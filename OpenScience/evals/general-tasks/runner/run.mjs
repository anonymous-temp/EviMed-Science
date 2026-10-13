#!/usr/bin/env node
// The general-task baseline runner: drives the cases of cases.json, one at a time, against the real DSH kernel and DeepSeek
// through the real control plane, unattended, and leaves one JSON record per case plus a summary. Resumable: a case that already
// has a record is skipped (--redo to run it again).
//
//   node evals/general-tasks/runner/run.mjs --tree <OpenScience checkout> --arm B|A|C --out <dir>
//        [--cases G01,G05 | --set all|general|medical] [--repeat 1] [--timeout-min 15] [--port 48841] [--pg-port 55657]
//        [--variant normal,classifier-timeout,web-search-off] [--seed-from <sealed seed dir>] [--redo] [--no-judge] [--keep-data]
//
// Arms: B and C run the tree as it is (B = the tree before the course correction, C = the corrected tree: the arm is a label);
// A is the native control: the seven switchable first-party socket plugins off (OPEN_SCIENCE_RUNTIME_DISABLED_SOCKET_PLUGINS),
// the citation tools off, and the preset's persona replaced by one neutral sentence (persona.mjs). A runs the general cases only.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Api, runCell } from './cell.mjs';
import { NEUTRAL_PERSONA } from './persona.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.resolve(HERE, '..');
const SECRETS = process.env.EVAL_SECRETS_DIR ?? '/home/coder/workspace/EviMedScience/.evimed-local/secrets';
const L = process.env.EVAL_LIVE_DIR ?? '/tmp/eval/live';
const ARM_A_PLUGINS = ['evimed-guidance', 'evimed-run-policy', 'evimed-evidence', 'evimed-capsule', 'evimed-screening', 'evimed-compaction', 'evimed-duplicate-lines'];
const PROFILES = {
  normal: {},
  // The classifier's deadline is clamped to at least a second; the harness makes its call hang (EVAL_FAULT), so the deadline ends it.
  'classifier-timeout': { OPEN_SCIENCE_LLM_ROUTING_TIMEOUT_MS: '1000' },
  'web-search-off': { OPEN_SCIENCE_WEB_SEARCH_BAILIAN_ENABLED: 'false' },
};

function parseArgs(argv) {
  const out = { repeat: 1, timeoutMin: 15, port: 48841, pgPort: 55657, set: 'all' };
  const flags = new Set(['redo', 'no-judge', 'keep-data', 'help']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = flags.has(key) ? true : argv[++i];
  }
  for (const k of ['repeat', 'port', 'pgPort']) out[k] = Number(out[k]);
  out.timeoutMin = Number(out.timeoutMin);
  return out;
}

const log = (...parts) => console.log(`${new Date().toISOString()} ${parts.join(' ')}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listening = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });

/** The cells to run: a case that continues another (`after`) rides in the other's conversation. */
export function buildPlan(cases, { ids, set, arm, variants = null }) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  let wanted = ids?.length ? ids : cases.filter((c) => set === 'all' || (set === 'general' && c.kind === 'general') || (set === 'medical' && c.kind === 'medical')).map((c) => c.id);
  if (arm === 'A') wanted = wanted.filter((id) => byId.get(id)?.kind === 'general');
  const unknown = wanted.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`unknown case(s): ${unknown.join(', ')}`);
  const set2 = new Set(wanted);
  for (const id of [...set2]) { const after = byId.get(id).after; if (after) set2.add(after); }
  const units = [];
  const taken = new Set();
  for (const c of cases) {
    if (!set2.has(c.id) || taken.has(c.id) || c.after) continue;
    const members = [c, ...cases.filter((d) => d.after === c.id && set2.has(d.id))];
    members.forEach((m) => taken.add(m.id));
    for (const variant of c.variants ?? [{ id: 'normal' }]) {
      if (variants && !variants.includes(variant.id)) continue;
      units.push({ id: members.map((m) => m.id).join('+'), cases: members, variant, profile: variant.profile ?? 'normal' });
    }
  }
  return units;
}

const recordName = (unit, rep) => `${unit.id}${unit.variant.id === 'normal' ? '' : `--${unit.variant.id}`}-r${rep}`;

async function ensurePostgres(port) {
  if (await listening(port)) return { started: false };
  const bin = (await fs.readFile(path.join(os.homedir(), '.cache/evimed-pg/BIN'), 'utf8')).trim();
  const dir = `/tmp/eval-pg-${port}`;
  if (!fsSync.existsSync(`${dir}/data/PG_VERSION`)) {
    await fs.mkdir(dir, { recursive: true });
    const init = spawnSync(`${bin}/initdb`, ['-D', `${dir}/data`, '-U', 'coder', '--auth=trust', '-E', 'UTF8'], { encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`initdb: ${init.stderr}`);
  }
  const child = spawn(`${bin}/postgres`, ['-D', `${dir}/data`, '-p', String(port), '-c', 'fsync=off', '-c', 'listen_addresses=127.0.0.1', '-c', `unix_socket_directories=${dir}`, '-c', 'max_connections=60'],
    { detached: true, stdio: ['ignore', fsSync.openSync(`${dir}/pg.log`, 'a'), fsSync.openSync(`${dir}/pg.log`, 'a')] });
  child.unref();
  for (let i = 0; i < 40 && !(await listening(port)); i += 1) await sleep(500);
  if (!(await listening(port))) throw new Error('postgres did not start');
  return { started: true, pid: child.pid, bin };
}

async function ensureDatabase(port, name) {
  const bin = (await fs.readFile(path.join(os.homedir(), '.cache/evimed-pg/BIN'), 'utf8')).trim();
  const exists = spawnSync(`${bin}/psql`, ['-h', '127.0.0.1', '-p', String(port), '-U', 'coder', '-d', 'postgres', '-Atc', `select 1 from pg_database where datname='${name}'`], { encoding: 'utf8' });
  if (exists.stdout.trim() === '1') return;
  const made = spawnSync(`${bin}/createdb`, ['-h', '127.0.0.1', '-p', String(port), '-U', 'coder', name], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`createdb: ${made.stderr}`);
}

function kernelPidsUnder(dir) {
  const pids = [];
  for (const entry of fsSync.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = fsSync.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ');
      if (cmd.includes('--profile evimed-runtime') && cmd.includes(`--patch ${dir}/`)) pids.push(Number(entry));
    } catch { /* gone */ }
  }
  return pids;
}

async function startHarness({ args, treeOs, treeDir, dataDir, profile, arm, dbUrl }) {
  const base = `http://127.0.0.1:${args.port}`;
  const armA = arm === 'A';
  const env = {
    OPEN_SCIENCE_EVOLUTION_ENABLED: 'false', OPEN_SCIENCE_LEARNING_ENABLED: 'false', OPEN_SCIENCE_LOOPX_ENABLED: 'false', OPEN_SCIENCE_JEV_ENABLED: 'false',
    OPEN_SCIENCE_RUN_TITLES_ENABLED: 'false', OPEN_SCIENCE_MAX_PROJECTS_PER_USER: '500', OPEN_SCIENCE_MEMORY_EXTRACTION_ENABLED: 'true',
    OPEN_SCIENCE_AUTOPILOT_ENABLED: 'true', OPEN_SCIENCE_SOURCE_INGESTION_ENABLED: 'true',
    OPEN_SCIENCE_WEB_SEARCH_BAILIAN_ENABLED: 'true', OPEN_SCIENCE_DASHSCOPE_API_KEY_FILE: path.join(SECRETS, 'dashscope.api-key'),
    OPEN_SCIENCE_DEV_AUTH: 'false',
    ...(armA ? { OPEN_SCIENCE_RUNTIME_DISABLED_SOCKET_PLUGINS: ARM_A_PLUGINS.join(',') } : {}),
    ...PROFILES[profile],
  };
  const overrides = { devAuth: false, authMode: 'local', publicUrl: base };
  await fs.mkdir(dataDir, { recursive: true });
  const logFile = fsSync.openSync(`${dataDir}/harness.log`, 'a');
  const child = spawn('node', [path.join(HERE, 'harness.mjs')], {
    cwd: dataDir, detached: true, stdio: ['ignore', logFile, logFile],
    env: { ...process.env, OS: treeOs, TREE_DIR: treeDir, LIVE_DIR: L, LIVE_DATA: dataDir, LIVE_PORT: String(args.port), LIVE_DATABASE_URL: dbUrl,
      LIVE_ENV: JSON.stringify(env), LIVE_OVERRIDES: JSON.stringify(overrides), TMPDIR: '/tmp/eval-t',
      EVAL_DEEPSEEK_KEY_FILE: path.join(SECRETS, 'deepseek.api-key'), ...(profile === 'classifier-timeout' ? { EVAL_FAULT: 'classifier-timeout' } : {}),
      ...(armA ? { EVAL_PERSONA: NEUTRAL_PERSONA, EVAL_KERNEL_ENV: JSON.stringify({ EVIMED_CITE_ENABLED: '0' }) } : {}) },
  });
  child.unref();
  for (let i = 0; i < 120; i += 1) {
    if (await listening(args.port)) { await sleep(1500); return { pid: child.pid, dataDir, base, profile }; }
    if (child.exitCode !== null) break;
    await sleep(1000);
  }
  throw new Error(`harness did not listen; see ${dataDir}/harness.log`);
}

async function stopHarness(h) {
  if (!h) return;
  try { process.kill(h.pid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 20; i += 1) { if (!fsSync.existsSync(`/proc/${h.pid}`)) break; await sleep(1000); }
  try { process.kill(h.pid, 'SIGKILL'); } catch { /* gone */ }
  // Kernels the harness started, by their own --patch path under this arm's data directory only.
  for (const pid of kernelPidsUnder(h.dataDir)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  await sleep(1500);
  for (const pid of kernelPidsUnder(h.dataDir)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(500);
}

function judge(args, outDir, name) {
  const script = path.join(SUITE, 'judges', 'judge_case.py');
  const r = spawnSync('python3', [script, '--cases', path.join(SUITE, 'cases.json'), '--record', `${outDir}/records/${name}.json`, '--out', `${outDir}/judged/${name}.json`, '--fixtures', path.join(SUITE, 'fixtures')],
    { encoding: 'utf8', timeout: 600_000 });
  if (r.status !== 0) log(`  judge failed for ${name}: ${(r.stderr || r.stdout).slice(-400)}`);
}

function summarize(outDir) {
  const r = spawnSync('python3', [path.join(SUITE, 'judges', 'summarize.py'), '--run', outDir], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) log(`  summary failed: ${(r.stderr || r.stdout).slice(-300)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.tree || !args.arm || !args.out) {
    console.log('usage: run.mjs --tree <OpenScience checkout> --arm A|B|C --out <dir> [--cases G01,G05 | --set all|general|medical] [--repeat 1] [--timeout-min 15] [--port 48841] [--pg-port 55657] [--variant ID[,ID]] [--seed-from DIR] [--redo] [--no-judge] [--keep-data]');
    process.exit(args.help ? 0 : 2);
  }
  const arm = String(args.arm).toUpperCase();
  if (!['A', 'B', 'C'].includes(arm)) throw new Error('--arm must be A, B or C');
  if (args.port < 48840 || args.port > 48859) log(`note: port ${args.port} is outside 48840-48859`);
  const treeOs = path.resolve(args.tree);
  if (!fsSync.existsSync(path.join(treeOs, 'apps/server/src/server.mjs'))) throw new Error(`${treeOs} is not an OpenScience checkout`);
  const git = (...a) => spawnSync('git', ['-C', treeOs, ...a], { encoding: 'utf8' }).stdout.trim();
  const tree = { path: treeOs, commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=no').length > 0 };
  const outDir = path.resolve(args.out);
  await fs.mkdir(`${outDir}/records`, { recursive: true });
  const cases = JSON.parse(await fs.readFile(path.join(SUITE, 'cases.json'), 'utf8')).cases;
  const plan = buildPlan(cases, { ids: args.cases ? String(args.cases).split(',').map((s) => s.trim()) : null, set: args.set, arm, variants: args.variant ? String(args.variant).split(',').map((s) => s.trim()) : null });
  // Normal profile first: the harness restarts only when the profile changes.
  plan.sort((a, b) => (a.profile === 'normal' ? 0 : 1) - (b.profile === 'normal' ? 0 : 1));
  const manifestFile = `${outDir}/run.json`;
  const manifest = fsSync.existsSync(manifestFile) ? JSON.parse(await fs.readFile(manifestFile, 'utf8')) : { runs: [] };
  manifest.arm = arm; manifest.tree = tree; manifest.runs.push({ startedAt: new Date().toISOString(), args: { ...args, tree: treeOs }, cells: plan.map((u) => recordName(u, 1)) });
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 1));
  log(`arm ${arm} on ${treeOs} @ ${tree.commit.slice(0, 9)}${tree.dirty ? ' (dirty)' : ''}: ${plan.length} cell(s) x ${args.repeat}`);

  const pg = await ensurePostgres(args.pgPort);
  const dbName = `evimed_test_eval_${arm.toLowerCase()}`;
  await ensureDatabase(args.pgPort, dbName);
  const dbUrl = `postgresql://coder@127.0.0.1:${args.pgPort}/${dbName}`;
  await fs.mkdir('/tmp/eval-t', { recursive: true, mode: 0o700 });
  const seed = spawnSync('bash', [path.join(HERE, 'seed.sh')], { encoding: 'utf8', env: { ...process.env, OS: treeOs, L, ...(args.seedFrom ? { SEED_FROM: args.seedFrom } : {}) }, maxBuffer: 16 * 1024 * 1024 });
  process.stderr.write(seed.stderr ?? '');
  if (seed.status !== 0) throw new Error(`seed.sh failed (${seed.status})`);
  const treeDir = seed.stdout.trim().split('\n').pop();
  const dataDir = `${L}/data-${arm.toLowerCase()}`;

  let harness = null;
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true; await stopHarness(harness); if (pg.started) { try { process.kill(pg.pid, 'SIGTERM'); } catch { /* gone */ } } };
  process.on('SIGTERM', async () => { await shutdown(); process.exit(143); });
  process.on('SIGINT', async () => { await shutdown(); process.exit(130); });
  try {
    for (let rep = 1; rep <= args.repeat; rep += 1) {
      for (const unit of plan) {
        const name = recordName(unit, rep);
        const file = `${outDir}/records/${name}.json`;
        if (fsSync.existsSync(file) && !args.redo && !JSON.parse(await fs.readFile(file, 'utf8')).infra) { log(`skip ${name} (record exists)`); continue; }
        if (!harness || harness.profile !== unit.profile || !(await listening(args.port))) {
          await stopHarness(harness);
          harness = await startHarness({ args, treeOs, treeDir, dataDir, profile: unit.profile, arm, dbUrl });
          log(`harness up on ${harness.base} (profile ${unit.profile}, pid ${harness.pid})`);
        }
        // The cell's conversation: the first case's turns, then the continuing cases' turns after them.
        const turns = unit.cases.flatMap((c) => c.turns);
        const spec = { id: unit.id, family: unit.cases[0].family, inputs: unit.cases[0].inputs ?? [], turns, manual_trigger: unit.cases.find((c) => c.manual_trigger)?.manual_trigger };
        const timeoutMin = Math.max(args.timeoutMin, ...unit.cases.map((c) => c.timeout_min ?? 0));
        log(`run ${name} (${turns.length} turn(s), timeout ${timeoutMin} min/turn)`);
        const t0 = Date.now();
        const cellDir = `${outDir}/records/${name}.files`;
        await fs.rm(cellDir, { recursive: true, force: true });
        await fs.mkdir(cellDir, { recursive: true });
        let record;
        try {
          record = await runCell({ api: new Api(harness.base), spec, fixtureRoot: path.join(SUITE, 'fixtures'), dataDir, outDir: cellDir, timeoutMs: timeoutMin * 60_000, log });
        } catch (error) {
          record = { schema: 1, cell: unit.id, error: String(error?.stack ?? error).slice(0, 2000), turns: [], infra: true };
          log(`  cell failed: ${String(error?.message ?? error)}`);
        }
        Object.assign(record, {
          caseIds: unit.cases.map((c) => c.id), turnOffsets: Object.fromEntries(unit.cases.map((c, i) => [c.id, unit.cases.slice(0, i).reduce((n, m) => n + m.turns.length, 0)])),
          variant: unit.variant.id, profile: unit.profile, rep, arm, tree, name, wallMs: record.wallMs ?? Date.now() - t0,
        });
        await fs.writeFile(file, JSON.stringify(record, null, 1));
        if (!args.keepData && record.projectDir) await fs.rm(record.projectDir, { recursive: true, force: true }).catch(() => {});
        if (!args.noJudge) judge(args, outDir, name);
        summarize(outDir);
        log(`done ${name} in ${Math.round((Date.now() - t0) / 1000)}s`);
      }
    }
  } finally {
    await shutdown();
  }
  summarize(outDir);
  log(`finished; summary at ${outDir}/summary.md`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
