#!/usr/bin/env node
// L3 product-path comparison. One durable account per arm; isolated projects per task; no exam case teaches a method.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Api, registerAccount, runCell } from '../../general-tasks/runner/cell.mjs';
import { ensurePostgres, ensureDatabase, startHarness, stopHarness, judge, summarize } from '../../general-tasks/runner/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(HERE, '../../..');
const SUITE = path.resolve(HERE, '../../general-tasks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const STUBS = { C: 'Official pyramid library does not exist yet.', G: "OpenViking Agent Evolution needs the engine's experiences type.", 'C+frame': 'Requires the missing official pyramid library (arm C).' };
export function armEnv(arm) {
  if (STUBS[arm]) throw new Error(`L3 ${arm} unavailable: ${STUBS[arm]}`);
  if (!['A', 'B', 'E', 'D', 'F'].includes(arm)) throw new Error(`Unknown L3 arm ${arm}`);
  return Object.fromEntries(fsSync.readFileSync(`${HERE}/arms/${arm}.env`, 'utf8').split('\n')
    .filter(line => line && !line.startsWith('#')).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
}
export function examSpec(id, cases) {
  const c = cases.find(row => row.id === id);
  if (!c) throw new Error(`Unknown case ${id}`);
  const prerequisite = c.after ? cases.find(row => row.id === c.after) : null;
  const setup = prerequisite?.turns ?? [];
  return { ...c, turns: [...setup, ...c.turns], prerequisite: prerequisite?.id ?? null, turnOffsets: { [id]: setup.length } };
}
export function wilson(passed, total) {
  if (!total) return null;
  const z = 1.959963984540054, p = passed / total, d = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / d;
  const width = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d;
  return [center - width, center + width];
}
export function composite(entry, record, { contextLimit = 1_000_000, turnLimit = 100 } = {}) {
  const turns = record.turns ?? [];
  const checks = (entry?.checks ?? []).filter(c => c.required && typeof c.ok === 'boolean');
  const result = entry?.status === 'pass' ? 1 : 0;
  const subtask = checks.length ? checks.filter(c => c.ok).length / checks.length : 0;
  const contextShare = Math.min(1, (record.modelRequests?.maxEstimatedContextTokens ?? 0) / contextLimit);
  const turnShare = Math.min(1, (record.modelRequests?.agentRequests ?? turns.length) / turnLimit);
  return { result, subtask, contextShare, turnShare, score: result + .2 * subtask - .1 * contextShare - .1 * turnShare };
}
export function argsOf(argv) {
  const out = { port: 48854, pgPort: 55684, repeat: 2, timeoutMin: 15, learningTimeoutMin: 90, waitMemoryTools: true };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (['smoke', 'waitMemoryTools', 'noWaitMemoryTools', 'summarizeOnly'].includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  for (const k of ['port', 'pgPort', 'repeat', 'timeoutMin', 'learningTimeoutMin']) out[k] = Number(out[k]);
  if (out.noWaitMemoryTools) out.waitMemoryTools = false;
  return out;
}
async function atomic(file, value, privateFile = false) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 1), { mode: privateFile ? 0o600 : 0o644 });
  await fs.rename(`${file}.tmp`, file);
}
function ipc(h, action, args = {}) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { h.child.off('message', reply); reject(new Error(`eval control timeout: ${action}`)); }, 300_000);
    const reply = message => {
      if (message.id !== id) return;
      clearTimeout(timer); h.child.off('message', reply);
      message.error ? reject(new Error(message.error)) : resolve(message.value);
    };
    h.child.on('message', reply);
    h.child.send({ evalControl: true, id, action, args });
  });
}
async function drain(h, userId, outDir, args, status) {
  await ipc(h, 'start', { userId });
  const deadline = Date.now() + args.learningTimeoutMin * 60_000;
  let quiet = 0, slept = false, last;
  while (Date.now() < deadline) {
    last = await ipc(h, 'status', { userId });
    await atomic(`${outDir}/learning-jobs.json`, last);
    const pending = last.jobs.filter(j => ['queued', 'running'].includes(j.status) && (args.arm !== 'F' || j.kind !== 'consolidate'));
    if (!pending.length && !last.worker.running) quiet++; else quiet = 0;
    if (quiet >= 3) {
      if (!slept && args.arm !== 'F') {
        await ipc(h, 'sleep', { userId, key: path.basename(outDir) });
        status('learning sleep pass queued through ProductJobs'); slept = true; quiet = 0;
      } else {
        await ipc(h, 'pause', { userId });
        status(`learning settled: ${last.jobs.length} jobs; failed=${last.jobs.filter(j => j.status === 'failed').length}`);
        return last;
      }
    }
    await sleep(5000);
  }
  throw new Error(`Learning did not settle in ${args.learningTimeoutMin} minutes; resume with the same command (learning-jobs.json has details).`);
}
async function modelStats(dataDir, record) {
  const rows = (await fs.readFile(`${dataDir}/model-requests.jsonl`, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse)
    .filter(row => row.at >= record.startedAt && row.at <= record.finishedAt);
  const agent = rows.filter(row => row.tools > 0);
  return { requests: rows.length, agentRequests: agent.length, maxEstimatedContextTokens: Math.max(0, ...agent.map(row => row.bytes / 4)),
    contextEstimate: 'Maximum model-request JSON bytes / 4, including schemas; proxy, not provider tokenization.' };
}
export async function methodLibrary(api) {
  const items = [], seen = new Set();
  let cursor = null;
  do {
    const response = await api.call('GET', `/api/methods?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (response.status !== 200 || !Array.isArray(response.json?.data?.items)) throw new Error(`Method library snapshot failed: HTTP ${response.status}`);
    items.push(...response.json.data.items);
    cursor = response.json.data.nextCursor ?? null;
    if (cursor && seen.has(cursor)) throw new Error('Method library cursor repeated');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { data: { items, nextCursor: null } };
}
export function reuseOf(rows, learnedNames = []) {
  const cases = new Map();
  for (const row of rows) for (const method of row.methodsOpened ?? []) {
    if (!cases.has(method.name)) cases.set(method.name, new Set());
    cases.get(method.name).add(row.case);
  }
  const reused = [...cases].filter(([, ids]) => ids.size > 1).map(([name]) => name);
  const learned = [...new Set(learnedNames)];
  const learnedOpened = learned.filter(name => cases.has(name));
  return { openedMethods: cases.size, reusedAcrossExamCases: reused, crossTaskShare: cases.size ? reused.length / cases.size : null,
    learnedMethods: learned.length, learnedOpenedInExam: learnedOpened, learnedTransferShare: learned.length ? learnedOpened.length / learned.length : null,
    definition: 'Distinct exam case IDs, not repetitions. Learned transfer = approved account methods opened in an exam / approved account methods after learning.' };
}
export async function summary(outDir, arm) {
  const rows = [];
  for (const name of await fs.readdir(`${outDir}/records`).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const record = JSON.parse(await fs.readFile(`${outDir}/records/${name}`, 'utf8'));
    if (record.phase !== 'exam') continue;
    const judged = JSON.parse(await fs.readFile(`${outDir}/judged/${name}`, 'utf8').catch(() => '{}'));
    const entry = judged.entries?.[record.cell];
    const model = JSON.parse(await fs.readFile(`${outDir}/model-judged/${name}`, 'utf8').catch(() => '{}')).entries?.[record.cell];
    const verdict = entry?.status === 'fail' || model?.verdict === 'not_satisfied' ? 'fail'
      : entry?.status === 'pass' && model?.verdict === 'satisfied' ? 'pass' : 'unjudged';
    const usage = record.turns.map(turn => turn.run?.usage ?? {});
    const scoredTurns = record.turns.slice(record.turnOffsets?.[record.cell] ?? 0);
    rows.push({ name, case: record.cell, rep: record.rep, status: verdict, deterministicStatus: entry?.status ?? 'unjudged', semanticVerdict: model?.verdict ?? null, failedChecks: entry?.failedChecks ?? [], wallMs: record.wallMs,
      inputTokens: usage.reduce((n, u) => n + (u.inputTokens ?? 0), 0), outputTokens: usage.reduce((n, u) => n + (u.outputTokens ?? 0), 0),
      methodsMounted: scoredTurns.flatMap(t => t.run?.methodsLoaded ?? []), methodsOpened: scoredTurns.flatMap(t => t.run?.methodsInvoked ?? []),
      toolChain: record.turns.flatMap(t => t.tools?.map(tool => tool.name) ?? []), evoDS: composite(entry ? { ...entry, status: verdict } : null, record) });
  }
  const passed = rows.filter(row => row.status === 'pass').length;
  const learning = JSON.parse(await fs.readFile(`${outDir}/learning-complete.json`, 'utf8').catch(() => '{}'));
  const accountUsage = JSON.parse(await fs.readFile(`${outDir}/account-usage.json`, 'utf8').catch(() => '{}'));
  const reuse = reuseOf(rows, (learning.methods?.data?.items ?? []).filter(method => method.status === 'approved').map(method => method.name));
  const result = { arm, reuse, learningUsage: learning.usage ?? null, accountUsage, examRuns: rows.length, passed, passRate: rows.length ? passed / rows.length : null, wilson95: wilson(passed, rows.length),
    uncertainty: 'Wilson interval treats repeated cases as independent; descriptive only. Repetitions share an account.',
    deterministicPassed: rows.filter(row => row.deterministicStatus === 'pass').length,
    semanticSatisfied: rows.filter(row => row.semanticVerdict === 'satisfied').length,
    unjudged: rows.filter(row => row.status === 'unjudged').length,
    failed: rows.filter(row => row.status === 'fail').length,
    failureRate: rows.length ? rows.filter(row => row.status === 'fail').length / rows.length : null,
    tokens: rows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0), wallSeconds: rows.reduce((n, r) => n + r.wallMs / 1000, 0),
    evoDS: rows.length ? rows.reduce((n, r) => n + r.evoDS.score, 0) / rows.length : null,
    terms: { result: '1 when all required deterministic checks pass AND the Qwen general-task rubric judge is satisfied; else 0 (unknown is not a pass).',
      subtask: 'Fraction of decidable required deterministic checks passing; proxy for subtask reward.',
      contextShare: 'Maximum agent request JSON bytes / 4 / 1,000,000, capped at 1; proxy includes tool schemas.',
      turnShare: 'Agent model requests / 100, capped at 1; proxy for reasoning/tool turns.',
      costs: 'Run ledger input+output tokens; learning and engine tokens are separate, not included in exam total.' }, rows };
  await atomic(`${outDir}/l3-summary.json`, result);
  await fs.writeFile(`${outDir}/l3-summary.txt`, `${arm}: ${passed}/${rows.length}; Wilson95=${JSON.stringify(result.wilson95)}; tokens=${result.tokens}; wall_s=${result.wallSeconds}; EvoDS=${result.evoDS}\n`);
  return result;
}
async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args.arms) {
    for (const arm of args.arms.split(',')) {
      const forwarded = process.argv.slice(2); const index = forwarded.indexOf('--arms'); forwarded.splice(index, 2, '--arm', arm);
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...forwarded], { stdio: 'inherit' });
      const code = await new Promise(resolve => child.on('exit', resolve));
      if (code !== 0) throw new Error(`Arm ${arm} exited ${code}; later arms remain unstarted.`);
    }
    return;
  }
  const env = armEnv(args.arm);
  Object.assign(process.env, env);
  const outDir = path.resolve(args.out ?? `/srv/evimed/runs/l3-${args.arm}-1`);
  await fs.mkdir(`${outDir}/records`, { recursive: true });
  await fs.mkdir(`${outDir}/judged`, { recursive: true });
  const status = message => {
    const line = `${new Date().toISOString()} L3 ${args.arm} ${message}\n`;
    process.stdout.write(line); fsSync.appendFileSync(`${outDir}/STATUS`, line);
    if (process.env.L3_STATUS_FILE) fsSync.appendFileSync(process.env.L3_STATUS_FILE, line);
  };
  if (args.summarizeOnly) { await summary(outDir, args.arm); return; }
  const treeOs = path.resolve(args.tree ?? OS);
  const raw = await fs.readFile(`${SUITE}/cases.json`);
  const cases = JSON.parse(raw).cases;
  const split = JSON.parse(await fs.readFile(`${HERE}/../pools/l3-split-20261109.json`, 'utf8'));
  if ((args.smokeLearning || args.smokeCases) && !args.smoke) throw new Error('Targeted case overrides are smoke-only; full L3 always uses the frozen split.');
  const learningIds = args.smoke ? (args.smokeLearning?.split(',') ?? []) : split.learning;
  const exams = args.smoke ? (args.smokeCases?.split(',') ?? ['G04', 'M01']) : split.exam;
  if (learningIds.some(id => !split.learning.includes(id)) || exams.some(id => !split.exam.includes(id))) throw new Error('Smoke cases must respect the frozen learning/exam split.');
  if (createHash('sha256').update(raw).digest('hex') !== split.sourceSha256) throw new Error('Frozen L3 cases digest changed');
  const dataDir = path.resolve(args.dataDir ?? `/srv/evimed/pp/data/${path.basename(outDir)}`);
  const live = process.env.EVAL_LIVE_DIR ?? '/tmp/eval/live';
  const dbName = `evimed_test_l3_${args.arm.toLowerCase()}_${args.smoke ? 'smoke' : 'full'}`;
  await ensurePostgres(args.pgPort); await ensureDatabase(args.pgPort, dbName);
  const seed = spawnSync('bash', [`${SUITE}/runner/seed.sh`], { encoding: 'utf8', env: { ...process.env, OS: treeOs, L: live, SEED_FROM: args.seedFrom ?? '/srv/evimed/pp/seed/dsh-seed' }, maxBuffer: 16 * 1024 * 1024 });
  process.stderr.write(seed.stderr ?? '');
  if (seed.status !== 0) throw new Error('seed failed');
  const treeDir = seed.stdout.trim().split('\n').pop();
  const commit = process.env.EVAL_TREE_COMMIT || spawnSync('git', ['-C', treeOs, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const harnessSource = ['run_l3.mjs', ...['A','B','E','D','F'].map(arm => `arms/${arm}.env`)];
  const harnessSha256 = createHash('sha256');
  for (const file of harnessSource) harnessSha256.update(await fs.readFile(`${HERE}/${file}`));
  for (const file of ['run.mjs','harness.mjs','cell.mjs','seed.sh','learning-control.mjs','eval-memory-observer.mjs']) harnessSha256.update(await fs.readFile(`${SUITE}/runner/${file}`));
  const prior = JSON.parse(await fs.readFile(`${outDir}/run.json`, 'utf8').catch(() => '{}'));
  if (prior.arm && prior.arm !== args.arm) throw new Error('Cannot resume an output directory with a different treatment arm.');
  await atomic(`${outDir}/run.json`, { attempts: [...(prior.attempts ?? []), { at: new Date().toISOString(), commit, args }], arm: args.arm, tree: { path: treeOs, commit }, split, env, args, harnessSha256: harnessSha256.digest('hex'), nativeControl: false,
    rankerOverride: 'Product ranker initialized even with learning off; production gates initialization on learning.',
    memoryToolsWait: args.waitMemoryTools, examLearning: 'automated dispatch; worker paused; no exam teaching',
    stubs: STUBS, learningSettlement: 'Product worker + explicit sleep job, evidence jobs brought forward; no fabricated lessons/approvals.' });
  let h;
  const shutdown = async () => { if (h) { const old = h; h = null; await stopHarness(old); } };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await shutdown(); process.exit(128 + (signal === 'SIGINT' ? 2 : 15)); });
  try {
    h = await startHarness({ args, treeOs, treeDir, dataDir, profile: 'normal', arm: 'B', dbUrl: `postgresql://coder@127.0.0.1:${args.pgPort}/${dbName}` });
    const facts = await ipc(h, 'facts');
    await atomic(`${outDir}/engine-facts.json`, facts);
    if (process.env.OPEN_SCIENCE_OPENVIKING_URL && !facts.nativeMemory?.ok) throw new Error(`Native memory engine is unavailable: ${JSON.stringify(facts.nativeMemory)}`);
    status(`harness ready pid=${h.pid} port=${args.port} database=${dbName}`);
    const api = new Api(h.base);
    const identityFile = `${outDir}/account.json`;
    let account;
    if (fsSync.existsSync(identityFile)) {
      account = JSON.parse(await fs.readFile(identityFile, 'utf8'));
      const login = await api.call('POST', '/api/auth/login', { username: account.username, password: 'eval-pass-1' }, { project: null });
      if (login.status !== 200) throw new Error(`Resume login failed: ${login.status}`);
      api.csrf = login.json?.data?.csrfToken ?? login.json?.data?.session?.csrfToken ?? '';
      if (!api.csrf) api.csrf = (await api.call('GET', '/api/me', undefined, { project: null })).json?.data?.csrfToken ?? '';
    } else { account = await registerAccount(api, `l3${args.arm.toLowerCase()}${Date.now().toString(36)}`); await atomic(identityFile, account, true); }
    const tree = { path: treeOs, commit };
    const execute = async (id, phase, rep) => {
      const name = `${phase}-${id}-r${rep}`;
      const file = `${outDir}/records/${name}.json`;
      if (fsSync.existsSync(file) && !JSON.parse(await fs.readFile(file, 'utf8')).infra) { judge(args, outDir, name); return; }
      status(`${phase} ${id} r${rep} start`);
      const spec = examSpec(id, cases);
      const cellDir = `${outDir}/records/${name}.files`;
      await fs.rm(cellDir, { recursive: true, force: true }); await fs.mkdir(cellDir, { recursive: true });
      const record = await runCell({ api, account, spec, dataDir, outDir: cellDir, fixtureRoot: `${SUITE}/fixtures`,
        timeoutMs: Math.max(args.timeoutMin, spec.timeout_min ?? 0) * 60_000, log: status, waitMemoryTools: args.waitMemoryTools, automated: phase === 'exam', observeMethods: identity => ipc(h, 'methods', identity) });
      Object.assign(record, { name, arm: args.arm, caseIds: [id], turnOffsets: spec.turnOffsets, prerequisite: spec.prerequisite, phase, rep, variant: 'normal', tree });
      record.modelRequests = await modelStats(dataDir, record);
      await atomic(`${outDir}/account-usage.json`, await ipc(h, 'usage', { userId: account.userId }));
      await atomic(file, record); judge(args, outDir, name); summarize(outDir); await summary(outDir, args.arm);
      status(`${phase} ${id} r${rep} recorded; memoryFirst=${record.firstRequest.hadMemoryTools}`);
      // Keep sources/transcripts through learning. The same account continues in a fresh project next time.
    };
    const phaseFile = `${outDir}/learning-complete.json`;
    const priorPhase = JSON.parse(await fs.readFile(phaseFile, 'utf8').catch(() => '{}'));
    if (!Array.isArray(priorPhase.methods?.data?.items)) {
      for (const id of learningIds) await execute(id, 'learning', 1);
      if (env.OPEN_SCIENCE_LEARNING_ENABLED === 'true') {
        status('learning drain start'); await drain(h, account.userId, outDir, args, status);
      }
      const methods = await methodLibrary(api);
      await atomic(phaseFile, { at: new Date().toISOString(), smokeSkipped: Boolean(args.smoke && !learningIds.length), learningCases: learningIds, methods, usage: await ipc(h, 'usage', { userId: account.userId }) });
      status('learning phase complete');
    }
    if (env.OPEN_SCIENCE_LEARNING_ENABLED === 'true') await ipc(h, 'pause', { userId: account.userId });
    for (let rep = 1; rep <= (args.smoke ? 1 : args.repeat); rep++) for (const id of exams) await execute(id, 'exam', rep);
    status('offline Qwen general-task rubric judge start');
    const modelJudge = spawn('python3', [`${SUITE}/judges/model_judge.py`, '--run', outDir, '--phase', 'exam',
      '--model', 'qwen3.8-max', '--api-base', 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      '--key-file', path.join(process.env.EVAL_SECRETS_DIR ?? '/srv/evimed/secrets', 'dashscope.api-key')], { stdio: 'inherit' });
    const judgeCode = await new Promise(resolve => modelJudge.on('exit', resolve));
    if (judgeCode !== 0) throw new Error(`Model judge failed with ${judgeCode}; resume to rejudge saved records`);
    summarize(outDir); await summary(outDir, args.arm); status('complete');
  } finally { await shutdown(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exit(1); });
