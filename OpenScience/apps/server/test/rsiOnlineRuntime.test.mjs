import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PLATFORM_PUBLISHER_USER_ID } from '@evimed/domain';
import { createRsiAuthorizedTranscriptReader, createRsiBundlePoller, createRsiOnlineRuntime, createRsiSourceInvalidation, rsiIncidentRunEligible } from '../src/rsiOnlineRuntime.mjs';
import { HttpError } from '../src/security.mjs';
import { createRsiOnlineWorker } from '../src/rsiOnlineWorker.mjs';
import { rsiOnlineConfigurationIssues } from '../src/rsiOnlineConfiguration.mjs';
import { PRODUCT_JOB_KINDS } from '../src/productPersistence.mjs';

const source = { userId: 'researcher', projectId: 'research', sourceRunId: 'run-1', sourceRevision: 'a'.repeat(64), authorizationId: 'agreement-1' };
function fixture(options = {}) {
  const project = { userId: source.userId, id: source.projectId };
  const run = { id: source.sourceRunId, sessionId: 'session-1', transcript: { sha256: source.sourceRevision } };
  const calls = [];
  const reader = createRsiAuthorizedTranscriptReader({
    store: { userById: async id => options.deleted ? null : { id }, requireProject: async user => { assert.equal(user.id, source.userId); if (options.denied) throw new Error('denied'); return project; } },
    agentRuns: { list: async () => [run] }, agreementId: source.authorizationId,
    authority: { authorizeIncident: async () => options.revoked !== true },
    assertModelAccess: async (caller, body) => { calls.push({ caller, body }); if (options.clinicalDenied) throw new Error('clinical denied'); },
    readTranscript: async () => { if (options.digestFailed) throw new Error('digest'); return { header: { completeness: 'complete' }, messages: [
      { sessionId: 'child', seq: 1, role: 'assistant', parts: [{ type: 'text', text: 'child private' }] },
      { sessionId: 'session-1', seq: 2, role: 'user', source: 'user', parts: [{ type: 'text', text: 'Expected a table.' }] },
      { sessionId: 'session-1', seq: 3, role: 'assistant', parts: [{ type: 'text', text: 'Actual prose.' }] },
      { sessionId: 'session-1', seq: 4, role: 'tool', parts: [{ type: 'text', text: 'tool private' }] },
    ] }; },
  });
  return { reader, calls };
}
test('source rights, canonical digest and live agreement fail closed without archive fallback', async () => {
  for (const option of ['deleted', 'denied', 'revoked', 'digestFailed']) assert.equal(await fixture({ [option]: true }).reader(source), null, option);
  assert.equal(await fixture().reader({ ...source, sourceRevision: 'b'.repeat(64) }), null);
  assert.equal(await fixture().reader({ ...source, authorizationId: 'client-assertion' }), null);
});
test('only verified root prose is offered, with stable identities and source clinical egress scope', async () => {
  const { reader, calls } = fixture();
  const result = await reader(source);
  assert.deepEqual(result.messages.map(row => row.id), ['run-1:2', 'run-1:3']);
  assert.deepEqual(calls[0].caller, { userId: 'researcher', projectId: 'research', runId: 'run-1', sessionId: 'session-1' });
  assert.equal(await fixture({ clinicalDenied: true }).reader(source), null);
});
test('normal and automated conversations do not become incident exports', () => {
  assert.equal(rsiIncidentRunEligible({ status: 'delivered' }), false);
  assert.equal(rsiIncidentRunEligible({ status: 'failed', automated: true }), false);
  assert.equal(rsiIncidentRunEligible({ status: 'failed' }), true);
  assert.equal(rsiIncidentRunEligible({ status: 'delivered', qualityNotices: [{ code: 'run_tool_failed' }] }), true);
});
test('unbound runtime never requires a publisher account or provisions its project', async () => {
  const runtime = await createRsiOnlineRuntime({ config: {}, store: { userById: () => assert.fail('publisher lookup') },
    documents: {}, jobs: {}, database: {}, agentRuns: {}, servingAdapters: null });
  assert.equal(runtime.configured(), false);
  await runtime.worker.close();
});
test('unconfigured online worker never claims, extracts, imports or touches transport', async () => {
  const worker = createRsiOnlineWorker({ configured: () => false, jobs: { claim: () => assert.fail('claimed') }, incidents: { processPending: () => assert.fail('extracted') }, pollBundles: () => assert.fail('imported'), owner: 'publisher' });
  assert.equal(await worker.tick(), null);
  await worker.close();
  assert.ok(rsiOnlineConfigurationIssues(null).length);
});
test('maintenance admission is checked both before and inside the online queue claim', async () => {
  let allowed = false, claimed = 0;
  const worker = createRsiOnlineWorker({ configured: () => true, canRun: async () => allowed, owner: 'publisher',
    jobs: { claim: async (_kinds, _id, options) => { claimed++; assert.equal(await options.admission({}), allowed); return null; } } });
  await worker.tick(); assert.equal(claimed, 0);
  allowed = true; await worker.tick(); assert.equal(claimed, 1);
  await worker.close();
});
test('production server composes only serving evolution and declares dedicated online queues', async () => {
  const code = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /import\s*\{\s*createEvolution\s*\}|evolution\.model\(|evolution\.loops|evolution\.budgeted\(|evolution\.runtimeSession/);
  assert.match(code, /createEvolutionServing\(/);
  assert.ok(PRODUCT_JOB_KINDS.includes('rsi-incident-export'));
  assert.ok(PRODUCT_JOB_KINDS.includes('rsi-bundle-poll'));
});

function memoryDocuments() {
  const rows = new Map();
  return { rows,
    get: async (u, k, id) => rows.get(`${u}:${id}`) ?? null,
    put: async (u, k, id, payload, o) => { const key = `${u}:${id}`, old = rows.get(key); if ((old?.revision ?? 0) !== o.expectedRevision) throw Object.assign(new Error('conflict'), { code: 'product_revision_conflict' }); const row = { id, revision: (old?.revision ?? 0) + 1, payload: structuredClone(payload), ownerId: u }; rows.set(key, row); return row; },
    list: async (u, k, o) => ({ items: [...rows.values()].filter(row => row.ownerId === u && Object.entries(o.filter ?? {}).every(([field, value]) => row.payload[field] === value)), nextCursor: null }) };
}
function memoryJobs() {
  const jobs = [];
  return { jobs,
    enqueue: async (userId, kind, payload, o) => {
      const existing = jobs.find(job => job.userId === userId && job.idempotencyKey === o.idempotencyKey);
      if (existing) { if (JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw Object.assign(new Error('conflict'), { code: 'product_job_idempotency_conflict' }); if (o.rearmFailed && existing.status === 'failed') existing.status = 'queued'; return existing; }
      const job = { id: `job-${jobs.length + 1}`, userId, kind, payload: structuredClone(payload), idempotencyKey: o.idempotencyKey, status: 'queued', leaseToken: null }; jobs.push(job); return job;
    },
    claim: async (kinds, _worker, o) => { const job = jobs.find(row => row.status === 'queued' && kinds.includes(row.kind) && (!o.ownerId || row.userId === o.ownerId)); if (!job) return null; job.status = 'running'; job.leaseToken = 'lease'; return job; },
    renew: async () => true,
    finish: async (_u, id, _lease, result) => { const job = jobs.find(row => row.id === id); job.status = 'succeeded'; job.result = result; return job; },
    fail: async (_u, id, _lease, error, o = {}) => { const job = jobs.find(row => row.id === id); job.status = o.retry ? 'queued' : 'failed'; job.error = error; job.options = o; return job; } };
}

test('a run that cannot prove its own turn in a shared session offers nothing, never the earlier turns', async () => {
  const earlier = { id: 'run-0', sessionId: 'session-1', createdAt: '2026-10-25T00:00:00Z', transcript: { sha256: 'b'.repeat(64) } };
  const reader = run => createRsiAuthorizedTranscriptReader({ agreementId: source.authorizationId, authority: { authorizeIncident: async () => true },
    store: { userById: async id => ({ id }), requireProject: async () => ({ userId: source.userId, id: source.projectId }) }, agentRuns: { list: async () => [earlier, run] },
    readTranscript: async () => ({ header: { completeness: 'complete' }, messages: [
      { sessionId: 'session-1', seq: 1, role: 'user', source: 'user', turnStartSeq: 1, parts: [{ type: 'text', text: 'Earlier private turn.' }] },
      { sessionId: 'session-1', seq: 2, role: 'assistant', turnStartSeq: 1, parts: [{ type: 'text', text: 'Earlier private answer.' }] },
      { sessionId: 'session-1', seq: 3, role: 'user', source: 'user', turnStartSeq: 3, parts: [{ type: 'text', text: 'Expected a table.' }] },
      { sessionId: 'session-1', seq: 4, role: 'assistant', turnStartSeq: 3, parts: [{ type: 'text', text: 'Actual prose.' }] },
    ] }) });
  const unproven = { id: source.sourceRunId, sessionId: 'session-1', createdAt: '2026-10-26T00:00:00Z', transcript: { sha256: source.sourceRevision } };
  assert.equal(await reader(unproven)(source), null);
  assert.deepEqual((await reader({ ...unproven, nativeTurn: { startSeq: 3 } })(source)).messages.map(row => row.id), ['run-1:3', 'run-1:4']);
});

function pollerFixture() {
  const documents = memoryDocuments(), jobs = memoryJobs(), reads = [], said = [];
  const keys = ['a', 'b', 'c', 'd'].map(ch => `rsi/v1/bundles/${ch.repeat(64)}.json`).concat('rsi/v1/bundles/not-a-digest.json');
  const outcomes = {
    a: () => { throw new HttpError(409, 'campaign_replay_or_surface_busy', 'Campaign activation refused.'); },
    b: () => ({ state: 'rejected', issues: ['campaign_signature_invalid'] }),
    c: () => { throw new Error('connection reset'); },
    d: () => ({ state: 'exposed' }),
  };
  const transport = { listBundles: async cursor => ({ keys, cursor: cursor ? null : 'page-2' }), readBundle: async digest => { reads.push(digest[0]); return { bytes: Buffer.from(JSON.stringify({ k: digest[0] })) }; } };
  const poller = createRsiBundlePoller({ transport, importer: { importBundle: async envelope => outcomes[envelope.k]() }, documents, owner: 'publisher', jobs, jobOwner: 'publisher', projectId: 'evidence', configured: () => true, report: code => said.push(code) });
  const intake = ch => documents.rows.get(`publisher:rsi-bundle-intake-${ch.repeat(64)}`)?.payload;
  return { poller, jobs, reads, said, intake };
}
test('one refused or conflicting bundle never holds the queue, a decided key is never read again, and the poll chain cannot fork', async () => {
  const f = pollerFixture();
  assert.deepEqual((await f.poller.poll({}, { id: 'job-1' })).outcomes, { rejected: 2, retrying: 1, imported: 1, ignored: 1 });
  assert.deepEqual([f.intake('a').state, f.intake('a').reason, f.intake('a').digest, f.intake('a').objectKey], ['rejected', 'campaign_replay_or_surface_busy', 'a'.repeat(64), `rsi/v1/bundles/${'a'.repeat(64)}.json`]);
  assert.deepEqual([f.intake('b').state, f.intake('b').reason], ['rejected', 'campaign_signature_invalid']);
  assert.deepEqual([f.intake('c').state, f.intake('c').lastCode, f.intake('c').attempts], ['retrying', 'campaign_import_failed', 1]);
  assert.equal(f.intake('d').state, 'imported');
  assert.deepEqual(f.jobs.jobs.map(job => [job.idempotencyKey, job.payload]), [['rsi-bundle-poll:after:job-1', { cursor: 'page-2' }]], 'the next page is queued although items failed');
  // A re-run of the same job names the same successor.
  await f.poller.poll({}, { id: 'job-1' });
  assert.equal(f.jobs.jobs.length, 1);
  f.reads.length = 0;
  await f.poller.poll({ cursor: 'page-2' }, { id: 'job-2' });
  assert.deepEqual(f.reads, ['c'], 'decided keys are skipped without reading their bytes');
  assert.deepEqual([f.intake('c').state, f.intake('c').reason, f.intake('c').attempts], ['rejected', 'campaign_import_retry_exhausted', 3]);
  assert.deepEqual(f.jobs.jobs.at(-1).payload, {});
  f.reads.length = 0;
  await f.poller.poll({}, { id: 'job-3' });
  assert.deepEqual(f.reads, []);
  assert.ok(f.said.includes('rsi_online_bundle_key_invalid'));
});

test('a permanent extraction failure ends its job instead of retrying and paying the model again', async () => {
  for (const failure of [async () => { throw new Error('rsi_incident_quote_mismatch'); }, async () => ({ payload: { status: 'not-exportable', failureCode: 'rsi_incident_sensitive_material' } })]) {
    const jobs = memoryJobs(); let attempts = 0;
    await jobs.enqueue('publisher', 'rsi-incident-export', { id: 'incident' }, { idempotencyKey: 'incident' });
    const worker = createRsiOnlineWorker({ jobs, owner: 'publisher', configured: () => true, incidents: { processPending: async () => { attempts++; return failure(); } }, pollBundles: async () => ({}) });
    await worker.tick(); await worker.tick();
    assert.equal(attempts, 1);
    assert.equal(jobs.jobs[0].status, 'failed');
    assert.match(jobs.jobs[0].error.code, /^rsi_incident_(quote_mismatch|sensitive_material)$/);
    await worker.close();
  }
  const jobs = memoryJobs(); let attempts = 0;
  await jobs.enqueue('publisher', 'rsi-incident-export', { id: 'incident' }, { idempotencyKey: 'incident' });
  const worker = createRsiOnlineWorker({ jobs, owner: 'publisher', configured: () => true, incidents: { processPending: async () => { attempts++; throw new Error('connection reset'); } }, pollBundles: async () => ({}) });
  await worker.tick(); await worker.tick();
  assert.equal(attempts, 2);
  assert.equal(jobs.jobs[0].status, 'queued', 'a transient failure still retries');
  await worker.close();
});
test('the worker hands the poll its own job, and runs a deferred source invalidation from its job', async () => {
  const jobs = memoryJobs(), seen = [];
  await jobs.enqueue('publisher', 'rsi-bundle-poll', {}, { idempotencyKey: 'poll' });
  await jobs.enqueue('publisher', 'rsi-incident-export', { invalidateSource: { userId: 'researcher' } }, { idempotencyKey: 'invalidate' });
  const worker = createRsiOnlineWorker({ jobs, owner: 'publisher', configured: () => true, pollBundles: async (payload, job) => { seen.push(['poll', job.id]); return {}; },
    incidents: { processPending: () => assert.fail('not an incident id'), invalidateSource: async input => { seen.push(['invalidate', input.userId]); return { invalidated: [] }; } } });
  await worker.tick(); await worker.tick();
  assert.deepEqual(seen, [['poll', 'job-1'], ['invalidate', 'researcher']]);
  assert.deepEqual(jobs.jobs.map(job => job.status), ['succeeded', 'succeeded']);
  await worker.close();
});

test('without the deployment file nothing is created: no publisher, transport, importer, poll, query or timer', async () => {
  let connected = false;
  const servingAdapters = { publicationOwnerId: 'publisher', connectImporter: () => { connected = true; }, setObservationReporter: () => assert.fail('reporter'), currentTarget: () => assert.fail('target'), adapters: {} };
  const runtime = await createRsiOnlineRuntime({ config: {}, servingAdapters, agentRuns: {}, transportFactory: () => assert.fail('cloud client'),
    store: { userById: () => assert.fail('publisher lookup'), requireProject: () => assert.fail('project') },
    documents: memoryDocuments(), jobs: { enqueue: () => assert.fail('job'), claim: () => assert.fail('claim') }, database: { query: () => assert.fail('query'), transaction: () => assert.fail('transaction') } });
  assert.equal(runtime.importer, null);
  assert.equal(connected, false);
  assert.deepEqual([runtime.configured(), runtime.canWithdraw()], [false, false]);
  runtime.worker.start();
  assert.equal(await runtime.worker.tick(), null);
  assert.deepEqual(await runtime.invalidateSource({ userId: 'researcher' }), { invalidated: [] });
  await runtime.worker.close();
});

test('a valid transport alone publishes withdrawals, and a removed agreement withdraws what was exported under it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rsi-withdraw-'));
  try {
    const file = path.join(dir, 'online.json');
    // The trust and evaluator bindings are gone and the agreement file was removed: no new export or import may run.
    await writeFile(file, JSON.stringify({ schemaVersion: 1, agreementRef: path.join(dir, 'agreement.json'), trustedKeyRefs: [], extractionDailyCny: 1,
      transport: { role: 'production', region: 'cn-beijing', endpoint: 'https://oss-cn-beijing.aliyuncs.com', incidentBucket: 'fixture-incidents', bundleBucket: 'fixture-bundles', identityRefs: { production: '/run/prod', lab: '/run/lab' } } }), { mode: 0o600 });
    const documents = memoryDocuments(), jobs = memoryJobs(), uploads = [], said = [];
    const id = 'rsi-incident-exported';
    await documents.put(PLATFORM_PUBLISHER_USER_ID, 'knowledge', id, { recordType: 'rsi-incident-export', userId: 'researcher', projectId: 'research', sourceRunId: 'run', sourceRevision: 'a'.repeat(64), authorizationId: 'rsi-agreement-old', status: 'exported', exportedDigest: 'b'.repeat(64) }, { expectedRevision: 0 });
    let transportConfig = null;
    const runtime = await createRsiOnlineRuntime({ config: { rsiOnlineConfigFile: file }, documents, jobs, database: {}, agentRuns: { list: () => assert.fail('no source read for a withdrawal') }, servingAdapters: null,
      store: { userById: async userId => ({ id: userId }), requireProject: async (user, projectId) => ({ userId: user.id, id: projectId }) }, report: code => said.push(code),
      transportFactory: async value => { transportConfig = value; return { available: true, headObject: async () => null, putObject: async input => { uploads.push(input); return { digest: input.digest }; } }; } });
    assert.equal(transportConfig.incidentBucket, 'fixture-incidents');
    assert.deepEqual([runtime.canWithdraw(), runtime.configured()], [true, false]);
    assert.ok(said.includes('rsi_deployment_agreement_unavailable'));
    await runtime.worker.tick();
    assert.equal(documents.rows.get(`${PLATFORM_PUBLISHER_USER_ID}:${id}`).payload.status, 'withdrawn');
    assert.deepEqual(uploads.map(input => [input.kind, input.generation, JSON.parse(input.serializedBody).type]), [['withdrawal', 2, 'withdrawal']]);
    assert.equal(await runtime.sweepAgreement(), null, 'reconciled once per agreement change');
    await runtime.worker.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failing RSI layer never fails a source deletion: the invalidation is retried from a durable job', async () => {
  const jobs = memoryJobs(), said = [];
  const hook = createRsiSourceInvalidation({ initialize: async () => { throw new Error('initialization failed'); }, jobs: () => jobs, report: code => said.push(code) });
  assert.deepEqual(await hook({ userId: 'researcher', projectId: 'research' }), { deferred: true });
  assert.deepEqual(await hook({ userId: 'researcher', projectId: 'research' }), { deferred: true });
  assert.deepEqual(jobs.jobs.map(job => [job.userId, job.kind, job.payload]), [[PLATFORM_PUBLISHER_USER_ID, 'rsi-incident-export', { invalidateSource: { userId: 'researcher', projectId: 'research' } }]]);
  const unrecordable = createRsiSourceInvalidation({ initialize: async () => ({ invalidateSource: async () => { throw new Error('database unavailable'); } }), jobs: { enqueue: async () => { throw new Error('database unavailable'); } }, report: code => said.push(code) });
  assert.equal(await unrecordable({ userId: 'researcher' }), null);
  assert.deepEqual(said, ['rsi_source_invalidation_failed', 'rsi_source_invalidation_failed', 'rsi_source_invalidation_failed', 'rsi_source_invalidation_retry_unrecorded']);
  const healthy = createRsiSourceInvalidation({ initialize: async () => ({ invalidateSource: async input => ({ invalidated: [input.userId] }) }), jobs: () => assert.fail('no retry needed') });
  assert.deepEqual(await healthy({ userId: 'researcher' }), { invalidated: ['researcher'] });
});
