import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { readGeoValueCoverage } from '../src/geoValueStore.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'Disposable local Postgres required' };
let isolated, database, store, project, other;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'value_selected');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  store = new GeoStore({ database }); await store.ready(); await new GeoMeasureStore(database).ready();
  project = await store.createProject({ userId: 'value-owner', projectId: 'value-project', engines: ['deepseek'], coverageDays: 90 });
  other = await store.createProject({ userId: 'other-owner', projectId: 'other-project', engines: ['deepseek'], coverageDays: 90 });
  for (const [scope, round, at] of [[project, 'old', '2026-10-01'], [project, 'new', '2026-10-02'], [other, 'foreign', '2026-10-03']]) {
    await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,created_at) VALUES($1,$2,$3,'baseline','done',$4)", [round, scope.userId, scope.id, at]);
    await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,engine,asked_at,answer_text) VALUES($1,$2,$3,$4,'deepseek',$5,'Preserved answer.')", ['s-'+round, scope.userId, scope.id, round, at]);
    const entries = Array.from({length:round === 'old' ? 37 : 1}, (_,n) => ({findingId:'f-'+round+'-'+n,status:n===36?'not_addressed':'represented',quote:'Preserved answer.'}));
    await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,judge_extract,checks) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)", ['s-'+round,scope.userId,scope.id,at,JSON.stringify({valueBasisVersion:round==='old'?1:2,valueCoverage:entries}),JSON.stringify({judgementCoverage:{status:'partial'}})]);
  }
});
after(async () => { await database?.close(); await isolated?.drop(); });
test('selected value observations retain all exact old members and partial absence without latest-round substitution', options, async () => {
  const selected = { rows: [{snapshotId:'s-old'}] };
  const read = await readGeoValueCoverage(store,project.id,{}, {project,selected});
  assert.equal(read.counts.reduce((sum,row)=>sum+row.n,0),37);
  assert.equal(read.observations.length,37);
  assert.equal(read.sample.length,20);
  assert.equal(new Set(read.observations.map(row=>row.id)).size,37);
  assert.ok(read.observations.every(row=>row.snapshotId==='s-old'&&row.roundId==='old'&&row.basisVersion===1));
  const last = read.observations.find(row=>row.findingId==='f-old-36');
  assert.deepEqual([last.status,last.recordedStatus,last.judgementCoverage.status],['uncertain','not_addressed','partial']);
  assert.equal(last.position,37);
  assert.equal((await readGeoValueCoverage(store,project.id)).sample[0].roundId,'new');
});
test('selected value admission keeps empty empty and never admits other owners or projects',options,async()=>{
  const empty=await readGeoValueCoverage(store,project.id,{}, {project,selected:{rows:[]}});
  assert.deepEqual([empty.counts,empty.sample,empty.observations],[[],[],[]]);
  const foreign=await readGeoValueCoverage(store,project.id,{}, {project,selected:{rows:[{snapshotId:'s-foreign'}]}});
  assert.deepEqual([foreign.counts,foreign.observations],[[],[]]);
  await assert.rejects(readGeoValueCoverage(store,project.id,{}, {project:other,selected:{rows:[{snapshotId:'s-old'}]}}),error=>error.status===422);
  await assert.rejects(readGeoValueCoverage(store,project.id,{}, {selected:{rows:[]}}),error=>error.status===422);
});
test('expanded selected observations fail visibly instead of exporting a truncated preview',options,async()=>{
  await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,engine,asked_at,answer_text) SELECT 'wide-'||n,$1,$2,'old','deepseek','2026-10-01','Preserved answer.' FROM generate_series(1,334)n",[project.userId,project.id]);
  const entries=Array.from({length:60},(_,n)=>({findingId:'wide-'+n,status:'represented',quote:'Preserved answer.'}));
  await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,judge_extract) SELECT 'wide-'||n,$1,$2,'2026-10-01',$3::jsonb FROM generate_series(1,334)n",[project.userId,project.id,JSON.stringify({valueBasisVersion:1,valueCoverage:entries})]);
  const selected={rows:Array.from({length:334},(_,n)=>({snapshotId:'wide-'+(n+1)}))};
  await assert.rejects(readGeoValueCoverage(store,project.id,{}, {project,selected}),error=>error.status===422&&error.message.includes('20,000 finding observations'));
});
