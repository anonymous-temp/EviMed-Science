import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { readGeoSelection } from '../src/geoReadScope.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };

test('a database access-plan change cannot invalidate identical selected question contents', options, async t => {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'geoselectionorder');
  let database;
  t.after(async () => { await database?.close(); await isolated.drop(); });
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 2000 });
  const store = new GeoStore({ database }), measure = new GeoMeasureStore(database); await measure.ready(); await store.ready();
  const owner = 'ordering-owner';
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Ordering fixture','development')", [owner]);
  const project = await store.createProject({ userId: owner, projectId: 'ordering-project', engines: ['deepseek'], coverageDays: 30 });
  await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES('order-g',$1,$2,1,'P2','Group')", [owner, project.id]);
  await store.query(`INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured)
    VALUES('q-first',$1,$2,'order-g',1,'P2','First question',true),('q-second',$1,$2,'order-g',1,'P2','Second question',true)`, [owner, project.id]);
  await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,surface)
    VALUES('order-r',$1,$2,'baseline','done',1,'{deepseek}','{"mode":"web"}')`, [owner, project.id]);
  for (const question of ['q-first', 'q-second']) await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface)
    VALUES($1,$2,$3,'order-r',$4,'deepseek','2026-10-01','valid','Original answer','{"mode":"web"}')`, [`s-${question}`, owner, project.id, question]);
  // A real HOT update moves the visible tuple while its index entry stays in
  // place. Restoring the text restores every selected field, not tuple order.
  await store.query("UPDATE evimed_geo.questions SET text='Temporary edit' WHERE id='q-first'");
  await store.query("UPDATE evimed_geo.questions SET text='First question' WHERE id='q-first'");
  await database.query('ANALYZE evimed_geo.questions');
  const ids = async () => (await store.query('SELECT id FROM evimed_geo.questions WHERE geo_project_id=$1 AND user_id=$2', [project.id, owner])).rows.map(row => row.id);
  try {
    // Only this test's one connection is changed; reset in finally. Both
    // ordinary PostgreSQL execution paths run against the same actual rows.
    await database.query('SET enable_seqscan=off'); await database.query('SET enable_bitmapscan=off');
    const indexedIds = await ids();
    const selected = await readGeoSelection(store, project, { round: 'order-r', groupIds: ['order-g'] });
    await database.query('SET enable_seqscan=on'); await database.query('SET enable_indexscan=off');
    await database.query('ANALYZE evimed_geo.questions');
    const sequentialIds = await ids();
    assert.notDeepEqual(sequentialIds, indexedIds, 'the control must actually exercise different unordered tuple sequences');
    const same = await readGeoSelection(store, project, { selectionRef: selected.selection.reference });
    assert.equal(same.selection.reference, selected.selection.reference);
    assert.equal(same.selection.dataRevision, selected.selection.dataRevision);
    await store.query("UPDATE evimed_geo.questions SET text='A real changed question' WHERE id='q-first'");
    await assert.rejects(readGeoSelection(store, project, { selectionRef: selected.selection.reference }), error => error.status === 409);
  } finally {
    await database.query('RESET enable_seqscan'); await database.query('RESET enable_indexscan'); await database.query('RESET enable_bitmapscan');
  }
});
