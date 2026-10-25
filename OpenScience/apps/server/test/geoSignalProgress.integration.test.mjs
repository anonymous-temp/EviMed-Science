import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoSignals } from '../src/geoSignals.mjs';
import { GeoOrchestrator } from '../src/geoOrchestrator.mjs';
import { GeoGroupChanges, GROUP_CHANGE_MARK } from '../src/geoGroupChanges.mjs';
import { GeoSignalDiscovery } from '../src/geoSignalDiscovery.mjs';
import { readGeoSignalProgress, writeGeoSignalProgress } from '../src/geoSignalProgress.mjs';
import { measureRound } from '../src/geoMetricsJob.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL&&'Disposable PostgreSQL required'};
async function fixture(t, groupCount = 1, poolMax = 1){
 const isolated=await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'groupchange');
 const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:poolMax,databaseConnectionTimeoutMs:3000});
 t.after(async()=>{await database.close();await isolated.drop();});
 const store=new GeoStore({database});await store.ready();const measure=new GeoMeasureStore(database);await measure.ready();
 const user={id:'owner'};
 await store.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('owner','Owner','development')");
 await store.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('owner','control','Fixture',1048576)");
 const project=await store.createProject({userId:user.id,projectId:'control',coverageDays:90,engines:['deepseek'],product:{brandName:'Ours'}});
 await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) SELECT CASE WHEN $2=1 THEN 'g' ELSE 'g'||n END,'owner',$1,1,'P2','Group '||n FROM generate_series(1,$2)n",[project.id,groupCount]);
 await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured) SELECT 'q'||n,'owner',$1,CASE WHEN $2=1 THEN 'g' ELSE 'g'||((n-1)/40+1) END,1,'P2','Which brand '||n,true FROM generate_series(1,$3) n",[project.id,groupCount,groupCount===1?220:groupCount*40]);
 const documents=new ProductDocuments(database), service=new GeoService({store,config:{geoEnabled:true,geoAudience:'all'}});
 const runs=[];const signals=new GeoSignals({documents,store,service,runs:async()=>runs,resultForRun:async()=>({present:true})});service.signals=signals;
 async function round(id,minute,mentioned){
  await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,finished_at,surface)
    VALUES($1,'owner',$2,'baseline','done',1,'{deepseek}','2026-10-25',$3::timestamptz,$4::jsonb)`,[id,project.id,`2026-10-25T01:${minute}:00Z`,JSON.stringify({mode:'web',measurementContract:{samplingMode:'recurring',repeats:1,engines:['deepseek'],sourceBasis:'answers',reportPresentation:'summary',metricIds:['M-01','M-03']}})]);
  await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface,citations)
    SELECT $1||'-'||n,'owner',$2,$1,'q'||n,'deepseek','2026-10-25T00:00:00Z','valid',repeat('Preserved answer ',100)||n,'{"mode":"web"}','[]' FROM generate_series(1,$3)n`,[id,project.id,groupCount===1?220:groupCount*40]);
  await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,created_at,brands,mentions_ours,statements,checks,retrieval_triggered)
    SELECT $1||'-'||n,'owner',$2,'2026-10-24T00:00:00Z','2026-10-24T00:00:00Z',$3::jsonb,$4,'[{"text":"Known","verdict":"correct"}]','{"judgementCoverage":{"status":"complete"}}',true FROM generate_series(1,$5)n`,[id,project.id,JSON.stringify(mentioned?[{name:'Ours',ours:true,count:1}]:[]),mentioned,groupCount===1?220:groupCount*40]);
  await measureRound({store:measure},id);
 }
 return {database,store,measure,documents,user,project,service,signals,round,runs};
}

const ageLease = f => f.store.query("UPDATE evimed_geo.schedule_marks SET updated_at=clock_timestamp()-interval '61 seconds' WHERE geo_project_id='_platform' AND key='lease:signals'");
const markOf = async (f,key=GROUP_CHANGE_MARK) => (await f.store.query('SELECT state,attempts,detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND key=$2',[f.project.id,key])).rows[0];
function gate() {
  let reached,release;
  const waiting=new Promise(resolve=>{reached=resolve;}),resume=new Promise(resolve=>{release=resolve;});
  return {reached,release,waiting,resume};
}
const loop = f => new GeoOrchestrator({store:f.store,config:{geoLeaseMs:60000}});

test('real pool-one actual lease expiry and unchanged-state takeover both fence old pending writers',options,async t=>{
  for(const takeover of [false,true]) {
    const f=await fixture(t);await f.round('a','00',false);await f.round('b','01',true);
    const first=new GeoGroupChanges({store:f.store,signals:f.signals}),pause=gate(),original=first.mark.bind(first);
    first.mark=async(project,detail,state)=>{if(detail.pending){pause.reached();await pause.resume;}return original(project,detail,state);};
    const active=loop(f).leaseLoop('signals',()=>first.project(f.project));await pause.waiting;
    const before=await markOf(f);await ageLease(f);
    if(takeover) assert.equal((await loop(f).leaseLoop('signals',async()=> 'no project-state change')).acquired,true);
    pause.release();const result=await active;
    assert.equal(result.value.superseded,true);assert.deepEqual(await markOf(f),before);
    assert.equal(f.database.pool.waitingCount,0);assert.equal(f.database.pool.idleCount,f.database.pool.totalCount);
    const discovery=new GeoSignalDiscovery({store:f.store,signals:f.signals});
    assert.equal((await loop(f).leaseLoop('signals',()=>discovery.tick())).acquired,true);
    assert.equal((await markOf(f)).detail.roundId,'b','the new attempt resumes the already durable immutable receipt');
    assert.equal(f.database.pool.waitingCount,0);assert.equal(f.database.pool.idleCount,f.database.pool.totalCount);
  }
});

test('same-pair pending digest and round stay equal while exact group generation prevents stale index writes',options,async t=>{
  const f=await fixture(t,22);await f.round('a','00',false);await f.round('b','01',true);
  const first=new GeoGroupChanges({store:f.store,signals:f.signals}),second=new GeoGroupChanges({store:f.store,signals:f.signals}),pause=gate();
  const original=first.mark.bind(first);let held=false;
  first.mark=async(project,detail,state)=>{if(detail.pending&&detail.index===1&&!held){held=true;pause.reached();await pause.resume;}return original(project,detail,state);};
  const active=loop(f).leaseLoop('signals',()=>first.project(f.project));await pause.waiting;
  const before=await markOf(f);assert.equal(before.detail.index,0);await ageLease(f);
  await loop(f).leaseLoop('signals',()=>second.project(f.project));
  const winner=await markOf(f);assert.equal(winner.detail.index,20);assert.equal(winner.detail.roundId,before.detail.roundId);assert.equal(winner.detail.pendingDigest,before.detail.pendingDigest);
  pause.release();assert.equal((await active).value.superseded,true);assert.deepEqual(await markOf(f),winner);
  await loop(f).leaseLoop('signals',()=>second.project(f.project));assert.equal((await markOf(f)).detail.roundId,'b');
});

test('stale group and enclosing discovery failure paths cannot poison a successful owner state',options,async t=>{
  const f=await fixture(t);await f.round('a','00',false);await f.round('b','01',true);
  const first=new GeoSignalDiscovery({store:f.store,signals:f.signals}),second=new GeoSignalDiscovery({store:f.store,signals:f.signals}),pause=gate();
  first.citations=async()=>{pause.reached();await pause.resume;throw Object.assign(new Error('old source generation failed'),{code:'stale_fixture_failure'});};
  const active=loop(f).leaseLoop('signals',()=>first.tick());await pause.waiting;await ageLease(f);
  await loop(f).leaseLoop('signals',()=>second.tick());
  const winner=await markOf(f,'signals:discovery:v1');assert.equal(winner.state,'done');assert.equal(winner.detail.lastError,null);
  pause.release();assert.deepEqual((await active).value,{projects:0,failed:0});assert.deepEqual(await markOf(f,'signals:discovery:v1'),winner);
  // Same concrete catch path for an old group input failure before its pending mark.
  await f.round('c','02',false);
  const group=new GeoGroupChanges({store:f.store,signals:f.signals}),newGroup=new GeoGroupChanges({store:f.store,signals:f.signals}),groupPause=gate(),original=group.mark.bind(group);let held=false;
  group.mark=async(project,detail,state)=>{if(detail.pending&&state!=='failed'&&!held){held=true;groupPause.reached();await groupPause.resume;throw new Error('old group input failed');}return original(project,detail,state);};
  const old=loop(f).leaseLoop('signals',()=>group.project(f.project));await groupPause.waiting;await ageLease(f);
  await loop(f).leaseLoop('signals',()=>newGroup.project(f.project));const groupWinner=await markOf(f);
  groupPause.release();assert.equal((await old).value.superseded,true);assert.deepEqual(await markOf(f),groupWinner);
});

test('a new token of the same orchestrator owner survives the old acquisition finally',options,async t=>{
  const f=await fixture(t),owner=loop(f),first=gate(),second=gate();
  const old=owner.leaseLoop('signals',async()=>{first.reached();await first.resume;});await first.waiting;
  const read=async()=>(await f.store.query("SELECT state,detail FROM evimed_geo.schedule_marks WHERE geo_project_id='_platform' AND key='lease:signals'")).rows[0];
  const initial=await read();await ageLease(f);
  const current=owner.leaseLoop('signals',async()=>{second.reached();await second.resume;});await second.waiting;
  const replacement=await read();assert.equal(replacement.detail.owner,initial.detail.owner);assert.notEqual(replacement.detail.token,initial.detail.token);
  first.release();await old;assert.deepEqual(await read(),replacement);
  second.release();await current;assert.equal((await read()).state,'done');
});

test('direct trusted calls use full read-generation CAS, reject absent-row collisions and release pool-one after failure',options,async t=>{
  const f=await fixture(t),key='signals:discovery:v1';
  const older=await readGeoSignalProgress(f.store,f.project,key),newer=await readGeoSignalProgress(f.store,f.project,key);
  const updated=await writeGeoSignalProgress(f.store,f.project,key,{...newer,snapshotId:'winner'},'done',new Date());
  await assert.rejects(writeGeoSignalProgress(f.store,f.project,key,{...older,snapshotId:'old'},'failed',new Date()),e=>e.code==='geo_signal_progress_superseded');
  const winner=await markOf(f,key);assert.equal(winner.attempts,1);
  const reset=await writeGeoSignalProgress(f.store,f.project,key,{...updated,snapshotId:'same business fields'},'done',new Date());
  const restored=await writeGeoSignalProgress(f.store,f.project,key,{...reset,snapshotId:'winner'},'done',new Date());
  await assert.rejects(writeGeoSignalProgress(f.store,f.project,key,{...updated,snapshotId:'stale same detail'},'failed',new Date()),e=>e.code==='geo_signal_progress_superseded');
  assert.equal((await markOf(f,key)).attempts,3);assert.equal(restored.snapshotId,'winner');
  assert.equal((await f.store.query('SELECT 1 AS ok')).rows[0].ok,1);assert.equal(f.database.pool.waitingCount,0);assert.equal(f.database.pool.idleCount,f.database.pool.totalCount);
});

test('old final completion and detached callbacks retain no progress authority after takeover or loop close',options,async t=>{
  const f=await fixture(t);await f.round('a','00',false);await f.round('b','01',true);
  const first=new GeoGroupChanges({store:f.store,signals:f.signals}),second=new GeoGroupChanges({store:f.store,signals:f.signals}),pause=gate(),original=first.mark.bind(first);
  first.mark=async(project,detail,state)=>{if(detail.lastPair&&detail.roundId==='b'&&!detail.pending){pause.reached();await pause.resume;}return original(project,detail,state);};
  const active=loop(f).leaseLoop('signals',()=>first.project(f.project));await pause.waiting;await ageLease(f);
  await loop(f).leaseLoop('signals',()=>second.project(f.project));const winner=await markOf(f);
  pause.release();assert.equal((await active).value.superseded,true);assert.deepEqual(await markOf(f),winner);
  const detached=gate();let writing;
  await loop(f).leaseLoop('signals',async()=>{
    const current=await readGeoSignalProgress(f.store,f.project,GROUP_CHANGE_MARK);
    writing=Promise.resolve().then(async()=>{detached.reached();await detached.resume;return writeGeoSignalProgress(f.store,f.project,GROUP_CHANGE_MARK,{...current,lastError:'detached'},'failed',new Date());});
    // Attach rejection handling before allowing this deliberately detached callback to continue.
    writing.catch(()=>{});await detached.waiting;
  });
  detached.release();await assert.rejects(writing,e=>e.code==='geo_signal_progress_superseded');assert.deepEqual(await markOf(f),winner);
});

import { setImmediate as tick } from 'node:timers/promises';
async function until(predicate){const end=Date.now()+2000;while(!predicate()){assert.ok(Date.now()<end,'pool transition timed out');await tick();}}
test('independent lease expiry between lock admission and mark mutation is rechecked under pool one',options,async t=>{
 const f=await fixture(t),key='signals:discovery:v1',original=f.store.transaction.bind(f.store);let delayed=false;
 f.store.transaction=work=>original(async client=>work({query:async(sql,values)=>{
  if(sql.startsWith('INSERT INTO evimed_geo.schedule_marks')&&sql.includes("'notice'")&&!delayed){delayed=true;await client.query('SELECT pg_sleep(0.30)');}
  return client.query(sql,values);
 }}));
 await loop(f).leaseLoop('signals',async()=>{
  const current=await readGeoSignalProgress(f.store,f.project,key);
  await f.store.query("UPDATE evimed_geo.schedule_marks SET updated_at=clock_timestamp()-interval '59.85 seconds' WHERE geo_project_id='_platform' AND key='lease:signals'");
  await assert.rejects(writeGeoSignalProgress(f.store,f.project,key,{...current,snapshotId:'must not persist'},'done',new Date()),e=>e.code==='geo_signal_progress_superseded');
 });
 assert.equal(delayed,true);assert.equal(await markOf(f,key),undefined);assert.equal(f.database.pool.waitingCount,0);assert.equal(f.database.pool.idleCount,f.database.pool.totalCount);
});
test('independent detached write queued before loop closure must revalidate active scope after pool checkout',options,async t=>{
 const f=await fixture(t),key='signals:discovery:v1',held=gate(),returned=gate();let holder,writing;
 const active=loop(f).leaseLoop('signals',async()=>{
  const current=await readGeoSignalProgress(f.store,f.project,key);
  holder=f.database.withClient(async()=>{held.reached();await held.resume;});await held.waiting;
  writing=writeGeoSignalProgress(f.store,f.project,key,{...current,snapshotId:'closed-scope'},'done',new Date());writing.catch(()=>{});
  await until(()=>f.database.pool.waitingCount===1);returned.reached();
 });
 await returned.waiting;
 await until(()=>f.database.pool.waitingCount===2); // progress transaction followed by actual old finally release.
 held.release();await holder;await active;
 const observed=await markOf(f,key);
 await assert.rejects(writing,e=>e.code==='geo_signal_progress_superseded');
 assert.equal(observed,undefined);assert.equal(f.database.pool.waitingCount,0);assert.equal(f.database.pool.idleCount,f.database.pool.totalCount);
});
