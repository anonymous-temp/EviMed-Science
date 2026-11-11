// Evaluation scaffolding only. Uses the existing real control-plane/kernel harness.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Api, registerAccount } from '../../general-tasks/runner/cell.mjs';
import { ensurePostgres, ensureDatabase, startHarness, stopHarness } from '../../general-tasks/runner/run.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function profileOpening(request) {
  const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => v.text ?? '').join('\n') : '';
  const context = [text(request.system), ...(request.messages ?? []).map(m => text(m.content))].join('\n');
  // Guidance mentions the bare tag as an example; only the plugin's attributed profile block is an opening.
  return (context.match(/<openviking-context\s+source="profile"[^>]*>[\s\S]*?<\/openviking-context>/g) ?? []).join('\n');
}
export const read = async (file, fallback = null) => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
export async function save(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 1));
  await fs.rename(`${file}.tmp`, file);
}
export function argsOf(argv) {
  const args = { data: '/srv/evimed/data/memdata-data', port: 48854, pgPort: 55684, timeoutMin: 10 };
  for (let i = 0; i < argv.length; i++) args[argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  for (const k of ['port', 'pgPort', 'timeoutMin']) args[k] = Number(args[k]);
  if (!args.out || !args.tree) throw new Error('--out and --tree required');
  if (args.data.split('/').some(p => /sealed/i.test(p))) throw new Error('sealed data refused');
  return args;
}
export function ipc(h, action, args = {}) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { h.child.off('message', reply); reject(new Error(`IPC timeout: ${action}`)); }, 300_000);
    const reply = message => { if (message.id !== id) return; clearTimeout(timer); h.child.off('message', reply); message.error ? reject(new Error(message.error)) : resolve(message.value); };
    h.child.on('message', reply); h.child.send({ evalControl: true, id, action, args });
  });
}
export async function account(h, file, prefix) {
  const api = new Api(h.base);
  let identity = await read(file);
  if (!identity) { identity = await registerAccount(api, `${prefix}${randomUUID().replaceAll('-', '').slice(0, 14)}`); await save(file, identity); }
  else {
    const login = await api.call('POST', '/api/auth/login', { username: identity.username, password: 'eval-pass-1' }, { project: null });
    if (login.status !== 200) throw new Error(`resume login: ${login.status}`);
    api.csrf = login.json?.data?.csrfToken ?? login.json?.data?.session?.csrfToken ?? '';
    if (!api.csrf) api.csrf = (await api.call('GET', '/api/me', undefined, { project: null })).json?.data?.csrfToken ?? '';
  }
  return { api, ...identity };
}
export async function setup(args) {
  if (process.env.OPEN_SCIENCE_MEMORY_RUNTIME_LOCK_ISOLATION_ENABLED !== 'true') throw new Error('Lock isolation must be ON');
  const status = message => { const line = `${new Date().toISOString()} EG ${message}\n`; process.stdout.write(line); fsSync.appendFileSync(`${args.out}/STATUS`, line); };
  await fs.mkdir(args.out, { recursive: true });
  const treeOs = path.resolve(args.tree), suite = path.resolve(treeOs, 'evals/general-tasks');
  const commit = process.env.EVAL_TREE_COMMIT || spawnSync('git', ['-C', treeOs, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(OPEN_SCIENCE_|EVAL_|EVIMED_)/.test(k)).map(([k, v]) => [k, /KEY$|TOKEN|SECRET|PASSWORD|DATABASE_URL/.test(k) ? '<set>' : v]));
  const prior = await read(`${args.out}/provenance.json`, { attempts: [] });
  const attempt = { at: new Date().toISOString(), args, commit, env, balance: await fs.readFile('/srv/evimed/runs/BUDGET-LAST', 'utf8') };
  await save(`${args.out}/provenance.json`, { ...attempt, attempts: [...(prior.attempts?.length ? prior.attempts : prior.at ? [prior] : []), attempt] });
  const mounts = JSON.parse(spawnSync('docker', ['inspect', 'ovlab-pp', '--format', '{{json .Mounts}}'], { encoding: 'utf8' }).stdout);
  const templates = mounts.find(m => m.Destination === '/app/memory-templates')?.Source;
  if (!templates) throw new Error('Cannot record product engine templates');
  const digest = createHash('sha256');
  const names = (await fs.readdir(templates, { withFileTypes: true })).filter(d => d.isFile()).map(d => d.name).sort();
  for (const name of names) digest.update(`${name}\0${createHash('sha256').update(await fs.readFile(`${templates}/${name}`)).digest('hex')}\n`);
  await save(`${args.out}/engine.json`, { version: 'v0.5.3', templatesDigest: digest.digest('hex'), templatesFiles: names.length, templatesDir: templates,
    imageDigest: spawnSync('docker', ['inspect', 'ovlab-pp', '--format', '{{.Image}}'], { encoding: 'utf8' }).stdout.trim() });
  const dbName = `evimed_test_${path.basename(args.out).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 60);
  await ensurePostgres(args.pgPort); await ensureDatabase(args.pgPort, dbName);
  const seed = spawnSync('bash', [`${suite}/runner/seed.sh`], { encoding: 'utf8', env: { ...process.env, OS: treeOs, L: process.env.EVAL_LIVE_DIR, SEED_FROM: args.seedFrom ?? '/srv/evimed/pp/seed/dsh-seed' }, maxBuffer: 16 * 1024 * 1024 });
  process.stderr.write(seed.stderr ?? '');
  if (seed.status !== 0) throw new Error('seed failed');
  const treeDir = seed.stdout.trim().split('\n').pop();
  const dataDir = args.dataDir ?? `/srv/evimed/pp/data/${path.basename(args.out)}`;
  process.env.EVAL_CONTROL_EXTRA = path.resolve(treeOs, 'evals/capsule-proving/eg/control.mjs');
  const h = await startHarness({ args, treeOs, treeDir, dataDir, profile: 'normal', arm: 'B', dbUrl: `postgresql://coder@127.0.0.1:${args.pgPort}/${dbName}` });
  const close = async () => { await stopHarness(h); };
  // Account receipts plus conservatively priced engine tokens avoid charging this lane for other lanes' work.
  const budgetFile = '/srv/evimed/runs/eg-budget-20261111.json';
  let budget = await read(budgetFile);
  if (!budget) {
    const line = await fs.readFile('/srv/evimed/runs/BUDGET-LAST', 'utf8');
    budget = { startedAt: new Date().toISOString(), balance: Number(line.trim().split(/\s+/).at(-1)), capCny: 350, deadlineHours: 12 };
    await save(budgetFile, budget);
  }
  const guard = setInterval(async () => {
    try {
      const balance = Number((await fs.readFile('/srv/evimed/runs/BUDGET-LAST', 'utf8')).trim().split(/\s+/).at(-1));
      const spend = await read('/srv/evimed/runs/eg-spend-20261111.json');
      const metered = spend && Date.now() - Date.parse(spend.at) < 300_000 && !spend.errors.length && !spend.missing.length;
      const exhausted = metered ? spend.estimatedUpperCny >= 330 : budget.balance - balance >= 340;
      if (exhausted || balance < 150 || Date.now() - Date.parse(budget.startedAt) > 12 * 3600_000) {
        clearInterval(guard); status(`STOP budget/time guard: currentBalance=${balance} laneUpperCny=${spend?.estimatedUpperCny ?? 'unavailable'} metered=${metered}`);
        await close(); process.exit(3);
      }
    } catch (e) { status(`budget guard read failed: ${e.message}`); }
  }, 30_000);
  guard.unref();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { status(`interrupted ${sig}`); await close(); process.exit(1); });
  const facts = await ipc(h, 'facts'); await save(`${args.out}/engine-facts.json`, facts);
  if (!facts.nativeMemory?.ok) { await close(); throw new Error('Native memory unavailable'); }
  status(`ready port=${args.port} pg=${args.pgPort} commit=${commit} lockIsolation=true`);
  return { h, close, status, dataDir, commit };
}
export async function settle(h, userId, status, timeoutMs = 600_000) {
  const start = Date.now(); let last, quiet = 0;
  // Allow the native turn's delayed commit to be armed before testing for a quiet ledger.
  await sleep(25_000);
  do {
    last = await ipc(h, 'lxEGCommits', { userId });
    if (!last.pending && last.total) quiet++; else quiet = 0;
    if (quiet >= 2) return { ...last, waitedMs: Date.now() - start, timedOut: false };
    await sleep(3000);
  } while (Date.now() - start < timeoutMs);
  status(`commit wait timed out user=${userId} pending=${last?.pending} total=${last?.total}`);
  return { ...last, waitedMs: Date.now() - start, timedOut: true };
}
