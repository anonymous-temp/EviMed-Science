#!/usr/bin/env node
// C2 (plan 5.5): the EvoDS data-analysis benchmarks through the PRODUCT PATH -- the real control plane, the pinned DSH kernel,
// DeepSeek and the product-path memory engine -- scored by each benchmark's official scorer. Built on the general-tasks cell
// runner (one fresh account and project per task, the files through the upload route, the ordinary conversation route).
//
//   node run_c2.mjs worker    --bench dabench|da-code --arm baseline|reuse --out DIR --slot N --port P --pg-port PG [--tree T]
//                             [--tasks id,id] [--limit N] [--gate-load 16] [--timeout-min N] [--keep-data]
//   node run_c2.mjs summarize --bench B --arm A --out DIR          per-task rows -> c2-summary.json/.txt + the official aggregate
//   node run_c2.mjs ledger    --bench B --arm A --out DIR --json F  one ledger row (run/ledger.mjs add --json F)
//
// Resumable: a task with a record is skipped; two workers share a run through claim files (out/claims/<task>.json, exclusive
// create, a dead owner's claim is taken over). A worker given --gate-load takes no new task while the 1-minute load average is
// above it (the shared lab host's rule: one slot above 16). Arms: baseline = the product for a new account (c2/arms/baseline.env);
// reuse = one account in task order with account learning and the pyramid/toolchain switches on, the first 3/5 of the tasks
// practised, the learning loop drained, the last 2/5 tested (EvoDS's validation-to-test reuse protocol).
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Api, registerAccount, runCell } from '../../general-tasks/runner/cell.mjs';
import { ensurePostgres, ensureDatabase, startHarness, stopHarness } from '../../general-tasks/runner/run.mjs';
import { PAPER, TIMEOUT_MIN, oversizedInputs, reuseSplit, tasksFor } from './benches.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.resolve(HERE, '../../general-tasks');
const SAMPLES = path.resolve(HERE, '../pools/c-samples-20261110.json');
const SCORE_PY = process.env.C2_SCORE_PYTHON ?? '/srv/evimed/pp/c2-score-venv/bin/python';
const BUDGET_FILE = '/srv/evimed/runs/BUDGET-LAST';
const BUDGET_FLOOR = 160; // the lab guard stops everything below CNY 150; stop taking tasks a little before it
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listening = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });

/**
 * What ScienceAgentBench needs that is not in place (assessed 2026-11-10). The inputs are: benchmark_verified.zip (1,769,478,786 bytes,
 * sha256 46e715d3...9610, 4.07 GB unpacked; datasets, eval_programs, gold_programs) was fetched from the README's share link into
 * /srv/evimed/data/c2-sab/dl and is not unpacked (the authors ask not to redistribute it).
 */
export const SAB_GAPS = [
  'Official scorer: 20 of the 30 sampled tasks (82 39 76 62 96 48 68 49 36 98 55 94 32 81 65 75 52 50 20 38) are graded by gpt4_visual_judge.score_figure, an OpenAI GPT-4o call (pass at >= 60); there is no OpenAI access here, and another judge would not be the official scorer.',
  'Execution environment: the official harness (evaluation/harness, docker) builds a ~5 GB conda base image and one instance image per task from the program\'s pipreqs requirements (up to 25 GB per worker at run time); not built or tried on this host.',
  'Product adapter: SAB grades a self-contained program (pred_programs/pred_<file>.py) that the harness re-executes, so the product\'s answer must yield that program (the official agent extracts the last ```python block of the reply, recover_pred_from_log.py); this extraction and the official prompt (agent.py SYSTEM_PROMPT + task_inst + dataset tree/preview) are not wired into run_c2.mjs.',
];

export function parseArgs(argv) {
  const out = { mode: argv[0], slot: 1, port: 48846, pgPort: 55686, gateLoad: 0, keepData: false, limit: 0 };
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (['keepData', 'help'].includes(key)) out[key] = true; else out[key] = argv[++i];
  }
  for (const key of ['slot', 'port', 'pgPort', 'gateLoad', 'limit']) out[key] = Number(out[key] ?? 0);
  if (out.timeoutMin !== undefined) out.timeoutMin = Number(out.timeoutMin);
  return out;
}

export function armEnv(arm) {
  if (!['baseline', 'reuse'].includes(arm)) throw new Error(`unknown C2 arm ${arm}`);
  return Object.fromEntries(fsSync.readFileSync(`${HERE}/arms/${arm}.env`, 'utf8').split('\n')
    .filter((line) => line && !line.startsWith('#')).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
}

export const loadAverage = () => Number(fsSync.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
export function budgetBalance(text) {
  const match = /balance\s+(-?[0-9.]+)/.exec(text ?? '');
  return match ? Number(match[1]) : null;
}

/** Wilson interval (proportion of binary verdicts). */
export function wilson(pass, n, z = 1.959963984540054) {
  if (!n) return null;
  const p = pass / n, d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d, margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

/** Normal interval of a mean of scores in [0, 1] (DA-Code's ML tasks score fractions), clipped to [0, 1]. */
export function meanInterval(scores) {
  const n = scores.length;
  if (!n) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return [0, 1];
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const half = 1.959963984540054 * Math.sqrt(variance / n);
  return [Math.max(0, mean - half), Math.min(1, mean + half)];
}

/**
 * EvoDS failure classes (misread instruction / execution limit / coordination / reasoning), decided by code from the record:
 *  execution limit -- the turn timed out, the run failed or was cancelled, the harness lost the task, or DA-Code's run never finished;
 *  misread instruction -- the answer is not in the form the task asked for (DABench: an expected @name[...] missing or no answer;
 *    DA-Code: none of the expected output files exists and no Terminate answer was given);
 *  coordination -- a delegated sub-agent call failed (the product's analogue of EvoDS's inter-agent errors);
 *  reasoning -- the answer has the asked form and is wrong.
 * A first pass by rule, not a reading of each transcript.
 */
export function failureClass({ bench, record, verdict }) {
  if (verdict?.pass) return null;
  const turn = record?.turns?.at(-1);
  const status = String(turn?.run?.status ?? '');
  if (record?.infra || !turn || turn.timedOut || turn.error || ['failed', 'cancelled', 'canceled', 'error', 'timed_out'].includes(status)) return 'execution limit';
  if (bench === 'da-code' && verdict && verdict.finished === false) return 'execution limit';
  const tools = record.turns.flatMap((t) => t.tools ?? []);
  if (tools.some((tool) => /delegate|await|^task$|subagent/i.test(tool.name) && tool.error)) return 'coordination';
  if (bench === 'dabench' && (!verdict || verdict.emptyResponse || (verdict.missingNames ?? []).length)) return 'misread instruction';
  if (bench === 'da-code' && verdict) {
    const expected = expectedFiles(verdict.evalResult);
    const produced = new Set([...(verdict.added ?? []), ...(verdict.changed ?? [])].map((f) => path.basename(f)));
    if (expected.length && !expected.some((f) => produced.has(f)) && !verdict.terminateFound) return 'misread instruction';
  }
  return 'reasoning';
}

function expectedFiles(result) {
  const out = [];
  for (const item of Array.isArray(result) ? result : result ? [result] : []) {
    const files = Array.isArray(item?.file) ? item.file : item?.file ? [item.file] : [];
    for (const file of files) if (!String(file).startsWith('dabench/')) out.push(path.basename(String(file)));
  }
  return out;
}

const sumUsage = (record) => {
  const usage = (record?.turns ?? []).map((t) => t.run?.usage ?? {});
  const add = (key) => usage.reduce((n, u) => n + (Number(u[key]) || 0), 0);
  return { requests: add('requests'), inputTokens: add('inputTokens'), cachedInputTokens: add('cachedInputTokens'), outputTokens: add('outputTokens'), costCny: add('costCny') };
};

/** One row per task: what the summary, the ledger and the failure analysis read. */
export function taskRow({ bench, task, record, verdict }) {
  const turn = record?.turns?.at(-1) ?? {};
  const usage = sumUsage(record);
  const score = Number(verdict?.score ?? 0);
  return {
    id: task.id, bench, phase: record?.phase ?? null, category: bench === 'dabench' ? task.level : task.type, score, pass: Boolean(verdict?.pass),
    scored: Boolean(verdict) && !verdict.error, scorerError: verdict?.error ?? null, infra: Boolean(record?.infra),
    failureClass: failureClass({ bench, record, verdict }), wallSeconds: (record?.wallMs ?? 0) / 1000,
    status: turn.run?.status ?? null, timedOut: Boolean(turn.timedOut), model: turn.run?.model ?? null, route: turn.run ? `${turn.run.effectiveAgentId}/${turn.run.effectiveRouteReason}` : null,
    toolCalls: (record?.turns ?? []).reduce((n, t) => n + (t.tools?.length ?? 0), 0), ...usage,
    outputs: (record?.turns ?? []).flatMap((t) => t.changed ?? []), transcripts: record?.transcripts ?? [],
    memoryToolsAtStart: record?.firstRequest?.hadMemoryTools ?? null,
    methodsMounted: (record?.turns ?? []).flatMap((t) => t.run?.methodsLoaded ?? []).map((m) => m.name ?? m),
    methodsOpened: (record?.turns ?? []).flatMap((t) => t.run?.methodsInvoked ?? []).map((m) => m.name ?? m),
    placedDirectly: record?.placedDirectly ?? [],
    // DA-Code plots: the official post-process found no plotting script it recognises (it looks for `plt.savefig` in a top-level .py).
    postProcessError: (verdict?.postProcessErrors ?? []).filter(Boolean)[0] ?? null,
  };
}

/** Cross-task reuse (EvoDS: share of skill uses whose skill was made in another task). */
export function reuseStats(rows, learned = []) {
  const learnedNames = new Set(learned.map((m) => m.name));
  const opened = rows.flatMap((row) => row.methodsOpened.map((name) => ({ name, task: row.id })));
  const learnedOpened = opened.filter((o) => learnedNames.has(o.name));
  return {
    learnedMethods: learnedNames.size, openings: opened.length, learnedOpenings: learnedOpened.length,
    crossTaskReuseRate: opened.length ? learnedOpened.length / opened.length : null,
    tasksUsingLearned: new Set(learnedOpened.map((o) => o.task)).size, distinctLearnedOpened: new Set(learnedOpened.map((o) => o.name)).size,
    definition: 'Openings (methods invoked, product observer) in the test tasks; a learned method is an approved account method from the practice tasks, so every opening of one is a use in a task other than the one it came from. EvoDS reports 69% of 925 calls.',
  };
}

export function summarizeRows(rows, { bench, arm, expected }) {
  const n = rows.length;
  const passed = rows.filter((r) => r.pass).length;
  const scores = rows.map((r) => r.score);
  const value = n ? scores.reduce((a, b) => a + b, 0) / n : 0;
  const valid = rows.filter((r) => !r.infra);
  const validValue = valid.length ? valid.reduce((a, r) => a + r.score, 0) / valid.length : null;
  const binary = bench === 'dabench';
  const median = (values) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const classes = {};
  for (const row of rows) if (row.failureClass) classes[row.failureClass] = (classes[row.failureClass] ?? 0) + 1;
  const byCategory = {};
  for (const row of rows) {
    const key = row.category ?? 'unknown';
    byCategory[key] ??= { n: 0, sum: 0 };
    byCategory[key].n += 1; byCategory[key].sum += row.score;
  }
  const routes = {}, models = {};
  for (const row of rows) routes[row.route ?? 'none'] = (routes[row.route ?? 'none'] ?? 0) + 1;
  for (const row of rows) if (row.model) models[row.model] = (models[row.model] ?? 0) + 1;
  const total = (key) => rows.reduce((a, r) => a + (r[key] ?? 0), 0);
  return {
    bench, arm, set: PAPER[bench].set, expected, n, complete: expected ? n >= expected : null, passed, value,
    ci95: binary ? wilson(passed, n) : meanInterval(scores), interval: binary ? 'Wilson 95% on pass/fail' : 'normal 95% on the mean score, clipped to [0, 1]',
    valueValid: validValue, nValid: valid.length, infra: n - valid.length, scorerErrors: rows.filter((r) => r.scorerError).length,
    paper: { baseline: PAPER[bench].baseline, reuse: PAPER[bench].reuse, metric: PAPER[bench].metric },
    failureClasses: classes, byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, { n: v.n, value: v.sum / v.n }])), routes, models,
    tokens: { prompt: total('inputTokens'), cached: total('cachedInputTokens'), completion: total('outputTokens'), requests: total('requests') },
    costCny: total('costCny'), wallSeconds: total('wallSeconds'), medianWallSeconds: median(rows.map((r) => r.wallSeconds)),
    perTask: n ? { costCny: total('costCny') / n, wallSeconds: total('wallSeconds') / n, toolCalls: total('toolCalls') / n, prompt: total('inputTokens') / n, completion: total('outputTokens') / n } : null,
    memoryToolsAtStart: rows.filter((r) => r.memoryToolsAtStart).length, placedDirectly: rows.filter((r) => r.placedDirectly.length).map((r) => r.id),
    postProcessFailures: rows.filter((r) => r.postProcessError).map((r) => r.id),
    methodsMountedTasks: rows.filter((r) => r.methodsMounted.length).length, methodsOpenedTasks: rows.filter((r) => r.methodsOpened.length).length,
  };
}

export function ledgerRow(summary, { runId, commit, engineVersion, flags, rawPath, notes, label }) {
  return {
    runId, commit, engine: { version: engineVersion, templatesDigest: 'unknown' }, arm: summary.arm === 'baseline' ? 'product-baseline' : `product-${summary.arm}`,
    flags, set: summary.set, split: 'dev', label, metric: 'accuracy', n: summary.n, value: summary.value, ci95: summary.ci95,
    valueValid: summary.valueValid, nValid: summary.nValid, invalid: summary.infra,
    judged: { code: summary.n - summary.scorerErrors, judge: 0, unknown: 0, error: summary.scorerErrors },
    tokens: { prompt: summary.tokens.prompt, completion: summary.tokens.completion, cached: summary.tokens.cached, extractionPrompt: 0, extractionCompletion: 0 },
    costCny: summary.costCny, wallSeconds: summary.wallSeconds, scorer: notes.scorer, rawPath,
    byCategory: summary.byCategory, notes: notes.text,
  };
}

// ----------------------------------------------------------------------------------------------------------------------------
// worker

/** An Api that places the files above the product's upload ceiling straight into the new project's workspace. */
class PlacingApi extends Api {
  constructor(base, onProject) { super(base); this.onProject = onProject; }
  async call(method, url, body, options) {
    const response = await super.call(method, url, body, options);
    if (method === 'POST' && url === '/api/projects' && response.status === 200 && this.onProject) await this.onProject(body.id);
    return response;
  }
}

function ipc(h, action, args = {}, timeoutMs = 300_000) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { h.child.off('message', reply); reject(new Error(`eval control timeout: ${action}`)); }, timeoutMs);
    const reply = (message) => {
      if (message.id !== id) return;
      clearTimeout(timer); h.child.off('message', reply);
      message.error ? reject(new Error(message.error)) : resolve(message.value);
    };
    h.child.on('message', reply);
    h.child.send({ evalControl: true, id, action, args });
  });
}

async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 1));
  await fs.rename(`${file}.tmp`, file);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function claim(dir, id, owner) {
  const file = path.join(dir, `${id}.json`);
  await fs.mkdir(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ ...owner, at: new Date().toISOString() }));
      await handle.close();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const held = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'));
      if (held.pid && alive(held.pid) && held.pid !== owner.pid) return false;
      await fs.rm(file, { force: true });
    }
  }
  return false;
}

async function scoreTask({ bench, task, record, cellDir, outDir, log }) {
  const reply = record.turns?.at(-1)?.reply ?? '';
  await fs.writeFile(`${cellDir}/reply.txt`, reply);
  const verdictFile = `${cellDir}/verdict.json`;
  let run;
  if (bench === 'dabench') {
    run = spawnSync(SCORE_PY, ['-I', `${HERE}/score_dabench.py`, 'one', '--id', String(task.sourceId), '--response-file', `${cellDir}/reply.txt`, '--out', verdictFile],
      { encoding: 'utf8', timeout: 120_000 });
  } else {
    const last = record.turns?.at(-1) ?? {};
    const finished = !record.infra && !last.timedOut && !last.error && ['succeeded', 'unverified', 'completed'].includes(String(last.run?.status));
    const trajectory = (record.turns ?? []).flatMap((t) => t.tools ?? []).map((tool) => ({ action: tool.name === 'bash' ? 'Bash' : tool.name, code: tool.input, observation: tool.outputHead }));
    await fs.writeFile(`${cellDir}/task.json`, JSON.stringify({ id: task.id, sourceDir: task.sourceDir, postProcess: task.postProcess, eval: task.eval }));
    await fs.writeFile(`${cellDir}/meta.json`, JSON.stringify({ finished, trajectory }));
    run = spawnSync(SCORE_PY, ['-I', `${HERE}/score_dacode.py`, 'one', '--task-file', `${cellDir}/task.json`, '--workspace', `${record.projectDir}/workspace`,
      '--reply-file', `${cellDir}/reply.txt`, '--meta-file', `${cellDir}/meta.json`, '--out-root', `${outDir}/dacode-output`, '--verdict-out', verdictFile],
    { encoding: 'utf8', timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024 });
  }
  await fs.writeFile(`${cellDir}/scorer.log`, `${run.stdout ?? ''}\n${run.stderr ?? ''}`.slice(-20000));
  const verdict = JSON.parse(await fs.readFile(verdictFile, 'utf8').catch(() => 'null'));
  if (!verdict) { log(`  scorer failed (${run.status}): ${(run.stderr || run.error?.message || '').slice(-300)}`); return { score: 0, pass: false, error: `scorer exit ${run.status}` }; }
  if (bench === 'da-code') verdict.evalResult = task.eval?.result ?? null;
  return verdict;
}

async function worker(args) {
  const bench = args.bench, arm = args.arm;
  if (!PAPER[bench] || bench === 'sab') throw new Error(bench === 'sab' ? `SAB is not runnable: ${SAB_GAPS.join(' | ')}` : `unknown bench ${bench}`);
  const env = armEnv(arm);
  Object.assign(process.env, env);
  const outDir = path.resolve(args.out);
  const statusFiles = [`${outDir}/STATUS`, process.env.C2_STATUS_FILE].filter(Boolean);
  await fs.mkdir(`${outDir}/records`, { recursive: true });
  const status = (message) => {
    const line = `${new Date().toISOString()} C2 ${bench} ${arm} s${args.slot} ${message}\n`;
    process.stdout.write(line);
    for (const file of statusFiles) fsSync.appendFileSync(file, line);
  };
  const samples = JSON.parse(await fs.readFile(SAMPLES, 'utf8'));
  let tasks = await tasksFor(bench, samples);
  if (args.tasks) { const want = new Set(String(args.tasks).split(',')); tasks = tasks.filter((t) => want.has(t.id) || want.has(String(t.sourceId))); }
  if (args.limit) tasks = tasks.slice(0, args.limit);
  const missing = tasks.filter((t) => t.missingSource).map((t) => t.id);
  if (missing.length) throw new Error(`task data missing for ${missing.join(', ')}`);
  const split = arm === 'reuse' ? reuseSplit(tasks.map((t) => t.id)) : null;
  if (arm === 'reuse' && args.slot !== 1) throw new Error('the reuse arm is one account in task order: one worker (slot 1)');
  const timeoutMin = args.timeoutMin || TIMEOUT_MIN[bench];
  const treeOs = path.resolve(args.tree ?? path.resolve(HERE, '../../..'));
  const commit = process.env.EVAL_TREE_COMMIT || spawnSync('git', ['-C', treeOs, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'unknown';
  const dataDir = path.resolve(args.dataDir ?? `/srv/evimed/pp/data/${path.basename(outDir)}-s${args.slot}`);
  const dbName = `evimed_test_c2_${bench.replace(/-/g, '_')}_${arm}_s${args.slot}`;
  const prior = JSON.parse(await fs.readFile(`${outDir}/run.json`, 'utf8').catch(() => '{}'));
  if (prior.arm && (prior.arm !== arm || prior.bench !== bench)) throw new Error('output directory belongs to another bench or arm');
  await atomic(`${outDir}/run.json`, { ...prior, bench, arm, env, tree: { path: treeOs, commit }, timeoutMin, tasks: tasks.map((t) => t.id), split,
    attempts: [...(prior.attempts ?? []), { at: new Date().toISOString(), slot: args.slot, port: args.port, pid: process.pid, args }],
    presentation: bench === 'dabench'
      ? 'One message: official eval.py prompt "Question: {question}\\n{constraints}\\n", then the format requirement with the official reformat.py sentence (no separate reformat call); the csv uploaded through /api/files/upload.'
      : 'One message: the task instruction verbatim, then the official Terminate action description (da_agent/agent/action.py); every source file uploaded through /api/files/upload (files above the 50 MB upload ceiling placed in the workspace directly).',
    scorer: bench === 'dabench' ? 'infiagent-dabench eval_closed_form.py @3d6c4a7 (per task: evaluate_responses; run: the script itself)' : 'da-code Evaluator + evaluate.run_evaluation @b211daf, plot_process post-processing in the product sandbox' });

  let h = null, seeded = null, account = null, infraStreak = 0;
  const shutdown = async () => { if (h) { const old = h; h = null; await stopHarness(old); } };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await shutdown(); process.exit(128 + (signal === 'SIGINT' ? 2 : 15)); });
  const ensureHarness = async () => {
    // A harness that died (or stopped listening) is replaced before the next task rather than failing every task after it.
    if (h && (h.child.exitCode !== null || !(await listening(args.port)))) { status('harness gone; restarting'); const old = h; h = null; await stopHarness(old); }
    if (h) return h;
    await ensurePostgres(args.pgPort); await ensureDatabase(args.pgPort, dbName);
    if (!seeded) {
      const seed = spawnSync('bash', [`${SUITE}/runner/seed.sh`], { encoding: 'utf8', env: { ...process.env, OS: treeOs, L: process.env.EVAL_LIVE_DIR ?? '/tmp/eval/live', SEED_FROM: args.seedFrom ?? '/srv/evimed/pp/seed/dsh-seed' }, maxBuffer: 16 * 1024 * 1024 });
      process.stderr.write(seed.stderr ?? '');
      if (seed.status !== 0) throw new Error('seed.sh failed');
      seeded = seed.stdout.trim().split('\n').pop();
    }
    h = await startHarness({ args: { port: args.port }, treeOs, treeDir: seeded, dataDir, profile: 'normal', arm: 'B', dbUrl: `postgresql://coder@127.0.0.1:${args.pgPort}/${dbName}` });
    const facts = await ipc(h, 'facts');
    await atomic(`${outDir}/engine-facts-s${args.slot}.json`, facts);
    status(`harness up pid=${h.pid} port=${args.port} db=${dbName} memory=${facts.nativeMemory?.ok} ranker=${facts.ranker}`);
    return h;
  };
  const signIn = async (api) => {
    if (arm !== 'reuse') return registerAccount(api, `c2${bench.replace(/[^a-z]/g, '').slice(0, 4)}${randomBytes(3).toString('hex')}${Date.now().toString(36).slice(-4)}`);
    const file = `${outDir}/account.json`;
    if (account) {
      const login = await api.call('POST', '/api/auth/login', { username: account.username, password: 'eval-pass-1' }, { project: null });
      if (login.status !== 200) throw new Error(`login ${login.status}`);
      api.csrf = login.json?.data?.csrfToken ?? login.json?.data?.session?.csrfToken ?? (await api.call('GET', '/api/me', undefined, { project: null })).json?.data?.csrfToken ?? '';
      return account;
    }
    if (fsSync.existsSync(file)) { account = JSON.parse(await fs.readFile(file, 'utf8')); return signIn(api); }
    account = await registerAccount(api, `c2reuse${Date.now().toString(36)}`);
    await fs.writeFile(file, JSON.stringify(account), { mode: 0o600 });
    return account;
  };

  const runTask = async (task, phase) => {
    const file = `${outDir}/records/${task.id}.json`;
    if (fsSync.existsSync(file) && !JSON.parse(await fs.readFile(file, 'utf8')).infra) return 'done';
    if (!(await claim(`${outDir}/claims`, task.id, { pid: process.pid, slot: args.slot }))) return 'taken';
    try {
      await ensureHarness();
      const cellDir = `${outDir}/records/${task.id}.files`;
      await fs.rm(cellDir, { recursive: true, force: true }); await fs.mkdir(cellDir, { recursive: true });
      const oversized = bench === 'da-code' ? await oversizedInputs(task) : [];
      const spec = { ...task.spec, inputs: task.spec.inputs.flatMap((input) => expandInputs(task, input, oversized)) };
      let identity = null;
      const placed = [];
      const api = new PlacingApi(h.base, async (projectId) => {
        if (!oversized.length) return;
        const workspace = `${dataDir}/users/${identity.userId}/projects/${projectId}/workspace`;
        for (const rel of oversized) {
          await fs.mkdir(path.dirname(path.join(workspace, rel)), { recursive: true });
          await fs.copyFile(path.join(task.sourceDir, rel), path.join(workspace, rel));
          placed.push(rel);
        }
      });
      identity = await signIn(api);
      status(`${phase} ${task.id} start load=${loadAverage()}`);
      const t0 = Date.now();
      let record;
      try {
        record = await runCell({ api, account: identity, spec, fixtureRoot: task.fixtureRoot, dataDir, outDir: cellDir, timeoutMs: timeoutMin * 60_000,
          log: (line) => status(`  ${task.id}${line}`), automated: phase === 'test', observeMethods: (who) => ipc(h, 'methods', who).catch((error) => ({ error: String(error.message), methodsLoaded: [], methodsInvoked: [] })) });
      } catch (error) {
        record = { schema: 1, cell: task.id, error: String(error?.stack ?? error).slice(0, 2000), turns: [], infra: true, projectDir: null };
        status(`  ${task.id} cell failed: ${String(error?.message ?? error).slice(0, 300)}`);
      }
      Object.assign(record, { bench, arm, phase, task: { id: task.id, sourceId: task.sourceId ?? null, category: task.level ?? task.type, hardness: task.hardness ?? null },
        placedDirectly: placed, slot: args.slot, wallMs: record.wallMs ?? Date.now() - t0, tree: { path: treeOs, commit } });
      record.transcripts = (await fs.readdir(`${cellDir}/transcripts`).catch(() => [])).map((name) => `${cellDir}/transcripts/${name}`);
      const verdict = record.infra && bench === 'dabench' ? null : await scoreTask({ bench, task, record, cellDir, outDir, log: status });
      record.verdict = verdict;
      record.row = taskRow({ bench, task, record, verdict });
      if (!args.keepData && record.projectDir) await fs.rm(record.projectDir, { recursive: true, force: true }).catch(() => {});
      await atomic(file, record);
      infraStreak = record.infra ? infraStreak + 1 : 0;
      if (record.infra && h) { const old = h; h = null; await stopHarness(old); }
      if (infraStreak >= 4) throw new Error(`${infraStreak} harness failures in a row; stopping so the wrapper restarts this slot (records are kept, infra ones rerun)`);
      status(`${phase} ${task.id} ${record.row.pass ? 'PASS' : 'fail'} score=${record.row.score.toFixed(3)} class=${record.row.failureClass ?? '-'} wall=${Math.round(record.row.wallSeconds)}s tools=${record.row.toolCalls} cost=${record.row.costCny.toFixed(4)}`);
      return 'ran';
    } finally {
      await fs.rm(`${outDir}/claims/${task.id}.json`, { force: true });
    }
  };

  try {
    const phases = arm === 'reuse' ? [['practice', split.validation], ['test', split.test]] : [['baseline', tasks.map((t) => t.id)]];
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const [phase, ids] of phases) {
      if (arm === 'reuse' && phase === 'test') await settleLearning();
      for (const id of ids) {
        const recordFile = `${outDir}/records/${id}.json`;
        if (fsSync.existsSync(recordFile) && !JSON.parse(await fs.readFile(recordFile, 'utf8')).infra) continue;
        const balance = budgetBalance(await fs.readFile(BUDGET_FILE, 'utf8').catch(() => ''));
        if (balance !== null && balance < BUDGET_FLOOR) { status(`stop: model balance ${balance} below ${BUDGET_FLOOR}`); return; }
        if (args.gateLoad) {
          let waited = 0;
          // The other slot may finish this task (or the whole pass) meanwhile: never wait on a task that has its record.
          while (loadAverage() > args.gateLoad && !fsSync.existsSync(recordFile)) {
            if (waited % 600_000 === 0) status(`load ${loadAverage()} above ${args.gateLoad}: this slot waits`);
            await sleep(60_000); waited += 60_000;
          }
          if (fsSync.existsSync(recordFile)) continue;
        }
        await runTask(byId.get(id), phase);
      }
    }
    status('worker finished its pass over the tasks');
  } finally {
    await shutdown();
  }

  async function settleLearning() {
    const phaseFile = `${outDir}/learning-complete.json`;
    if (fsSync.existsSync(phaseFile)) return;
    const pending = split.validation.filter((id) => !fsSync.existsSync(`${outDir}/records/${id}.json`));
    if (pending.length) throw new Error(`practice tasks without records: ${pending.join(',')}`);
    await ensureHarness();
    const api = new Api(h.base); const who = await signIn(api);
    status('learning drain start (product LearningWorker + one sleep pass)');
    await ipc(h, 'start', { userId: who.userId });
    const deadline = Date.now() + Number(args.learningTimeoutMin ?? 180) * 60_000;
    let quiet = 0, slept = false, last;
    while (Date.now() < deadline) {
      last = await ipc(h, 'status', { userId: who.userId });
      await atomic(`${outDir}/learning-jobs.json`, last);
      const busy = last.jobs.filter((j) => ['queued', 'running'].includes(j.status));
      quiet = !busy.length && !last.worker.running ? quiet + 1 : 0;
      if (quiet >= 3) {
        if (!slept) { await ipc(h, 'sleep', { userId: who.userId, key: path.basename(outDir) }); slept = true; quiet = 0; status('learning sleep pass queued'); }
        else break;
      }
      await sleep(10_000);
    }
    await ipc(h, 'pause', { userId: who.userId });
    const methods = [];
    let cursor = null;
    do {
      const response = await api.call('GET', `/api/methods?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      methods.push(...(response.json?.data?.items ?? []));
      cursor = response.json?.data?.nextCursor ?? null;
    } while (cursor);
    await atomic(phaseFile, { at: new Date().toISOString(), jobs: last?.jobs?.length ?? 0, failedJobs: (last?.jobs ?? []).filter((j) => j.status === 'failed').length, methods, usage: await ipc(h, 'usage', { userId: who.userId }) });
    status(`learning settled: ${methods.length} methods (${methods.filter((m) => m.status === 'approved').length} approved)`);
  }
}

/** Every source file as its own upload (so one above the ceiling can be left to direct placement); the attach line names top-level entries. */
function expandInputs(task, input, oversized) {
  if (task.bench !== 'da-code') return [input];
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.join(dir, entry.name), relative = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next, relative);
      else if (!oversized.includes(relative)) out.push({ fixture: `${task.id}/${relative}`, to: relative });
    }
  };
  const full = path.join(task.fixtureRoot, input.fixture);
  if (fsSync.statSync(full).isDirectory()) walk(full, input.to);
  else if (!oversized.includes(input.to)) out.push(input);
  return out;
}

// ----------------------------------------------------------------------------------------------------------------------------
// summary and ledger

async function loadRows(outDir, bench) {
  const rows = [];
  for (const name of (await fs.readdir(`${outDir}/records`).catch(() => [])).sort()) {
    if (!name.endsWith('.json')) continue;
    const record = JSON.parse(await fs.readFile(`${outDir}/records/${name}`, 'utf8'));
    // Recomputed from the record and the official verdict, so a corrected rule never leaves a stale row behind.
    const task = { id: record.cell, level: record.task?.category, type: record.task?.category };
    rows.push({ ...taskRow({ bench, task, record, verdict: record.verdict }), reply: record.turns?.at(-1)?.reply ?? '', sourceId: record.task?.sourceId });
  }
  return rows;
}

async function summarize(args) {
  const outDir = path.resolve(args.out);
  const run = JSON.parse(await fs.readFile(`${outDir}/run.json`, 'utf8'));
  const rows = await loadRows(outDir, args.bench);
  const scoredRows = args.arm === 'reuse' ? rows.filter((r) => r.phase === 'test') : rows;
  const expected = args.arm === 'reuse' ? run.split?.test?.length : run.tasks?.length;
  const summary = summarizeRows(scoredRows, { bench: args.bench, arm: args.arm, expected });
  if (args.arm === 'reuse') {
    const learning = JSON.parse(await fs.readFile(`${outDir}/learning-complete.json`, 'utf8').catch(() => '{}'));
    summary.reuse = reuseStats(scoredRows, (learning.methods ?? []).filter((m) => m.status === 'approved' && !/official/i.test(String(m.origin ?? ''))));
    summary.practice = summarizeRows(rows.filter((r) => r.phase === 'practice'), { bench: args.bench, arm: 'reuse-practice', expected: run.split?.validation?.length });
  }
  // The official aggregate over the same answers (DABench: eval_closed_form.py; DA-Code: evaluate.run_evaluation).
  const official = `${outDir}/official`;
  await fs.mkdir(official, { recursive: true });
  if (args.bench === 'dabench') {
    await fs.writeFile(`${official}/answers.jsonl`, scoredRows.map((r) => JSON.stringify({ id: r.sourceId, response: r.reply })).join('\n') + '\n');
    const r = spawnSync(SCORE_PY, ['-I', `${HERE}/score_dabench.py`, 'aggregate', '--responses', `${official}/answers.jsonl`, '--out-dir', official], { encoding: 'utf8', timeout: 600_000 });
    summary.official = { exit: r.status, accuracyByQuestion: Number(/Accuracy by Question:\s*([0-9.]+)%/.exec(r.stdout ?? '')?.[1] ?? NaN) / 100 };
  } else if (args.bench === 'da-code') {
    const r = spawnSync(SCORE_PY, ['-I', `${HERE}/score_dacode.py`, 'aggregate', '--out-root', `${outDir}/dacode-output`, '--result-dir', official], { encoding: 'utf8', timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 });
    await fs.writeFile(`${official}/official-stdout.txt`, `${r.stdout ?? ''}\n${r.stderr ?? ''}`.slice(-200000));
    summary.official = { exit: r.status, averageScore: Number(/Average score:\s*([0-9.]+)/.exec(r.stdout ?? '')?.[1] ?? NaN), results: Number(/Number of results:\s*(\d+)/.exec(r.stdout ?? '')?.[1] ?? NaN) };
  }
  summary.rows = scoredRows.map(({ reply, ...rest }) => rest);
  await atomic(`${outDir}/c2-summary.json`, summary);
  const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : (100 * x).toFixed(1));
  const text = `${args.bench} ${args.arm}: ${summary.passed}/${summary.n} pass, value ${pct(summary.value)}% [${summary.ci95?.map(pct).join(', ')}] (paper ${summary.paper.baseline} -> ${summary.paper.reuse}); official ${JSON.stringify(summary.official)}; `
    + `classes ${JSON.stringify(summary.failureClasses)}; per task ${summary.perTask ? `${summary.perTask.costCny.toFixed(4)} CNY, ${Math.round(summary.perTask.wallSeconds)} s, ${summary.perTask.toolCalls.toFixed(1)} tools` : 'n/a'}`
    + `${summary.reuse ? `; reuse ${JSON.stringify(summary.reuse)}` : ''}\n`;
  await fs.writeFile(`${outDir}/c2-summary.txt`, text);
  process.stdout.write(text);
  return summary;
}

async function ledger(args) {
  const outDir = path.resolve(args.out);
  const summary = await summarize(args);
  const run = JSON.parse(await fs.readFile(`${outDir}/run.json`, 'utf8'));
  let engineVersion = 'unknown';
  try { engineVersion = (await (await fetch('http://127.0.0.1:19350/health', { signal: AbortSignal.timeout(5000) })).json()).version ?? 'unknown'; } catch { /* engine down */ }
  const paper = PAPER[args.bench];
  const notes = {
    scorer: run.scorer,
    text: [`C2 ${args.arm} arm on the product path (real control plane, DSH 0.2.2-rc.1, DeepSeek, memory engine ovlab-pp), one fresh project per task${args.arm === 'reuse' ? ' in one account; test part of a 3:2 practice/test split' : ', one fresh account per task'}.`,
      `Official scorer: ${run.scorer}. Paper (EvoDS) ${paper.metric}: baseline ${paper.baseline}, with reuse ${paper.reuse}; the product's model here (${Object.keys(summary.models).join(', ') || 'unknown'}), so absolute values are not comparable, only direction.`,
      `Presentation: ${run.presentation}`,
      `Value counts every task (harness failures as wrong); valueValid excludes them. ${summary.interval}.`,
      summary.official ? `Official aggregate: ${JSON.stringify(summary.official)}.` : ''].join(' '),
  };
  const flags = Object.fromEntries(Object.entries(run.env ?? {}).filter(([k]) => !/KEY|TOKEN|SECRET|PASSWORD/.test(k)));
  const row = ledgerRow(summary, { runId: path.basename(outDir), commit: run.tree?.commit ?? 'unknown', engineVersion, flags: { ...flags, timeoutMin: run.timeoutMin },
    rawPath: outDir, notes, label: `C2 EvoDS ${args.bench} ${args.arm} (product path)` });
  await atomic(path.resolve(args.json), row);
  process.stdout.write(`${JSON.stringify({ set: row.set, n: row.n, value: row.value, ci95: row.ci95 })}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !['worker', 'summarize', 'ledger'].includes(args.mode) || !args.bench || !args.arm || !args.out) {
    console.log('usage: run_c2.mjs worker|summarize|ledger --bench dabench|da-code --arm baseline|reuse --out DIR [--slot N --port P --pg-port PG --tree T --tasks ids --limit N --gate-load L --timeout-min M --json F]');
    process.exit(args.help ? 0 : 2);
  }
  if (args.mode === 'worker') await worker(args);
  else if (args.mode === 'summarize') await summarize(args);
  else await ledger(args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exit(1); });
