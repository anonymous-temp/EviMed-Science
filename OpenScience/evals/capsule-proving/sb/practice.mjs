#!/usr/bin/env node
// Product-path practice only. The scored rows use reference harnesses; this must never label those rows product runs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Api, registerAccount, runCell } from '../../general-tasks/runner/cell.mjs';
import { ensurePostgres, ensureDatabase, startHarness, stopHarness } from '../../general-tasks/runner/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SB_ROOT ?? '/srv/evimed/sb';
const OUT = `${ROOT}/practice`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const put = async (file, obj) => { await fs.writeFile(`${file}.tmp`, JSON.stringify(obj, null, 2)); await fs.rename(`${file}.tmp`, file); };
const exists = async file => Boolean(await fs.stat(file).catch(() => null));
const status = async text => { const line = `${new Date().toISOString()} SB practice ${text}\n`; process.stdout.write(line); await fs.appendFile('/srv/evimed/runs/sb-STATUS', line); };

export function ipc(h, action, args = {}) {
  return new Promise((resolve, reject) => {
    const id = `sb-${Date.now()}-${Math.random()}`;
    const timer = setTimeout(() => { h.child.off('message', handle); reject(new Error(`IPC timeout ${action}`)); }, 180_000);
    const handle = message => {
      if (message.id !== id) return;
      clearTimeout(timer); h.child.off('message', handle);
      if (message.error) reject(new Error(message.error)); else resolve(message.value);
    };
    h.child.on('message', handle); h.child.send({ evalControl: true, id, action, args });
  });
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await fs.mkdir(`${ROOT}/learned`, { recursive: true });
  if (await exists(`${OUT}/complete.json`)) return;
  const manifest = JSON.parse(await fs.readFile(`${ROOT}/manifest.json`, 'utf8'));
  const treeOs = path.resolve(process.env.SB_PRODUCT_TREE ?? path.resolve(HERE, '../../..'));
  const port = Number(process.env.SB_PORT ?? 48848), pgPort = Number(process.env.SB_PG_PORT ?? 55686);
  const env = {
    OPEN_SCIENCE_LEARNING_ENABLED: 'true', OPEN_SCIENCE_MEMORY_RUNTIME_LOCK_ISOLATION_ENABLED: 'true',
    OPEN_SCIENCE_OFFICIAL_PACKS_ENABLED: 'false', OPEN_SCIENCE_METHOD_PYRAMID_ENABLED: 'true',
    OPEN_SCIENCE_METHOD_CARD_EVIDENCE_ENABLED: 'true', OPEN_SCIENCE_LEARNING_TOOLCHAIN_ROUTINE_ENABLED: 'true',
    OPEN_SCIENCE_OFFICIAL_PROMOTION_ENABLED: 'false', OPEN_SCIENCE_LEARNING_CONCURRENCY: '1',
    OPEN_SCIENCE_LEARNING_WINDOW: '', OPEN_SCIENCE_LEARNING_CONSOLIDATION_INTERVAL_MS: '86400000',
    OPEN_SCIENCE_MAX_RUNNING_RUNTIMES: '1', OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER: '1',
    EVAL_METHOD_RANKER: '1', EVAL_DEFER_LEARNING: '1', EVAL_CONTROL_EXTRA: `${HERE}/export-control.mjs`,
  };
  Object.assign(process.env, env);
  const dataDir = `${ROOT}/product-data`;
  await ensurePostgres(pgPort); await ensureDatabase(pgPort, 'evimed_test_sb_practice');
  const seed = spawnSync('bash', [`${treeOs}/evals/general-tasks/runner/seed.sh`], {
    encoding: 'utf8', env: { ...process.env, OS: treeOs, L: process.env.EVAL_LIVE_DIR,
      SEED_FROM: '/srv/evimed/pp/seed/dsh-seed' }, maxBuffer: 16 * 1024 * 1024,
  });
  if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr?.slice(-1000)}`);
  const h = await startHarness({ args: { port }, treeOs, treeDir: seed.stdout.trim().split('\n').at(-1),
    dataDir, profile: 'normal', arm: 'B', dbUrl: `postgresql://coder@127.0.0.1:${pgPort}/evimed_test_sb_practice` });
  const shutdown = async () => { await stopHarness(h); };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await shutdown(); process.exit(1); });
  try {
    await put(`${OUT}/config.json`, { treeOs, env, pin: manifest.pins, simulatedUser: true,
      automated: false, scored: false, adaptation: 'Environment files uploaded into the product workspace; absolute /root and /app paths are explained as workspace-relative. No official verifier or oracle is given to practice or distillation.' });
    // The harness awaits its readiness probe before listening. Keep its observed facts as evidence.
    await put(`${OUT}/engine-facts.json`, await ipc(h, 'facts'));
    const api = new Api(h.base);
    const accountFile = `${OUT}/account.json`;
    let account;
    if (await exists(accountFile)) {
      account = JSON.parse(await fs.readFile(accountFile, 'utf8'));
      const login = await api.call('POST', '/api/auth/login', { username: account.username, password: 'eval-pass-1' }, { project: null });
      if (login.status !== 200) throw new Error('Practice login failed');
      api.csrf = login.json?.data?.csrfToken ?? login.json?.data?.session?.csrfToken ?? (await api.call('GET', '/api/me', undefined, { project: null })).json?.data?.csrfToken ?? '';
    } else {
      account = await registerAccount(api, `sbpractice${Date.now().toString(36)}`);
      await fs.writeFile(accountFile, JSON.stringify(account), { mode: 0o600 });
    }
    for (const task of manifest.practice) {
      const file = `${OUT}/${task.bench}-${task.id}.json`;
      if (await exists(file)) continue;
      const budget = await fs.readFile('/srv/evimed/runs/BUDGET-LAST', 'utf8');
      if (Number(/balance\s+([\d.]+)/.exec(budget)?.[1] ?? 0) < 400) throw new Error('Balance below batch start floor');
      const usage = await ipc(h, 'usage', { userId: account.userId });
      await put(`${OUT}/usage.json`, usage);
      const spent = Number(usage.account?.actualCost ?? 0) + Number(usage.account?.reservedCost ?? 0);
      if (spent > 100) throw new Error('Product practice CNY 100 allocation reached');
      const referenceSpent = (await fs.readFile(`${ROOT}/usage.jsonl`, 'utf8').catch(() => '')).split('\n').filter(Boolean)
        .reduce((sum, line) => sum + Number(JSON.parse(line).costCny ?? 0), 0);
      if (spent + referenceSpent > 340) throw new Error('Combined lane allocation reached');
      const inputs = [], skipped = [];
      const envDir = `${task.path}/environment`;
      const walk = async (dir, rel = '') => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (['skills', 'Dockerfile', '__pycache__'].includes(entry.name)) continue;
          const next = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(`${dir}/${entry.name}`, next);
          else if (entry.isFile() && (await fs.stat(`${dir}/${entry.name}`)).size < 45_000_000) inputs.push({ fixture: next, to: next });
          else skipped.push(next);
        }
      };
      await walk(envDir);
      let instruction = await fs.readFile(`${task.path}/${task.bench === 'sb' ? 'task.md' : 'instruction.md'}`, 'utf8');
      if (task.bench === 'sb') instruction = instruction.split('---').slice(2).join('---').trim();
      const spec = { id: `sbp-${task.bench}-${createHash('sha256').update(task.id).digest('hex').slice(0, 8)}`, kind: 'general', inputs, turns: [
        { text: `${instruction}\n\nThis is a practice task in this project's workspace. The supplied environment files are attached. Treat /root/ and /app/ paths in the task as paths relative to this workspace; keep all work in the workspace. Dependencies available in this environment may differ from the task container. If an input or dependency is missing, state that limitation rather than inventing results.` },
        { text: 'Please remember the reusable workflow you used on this task for similar work in my other projects. Keep the method general: do not memorize this instance\'s values, filenames, answers or unavailable steps. I am asking you to retain the method, not asserting that this result passed an external test.' },
      ] };
      const cellDir = `${OUT}/${task.bench}-${task.id}.files`;
      await fs.mkdir(cellDir, { recursive: true });
      await status(`start ${task.bench}/${task.id}`);
      const record = await runCell({ api, account, spec, fixtureRoot: envDir, dataDir, outDir: cellDir,
        timeoutMs: 8 * 60_000, automated: false, waitMemoryTools: true,
        observeMethods: who => ipc(h, 'methods', who), log: line => status(line) });
      await put(file, { ...record, task, simulatedUser: true, automated: false, skipped });
      await put(`${OUT}/usage.json`, await ipc(h, 'usage', { userId: account.userId }));
      await status(`done ${task.id}`);
    }
    await ipc(h, 'start', { userId: account.userId });
    const deadline = Date.now() + 45 * 60_000;
    let quiet = 0, last;
    while (Date.now() < deadline) {
      last = await ipc(h, 'status', { userId: account.userId });
      await put(`${OUT}/jobs.json`, last);
      const busy = last.jobs?.filter(j => ['queued', 'running'].includes(j.status)) ?? [];
      quiet = !busy.length && !last.worker?.running ? quiet + 1 : 0;
      if (quiet >= 3) break;
      await status(`drain queued/running=${busy.length}`);
      await pause(20_000);
    }
    await ipc(h, 'pause', { userId: account.userId });
    const methods = [];
    let cursor = null;
    do {
      const response = await api.call('GET', `/api/methods?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (response.status !== 200) throw new Error('Method export failed');
      methods.push(...(response.json?.data?.items ?? [])); cursor = response.json?.data?.nextCursor ?? null;
    } while (cursor);
    const exported = await ipc(h, 'lxSbExport', { userId: account.userId, ids: methods.filter(m => m.status === 'approved').map(m => m.id) });
    for (const method of exported) {
      const name = method.frontmatter.name;
      const directory = `${ROOT}/learned/${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
      await fs.mkdir(directory, { recursive: true });
      // JSON is a YAML subset, preserving every frontmatter field without introducing another serializer.
      await fs.writeFile(`${directory}/SKILL.md`, `---\n${JSON.stringify(method.frontmatter)}\n---\n\n${method.body ?? ''}`);
      // Script attachments, if present, are part of the method, not an inference adapter.
      for (const [relative, content] of Object.entries(method.files ?? {})) {
        if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Unsafe method attachment');
        const destination = path.join(directory, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, String(content));
      }
    }
    const finalUsage = await ipc(h, 'usage', { userId: account.userId });
    await put(`${OUT}/complete.json`, { at: new Date().toISOString(), methods, exported, jobs: last, usage: finalUsage,
      learned: methods.length, approved: methods.filter(m => m.status === 'approved').length,
      reachedQuiet: quiet >= 3, productPath: true, scoredTrialsProductPath: false });
    await status(`complete learned=${methods.length} approved=${methods.filter(m => m.status === 'approved').length}`);
  } finally { await shutdown(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
