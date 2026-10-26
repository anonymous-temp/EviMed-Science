import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore, canonicalJson } from '../src/geoStore.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoSignals } from '../src/geoSignals.mjs';
import { GeoGroupChanges, GROUP_CHANGE_MARK, readGeoRoundComparison, groupChangeEvents } from '../src/geoGroupChanges.mjs';
import { GeoSignalDiscovery } from '../src/geoSignalDiscovery.mjs';
import { GeoSignalInputs } from '../src/geoSignalInputs.mjs';
import { GeoPlanContext, geoPlanDigest } from '../src/geoPlanContext.mjs';
import { measureRound } from '../src/geoMetricsJob.mjs';
import { readGeoGroupChangeMembers } from '../src/geoSignalTargets.mjs';
import { readGeoSelection } from '../src/geoReadScope.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL&&'Disposable PostgreSQL required'};
async function fixture(t, groupCount = 1){
 const isolated=await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'groupchange');
 const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:3000});
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
 return {store,measure,documents,user,project,service,signals,round,runs};
}
test('actual same-day adjacent producer freezes both complete cohorts through retries and native pages',options,async t=>{
 const f=await fixture(t),{store,documents,user,project,signals,service,round,runs}=f;
 await round('a','00',false);await round('b','01',true);await round('c','02',false);
 await assert.rejects(readGeoRoundComparison(store,project,{previousRoundId:'a',currentRoundId:'c'}),e=>e.code==='geo_group_change_pair_not_adjacent');
 const producer=new GeoGroupChanges({store,signals});
 const original=signals.record.bind(signals);let crash=true;
 signals.record=async(...args)=>{const result=await original(...args);if(crash){crash=false;throw Error('crash after event insert');}return result;};
 await assert.rejects(producer.project(project),/crash after event insert/);
 await producer.project(project);await producer.project(project);
 const events=(await documents.list(user.id,'geo-signal',{projectId:project.projectId,limit:100,filter:{recordType:'geo-signal',kind:'group_changed'}})).items;
 assert.equal(events.length,2);assert.deepEqual(events.map(r=>[r.payload.basis.previous.id,r.payload.basis.current.id]).sort(),[['a','b'],['b','c']]);
 const event=events.find(r=>r.payload.basis.current.id==='b');
 assert.equal(event.payload.basis.policy.noiseMeasured,false);assert.ok(event.payload.basis.sides.before.targetPages.pages.length>1);
 for(const side of ['before','after']){
  const all=[];let offset=0,page;
  do{page=await readGeoGroupChangeMembers(documents,project,event,{side,offset,limit:50});all.push(...page.items);offset=page.nextOffset;}while(page.more);
  assert.equal(all.length,220);assert.ok(all.every(r=>r.side===side&&r.preservedAnswer.text.includes('Preserved answer')&&r.preservedQuestion.text.startsWith('Which brand')));
 }
 const pair=await readGeoRoundComparison(store,project,{previousRoundId:'a',currentRoundId:'b'});
 assert.equal(groupChangeEvents(pair).events[0].eventVersion,event.payload.eventVersion);
 const contexts=new GeoPlanContext({store,service,documents});
 const staged=await contexts.stageSignal(user,project,{mode:'signal',sessionId:'session',requestKey:'stage',signalId:event.id,expectedSignalRevision:1,intent:'analyse'});
 let ctx=await documents.get(user.id,'geo-plan-context',staged.referenceId);
 assert.equal(ctx.payload.state,'staged');assert.ok(Buffer.byteLength(canonicalJson(ctx.payload.basis))<200000);
 await store.query("UPDATE evimed_geo.snapshots SET answer_text='Changed current answer' WHERE round_id='a'");
 await assert.rejects(readGeoSelection(store,project,{selectionRef:pair.previous.selection.reference}),e=>e.status===409);
 for(const side of ['before','after']){
  let offset=0,total=0,page;
  do{page=await signals.members(user,project.id,event.id,{side,offset,limit:20,expectedBasisDigest:event.payload.basisDigest});total+=page.items.length;offset=page.nextOffset;}while(page.more);
  assert.equal(total,220,'Public frozen paging survives stale live selection');
 }
 await assert.rejects(signals.members({id:'foreign'},project.id,event.id,{side:'before',expectedBasisDigest:event.payload.basisDigest}),error=>error.status===404);
 for(const bad of [{side:'other'},{offset:-1},{limit:51},{expectedBasisDigest:'f'.repeat(64)},{round:'latest'},{metricKey:'outside'}])await assert.rejects(signals.members(user,project.id,event.id,{side:'before',expectedBasisDigest:event.payload.basisDigest,...bad}));
 await documents.put(user.id,'geo-plan-context',ctx.id,{...ctx.payload,state:'bound',requestId:'request'},{projectId:project.projectId,expectedRevision:ctx.revision});
 const native=new GeoSignalInputs({contexts,service,store});
 for(const side of ['before','after']){
  let offset=0,total=0,page;
  do{page=await native.read(project,{planContextRef:ctx.id,targetKey:side,offset,limit:50});total+=page.items.length;offset=page.nextOffset;}while(page.more);
  assert.equal(total,220);
 }
 await assert.rejects(native.read(project,{planContextRef:ctx.id,targetKey:'target-source'}),e=>e.status===404);
 runs.push({id:'run',sessionId:'session',kernelRequestIds:['request'],status:'succeeded'});
 const detail=await signals.detail(user,project.id,event.id);
 assert.equal(detail.businessOutcome.state,'observed');assert.equal(detail.state,'completed');
 await store.query("UPDATE evimed_geo.question_groups SET name='Renamed' WHERE id='g'");
 await producer.project(project);assert.equal((await documents.list(user.id,'geo-signal',{projectId:project.projectId,filter:{recordType:'geo-signal'}})).items.length,2);
 const pageId=event.payload.basis.sides.after.targetPages.pages[0].id,saved=await documents.get(user.id,'geo-signal',pageId);
 await documents.put(user.id,'geo-signal',pageId,{...saved.payload,targets:saved.payload.targets.slice(1)},{projectId:project.projectId,expectedRevision:saved.revision});
 await assert.rejects(native.read(project,{planContextRef:ctx.id,targetKey:'after'}),e=>e.code==='geo_signal_conflict');
 assert.equal((await signals.detail(user,project.id,event.id)).groupMembers.after.availability,'unknown');
 ctx=await documents.get(user.id,'geo-plan-context',ctx.id);
 const changed={...ctx.payload.basis,event:{...ctx.payload.basis.event,sides:{before:ctx.payload.basis.event.sides.after,after:ctx.payload.basis.event.sides.before}}};
 await documents.put(user.id,'geo-plan-context',ctx.id,{...ctx.payload,basis:changed,basisDigest:geoPlanDigest(changed)},{projectId:project.projectId,expectedRevision:ctx.revision});
 await assert.rejects(native.read(project,{planContextRef:ctx.id,targetKey:'before'}),e=>e.status===404);
});
test('incompatible intermediate rounds and stale metrics do not skip to a convenient comparison',options,async t=>{
 const {store,project,signals,round,documents,user}=await fixture(t);
 await round('a','00',false);await round('b','01',true);await round('c','02',true);
 await store.query("UPDATE evimed_geo.rounds SET ref=jsonb_set(ref,'{balance,methodVersion}','\"unsupported\"') WHERE id='b'");
 const producer=new GeoGroupChanges({store,signals});await producer.project(project);await producer.project(project);
 assert.equal((await documents.list(user.id,'geo-signal',{projectId:project.projectId,filter:{recordType:'geo-signal'}})).items.length,0);
 assert.equal((await store.query('SELECT detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND key=$2',[project.id,GROUP_CHANGE_MARK])).rows[0].detail.roundId,'c');
 await round('d','03',false);await store.query("UPDATE evimed_geo.facts SET reparsed_at=now()+interval '1 minute' WHERE snapshot_id='d-1'");
 await assert.rejects(producer.project(project),e=>e.code==='geo_group_change_not_ready');
 const mark=(await store.query('SELECT detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND key=$2',[project.id,GROUP_CHANGE_MARK])).rows[0].detail;
 assert.equal(mark.roundId,'c');
 // Other discovery work still reconciles and its durable mark rotates even when this producer retries.
 const discovery=new GeoSignalDiscovery({store,signals});await assert.rejects(discovery.project(project),e=>e.code==='geo_group_change_not_ready');
 assert.ok((await store.query("SELECT 1 FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND key='signals:discovery:v1'",[project.id])).rows.length);
});


test('a pending pair never mixes rejudged generations while processing more than one group batch',options,async t=>{
 const {store,project,signals,round,documents,user}=await fixture(t,22);
 await round('a','00',false);await round('b','01',true);
 const evaluated=groupChangeEvents(await readGeoRoundComparison(store,project,{previousRoundId:'a',currentRoundId:'b'}));
 assert.equal(evaluated.events.length,22,JSON.stringify(evaluated.reasons));
 const producer=new GeoGroupChanges({store,signals});await producer.project(project);
 let mark=(await store.query('SELECT detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND key=$2',[project.id,GROUP_CHANGE_MARK])).rows[0].detail;
 assert.equal(mark.index,20);assert.ok(mark.pending);
 const receipt=await documents.get(user.id,'geo-signal',mark.pending);
 assert.equal(receipt.payload.entries.length,22);
 await store.query("UPDATE evimed_geo.snapshots SET answer_text='Later generation' WHERE round_id='b'");
 await store.query("UPDATE evimed_geo.facts SET brands='[]',reparsed_at=now()+interval '1 minute' WHERE snapshot_id LIKE 'b-%'");
 await producer.project(project);
 const events=(await documents.list(user.id,'geo-signal',{projectId:project.projectId,limit:100,filter:{recordType:'geo-signal',kind:'group_changed'}})).items;
 assert.equal(events.length,22);assert.ok(events.every(event=>event.payload.basis.cells[0].delta===100));
 for(const event of events){const page=await readGeoGroupChangeMembers(documents,project,event,{side:'after',limit:50});assert.equal(page.total,40);assert.ok(page.items.every(member=>member.preservedAnswer.text.includes('Preserved answer')));}
 mark=(await store.query('SELECT detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND key=$2',[project.id,GROUP_CHANGE_MARK])).rows[0].detail;
 assert.equal(mark.roundId,'b');assert.equal(mark.pending,undefined);
 await assert.rejects(readGeoGroupChangeMembers(documents,{...project,projectId:'unrelated'},events[0],{side:'before'}),e=>e.code==='geo_signal_conflict');
 await assert.rejects(readGeoRoundComparison(store,{...project,projectId:'unrelated'},{previousRoundId:'a',currentRoundId:'b'}),e=>e.code==='geo_group_change_not_ready');
});


test('first round, unsupported surfaces and historic unknown method never manufacture change history',options,async t=>{
 const {store,project,signals,round,documents,user}=await fixture(t);
 const producer=new GeoGroupChanges({store,signals});
 await round('a','00',false);await producer.project(project);
 assert.equal((await documents.list(user.id,'geo-signal',{projectId:project.projectId,filter:{recordType:'geo-signal'}})).items.length,0);
 await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,finished_at,surface)
  VALUES('noise','owner',$1,'noise','done',1,'{deepseek}','2026-10-25T01:00:10Z','{"mode":"web"}'),
  ('running','owner',$1,'baseline','running',1,'{deepseek}','2026-10-25T01:00:20Z','{"mode":"web"}'),
  ('inclusion','owner',$1,'baseline','done',1,'{deepseek}','2026-10-25T01:00:30Z','{"mode":"inclusion"}')`,[project.id]);
 await round('b','01',true);
 await store.query("UPDATE evimed_geo.rounds SET ref=ref#-'{balance,methodVersion}' WHERE id='a'");
 await producer.project(project);
 const mark=(await store.query('SELECT detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND key=$2',[project.id,GROUP_CHANGE_MARK])).rows[0].detail;
 assert.equal(mark.roundId,'b');assert.deepEqual(mark.reasons,{incompatible_measurement:1});
 assert.equal((await documents.list(user.id,'geo-signal',{projectId:project.projectId,filter:{recordType:'geo-signal'}})).items.length,0);
});

test('actual completed observations cannot exceed their declared metric, engine or repeat contract',options,async t=>{
 const f=await fixture(t);await f.round('a','00',false);await f.round('b','01',true);
 const valid={samplingMode:'recurring',engines:['deepseek'],repeats:1,metricIds:['M-01','M-03'],sourceBasis:'answers',reportPresentation:'summary'};
 for(const contract of [{samplingMode:'recurring'},{...valid,metricIds:['M-06']},{...valid,engines:['kimi']},{...valid,repeats:20}]){
  await f.store.query("UPDATE evimed_geo.rounds SET surface=jsonb_set(surface,'{measurementContract}',$1::jsonb) WHERE id IN ('a','b')",[JSON.stringify(contract)]);
  const pair=await readGeoRoundComparison(f.store,f.project,{previousRoundId:'a',currentRoundId:'b'});
  assert.equal(groupChangeEvents(pair).events.length,0);
 }
 await f.store.query("UPDATE evimed_geo.rounds SET surface=jsonb_set(surface,'{measurementContract}',$1::jsonb) WHERE id IN ('a','b')",[JSON.stringify(valid)]);
 assert.equal(groupChangeEvents(await readGeoRoundComparison(f.store,f.project,{previousRoundId:'a',currentRoundId:'b'})).events.length,1);
});

import { enqueueRound } from '../src/geoProbeQueue.mjs';
const contract={samplingMode:'recurring',engines:['deepseek'],repeats:1,metricIds:['M-01','M-03'],sourceBasis:'answers',reportPresentation:'summary'};
async function actualPair(t,agreement=contract,engines=null){
 const f=await fixture(t);
 await f.store.query('UPDATE evimed_geo.projects SET engines=$2::text[] WHERE id=$1',[f.project.id,agreement.engines]);f.project.engines=agreement.engines;
 await f.store.query('INSERT INTO evimed_geo.question_sets(geo_project_id,user_id,version,locked_at,measured_count,contract) VALUES($1,$2,1,now(),220,$3::jsonb)',[f.project.id,f.user.id,JSON.stringify(agreement)]);
 const ids=[];
 for(const [index,mentioned] of [false,true].entries()){
  const at=new Date(`2026-10-25T01:0${index}:00Z`),queued=await enqueueRound({store:f.measure,now:()=>at},{geoProjectId:f.project.id,kind:index?'weekly':'baseline',...(engines?{engines}:{})});
  assert.equal(queued.planned,220);ids.push(queued.roundId);
  const persisted=(await f.store.query('SELECT surface,set_version FROM evimed_geo.rounds WHERE id=$1',[queued.roundId])).rows[0];
  assert.equal(persisted.surface.measurementContract.questionVersion,1);assert.equal(persisted.set_version,1);
  await f.store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface,citations,probe_job_id)
    SELECT 's_'||j.id,j.user_id,j.geo_project_id,j.round_id,j.question_id,j.engine,$2,'valid','Actual queued job preserved answer','{"mode":"web"}','[]',j.id FROM evimed_geo.probe_jobs j WHERE j.round_id=$1`,[queued.roundId,at.toISOString()]);
  await f.store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,statements,checks,retrieval_triggered)
    SELECT s.id,s.user_id,s.geo_project_id,now(),$2::jsonb,$3,'[{"text":"Known","verdict":"correct"}]','{"judgementCoverage":{"status":"complete"}}',true FROM evimed_geo.snapshots s WHERE s.round_id=$1`,[queued.roundId,JSON.stringify(mentioned?[{name:'Ours',ours:true,count:1}]:[]),mentioned]);
  await f.store.query(`UPDATE evimed_geo.probe_jobs j SET status='done',snapshot_id='s_'||j.id WHERE round_id=$1`,[queued.roundId]);
  assert.equal((await f.measure.finishRound(queued.roundId,{now:at,skip:[]})).status,'done');
  await measureRound({store:f.measure,now:()=>new Date(Date.now()+20)},queued.roundId);
 }
 return {...f,ids};
}
test('production enqueueRound -> completion -> actual measurement -> group producer retains a valid questionVersion extension',options,async t=>{
 const f=await actualPair(t),pair=await readGeoRoundComparison(f.store,f.project,{previousRoundId:f.ids[0],currentRoundId:f.ids[1]});
 assert.equal(pair.commonKeys.length,220);
 await new GeoGroupChanges({store:f.store,signals:f.signals}).project(f.project);
 const events=(await f.documents.list(f.user.id,'geo-signal',{projectId:f.project.projectId,filter:{recordType:'geo-signal',kind:'group_changed'}})).items;
 assert.equal(events.length,1,'A producer must retain valid contracts produced by actual enqueueRound');
});
test('production enqueueRound contract rejects wrong questionVersion and unrelated unknown extension fields',options,async t=>{
 const f=await actualPair(t);
 for(const patch of [{questionVersion:2},{questionVersion:'1'},{questionVersion:null},{arbitraryUnknownField:true}]){
  await f.store.query(`UPDATE evimed_geo.rounds SET surface=jsonb_set(surface,'{measurementContract}',$2::jsonb) WHERE id=ANY($1::text[])`,[f.ids,JSON.stringify({...contract,questionVersion:1,...patch})]);
  const result=groupChangeEvents(await readGeoRoundComparison(f.store,f.project,{previousRoundId:f.ids[0],currentRoundId:f.ids[1]}));
  assert.equal(result.events.length,0);assert.equal(result.reasons.incompatible_measurement,1);
 }
});

test('an explicitly requested engine subset follows enqueueRound scope without inventing unmeasured platforms',options,async t=>{
 const f=await actualPair(t,{...contract,engines:['deepseek','kimi']},['deepseek']);
 await new GeoGroupChanges({store:f.store,signals:f.signals}).project(f.project);
 const event=(await f.documents.list(f.user.id,'geo-signal',{projectId:f.project.projectId,filter:{recordType:'geo-signal',kind:'group_changed'}})).items[0];
 assert.ok(event);assert.deepEqual(event.payload.basis.methods.before.declaredEngines,['deepseek']);assert.deepEqual(event.payload.basis.methods.after.engines,['deepseek']);
 const page=await readGeoGroupChangeMembers(f.documents,f.project,event,{side:'before'});assert.ok(page.items.every(row=>row.engine==='deepseek'));
});
test('a round that heard no answer between two measured rounds is passed over, never a pair the screen waits on for good',options,async t=>{
 // 2026-10-25: with the probe host down a weekly round closes with nothing asked; it is never measured, so a pair ending on it was
 // "not ready" on every pass and the screen stopped there for good.
 const f=await fixture(t),{store,documents,user,project,signals,round}=f;
 await round('a','00',false);
 await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,finished_at,surface)
   VALUES('empty','owner',$1,'weekly','partial',1,'{deepseek}',NULL,'2026-10-25T01:01:00Z','{"mode":"web"}')`,[project.id]);
 await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,surface,citations)
   VALUES('empty-1','owner',$1,'empty','q1','deepseek','2026-10-25T01:00:30Z','failed','{"mode":"web"}','[]')`,[project.id]);
 await round('b','02',true);
 const pair=await readGeoRoundComparison(store,project,{previousRoundId:'a',currentRoundId:'b'});
 assert.equal(pair.current.rounds[0].id,'b','the empty round between them does not break the adjacency');
 const producer=new GeoGroupChanges({store,signals});
 await producer.project(project);await producer.project(project);
 const events=(await documents.list(user.id,'geo-signal',{projectId:project.projectId,limit:100,filter:{recordType:'geo-signal',kind:'group_changed'}})).items;
 assert.deepEqual(events.map(r=>[r.payload.basis.previous.id,r.payload.basis.current.id]),[['a','b']]);
 const mark=(await store.query('SELECT detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND key=$2',[project.id,GROUP_CHANGE_MARK])).rows[0].detail;
 assert.deepEqual([mark.roundId,mark.lastError??null],['b',null]);
});
