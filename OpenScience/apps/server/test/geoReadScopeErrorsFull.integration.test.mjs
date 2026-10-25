import assert from 'node:assert/strict';
import test from 'node:test';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {GeoStore} from '../src/geoStore.mjs';
import {GeoMeasureStore} from '../src/geoMeasureStore.mjs';
import {readGeoSelectionErrors} from '../src/geoReadScope.mjs';
import {createGeoTestDatabase} from './helpers/geoTestDatabase.mjs';
import {seedGeoProject} from './helpers/geoMeasureFixtures.mjs';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL};
async function fixture(t){
 const isolated=await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'geofullerrors');
 const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:3,databaseConnectionTimeoutMs:2000});
 t.after(async()=>{await database.close();await isolated.drop();});
 const store=new GeoStore({database});await store.ready();await new GeoMeasureStore(database).ready();
 for(const owner of ['one','two']){
  await seedGeoProject(database,{id:'geo-'+owner,userId:owner,projectId:'control-'+owner,engines:['deepseek'],groups:[{id:'group-'+owner,pool:'P2'}],questions:[{id:'question-'+owner,groupId:'group-'+owner,text:'Question'}]});
  await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,ref) VALUES($1,$2,$3,'baseline','done',1,'{deepseek}',$4::jsonb)",['round-'+owner,owner,'geo-'+owner,JSON.stringify({evaluationBasis:{claims:[{id:'claim-'+owner,statement:owner+' preserved claim'}]}})]);
  await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,answer_text) VALUES($1,$2,$3,$4,$5,'deepseek','valid',$6)",['snapshot-'+owner,owner,'geo-'+owner,'round-'+owner,'question-'+owner,owner+' answer']);
  await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,statements) VALUES($1,$2,$3,$4::jsonb)",['snapshot-'+owner,owner,'geo-'+owner,JSON.stringify([{text:owner+' preserved statement',verdict:'wrong'}])]);
 }
 return {store,project:{id:'geo-one',userId:'one',projectId:'control-one'},selected:{rows:[{snapshotId:'snapshot-one'}]}};
}
async function errors(store,count){
 await store.query(`INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,error_type,severity,statement)
 SELECT 'error-'||n,'one','geo-one','fingerprint-'||n,'deepseek','question-one','snapshot-one','snapshot-one',CASE WHEN n=$1 THEN 'dropped_condition' ELSE 'number' END,'S1','Preserved error '||n FROM generate_series(1,$1::integer)n`,[count]);
}
test('full error admission retains the rare last object beyond the ordinary 500-row page',options,async t=>{
 const f=await fixture(t);await errors(f.store,620);
 const page=await readGeoSelectionErrors(f.store,f.project,f.selected,{errorLimit:500,errorJudgmentState:'active'});
 assert.equal(page.rows.length,500);assert.equal(page.counts.total,620);
 const all=await readGeoSelectionErrors(f.store,f.project,f.selected,{errorJudgmentState:'active'},{allRows:true});
 assert.equal(all.rows.length,620);assert.equal(all.page.more,false);assert.ok(all.rows.some(row=>row.id==='error-620'&&row.error_type==='dropped_condition'));
 const empty=await readGeoSelectionErrors(f.store,f.project,{rows:[]},{},{allRows:true});assert.equal(empty.rows.length,0);
});
test('error aggregates and origin evidence refuse inconsistent foreign question/snapshot references',options,async t=>{
 const f=await fixture(t);
 await f.store.query(`INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,error_type,severity)
 VALUES('foreign-links','one','geo-one','foreign-links','deepseek','question-two','snapshot-two','snapshot-one','number','S1')`);
 const all=await readGeoSelectionErrors(f.store,f.project,f.selected,{}, {allRows:true});
 assert.equal(all.rows.length,1);assert.equal(all.rows[0].origin_statements,null);assert.equal(all.rows[0].origin_claims,null);
 assert.equal(all.summary.byGroup['group-two'],undefined);
 assert.equal(JSON.stringify(all).includes('two preserved'),false);
});
test('full error admission refuses breadth before exposing a truncated analytical population',options,async t=>{
 const f=await fixture(t);await errors(f.store,20001);
 await assert.rejects(readGeoSelectionErrors(f.store,f.project,f.selected,{}, {allRows:true}),error=>error.status===422&&error.code==='geo_read_filter_invalid');
});

test('addressed error groups are exact before pagination and preserve legacy grouping precedence',options,async t=>{
 const f=await fixture(t);await errors(f.store,620);
 const exact=await readGeoSelectionErrors(f.store,f.project,f.selected,{errorFingerprint:'fingerprint-620'});
 assert.match(exact.page.populationRevision,/^[a-f0-9]{32}$/u);
 await f.store.query("UPDATE evimed_geo.errors SET statement='Changed with the same count' WHERE id='error-620'");
 const changed=await readGeoSelectionErrors(f.store,f.project,f.selected,{errorFingerprint:'fingerprint-620'});
 assert.notEqual(changed.page.populationRevision,exact.page.populationRevision);
 assert.equal(exact.rows.length,1);assert.equal(exact.rows[0].id,'error-620');
 await f.store.query("INSERT INTO evimed_geo.claims(id,user_id,geo_project_id,claim_key,statement,quote,source_ref) VALUES('legacy-claim','one','geo-one','legacy','Claim','Quote','label:old')");
 await f.store.query(`INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,claim_id,error_type,severity)
 VALUES('legacy-row','one','geo-one','','deepseek','question-one','snapshot-one','snapshot-one','legacy-claim','number','S1'),
 ('shadow-row','one','geo-one','present-fingerprint','deepseek','question-one','snapshot-one','snapshot-one','legacy-claim','number','S1')`);
 const legacy=await readGeoSelectionErrors(f.store,f.project,f.selected,{errorFingerprint:'legacy-claim'});
 assert.deepEqual(legacy.rows.map(row=>row.id),['legacy-row'],'A present different fingerprint takes precedence over the claim alias');
 for(const invalid of ['',42,'bad\nkey','x'.repeat(241)])await assert.rejects(readGeoSelectionErrors(f.store,f.project,f.selected,{errorFingerprint:invalid}),error=>error.status===400);
});
