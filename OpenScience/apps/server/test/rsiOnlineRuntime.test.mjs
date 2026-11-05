import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PLATFORM_PUBLISHER_USER_ID } from '@evimed/domain';
import { createRsiAuthorizedTranscriptReader, createRsiBundlePoller, createRsiIncidentExtractor, createRsiOnlineRuntime, createRsiSourceInvalidation, rsiIncidentRunEligible } from '../src/rsiOnlineRuntime.mjs';
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
test('production server composes the serving part of evolution and nothing else, and declares dedicated online queues', async () => {
  const code = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  // Owner, 2026-11-04: the online experiment engine and its switch are deleted, so the serving part is the only composition there is.
  assert.match(code, /createEvolutionServing\(/);
  assert.doesNotMatch(code, /composeEvolution\(|createEvolution\(/);
  assert.doesNotMatch(code, /evolution\.model\(|evolution\.loops|evolution\.budgeted\(|evolution\.runtimeSession/);
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
    a: () => { throw new HttpError(409, 'campaign_replayed', 'Campaign activation refused.'); },
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
  assert.deepEqual([f.intake('a').state, f.intake('a').reason, f.intake('a').digest, f.intake('a').objectKey], ['rejected', 'campaign_replayed', 'a'.repeat(64), `rsi/v1/bundles/${'a'.repeat(64)}.json`]);
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

/** A poller over bundles whose unverified payload carries a manifest time, as a signed envelope does. @param {Record<string, string|null>} created */
function orderedPollerFixture(created, importBundle) {
  const documents = memoryDocuments(), jobs = memoryJobs(), reads = [];
  const keys = Object.keys(created).map(ch => `rsi/v1/bundles/${ch.repeat(64)}.json`);
  const transport = { listBundles: async () => ({ keys, cursor: null }),
    readBundle: async digest => { reads.push(digest[0]); return { bytes: Buffer.from(JSON.stringify({ k: digest[0], payload: JSON.stringify({ manifest: created[digest[0]] ? { createdAt: created[digest[0]] } : {} }) })) }; } };
  const poller = createRsiBundlePoller({ transport, importer: { importBundle }, documents, owner: 'publisher', jobs, jobOwner: 'publisher', projectId: 'evidence', configured: () => true });
  return { poller, reads, intake: ch => documents.rows.get(`publisher:rsi-bundle-intake-${ch.repeat(64)}`)?.payload };
}
test('bundles are imported oldest manifest first, whatever their keys sort as, and each bundle is read once', async () => {
  const order = [];
  const f = orderedPollerFixture({ a: '2026-10-26T03:00:00Z', b: '2026-10-26T01:00:00Z', c: null, d: '2026-10-26T02:00:00Z' }, async envelope => { order.push(envelope.k); return { state: 'exposed' }; });
  await f.poller.poll({}, { id: 'job-1' });
  assert.deepEqual(order, ['b', 'd', 'a', 'c'], 'by createdAt; the one with no readable time comes last');
  assert.deepEqual([...f.reads].sort(), ['a', 'b', 'c', 'd'], 'the bytes read to order a page are the bytes imported');
});
test('a surface held by an active campaign makes a bundle wait, uncounted and undecided, while a replayed campaign stays terminal', async () => {
  let busy = true;
  const f = orderedPollerFixture({ a: '2026-10-26T01:00:00Z', b: '2026-10-26T02:00:00Z' }, async envelope => {
    if (envelope.k === 'b') throw new HttpError(409, 'campaign_replayed', 'Campaign activation refused.');
    return busy ? { state: 'waiting', reason: 'campaign_surface_busy' } : { state: 'exposed' };
  });
  for (let poll = 0; poll < 5; poll++) assert.deepEqual((await f.poller.poll({}, { id: `job-${poll}` })).outcomes, { waiting: 1, rejected: 1 }, `poll ${poll}`);
  assert.equal(f.intake('a'), undefined, 'a waiting bundle leaves no decision and spends no attempt, however long it waits (its own expiry ends it)');
  assert.deepEqual([f.intake('b').state, f.intake('b').reason], ['rejected', 'campaign_replayed']);
  busy = false;
  assert.deepEqual((await f.poller.poll({}, { id: 'job-last' })).outcomes, { imported: 1, rejected: 1 });
  assert.equal(f.intake('a').state, 'imported');
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

/** The public records a deployment's trust reads, written as the deployment does: private files. */
async function trustRecords(dir) {
  const pem = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const publisherRef = path.join(dir, 'publisher.json'), evaluatorRef = path.join(dir, 'evaluators.json');
  await writeFile(publisherRef, JSON.stringify({ keyId: 'publisher', publicKey: pem(), surfaces: ['frontier-selection'], kinds: ['policy'] }), { mode: 0o600 });
  await writeFile(evaluatorRef, JSON.stringify({ schemaVersion: 1, version: 1, evaluators: [{ keyId: 'evaluator', publicKey: pem(), surfaces: ['frontier-selection'], procedureDigests: ['a'.repeat(64)], consumerDigests: ['b'.repeat(64)] }] }), { mode: 0o600 });
  return { trustedKeyRefs: [publisherRef], evaluatorRegistryRef: evaluatorRef };
}
const stubServing = () => ({ publicationOwnerId: PLATFORM_PUBLISHER_USER_ID, connectImporter() {}, setObservationReporter() {}, currentTarget: async () => null, adapters: {}, verifyObservation: async () => null });
const stubStore = (touched = () => {}) => ({ userById: async id => { touched(); return { id }; }, requireProject: async (user, projectId) => { touched(); return { userId: user.id, id: projectId }; } });

test('a directory deployment imports on its trust alone: no agreement file, no cloud client, and no incident is offered, extracted or uploaded', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rsi-directory-runtime-'));
  try {
    const bundles = path.join(dir, 'bundles');
    await mkdir(bundles);
    const file = path.join(dir, 'online.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, transport: { kind: 'directory', role: 'production', path: bundles }, ...await trustRecords(dir) }), { mode: 0o600 });
    const documents = memoryDocuments(), jobs = memoryJobs(), said = [];
    let lookups = 0, modelCalls = 0;
    const runtime = await createRsiOnlineRuntime({ config: { rsiOnlineConfigFile: file }, documents, jobs, database: {}, agentRuns: { list: () => assert.fail('no run is read') }, servingAdapters: stubServing(),
      store: stubStore(() => { lookups++; }), report: code => said.push(code), model: async () => { modelCalls++; return {}; } });
    assert.deepEqual([runtime.configured(), runtime.canExport(), runtime.canWithdraw()], [true, false, false]);
    assert.ok(runtime.importer, 'the importer is composed');
    assert.deepEqual(said, [], 'no agreement is missed: this deployment has no use for one');
    assert.deepEqual(jobs.jobs.map(job => [job.kind, job.idempotencyKey]), [['rsi-bundle-poll', 'rsi-bundle-poll:bootstrap']]);
    // A run's failure offers nothing, by name, and reads nothing to say so.
    const before = lookups;
    assert.deepEqual(await runtime.offerRun({ id: 'research', userId: 'researcher' }, 'run-1'), { offered: false, reason: 'rsi_incident_channel_absent' });
    assert.equal(lookups, before);
    // The worker polls with what this deployment has: the empty directory.
    await runtime.worker.tick();
    assert.equal(jobs.jobs[0].status, 'succeeded');
    assert.deepEqual(jobs.jobs[0].result, { processed: 0, outcomes: {} });
    assert.equal(jobs.jobs[1].idempotencyKey, 'rsi-bundle-poll:after:job-1', 'and the next poll is queued');
    // A journal an earlier life of the deployment left: nothing reads the source, calls the model or uploads, and its withdrawal stays owed.
    const id = 'rsi-incident-left';
    await documents.put(PLATFORM_PUBLISHER_USER_ID, 'knowledge', id, { recordType: 'rsi-incident-export', userId: 'researcher', projectId: 'research', sourceRunId: 'run', sourceRevision: 'a'.repeat(64), authorizationId: 'rsi-agreement-old', status: 'queued' }, { expectedRevision: 0 });
    await jobs.enqueue(PLATFORM_PUBLISHER_USER_ID, 'rsi-incident-export', { id }, { idempotencyKey: id });
    jobs.jobs[1].status = 'done-elsewhere';
    await runtime.worker.tick();
    assert.equal(documents.rows.get(`${PLATFORM_PUBLISHER_USER_ID}:${id}`).payload.status, 'awaiting-configuration');
    assert.equal(modelCalls, 0);
    assert.equal(await runtime.sweepAgreement(), null, 'no agreement to reconcile with');
    // A source deletion still marks what it must, with no channel to publish on.
    assert.deepEqual(await runtime.invalidateSource({ userId: 'researcher', projectId: 'research' }), { invalidated: [id] });
    assert.equal(documents.rows.get(`${PLATFORM_PUBLISHER_USER_ID}:${id}`).payload.invalidated, true);
    await runtime.worker.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a broken directory deployment says why and binds nothing: no transport, no poll, no publisher project, and an active campaign would read as unbound', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rsi-directory-broken-'));
  try {
    const file = path.join(dir, 'online.json');
    const records = await trustRecords(dir);
    const deployment = { schemaVersion: 1, transport: { kind: 'directory', role: 'production', path: path.join(dir, 'bundles') }, ...records };
    const said = [], jobs = memoryJobs();
    const start = (extra = {}) => createRsiOnlineRuntime({ config: { rsiOnlineConfigFile: file }, documents: memoryDocuments(), jobs, database: {}, agentRuns: {}, servingAdapters: stubServing(), store: stubStore(), report: code => said.push(code), ...extra });
    await writeFile(file, JSON.stringify({ ...deployment, agreementRef: path.join(dir, 'agreement.json') }), { mode: 0o600 });
    const invalid = await start({ transportFactory: () => assert.fail('no transport on an invalid file'), store: { userById: () => assert.fail('no publisher on an invalid file') } });
    assert.deepEqual(said, ['rsi_online_configuration_invalid']);
    assert.deepEqual([invalid.configured(), invalid.canWithdraw()], [false, false]);
    assert.ok(invalid.importer, 'it still reconciles journals left by an earlier configuration');
    assert.equal(invalid.importer.isBound(), false);
    assert.deepEqual(jobs.jobs, []);
    await invalid.worker.close();
    // The file is whole but the directory is not there: the same as an OSS client that cannot start.
    said.length = 0;
    await writeFile(file, JSON.stringify(deployment), { mode: 0o600 });
    const absent = await start();
    assert.deepEqual(said, ['rsi_online_transport_unavailable']);
    assert.equal(absent.configured(), false);
    assert.deepEqual(jobs.jobs, []);
    await absent.worker.close();
    // The directory is there, the evaluator registry is not: no import without its trust.
    said.length = 0;
    await mkdir(path.join(dir, 'bundles'));
    await rm(records.evaluatorRegistryRef);
    const untrusted = await start();
    assert.deepEqual(said, ['rsi_deployment_binding_unavailable']);
    assert.equal(untrusted.configured(), false);
    assert.deepEqual(jobs.jobs, []);
    untrusted.worker.start();
    assert.equal(await untrusted.worker.tick(), null, 'nothing to claim with');
    await untrusted.worker.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an OSS deployment imports without an agreement in force, and only its incidents wait for one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rsi-oss-import-'));
  try {
    const file = path.join(dir, 'online.json'), agreementRef = path.join(dir, 'agreement.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, agreementRef, ...await trustRecords(dir), extractionDailyCny: 1,
      transport: { role: 'production', region: 'cn-beijing', endpoint: 'https://oss-cn-beijing.aliyuncs.com', incidentBucket: 'fixture-incidents', bundleBucket: 'fixture-bundles', identityRefs: { production: '/run/prod', lab: '/run/lab' } } }), { mode: 0o600 });
    const said = [], run = { id: 'run-1', status: 'failed', transcript: { sha256: 'a'.repeat(64) } };
    const start = () => { const jobs = memoryJobs(); return createRsiOnlineRuntime({ config: { rsiOnlineConfigFile: file }, documents: memoryDocuments(), jobs, database: {}, agentRuns: { list: async () => [run] }, servingAdapters: stubServing(), store: stubStore(), report: code => said.push(code),
      transportFactory: async () => ({ available: true, listBundles: async () => ({ keys: [], cursor: null }), readBundle: async () => null, headObject: async () => null, putObject: async input => ({ digest: input.digest }) }) }).then(runtime => ({ runtime, jobs })); };
    const missing = await start();
    assert.deepEqual([missing.runtime.configured(), missing.runtime.canWithdraw(), missing.runtime.canExport()], [true, true, false]);
    assert.ok(said.includes('rsi_deployment_agreement_unavailable'));
    assert.equal(await missing.runtime.offerRun({ id: 'research', userId: 'researcher' }, run.id), null);
    assert.deepEqual(missing.jobs.jobs.map(job => job.kind), ['rsi-bundle-poll'], 'the poll runs; no incident was queued');
    await missing.runtime.worker.close();
    await writeFile(agreementRef, JSON.stringify({ id: 'quality', version: 1, purpose: 'platform-quality', providers: ['deepseek', 'dashscope'], scope: 'authorized-incident' }), { mode: 0o600 });
    const agreed = await start();
    assert.deepEqual([agreed.runtime.configured(), agreed.runtime.canWithdraw(), agreed.runtime.canExport()], [true, true, true]);
    const offered = await agreed.runtime.offerRun({ id: 'research', userId: 'researcher' }, run.id);
    assert.equal(offered.payload.recordType, 'rsi-incident-export');
    assert.deepEqual(agreed.jobs.jobs.map(job => job.kind), ['rsi-bundle-poll', 'rsi-incident-export']);
    await agreed.runtime.worker.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an incident extraction is booked as the offline campaigns\' own purpose, never a person\'s learning, under the deployment\'s ceiling', async () => {
  // Audit 2026-11-03, D6: it was booked `learning`, the purpose of a person's own learning loop and of its per-account cap.
  const calls = [];
  let configured = true;
  const extract = createRsiIncidentExtractor({ config: { marker: 'config' }, usageLedger: { marker: 'ledger' }, binding: { userId: PLATFORM_PUBLISHER_USER_ID, projectId: 'evimed-evidence' },
    online: { extractionDailyCny: 2 }, configured: () => configured,
    model: async (dependencies, call) => { calls.push({ dependencies, call }); return { choices: [{ message: { content: '{"diagnostic":"d"}' } }] }; } });
  assert.deepEqual(await extract({ instructions: 'Read it.', fields: ['diagnostic'], messages: [] }), { diagnostic: 'd' });
  const [{ dependencies, call }] = calls;
  assert.deepEqual([dependencies.config.marker, dependencies.usageLedger.marker], ['config', 'ledger']);
  assert.deepEqual({ userId: call.userId, projectId: call.projectId, purpose: call.purpose, runId: call.runId, limits: call.limits },
    { userId: PLATFORM_PUBLISHER_USER_ID, projectId: 'evimed-evidence', purpose: 'rsi', runId: 'rsi-incident-extraction', limits: { daily: 0, weekly: 0, moduleDaily: 2 } });
  configured = false;
  await assert.rejects(extract({ instructions: 'Read it.', fields: [], messages: [] }), /rsi_online_configuration_missing/);
  assert.equal(calls.length, 1, 'no call once the deployment is no longer bound');
});

test('the extraction ceiling is the rsi purpose\'s own daily budget, and the publisher\'s other work neither spends it nor is spent by it', async () => {
  // Review of 2026-11-03: booked `rsi` under `daily`/`weekly` limits, the call was refused by everything else the publisher account spent
  // that day, and its own spend counted against that account's caps.
  const { callModelForControlPlane } = await import('../src/modelGateway.mjs');
  const { UNCAPPED_USAGE_PURPOSES } = await import('../src/usageLedger.mjs');
  const reserved = [];
  const usageLedger = { async reserveModel(input) { reserved.push(input); throw Object.assign(new Error('The module daily budget is exhausted.'), { status: 402, code: 'usage_module_budget_exceeded' }); } };
  const extract = createRsiIncidentExtractor({ config: { deepseekBaseUrl: 'https://api.deepseek.com', deepseekApiKey: 'unused', production: false }, usageLedger,
    model: callModelForControlPlane, binding: { userId: PLATFORM_PUBLISHER_USER_ID, projectId: 'evimed-evidence' }, online: { extractionDailyCny: 2 }, configured: () => true });
  await assert.rejects(extract({ instructions: 'Read it.', fields: ['diagnostic'], messages: [] }), /module daily budget/);
  const [{ purpose, budgetPurpose, moduleLimit, dailyLimit, weeklyLimit }] = reserved;
  assert.deepEqual({ purpose, budgetPurpose, moduleLimit, dailyLimit, weeklyLimit }, { purpose: 'rsi', budgetPurpose: 'rsi', moduleLimit: 2, dailyLimit: 0, weeklyLimit: 0 });
  assert.ok(UNCAPPED_USAGE_PURPOSES.includes('rsi'), 'an rsi row is never summed into an account\'s caps');
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
