import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoSignals } from '../src/geoSignals.mjs';
import { GeoSignalDiscovery } from '../src/geoSignalDiscovery.mjs';
import { NotificationService } from '../src/notificationService.mjs';
import { createGeoNotifier } from '../src/geoNotify.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { packGeoSignalTargets } from '../src/geoSignalTargets.mjs';
import { geoSignalId } from '../src/geoSignals.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'Disposable PostgreSQL required' };
async function fixture(t) {
  const isolated = await createGeoTestDatabase(url, 'signalrecovery');
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 3, databaseConnectionTimeoutMs: 3000 });
  t.after(async () => { await database.close(); await isolated.drop(); });
  const store = new GeoStore({ database }); await store.ready();
  const user = { id: 'owner' };
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('owner','Owner','development')");
  const makeProject = async id => {
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('owner',$1,'Fixture',1048576)", [id]);
    return store.createProject({ userId: user.id, projectId: id, coverageDays: 90, engines: ['deepseek'], product: { brandName: 'Fictional' } });
  };
  const documents = new ProductDocuments(database), service = new GeoService({ store, config: { geoEnabled: true, geoAudience: 'all' } });
  const signals = new GeoSignals({ documents, store, service, runs: async () => [], resultForRun: async () => ({ present: false }) });
  return { database, store, user, makeProject, documents, signals };
}

test('large finding text preserves every impact identity while failed projects yield and retain cursors', options, async t => {
  const { store, user, makeProject, signals, documents } = await fixture(t);
  const blocked = [];
  for (let index = 0; index < 5; index++) {
    const project = await makeProject(`large-${index}`); blocked.push(project);
    for (let start = 0; start < 75; start += 25) await store.writeValue(user.id, project.id, { findings: Array.from({ length: 25 }, (_, n) => ({ id: `f${start + n}`, statement: 'Long statement '.repeat(220), sourceRef: 'source' })) });
    await store.writeValue(user.id, project.id, { sourceChanges: [{ id: 'correction', sourceRef: 'source', kind: 'correction' }] });
  }
  const healthy = await makeProject('healthy');
  let clock = Date.parse('2026-10-24T00:00:00Z');
  const reports = [], discovery = new GeoSignalDiscovery({ store, signals, now: () => new Date(clock += 1000), report: code => reports.push(code) });
  assert.deepEqual(await discovery.tick(), { projects: 5, failed: 0 });
  for (const project of blocked) {
    const rows = await documents.list(user.id, 'geo-signal', { projectId: project.projectId, filter: { recordType: 'geo-signal' } });
    assert.equal(rows.items[0].payload.basis.targets.length, 75);
    assert.ok(rows.items[0].payload.basis.targets.every(target => target.label.length <= 160 && target.digest.length === 64));
  }
  const original = discovery.sources.bind(discovery);
  discovery.sources = async project => { if (blocked.some(item => item.id === project.id)) throw Object.assign(new Error('Fixture failure'), { code: 'fixture_source_failure' }); return original(project); };
  const before = new Map();
  for (const project of blocked) before.set(project.id, (await store.query("SELECT detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND key='signals:discovery:v1'", [project.id])).rows[0].detail);
  assert.deepEqual(await discovery.tick(), { projects: 1, failed: 4 });
  assert.deepEqual(await discovery.tick(), { projects: 1, failed: 4 });
  assert.ok((await store.query("SELECT 1 FROM evimed_geo.schedule_marks WHERE geo_project_id=$1", [healthy.id])).rows.length);
  for (const project of blocked) {
    const mark = (await store.query("SELECT state,detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1", [project.id])).rows[0];
    assert.equal(mark.state, 'failed');
    const { lastError, ...cursors } = mark.detail, { lastError: _beforeError, ...oldCursors } = before.get(project.id);
    assert.equal(lastError, 'fixture_source_failure'); assert.deepEqual(cursors, oldCursors);
  }
  discovery.sources = original;
  await discovery.tick(); await discovery.tick();
  for (const project of blocked) {
    const mark = (await store.query("SELECT state,detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1", [project.id])).rows[0];
    assert.equal(mark.state, 'done'); assert.equal(mark.detail.lastError, null);
  }
  assert.equal(reports.length, 8);
});

test('large impact sets use atomic immutable pages and native focus preserves exact off-page targets', options, async t => {
  const { makeProject, signals, user, documents, store } = await fixture(t);
  const project = await makeProject('target-pages');
  const targets = Array.from({ length: 1200 }, (_, n) => ({ key: `target-${n}`, id: `finding-${n}`, type: 'finding', label: 'L'.repeat(160), digest: 'a'.repeat(64), version: 1, relationship: 'source_dependency' }));
  const event = { kind: 'source_changed', objectKey: 'source', eventVersion: 'first', title: 'A source changed', basis: { notice: { id: 'source' }, targets } };
  const [first, replay] = await Promise.all([signals.record(project, event), signals.record(project, event)]);
  assert.equal(first.id, replay.id);
  assert.ok(first.payload.basis.targetPages.pages.length > 1);
  assert.equal(first.payload.basis.targets.length, 0);
  assert.deepEqual((await signals.detail(user, project.id, first.id)).targets, targets);
  const input = await signals.stageInput(project, { signalId: first.id, expectedSignalRevision: 1, intent: 'review', focusRefs: ['target-1199'] });
  assert.deepEqual(input.basis.event.targets, [targets[1199]]);
  assert.equal(input.basis.event.targetSelection.total, 1200);
  assert.equal(input.basis.signal.basisDigest, first.payload.basisDigest);
  const page = await documents.get(user.id, 'geo-signal', first.payload.basis.targetPages.pages[0].id);
  await documents.put(user.id, 'geo-signal', page.id, { ...page.payload, targets: page.payload.targets.slice(1) }, { projectId: project.projectId, expectedRevision: page.revision });
  await assert.rejects(signals.detail(user, project.id, first.id), error => error.code === 'geo_signal_conflict');
  await assert.rejects(signals.stageInput(project, { signalId: first.id, expectedSignalRevision: 1, intent: 'review', focusRefs: ['target-1199'] }), error => error.code === 'geo_signal_conflict');
  const next = { ...event, eventVersion: 'second' }, id = geoSignalId(project.id, next.kind, next.objectKey, next.eventVersion);
  const pack = packGeoSignalTargets(project, id, next.basis), collision = pack.pages[0];
  await documents.put(user.id, collision.kind, collision.id, collision.payload, { projectId: project.projectId, expectedRevision: 0 });
  await assert.rejects(signals.record(project, next), error => error.code === 'product_revision_conflict');
  assert.equal(await documents.get(user.id, 'geo-signal', id), null);
  assert.equal((await store.query("SELECT count(*)::int AS count FROM evimed_product.documents WHERE payload->>'signalId'=$1", [id])).rows[0].count, 1);
});

test('resolved order episodes stay complete through recurrence, ignoring and repeated checks', options, async t => {
  const { store, user, makeProject, signals } = await fixture(t);
  const project = await makeProject('orders'), discovery = new GeoSignalDiscovery({ store, signals });
  await store.query("INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state) VALUES('order','owner',$1,'problem')", [project.id]);
  const add = async (id, time, from, to, reason = null) => {
    await store.query('INSERT INTO evimed_geo.order_events(id,order_id,at,from_state,to_state,detail) VALUES($1,\'order\',$2,$3,$4,$5::jsonb)', [id, `2026-10-24T0${time}:00:00Z`, from, to, JSON.stringify({ reason })]);
    await store.query("UPDATE evimed_geo.orders SET state=$1 WHERE id='order'", [to]);
    await discovery.orders(project, (await store.query('SELECT * FROM evimed_geo.order_events WHERE id=$1', [id])).rows);
  };
  await add('first', 1, 'published', 'problem', 'text_changed');
  const first = (await signals.list(user, project.id)).items[0];
  await add('recovered', 2, 'problem', 'verified');
  await add('second', 3, 'verified', 'problem', 'text_changed');
  await add('check', 4, 'problem', 'problem', 'text_changed');
  const page = await signals.list(user, project.id);
  assert.equal(page.total, 2); assert.equal(page.actionable, 1);
  const old = await signals.detail(user, project.id, first.id);
  assert.equal(old.state, 'completed'); assert.equal(old.businessOutcome.resolutionEventId, 'recovered'); assert.equal(old.businessOutcome.currentState, 'problem');
  await signals.disposition(user, project.id, first.id, { expectedRevision: 1, requestKey: 'ignore', disposition: 'ignored' });
  assert.equal((await signals.detail(user, project.id, first.id)).state, 'ignored');
  await signals.disposition(user, project.id, first.id, { expectedRevision: 2, requestKey: 'restore', disposition: 'active' });
  assert.equal((await signals.detail(user, project.id, first.id)).state, 'completed');
  await add('unknown', 5, 'problem', 'unknown');
  const unknown = (await signals.list(user, project.id)).items.find(item => item.id !== first.id && item.businessOutcome.state === 'unknown');
  assert.ok(unknown);
  const unknownRows = await signals.all(project, 'geo-signal', { recordType: 'geo-signal' });
  const unknownId = unknownRows.find(row => row.payload.basis.eventId === 'unknown').id;
  await add('accepted', 6, 'unknown', 'accepted');
  assert.equal((await signals.detail(user, project.id, unknownId)).state, 'completed');
});

test('legacy and signal producers share the first text-change notice, preserve read state and never resend channels', options, async t => {
  const { store, database, user, makeProject, signals } = await fixture(t);
  const project = await makeProject('notices');
  for (const [id, role] of [['reviewer', 'medical_reviewer'], ['editor', 'editor'], ['viewer', 'viewer']]) {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$1,'development')", [id]);
    await store.query('INSERT INTO evimed_geo.members(geo_project_id,user_id,role) VALUES($1,$2,$3)', [project.id, id, role]);
  }
  const inbox = new NotificationService(database), sent = [];
  inbox.attachChannels({ registry: { enabledIds: () => ['fixture'] }, onChange: item => sent.push(item.id) });
  const notifier = createGeoNotifier({ notifications: inbox, store });
  const discovery = new GeoSignalDiscovery({ store, signals });
  for (const firstProducer of ['legacy', 'signal']) {
    const id = `order-${firstProducer}`;
    await store.query("INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state) VALUES($1,'owner',$2,'problem')", [id, project.id]);
    await store.query("INSERT INTO evimed_geo.order_events(id,order_id,at,from_state,to_state,detail) VALUES($1,$2,'2026-10-24T01:00:00Z','published','problem','{\"reason\":\"text_changed\"}')", [id, id]);
    await discovery.orders(project, (await store.query('SELECT * FROM evimed_geo.order_events WHERE order_id=$1', [id])).rows);
    const row = (await signals.all(project, 'geo-signal', { recordType: 'geo-signal', objectKey: id }))[0];
    assert.equal(row.payload.basis.notificationKey, `geo:order:${id}:text_changed`);
    const legacy = () => notifier.textChanged({ userId: user.id, geoProjectId: project.id, orderId: id, changed: ['Protected text'] });
    if (firstProducer === 'legacy') {
      const item = await legacy(); await inbox.markRead(user.id, item.id, item.revision);
    } else await notifier.signal(project, row);
    await notifier.signal(project, row); await legacy(); await notifier.signal(project, row);
    const notices = (await database.query("SELECT * FROM evimed_inbox.notifications WHERE source->>'id'=$1", [`${project.id}/signals/${row.id}`])).rows;
    assert.deepEqual(notices.map(item => item.user_id).sort(), ['owner', 'reviewer']);
    assert.ok(notices.every(item => item.event_count === 1));
    if (firstProducer === 'legacy') assert.ok(notices.find(item => item.user_id === user.id).read_at);
  }
  assert.equal((await database.query('SELECT count(*)::integer AS n FROM evimed_inbox.notifications')).rows[0].n, 4);
  assert.equal(sent.length, 4);
});
