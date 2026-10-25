import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoSignals, geoSignalId } from '../src/geoSignals.mjs';
import { GeoPlanContext } from '../src/geoPlanContext.mjs';
import { GeoSignalInputs } from '../src/geoSignalInputs.mjs';
import { GeoSignalDiscovery, geoSourceImpactEvent } from '../src/geoSignalDiscovery.mjs';
import { pruneGeoValueProfiles } from '../src/geoValueUpkeep.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'Disposable PostgreSQL required', timeout: 15000 };
const rules = { keep: 20, limit: 200, timeZone: 'Asia/Shanghai' };
const gate = () => {
  let enter, release;
  return { entered: new Promise(resolve => { enter = resolve; }), held: new Promise(resolve => { release = resolve; }), enter: () => enter(), release: () => release() };
};
async function fixture(t, paged = false, initializeProduct = true) {
  const isolated = await createGeoTestDatabase(url, 'signalretentionrace');
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 });
  const peer = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 3, databaseConnectionTimeoutMs: 1000 });
  const store = new GeoStore({ database }), other = new GeoStore({ database: peer });
  const pending = [], gates = [];
  t.after(async () => { for (const barrier of gates) barrier.release(); await Promise.allSettled(pending); await database.close(); await peer.close(); await isolated.drop(); });
  await store.ready(); await other.ready();
  const user = { id: 'race-owner' }, control = { userId: user.id, id: randomUUID() };
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Race','development')", [user.id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Race',1048576)", [user.id, control.id]);
  const project = await store.createProject({ userId: user.id, projectId: control.id, engines: ['deepseek'], coverageDays: 90 });
  const documents = new ProductDocuments(database), otherDocuments = new ProductDocuments(peer);
  if (initializeProduct) { await documents.get(user.id, 'geo-signal', 'initialize'); await otherDocuments.get(user.id, 'geo-signal', 'initialize'); }
  await store.writeValue(user.id, project.id, { findings: [{ id: 'first', statement: 'Monthly first' }] });
  const findings = Array.from({ length: paged ? 1200 : 1 }, (_, n) => ({ id: `finding-${n}`, statement: `Original finding ${n} ` + 'L'.repeat(160), sourceRef: 'doi:10.1000/race' }));
  const profile = await store.writeValue(user.id, project.id, { findings, sourceChanges: [{ id: 'source-change', sourceRef: 'doi:10.1000/race', kind: 'correction', status: 'needs_review', summary: 'Source corrected' }] });
  const impact = { change: profile.data.sourceChanges[0], findingIds: findings.map(item => item.id), articleIds: [], groupIds: [] };
  const event = geoSourceImpactEvent(profile, impact, [], []);
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: 'all' } });
  const signals = new GeoSignals({ documents, store, service, runs: async () => [] }); service.signals = signals;
  const contexts = new GeoPlanContext({ documents, store, service, authorizeSession: async () => {}, runs: async () => [] });
  const track = promise => { pending.push(promise); promise.catch(() => {}); return promise; };
  const barrier = () => { const item = gate(); gates.push(item); return item; };
  async function age() {
    for (let version = 3; version <= 30; version++) await other.writeValue(user.id, project.id, { findings: [{ id: 'finding-0', statement: `New finding ${version}` }] });
    await other.query("UPDATE evimed_geo.value_profiles SET created_at='2026-10-10T12:00:00Z'::timestamptz+make_interval(mins=>version) WHERE geo_project_id=$1", [project.id]);
  }
  async function read(staged) {
    const request = { requestId: randomUUID(), sessionId: 'retention-session', content: [{ type: 'text', text: 'Explain the original finding.' }], geoPlanContext: { referenceId: staged.referenceId } };
    await contexts.prepare(user, control, request); await contexts.bind(user, control, request);
    const result = await new GeoSignalInputs({ contexts, service, store }).read(project, { planContextRef: staged.referenceId, targetKey: event.basis.targets.find(item => item.id === 'finding-0').key });
    assert.equal(result.availability, 'preserved');
    assert.deepEqual(JSON.parse(result.items.map(item => item.text).join('')), profile.data.findings.find(item => item.id === 'finding-0'));
  }
  const stage = signal => contexts.stage(user, project.id, { requestKey: randomUUID(), sessionId: 'retention-session', mode: 'signal', signalId: signal.id, expectedSignalRevision: signal.revision, intent: 'analyse', focusRefs: [event.basis.targets.find(item => item.id === 'finding-0').key] });
  return { database, peer, store, other, documents, otherDocuments, project, event, profile, service, signals, contexts, user, control, track, barrier, age, read, stage };
}
async function waiting(database) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const rows = await database.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()");
    if (rows.rows.length) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return false;
}
function holdPublication(f, barrier, { fail = false, recordType = 'geo-signal' } = {}) {
  return new Proxy(f.documents, { get(target, key) {
    if (key === 'put' || key === 'createBatch') return async (...args) => {
      const root = key === 'put' ? args[3] : args[1]?.[0]?.payload;
      if (root?.recordType !== recordType) return target[key](...args);
      return f.database.transaction(client => f.database.withTransactionClient(client, async () => {
        const row = await target[key](...args); barrier.enter(); await barrier.held;
        if (fail) throw Object.assign(new Error('Cancelled publication fixture'), { code: 'fixture_cancelled' });
        return row;
      }));
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
for (const paged of [false, true]) {
  test(`publication wins: ${paged ? 'paged' : 'inline'} signal holds retention through the actual root/pages commit on pool=1`, options, async t => {
    const f = await fixture(t, paged); await f.age(); const barrier = f.barrier();
    f.signals.documents = holdPublication(f, barrier);
    const publication = f.track(f.signals.record(f.project, f.event)); await barrier.entered;
    const pruning = f.track(pruneGeoValueProfiles(f.other, f.project.id, rules));
    assert.equal(await waiting(f.peer), true, 'the real prune must wait on the publisher value lock');
    barrier.release(); const signal = await publication;
    assert.equal((await pruning).includes(f.profile.version), false);
    assert.equal(Boolean(signal.payload.basis.targetPages), paged);
    await f.read(await f.stage(signal)); assert.equal(f.database.pool.totalCount, 1);
  });
  test(`rollback releases ${paged ? 'paged' : 'inline'} publication lock with no head/page fragments and no accidental retention pin`, options, async t => {
    const f = await fixture(t, paged); await f.age(); const barrier = f.barrier();
    f.signals.documents = holdPublication(f, barrier, { fail: true });
    const publication = f.track(f.signals.record(f.project, f.event)); await barrier.entered;
    const pruning = f.track(pruneGeoValueProfiles(f.other, f.project.id, rules));
    assert.equal(await waiting(f.peer), true); barrier.release();
    await assert.rejects(publication, error => error.code === 'fixture_cancelled');
    assert.equal((await pruning).includes(f.profile.version), true);
    const id = geoSignalId(f.project.id, f.event.kind, f.event.objectKey, f.event.eventVersion);
    assert.equal(await f.documents.get(f.user.id, 'geo-signal', id), null);
    assert.equal((await f.other.query("SELECT count(*)::integer AS n FROM evimed_product.documents WHERE payload->>'signalId'=$1", [id])).rows[0].n, 0);
    assert.equal((await f.other.query("SELECT count(*)::integer AS n FROM evimed_product.revisions WHERE id=$1 OR payload->>'signalId'=$1", [id])).rows[0].n, 0);
    f.signals.documents = f.documents;
    const next = await f.signals.record(f.project, { kind: 'citation_observed', objectKey: 'next', eventVersion: 'first', title: 'Independent progress', basis: {} });
    assert.ok(next.id); assert.equal(f.database.pool.totalCount, 1);
  });
}

test('pruning wins and a stale captured event cannot publish a dangling version or silently substitute the latest', options, async t => {
  const f = await fixture(t); await f.age(); const barrier = f.barrier();
  const transaction = f.other.transaction.bind(f.other);
  f.other.transaction = operation => transaction(client => f.peer.withTransactionClient(client, () => operation(new Proxy(client, { get(target, key) {
    if (key === 'query') return async (sql, values) => { const result = await target.query(sql, values); if (sql.startsWith('WITH pointed AS')) { barrier.enter(); await barrier.held; } return result; };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } }))));
  const pruning = f.track(pruneGeoValueProfiles(f.other, f.project.id, rules)); await barrier.entered;
  const publication = f.track(f.signals.record(f.project, f.event));
  assert.equal(await waiting(f.peer), true, 'publication waits for the earlier pruning transaction');
  barrier.release(); assert.ok((await pruning).includes(f.profile.version));
  await assert.rejects(publication, error => error.code === 'geo_signal_conflict');
  await assert.rejects(f.signals.record(f.project, f.event), error => error.code === 'geo_signal_conflict');
  assert.equal((await f.other.query("SELECT count(*)::integer AS n FROM evimed_product.documents WHERE payload->>'recordType'='geo-signal'")).rows[0].n, 0);
  let delivered = 0; f.signals.deliver = async () => { assert.equal(Boolean(f.database.transactionScope()), false, 'delivery stays outside the value lock'); delivered++; };
  await new GeoSignalDiscovery({ store: f.store, signals: f.signals }).sources(f.project);
  assert.equal(delivered, 1);
  const current = (await f.documents.list(f.user.id, 'geo-signal', { projectId: f.control.id, filter: { recordType: 'geo-signal' } })).items[0];
  assert.equal(current.payload.basis.profileVersionAtDetection, 30);
});

test('a captured signal-to-context handoff survives concurrent originating-head deletion and prune without borrowing another pool connection', options, async t => {
  const f = await fixture(t); await f.age(); const signal = await f.signals.record(f.project, f.event), barrier = f.barrier();
  const stageInput = f.signals.stageInput.bind(f.signals);
  f.signals.stageInput = async (...args) => { const input = await stageInput(...args); barrier.enter(); await barrier.held; return input; };
  const staged = f.track(f.stage(signal)); await barrier.entered;
  await f.otherDocuments.remove(f.user.id, 'geo-signal', signal.id, signal.revision);
  const pruning = f.track(pruneGeoValueProfiles(f.other, f.project.id, rules));
  assert.equal(await waiting(f.peer), true, 'context capture and publication share the profile retention lock');
  barrier.release(); const context = await staged;
  assert.equal((await pruning).includes(f.profile.version), false); await f.read(context);
  assert.equal(await f.documents.get(f.user.id, 'geo-signal', signal.id), null); assert.equal(f.database.pool.totalCount, 1);
});

test('source discovery captures the profile under the same retention lock and delivers after committing', options, async t => {
  const f = await fixture(t), barrier = f.barrier();
  const latest = f.store.latestValue.bind(f.store); let first = true;
  f.store.latestValue = async (...args) => { const value = await latest(...args); if (first) { first = false; barrier.enter(); await barrier.held; } return value; };
  let delivered = 0; f.signals.deliver = async () => { assert.equal(Boolean(f.database.transactionScope()), false); delivered++; };
  const discovery = f.track(new GeoSignalDiscovery({ store: f.store, signals: f.signals }).sources(f.project)); await barrier.entered;
  const writing = f.track(f.other.writeValue(f.user.id, f.project.id, { findings: [{ id: 'finding-0', statement: 'New value after capture' }] }));
  assert.equal(await waiting(f.peer), true, 'the profile writer cannot cross discovery capture-to-commit');
  barrier.release(); await discovery; await writing; assert.equal(delivered, 1);
  const signal = (await f.documents.list(f.user.id, 'geo-signal', { projectId: f.control.id, filter: { recordType: 'geo-signal' } })).items[0];
  assert.equal(signal.payload.basis.profileVersionAtDetection, f.profile.version);
  await f.read(await f.stage(signal));
});


test('the first signal publication initializes its product schema before a one-connection retention transaction', options, async t => {
  const f = await fixture(t, false, false);
  assert.equal((await f.database.query("SELECT to_regclass('evimed_product.documents') AS name")).rows[0].name, null);
  const signal = await f.signals.record(f.project, f.event);
  await f.read(await f.stage(signal)); assert.equal(f.database.pool.totalCount, 1);
});

test('a failed signal-context handoff rolls back its root and receipt, releasing a waiting prune and subsequent discovery', options, async t => {
  const f = await fixture(t); await f.age(); const signal = await f.signals.record(f.project, f.event), barrier = f.barrier();
  f.contexts.documents = holdPublication(f, barrier, { fail: true, recordType: 'geo-plan-context' });
  const staged = f.track(f.stage(signal)); await barrier.entered;
  await f.otherDocuments.remove(f.user.id, 'geo-signal', signal.id, signal.revision);
  const pruning = f.track(pruneGeoValueProfiles(f.other, f.project.id, rules));
  assert.equal(await waiting(f.peer), true); barrier.release();
  await assert.rejects(staged, error => error.code === 'fixture_cancelled');
  assert.equal((await pruning).includes(f.profile.version), true);
  assert.equal((await f.other.query("SELECT count(*)::integer AS n FROM evimed_product.documents WHERE kind='geo-plan-context'")).rows[0].n, 0);
  assert.equal((await f.other.query("SELECT count(*)::integer AS n FROM evimed_product.revisions WHERE kind='geo-plan-context'")).rows[0].n, 0);
  await new GeoSignalDiscovery({ store: f.store, signals: f.signals }).sources(f.project);
  assert.equal((await f.other.query("SELECT count(*)::integer AS n FROM evimed_product.documents WHERE payload->>'recordType'='geo-signal' AND deleted_at IS NULL")).rows[0].n, 1);
});
