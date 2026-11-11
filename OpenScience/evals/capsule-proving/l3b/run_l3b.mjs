#!/usr/bin/env node
// L3B: attended conversations, explicit corrections, different paired exams, native memory and actual product learning.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Api, registerAccount } from '../../general-tasks/runner/cell.mjs';
import { ensurePostgres, ensureDatabase, startHarness, stopHarness } from '../../general-tasks/runner/run.mjs';
import { runConversation } from '../lx/conversation.mjs';
import { ipc, drain } from '../lx/run_lx.mjs';
import { methodLibrary } from '../l3/run_l3.mjs';
import { HERE, armEnv, loadPairs, examOrder, profileBlocksOf } from './design.mjs';
const OS = path.resolve(HERE, '../../..');
const read = async (file, fallback = null) => JSON.parse(await fs.readFile(file, 'utf8').catch(() => JSON.stringify(fallback)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 1), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}
function argsOf(argv) {
  const o = { port: 48854, pgPort: 55684, timeoutMin: 8, learningTimeoutMin: 25, repeat: 3 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    o[k] = argv[++i];
  }
  for (const k of ['port', 'pgPort', 'timeoutMin', 'learningTimeoutMin', 'repeat']) o[k] = Number(o[k]);
  return o;
}
async function main() {
  const args = argsOf(process.argv.slice(2));
  const env = armEnv(args.arm); Object.assign(process.env, env);
  const out = path.resolve(args.out ?? `/srv/evimed/runs/l3b-${args.arm}-1`);
  const dataDir = `/srv/evimed/pp/data/${path.basename(out)}`;
  await fs.mkdir(`${out}/records`, { recursive: true });
  const status = message => { const line = `${new Date().toISOString()} L3B ${args.arm} ${message}\n`; process.stdout.write(line); fsSync.appendFileSync(`${out}/STATUS`, line); };
  const design = await loadPairs();
  const digest = createHash('sha256').update(JSON.stringify(design)).digest('hex');
  const prior = await read(`${out}/run.json`);
  if (prior && (prior.arm !== args.arm || prior.pairsSha256 !== digest)) throw new Error('Cannot resume a changed treatment or pair set');
  const start = prior?.startedAt ?? new Date().toISOString();
  // Shared-lane budget uses cumulative account ledgers plus a reserve for unledgered engine/judge calls.
  const capFile = '/srv/evimed/runs/l3b-budget.json';
  const budget = await read(capFile);
  if (!budget) throw new Error('Launch must establish l3b-budget.json');
  const guard = async () => {
    const balance = Number((await fs.readFile('/srv/evimed/runs/BUDGET-LAST', 'utf8')).trim().split(/\s+/)[2]);
    const usages = await Promise.all(['A','B','C','D'].map(a => read(`/srv/evimed/runs/l3b-${a}-1/account-usage.json`, {})));
    const ledger = usages.reduce((n, u) => n + Number(u.account?.actualCost ?? 0), 0);
    if (!(balance >= 150) || ledger >= 350 || budget.balanceBefore - balance >= 400 || Date.now() > budget.deadlineMs)
      throw new Error(`Budget/time guard: balance=${balance} laneLedger=${ledger}; progress preserved`);
  };
  await guard();
  const treeOs = path.resolve(args.tree ?? OS);
  await ensurePostgres(args.pgPort);
  const dbName = `evimed_test_l3b_${args.arm.toLowerCase()}`;
  await ensureDatabase(args.pgPort, dbName);
  const seed = spawnSync('bash', [`${OS}/evals/general-tasks/runner/seed.sh`], { encoding: 'utf8', env: { ...process.env, OS: treeOs, L: process.env.EVAL_LIVE_DIR, SEED_FROM: args.seedFrom ?? '/srv/evimed/pp/seed/dsh-seed' }, maxBuffer: 16 * 1024 * 1024 });
  if (seed.status !== 0) throw new Error(`Seed failed: ${seed.stderr.slice(-2000)}`);
  const treeDir = seed.stdout.trim().split('\n').pop();
  const commit = process.env.EVAL_TREE_COMMIT ?? 'unrecorded';
  await atomic(`${out}/run.json`, { schema: 'l3b/1', startedAt: start, arm: args.arm, pairsSha256: digest, commit, env, args,
    dispatch: 'LX runConversation; attended /api/agent-runs/dispatch without automated',
    treatment: args.arm === 'A' ? 'No learning conversations or memory carried; ordinary official methods unchanged' : args.arm === 'B' ? 'Same learning conversations, native memory on, method learning off' : 'Same conversations, native memory and method learning on',
    exams: 'No feedback or correction. Worker paused during exams to preserve learned-method treatment; attended native memory commits remain on except A. Repetition history may affect later exams; rep-1 and case-majority sensitivity reported.',
    learning: 'LX drain through product worker; settle windows advanced, no synthetic lessons or approval; no forced sleep phase',
    ranker: 'Initialized in every arm including learning-off arms, matching ordinary method selection',
    smoke: Boolean(args.only), budget });
  let h;
  const shutdown = async () => { if (h) { const old = h; h = null; await stopHarness(old); } };
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { await shutdown(); process.exit(143); });
  try {
    h = await startHarness({ args, treeOs, treeDir, dataDir, profile: 'normal', arm: 'B', dbUrl: `postgresql://coder@127.0.0.1:${args.pgPort}/${dbName}` });
    const facts = await ipc(h, 'facts'); await atomic(`${out}/engine-facts.json`, facts);
    if (args.arm !== 'A' && !facts.nativeMemory?.ok) throw new Error('Native memory is unavailable');
    const api = new Api(h.base);
    let account = await read(`${out}/account.json`);
    if (account) {
      const login = await api.call('POST', '/api/auth/login', { username: account.username, password: 'eval-pass-1' }, { project: null });
      if (login.status !== 200) throw new Error(`Resume login ${login.status}`);
      api.csrf = login.json?.data?.csrfToken ?? login.json?.data?.session?.csrfToken ?? '';
      if (!api.csrf) api.csrf = (await api.call('GET','/api/me',undefined,{ project:null })).json?.data?.csrfToken ?? '';
    } else { account = await registerAccount(api, `l3b${args.arm.toLowerCase()}${Date.now().toString(36)}`); await atomic(`${out}/account.json`, account); }
    const userId = account.userId;
    const usage = async () => atomic(`${out}/account-usage.json`, await ipc(h, 'usage', { userId }));
    const memoryState = async label => {
      const state = await ipc(h, 'lxMemoryState', { userId }); await atomic(`${out}/memory-${label}.json`, state); return state;
    };
    const snapshotMemory = async label => {
      api.project = null;
      const result = await api.call('GET', '/api/memory/profile', undefined, { project: null });
      await atomic(`${out}/profile-${label}.json`, { status: result.status, body: result.json });
    };
    const execute = async (item, phase, rep) => {
      await guard();
      const name = `${phase}-${item.id}-r${rep}`, file = `${out}/records/${name}.json`;
      if (fsSync.existsSync(file)) return read(file);
      const pending = `${out}/pending.json`;
      const interrupted = await read(pending);
      if (interrupted) throw new Error(`Unfinished conversation ${interrupted.name}; inspect product state before resuming, do not silently replay it`);
      const sessionId = `l3b-${phase}-${item.id.toLowerCase()}-${rep}`;
      const projectId = `l3b-${phase}-${item.id.toLowerCase()}-${rep}`;
      await atomic(pending, { name, sessionId, projectId, at: new Date().toISOString() });
      status(`${name} start`);
      const record = await runConversation({ api, userId, projectId, projectName: `L3B ${item.kind}`, sessionId,
        first: phase === 'learning' ? item.learning.initial : item.exam,
        next: (_turn, i) => phase === 'learning' && i === 0 ? item.learning.correction : null,
        dataDir, outDir: `${out}/records/${name}.files`, timeoutMs: args.timeoutMin * 60_000, maxTurns: phase === 'learning' ? 2 : 1,
        log: status, observeMethods: identity => ipc(h, 'methods', identity), waitMemoryTools: args.arm !== 'A' });
      Object.assign(record, { name, phase, rep, id: item.id, kind: item.kind, arm: args.arm });
      const firstRequests = [];
      for (const f of await fs.readdir(`${dataDir}/first-requests`)) {
        const r = await read(`${dataDir}/first-requests/${f}`);
        if (r?.at >= record.startedAt && r.at <= record.finishedAt) firstRequests.push(r);
      }
      const profileBlocks = profileBlocksOf(firstRequests);
      record.memory = { firstRequests: firstRequests.length, profileBlockPresent: profileBlocks.length > 0, profileBlocks,
        searchCalls: record.turns.flatMap(t => t.tools).filter(t => /openviking.*search/.test(t.name)),
        rememberCalls: record.turns.flatMap(t => t.tools).filter(t => /openviking.*remember/.test(t.name)) };
      await fs.writeFile(`${out}/records/${name}.files/first-requests.json.gz`, zlib.gzipSync(JSON.stringify(firstRequests)));
      await atomic(file, record); await fs.rm(pending); await usage();
      if (record.turns.some(t => t.run?.automated === true)) throw new Error('Attended dispatch became automated');
      status(`${name} recorded turns=${record.turns.length} profile=${record.memory.profileBlockPresent}`);
      return record;
    };
    const pairs = args.only ? design.pairs.filter(p => args.only.split(',').includes(p.id)) : design.pairs;
    if (!await read(`${out}/learning-complete.json`)) {
      if (args.arm !== 'A') for (const item of pairs) {
        await execute(item, 'learning', 1);
        const drained = `${out}/drained-${item.id}.json`;
        if (['C','D'].includes(args.arm) && !await read(drained)) {
          status(`drain ${item.id} start`);
          const d = await drain(h, userId, { timeoutMin: args.learningTimeoutMin }, status);
          await atomic(`${out}/state-${item.id}.json`, await ipc(h, 'lxState', { userId }));
          await usage();
          if (d.timedOut) throw new Error(`Learning drain timed out after ${item.id}`);
          await atomic(drained, d); status(`drain ${item.id} done`);
        }
      }
      if (args.arm !== 'A') {
        status('waiting for native memory commits');
        // Read-only settlement: wait for native extraction, never plant a preference in the exam.
        const deadline = Date.now() + 20 * 60_000; let quiet = 0;
        while (Date.now() < deadline) {
          await guard(); const m = await memoryState('settlement');
          const open = m.commits.filter(c => ['pending','failed'].includes(c.state));
          quiet = open.length ? 0 : quiet + 1;
          if (quiet >= 3) break;
          await sleep(5000);
        }
        const m = await memoryState('before-exam');
        if (m.commits.some(c => ['pending','failed'].includes(c.state))) throw new Error('Native memory did not settle; exam not started');
        await snapshotMemory('before-exam');
      }
      api.project = null;
      await atomic(`${out}/learning-complete.json`, { at: new Date().toISOString(), methods: await methodLibrary(api), state: await ipc(h, 'lxState', { userId }) });
    }
    if (['C','D'].includes(args.arm)) await ipc(h, 'pause', { userId });
    for (let rep = 1; rep <= args.repeat; rep++) for (const item of examOrder(pairs, args.only ? [] : design.controls, rep)) await execute(item, 'exam', rep);
    await atomic(`${out}/state-final.json`, await ipc(h, 'lxState', { userId }));
    await memoryState('final'); await usage();
    await atomic(`${out}/complete.json`, { at: new Date().toISOString() }); status('product-path complete');
  } finally { await shutdown(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
