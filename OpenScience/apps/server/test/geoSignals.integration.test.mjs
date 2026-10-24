import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoSignals, geoSignalId } from '../src/geoSignals.mjs';
import { GeoSignalDiscovery } from '../src/geoSignalDiscovery.mjs';
import { GeoPlanContext } from '../src/geoPlanContext.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'Disposable PostgreSQL required' };
const user = { id: 'signals-owner' };
let isolated, database, store, documents, project, service, signals;
let runs = [], resultPresent = false, unreadable = false, notifications = 0;
const event = key => ({ kind: 'citation_observed', objectKey: `https://example.org/${key}`, eventVersion: 'first',
  observedAt: '2026-10-01T00:00:00Z', title: `A cited page ${key}`, basis: { url: `https://example.org/${key}`, snapshotId: 's1', engine: 'deepseek' } });

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'geosignals');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 3, databaseConnectionTimeoutMs: 3000 });
  store = new GeoStore({ database }); await store.ready();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Signals','development')", [user.id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'signals-project','Signals',1048576)", [user.id]);
  project = await store.createProject({ userId: user.id, projectId: 'signals-project', coverageDays: 90, engines: ['deepseek'], product: { brandName: 'Fictional' } });
  documents = new ProductDocuments(database);
  service = new GeoService({ store, config: { geoEnabled: true, geoAudience: 'all' } });
  signals = new GeoSignals({ documents, store, service, runs: async () => { if (unreadable) throw new Error('offline'); return runs; },
    resultForRun: async (_project, run) => ({ present: resultPresent, runId: run.id }), notify: async () => ++notifications });
  service.signals = signals;
});
after(async () => { await database?.close(); await isolated?.drop(); });

test('durable occurrence identity survives concurrent replay; a real new occurrence is independent', options, async () => {
  const [first, second] = await Promise.all([signals.record(project, event('one')), signals.record(project, event('one'))]);
  assert.equal(first.id, second.id); assert.equal(first.revision, 1);
  assert.equal(first.id, geoSignalId(project.id, 'citation_observed', 'https://example.org/one', 'first'));
  const replay = await signals.record(project, { ...event('one'), title: 'Edited copy', observedAt: '2026-10-23T00:00:00Z' });
  assert.equal(replay.payload.title, first.payload.title);
  assert.equal(replay.payload.observedAt, first.payload.observedAt);
  const recurring = await signals.record(project, { ...event('one'), eventVersion: 'recurrence-explicit' });
  assert.notEqual(recurring.id, first.id);
  await assert.rejects(signals.detail({ id: 'foreign' }, project.id, first.id), error => error.status === 404);
  assert.equal(notifications, 0);
});

test('disposition CAS is atomic, replay-safe and records history without changing the event or task', options, async () => {
  const row = await signals.record(project, event('disposition'));
  const body = { expectedRevision: 1, requestKey: 'ignore', disposition: 'ignored', reason: 'Already reviewed elsewhere' };
  const results = await Promise.all([signals.disposition(user, project.id, row.id, body), signals.disposition(user, project.id, row.id, body)]);
  assert.ok(results.every(result => result.state === 'ignored'));
  assert.equal((await documents.get(user.id, 'geo-signal', row.id)).revision, 2);
  await assert.rejects(signals.disposition(user, project.id, row.id, { ...body, disposition: 'active' }), error => error.code === 'geo_signal_conflict');
  await assert.rejects(signals.disposition(user, project.id, row.id, { ...body, requestKey: 'stale', disposition: 'active' }), error => error.code === 'geo_signal_conflict');
  const restored = await signals.disposition(user, project.id, row.id, { expectedRevision: 2, requestKey: 'restore', disposition: 'active' });
  assert.equal(restored.state, 'pending');
  assert.equal((await documents.history(user.id, 'geo-signal', row.id)).length, 3);
  assert.equal(restored.basisDigest, row.payload.basisDigest);
  await assert.rejects(signals.disposition(user, project.id, row.id, { expectedRevision: 3, requestKey: 'forge', disposition: 'completed' }), error => error.status === 400);
  const originalPut = documents.put.bind(documents);
  documents.put = async (...args) => { if (args[3]?.recordType === 'geo-signal-disposition') throw new Error('receipt unavailable'); return originalPut(...args); };
  try {
    await assert.rejects(signals.disposition(user, project.id, row.id, { expectedRevision: 3, requestKey: 'atomic', disposition: 'ignored' }), /receipt unavailable/);
  } finally { documents.put = originalPut; }
  assert.equal((await documents.get(user.id, 'geo-signal', row.id)).revision, 3);
});

test('exact bound request controls lifecycle and outputs; same-session unrelated runs never count', options, async () => {
  const row = await signals.record(project, event('execution'));
  const contextId = `gpc_${'1'.repeat(64)}`;
  const payload = { recordType: 'geo-plan-context', mode: 'signal', geoId: project.id, sessionId: 'native-session', requestId: 'req-1',
    state: 'staged', basis: { signal: { id: row.id, basisDigest: row.payload.basisDigest } } };
  await documents.put(user.id, 'geo-plan-context', contextId, payload, { expectedRevision: 0, projectId: project.projectId });
  assert.equal((await signals.detail(user, project.id, row.id)).state, 'pending');
  await documents.put(user.id, 'geo-plan-context', contextId, { ...payload, state: 'bound' }, { expectedRevision: 1, projectId: project.projectId });
  runs = [{ id: 'other', sessionId: 'native-session', kernelRequestIds: ['other-request'], status: 'succeeded' }]; resultPresent = true;
  assert.equal((await signals.detail(user, project.id, row.id)).availability, 'unknown');
  const run = { id: 'exact', sessionId: 'native-session', kernelRequestIds: ['req-1'], status: 'running', startedAt: '2026-10-24T00:00:00Z' };
  runs.push(run);
  assert.equal((await signals.detail(user, project.id, row.id)).state, 'processing');
  run.status = 'succeeded';
  assert.equal((await signals.detail(user, project.id, row.id)).state, 'completed');
  assert.equal((await signals.detail(user, project.id, row.id)).businessOutcome.state, 'observed');
  const later = { ...payload, requestId: 'req-2', state: 'bound' };
  await documents.put(user.id, 'geo-plan-context', `gpc_${'2'.repeat(64)}`, later, { expectedRevision: 0, projectId: project.projectId });
  runs.push({ ...run, id: 'later', kernelRequestIds: ['req-2'], status: 'failed', startedAt: '2026-10-24T00:01:00Z' });
  assert.equal((await signals.detail(user, project.id, row.id)).state, 'failed_recoverable');
  unreadable = true;
  try { assert.equal((await signals.detail(user, project.id, row.id)).availability, 'unknown'); }
  finally { unreadable = false; }
});

test('full-set counts exceed a page and read operations do not create notices or revisions', options, async () => {
  for (let index = 0; index < 105; index++) await signals.record(project, event(`many-${index}`));
  const before = (await database.query("SELECT count(*)::integer AS n FROM evimed_product.revisions WHERE kind='geo-signal'")).rows[0].n;
  const first = await signals.list(user, project.id, { limit: 17 });
  assert.ok(first.total > 100);
  const seen = new Set();
  let cursor = null;
  do {
    const page = await signals.list(user, project.id, { limit: 17, cursor });
    for (const item of page.items) { assert.ok(!seen.has(item.id)); seen.add(item.id); }
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(seen.size, first.total);
  assert.equal(Object.values(first.counts).reduce((sum, value) => sum + value, 0), first.total);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_product.revisions WHERE kind='geo-signal'")).rows[0].n, before);
  assert.equal(notifications, 0);
});

test('producer cursor advances only after durable exact page sightings; repeated polls and URL aliases do not duplicate', options, async () => {
  const discovery = new GeoSignalDiscovery({ store, signals });
  await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,question_id,engine,asked_at,status,answer_sha256,citations)
    VALUES('discovery-s1',$1,$2,'original-question','deepseek','2026-10-23T10:00:00Z','valid',$3,$4::jsonb)`,
  [user.id, project.id, 'a'.repeat(64), JSON.stringify([{ url: 'https://example.org/article?b=2&a=1#section' }, { url: 'https://example.org/article?a=1&b=2' }, { url: 'https://example.org/article?a=2&b=2' }])]);
  const originalRecord = signals.record.bind(signals);
  let n = 0;
  signals.record = async (...args) => { if (++n === 2) throw new Error('interrupted persistence'); return originalRecord(...args); };
  try { await assert.rejects(discovery.project(project), /interrupted persistence/); }
  finally { signals.record = originalRecord; }
  assert.equal((await store.query("SELECT * FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND key='signals:discovery:v1'", [project.id])).rows.length, 0);
  await discovery.project(project);
  await discovery.project(project);
  const rows = (await documents.list(user.id, 'geo-signal', { projectId: project.projectId, limit: 100, filter: { recordType: 'geo-signal', kind: 'citation_observed', eventVersion: 'first_preserved_observation' } })).items;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.payload.basis.snapshotId === 'discovery-s1' && row.payload.basis.articleVersion === null));
  const mark = (await store.query("SELECT detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND key='signals:discovery:v1'", [project.id])).rows[0];
  assert.equal(mark.detail.snapshotId, 'discovery-s1');
  const stats = await discovery.tick(); assert.equal(stats.failed, 0);
  assert.equal(notifications, 0);
});

test('the one native context stages a signal once across tabs and preserves exact failed-turn continuation', options, async () => {
  const row = await signals.record(project, event('native-handling'));
  const adapter = new GeoPlanContext({ documents, store, service, authorizeSession: async (_user, _project, session) => assert.equal(session, 'signal-native'), runs: async () => runs });
  const body = { requestKey: 'click-1', sessionId: 'signal-native', mode: 'signal', signalId: row.id, expectedSignalRevision: 1, intent: 'analyse' };
  const [first, other] = await Promise.all([adapter.stage(user, project.id, body), adapter.stage(user, project.id, { ...body, requestKey: 'click-2' })]);
  assert.equal(first.referenceId, other.referenceId); assert.equal(first.state, 'staged');
  const request = { requestId: 'signal-native-request', sessionId: 'signal-native', content: [{ type: 'text', text: 'Please explain this citation.' }], geoPlanContext: { referenceId: first.referenceId } };
  const control = { userId: user.id, id: project.projectId };
  await adapter.prepare(user, control, request);
  await store.transaction(() => adapter.bind(user, control, request));
  assert.equal(request.geoPlanContext, undefined);
  assert.ok(request.content[1].text.includes(row.id));
  assert.equal((await adapter.routingInputForRequest(control, request)).originalText, 'Please explain this citation.');
  const replay = await adapter.stage(user, project.id, { ...body, requestKey: 'click-3' });
  assert.equal(replay.state, 'bound'); assert.equal(replay.requestId, request.requestId);
  await assert.rejects(adapter.stage(user, project.id, { ...body, intent: 'correct' }), error => error.code === 'geo_plan_context_conflict');
  await assert.rejects(adapter.stage(user, project.id, { ...body, requestKey: 'bad-focus', focusRefs: ['unrelated'] }), error => error.status === 400);
  await assert.rejects(adapter.stage(user, project.id, { ...body, requestKey: 'premature', previousContextRef: first.referenceId }), error => error.code === 'geo_signal_conflict');
  runs.push({ id: 'signal-run', sessionId: 'signal-native', kernelRequestIds: [request.requestId], status: 'failed', startedAt: '2026-10-24T12:00:00Z' });
  const next = await adapter.stage(user, project.id, { ...body, requestKey: 'continue', previousContextRef: first.referenceId });
  assert.notEqual(next.referenceId, first.referenceId);
  const held = await documents.get(user.id, 'geo-plan-context', next.referenceId);
  assert.deepEqual(held.payload.basis.previous, { contextRef: first.referenceId, sessionId: 'signal-native', requestId: 'signal-native-request', runId: 'signal-run', status: 'failed' });
  assert.equal(held.payload.basis.signal.basisDigest, row.payload.basisDigest);
  assert.equal((await signals.detail(user, project.id, row.id)).currentAttempt.runId, 'signal-run');
});
