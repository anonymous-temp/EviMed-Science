import assert from 'node:assert/strict';
import { before,after,test } from 'node:test';
import { ProductJobs,ProductDocuments } from '../src/productStore.mjs';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { PatientMatchingContinuation } from '../src/patientMatchingContinuation.mjs';

const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options={skip:!url&&'An isolated PostgreSQL is required'};
let database,isolated,jobs,documents;
before(async()=>{if(!url)return;isolated=await createGeoTestDatabase(url,'matchingcontinue');database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:5,databaseConnectionTimeoutMs:2000});await migrateProductStore(database);await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('owner','Owner','development')");await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner','project','Project',10000)");jobs=new ProductJobs(database);documents=new ProductDocuments(database);});
after(async()=>{await database?.close();await isolated?.drop();});
const origin={userId:'owner',projectId:'project',rootSessionId:'root',runId:'original',pluginGeneration:'generation-a'};
function fixture(){
  const p={pending:true,cursor:0,state:'pending',continuationEpoch:0};const runs=[];let notified=0,accepted=0,lost=false,allowed=true;
  const worker=new PatientMatchingContinuation({jobs,documents,pollMs:0,adapter:{pending:async()=>({...p})},resolve:async()=>({project:{id:'project'},user:{id:'owner'},sessionId:'root'}),runs:async()=>runs,allowed:async()=>allowed,notify:async()=>{notified++;},dispatch:async(_ctx,r)=>{await r.options.beforeReserve();await r.options.beforePrompt();accepted++;runs.push({sessionId:r.sessionId,dispatchId:r.dispatchId,dispatchFingerprint:r.options.dispatchFingerprint,status:'running'});if(lost){lost=false;throw Object.assign(new Error(),{code:'lost_acceptance'});}return {accepted:true};}});
  return {worker,p,runs,accepted:()=>accepted,notified:()=>notified,lose:()=>{lost=true;},disable:()=>{allowed=false;}};
}
test('leased same-session resume deduplicates lost acceptance, advances saved cursor and respects cancellation',options,async()=>{
  const f=fixture();f.lose();const job=await f.worker.enqueue(origin,'task-a');assert.equal((await f.worker.enqueue(origin,'task-a')).id,job.id);
  await f.worker.tick();assert.equal(f.accepted(),1);await f.worker.tick();assert.equal(f.accepted(),1,'lost acceptance reuses dispatch identity');
  f.runs[0].status='completed';f.p.cursor=1;await f.worker.tick();assert.equal((await jobs.get('owner',job.id)).status,'succeeded');
  await f.worker.tick();assert.equal(f.accepted(),2);assert.equal(f.runs[1].sessionId,'root');
  f.p.pending=false;f.p.state='cancelled';f.runs.at(-1).status='canceled';await f.worker.tick();assert.equal(f.accepted(),2);
  f.p.pending=true;f.p.state='pending';f.p.continuationEpoch++;await f.worker.enqueue(origin,'task-a');await f.worker.tick();assert.equal(f.accepted(),3,'explicit continuation after cancellation starts a new epoch');f.p.pending=false;await f.worker.tick();
});
test('three completed rounds without progress preserve pending work and notify once',options,async()=>{
  const f=fixture();const job=await f.worker.enqueue(origin,'task-stalled');
  await f.worker.tick();
  for(let i=0;i<3;i++){f.runs.at(-1).status='completed';await f.worker.tick();}
  const ended=await jobs.get('owner',job.id);assert.equal(ended.status,'succeeded');assert.equal(ended.result.state,'needs-attention');assert.equal(ended.result.pending,true);assert.equal(f.accepted(),3);assert.equal(f.notified(),1);assert.equal(f.p.pending,true);
  f.p.continuationEpoch++;const resumed=await f.worker.enqueue(origin,'task-stalled');assert.notEqual(resumed.id,job.id);await f.worker.tick();assert.equal(f.accepted(),4,'an explicit resume after a no-progress pause gets one new epoch');f.p.pending=false;await f.worker.tick();
});
