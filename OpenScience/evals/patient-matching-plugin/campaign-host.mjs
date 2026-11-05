/** Native public benchmark host. No labels, expected verdicts or direct clinical model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { ControlPlaneDatabase } from '../../apps/server/src/controlPlaneDatabase.mjs';
import { UsageLedger, closeUnsettledReservation } from '../../apps/server/src/usageLedger.mjs';
import { parseMessagesReceipt, createUsageTail } from '../../apps/server/src/usageMetering.mjs';
import { ProductDocuments } from '../../apps/server/src/productStore.mjs';
import { composeVcr } from '../../apps/server/src/vcrComposition.mjs';
import { createVcrTrialCorpus } from '../../apps/server/src/vcrTrialCorpus.mjs';
import { createVcrPatientContext } from '../../apps/server/src/vcrPatientContext.mjs';
import { createPatientMatchingHostAdapter, patientMatchingScope } from '../../apps/server/src/patientMatchingHostAdapter.mjs';
import { patientMatchingRankingDocument, MATCHING_RANKING_VIEW } from '../../apps/server/src/patientMatchingRankingText.mjs';
import { createPatientMatchingGatewayHandler } from '../../apps/server/src/patientMatchingGateway.mjs';
import { createPatientMatchingModelPorts } from '../../apps/server/src/patientMatchingModels.mjs';
import { createPatientMatchingDiscovery } from '../../apps/server/src/patientMatchingDiscovery.mjs';
import { createPatientMatchingTrialResource } from '../../apps/server/src/patientMatchingTrialResource.mjs';
import { patientMatchingConfiguration } from '../../apps/server/src/patientMatchingConfiguration.mjs';
import { priceUsage, REFERENCE_PRICE_LIST, isPeak } from '../../packages/domain/index.mjs';
import { validateMatchingResult, contentDigest, profileIdentity } from '../../packages/patient-matching-core/index.mjs';
import { createCampaignBudget } from './campaign-budget.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const writes = new Map();
const write = (filename, value) => {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const pending = (writes.get(filename) ?? Promise.resolve()).then(async () => {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  });
  writes.set(filename, pending);
  return pending.finally(() => { if (writes.get(filename) === pending) writes.delete(filename); });
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execFile);
const OWNER = 'matching-campaign-owner', PROJECT = 'matching-campaign-project';
/** HTTP socket close does not await async handlers. Keep billing finalizers alive until their work really settles. */
export function createCampaignFinalizers() {
  const controller = new AbortController(), pending = new Set(); let closing = false;
  const abort = () => { closing = true; if (!controller.signal.aborted) controller.abort(new Error('Campaign owner stopped execution')); };
  return {
    signal: controller.signal, abort,
    wrap(handler) {
      return (request, response) => {
        if (closing) { response.writeHead(503); response.end(); return; }
        const work = Promise.resolve().then(() => handler(request, response)); pending.add(work);
        work.then(() => pending.delete(work), () => pending.delete(work)); return work;
      };
    },
    async drain({ abort: cancel = false } = {}) {
      closing = true; if (cancel) abort();
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
/** Abort the real curl process and await close, rather than merely awaiting the early AbortError promise. */
export async function runCampaignCurl(configFile, { signal, execute = exec } = {}) {
  const work = execute('curl', ['--config', configFile, '--write-out', '%{http_code}'], { timeout: 250000, maxBuffer: 1024 * 1024, signal, killSignal: 'SIGTERM' });
  const child = work.child;
  let closed = !child;
  const exited = child ? new Promise(resolve => {
    const finish = () => { closed = true; resolve(); };
    child.once('close', finish); child.once('error', () => { if (!child.pid) finish(); });
    if (child.exitCode !== null || child.signalCode !== null) finish();
  }) : Promise.resolve();
  try { return await work; }
  finally {
    let force;
    if (signal?.aborted && child && !closed) { child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 2000); }
    await exited; if (force) clearTimeout(force);
  }
}
/** The production gateway owns origin.signal, so cancellation must enter through its request lifecycle. */
export async function dispatchCampaignGateway(gateway, request, response, ownerSignal) {
  const abort = () => request.emit('aborted');
  ownerSignal.addEventListener('abort', abort, { once: true });
  try {
    const work = gateway(request, response);
    // The gateway installs its abort listener synchronously before reading the replayed body.
    if (ownerSignal.aborted) abort();
    return await work;
  } finally { ownerSignal.removeEventListener('abort', abort); }
}
export const campaignSourceModelIdentity = ({ artifactSha256, definition, indexDigest, sourceIdentity, modelProfile }) => contentDigest(JSON.stringify({ artifactSha256, definition, indexDigest, sourceIdentity, modelProfile }));
export async function verifyCampaignSources(configured) {
  assert.equal(hash(await fs.readFile(path.resolve(configured.artifact))), configured.artifactSha256, 'Unqualified plugin artifact');
  if (!configured.sourceFiles) return null;
  const bytes = await fs.readFile(configured.sourceFiles); assert.equal(contentDigest(bytes), configured.sourceFilesDigest, 'Frozen host source receipt changed');
  for (const [filename, digest] of Object.entries(JSON.parse(bytes))) assert.equal(contentDigest(await fs.readFile(filename)), digest, 'Host source differs from the frozen campaign');
  return configured.sourceFilesDigest;
}
/** Resource backpressure only: clinical and discovery reads share the source reader's existing bound. */
export function createCampaignReadGate(limit = 8) {
  let active = 0;
  const waiting = [];
  return async operation => {
    if (active >= limit) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await operation(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}
/** Freeze a declared clinical subset from a persisted full relevance order; this never changes that parent order. */
export async function freezeClinicalSubset({ searches, study, subjectKey, discovery, depth }) {
  assert.ok(Number.isSafeInteger(depth) && depth > 0 && depth <= 100);
  const parent = await searches.get(study, discovery.searchId);
  assert.ok(parent && parent.items.length && parent.items.every(item => typeof item.registryId === 'string'));
  const parentIds = parent.items.map(item => item.registryId), items = parent.items.slice(0, depth), registryIds = items.map(item => item.registryId), selected = new Set(registryIds);
  assert.equal(selected.size, registryIds.length);
  const source = { parentSearchId: parent.id, parentCount: parentIds.length, parentOrderDigest: profileIdentity(parentIds), requestedDepth: depth, selectedCount: items.length };
  const searchId = await searches.save(study, { subjectKey, request: { ...parent.request, clinicalSubset: source }, registries: parent.registries,
    collection: parent.collection, found: items.length, items,
    rerank: { ...parent.rerank, incomingOrder: (parent.rerank?.incomingOrder ?? parentIds).filter(id => selected.has(id)), finalOrder: registryIds, clinicalSubset: source } });
  return { searchId, ...source, registryIds };
}
export function campaignStep(state) {
  if (state.ended || state.stopReason) return {};
  if (!state.context) return { tool: 'match_context', args: { messageSeq: 1 } };
  if (state.board !== 'sigir' && !state.discovery) return { tool: 'match_discover', args: { taskId: state.context.taskId, query: state.case.note.slice(0, 4000), limit: 100 } };
  if (state.stopReason || state.result && state.result.rows.every(row => row.current)) return {};
  const acknowledgement = state.sourceRepair?.acceptedFailureThroughSegment;
  const acknowledgedThrough = Number.isSafeInteger(acknowledgement) && acknowledgement >= 0 && acknowledgement <= state.nativeSegments ? acknowledgement : 0;
  if (state.nativeSegments > Math.max(state.lastSavedSegment ?? 0, acknowledgedThrough)) { state.stopReason = 'native_assessment_no_saved_progress'; return {}; }
  return { tool: 'match_assess', args: { taskId: state.context.taskId, subjectKey: state.context.subjectKey,
    ...(state.discovery ? { searchId: state.clinicalSelection?.searchId ?? state.discovery.searchId } : {}) } };
}

export function campaignMessagesInvoice(bytes, at) {
  const raw = bytes.toString(), { usage, id } = parseMessagesReceipt(raw);
  let model = null;
  for (const line of raw.split('\n')) if (line.startsWith('data: ')) { try { const envelope = JSON.parse(line.slice(6)); model = envelope.message?.model ?? model; } catch { /* Non-JSON SSE keep-alive. */ } }
  const validModel = typeof model === 'string' && /flash/i.test(model) && !/pro/i.test(model);
  const completion = createUsageTail(16384, { stream: true, protocol: 'messages' }); completion.observe(bytes);
  const priced = usage ? priceUsage({ resourceType: 'model', model: 'deepseek-flash', cacheHit: usage.cacheHitTokens, cacheMiss: usage.cacheMissTokens, output: usage.completionTokens, peak: isPeak(at) }) : null;
  return { usage, id, servedModel: model, validModel, finished: completion.finished(), price: priced };
}

/** Same durable usage rows plus the campaign lifetime fence; uncertain requests retain the reserved upper bound. */
export function campaignLedger(ledger, budget, allowProviderCalls = true) {
  return new Proxy(ledger, { get(target, property) {
    if (property === 'reserveModel') return async input => {
      if (!allowProviderCalls) throw Object.assign(new Error('Campaign paid calls are disabled'), { code: 'campaign_paid_calls_disabled' });
      await budget.reserve({ id: input.id, provider: input.model.startsWith('deepseek') ? 'deepseek' : input.model, maxCostCny: input.estimatedCost, operation: input.operation, taskId: input.taskId });
      try { return await target.reserveModel({ ...input, purpose: 'kernel', budgetPurpose: 'kernel', dailyLimit: 500, weeklyLimit: 500 }); }
      catch (error) { await budget.settle({ id: input.id, costCny: 0 }); throw error; }
    };
    if (property === 'settleModel') return async (user, id, input) => { const result = await target.settleModel(user, id, input); await budget.settle({ id, costCny: input.actualCost, uncertain: !input.priced }); return result; };
    if (property === 'markUncertain') return async (user, id, code, input) => { const result = await target.markUncertain(user, id, code, input); await budget.settle({ id, costCny: input?.estimatedCost ?? 0, uncertain: true }); return result; };
    if (property === 'release') return async (user, id, ...rest) => { const result = await target.release(user, id, ...rest); await budget.settle({ id, costCny: 0 }); return result; };
    const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export async function runCampaign({ configPath, prepareOnly = false, maximumTopics = Infinity, selectedBoards = null }) {
  const configured = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const out = path.resolve(configured.out), stateDir = path.join(out, 'topics');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const artifact = path.resolve(configured.artifact), artifactSha256 = hash(await fs.readFile(artifact));
  assert.equal(artifactSha256, configured.artifactSha256, 'Unqualified plugin artifact');
  const sourceIdentity = await verifyCampaignSources(configured);
  const source = JSON.parse(await fs.readFile(configured.postgresConfig, 'utf8'));
  const database = new ControlPlaneDatabase({ ...source, databasePoolMax: 16, databaseConnectionTimeoutMs: 10000 });
  const budget = createCampaignBudget({ path: configured.campaignBudget, limitCny: 500 });
  const ledger = campaignLedger(new UsageLedger(database), budget, configured.allowProviderCalls === true);
  await ledger.health();
  const providers = JSON.parse(await fs.readFile(configured.providerConfig, 'utf8'));
  const deepseekKey = (await fs.readFile(providers.deepseek.key_file, 'utf8')).trim();
  const dashscopeKey = (await fs.readFile(providers.dashscope.key_file, 'utf8')).trim();
  const workload = randomBytes(32).toString('hex'), hostToken = randomBytes(32).toString('hex');
  const states = new Map(), children = new Map(), boards = new Map(), errors = [], providerCalls = [];
  const finalizers = createCampaignFinalizers();
  const generation = `campaign-${artifactSha256}`, startedAt = Date.now();
  const persist = async state => write(path.join(stateDir, `${state.case.patientId}.json`), state);
  let kernel, cancelled = false;
  let checkedBalanceAt = 0, balanceCheck = null;
  const checkBalance = async () => {
    if (Date.now() - checkedBalanceAt < 5 * 60 * 1000) return;
    balanceCheck ??= (async () => {
      const result = await exec(configured.python ?? 'python3', ['-I', '-B', fileURLToPath(new URL('../vcr-matching-boards/budget.py', import.meta.url)), '--key-file', providers.deepseek.key_file, '--floor', '200', '--require-off-peak'], { timeout: 30000, maxBuffer: 16384 });
      await fs.appendFile(path.join(out, 'balance-checks.jsonl'), JSON.stringify({ at: new Date().toISOString(), result: result.stdout.trim() }) + '\n', { mode: 0o600 }); checkedBalanceAt = Date.now();
    })().finally(() => { balanceCheck = null; });
    return balanceCheck;
  };
  const stop = () => { cancelled = true; finalizers.abort(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const authorize = async envelope => {
    finalizers.signal.throwIfAborted();
    assert.equal(envelope.scope.actorId, OWNER); assert.equal(envelope.scope.projectId, PROJECT);
    return { userId: OWNER, projectId: PROJECT, limits: { daily: 500, weekly: 500 } };
  };
  for (const [board, definition] of Object.entries(configured.boards)) {
    if (board === 'sigir') assert.equal(definition.clinicalDepth, undefined, 'SIGIR retains every supplied judged pair');
    const bytes = await fs.readFile(definition.cases), cases = bytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(contentDigest(bytes), definition.casesDigest, 'Requested topics changed');
    const collectionBytes = await fs.readFile(definition.collection);
    assert.equal(contentDigest(collectionBytes), definition.collectionDigest, 'Frozen collection manifest changed');
    const config = { vcrEnabled: true, vcrAudience: 'all', vcrProviderAgreements: true, vcrDataPlaneDir: path.join(out, 'data-plane', board),
      vcrTrialCorpusManifest: definition.collection, vcrMatchRerankEnabled: true, vcrMatchRerankIntakeMax: 100,
      requireDurableUsageLedger: true, production: true, dashscopeApiKey: dashscopeKey, userDailySpendLimit: 500, userWeeklySpendLimit: 500,
      deepseekBaseUrl: 'https://api.deepseek.com' };
    config.patientMatchingProfile = patientMatchingConfiguration(config, {});
    const indexDigest = definition.indexManifest ? contentDigest(await fs.readFile(definition.indexManifest)) : null;
    if (definition.indexManifest) assert.equal(indexDigest, definition.indexManifestDigest, 'Frozen index manifest changed');
    const sourceModelIdentity = campaignSourceModelIdentity({ artifactSha256, definition, indexDigest, sourceIdentity, modelProfile: config.patientMatchingProfile });
    const vcr = composeVcr({ config, productDatabase: database }); await vcr.store.ready();
    const sourceRead = createCampaignReadGate(8);
    for (const operation of ['registryRecord', 'judgmentRecord']) {
      const original = vcr.evidence[operation].bind(vcr.evidence);
      vcr.evidence[operation] = (...args) => sourceRead(() => original(...args));
    }
    const corpus = createVcrTrialCorpus(definition.collection, { timeoutMs: 60000 });
    const runtimeRead = vcr.service.runtimeRead.bind(vcr.service);
    // Frozen benchmark source adapter: the existing production corpus reader accepts the complete
    // public vignette. No keyword extraction, model proxy, relevance label or registry network is used.
    vcr.service.runtimeRead = async (study, what, filter, options) => {
      if (what !== 'candidates') return runtimeRead(study, what, filter, options);
      await vcr.access.require({ actor: OWNER, studyId: study.id, ability: 'read_patient_level' });
      return corpus.collect({ condition: filter.condition, terms: [], summary: null, age: null, sex: null, region: null, scope: 'any', limit: 100 });
    };
    vcr.patientContext = createVcrPatientContext({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, documents: vcr.documents, subjectKnown: vcr.subjectKnown,
      transcript: async origin => ({ sessionId: origin.rootSessionId, messages: [{ seq: 1, role: 'user', source: 'user', parts: [{ type: 'text', text: states.get(origin.rootSessionId).case.note }] }] }), isHumanMessage: async () => true });
    const models = createPatientMatchingModelPorts({ config, usageLedger: ledger, authorize });
    const resource = definition.indexManifest ? await createPatientMatchingTrialResource({ manifestPath: definition.indexManifest, database, models, authorize }) : null;
    const observedIndex = resource ? { ...resource, async query(envelope) {
      const result = await resource.query(envelope), state = states.get(envelope.origin.rootSessionId);
      if (state) state.denseRetrieval = result;
      return result;
    } } : null;
    const discover = createPatientMatchingDiscovery({ vcr, models, index: observedIndex });
    const adapter = createPatientMatchingHostAdapter({ vcr, documents: new ProductDocuments(database), config, modelPorts: models, indexPorts: resource, discover });
    const gateway = createPatientMatchingGatewayHandler(config, { assertActiveModelGatewayToken(token) { assert.equal(token, hostToken); return { userId: OWNER, projectId: PROJECT }; } }, {
      vcr, adapter, resolveInvocation: async (_identity, body) => {
        const invocation = body.invocation, root = children.get(invocation.sessionId) ?? invocation.sessionId, state = states.get(root);
        assert.ok(state, 'An original topic session must own every invocation');
        return { userId: OWNER, projectId: PROJECT, rootSessionId: root, runId: `native-${state.case.patientId}`, callId: invocation.callId,
          rootCallId: root === invocation.sessionId ? invocation.callId : state.assessmentCallId, pluginGeneration: generation, tool: invocation.tool, args: invocation.args, child: root !== invocation.sessionId };
      }, report: code => errors.push({ stage: 'gateway', code }) });
    boards.set(board, { cases, vcr, adapter, gateway, corpus, models, definition });
    for (const row of cases) {
      assert.equal(row.language ?? 'en', 'en'); assert.equal(row.translatedFrom, undefined);
      const sessionId = `campaign-${configured.sessionNamespace}-${row.patientId.toLowerCase()}`;
      let state;
      try { state = JSON.parse(await fs.readFile(path.join(stateDir, `${row.patientId}.json`), 'utf8')); assert.equal(state.sourceModelIdentity, sourceModelIdentity); assert.equal(state.artifactSha256, artifactSha256); assert.equal(state.inputDigest, contentDigest(JSON.stringify(row))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; state = { board, case: row, inputDigest: contentDigest(JSON.stringify(row)), sourceModelIdentity, sessionId, artifactSha256, calls: 0, nativeSegments: 0, status: 'pending' }; }
      states.set(sessionId, state);
    }
  }
  const receipt = { kind: 'native-matching-full-campaign', artifactSha256, generation, sourceIdentity, concurrency: 8, sourceReadConcurrencyPerBoard: 8, maxCostCny: 500,
    casesRequested: states.size, providerRetryCount: 0, scope: 'Pinned native plugin and production PostgreSQL HostAdapter reference host; SaaS UI/customer acceptance and clinical validation are separate.' };
  receipt.depths = Object.fromEntries([...boards].map(([board, value]) => [board, { mainRanking: board === 'sigir' ? 'all-supplied-pairs' : 100, fullClinical: value.definition.clinicalDepth ?? 'all-supplied-pairs' }]));
  await write(path.join(out, 'preflight.json'), { ...receipt, boards: [...boards].map(([board, value]) => ({ board, cases: value.cases.length, pairs: value.cases.reduce((sum, item) => sum + (item.candidateIds?.length ?? 100), 0) })), budget: await budget.snapshot() });
  if (prepareOnly) { for (const board of boards.values()) await board.corpus.close(); await database.close(); process.off('SIGTERM', stop); process.off('SIGINT', stop); return receipt; }
  const runLock = path.join(out, 'run.lock');
  // An interrupted lock is kept for an operator to inspect; never start a second paid campaign by guessing it is stale.
  await fs.mkdir(runLock, { mode: 0o700 });
  await write(path.join(runLock, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString(), configPath: path.resolve(configPath), artifactSha256 });

  const host = createServer(finalizers.wrap(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 10 * 1024 * 1024) throw new Error('Host request limit'); }
      const body = JSON.parse(raw);
      if (request.url === '/driver' || request.url === '/lineage' || request.url === '/root-result') {
        assert.equal(request.headers.authorization, `Bearer ${workload}`);
        if (request.url === '/lineage') { children.set(body.sessionId, children.get(body.parent) ?? body.parent); response.end('{}'); return; }
        const state = states.get(body.sessionId); assert.ok(state);
        if (request.url === '/root-result') {
          const value = body.result?.value;
          if (body.result?.isError || value?.ok === false) state.stopReason = 'native_root_tool_failed';
          await persist(state); response.end('{}'); return;
        }
        if (state.calls > 0 && !state.context) state.stopReason = 'native_context_not_created';
        if (cancelled) state.stopReason = 'campaign_interrupted';
        const plan = campaignStep(state);
        if (plan.tool && !body.tools?.includes(plan.tool)) { state.stopReason = 'native_tool_unavailable'; delete plan.tool; delete plan.args; }
        if (!plan.tool) { state.ended = true; state.status = state.result?.rows.every(row => row.current) ? 'complete' : 'partial'; state.endedAt = new Date().toISOString(); }
        else { state.calls++; plan.callId = `campaign-${state.calls}-${randomUUID()}`; }
        await persist(state); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(plan)); return;
      }
      assert.equal(request.url, '/internal/patient-matching/v1/port');
      const invocation = body.invocation, root = children.get(invocation.sessionId) ?? invocation.sessionId, state = states.get(root); assert.ok(state);
      if (invocation.tool === 'match_assess' && body.input.phase === 'prepare') { state.assessmentCallId = invocation.callId; state.nativeSegments++; }
      const replay = Readable.from([Buffer.from(raw)]); Object.assign(replay, { method: request.method, url: request.url, headers: request.headers });
      const captured = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); }, end(chunk) { this.body = String(chunk ?? ''); } };
      await dispatchCampaignGateway(boards.get(state.board).gateway, replay, captured, finalizers.signal);
      const answer = JSON.parse(captured.body);
      if (captured.statusCode >= 400) await fs.appendFile(path.join(out, 'host-errors.jsonl'), JSON.stringify({ patientId: state.case.patientId, port: body.port, operation: body.operation, answer }) + '\n', { mode: 0o600 });
      if (body.port === 'PatientDataPort' && body.operation === 'context' && answer.status === 'complete') {
        state.context = answer.data;
        if (state.board === 'sigir' && !state.discovery) {
          // The public judged-pair protocol supplies every candidate; a durable selection receipt
          // avoids carrying >100 ids through a bounded native tool argument without dropping any.
          const board = boards.get(state.board), origin = { userId: OWNER, projectId: PROJECT, rootSessionId: root };
          const study = await board.vcr.store.taskContext(origin, { create: false });
          const candidates = [], views = [];
          for (const registryId of state.case.candidateIds) {
            const preserved = await board.vcr.service.runtimeRead(study, 'trial_registry_record', { registry: 'clinicaltrials.gov', registryId, collection: board.corpus.id, collectionRevision: board.corpus.revision }, { ownerView: true });
            assert.ok(preserved?.available !== false && preserved?.record, 'Frozen SIGIR candidate is absent from the authorized corpus');
            const view = patientMatchingRankingDocument({ ...preserved.record, eligibility: preserved.record.eligibilityText }); views.push(view);
            candidates.push({ registryId, text: view.text });
          }
          const ranked = await board.models.rerank({ scope: patientMatchingScope(origin), origin, signal: finalizers.signal, input: { taskId: state.context.taskId, query: state.case.note, candidates } });
          const order = ranked.data?.order;
          assert.ok(Array.isArray(order) && order.length === state.case.candidateIds.length && new Set(order).size === order.length && order.every(id => state.case.candidateIds.includes(id)), 'Main ranker must preserve the entire frozen judged pool');
          const rerank = { ...ranked.data, state: ranked.status, applied: ranked.status === 'complete', incomingOrder: state.case.candidateIds, finalOrder: order,
            view: { profile: MATCHING_RANKING_VIEW, truncated: views.filter(view => view.truncated).length, fullRecordsUnavailable: [] } };
          const searchId = await board.vcr.candidateSearches.save(study, { subjectKey: state.context.subjectKey, request: { protocol: 'trialgpt-judged-pair-ranking', candidateIdsDigest: contentDigest(JSON.stringify(state.case.candidateIds)) },
            registries: [], rerank, collection: { id: board.corpus.id, revision: board.corpus.revision }, found: state.case.candidateIds.length,
            items: order.map(registryId => ({ registryId, registry: 'clinicaltrials.gov' })) });
          state.discovery = { searchId, source: 'frozen-public-judged-pair-input', candidateCount: state.case.candidateIds.length, rerank };
        }
      }
      if (body.port === 'RegistryPort' && body.operation === 'search') {
        if (answer.status === 'complete' && answer.data.searchId) {
          state.discovery = answer.data;
          const board = boards.get(state.board), fullIds = answer.data.candidates.map(row => row.registryId);
          if (board.definition.clinicalDepth) {
            const study = await board.vcr.store.taskContext({ userId: OWNER, projectId: PROJECT, rootSessionId: root }, { create: false });
            state.clinicalSelection = await freezeClinicalSubset({ searches: board.vcr.candidateSearches, study, subjectKey: state.context.subjectKey, discovery: answer.data, depth: board.definition.clinicalDepth });
            state.case.retrievedCandidateIds = fullIds; state.case.retrievedCandidateCount = fullIds.length;
            state.case.clinicalDepthRequested = board.definition.clinicalDepth;
            state.case.candidateIds = state.clinicalSelection.registryIds;
          } else state.case.candidateIds = fullIds;
          state.case.candidateCount = state.case.candidateIds.length;
        }
        else state.stopReason = 'discovery_failed';
      }
      if (body.port === 'ExecutionPort' && body.operation === 'assess' && answer.data?.kind === 'prepared') {
        state.expectedRows = answer.data.remaining; state.prepared = { executionId: answer.data.executionId, pairs: answer.data.task.selectedPairs.length };
        await write(path.join(stateDir, `${state.case.patientId}-prepared-${state.nativeSegments}.json`), answer.data);
      }
      if (body.port === 'ResultPort' && body.operation === 'save' && answer.data?.rows) {
        validateMatchingResult(answer.data); state.result = answer.data; state.lastSavedSegment = state.nativeSegments;
        await write(path.join(stateDir, `${state.case.patientId}-saved-${answer.data.revision}.json`), answer.data);
      }
      if (body.port === 'ExecutionPort' && body.operation === 'assess' && answer.data?.kind === 'saved-result') state.result = answer.data.result;
      if (invocation.sessionId === root && (captured.statusCode >= 400 || ['failed', 'unsupported', 'cancelled'].includes(answer.status))) state.stopReason = answer.data?.code ?? `host_${captured.statusCode}_${answer.status}`;
      state.lastHostOperation = { port: body.port, operation: body.operation, phase: body.input.phase ?? null, status: answer.status, httpStatus: captured.statusCode };
      await persist(state); response.writeHead(captured.statusCode, captured.headers); response.end(captured.body);
    } catch (error) { errors.push({ stage: 'host', code: error.code ?? error.name }); response.writeHead(500); response.end(JSON.stringify({ code: 'campaign_host_failed' })); }
  }));
  const proxy = createServer(finalizers.wrap(async (request, response) => {
    const at = Date.now(); let reservation = null, dispatched = false, state, id;
    try {
      assert.equal(request.headers['x-api-key'], workload); assert.equal(request.url, '/anthropic/v1/messages');
      const sessionId = String(request.headers['x-deepseek-harness-session-id'] ?? ''), root = children.get(sessionId); state = states.get(root); assert.ok(state, 'Only an authorized native clinical child may call Flash');
      let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 10 * 1024 * 1024) throw new Error('Provider request limit'); }
      const body = JSON.parse(raw); assert.equal(body.model, 'deepseek-flash');
      const structuredTool = (body.tools ?? []).find(tool => tool.name === 'structured_output');
      const wireSchema = JSON.stringify(structuredTool?.input_schema ?? {});
      const priorityContractVisible = /Optional recommendation priority from 0 to 1 inclusive/.test(wireSchema);
      const formalIdsVisible = /Provided formal IDs:/.test(wireSchema), registryDemographicsGuidanceVisible = /formal criteria AND the trial profile demographics/.test(wireSchema), computationReceiptGuidanceVisible = /Computed requires a successful match_compute receipt/.test(wireSchema);
      if (configured.allowProviderCalls !== true) throw Object.assign(new Error('Unpaid native transport check'), { code: 'campaign_paid_calls_disabled' });
      finalizers.signal.throwIfAborted();
      await checkBalance();
      body.max_tokens = Math.min(Number(body.max_tokens ?? 16000), 16000);
      const estimate = priceUsage({ resourceType: 'model', model: body.model, cacheMiss: Buffer.byteLength(JSON.stringify(body)), output: body.max_tokens, peak: true }); assert.ok(estimate.priced);
      id = randomUUID(); reservation = await ledger.reserveModel({ id, userId: OWNER, projectId: PROJECT, runId: null, sessionId, purpose: 'kernel', module: 'patient-matching', operation: 'native-flash', taskId: state.context.taskId,
        model: body.model, priceVersion: REFERENCE_PRICE_LIST.version, currency: estimate.currency, estimatedCost: estimate.cost, requestFingerprint: hash(JSON.stringify(body)), dailyLimit: 500, weeklyLimit: 500 });
      await fs.appendFile(path.join(out, 'provider-admissions.jsonl'), JSON.stringify({ id, patientId: state.case.patientId, sessionId, priorityContractVisible, formalIdsVisible, registryDemographicsGuidanceVisible, computationReceiptGuidanceVisible, requestedMaxTokens: body.max_tokens }) + '\n', { mode: 0o600 });
      const directory = await fs.mkdtemp(path.join(out, 'provider-private-'));
      try {
        const input = path.join(directory, 'request.json'), curl = path.join(directory, 'curl.conf'), output = path.join(directory, 'response'), headers = path.join(directory, 'headers');
        await write(input, body);
        const endpoint = new URL(providers.deepseek.messages_endpoint ?? '/anthropic/v1/messages', providers.deepseek.endpoint ?? 'https://api.deepseek.com');
        assert.equal(endpoint.protocol, 'https:'); assert.equal(endpoint.username, ''); assert.equal(endpoint.password, '');
        let options = `url = ${JSON.stringify(endpoint.href)}\nrequest = "POST"\nsilent\nshow-error\nconnect-timeout = 10\nmax-time = 240\nheader = "content-type: application/json"\nheader = "anthropic-version: 2023-06-01"\nheader = ${JSON.stringify('x-api-key: ' + deepseekKey)}\ndata-binary = ${JSON.stringify('@' + input)}\noutput = ${JSON.stringify(output)}\ndump-header = ${JSON.stringify(headers)}\n`;
        if (providers.deepseek.proxy) options += `proxy = ${JSON.stringify(providers.deepseek.proxy)}\n`;
        await fs.writeFile(curl, options, { mode: 0o600 });
        finalizers.signal.throwIfAborted();
        dispatched = true;
        const { stdout } = await runCampaignCurl(curl, { signal: finalizers.signal });
        const status = Number(stdout.trim()), bytes = await fs.readFile(output), invoice = campaignMessagesInvoice(bytes, new Date(at)), { usage, servedModel } = invoice;
        if (status === 200 && usage && invoice.validModel && invoice.finished) {
          await ledger.settleModel(OWNER, id, { actualCost: invoice.price.cost, priced: invoice.price.priced, usage, providerRequestId: invoice.id }); reservation = null;
        } else { await closeUnsettledReservation(ledger, OWNER, id, { dispatched: true, status, estimatedCost: estimate.cost }); reservation = null; }
        const providerReceipt = { id, patientId: state.case.patientId, sessionId, status, servedModel, usage, priorityContractVisible, formalIdsVisible, registryDemographicsGuidanceVisible, computationReceiptGuidanceVisible, finished: invoice.finished, costCny: status === 200 && invoice.validModel && invoice.finished ? invoice.price?.cost ?? null : null, durationMs: Date.now() - at };
        providerCalls.push(providerReceipt); await fs.appendFile(path.join(out, 'provider-calls.jsonl'), JSON.stringify(providerReceipt) + '\n', { mode: 0o600 });
        await fs.writeFile(path.join(stateDir, `${state.case.patientId}-${id}.sse`), bytes, { mode: 0o600 });
        if (status === 200 && !invoice.validModel) { state.stopReason = 'provider_model_identity_mismatch'; throw Object.assign(new Error('Provider model identity differs'), { code: 'provider_model_identity_mismatch' }); }
        if (status === 200 && !invoice.finished) { state.stopReason = 'provider_stream_incomplete'; throw Object.assign(new Error('Provider stream did not finish'), { code: 'provider_stream_incomplete' }); }
        if (status !== 200) state.stopReason = `provider_http_${status}`;
        response.writeHead(status, { 'content-type': 'text/event-stream' }); response.end(bytes);
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    } catch (error) {
      if (reservation) await closeUnsettledReservation(ledger, OWNER, id, { dispatched, status: 0, estimatedCost: reservation.reservedCost ?? reservation.estimatedCost }).catch(finalizerError => errors.push({ stage: 'provider-billing-finalizer', code: finalizerError.code ?? finalizerError.name, reservationId: id }));
      if (state) state.stopReason = error.code ?? 'provider_failed'; errors.push({ stage: 'provider', code: error.code ?? error.name });
      response.writeHead(502, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'error', error: { type: 'campaign_provider_failed', message: 'The bounded campaign request could not complete.' } }));
    }
  }));
  const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
  try {
    const hostUrl = await listen(host), proxyUrl = await listen(proxy), runtime = path.dirname(fileURLToPath(import.meta.url)), native = path.join(out, 'native');
    await fs.mkdir(native, { recursive: true, mode: 0o700 });
    const tokenFile = path.join(native, 'host-token'), readyFile = path.join(native, 'ready.json'); await fs.writeFile(tokenFile, hostToken, { mode: 0o600 }); await fs.rm(readyFile, { force: true });
    const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, { HOME: path.join(native, 'home'), DSH_HOME: path.join(native, 'dsh'), DSH_TELEMETRY: '0', EVIMED_PATIENT_MATCHING_ENABLED: '1', EVIMED_PATIENT_MATCHING_HOST_ENDPOINT: hostUrl + '/internal/patient-matching/v1/port', EVIMED_PATIENT_MATCHING_TOKEN_FILE: tokenFile,
      MATCHING_CAMPAIGN_PROXY: proxyUrl + '/anthropic', MATCHING_CAMPAIGN_WORKLOAD: workload, MATCHING_CAMPAIGN_HOST: hostUrl, MATCHING_CAMPAIGN_EVENTS: path.join(native, 'events.jsonl'), MATCHING_CAMPAIGN_READY: readyFile });
    await fs.mkdir(env.HOME, { recursive: true }); const workspace = path.join(native, 'workspace'); await fs.mkdir(workspace, { recursive: true });
    const patch = path.join(native, 'campaign.patch.yml');
    await fs.writeFile(patch, `- id: agent-default-model\n  config:\n    provider: campaign-root\n    model: campaign-root\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- id: llm-retry\n  disabled: true\n- id: session-title-llm\n  disabled: true\n- insert:\n    - id: matching-campaign-runtime\n      name: '${path.join(runtime, 'campaign-runtime.mjs')}'\n`);
    const command = args => { const result = spawnSync(configured.dsh, args, { env: { ...env, PATH: configured.setupPath ?? env.PATH, HOME: process.env.HOME }, cwd: workspace, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 }); if (result.status !== 0) throw new Error('Native profile setup failed'); return result.stdout; };
    const installed = path.join(native, 'installed.json');
    try { assert.equal(JSON.parse(await fs.readFile(installed, 'utf8')).artifactSha256, artifactSha256); }
    catch (error) { if (error.code !== 'ENOENT') throw error; command(['--profile', 'matching-campaign', '--from-default-profile', 'web', '--dump-config']); command(['plugin', '--profile', 'matching-campaign', 'add', artifact, '--offline', '--ignore-scripts']); await write(installed, { artifactSha256 }); }
    kernel = spawn(configured.dsh, ['--profile', 'matching-campaign', '--patch', patch, '--no-open', '--port', '0'], { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = chunk => fs.appendFile(path.join(native, 'kernel.log'), String(chunk).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]'), { mode: 0o600 }).catch(() => {}); kernel.stdout.on('data', log); kernel.stderr.on('data', log);
    let ready;
    for (let attempt = 0; attempt < 300; attempt++) { try { ready = JSON.parse(await fs.readFile(readyFile, 'utf8')); break; } catch { if (kernel.exitCode !== null) throw new Error('Native kernel exited before readiness'); await delay(200); } }
    assert.ok(ready, 'Native kernel readiness deadline exceeded');
    const pending = [...states.values()].filter(state => !state.ended && !state.stopReason && (!selectedBoards || selectedBoards.includes(state.board))).slice(0, maximumTopics);
    let cursor = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (!finalizers.signal.aborted && cursor < pending.length) {
        const state = pending[cursor++], resume = Boolean(state.startedAt); state.startedAt ??= new Date().toISOString(); state.status = 'running'; await persist(state);
        const response = await fetch(ready.endpoint + '/run', { method: 'POST', headers: { authorization: `Bearer ${workload}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: state.sessionId, resume }) });
        if (!response.ok) { state.stopReason = 'native_session_admission_failed'; state.ended = true; state.status = 'partial'; await persist(state); continue; }
        const deadline = Date.now() + 2 * 60 * 60 * 1000;
        while (!state.ended && !finalizers.signal.aborted && Date.now() < deadline && kernel.exitCode === null) await delay(1000);
        if (!state.ended) { state.stopReason ??= cancelled ? 'campaign_interrupted' : 'native_topic_deadline'; state.status = 'partial'; await persist(state); }
        process.stdout.write(JSON.stringify({ kind: 'native-topic', patientId: state.case.patientId, status: state.status, current: state.result?.counts, segments: state.nativeSegments }) + '\n');
      }
    }));
  } finally {
    if (kernel && kernel.exitCode === null) { kernel.kill('SIGTERM'); const force = setTimeout(() => kernel.kill('SIGKILL'), 5000); await once(kernel, 'exit'); clearTimeout(force); }
    await new Promise(resolve => host.close(resolve)); await new Promise(resolve => proxy.close(resolve));
    await finalizers.drain({ abort: cancelled });
    receipt.durationMs = Date.now() - startedAt; receipt.status = [...states.values()].every(state => state.status === 'complete') ? 'complete' : 'partial';
    receipt.topics = [...states.values()].map(state => ({ patientId: state.case.patientId, board: state.board, status: state.status, stopReason: state.stopReason, candidateCount: state.case.candidateIds?.length ?? null, current: state.result?.counts, startedAt: state.startedAt, endedAt: state.endedAt }));
    receipt.sourceRepairs = [...states.values()].filter(state => state.sourceRepair).map(state => ({ patientId: state.case.patientId, ...state.sourceRepair }));
    receipt.errors = errors; receipt.budget = await budget.snapshot(); await write(path.join(out, 'receipt.json'), receipt);
    await fs.writeFile(path.join(out, 'saved-results.jsonl'), [...states.values()].filter(state => state.result).map(state => JSON.stringify(state.result)).join('\n') + '\n', { mode: 0o600 });
    for (const board of boards.values()) await board.corpus.close();
    await database.close(); process.off('SIGTERM', stop); process.off('SIGINT', stop);
    await fs.rm(runLock, { recursive: true });
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'prepare-only': { type: 'boolean' }, 'maximum-topics': { type: 'string' }, boards: { type: 'string' } } });
  if (!values.config) throw new Error('--config is required');
  await runCampaign({ configPath: values.config, prepareOnly: values['prepare-only'], maximumTopics: Number(values['maximum-topics'] ?? Infinity), selectedBoards: values.boards?.split(',') ?? null });
}
