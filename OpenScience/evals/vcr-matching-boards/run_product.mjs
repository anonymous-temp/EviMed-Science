#!/usr/bin/env node
/**
 * The real product path over the boards: a throwaway account, a project, real uploads, a dispatch into a real DSH kernel with
 * automated attribution, the model calling the tools, the job finishing back into the conversation, and the saved judgments read
 * back from the platform and written in the JSONL `to_official.py` takes. One natural request per case; the arm is one short sentence.
 *
 *   job     the default behaviour of the product: a batch of pairs goes to the background judging job
 *   native  the same request plus a sentence asking the conversation to judge the listed trials itself and save them, no job
 *
 * The stack is the harness of the general-tasks suite (the platform's control plane and a real kernel on this host, only the
 * container launch replaced), started as `product_server.mjs`. That is a host-kernel diagnostic: the comparison campaign's formal
 * gate (`verifyCampaign` in `../vcr-platform-comparison/run.mjs`) refuses such a receipt by design and still does here. A run on
 * this stack needs `--diagnostic`, and what it writes says so.
 *
 *   node run_product.mjs --readiness  ...   start the stack, register an account, open a session, confirm the kernel boots,
 *                                           dispatch nothing, tear everything down
 *   node run_product.mjs --board sigir --arm native --diagnostic ...   run the cases
 *
 * Exit: 0 finished; 1 error; 2 refused before any paid call; 3 stopped by a guard or a signal; 4 some case did not settle.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchTransport, openThrowawayAccount } from '../../scripts/ops/throwaway-account.mjs';
import { usageBound, verifyCampaign } from '../vcr-platform-comparison/run.mjs';
import { BOARDS, SPLITS, fail, loadCases, rankingRecord } from './board_cases.mjs';
import { scoreRun } from './dev_job.mjs';
import { dropDatabase, ensureDatabase, scratchUrl, takeRunnerLock } from './devdb.mjs';
import { startFakeProvider } from './fake_provider.mjs';
import { DEFAULT_CAP_CNY, DEFAULT_FLOOR_CNY, GuardStop, createBalanceChecker, createSpendLedger, preflight, watch } from './spend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_PROVIDER = 'https://api.deepseek.com';
const ACTIVE = new Set(['queued', 'running', 'planned', 'dispatching', 'starting', 'waiting']);
const JOB_TERMINAL = new Set(['completed', 'succeeded', 'done', 'failed', 'canceled', 'cancelled']);
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const hash = (/** @type {Buffer | string} */ bytes) => createHash('sha256').update(bytes).digest('hex');
const rows = (/** @type {any} */ value) => (Array.isArray(value) ? value : value?.runs ?? value?.items ?? []);

export const EXIT = Object.freeze({ finished: 0, error: 1, refused: 2, stopped: 3, unsettled: 4 });
export const ARMS = Object.freeze(['job', 'native']);

// ---------------------------------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------------------------------

/** The one sentence that sets an arm. The job arm adds nothing: it is the product's own behaviour. */
const ARM_SENTENCE = Object.freeze({ job: '', native: '请你自己在这次对话里逐个判断这些试验并保存判断，不要启动后台作业。' });

/**
 * The case's request, in one natural paragraph. It names the files, the frozen archive the trial texts are in (a fact about the
 * data, as a person would say it) and where the result should end up; it names no tool and no step.
 * @param {{ arm: keyof typeof ARM_SENTENCE, collection: string }} input
 */
export function promptFor({ arm, collection }) {
  if (!Object.hasOwn(ARM_SENTENCE, arm)) throw fail(`The arm is ${ARMS.join(' or ')}.`, 'option_invalid');
  if (!/^[A-Za-z0-9_.:@-]{1,160}$/u.test(collection)) throw fail('Invalid collection.', 'option_invalid');
  return [
    '请看附件 patient.txt 里的患者，再看 trials.txt 里列出的候选临床试验，判断这位患者适合哪些试验，排好顺序，结果保存在平台里。',
    `这些试验的原文在平台的冻结试验库 ${collection} 里，请用它，不要查实时注册库。这是公开合成患者的研究测试，不涉及真实招募；不要联系患者。`,
    ARM_SENTENCE[arm],
    '附件已通过平台上传到 inputs/。',
  ].filter(Boolean).join('\n');
}

/**
 * Write each case's two input files and the manifest in the shape the comparison campaign's `verifyCampaign` reads (exactly
 * `patient.txt` and `trials.txt`, each with its hash). Nothing but the note and the candidate ids is written: no label exists here.
 * @param {{ cases: Array<Record<string, any>>, dir: string }} input
 */
export function writeCaseInputs({ cases, dir }) {
  const collection = String(cases[0]?.collection ?? '');
  const out = [];
  for (const row of cases) {
    if (String(row.collection) !== collection) throw fail('The cases of a run share one collection.', 'collection_ambiguous');
    const folder = path.join(dir, row.patientId);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const files = [['patient.txt', String(row.note)], ['trials.txt', `Frozen trial collection: ${collection}\nHistorical records; status is not current.\n${row.candidateIds.join('\n')}\n`]]
      .map(([name, text]) => { const file = path.join(folder, name); fs.writeFileSync(file, text, { mode: 0o600 }); return { name, path: file, sha256: hash(text) }; });
    out.push({ id: row.patientId, files });
  }
  return { version: 1, task: 'matching', collection, cases: out };
}

// ---------------------------------------------------------------------------------------------------------------------
// Settling and the stack's receipt
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Whether a case has settled, from what one poll saw. A case settles when its root run has ended, no run is active, every job of its
 * studies is terminal, and none of that has changed for `quietMs`: a job's completion starts a turn of the conversation, and that turn
 * must have its chance to begin before the case is called done.
 * @param {{ lastChangeAt: number, signature: string }} memory
 * @param {{ runs: Array<Record<string, any>>, rootRunId: string | null, jobs: Array<Record<string, any>> }} seen
 * @param {number} now @param {{ quietMs?: number }} [options]
 * @returns {{ memory: { lastChangeAt: number, signature: string }, state: 'working' | 'quiet' | 'settled' | 'awaiting_budget' }}
 */
export function settleStep(memory, seen, now, { quietMs = 20_000 } = {}) {
  const runStates = seen.runs.map((run) => `${run.id}:${run.status}`).sort();
  const jobStates = seen.jobs.map((job) => `${job.id}:${job.state ?? job.status}`).sort();
  const signature = JSON.stringify([runStates, jobStates]);
  const next = signature === memory.signature ? memory : { lastChangeAt: now, signature };
  const root = seen.rootRunId ? seen.runs.find((run) => run.id === seen.rootRunId) : null;
  const anyActive = seen.runs.some((run) => ACTIVE.has(run.status));
  const jobsOpen = seen.jobs.some((job) => !JOB_TERMINAL.has(job.state ?? job.status));
  if (root && !anyActive && seen.jobs.some((job) => (job.state ?? job.status) === 'awaiting_budget')) return { memory: next, state: 'awaiting_budget' };
  if (!root || anyActive || jobsOpen) return { memory: next, state: 'working' };
  return { memory: next, state: now - next.lastChangeAt >= quietMs ? 'settled' : 'quiet' };
}

/**
 * Whether the stack's receipt may be used for this run. A formal run goes through the comparison campaign's `verifyCampaign`, which
 * refuses a host-kernel receipt; a diagnostic run accepts one only if it says what it is and its isolation settings took effect.
 * @param {{ receipt: Record<string, any>, diagnostic: boolean, origin: string, pinned: string | null, formal?: () => Promise<unknown> }} input
 */
export async function acceptReceipt({ receipt, diagnostic, origin, pinned, formal }) {
  if (!diagnostic) {
    if (!formal) throw fail('A formal run needs the container stack; this stack is a host-kernel diagnostic.', 'formal_refused');
    await formal();
    return { diagnostic: false };
  }
  const config = receipt.resolvedConfig ?? {};
  const problems = [
    receipt.diagnostic !== true && 'the receipt does not say it is a diagnostic',
    receipt.origin !== origin && 'the receipt names another origin',
    !/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) && 'the origin is not local',
    !receipt.instance && 'the receipt names no server instance',
    receipt.budget?.allModelPurposes !== true && 'the benchmark budget is not installed',
    ['memoryEnabled', 'memoryRecallEnabled', 'nativeMemoryTurnCommitEnabled', 'learningEnabled'].some((key) => config[key] !== false) && 'memory or learning is on',
    config.production && 'the configuration is production',
    pinned && receipt.kernelVersion !== pinned && `the kernel is ${receipt.kernelVersion}, the pin is ${pinned}`,
  ].filter(Boolean);
  if (problems.length) throw fail(`The stack is not usable for a diagnostic run: ${problems.join('; ')}.`, 'receipt_refused');
  return { diagnostic: true, isolation: receipt.isolation, kernelVersion: receipt.kernelVersion, sourceSha: receipt.sourceSha, dirty: receipt.dirty };
}

// ---------------------------------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------------------------------

const OPTIONS = {
  board: { type: 'string' }, split: { type: 'string', default: 'dev' }, arm: { type: 'string' }, 'limit-patients': { type: 'string' },
  readiness: { type: 'boolean', default: false }, diagnostic: { type: 'boolean', default: false }, 'plan-only': { type: 'boolean', default: false },
  'data-dir': { type: 'string' }, boards: { type: 'string' }, 'live-root': { type: 'string' }, os: { type: 'string' }, 'dsh-bin': { type: 'string' },
  'key-file': { type: 'string' }, 'base-url': { type: 'string', default: REAL_PROVIDER }, 'db-url': { type: 'string' }, 'db-name': { type: 'string', default: 'evimed_test_vmlive' },
  'cap-cny': { type: 'string', default: String(DEFAULT_CAP_CNY) }, 'floor-cny': { type: 'string', default: String(DEFAULT_FLOOR_CNY) }, 'case-cny': { type: 'string', default: '2' },
  'budget-cny': { type: 'string', default: '30' }, 'allow-peak': { type: 'boolean', default: false }, concurrency: { type: 'string', default: '8' },
  'case-timeout-min': { type: 'string', default: '45' }, 'quiet-seconds': { type: 'string', default: '20' }, score: { type: 'string', default: 'auto' },
  tg2: { type: 'string' }, tg1: { type: 'string' }, labels: { type: 'string' }, 'eval-python': { type: 'string' }, out: { type: 'string' }, 'check-minutes': { type: 'string', default: '5' },
  'sha': { type: 'string' }, 'manifest-out': { type: 'string' }, 'startup': { type: 'string' },
};

/** @param {string | undefined} value @param {string} name @param {number} min @param {number} max */
function whole(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw fail(`${name} is a whole number from ${min} to ${max}.`, 'option_invalid');
  return number;
}

/** @param {string[]} argv @param {Record<string, string | undefined>} [env] */
export function parseOptions(argv, env = process.env) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  const readiness = Boolean(values.readiness);
  const board = /** @type {keyof typeof BOARDS} */ (values.board ?? 'sigir');
  if (!BOARDS[board]) throw fail(`--board is one of ${Object.keys(BOARDS).join(', ')}.`, 'option_invalid');
  if (BOARDS[board].answer !== 'ranking') throw fail('The product runner takes the ranking boards (sigir, trec2021, trec2022, nih); the criterion board is run by dev_job.', 'option_invalid');
  const arm = String(values.arm ?? 'job');
  if (!ARMS.includes(arm)) throw fail(`--arm is one of ${ARMS.join(', ')}.`, 'option_invalid');
  if (!SPLITS.includes(String(values.split))) throw fail(`--split is one of ${SPLITS.join(', ')}.`, 'option_invalid');
  const dataDir = values['data-dir'] ?? env.VCR_BOARDS_DATA;
  const boards = values.boards ?? env.VCR_BOARDS_INPUTS;
  const liveRoot = values['live-root'] ?? env.VCR_BOARDS_LIVE;
  const tree = values.os ?? env.OS;
  if (!dataDir) throw fail('--data-dir (or VCR_BOARDS_DATA) names the private directory for outputs.', 'option_missing');
  if (!liveRoot) throw fail('--live-root (or VCR_BOARDS_LIVE) names the staged stack (live_stack.sh).', 'option_missing');
  if (!tree) throw fail('--os (or OS) names the OpenScience tree under test.', 'option_missing');
  if (!readiness && !boards) throw fail('--boards (or VCR_BOARDS_INPUTS) names the prepared inputs directory.', 'option_missing');
  const keyFile = values['key-file'] ?? env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE;
  if (!keyFile) throw fail('--key-file (or OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE) names the DeepSeek key file; the key is never printed.', 'option_missing');
  const score = String(values.score);
  if (!['auto', 'yes', 'no'].includes(score)) throw fail('--score is auto, yes or no.', 'option_invalid');
  return {
    readiness, board, arm, split: String(values.split), diagnostic: Boolean(values.diagnostic), planOnly: Boolean(values['plan-only']),
    limitPatients: values['limit-patients'] == null ? null : whole(values['limit-patients'], '--limit-patients', 1, 100_000),
    dataDir: path.resolve(dataDir), boardsDir: boards ? path.resolve(boards) : null, liveRoot: path.resolve(liveRoot), tree: path.resolve(tree),
    dshBin: values['dsh-bin'] ? path.resolve(values['dsh-bin']) : path.join(path.resolve(liveRoot), 'kernel/node_modules/.bin/dsh'), keyFile: path.resolve(keyFile),
    baseUrl: String(values['base-url']), dbUrl: values['db-url'] ?? env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? null, dbName: String(values['db-name']),
    capCny: Number(values['cap-cny']), floorCny: Number(values['floor-cny']), caseCny: Number(values['case-cny']), budgetCny: Number(values['budget-cny']),
    allowPeak: Boolean(values['allow-peak']), concurrency: whole(values.concurrency, '--concurrency', 1, 64),
    caseTimeoutMs: whole(values['case-timeout-min'], '--case-timeout-min', 1, 600) * 60_000, quietMs: whole(values['quiet-seconds'], '--quiet-seconds', 0, 600) * 1000, checkMs: Number(values['check-minutes']) * 60_000,
    score, tg2: values.tg2 ?? env.VCR_BOARDS_TG2 ?? null, tg1: values.tg1 ?? env.VCR_BOARDS_TG1 ?? null, labels: values.labels ?? env.VCR_BOARDS_LABELS ?? null,
    evalPython: values['eval-python'] ?? env.VCR_BOARDS_PYTHON ?? 'python3', out: values.out ? path.resolve(values.out) : null,
    sha: values.sha ?? null, startup: values.startup ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The server process
// ---------------------------------------------------------------------------------------------------------------------

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = /** @type {net.AddressInfo} */ (server.address()); server.close(() => resolve(port)); });
  });
}

/** Processes whose command line carries a path under one of `dirs`: the kernels this run's server started, and nothing else. @param {...string} dirs */
export function ownedProcesses(...dirs) {
  const mine = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
    try {
      const line = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ');
      if (dirs.some((dir) => dir && line.includes(`${dir}${path.sep}`)) && /\bdsh\b/u.test(line)) mine.push(Number(entry));
    } catch { /* gone */ }
  }
  return mine;
}

/**
 * Start `product_server.mjs` and wait until it answers and has written its receipt. The child is this process's own; stopping it
 * asks it to close (its shutdown stops the runtimes it started), then ends it, then reaps any kernel still carrying this run's paths.
 * @param {Record<string, any>} o @param {{ manifest?: string, dataDir: string, databaseUrl: string, log?: (line: string) => void }} input
 */
export async function startServer(o, { manifest = '', dataDir, databaseUrl, log = () => {} }) {
  const port = await freePort();
  // A runtime's control socket lives under the data directory and a unix socket path is at most 107 bytes; the control plane refuses a
  // longer one (and refuses a data directory that is a link), so the server's data directory is a short real one beside the stack.
  const liveData = path.join(o.liveRoot, `d-${hash(dataDir).slice(0, 6)}`);
  if (Buffer.byteLength(liveData, 'utf8') + 51 > 107) throw fail(`The live root is too deep for a runtime socket (${liveData}); use a shorter --live-root.`, 'path_too_long');
  fs.mkdirSync(liveData, { recursive: true, mode: 0o700 });
  const receiptFile = path.join(dataDir, 'startup.json');
  fs.rmSync(receiptFile, { force: true });
  const env = {
    PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: process.env.TMPDIR ?? '/tmp',
    OS: o.tree, TREE_DIR: o.liveRoot, LIVE_DIR: o.liveRoot, LIVE_DATA: liveData, LIVE_PORT: String(port), LIVE_DATABASE_URL: databaseUrl, DSH_BIN: o.dshBin,
    EVAL_DEEPSEEK_KEY_FILE: o.keyFile, VCR_BENCHMARK_BUDGET_FILE: path.join(dataDir, 'budget.json'), VCR_BENCHMARK_BUDGET_CNY: String(o.budgetCny),
    VCR_STARTUP_RECEIPT: receiptFile, PRODUCT_MODEL_BASE_URL: o.baseUrl, PRODUCT_JUDGE_CONCURRENCY: String(o.concurrency), ...(manifest ? { VCR_COLLECTION_MANIFEST: manifest } : {}),
  };
  const logFile = path.join(dataDir, 'server.log');
  const out = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [path.join(HERE, 'product_server.mjs')], { env, stdio: ['ignore', out, out], cwd: dataDir });
  fs.closeSync(out);
  let exited = false;
  child.once('exit', () => { exited = true; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 180_000;
  try {
    for (;;) {
      if (exited) throw fail(`The server exited while starting (${logFile}).`, 'server_exited');
      if (fs.existsSync(receiptFile)) {
        const live = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (live?.ok) break;
      }
      if (Date.now() > deadline) throw fail('The server did not come up in time.', 'server_timeout');
      await sleep(500);
    }
  } catch (error) {
    await stopServer(child, dataDir, log, liveData);
    throw error;
  }
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  log(`[run_product] server up at ${base} (pid ${child.pid}, kernel ${receipt.kernelVersion})`);
  return { base, child, receipt, receiptFile, logFile, dataDir, liveData, instance: String(receipt.instance) };
}

/** @param {import('node:child_process').ChildProcess} child @param {string} dataDir @param {(line: string) => void} [log] @param {string} [liveData] */
export async function stopServer(child, dataDir, log = () => {}, liveData = '') {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 45_000);
      child.once('exit', () => { clearTimeout(timer); resolve(null); });
    });
  }
  const left = ownedProcesses(dataDir, liveData);
  for (const pid of left) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  if (left.length) log(`[run_product] ended ${left.length} kernel process(es) still carrying this run's paths`);
}

// ---------------------------------------------------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One case on the product path. Everything that can fail ends in the account's deletion. `deps` replaces the account, the
 * transport and the reader in tests; the dispatch, the polling and the cleanup are the same code.
 *
 * @param {{ base: string, instance?: string | null, row: Record<string, any>, files: Array<{ name: string, path: string, sha256: string }>, arm: keyof typeof ARM_SENTENCE,
 *   outDir: string, timeoutMs: number, quietMs: number, signal?: AbortSignal | null,
 *   read: (input: { userId: string, projectId: string }) => Promise<{ ranking: any[], failed: any[], usage: Record<string, number> | null, readFrom: string, studies: string[], subjects: number }>,
 *   deps?: { openAccount?: typeof openThrowawayAccount, fetchImpl?: typeof fetch, now?: () => number, sleepMs?: (ms: number) => Promise<unknown>, pollMs?: number } }} input
 */
export async function runBoardCase({ base, instance = null, row, files, arm, outDir, timeoutMs, quietMs, signal = null, read, deps = {} }) {
  const { openAccount = openThrowawayAccount, fetchImpl = fetch, now = Date.now, sleepMs = sleep, pollMs = 3000 } = deps;
  const folder = path.join(outDir, row.patientId);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  /** @type {Record<string, any>} */
  const record = { caseId: row.patientId, arm, startedAt: new Date(now()).toISOString(), status: 'starting', requests: [] };
  let account, projectId = '', sessionId = '', projectCreated = false, interrupted = false;
  const deadline = now() + timeoutMs;
  const controller = new AbortController();
  const onAbort = () => { interrupted = true; controller.abort(); };
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) onAbort();
  let sequence = 0;
  /** @param {string} method @param {string} route @param {unknown} [body] @param {{ allowed?: number[], cleanup?: boolean }} [options] */
  const api = async (method, route, body, { allowed = [200, 201, 202], cleanup = false } = {}) => {
    if (interrupted && !cleanup) throw new Error('Campaign interrupted');
    if (!cleanup && now() >= deadline) throw new Error('Case deadline exceeded');
    const timer = AbortSignal.timeout(cleanup ? 15_000 : Math.max(1, Math.min(30_000, deadline - now())));
    const response = await fetchImpl(base + route, {
      method, redirect: 'error', signal: cleanup ? timer : AbortSignal.any([timer, controller.signal]),
      headers: { 'content-type': 'application/json', origin: base, ...account.headers, 'x-evimed-automated': '1', ...(projectId ? { 'x-open-science-project': projectId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (instance && response.headers.get('x-evimed-benchmark-instance') !== instance) throw new Error('Benchmark server instance changed');
    const data = await response.json().catch(() => ({}));
    record.requests.push({ sequence: ++sequence, method, route, status: response.status });
    if (!allowed.includes(response.status)) throw Object.assign(new Error(`${method} ${route}: ${response.status} ${data?.code ?? ''}`), { code: data?.code });
    return data?.data ?? null;
  };
  /** The studies the platform made for this project, by the account's own list. */
  const studiesOf = async (options = {}) => {
    const home = await api('GET', '/api/vcr/studies', undefined, options).catch(() => null);
    const found = [...(home?.conversationStudies ?? []), ...(home?.studies ?? [])].filter((study) => study.projectId === projectId);
    return [...new Map(found.map((study) => [study.id, study])).values()];
  };
  const quiesce = async () => {
    if (!account || !projectCreated) return;
    for (const run of rows(await api('GET', '/api/agent-runs', undefined, { cleanup: true }).catch(() => []))) if (ACTIVE.has(run.status)) await api('POST', `/api/agent-runs/${run.id}/cancel`, {}, { cleanup: true }).catch(() => {});
    for (const study of await studiesOf({ cleanup: true })) {
      const jobs = await api('GET', `/api/vcr/studies/${study.id}/jobs`, undefined, { cleanup: true }).catch(() => ({ jobs: [] }));
      for (const job of jobs.jobs ?? []) if (!JOB_TERMINAL.has(job.state ?? job.status)) await api('POST', `/api/vcr/studies/${study.id}/jobs/${encodeURIComponent(job.id)}/cancel`, {}, { cleanup: true }).catch(() => {});
    }
    const until = now() + 30_000;
    for (;;) {
      const open = [];
      for (const study of await studiesOf({ cleanup: true })) open.push(...((await api('GET', `/api/vcr/studies/${study.id}/jobs`, undefined, { cleanup: true }).catch(() => ({ jobs: [] }))).jobs ?? []).filter((job) => !JOB_TERMINAL.has(job.state ?? job.status)));
      if (!open.length) break;
      if (now() >= until) throw new Error('Owned jobs did not stop');
      await sleepMs(500);
    }
  };
  const stop = async () => { await quiesce(); if (projectCreated) await api('POST', '/api/commands/stop_runtime', {}, { cleanup: true }); };
  try {
    if (interrupted) throw new Error('Campaign interrupted before registration');
    account = await openAccount({ base, send: fetchTransport(base), prefix: 'vmprod', signals: false, stop, say: (message) => { (record.accountEvents ??= []).push(message); } });
    record.accountId = account.id;
    projectId = `vmb-${row.patientId}-${randomUUID().slice(0, 8)}`.slice(0, 64);
    record.projectId = projectId;
    await api('POST', '/api/projects', { id: projectId, name: `Board ${row.patientId}` });
    projectCreated = true;
    record.uploads = [];
    for (const file of files) {
      const bytes = fs.readFileSync(file.path);
      if (hash(bytes) !== file.sha256) throw new Error('Frozen input changed');
      const uploaded = await api('POST', '/api/files/upload', { root: 'workspace', path: `inputs/${file.name}`, data: bytes.toString('base64'), encoding: 'base64' });
      record.uploads.push({ name: file.name, sha256: file.sha256, sourceId: uploaded?.source?.id ?? null, vcrInput: uploaded?.vcrInput ?? null, vcrInputWarning: uploaded?.vcrInputWarning ?? null });
    }
    sessionId = (await api('POST', '/api/runtime/sessions', {})).id;
    record.sessionId = sessionId;
    await api('PUT', `/api/research-sessions/${sessionId}`, { mode: 'open-domain' });
    record.prompt = promptFor({ arm, collection: String(row.collection) });
    record.dispatchAttempted = true;
    const run = await api('POST', '/api/agent-runs/dispatch', { sessionId, dispatchId: `vmboard-${randomUUID()}`, text: record.prompt, automated: true, line: 'answer' });
    record.runId = run.id;
    record.status = 'running';
    let memory = { lastChangeAt: now(), signature: '' };
    let settled = false;
    while (now() < deadline && !interrupted) {
      const runs = rows(await api('GET', '/api/agent-runs'));
      if (runs.some((entry) => entry.automated !== true)) throw new Error('An unmarked run entered the campaign');
      const jobs = [];
      for (const study of await studiesOf()) jobs.push(...((await api('GET', `/api/vcr/studies/${study.id}/jobs`)).jobs ?? []));
      const step = settleStep(memory, { runs, rootRunId: run.id, jobs }, now(), { quietMs });
      memory = step.memory;
      record.rootOutcome = runs.find((entry) => entry.id === run.id)?.status ?? null;
      record.runs = runs;
      record.jobs = jobs;
      if (step.state === 'awaiting_budget') { record.status = 'awaiting_budget'; break; }
      if (step.state === 'settled') { settled = true; break; }
      await sleepMs(pollMs);
    }
    record.status = settled ? (['completed', 'succeeded', 'done'].includes(record.rootOutcome) ? 'settled' : 'run_failed')
      : interrupted ? 'interrupted' : record.status === 'awaiting_budget' ? 'awaiting_budget' : 'timed_out';
    if (!settled) await quiesce().catch((error) => { record.quiesceError = error.message; });
    // The saved judgments, read back from the platform before the account (and its usage rows) is deleted.
    record.transcript = await api('GET', `/api/runtime/sessions/${sessionId}/transcript`, undefined, { cleanup: !settled || interrupted }).catch((error) => ({ error: error.message }));
    record.saved = await read({ userId: account.id, projectId });
    record.outputs = await api('GET', `/api/sources/outputs?projectId=${encodeURIComponent(projectId)}`, undefined, { cleanup: !settled || interrupted }).catch(() => null);
    if (record.status === 'settled' && !record.saved.ranking.length && !record.saved.failed.length) record.status = 'missing_feature_result';
  } catch (error) {
    record.status = interrupted ? 'interrupted' : 'failed';
    record.error = { message: /** @type {any} */ (error).message, code: /** @type {any} */ (error).code ?? null };
    if (!account && /** @type {any} */ (error).account) { record.accountId = /** @type {any} */ (error).account; record.cleanup = { deleted: false, reason: 'registration_outcome_uncertain' }; }
    if (account && !record.saved) record.saved = await read({ userId: account.id, projectId }).catch(() => null);
  } finally {
    if (account) {
      await stop().catch((error) => { record.stopError = error.message; });
      record.usage = await api('GET', '/api/account/usage', undefined, { cleanup: true }).catch(() => null);
      record.cleanup = record.stopError && record.dispatchAttempted ? { deleted: false, reason: record.stopError } : await account.close();
      if (!record.cleanup.deleted) record.status = 'cleanup_failed';
    }
    record.finishedAt = new Date(now()).toISOString();
    // The conversation and the saved rows stay in the case folder; the account and its data do not.
    fs.writeFileSync(path.join(folder, 'case.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    signal?.removeEventListener('abort', onAbort);
  }
  return record;
}

/**
 * The line of the export for one case: the ranking record the scorer reads, from what the platform saved. A case with no saved
 * judgment is an empty record and says why.
 * @param {Record<string, any>} row @param {Record<string, any>} record
 */
export function exportRecord(row, record) {
  const saved = record.saved ?? { ranking: [], failed: [], usage: null };
  const base = rankingRecord({ case: row, ranking: saved.ranking ?? [], failed: saved.failed ?? [], usage: saved.usage ?? null });
  return { ...base, ...(base.status === 'none' ? { why: record.status } : {}), caseStatus: record.status, arm: record.arm };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading what was saved
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The reader over the harness database: the platform's own judgment reader (`matchJudgmentReads`, the one the model's reads and the
 * pages go through) composed over the same database the server writes to. Evidence projection needs the data plane and a ranking
 * does not, so it is left out; nothing is written.
 * @param {{ databaseUrl: string, tree: string }} input
 */
export async function createSavedReader({ databaseUrl, tree }) {
  const { loadConfig } = await import(pathToFileURL(path.join(tree, 'apps/server/src/config.mjs')).href);
  const { ControlPlaneDatabase } = await import(pathToFileURL(path.join(tree, 'apps/server/src/controlPlaneDatabase.mjs')).href);
  const { composeVcr } = await import(pathToFileURL(path.join(tree, 'apps/server/src/vcrComposition.mjs')).href);
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 3, databaseConnectionTimeoutMs: 5000 });
  const config = loadConfig({ databaseUrl, stateStore: 'postgres', deepseekApiKey: 'reader-only-no-calls', vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: '' });
  const vcr = composeVcr({ config, productDatabase: database });
  return {
    close: () => database.close(),
    /** @param {{ userId: string, projectId: string }} input */
    async read({ userId, projectId }) {
      const found = await database.query('SELECT id FROM evimed_vcr.studies WHERE user_id = $1 AND project_id = $2 AND deleted_at IS NULL ORDER BY created_at', [userId, projectId]);
      const studies = found.rows.map((/** @type {any} */ study) => String(study.id));
      /** @type {Map<string, { study: any, key: string, judged: number }>} */
      const subjects = new Map();
      for (const id of studies) {
        const study = await vcr.store.studyById(id);
        if (!study) continue;
        const keys = await database.query('SELECT subject_key, count(*) FILTER (WHERE status = $2)::int AS judged FROM evimed_vcr.match_judgments WHERE study_id = $1 GROUP BY subject_key', [id, 'done']);
        for (const key of keys.rows) subjects.set(`${id}\u0000${key.subject_key}`, { study, key: String(key.subject_key), judged: Number(key.judged) });
      }
      // One patient per case; more than one is the model's doing and is reported, the best-judged one is read.
      const chosen = [...subjects.values()].sort((a, b) => b.judged - a.judged)[0];
      if (!chosen) return { ranking: [], failed: [], usage: await usageOf(database, userId), readFrom: 'saved judgments', studies, subjects: 0 };
      /** @type {any[]} */ const ranking = [];
      for (let offset = 0; ; offset += 500) {
        const page = await vcr.matchJudgmentReads.forSubject(chosen.study, chosen.key, { limit: 500, offset });
        ranking.push(...page.ranking);
        if (!page.more) break;
      }
      const rowsOf = await vcr.matchJudgments.list({ studyId: chosen.study.id, subjectKey: chosen.key });
      const done = new Set(rowsOf.filter((/** @type {any} */ entry) => entry.status === 'done').map((/** @type {any} */ entry) => entry.targetId));
      const failed = rowsOf.filter((/** @type {any} */ entry) => entry.status === 'failed' && !done.has(entry.targetId)).map((/** @type {any} */ entry) => ({ registryId: entry.targetId, code: String(entry.errorCode ?? 'unknown') }));
      const producers = [...new Set(rowsOf.map((/** @type {any} */ entry) => entry.producer))];
      return { ranking, failed, usage: await usageOf(database, userId), readFrom: `saved judgments (${producers.join('+') || 'none'})`, studies, subjects: subjects.size };
    },
  };
}

/** The account's model usage, from the ledger, while the account still exists. @param {any} database @param {string} userId */
async function usageOf(database, userId) {
  const result = await database.query(`SELECT COALESCE(sum(CASE WHEN status = 'released' THEN 0 ELSE COALESCE(actual_cost, reserved_cost) END), 0)::float AS cny,
    COALESCE(sum(COALESCE(cache_hit_tokens, 0) + COALESCE(cache_miss_tokens, 0)), 0)::float AS input, COALESCE(sum(COALESCE(output_tokens, 0)), 0)::float AS output, count(*)::int AS calls
    FROM evimed_usage.model_requests WHERE user_id = $1`, [userId]).catch(() => null);
  const row = result?.rows?.[0];
  return row ? { inputTokens: Number(row.input), outputTokens: Number(row.output), costCny: Number(row.cny), calls: Number(row.calls) } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Start the stack, prove it up to the model call (readiness) or run the cases, and tear it down. Everything this starts, it ends:
 * the account of each case, the server it launched, and the kernels carrying its paths.
 * @param {Record<string, any>} o
 * @param {{ log?: (line: string) => void, now?: () => Date, balance?: (() => Promise<{ code: number, balance: number | null, line: string }>) | null, signals?: boolean, formal?: () => Promise<unknown>, dropDatabaseAfter?: boolean }} [deps]
 */
export async function runProduct(o, deps = {}) {
  const log = deps.log ?? ((/** @type {string} */ line) => process.stdout.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  const root = o.out ?? path.join(o.dataDir, 'product', o.readiness ? 'readiness' : `${o.arm}-${o.board}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dbUrl = scratchUrl({ serverUrl: o.dbUrl, name: o.dbName });
  const cases = o.readiness ? [] : loadCases(o.boardsDir, o.board, { split: o.split, limit: o.limitPatients });
  if (!o.readiness && !cases.length) throw fail('No cases for this board and split.', 'no_cases');
  const manifestFile = !o.readiness && o.boardsDir ? path.join(o.boardsDir, 'collections', String(cases[0].collection), 'collection.json') : '';
  const inputs = o.readiness ? null : writeCaseInputs({ cases, dir: path.join(root, 'inputs') });
  const spend = createSpendLedger(path.join(o.dataDir, 'spend-ledger.jsonl'));
  const realProvider = new URL(o.baseUrl).origin === REAL_PROVIDER;
  const balance = deps.balance !== undefined ? deps.balance : (realProvider ? createBalanceChecker({ python: o.evalPython, script: path.join(HERE, 'budget.py'), keyFile: o.keyFile, floor: o.floorCny }) : null);
  const recordedBefore = spend.recorded();
  const estimate = o.readiness ? 0 : o.caseCny * cases.length;
  const header = o.readiness ? 'readiness (nothing is dispatched)' : `board=${o.board} arm=${o.arm} split=${o.split} cases=${cases.length} (about CNY ${estimate.toFixed(2)} at ${o.caseCny} a case; recorded so far CNY ${recordedBefore.toFixed(2)} of cap ${o.capCny})`;
  log(`[run_product] ${header}${o.diagnostic ? ' | diagnostic (host-kernel stack)' : ''}`);
  if (o.planOnly) return { exitCode: EXIT.finished, summary: { planOnly: true, cases: cases.length, estimateCny: estimate }, outDir: root };
  if (!o.readiness) {
    try { await preflight({ estimateCny: estimate, capCny: o.capCny, recordedCny: recordedBefore, floor: o.floorCny, allowPeak: o.allowPeak, now: now(), balance }); } catch (error) {
      if (error instanceof GuardStop) { log(`[run_product] refused: ${error.message}`); return { exitCode: EXIT.refused, summary: { refused: { code: error.code, message: error.message } }, outDir: root }; }
      throw error;
    }
  }

  // Formal runs are the comparison campaign's, on its container stack; this runner's stack is a host-kernel diagnostic and says so.
  if (!o.readiness && !o.diagnostic) throw fail('This stack is a host-kernel diagnostic: pass --diagnostic. A formal run needs the container stack of the comparison campaign, whose verifier refuses a receipt like this one.', 'formal_refused');
  const created = await ensureDatabase(dbUrl);
  if (created && !o.readiness) log(`[run_product] ${o.dbName} is new: its first server start makes a few small model calls of its own (the starter packs' scan). Run --readiness against it first, which points them at a local stand-in.`);
  const lock = await takeRunnerLock(dbUrl);
  // A fresh product database makes a few small model calls of its own the first time the server starts (it scans the platform's starter
  // packs). The readiness check must be unable to spend: its server is pointed at a local stand-in, and the calls are counted there.
  const stand = o.readiness ? await startFakeProvider() : null;
  /** @type {Awaited<ReturnType<typeof startServer>> | null} */ let server = null;
  /** @type {Awaited<ReturnType<typeof createSavedReader>> | null} */ let reader = null;
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  if (deps.signals !== false) for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, onSignal);
  /** @type {Record<string, any>} */
  const summary = { board: o.board, arm: o.arm, split: o.split, readiness: o.readiness, diagnostic: o.diagnostic || o.readiness, startedAt: now().toISOString(), cases: [] };
  let stopReason = /** @type {GuardStop | null} */ (null);
  try {
    server = await startServer(stand ? { ...o, baseUrl: stand.url } : o, { manifest: manifestFile, dataDir: root, databaseUrl: dbUrl, log });
    const pinned = JSON.parse(fs.readFileSync(path.join(o.tree, 'deps-version.json'), 'utf8')).dsh?.version ?? null;
    const formal = deps.formal ?? (() => verifyCampaign({ base: `${server.base}/`, manifestPath: path.join(root, 'cases.json'), startupPath: server.receiptFile, expectedSha: o.sha ?? '' }));
    if (inputs) fs.writeFileSync(path.join(root, 'cases.json'), JSON.stringify(inputs, null, 2), { mode: 0o600 });
    summary.stack = await acceptReceipt({ receipt: server.receipt, diagnostic: o.diagnostic || o.readiness, origin: server.base, pinned, formal });
    if (o.readiness) summary.readinessResult = { ...await readiness({ base: server.base, instance: server.instance, liveData: server.liveData, log }), standInRequests: stand?.requests.length ?? 0, paidRequests: 0 };
    else {
      reader = await createSavedReader({ databaseUrl: dbUrl, tree: o.tree });
      const arm = /** @type {keyof typeof ARM_SENTENCE} */ (o.arm);
      /** @type {Array<Record<string, any>>} */ const exported = [];
      let spentThisRun = 0;
      let lastCheck = Date.now();
      let unreadable = 0;
      for (const [index, row] of cases.entries()) {
        if (abort.signal.aborted) { stopReason = new GuardStop('signal', 'Interrupted: the account of the case in hand is deleted and the run stops.'); break; }
        const guard = await watch({ spentThisRunCny: spentThisRun, recordedBeforeCny: recordedBefore, capCny: o.capCny, floor: o.floorCny, allowPeak: o.allowPeak, now: now(), balance: Date.now() - lastCheck >= o.checkMs ? balance : null });
        if (Date.now() - lastCheck >= o.checkMs) { lastCheck = Date.now(); unreadable = guard.unreadable ? unreadable + 1 : 0; }
        if (guard.stop || unreadable >= 3) { stopReason = guard.stop ?? new GuardStop('balance_unreadable', 'The balance could not be read three times in a row.'); break; }
        const input = /** @type {NonNullable<typeof inputs>} */ (inputs).cases[index];
        const record = await runBoardCase({ base: server.base, instance: server.instance, row, files: input.files, arm, outDir: path.join(root, 'cases'), timeoutMs: o.caseTimeoutMs, quietMs: o.quietMs,
          signal: abort.signal, read: (query) => reader.read(query) });
        const cost = Number(record.saved?.usage?.costCny ?? usageBound(record.usage, o.caseCny));
        spentThisRun += cost;
        spend.append({ kind: 'job', arm: `product-${o.arm}`, board: o.board, jobId: `product:${o.arm}:${row.patientId}:${record.runId ?? 'norun'}`, costCny: cost, calls: Number(record.saved?.usage?.calls ?? 0) });
        exported.push(exportRecord(row, record));
        summary.cases.push({ caseId: row.patientId, status: record.status, cleanup: record.cleanup, costCny: Number(cost.toFixed(4)), readFrom: record.saved?.readFrom ?? null, judged: record.saved?.ranking?.length ?? 0 });
        log(`[run_product] ${index + 1}/${cases.length} ${row.patientId}: ${record.status} | judged ${record.saved?.ranking?.length ?? 0}/${row.candidateIds.length} | cost CNY ${cost.toFixed(2)} | account ${record.cleanup?.deleted ? 'deleted' : 'NOT DELETED'}`);
        if (record.status === 'cleanup_failed') { stopReason = new GuardStop('cleanup_failed', 'An account could not be deleted: stopping so nobody adds to the leftovers.'); break; }
      }
      const file = path.join(root, 'judgments.jsonl');
      fs.writeFileSync(file, exported.map((entry) => JSON.stringify(entry)).join('\n') + (exported.length ? '\n' : ''));
      Object.assign(summary, { spentCny: Number(spentThisRun.toFixed(4)), campaignCnyAfter: Number(spend.recorded().toFixed(4)), judgments: file });
      if (stopReason) summary.stopped = { code: stopReason.code, message: stopReason.message };
      const holdsTest = cases.some((row) => row.split === 'test');
      if ((o.score === 'yes' || (o.score === 'auto' && !holdsTest)) && exported.length) summary.score = await scoreRun(o, BOARDS[o.board], root, file, log);
    }
    summary.finishedAt = now().toISOString();
    fs.writeFileSync(path.join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    const unsettled = summary.cases.filter((entry) => entry.status !== 'settled').length;
    return { exitCode: stopReason ? EXIT.stopped : unsettled ? EXIT.unsettled : EXIT.finished, summary, outDir: root };
  } finally {
    if (deps.signals !== false) for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, onSignal);
    await reader?.close().catch(() => {});
    if (server) await stopServer(server.child, root, log, server.liveData);
    await stand?.close().catch(() => {});
    await lock.release().catch(() => {});
    if (deps.dropDatabaseAfter) await dropDatabase(dbUrl).catch(() => {});
  }
}

/**
 * Prove the path up to the model call: an account, a project, a session, a kernel that answers, and no model request made.
 * @param {{ base: string, instance: string, liveData: string, log: (line: string) => void }} input
 */
export async function readiness({ base, instance, liveData, log }) {
  const requestLog = path.join(liveData, 'model-requests.jsonl');
  const countRequests = () => (fs.existsSync(requestLog) ? fs.readFileSync(requestLog, 'utf8').split('\n').filter(Boolean).length : 0);
  // The server's own start-up calls are not the readiness steps': wait until the log has been still for a few seconds, then count.
  for (let quietSince = Date.now(), seen = countRequests(), waited = 0; Date.now() - quietSince < 4000 && waited < 120; waited += 1) {
    await sleep(500);
    const now = countRequests();
    if (now !== seen) { seen = now; quietSince = Date.now(); }
  }
  const before = countRequests();
  const started = Date.now();
  /** @type {Record<string, any>} */
  const result = { accountCreated: false, sessionOpened: false, kernelAnswered: false, accountDeleted: false };
  let projectId = '';
  let account;
  const call = async (/** @type {string} */ method, /** @type {string} */ route, /** @type {unknown} */ body, /** @type {number[]} */ allowed = [200, 201]) => {
    const response = await fetch(base + route, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': 'application/json', origin: base, ...account.headers, 'x-evimed-automated': '1', ...(projectId ? { 'x-open-science-project': projectId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get('x-evimed-benchmark-instance') !== instance) throw new Error('Benchmark server instance changed');
    const data = await response.json().catch(() => ({}));
    if (!allowed.includes(response.status)) throw new Error(`${method} ${route}: ${response.status} ${data?.code ?? ''}`);
    return data?.data ?? null;
  };
  try {
    account = await openThrowawayAccount({ base, send: fetchTransport(base), prefix: 'vmready', signals: false, say: () => {},
      stop: async () => { if (projectId) await call('POST', '/api/commands/stop_runtime', {}, [200, 201, 202, 404]).catch(() => {}); } });
    result.accountCreated = true;
    projectId = `vmready-${randomUUID().slice(0, 8)}`;
    await call('POST', '/api/projects', { id: projectId, name: 'Readiness' });
    const session = await call('POST', '/api/runtime/sessions', {});
    result.sessionOpened = Boolean(session?.id);
    // The session exists only once the kernel has answered the platform's `session/create`; its transcript is read from the kernel.
    const transcript = await call('GET', `/api/runtime/sessions/${session.id}/transcript`, undefined, [200]);
    // The kernel's own first line, in the log the harness keeps for it, is the proof that a kernel process came up and printed its address.
    const kernelLog = path.join(liveData, `kernel-${projectId}.log`);
    for (let waited = 0; waited < 20 && !(fs.existsSync(kernelLog) && fs.readFileSync(kernelLog, 'utf8').includes('dsh web:')); waited += 1) await sleep(500);
    result.kernelAnswered = transcript !== undefined && fs.existsSync(kernelLog) && fs.readFileSync(kernelLog, 'utf8').includes('dsh web:');
    result.bootSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
  } finally {
    if (account) { const closed = await account.close(); result.accountDeleted = closed.deleted; if (!closed.deleted) result.cleanup = closed.reason; }
  }
  result.modelRequests = countRequests() - before;
  log(`[run_product] readiness: ${JSON.stringify(result)}`);
  if (!result.sessionOpened || !result.kernelAnswered) throw fail('The kernel did not come up.', 'readiness_failed');
  if (result.modelRequests !== 0) throw fail(`${result.modelRequests} model request(s) were made by the readiness steps; they must make none.`, 'readiness_requests');
  if (!result.accountDeleted) throw fail('The readiness account was not deleted.', 'readiness_leftover');
  return result;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try { options = parseOptions(argv, env); } catch (error) {
    process.stderr.write(`run_product: ${/** @type {any} */ (error)?.message ?? error}\n`);
    return EXIT.error;
  }
  try { return (await runProduct(options)).exitCode; } catch (error) {
    process.stderr.write(`run_product: ${/** @type {any} */ (error)?.code ?? 'error'}: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 400)}\n`);
    return EXIT.error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}

