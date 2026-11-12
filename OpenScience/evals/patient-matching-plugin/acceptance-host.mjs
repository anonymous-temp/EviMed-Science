/** Native non-TREC acceptance host. Labels and expected verdicts are never admitted. */
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
import { ProductDocuments } from '../../apps/server/src/productStore.mjs';
import { composeVcr } from '../../apps/server/src/vcrComposition.mjs';
import { createVcrTrialCorpus } from '../../apps/server/src/vcrTrialCorpus.mjs';
import { createVcrPatientContext } from '../../apps/server/src/vcrPatientContext.mjs';
import { createPatientMatchingHostAdapter } from '../../apps/server/src/patientMatchingHostAdapter.mjs';
import { createPatientMatchingGatewayHandler } from '../../apps/server/src/patientMatchingGateway.mjs';
import { acceptanceStep, assertAcceptanceCase } from './acceptance-inputs.mjs';
import { campaignMessagesInvoice, campaignLedger, createCampaignReadGate } from './campaign-host.mjs';
import { acceptanceModelProfile, acceptanceSourceIdentity, verifyAcceptanceSources } from './acceptance-source.mjs';
import { priceUsage, REFERENCE_PRICE_LIST } from '../../packages/domain/index.mjs';
import { validateMatchingResult, contentDigest } from '../../packages/patient-matching-core/index.mjs';
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
export async function runAcceptance({ configPath, prepareOnly = false, maximumTopics = Infinity, selectedBoards = null }) {
  const configured = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (!prepareOnly) assert.notEqual(configured.executionStatus, 'user-skipped', 'The owner stopped evaluation; do not execute this prepared campaign');
  assert.ok(Number.isFinite(configured.localLimitCny) && configured.localLimitCny > 0 && configured.localLimitCny <= 40, 'The local acceptance ceiling cannot exceed the authorized CNY 40');
  const out = path.resolve(configured.out), stateDir = path.join(out, 'topics');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const artifact = path.resolve(configured.artifact), artifactSha256 = hash(await fs.readFile(artifact));
  assert.equal(artifactSha256, configured.artifactSha256, 'Unqualified plugin artifact');
  const sourceIdentity = await verifyAcceptanceSources(configured);
  const source = JSON.parse(await fs.readFile(configured.postgresConfig, 'utf8'));
  const database = new ControlPlaneDatabase({ ...source, databasePoolMax: 16, databaseConnectionTimeoutMs: 10000 });
  const sharedBudget = createCampaignBudget({ path: configured.campaignBudget, limitCny: 500 });
  const localBudget = createCampaignBudget({ path: path.join(out, 'acceptance-budget.json'), limitCny: configured.localLimitCny });
  const budget = {
    async reserve(input) { await localBudget.reserve(input); try { return await sharedBudget.reserve(input); } catch (error) { await localBudget.settle({ id: input.id, costCny: 0 }); throw error; } },
    async settle(input) { await sharedBudget.settle(input); await localBudget.settle(input); },
    async snapshot() { return { shared: await sharedBudget.snapshot(), acceptance: await localBudget.snapshot() }; },
  };
  const ledger = campaignLedger(new UsageLedger(database), budget, configured.allowProviderCalls === true);
  await ledger.health();
  const providers = JSON.parse(await fs.readFile(configured.providerConfig, 'utf8'));
  const deepseekKey = (await fs.readFile(providers.deepseek.key_file, 'utf8')).trim();
  const workload = randomBytes(32).toString('hex'), hostToken = randomBytes(32).toString('hex');
  const states = new Map(), children = new Map(), boards = new Map(), errors = [], providerCalls = [];
  const generation = `campaign-${artifactSha256}`, startedAt = Date.now();
  const persist = async state => write(path.join(stateDir, `${state.case.patientId}.json`), state);
  let kernel;
  const cancellation = { requested: false };
  let checkedBalanceAt = 0, balanceCheck = null;
  const checkBalance = async () => {
    if (Date.now() - checkedBalanceAt < 5 * 60 * 1000) return;
    balanceCheck ??= (async () => {
      const result = await exec(configured.python ?? 'python3', ['-I', '-B', fileURLToPath(new URL('../vcr-matching-boards/budget.py', import.meta.url)), '--key-file', providers.deepseek.key_file, '--floor', '200', '--require-off-peak'], { timeout: 30000, maxBuffer: 16384 });
      await fs.appendFile(path.join(out, 'balance-checks.jsonl'), JSON.stringify({ at: new Date().toISOString(), result: result.stdout.trim() }) + '\n', { mode: 0o600 }); checkedBalanceAt = Date.now();
    })().finally(() => { balanceCheck = null; });
    return balanceCheck;
  };
  const stop = () => { cancellation.requested = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  for (const [board, definition] of Object.entries(configured.boards)) {
    assert.ok(['incidents', 'criterion', 'n2c2'].includes(board), 'Only non-TREC acceptance boards are admitted');
    const bytes = await fs.readFile(definition.cases), cases = bytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(contentDigest(bytes), definition.casesDigest, 'Requested topics changed');
    const collectionBytes = await fs.readFile(definition.collection);
    assert.equal(contentDigest(collectionBytes), definition.collectionDigest, 'Frozen collection manifest changed');
    const protocolText = definition.protocolPath ? await fs.readFile(definition.protocolPath, 'utf8') : null;
    if (protocolText) assert.equal(contentDigest(protocolText), definition.protocolDigest, 'Original guide protocol changed');
    const config = { vcrEnabled: true, vcrAudience: 'all', vcrProviderAgreements: true, vcrDataPlaneDir: path.join(out, 'data-plane', board),
      vcrTrialCorpusManifest: definition.collection, vcrMatchRerankEnabled: true, vcrMatchRerankIntakeMax: 100,
      requireDurableUsageLedger: true, production: true, userDailySpendLimit: 500, userWeeklySpendLimit: 500,
      deepseekBaseUrl: 'https://api.deepseek.com' };
    config.patientMatchingProfile = acceptanceModelProfile();
    const sourceModelIdentity = acceptanceSourceIdentity({ artifactSha256, definition, sourceIdentity, harnessSourcesDigest: configured.harnessSourcesDigest });
    const vcr = composeVcr({ config, productDatabase: database }); await vcr.store.ready();
    const sourceRead = createCampaignReadGate(8);
    for (const operation of ['registryRecord', 'judgmentRecord']) {
      const original = vcr.evidence[operation].bind(vcr.evidence);
      vcr.evidence[operation] = (...args) => sourceRead(() => original(...args));
    }
    const corpus = createVcrTrialCorpus(definition.collection, { timeoutMs: 60000 });
    const runtimeRead = vcr.service.runtimeRead.bind(vcr.service);
    // The existing production source reader receives each complete original note.
    vcr.service.runtimeRead = async (study, what, filter, options) => {
      if (what !== 'candidates') return runtimeRead(study, what, filter, options);
      await vcr.access.require({ actor: OWNER, studyId: study.id, ability: 'read_patient_level' });
      return corpus.collect({ condition: filter.condition, terms: [], summary: null, age: null, sex: null, region: null, scope: 'any', limit: 100 });
    };
    vcr.patientContext = createVcrPatientContext({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, documents: vcr.documents, subjectKnown: vcr.subjectKnown,
      transcript: async origin => ({ sessionId: origin.rootSessionId, messages: [{ seq: 1, role: 'user', source: 'user', parts: [{ type: 'text', text: states.get(origin.rootSessionId).case.note }] },
        ...(protocolText ? [{ seq: 2, role: 'user', source: 'user', parts: [{ type: 'text', text: protocolText }] }] : [])] }), isHumanMessage: async () => true });
    const adapter = createPatientMatchingHostAdapter({ vcr, documents: new ProductDocuments(database), config });
    const gateway = createPatientMatchingGatewayHandler(config, { assertActiveModelGatewayToken(token) { assert.equal(token, hostToken); return { userId: OWNER, projectId: PROJECT }; } }, {
      vcr, adapter, resolveInvocation: async (_identity, body) => {
        const invocation = body.invocation, root = children.get(invocation.sessionId) ?? invocation.sessionId, state = states.get(root);
        assert.ok(state, 'An original topic session must own every invocation');
        return { userId: OWNER, projectId: PROJECT, rootSessionId: root, runId: `native-${state.case.patientId}`, callId: invocation.callId,
          rootCallId: root === invocation.sessionId ? invocation.callId : state.assessmentCallId, pluginGeneration: generation, tool: invocation.tool, args: invocation.args, child: root !== invocation.sessionId };
      }, report: code => errors.push({ stage: 'gateway', code }) });
    boards.set(board, { cases, vcr, adapter, gateway, corpus, definition });
    for (const row of cases) {
      assertAcceptanceCase(row);
      const sessionId = `campaign-${configured.sessionNamespace}-${row.patientId.toLowerCase()}`;
      let state;
      try { state = JSON.parse(await fs.readFile(path.join(stateDir, `${row.patientId}.json`), 'utf8')); assert.equal(state.sourceModelIdentity, sourceModelIdentity); assert.equal(state.artifactSha256, artifactSha256); assert.equal(state.inputDigest, contentDigest(JSON.stringify(row))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; state = { board, case: row, inputDigest: contentDigest(JSON.stringify(row)), sourceModelIdentity, sessionId, artifactSha256, calls: 0, nativeSegments: 0, status: 'pending' }; }
      if (protocolText) state.protocolText = protocolText;
      states.set(sessionId, state);
    }
  }
  const receipt = { kind: 'native-matching-non-trec-acceptance', artifactSha256, generation, sourceIdentity, concurrency: 2, sourceReadConcurrencyPerBoard: 8, maxCostCny: 500,
    casesRequested: states.size, providerRetryCount: 0, scope: 'Pinned native plugin and production PostgreSQL HostAdapter reference host; SaaS UI/customer acceptance and clinical validation are separate.' };
  receipt.depths = Object.fromEntries([...boards].map(([board]) => [board, { mainRanking: 'input-order-no-ranker', fullClinical: 'all-supplied-pairs' }]));
  await write(path.join(out, 'preflight.json'), { ...receipt, boards: [...boards].map(([board, value]) => ({ board, cases: value.cases.length, pairs: value.cases.reduce((sum, item) => sum + item.candidateCount, 0) })), budget: await budget.snapshot() });
  if (prepareOnly) { for (const board of boards.values()) await board.corpus.close(); await database.close(); process.off('SIGTERM', stop); process.off('SIGINT', stop); return receipt; }
  const runLock = path.join(out, 'run.lock');
  // An interrupted lock is kept for an operator to inspect; never start a second paid campaign by guessing it is stale.
  await fs.mkdir(runLock, { mode: 0o700 });
  await write(path.join(runLock, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString(), configPath: path.resolve(configPath), artifactSha256 });

  const host = createServer(async (request, response) => {
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
        if (cancellation.requested) state.stopReason = 'campaign_interrupted';
        const plan = acceptanceStep(state);
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
      await boards.get(state.board).gateway(replay, captured);
      const answer = JSON.parse(captured.body);
      if (captured.statusCode >= 400) await fs.appendFile(path.join(out, 'host-errors.jsonl'), JSON.stringify({ patientId: state.case.patientId, port: body.port, operation: body.operation, answer }) + '\n', { mode: 0o600 });
      if (body.port === 'PatientDataPort' && body.operation === 'context' && answer.status === 'complete') {
        if (body.input.messageSeq === 2) state.protocol = answer.data;
        else state.context = answer.data;
        if (state.board !== 'n2c2' && !state.discovery) {
          // Persist the supplied candidate selection without retrieval, ranking, or labels.
          const board = boards.get(state.board), origin = { userId: OWNER, projectId: PROJECT, rootSessionId: root };
          const study = await board.vcr.store.taskContext(origin, { create: false });
          const order = state.case.candidateIds;
          const rerank = { state: 'not-requested', applied: false, incomingOrder: order, finalOrder: order };
          const searchId = await board.vcr.candidateSearches.save(study, { subjectKey: state.context.subjectKey, request: { protocol: 'native-non-trec-acceptance', candidateIdsDigest: contentDigest(JSON.stringify(state.case.candidateIds)) },
            registries: [], rerank, collection: { id: board.corpus.id, revision: board.corpus.revision }, found: state.case.candidateIds.length,
            items: order.map(registryId => ({ registryId, registry: 'clinicaltrials.gov' })) });
          state.discovery = { searchId, source: 'frozen-label-free-acceptance-input', candidateCount: state.case.candidateIds.length, rerank };
        }
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
  });
  const proxy = createServer(async (request, response) => {
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
        await fs.writeFile(curl, options, { mode: 0o600 }); dispatched = true;
        const { stdout } = await exec('curl', ['--config', curl, '--write-out', '%{http_code}'], { timeout: 250000, maxBuffer: 1024 * 1024 });
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
      if (reservation) await closeUnsettledReservation(ledger, OWNER, id, { dispatched, status: 0, estimatedCost: reservation.reservedCost ?? reservation.estimatedCost }).catch(() => {});
      if (state) state.stopReason = error.code ?? 'provider_failed'; errors.push({ stage: 'provider', code: error.code ?? error.name });
      response.writeHead(502, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'error', error: { type: 'campaign_provider_failed', message: 'The bounded campaign request could not complete.' } }));
    }
  });
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
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (!cancellation.requested && cursor < pending.length) {
        const state = pending[cursor++]; assert.ok(!state.startedAt, 'Acceptance cases run once; preserve a partial result instead of resampling'); const resume = false; state.startedAt ??= new Date().toISOString(); state.status = 'running'; await persist(state);
        const response = await fetch(ready.endpoint + '/run', { method: 'POST', headers: { authorization: `Bearer ${workload}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: state.sessionId, resume }) });
        if (!response.ok) { state.stopReason = 'native_session_admission_failed'; state.ended = true; state.status = 'partial'; await persist(state); continue; }
        const deadline = Date.now() + 2 * 60 * 60 * 1000;
        while (!state.ended && !cancellation.requested && Date.now() < deadline && kernel.exitCode === null) await delay(1000);
        if (!state.ended) { state.stopReason ??= cancellation.requested ? 'campaign_interrupted' : 'native_topic_deadline'; state.status = 'partial'; await persist(state); }
        process.stdout.write(JSON.stringify({ kind: 'native-topic', patientId: state.case.patientId, status: state.status, current: state.result?.counts, segments: state.nativeSegments }) + '\n');
      }
    }));
  } finally {
    if (kernel && kernel.exitCode === null) { kernel.kill('SIGTERM'); const force = setTimeout(() => kernel.kill('SIGKILL'), 5000); await once(kernel, 'exit'); clearTimeout(force); }
    await new Promise(resolve => host.close(resolve)); await new Promise(resolve => proxy.close(resolve));
    receipt.durationMs = Date.now() - startedAt; receipt.status = [...states.values()].every(state => state.status === 'complete') ? 'complete' : 'partial';
    receipt.topics = [...states.values()].map(state => ({ patientId: state.case.patientId, board: state.board, status: state.status, stopReason: state.stopReason, candidateCount: state.case.candidateCount, current: state.result?.counts, startedAt: state.startedAt, endedAt: state.endedAt }));
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
  await runAcceptance({ configPath: values.config, prepareOnly: values['prepare-only'], maximumTopics: Number(values['maximum-topics'] ?? Infinity), selectedBoards: values.boards?.split(',') ?? null });
}
