import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { GeoSignals } from '../src/geoSignals.mjs';
import { GeoPlanContext, freezeGeoPlanBasis, geoPlanDigest } from '../src/geoPlanContext.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
async function fixture(t) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'geobasisjson');
  let database;
  t.after(async () => { await database?.close(); await isolated.drop(); });
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  const user = { id: 'basis-owner' }, store = new GeoStore({ database }); await store.ready();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Basis fixture','development')", [user.id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'p','Basis fixture',1048576)", [user.id]);
  const project = await store.createProject({ userId: user.id, projectId: 'p', engines: ['deepseek'], coverageDays: 90 });
  await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,engines,sample_date,finished_at) VALUES('dated-round',$1,$2,'baseline','done','{deepseek}','2026-10-20',now())", [user.id, project.id]);
  // The round heard an answer: one that heard none is never the latest reading a plan freezes (2026-10-25).
  await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,engine,asked_at,status) VALUES('dated-answer',$1,$2,'dated-round','deepseek','2026-10-20T01:00:00Z','valid')", [user.id, project.id]);
  const documents = new ProductDocuments(database), service = new GeoService({ store, config: { geoEnabled: true, geoAudience: 'all' } });
  const adapter = new GeoPlanContext({ documents, store, service, authorizeSession: async () => {}, runs: async () => [] });
  return { user, project, store, documents, adapter, service };
}

test('a PostgreSQL Date is serialized before the frozen basis is hashed or stored', options, async t => {
  const f = await fixture(t);
  const raw = (await f.store.query("SELECT sample_date FROM evimed_geo.rounds WHERE id='dated-round'")).rows[0].sample_date;
  assert.ok(raw instanceof Date, 'exercise the real node-postgres date representation');
  const { basis } = await freezeGeoPlanBasis(f.store, f.project, { round: 'dated-round' });
  assert.equal(basis.readings.selected.rounds[0].date, raw.toJSON());
  assert.equal(geoPlanDigest(basis), geoPlanDigest(JSON.parse(JSON.stringify(basis))));
  const staged = await f.adapter.stage(f.user, f.project.id, { requestKey: 'round-trip', sessionId: 'native-session', mode: 'strategy' });
  const row = await f.adapter.resolve(f.user, f.project, staged.referenceId);
  assert.equal(row.payload.basisDigest, geoPlanDigest(row.payload.basis));
});

test('fresh signal bases use their persisted JSON identity while legacy recorded digests are preserved on retry', options, async t => {
  const f = await fixture(t), date = new Date('2026-10-20T01:02:03.000Z');
  f.service.signals = new GeoSignals({ store: f.store, documents: f.documents, service: f.service, runs: async () => [] });
  f.service.signals.stageInput = async () => ({ basis: { handlingKey: 'signal-json', capturedAt: date, nested: [date] }, draft: 'Review the preserved input' });
  const signal = await f.adapter.stage(f.user, f.project.id, { requestKey: 'signal-key', sessionId: 'native-session', mode: 'signal' });
  const signalRow = await f.adapter.resolve(f.user, f.project, signal.referenceId);
  assert.equal(signalRow.payload.basisDigest, geoPlanDigest(signalRow.payload.basis));
  assert.equal(signalRow.payload.basis.nested[0], date.toJSON());
  const body = { requestKey: 'legacy-key', sessionId: 'native-session', mode: 'strategy' };
  const staged = await f.adapter.stage(f.user, f.project.id, body);
  const row = await f.adapter.resolve(f.user, f.project, staged.referenceId);
  const typedBasis = structuredClone(row.payload.basis);
  typedBasis.readings.selected.rounds[0].date = new Date(typedBasis.readings.selected.rounds[0].date);
  const legacy = await f.documents.put(f.user.id, 'geo-plan-context', row.id, { ...row.payload, basisDigest: geoPlanDigest(typedBasis) },
    { projectId: 'p', expectedRevision: row.revision });
  assert.notEqual(legacy.payload.basisDigest, geoPlanDigest(legacy.payload.basis), 'represent the exact historical serialization defect');
  await f.adapter.stage(f.user, f.project.id, body);
  assert.deepEqual(await f.adapter.resolve(f.user, f.project, row.id), legacy, 'an existing receipt is not rewritten or re-certified');
});


test('browsing a selected historical group does not freeze an oversized planning payload', options, async t => {
  const f = await fixture(t);
  for (const version of [1, 2]) {
    await f.store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES($1,$2,$3,$4,'P2',$5)", [`basis-g${version}`, f.user.id, f.project.id, version, `Version ${version}`]);
    await f.store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,text,pool) VALUES($1,$2,$3,$4,$5,'Synthetic question','P2')", [`basis-q${version}`, f.user.id, f.project.id, `basis-g${version}`, version]);
  }
  await f.store.query("UPDATE evimed_geo.rounds SET set_version=1 WHERE id='dated-round'");
  await f.store.query("UPDATE evimed_geo.snapshots SET question_id='basis-q1' WHERE id='dated-answer'");
  const originalTargets = f.store.latestTargets.bind(f.store);
  f.store.latestTargets = async (...args) => ({ ...await originalTargets(...args), rows: [{ note: 'x'.repeat(210000) }] });
  await assert.rejects(freezeGeoPlanBasis(f.store, f.project, { round: 'dated-round' }), error => error.code === 'geo_plan_basis_too_large');
  const originalStrategy = f.service.spine.strategy.bind(f.service.spine);
  f.service.spine.strategy = async (spine, ...args) => ({ ...await originalStrategy(spine, ...args), selectedGroups: spine.groups.map(group => ({ id: group.id, setVersion: group.setVersion ?? group.set_version })) });
  const read = await f.service.strategy(f.user, f.project.id, { round: 'dated-round' });
  assert.equal(read.readingsKind, 'selected_current');
  assert.equal(read.basis, null);
  assert.deepEqual(read.selectedGroups, [{ id: 'basis-g1', setVersion: 1 }]);
  assert.ok(!read.selectedGroups.some(group => group.id === 'basis-g2'));
  await assert.rejects(f.service.strategy({ id: 'another-owner' }, f.project.id, { round: 'dated-round' }), error => error.status === 404 || error.status === 403);
});

test('an empty selected question catalogue does not fall back to live project groups', options, async t => {
  const f = await fixture(t);
  await f.store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES('unselected-current',$1,$2,2,'P2','Unselected live group')", [f.user.id, f.project.id]);
  const originalStrategy = f.service.spine.strategy.bind(f.service.spine);
  f.service.spine.strategy = async (spine, ...args) => ({ ...await originalStrategy(spine, ...args), selectedGroups: spine.groups.map(group => group.id) });
  const read = await f.service.strategy(f.user, f.project.id, { round: 'dated-round' });
  assert.deepEqual(read.selectedGroups, []);
});
