#!/usr/bin/env node
/**
 * The criterion-level module measured as it runs: the patient-matching plugin's own managed Flash child (`match_assess` in
 * `packages/patient-matching-plugin/src/handler.mjs`), started by the pinned DSH kernel, answered by the production host adapter
 * (`apps/server/src/patientMatchingHostAdapter.mjs`) over the plugin's real HTTP transport. Only the stores under the host adapter are
 * replaced (in memory, holding the frozen board inputs), and the root conversation is a stand-in that issues `match_assess` calls
 * (`native_replay_parent.mjs`), so the only model reasoning is the child's: its persona, prompt, tools, output schema and the host's
 * trusted Flash reasoning profile, unchanged.
 *
 *   node native_replay.mjs --board c --cases <C-criterion/cases.jsonl> --out <dir> ...           clause labels for score.py c
 *   node native_replay.mjs --board latency --cases <A-sigir/cases.jsonl> --orders <final orders jsonl> --limit 5 --pairs 20 ...
 *   node native_replay.mjs --board incidents --cases incidents.json ...
 *
 * Common: --dsh <kernel bin> --artifact <plugin tarball> --key-file <deepseek key> --cap-cny 25 --parallel 3 [--guide-file <the benchmark's
 * own task definition, read locally> --guide-title <its name>]: the same configuration the benchmark's other systems were given. The DeepSeek key stays in
 * this process: the kernel is given a placeholder and a loopback base URL, and this process forwards each child request to the official
 * endpoint with the key, keeping a spend ledger (`<out>/spend.jsonl`, shared by every board through --ledger) and refusing a request when
 * the cap is reached or it is the full-price window. Resumable: a case whose result file exists is not run again.
 *
 * Exit: 0 finished, 1 error, 3 stopped by a guard.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPatientMatchingHostAdapter } from '../../apps/server/src/patientMatchingHostAdapter.mjs';
import { createVcrTrialCorpus } from '../../apps/server/src/vcrTrialCorpus.mjs';
import { isPeak } from '../../packages/domain/src/metering.mjs';
import { segmentCriteria } from '../../packages/domain/index.mjs';
import { criterionRecord, noteForUpload, protocolOf } from './board_cases.mjs';
import { findings } from './incidents.mjs';
import { n2c2Protocol, n2c2Record } from './n2c2_board.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = 'https://api.deepseek.com';
// Per-million-token prices (CNY): the current Flash reference rates in metering.mjs at full price, never halved for the off-peak window,
// so the ledger is an upper bound of what the provider bills.
const PRICE = { miss: 2, hit: 0.04, output: 8 };
const GENERATION = 'native-replay-0.1.2';
const PLACEHOLDER_KEY = 'sk-native-replay-placeholder-0000000000';
const sha = (text) => createHash('sha256').update(String(text)).digest('hex');
const now = () => Date.now();
const jsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const append = (file, row) => fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
const clone = (value) => structuredClone(value);

// ---------------------------------------------------------------------------------------------------------------------
// The stores under the host adapter, in memory
// ---------------------------------------------------------------------------------------------------------------------

/** One replay conversation: its patients, protocols and trials, and what the host saved. */
function createRun({ id, patients, protocols = [], trials = [], plan, maxCalls }) {
  return { id, userId: 'replay-user', projectId: 'replay-project', patients: new Map(patients.map((row) => [row.subjectKey, row])),
    protocols: new Map(protocols.map((row) => [row.id, row])), trials: new Map(trials.map((row) => [row.registryId, row])),
    plan: [...plan], maxCalls, calls: 0, currentTask: null, rootSessionId: null, pendingAssessCallId: null,
    judgments: [], timeline: [], errors: [], model: { calls: 0, input: 0, cacheRead: 0, output: 0, costCny: 0, ms: [], spans: [] } };
}

const docsOf = (row) => row.docs ?? [{ docId: row.docId, text: row.text, visibleAt: '2026-01-01T00:00:00.000Z' }];

/** The host adapter's dependencies, reading the run a request belongs to. */
/** The benchmark's own task definition, handed to the child the way a study's assessment guide is (`--guide-file`); none by default. */
function createStores(runs, guide = null) {
  const ledger = new Map();
  const runOf = (studyId) => runs.get(String(studyId).replace(/^study-/u, ''));
  const documents = {
    async get(actor, kind, id) { const row = ledger.get(`${actor}|${kind}|${id}`); return row ? clone(row) : null; },
    async put(actor, kind, id, payload, { expectedRevision, projectId } = {}) {
      const key = `${actor}|${kind}|${id}`, current = ledger.get(key), revision = current?.revision ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== revision) throw Object.assign(new Error('revision conflict'), { code: 'product_revision_conflict' });
      const row = { id, kind, projectId, payload: clone(payload), revision: revision + 1 };
      ledger.set(key, row);
      return clone(row);
    },
  };
  const fakeClient = { query: async () => ({ rows: [] }) };
  // Commits hold an advisory lock in production (one per task); one queue here is the same order, stricter.
  let held = Promise.resolve();
  const serial = (fn) => { const turn = held.then(() => fn(fakeClient)); held = turn.catch(() => {}); return turn; };
  const vcr = {
    store: {
      async taskContext(origin) {
        const run = [...runs.values()].find((item) => item.rootSessionId === origin.rootSessionId);
        if (!run) return null;
        return { id: `study-${run.id}`, userId: run.userId, projectId: run.projectId, conversationSessionId: run.rootSessionId,
          ...(guide ? { settings: { matchingGuide: guide.text, matchingGuideTitle: guide.title } } : {}) };
      },
      transaction: serial,
      database: { withTransactionClient: (_client, fn) => fn() },
    },
    access: { require: async () => true },
    documents: {
      // A patient is one document, or (n2c2) the dated records of their file, each visible from its date.
      async roster(study) {
        const run = runOf(study.id);
        return [...run.patients.values()].flatMap((row) => docsOf(row).map((doc) => ({ id: doc.docId, subjectKey: row.subjectKey, subjectLabel: row.subjectKey, visibleAt: doc.visibleAt, chars: doc.text.length })));
      },
      async runtimeRead(study, { subjectKey, documentId }) {
        const row = runOf(study.id).patients.get(subjectKey);
        const doc = row && docsOf(row).find((item) => item.docId === documentId);
        return doc ? { id: doc.docId, text: doc.text } : null;
      },
      async judgeReads(_study, _actor, reads) { return { patientLevel: true, permitted: reads.map(() => true) }; },
      async recordStands() { return null; },
      async recordWindow() { return null; },
    },
    matchStore: {
      async withdrawnSubjects() { return new Set(); },
      async listCriteria({ studyId, protocolVersionId }) { return clone(runOf(studyId).protocols.get(protocolVersionId)?.criteria ?? []); },
      async protocols(studyId, protocolVersionId) {
        const all = [...runOf(studyId).protocols.values()].map((row) => ({ id: row.id, title: row.title, version: 1 }));
        return protocolVersionId ? all.filter((row) => row.id === protocolVersionId) : all;
      },
    },
    evidence: {
      async judgmentRecord({ registryId }) {
        for (const run of runs.values()) {
          const trial = run.trials.get(String(registryId));
          if (trial) return { status: 'ok', trial: clone(trial) };
        }
        return { status: 'registry_not_found', reason: 'not_in_replay', registryId };
      },
    },
    registryPages: null,
    matchJudgments: {
      async save(row) {
        const run = runOf(row.studyId);
        const saved = { ...clone(row), id: `row-${randomUUID()}`, updatedAt: new Date().toISOString() };
        run.judgments.push(saved);
        return clone(saved);
      },
      async byIds(studyId, ids) { const want = new Set(ids); return clone(runOf(studyId).judgments.filter((row) => want.has(row.id))); },
    },
  };
  return { vcr, documents };
}

// ---------------------------------------------------------------------------------------------------------------------
// The loopback server: the host port, the root's control, and the DeepSeek forwarder
// ---------------------------------------------------------------------------------------------------------------------

const CHILD_TOOLS = new Set(['match_evidence', 'match_compute']);

function originOf(run, invocation, signal) {
  if (invocation.tool === 'match_assess') { run.rootSessionId ??= invocation.sessionId; run.pendingAssessCallId = invocation.callId; }
  const child = run.rootSessionId != null && invocation.sessionId !== run.rootSessionId && CHILD_TOOLS.has(invocation.tool);
  const origin = { userId: run.userId, projectId: run.projectId, sessionId: invocation.sessionId, rootSessionId: run.rootSessionId ?? invocation.sessionId,
    runId: run.id, callId: invocation.callId, tool: invocation.tool, args: invocation.args ?? {}, rootCallId: child ? run.pendingAssessCallId : invocation.callId,
    child, pluginGeneration: GENERATION };
  Object.defineProperty(origin, 'signal', { value: signal, enumerable: false });
  return origin;
}

const runnerOrigin = (run) => {
  const origin = { userId: run.userId, projectId: run.projectId, sessionId: run.rootSessionId, rootSessionId: run.rootSessionId, runId: run.id,
    callId: 'replay-progress', tool: 'match_job', args: {}, rootCallId: 'replay-progress', child: false, pluginGeneration: GENERATION };
  Object.defineProperty(origin, 'signal', { value: new AbortController().signal, enumerable: false });
  return origin;
};

async function readBody(req) { const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }

function createServer({ runs, adapter, documents, token, key, ledgerFile, capCny, stopFile, billingFactor = 1 }) {
  let spent = jsonl(ledgerFile).reduce((sum, row) => sum + (row.costCny ?? 0), 0);
  const guard = () => {
    // The ledger is at full price; a request is only ever sent off-peak (below), so the bill is the ledger times the off-peak factor.
    if (spent * billingFactor >= capCny) return 'cap';
    if (isPeak(new Date())) return 'peak';
    if (stopFile && fs.existsSync(stopFile)) return 'stop';
    return null;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const forward = /^\/r\/([^/]+)(\/.*)$/u.exec(url.pathname);
    try {
      if (forward) return await proxy(req, res, runs.get(forward[1]), forward[2] + url.search);
      const match = /^\/run\/([^/]+)\/(port|next)$/u.exec(url.pathname);
      const run = match && runs.get(match[1]);
      if (!run || req.method !== 'POST') { res.writeHead(404).end(); return; }
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (match[2] === 'next') return send(res, 200, await nextCall(run));
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      const controller = new AbortController();
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      const origin = originOf(run, body.invocation ?? {}, controller.signal);
      const started = now();
      let result;
      try { result = await adapter.dispatch({ port: body.port, operation: body.operation, input: body.input ?? {}, origin }); }
      catch (error) {
        // The task's executions as the host held them when it refused (ids, lanes and states only), for a refused lane.
        const task = body.input?.taskId ? await documents.get(run.userId, 'patient-matching-task', body.input.taskId).catch(() => null) : null;
        const held = task?.payload?.executions?.map((item) => ({ id: String(item.executionId).slice(-6), lane: item.lane ?? null, state: item.state, root: item.rootCallId === body.invocation?.callId })) ?? null;
        run.errors.push({ port: body.port, operation: body.operation, phase: body.input?.phase ?? null, lane: body.input?.lane ?? null, held, code: String(error?.code ?? 'error'), message: String(error?.message ?? '').slice(0, 300),
          at: String(error?.stack ?? '').split('\n').slice(1, 4).map((line) => line.trim().replace(/^.*\/OpenScience\//u, '')) });
        return send(res, Number(error?.status) || 400, { error: { code: String(error?.code ?? 'error') } });
      }
      if (body.port === 'ExecutionPort' && body.operation === 'assess') {
        if (result?.data?.task?.taskId) run.currentTask = result.data.task.taskId;
        run.timeline.push({ at: started, end: now(), kind: `assess:${body.input?.phase ?? 'prepare'}`, status: result?.status, executionId: result?.data?.executionId ?? null, lane: body.input?.lane ?? null, answer: result?.data?.kind ?? null, pairs: result?.data?.task?.selectedPairs?.length ?? null,
          clauses: (result?.data?.trialProfiles ?? []).reduce((sum, profile) => sum + profile.criteria.length, 0) || null });
      } else if (body.port === 'ResultPort' && body.operation === 'save') {
        run.timeline.push({ at: started, end: now(), kind: `save:${body.input?.phase}`, status: result?.status, executionId: body.input?.executionId ?? null, decisions: body.input?.decisions?.length ?? 0, diagnostics: (body.input?.diagnostics ?? []).slice(0, 5).map((text) => String(text).slice(0, 160)) });
      } else run.timeline.push({ at: started, end: now(), kind: `${body.port}.${body.operation}`, status: result?.status ?? 'ok' });
      return send(res, 200, result);
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: { code: 'replay_server_error', message: String(error?.message ?? error).slice(0, 200) } });
    }
  });

  /** What the root does next: continue the current task while it has pairs, then the next planned call, then stop. */
  async function nextCall(run) {
    if (run.calls >= run.maxCalls) return { done: true, reason: 'max_calls' };
    if (run.currentTask && run.rootSessionId) {
      const job = await adapter.dispatch({ port: 'JobPort', operation: 'get', input: { taskId: run.currentTask }, origin: runnerOrigin(run) }).catch((error) => ({ error: String(error?.code ?? error) }));
      if (job?.data?.next) { run.calls += 1; return { tool: 'match_assess', args: { taskId: run.currentTask } }; }
      run.currentTask = null;
    }
    const planned = run.plan.shift();
    if (planned) { run.calls += 1; return { tool: 'match_assess', args: planned }; }
    return { done: true };
  }

  /** One child model request, forwarded to the official endpoint with the key; usage read from the stream. */
  async function proxy(req, res, run, rest) {
    if (!run) { res.writeHead(404).end(); return; }
    const stop = guard();
    if (stop) {
      run.errors.push({ port: 'model', code: `guard_${stop}` });
      return send(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: `replay guard: ${stop}` } });
    }
    const body = await readBody(req);
    const headers = { 'content-type': req.headers['content-type'] ?? 'application/json', 'x-api-key': key, 'content-length': body.length };
    for (const name of ['accept', 'anthropic-version', 'anthropic-beta', 'user-agent']) if (req.headers[name]) headers[name] = req.headers[name];
    const started = now();
    const usage = { input: 0, cacheRead: 0, output: 0 };
    const take = (value) => {
      if (!value || typeof value !== 'object') return;
      usage.input = Math.max(usage.input, Number(value.input_tokens) || 0);
      usage.cacheRead = Math.max(usage.cacheRead, Number(value.cache_read_input_tokens) || 0);
      usage.output = Math.max(usage.output, Number(value.output_tokens) || 0);
    };
    await new Promise((resolve) => {
      const upstream = https.request(`${UPSTREAM}${rest}`, { method: req.method, headers, timeout: 600000 }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, { 'content-type': answer.headers['content-type'] ?? 'application/json' });
        let pending = '';
        answer.on('data', (chunk) => {
          res.write(chunk);
          pending += chunk.toString('utf8');
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            try { const event = JSON.parse(line.slice(5)); take(event.message?.usage); take(event.usage); } catch { /* not JSON */ }
          }
        });
        answer.on('end', () => {
          try { const whole = JSON.parse(pending); take(whole.usage); } catch { /* streamed */ }
          res.end();
          const costCny = (usage.input * PRICE.miss + usage.cacheRead * PRICE.hit + usage.output * PRICE.output) / 1e6;
          spent += costCny;
          Object.assign(run.model, { calls: run.model.calls + 1, input: run.model.input + usage.input, cacheRead: run.model.cacheRead + usage.cacheRead,
            output: run.model.output + usage.output, costCny: run.model.costCny + costCny });
          run.model.ms.push(now() - started);
          run.model.spans.push([started, now()]);
          append(ledgerFile, { at: new Date(started).toISOString(), run: run.id, ms: now() - started, status: answer.statusCode, ...usage, costCny });
          resolve();
        });
        answer.on('error', () => { res.end(); resolve(); });
      });
      upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
      upstream.on('error', (error) => {
        run.errors.push({ port: 'model', code: `upstream_${error.code ?? error.message}` });
        if (!res.headersSent) send(res, 502, { type: 'error', error: { type: 'api_error', message: 'upstream unreachable' } }); else res.end();
        resolve();
      });
      upstream.end(body);
    });
  }
  return { server, spent: () => spent, guard };
}

function send(res, status, value) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }

// ---------------------------------------------------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------------------------------------------------

/** A profile with the plugin installed, made once under <work>/profile and copied per conversation. */
function prepareProfile({ dsh, artifact, work }) {
  const base = path.join(work, 'profile');
  const marker = path.join(base, 'installed.json');
  if (fs.existsSync(marker)) return base;
  fs.mkdirSync(path.join(base, 'home'), { recursive: true });
  fs.mkdirSync(path.join(base, 'ws'), { recursive: true });
  const env = { ...process.env, DSH_HOME: path.join(base, 'dsh'), HOME: path.join(base, 'home'), DSH_TELEMETRY: '0' };
  for (const args of [['--profile', 'replay', '--from-default-profile', 'headless', '--dump-config'], ['plugin', '--profile', 'replay', 'add', artifact, '--offline', '--ignore-scripts']]) {
    const out = spawnSync(dsh, args, { env, cwd: path.join(base, 'ws'), encoding: 'utf8', timeout: 180000 });
    if (out.status !== 0) throw new Error(`profile step failed: ${args[0]} ${(out.stderr || out.stdout).slice(-400)}`);
  }
  fs.writeFileSync(marker, JSON.stringify({ artifact: path.basename(artifact), sha256: createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'), kernel: spawnSync(dsh, ['--version'], { encoding: 'utf8' }).stdout.trim() }));
  return base;
}

function patchFor({ port, runId }) {
  return [
    '- id: agent-default-model', '  config:', '    provider: native-replay', '    model: replay-root',
    // The production row (dshProfilePatch.mjs) with the loopback forwarder as its gateway.
    '- id: llm-deepseek', '  config:', `    baseURL: http://127.0.0.1:${port}/r/${runId}/anthropic`, '    thinking: enabled', '    reasoningEffort: high', '    maxTokens: 65536',
    '    retryPolicy:', '      mode: normal', '      maxRetries: 5', '      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE]',
    '      backoff:', '        initialDelayMs: 500', '        maxDelayMs: 10000', '        jitterRatio: 0.1',
    // The socket's child capacity row (packages/socket/cordis.patch.yml): production holds each tree to 30 children, the kernel default is 8.
    '- id: subagent', '  config:', '    maxActiveSubagents: 30',
    '- id: llm-deepseek-account', '  disabled: true',
    '- id: session-title-llm', '  disabled: true',
    '- insert:', '    - id: native-replay-parent', `      name: '${path.join(HERE, 'native_replay_parent.mjs')}'`,
    '',
  ].join('\n');
}

async function runKernel({ run, dsh, profile, work, port, tokenFile, timeoutMs }) {
  const dir = path.join(work, 'runs', run.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ws'), { recursive: true });
  fs.cpSync(path.join(profile, 'dsh'), path.join(dir, 'dsh'), { recursive: true });
  const patch = path.join(dir, 'replay.patch.yml');
  fs.writeFileSync(patch, patchFor({ port, runId: run.id }));
  const env = { ...process.env, DSH_HOME: path.join(dir, 'dsh'), HOME: path.join(dir, 'home'), DSH_TELEMETRY: '0', DEEPSEEK_API_KEY: PLACEHOLDER_KEY,
    EVIMED_PATIENT_MATCHING_ENABLED: '1', EVIMED_PATIENT_MATCHING_HOST_ENDPOINT: `http://127.0.0.1:${port}/run/${run.id}/port`,
    EVIMED_PATIENT_MATCHING_TOKEN_FILE: tokenFile, NATIVE_REPLAY_CONTROL: `http://127.0.0.1:${port}/run/${run.id}/next` };
  delete env.DEEPSEEK_BASE_URL;
  const started = now();
  const child = spawn(dsh, ['--profile', 'replay', '--patch', patch, '--json', 'Assess the selected patient and trial pairs.'], { env, cwd: path.join(dir, 'ws'), stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(dir, 'kernel.log'));
  child.stdout.pipe(log); child.stderr.pipe(log);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const [code, signal] = await new Promise((resolve) => child.once('exit', (c, s) => resolve([c, s])));
  clearTimeout(timer);
  await new Promise((resolve) => log.end(resolve));
  if (process.env.NATIVE_REPLAY_KEEP !== '1') fs.rmSync(path.join(dir, 'dsh'), { recursive: true, force: true });
  return { code, signal, wallMs: now() - started };
}

// ---------------------------------------------------------------------------------------------------------------------
// The boards
// ---------------------------------------------------------------------------------------------------------------------

function trialFromPrecedent(registryId, built) {
  const precedent = built.precedent ?? {}, description = built.description ?? {};
  return { registry: 'clinicaltrials.gov', registryId, title: precedent.title ?? '', summary: description.briefSummary ?? '', eligibility: precedent.eligibilityText ?? '',
    minimumAge: precedent.pico?.minimumAge ?? '', maximumAge: precedent.pico?.maximumAge ?? '', sex: precedent.pico?.sex ?? '', conditions: precedent.pico?.conditions ?? [],
    interventions: (precedent.pico?.interventions ?? []).map((item) => item?.name ?? item) };
}

function trialFromTrialGpt(registryId, raw) {
  return { registry: 'clinicaltrials.gov', registryId, title: raw.title ?? '', summary: raw.brief_summary ?? '', eligibility: raw.raw_criteria ?? '', minimumAge: raw.minimum_age ?? '',
    maximumAge: raw.maximum_age ?? '', sex: raw.sex ?? '', conditions: Array.isArray(raw.condition) ? raw.condition : raw.condition ? [raw.condition] : [], interventions: [] };
}

const latestRows = (run) => {
  const newest = new Map();
  for (const row of [...run.judgments].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) newest.set(`${row.subjectKey}|${row.targetId}`, row);
  return newest;
};

const clauseRows = (row) => (row?.answer?.rows ?? []).map((item) => ({ number: item.number, kind: item.kind, label: item.label, basis: item.basis ?? null,
  sentenceIds: (item.evidence ?? []).map((evidence) => evidence.sentenceId) }));

async function buildCases(o) {
  if (o.board === 'c') {
    const cases = jsonl(o.cases).slice(0, o.limit ?? undefined);
    return cases.map((row) => {
      const protocols = row.trials.map((trial) => {
        const own = protocolOf(trial), id = `pv-${own.key}`;
        return { id, registryId: trial.registryId, title: own.title, numbered: own.numbered,
          criteria: own.criteria.map((criterion, index) => ({ id: `${id}-c${index + 1}`, kind: criterion.kind, sourceText: criterion.sourceText })) };
      });
      return { key: row.patientId, case: row, patients: [{ subjectKey: row.patientId, docId: `doc-${sha(row.patientId).slice(0, 12)}`, text: noteForUpload('c', row.note) }],
        protocols, plan: protocols.map((protocol) => ({ protocolVersionId: protocol.id, subjectKeys: [row.patientId] })) };
    });
  }
  if (o.board === 'latency') {
    const orders = new Map(jsonl(o.orders).map((row) => [row.patientId, row.ranking.map((entry) => entry.registryId)]));
    const cases = jsonl(o.cases).filter((row) => row.split === 'dev' && (orders.get(row.patientId)?.length ?? 0) >= o.pairs).slice(0, o.limit ?? 5);
    const corpus = createVcrTrialCorpus(o.collection);
    const out = [];
    for (const row of cases) {
      const ids = orders.get(row.patientId).slice(0, o.pairs);
      const trials = [];
      for (const registryId of ids) { const built = await corpus.record(registryId); if (built) trials.push(trialFromPrecedent(registryId, built)); }
      out.push({ key: row.patientId, case: row, patients: [{ subjectKey: row.patientId, docId: `doc-${sha(row.patientId).slice(0, 12)}`, text: String(row.note) }],
        trials, plan: [{ subjectKey: row.patientId, registryIds: trials.map((trial) => trial.registryId) }] });
    }
    await corpus.close?.();
    return out;
  }
  if (o.board === 'incidents') {
    const cases = JSON.parse(fs.readFileSync(o.cases, 'utf8'));
    return cases.slice(0, o.limit ?? undefined).map((one, index) => {
      const registryId = `NCT9${String(index + 1).padStart(7, '0')}`, subjectKey = `inc-${one.id}`;
      return { key: one.id, incident: one, patients: [{ subjectKey, docId: `doc-${index + 1}`, text: one.note }], trials: [trialFromTrialGpt(registryId, one.trial)],
        plan: [{ subjectKey, registryIds: [registryId] }] };
    });
  }
  if (o.board === 'f') {
    // The thirteen criteria as one protocol, each patient's file as its dated records; clause k is the scorer's tag k (n2c2_board.mjs).
    const own = n2c2Protocol(), id = `pv-${own.key}`;
    const protocol = { id, title: own.title, criteria: own.criteria.map((criterion, index) => ({ id: `${id}-c${index + 1}`, kind: criterion.kind, sourceText: criterion.sourceText })) };
    return jsonl(o.cases).slice(0, o.limit ?? undefined).map((row) => ({ key: row.patientId, case: row, protocols: [protocol],
      patients: [{ subjectKey: row.patientId, docs: row.records.map((record, index) => ({ docId: `doc-${sha(row.patientId).slice(0, 8)}-${index + 1}`, text: record.text, visibleAt: `${record.date}T00:00:00.000Z` })) }],
      plan: [{ protocolVersionId: id, subjectKeys: [row.patientId] }] }));
  }
  throw new Error(`unknown board ${o.board}`);
}

function resultOf(o, spec, run, kernel) {
  const newest = latestRows(run);
  const assess = run.timeline.filter((item) => item.kind.startsWith('assess:prepare'));
  const saves = run.timeline.filter((item) => item.kind.startsWith('save:'));
  const span = assess.length && saves.length ? saves.at(-1).end - assess[0].at : null;
  const opened = new Map();
  for (const item of assess) if (item.executionId && !opened.has(item.executionId)) opened.set(item.executionId, item.at);
  const intervals = saves.filter((item) => opened.has(item.executionId)).map((item) => [opened.get(item.executionId), item.end]);
  const summary = { key: spec.key, run: run.id, kernel: { code: kernel.code, signal: kernel.signal, wallMs: kernel.wallMs }, assessSpanMs: span, executions: opened.size, lanes: [...new Set(assess.map((item) => item.lane))].length, concurrentExecutionsMax: overlap(intervals), concurrentModelCallsMax: overlap(run.model.spans), busyAnswers: assess.filter((item) => item.answer === 'busy').length,
    saves: saves.map((item) => ({ kind: item.kind, status: item.status, decisions: item.decisions, diagnostics: item.diagnostics })),
    model: { ...run.model, ms: undefined, spans: undefined, p50Ms: median(run.model.ms) }, errors: run.errors.slice(0, 20), rows: run.judgments.length,
    done: [...newest.values()].filter((row) => row.status === 'done').length, failed: [...newest.values()].filter((row) => row.status !== 'done').length };
  if (o.board === 'c') {
    const byTrial = new Map(), failed = [];
    for (const protocol of spec.protocols) {
      const row = newest.get(`${spec.case.patientId}|${protocol.id}`);
      if (row?.status === 'done') byTrial.set(String(protocol.registryId), { ranking: [{ fit: row.fit, verdict: row.verdict, criteria: clauseRows(row) }], numbered: protocol.numbered });
      else failed.push({ registryId: protocol.registryId, code: row?.errorCode ?? 'native_not_saved' });
    }
    return { summary, record: criterionRecord({ case: spec.case, byTrial, failed, usage: { inputTokens: run.model.input, outputTokens: run.model.output, costCny: Number(run.model.costCny.toFixed(4)) } }) };
  }
  if (o.board === 'f') {
    const protocol = spec.protocols[0], row = newest.get(`${spec.case.patientId}|${protocol.id}`);
    const done = row?.status === 'done';
    return { summary, record: n2c2Record({ case: spec.case, judgment: done ? { criteria: clauseRows(row) } : null, failed: done ? [] : [{ registryId: protocol.id, code: row?.errorCode ?? 'native_not_saved' }],
      usage: { inputTokens: run.model.input, outputTokens: run.model.output, costCny: Number(run.model.costCny.toFixed(4)) } }) };
  }
  if (o.board === 'latency') {
    const verdicts = {};
    for (const row of newest.values()) verdicts[row.verdict ?? row.status] = (verdicts[row.verdict ?? row.status] ?? 0) + 1;
    return { summary: { ...summary, pairs: spec.trials.length, verdicts } };
  }
  const trial = spec.trials[0], row = newest.get(`${spec.patients[0].subjectKey}|${trial.registryId}`);
  const clauses = segmentCriteria(trial.eligibility);
  const entry = row?.status === 'done' ? { fit: row.fit, verdict: row.verdict, criteria: clauseRows(row).map((item) => ({ ...item, clause: clauses[item.number - 1]?.text ?? '' })) } : null;
  const found = findings(spec.incident.expect, entry);
  return { summary: { ...summary, pass: found.length === 0, findings: found, fit: entry?.fit ?? null, verdict: entry?.verdict ?? null } };
}

/** The most intervals open at one instant. */
function overlap(intervals) {
  const edges = intervals.flatMap(([start, end]) => [[start, 1], [end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0, most = 0;
  for (const [, step] of edges) { open += step; most = Math.max(most, open); }
  return most;
}

function median(values) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]; }

async function main() {
  const { values } = parseArgs({ options: {
    board: { type: 'string' }, cases: { type: 'string' }, out: { type: 'string' }, work: { type: 'string' }, dsh: { type: 'string' }, artifact: { type: 'string' },
    'key-file': { type: 'string' }, 'cap-cny': { type: 'string', default: '25' }, ledger: { type: 'string' }, parallel: { type: 'string', default: '3' },
    limit: { type: 'string' }, pairs: { type: 'string', default: '20' }, orders: { type: 'string' }, collection: { type: 'string' }, 'timeout-min': { type: 'string', default: '45' },
    'stop-file': { type: 'string' }, 'guide-file': { type: 'string' }, 'guide-title': { type: 'string' }, 'billing-factor': { type: 'string', default: '1' } } });
  const o = { ...values, limit: values.limit ? Number(values.limit) : null, pairs: Number(values.pairs), parallel: Number(values.parallel) };
  for (const name of ['board', 'cases', 'out', 'work', 'dsh', 'artifact', 'key-file']) if (!o[name]) throw new Error(`--${name} is required`);
  fs.mkdirSync(o.out, { recursive: true });
  fs.mkdirSync(o.work, { recursive: true });
  const ledgerFile = o.ledger ?? path.join(o.out, 'spend.jsonl');
  const key = fs.readFileSync(o['key-file'], 'utf8').trim();
  const tokenFile = path.join(o.work, 'host.token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomUUID().replaceAll('-', ''), { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const profile = prepareProfile({ dsh: o.dsh, artifact: o.artifact, work: o.work });
  const runs = new Map();
  const guide = o['guide-file'] ? { title: o['guide-title'] ?? 'Benchmark task definition', text: fs.readFileSync(o['guide-file'], 'utf8').trim() } : null;
  const { vcr, documents } = createStores(runs, guide);
  const adapter = createPatientMatchingHostAdapter({ vcr, documents, config: {} });
  const { server, spent, guard } = createServer({ runs, adapter, documents, token, key, ledgerFile, capCny: Number(o['cap-cny']), stopFile: o['stop-file'], billingFactor: Number(o['billing-factor']) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const specs = await buildCases(o);
  const resultsFile = path.join(o.out, 'results.jsonl'), recordsFile = path.join(o.out, 'judgments.jsonl');
  const done = new Set(jsonl(resultsFile).map((row) => row.key));
  const queue = specs.filter((spec) => !done.has(spec.key));
  console.log(`[replay] ${o.board}: ${specs.length} cases, ${done.size} done, ${queue.length} to run, spent so far CNY ${spent().toFixed(3)}`);
  let stopped = null;
  const worker = async () => {
    for (let spec = queue.shift(); spec; spec = queue.shift()) {
      const why = guard();
      if (why) { stopped = why; return; }
      const id = `r${sha(`${o.board}|${spec.key}`).slice(0, 10)}`;
      const run = createRun({ id, patients: spec.patients, protocols: spec.protocols, trials: spec.trials, plan: spec.plan,
        maxCalls: spec.plan.length + (spec.protocols?.length ?? 0) + (spec.trials?.length ?? 0) + 4 });
      runs.set(id, run);
      const kernel = await runKernel({ run, dsh: o.dsh, profile, work: o.work, port, tokenFile, timeoutMs: Number(o['timeout-min']) * 60000 });
      const result = resultOf(o, spec, run, kernel);
      fs.writeFileSync(path.join(o.work, 'runs', id, 'timeline.json'), JSON.stringify({ timeline: run.timeline, errors: run.errors, modelMs: run.model.ms }, null, 1));
      if (result.record) append(recordsFile, result.record);
      append(resultsFile, result.summary);
      const s = result.summary;
      console.log(`[replay] ${new Date().toISOString()} ${o.board} ${id} exit=${kernel.code ?? kernel.signal} wall=${(kernel.wallMs / 1000).toFixed(0)}s span=${s.assessSpanMs == null ? '-' : (s.assessSpanMs / 1000).toFixed(0)}s exec=${s.executions} done=${s.done} failed=${s.failed} conc=${s.concurrentExecutionsMax ?? "-"} calls=${s.model.calls} CNY=${s.model.costCny.toFixed(3)} errors=${s.errors.length}${s.pass == null ? '' : ` pass=${s.pass}`} total=${spent().toFixed(3)}`);
      runs.delete(id);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.parallel) }, worker));
  server.close();
  console.log(`[replay] ${o.board} ${stopped ? `stopped: ${stopped}` : 'finished'}; spent CNY ${spent().toFixed(3)}`);
  return stopped ? 3 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((code) => process.exit(code), (error) => { console.error(`[replay] error: ${error?.message ?? error}`); process.exit(1); });
}
