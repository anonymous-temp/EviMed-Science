import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createModelGatewayHandler } from '../../../apps/server/src/modelGateway.mjs';
import { createAssessmentRuntimeProbes, runFinancialCapRefusal, runFiniteConcurrentRefusal, finishOutboundObservation, hasUnconfirmedCleanup } from '../extension-assessment-runtime-probes.mjs';
// These are explicit controlled-boundary tests, not hosted qualification or actual DB/provider bills.
const sha = value => createHash('sha256').update(value).digest('hex');
const config = () => ({ production: false, learningEnabled: false, reviewEnabled: false, deepseekApiKey: 'provider-test-canary', deepseekBaseUrl: 'https://api.deepseek.com', deepseekModel: 'deepseek-v4-flash', modelGatewaySigningSecret: 'test-model-signing-secret-32-bytes', evimedWorkloadSigningSecret: 'test-workload-secret-32-bytes', bootstrapPassword: 'test-bootstrap-password', modelGatewayMaxBodyBytes: 65536, modelGatewayMaxResponseBytes: 1048576, modelGatewayTimeoutMs: 2000, modelGatewayReservationMaxOutputTokens: 4096, userDailySpendLimit: 2, userWeeklySpendLimit: 5, requireDurableUsageLedger: true });
const fault = (status, code, message = 'controlled refusal') => Object.assign(new Error(message), { status, code });
async function output(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-runtime-probe-control-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
async function listen(t, handler) { const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })); return 'http://127.0.0.1:' + server.address().port; }
async function financial(t, mode = {}) {
    const out = await output(t), cfg = config(), actor = { id: 'budget-owner', projectId: 'fresh-owned-project', password: 'account-password-canary', headers: { cookie: 'session-cookie-canary', 'x-open-science-csrf': 'csrf-canary' } }, project = { id: actor.projectId, userId: actor.id };
    const metrics = { reserve: 0, upstream: 0, release: 0, cancel: 0, stop: 0, observed: 0 };
    const ledger = { async reserveModel(input) { metrics.reserve++; if (mode.upstream)
            return { id: input.id }; throw Object.assign(fault(mode.otherError ? 503 : 402, mode.otherError ? 'product_state_unavailable' : 'usage_budget_exceeded'), {details:{window:mode.wrongWindow?'week':'day',limit:input.dailyLimit,committed:0,requested:input.estimatedCost}}); }, async settleModel() { }, async markUncertain() { }, async release() { } };
    const originalReserve = ledger.reserveModel, probes = createAssessmentRuntimeProbes({ config: cfg, env: {}, fetchImpl: async () => { metrics.upstream++; return new Response('{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}', { headers: { 'content-type': 'application/json' } }); } });
    const runtimes = new Map(), manager = { runtimes, key: () => actor.projectId, runtimeGeneration: () => 'budget-generation', async stop(_project, options) { metrics.stop++; assert.equal(options.expectedGeneration, 'budget-generation'); assert.equal(options.guard(), true); if (mode.stopFailure)
            throw new Error('stop failed'); runtimes.delete(actor.projectId); return true; }, assertActiveModelGatewayToken() { return { userId: mode.wrongActor ? 'other' : actor.id, projectId: actor.projectId }; } };
    const app = { config: cfg, usageLedger: ledger, runtimeManager: manager, store: { database: { async query() { return { rows: [] }; } }, async userById(id) { return { id }; }, async requireProject() { return project; } } };
    probes.bind(app);
    const gateway = await listen(t, createModelGatewayHandler(cfg, manager, { usageLedger: ledger, fetchImpl: probes.overrides.modelGatewayFetch }));
    const nativeFactory = async () => { runtimes.set(actor.projectId, { id: 'known-new-runtime' }); if (mode.acquireFailure)
        throw new Error('acquire failed'); return { sessionId: 'budget-session', async selectModel() { if (mode.selectFailure)
            throw new Error('select failed'); }, async prompt() { if (mode.beforeGateway)
            throw new Error('transport before gateway'); const response = await fetch(gateway + '/internal/model/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer runtime', 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Harmless public text' }] }) }); metrics.status = response.status; await response.text(); return { terminal: !mode.pending, requestId: 'budget-request' }; }, async cancel() { metrics.cancel++; }, async release() { metrics.release++; if (mode.releaseFailure)
            throw new Error('release failed'); } }; };
    const run = () => runFinancialCapRefusal({ owned: { record: { qualified: false }, app }, probes, actor, nativeFactory, base: gateway, out, observe: async () => { metrics.observed++; } });
    t.after(() => { try {
        probes.close();
    }
    catch { /* Failed-control cleanup is already recorded by the phase. */ } });
    return { run, metrics, app, cfg, probes, ledger, originalReserve, runtimes, out };
}
test('financial phase uses the real local HTTP gateway: 402 reservation refusal and zero original upstream calls', async (t) => { const c = await financial(t); const result = await c.run(); assert.equal(c.metrics.status, 402); assert.equal(c.metrics.upstream, 0); assert.equal(c.metrics.reserve, 1); assert.equal(c.metrics.release, 1); assert.equal(c.metrics.stop, 1); assert.equal(c.metrics.observed, 1); assert.equal(result.qualified, false); assert.equal(c.cfg.userDailySpendLimit, 2); assert.equal(c.runtimes.size, 0); c.probes.close(); assert.equal(c.ledger.reserveModel, c.originalReserve); const saved = JSON.parse(await fs.readFile(path.join(c.out, 'financial-cap.json'), 'utf8')); assert.equal(saved.state, 'refused-before-upstream'); assert.equal(saved.frameReleaseConfirmed, true); });
for (const mode of ['beforeGateway', 'otherError', 'wrongActor', 'upstream', 'pending','wrongWindow'])
    test('financial phase rejects ' + mode + ' attribution and restores configuration/known frame/runtime', async (t) => { const c = await financial(t, { [mode]: true }); await assert.rejects(c.run()); assert.equal(c.metrics.observed, 0); assert.equal(c.metrics.release, 1); assert.equal(c.metrics.stop, 1); assert.equal(c.cfg.userDailySpendLimit, 2); assert.equal(c.cfg.requireDurableUsageLedger, true); assert.equal(c.runtimes.size, 0); });
test('financial phase preserves primary plus release and exact runtime cleanup failures', async (t) => { const c = await financial(t, { beforeGateway: true, releaseFailure: true, stopFailure: true }); await assert.rejects(c.run(), error => { assert.equal(error.cleanupUnconfirmed, true); assert.deepEqual(error.errors.map(x => x.message), ['transport before gateway', 'release failed', 'stop failed']); return true; }); assert.equal(c.metrics.observed, 0); assert.equal(c.cfg.userDailySpendLimit, 2); const saved = JSON.parse(await fs.readFile(path.join(c.out, 'financial-cap.json'), 'utf8')); assert.equal(saved.frameReleaseConfirmed, false); assert.equal(saved.ownedPhaseRuntimeStopped, false); });
for (const mode of ['acquireFailure', 'selectFailure'])
    test('financial ' + mode + ' cleans only the newly known runtime without any gateway request', async (t) => { const c = await financial(t, { [mode]: true }); await assert.rejects(c.run()); assert.equal(c.metrics.reserve, 0); assert.equal(c.metrics.stop, 1); assert.equal(c.metrics.release, mode === 'selectFailure' ? 1 : 0); assert.equal(c.runtimes.size, 0); });
test('outbound observer preserves exact original arguments, return/error and writes only safe hashes/counts', async (t) => { const out = await output(t), cfg = config(), calls = [], sentinel = fault(503, 'unknown', 'must-not-persist-message'), response = new Response('ok'); const original = async (input, init) => { calls.push([input, init]); if (calls.length === 2)
    throw sentinel; return response; }; const probes = createAssessmentRuntimeProbes({ config: cfg, env: {}, fetchImpl: original }), originalReserve = async (input) => ({ id: input.id }), ledger = { reserveModel: originalReserve }; probes.bind({ usageLedger: ledger }); probes.registerSecrets(['private-cookie', 'private-password']); probes.begin('safe-outbound'); const init = { method: 'POST', body: 'public input', headers: { 'content-type': 'text/plain' } }, url = 'https://public.example/path?public-keyword'; assert.equal(await probes.overrides.publicSourceFetch(url, init), response); assert.equal(calls[0][0], url); assert.equal(calls[0][1], init); await assert.rejects(probes.overrides.documentParserFetch(url, init), error => error === sentinel); const report = await finishOutboundObservation({ probes, out }); const bytes = await fs.readFile(path.join(out, 'outbound-telemetry.json'), 'utf8'); for (const secret of ['private-cookie', 'private-password', 'public input', 'must-not-persist-message', cfg.deepseekApiKey, cfg.modelGatewaySigningSecret])
    assert.equal(bytes.includes(secret), false); assert.equal(report.telemetry.records.length, 2); assert.equal(calls.length, 2); probes.close(); assert.equal(ledger.reserveModel, originalReserve); });
test('model observation correlates exact reserved body and permits provider Authorization only at configured origin', async (t) => { const out = await output(t), cfg = config(), body = 'public model input', ledger = { reserveModel: async () => ({ id: 'r' }) }, probes = createAssessmentRuntimeProbes({ config: cfg, env: {}, fetchImpl: async () => new Response('ok') }); probes.bind({ usageLedger: ledger }); probes.begin('model'); await ledger.reserveModel({ id: 'r', userId: 'owner', projectId: 'project', purpose: 'kernel', requestFingerprint: sha(body), estimatedCost: 1, dailyLimit: 2 }); await probes.overrides.modelGatewayFetch(cfg.deepseekBaseUrl + '/chat/completions', { method: 'POST', body, headers: { authorization: 'Bearer ' + cfg.deepseekApiKey } }); const report = await finishOutboundObservation({ probes, out }); assert.equal(report.telemetry.records[0].scope.actorId, 'owner'); assert.equal(report.telemetry.records[0].headers[0].providerKeyMatches, 0); probes.close(); });
test('unmatched model body cannot invent actor attribution', async (t) => { const out = await output(t), cfg = config(), probes = createAssessmentRuntimeProbes({ config: cfg, env: {}, fetchImpl: async () => new Response('ok') }); probes.begin('model'); await probes.overrides.modelGatewayFetch(cfg.deepseekBaseUrl + '/chat/completions', { method: 'POST', body: 'public input', headers: { authorization: 'Bearer ' + cfg.deepseekApiKey } }); await assert.rejects(finishOutboundObservation({ probes, out }), /guessed model actor/); probes.close(); });
for (const kind of ['secret-body', 'provider-body', 'wrong-provider-header', 'truncated'])
    test('outbound observer preserves evidence but rejects ' + kind, async (t) => { const out = await output(t), cfg = config(), probes = createAssessmentRuntimeProbes({ config: cfg, env: {}, maxRecords: kind === 'truncated' ? 1 : 2048, fetchImpl: async () => new Response('ok') }); probes.begin('unsafe'); await probes.overrides.publicSourceFetch('https://public.example', { method: 'POST', body: kind === 'secret-body' ? cfg.bootstrapPassword : kind === 'provider-body' ? cfg.deepseekApiKey : 'public', headers: kind === 'wrong-provider-header' ? { authorization: cfg.deepseekApiKey } : undefined }); if (kind === 'truncated')
        await probes.overrides.publicSourceFetch('https://public.example'); await assert.rejects(finishOutboundObservation({ probes, out })); const text = await fs.readFile(path.join(out, 'outbound-telemetry.json'), 'utf8'); assert.equal(text.includes(cfg.bootstrapPassword), false); assert.equal(text.includes(cfg.deepseekApiKey), false); assert.equal(JSON.parse(text).state, 'incomplete-preserved'); probes.close(); });
test('original pinned web transport still refuses loopback and never falls through to generic fetch', async () => { let calls = 0; const probes = createAssessmentRuntimeProbes({ config: config(), env: {}, fetchImpl: async () => { calls++; return new Response('bypass'); } }); probes.begin('pinned'); await assert.rejects(probes.overrides.webReadTransport({ url: new URL('http://127.0.0.1/private'), headers: {}, maxBytes: 1024, signal: new AbortController().signal })); assert.equal(calls, 0); assert.ok(probes.end().records[0].error); probes.close(); });
async function concurrency(t, mode = {}) {
    const out = await output(t), actors = [{ id: 'first', projectId: 'one' }, { id: 'second', projectId: 'two' }], metrics = { originalSubmit: 0, cancel: 0, observed: 0, settlingCalls: [], nativeCancels: [] }, identity = { jobId: 'real-shape-job', ownerId: 'first', runtimeGeneration: 'generation-one' }, containerId = 'a'.repeat(64), source = Buffer.from('completed public workbook');
    let armed, joined = false, payloadRelease, payloadStarted, callbackPromise;
    const payloadBarrier = new Promise(resolve => { payloadStarted = resolve; });
    const auth = { userId: 'first', projectId: 'one', runtimeGeneration: 'generation-one' }, client = { async query() { return { rows: [{ total: mode.zeroCount ? 0 : 1, owned: 0 }] }; } }, query = client.query;
    const tools = { maxConcurrent: 2, active: new Map(), async admissionAvailable() { return !armed; } };
    const operations = { maxPending: 8, maxUserPending: 2, admission: new AsyncLocalStorage(), async withAdmission(scope, work, settling = false) { metrics.settlingCalls.push(settling); return this.admission.run({ client }, work); }, async submit(_requestAuth, _input) { metrics.originalSubmit++; if (mode.unrelatedAuth)
            throw fault(403, 'extension_access_denied'); return this.withAdmission({}, async () => { const count = (await this.admission.getStore().client.query("SELECT count(*)::int AS total FROM evimed_product.jobs WHERE kind='extension-execute'")).rows[0]; if (count.total >= this.maxPending)
            throw fault(503, 'product_state_unavailable'); return { jobId: 'unexpected-new-job' }; }); }, async cancel(received, id) { metrics.cancel++; assert.equal(received, auth); assert.equal(id, identity.jobId); if (mode.cancelFailure)
            throw new Error('cancel failed'); joined = true; } };
    const original = { submit: operations.submit, withAdmission: operations.withAdmission };
    const database = { async query(sql) { if (sql.startsWith('SELECT payload')) { if(mode.inflightClosing){payloadStarted();await new Promise(resolve=>{payloadRelease=resolve;});} return { rows: [{ payload: { scope: { userId: 'first', projectId: 'one' }, auth } }] }; } return { rows: [] }; } };
    const checkpoint = () => ({ attempts: [{ ...identity, containerId, stalled: true, physicallyAbsent: joined, joined, settledReceipt: joined }], jobs: [{ jobId: identity.jobId, status: joined ? 'failed' : 'running', leaseHeld: !joined }], otherObservation: { observedWhileRunning: true } });
    const physical = { armStalledNativeWrite(options) { armed = options; }, async checkpoint() { return checkpoint(); } };
    const natives = [{ sessionId: 'session-one', async cancel(){metrics.nativeCancels.push('first');}, async prompt() { if(mode.inflightClosing){callbackPromise=armed.onRunning({identity,containerId,observedRunning:true});callbackPromise.catch(()=>{});await payloadBarrier;throw new Error('first snapshot failed during physical callback');} if(mode.firstEarlyFailure)throw new Error('first snapshot failed before physical callback'); try {
                await operations.withAdmission({}, async () => {}, true);
                await armed.onRunning({ identity, containerId, observedRunning: true });
            }
            finally {
                if (!mode.needsCancel && !mode.cancelFailure)
                    joined = true;
            } return { terminal: true, requestId: 'first-request' }; } }, { sessionId: 'session-two', async cancel(){metrics.nativeCancels.push('second');}, async snapshot() { return { actual: 'ready' }; }, async prompt() { metrics.secondPromptCalls=(metrics.secondPromptCalls??0)+1; if (mode.beforeSubmit)
                throw new Error('transport before submit'); const request = { operation: 'doc_write', targetId: 'finite_concurrent_excess_xlsx', format: 'xlsx', spec: { kind: 'create', sheets: [{ name: 'Public', cells: [{ ref: 'A1', value: 'Public' }] }] } }, invocation = { sessionId: 'session-two', callId: 'second-call', rootCallId: 'second-call', agentId: 'session-two', toolName: 'doc_write', runtimeGeneration: 'generation-two' }; try {
                await operations.submit({ userId: mode.wrongActor ? 'foreign' : 'second', projectId: 'two', runtimeGeneration: 'generation-two', invocation: JSON.stringify(invocation) }, { request });
            }
            catch { /* Native returns actual tool refusal shape. */ } return { terminal: !mode.secondPending, requestId: 'second-request', tools: [{ tool: 'doc_write', input: request, callId: 'second-call', status: 'error' }] }; } }];
    const run = () => runFiniteConcurrentRefusal({ owned: { app: { hostedExtensions: { operations }, store: { database } }, assessment: { composition: { tools } } }, physical, natives, actors, out, observe: async () => { metrics.observed++; }, inspectRunning: async (_actor, id) => ({ containerId: id ?? 'b'.repeat(64), running: !mode.nonoverlap }), downloadOriginal: async () => mode.changedOutput ? Buffer.from('changed') : source, originalSHA256: sha(source) });
    const restored = () => { assert.equal(operations.submit, original.submit); assert.equal(operations.withAdmission, original.withAdmission); assert.equal(operations.maxPending, 8); assert.equal(operations.maxUserPending, 2); assert.equal(tools.maxConcurrent, 2); assert.equal(client.query, query); };
    return { run, metrics, restored, out, lateSubmit:()=>operations.submit({userId:'second',projectId:'two'}, {request:{targetId:'late-valid-target'}}), lateCallback:()=>armed.onRunning({identity,containerId,observedRunning:true}), resumeCallback:()=>{payloadRelease();return callbackPromise;} };
}
test('finite concurrent control requires actual count refusal while first observed running, same child joined and original output unchanged', async (t) => { const c = await concurrency(t); const report = await c.run(); assert.equal(c.metrics.originalSubmit, 1); assert.equal(c.metrics.observed, 1); assert.equal(report.facts[0].count.total, 1); assert.equal(report.facts[0].firstStillRunning, true); assert.equal(report.cleanupConfirmed, true); assert.deepEqual(c.metrics.settlingCalls, [true,false]); c.restored(); });
for (const mode of ['beforeSubmit', 'unrelatedAuth', 'zeroCount', 'wrongActor', 'nonoverlap', 'changedOutput'])
    test('concurrent control rejects ' + mode + ' and restores existing methods/settings', async (t) => { const c = await concurrency(t, { [mode]: true }); await assert.rejects(c.run()); assert.equal(c.metrics.observed, 0); c.restored(); });
test('concurrent primary failure explicitly cancels only known original job and confirms join before restoration success', async (t) => { const c = await concurrency(t, { beforeSubmit: true, needsCancel: true }); await assert.rejects(c.run(), error=>error.cleanupUnconfirmed&&error.errors[0].message==='transport before submit'); assert.equal(c.metrics.cancel, 1); c.restored(); const saved = JSON.parse(await fs.readFile(path.join(c.out, 'concurrent-cap.json'), 'utf8')); assert.equal(saved.firstChildJoined, true); assert.equal(saved.cleanupConfirmed, false); });
test('concurrent primary and exact cancellation failure both survive, with cleanup unconfirmed and configuration restored', async (t) => { const c = await concurrency(t, { beforeSubmit: true, cancelFailure: true }); await assert.rejects(c.run(), error => { assert.equal(error.cleanupUnconfirmed, true); assert.equal(error.errors[0].message,'transport before submit');assert.equal(error.errors.at(-1).message,'cancel failed');assert.equal(error.errors.filter(row=>row.message.includes('terminal remains unconfirmed')).length,2); return true; }); assert.equal(c.metrics.cancel, 1); c.restored(); const saved = JSON.parse(await fs.readFile(path.join(c.out, 'concurrent-cap.json'), 'utf8')); assert.equal(saved.cleanupConfirmed, false); });

for (const kind of ['query','path','encoded-query','origin','provider-query']) test('outbound URL scanner rejects '+kind+' without persisting it',async t=>{
 const out=await output(t),cfg=config(),canary='sensitive-canary',probes=createAssessmentRuntimeProbes({config:cfg,env:{},fetchImpl:async()=>new Response('ok')});
 probes.registerSecrets([canary]);probes.begin('url-scan');
 const url=kind==='origin'?'https://sensitive-canary.example/public':kind==='path'?'https://public.example/'+canary:kind==='encoded-query'?'https://public.example/?q=%73ensitive-canary':'https://public.example/?q='+(kind==='provider-query'?cfg.deepseekApiKey:canary);
 await probes.overrides.publicSourceFetch(url);await assert.rejects(finishOutboundObservation({probes,out}));
 const bytes=await fs.readFile(path.join(out,'outbound-telemetry.json'),'utf8');assert.equal(bytes.includes(canary),false);assert.equal(bytes.includes(cfg.deepseekApiKey),false);assert.equal(JSON.parse(bytes).knownMatchedFields,1);probes.close();
});
test('FormData string provider key is scanned, binary input stays explicitly partial without consuming it',async t=>{
 const out=await output(t),cfg=config();let received;
 const probes=createAssessmentRuntimeProbes({config:cfg,env:{},fetchImpl:async(_url,init)=>{received=init.body;return new Response('ok');}});
 probes.begin('form-provider');const text=new FormData();text.set('value',cfg.deepseekApiKey);await probes.overrides.documentParserFetch('https://parser.example',{method:'POST',body:text});assert.equal(received,text);await assert.rejects(finishOutboundObservation({probes,out}));
 assert.equal(probes.snapshot().records[0].body.providerKeyMatches,1);
 probes.begin('form-binary');const binary=new FormData();binary.set('file',new Blob(['public bytes']),'public.pdf');await probes.overrides.documentParserFetch('https://parser.example',{method:'POST',body:binary});assert.equal(received,binary);await assert.rejects(finishOutboundObservation({probes,out}),/not scanned/);
 const report=JSON.parse(await fs.readFile(path.join(out,'outbound-telemetry.json'),'utf8'));assert.equal(report.state,'partial-unscanned');assert.equal(report.coverageAccepted,false);assert.equal(report.telemetry.records[0].body.binaryFields,1);probes.close();
});
for(const kind of ['request-body','stream'])test(kind+' is never consumed by observer and remains partial',async t=>{
 const out=await output(t);let received,reads=0;const probes=createAssessmentRuntimeProbes({config:config(),env:{},fetchImpl:async(input,init)=>{received=[input,init];return new Response('ok');}});probes.begin('body');
 const stream=new ReadableStream({pull(){reads++;}},{highWaterMark:0});const input=kind==='request-body'?new Request('https://public.example',{method:'POST',body:'public text'}):'https://public.example';const init=kind==='stream'?{method:'POST',body:stream,duplex:'half'}:undefined;
 await probes.overrides.publicSourceFetch(input,init);assert.equal(received[0],input);assert.equal(received[1],init);assert.equal(reads,0);if(input instanceof Request)assert.equal(input.bodyUsed,false);
 await assert.rejects(finishOutboundObservation({probes,out}));assert.equal(JSON.parse(await fs.readFile(path.join(out,'outbound-telemetry.json'),'utf8')).state,'partial-unscanned');probes.close();
});
test('reservations record only active phase and are bounded; overflow cannot yield complete observation',async t=>{
 const out=await output(t);let calls=0;const ledger={reserveModel:async input=>{calls++;return {id:input.id};}},original=ledger.reserveModel,probes=createAssessmentRuntimeProbes({config:config(),env:{},maxRecords:1,fetchImpl:async()=>new Response('ok')});probes.bind({usageLedger:ledger});
 await ledger.reserveModel({id:'outside'});assert.equal(probes.snapshot().reservations.length,0);probes.begin('bounded');
 await ledger.reserveModel({id:'inside-one'});await ledger.reserveModel({id:'inside-two'});await probes.overrides.publicSourceFetch('https://public.example');assert.equal(calls,3);assert.equal(probes.snapshot().reservations.length,1);assert.equal(probes.snapshot().dropped,1);await assert.rejects(finishOutboundObservation({probes,out}),/Truncated/);probes.close();assert.equal(ledger.reserveModel,original);
});

for(const kind of ['form-field-name','header-name'])test(kind+' canary is scanned without persisting raw names or altering original arguments',async t=>{
 const out=await output(t),canary='sensitive-field-name',cfg=config();let received,calls=0;
 const probes=createAssessmentRuntimeProbes({config:cfg,env:{},fetchImpl:async(_url,init)=>{calls++;received=init;return new Response('ok');}});probes.registerSecrets([canary]);probes.begin('names');
 const form=new FormData();form.set(canary,'public value');const init=kind==='form-field-name'?{method:'POST',body:form}:{headers:{[canary]:'public value'}};
 await probes.overrides.documentParserFetch('https://parser.example',init);assert.equal(received,init);assert.equal(calls,1);await assert.rejects(finishOutboundObservation({probes,out}));
 const bytes=await fs.readFile(path.join(out,'outbound-telemetry.json'),'utf8');assert.equal(bytes.includes(canary),false);assert.equal(JSON.parse(bytes).knownMatchedFields,1);probes.close();
});

test('only phase-started nonterminal native sessions are canceled, ACK is not a physical-join claim',async t=>{
 const c=await concurrency(t,{secondPending:true});await assert.rejects(c.run());assert.deepEqual(c.metrics.nativeCancels,['second','first']);c.restored();
 const report=JSON.parse(await fs.readFile(path.join(c.out,'concurrent-cap.json'),'utf8'));assert.equal(report.firstChildJoined,true);assert.equal(report.cleanupConfirmed,false);assert.ok(report.nativeCancellationRequests.every(row=>row.cancelReturned&&!row.physicalJoinClaimed));assert.equal(c.metrics.observed,0);
});
test('completed phase natives are not canceled',async t=>{const c=await concurrency(t);await c.run();assert.deepEqual(c.metrics.nativeCancels,[]);c.restored();});
test('known actor cookie value alone is a forbidden canary and never enters observation JSON',async t=>{
 const out=await output(t),probes=createAssessmentRuntimeProbes({config:config(),env:{},fetchImpl:async()=>new Response('ok')});probes.registerActorCredentials({password:'actor-password',headers:{cookie:'session=synthetic-sensitive-token; another=another-sensitive-value','x-open-science-csrf':'csrf-token'}});probes.begin('actor-cookie');
 await probes.overrides.publicSourceFetch('https://public.example',{method:'POST',body:'synthetic-sensitive-token'});await assert.rejects(finishOutboundObservation({probes,out}));const text=await fs.readFile(path.join(out,'outbound-telemetry.json'),'utf8');assert.equal(text.includes('synthetic-sensitive-token'),false);assert.equal(JSON.parse(text).knownMatchedFields,1);probes.close();
});

test('early first snapshot failure with returned cancel ACK keeps join unknown and blocks late second-native dispatch',async t=>{
 const c=await concurrency(t,{firstEarlyFailure:true});await assert.rejects(c.run(),error=>{assert.equal(error.cleanupUnconfirmed,true);assert.match(error.errors[0].message,/snapshot failed/);return true;});
 assert.deepEqual(c.metrics.nativeCancels,['first']);await assert.rejects(c.lateCallback(),/Closing phase/);assert.equal(c.metrics.secondPromptCalls??0,0);assert.equal(c.metrics.originalSubmit,0);c.restored();
 const report=JSON.parse(await fs.readFile(path.join(c.out,'concurrent-cap.json'),'utf8'));assert.equal(report.cleanupConfirmed,false);assert.equal(report.nativeCancellationRequests[0].cancelReturned,true);assert.equal(report.nativeCancellationRequests[0].physicalJoinClaimed,false);assert.equal(c.metrics.observed,0);
});

test('callback already awaiting actual payload lookup cannot dispatch when phase closes before lookup returns',async t=>{
 const c=await concurrency(t,{inflightClosing:true});await assert.rejects(c.run(),error=>{assert.equal(error.cleanupUnconfirmed,true);assert.match(error.errors[0].message,/snapshot failed during/);return true;});
 await assert.rejects(c.resumeCallback(),/Closing phase/);assert.equal(c.metrics.secondPromptCalls??0,0);assert.equal(c.metrics.originalSubmit,0);c.restored();assert.equal(c.metrics.observed,0);
});

test('pending phase native cancel ACK and first child join never allow subsequent assessment phases, even if a late original submit could succeed',async t=>{
 const c=await concurrency(t,{secondPending:true});let wouldContinue=true;
 try{await c.run();}catch(error){assert.equal(error.cleanupUnconfirmed,true);assert.equal(error.errors.filter(row=>row.message.includes('terminal remains unconfirmed')).length,2);wouldContinue=!error.cleanupUnconfirmed;}
 assert.equal(wouldContinue,false);c.restored();const report=JSON.parse(await fs.readFile(path.join(c.out,'concurrent-cap.json'),'utf8'));assert.equal(report.firstChildJoined,true);assert.equal(report.cleanupConfirmed,false);assert.ok(report.nativeCancellationRequests.every(row=>row.cancelReturned&&!row.physicalJoinClaimed));
 // The product's original submit behavior was not changed; stopping assessment is not proof that cancel blocked late submission.
 assert.equal((await c.lateSubmit()).jobId,'unexpected-new-job');assert.equal(c.metrics.observed,0);
});

test('private unknown-cleanup flag survives primary plus frame-cleanup AggregateError wrappers without revisiting duplicate/cyclic errors',()=>{
 const primary=Object.assign(new Error('native terminal unknown'),{cleanupUnconfirmed:true}),frame=new Error('frame release failed');const usage=new AggregateError([primary,frame],'usage work and cleanup');const campaign=new AggregateError([usage,frame],'campaign cleanup');assert.equal(hasUnconfirmedCleanup(campaign),true);assert.equal(hasUnconfirmedCleanup(new AggregateError([frame,frame],'known terminal failures')),false);
 const cyclic=new AggregateError([],'cycle');cyclic.errors.push(cyclic);assert.equal(hasUnconfirmedCleanup(cyclic),false);cyclic.errors.push(primary);assert.equal(hasUnconfirmedCleanup(cyclic),true);
});
