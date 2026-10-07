import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {ProductDocuments,ProductJobs} from '../src/productStore.mjs';
import {migrateProductStore} from '../src/productPersistence.mjs';
import {migrateUsageLedger} from '../src/usagePersistence.mjs';
import {EvolutionService} from '../src/evolutionService.mjs';
import {createEvolutionSignals} from '../src/evolutionSignals.mjs';
import {UsageLedger} from '../src/usageLedger.mjs';
import {withEvolutionUsage} from '../src/evolutionUsage.mjs';
import {EvolutionWorker} from '../src/evolutionWorker.mjs';
import {createEvolutionMissions} from '../src/evolutionMissions.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??'';
if(url){const parsed=new URL(url);assert.ok(['localhost','127.0.0.1','::1'].includes(parsed.hostname));assert.match(parsed.pathname,/evimed_test/);}
const options={skip:!url&&'A disposable localhost test PostgreSQL database is required'};
const owner=`evolution_${randomUUID()}`,accounts=Array.from({length:5},()=>`researcher_${randomUUID()}`);
let database,documents,jobs,service,ledger;
before(async()=>{
 if(!url)return;
 database=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:8,databaseConnectionTimeoutMs:3000});
 await database.migrate();await migrateProductStore(database);await migrateUsageLedger(database);
 for(const id of [owner,...accounts]){
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Durability test','development')",[id]);
  for(const project of id===owner?['evimed-evolution','research']:['research'])await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Durability',1048576)",[id,project]);
 }
 documents=new ProductDocuments(database);jobs=new ProductJobs(database);service=new EvolutionService({documents,jobs,ownerId:owner});ledger=new UsageLedger(database);
});
after(async()=>{if(database){await database.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])',[[owner,...accounts]]);await database.close();}});
const request=(patch={})=>{const id=randomUUID();return{id,userId:owner,projectId:'evimed-evolution',purpose:'evolution',estimatedCost:0.6,dailyLimit:50,model:'deepseek-v4-flash',priceVersion:'evimed-reference-2026-09-05',currency:'CNY',requestFingerprint:createHash('sha256').update(id).digest('hex'),...patch};};
test('three distinct accounts are counted privately and only five open a shared lead; signal replay is race-safe',options,async()=>{
 const signals=createEvolutionSignals({service,capabilityIds:async()=>['statistical-analysis']});
 const lead=userId=>({track:'M',source:'runtime-failure',gapCode:'method-missing',userId,projectId:'research',sourceEventId:'closed-event',method:'private tenant prose'});
 for(const id of accounts.slice(0,3))await service.addLead(lead(id));
 const accumulating=(await service.list('lead'))[0];assert.equal(accumulating.payload.distinctAccounts,3);assert.equal(accumulating.payload.status,'accumulating');
 assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_product.jobs WHERE user_id=$1 AND kind='evolution-scout'",[owner])).rows[0].n,0);
 const signal=id=>({userId:id,projectId:'research',eventId:'demand-event',kind:'unmet-demand',moduleId:'tools',capability:'statistical-analysis',operation:'transform',dataShape:'table',reason:'missing-tool',privateText:'never aggregate'});
 await Promise.all(accounts.slice(0,3).flatMap(id=>Array.from({length:3},()=>signals.record(signal(id)))));
 assert.equal((await signals.aggregate()).length,0);
 for(const id of accounts.slice(3)){await service.addLead(lead(id));await signals.record(signal(id));}
 const shared=(await service.list('lead'))[0];assert.equal(shared.payload.distinctAccounts,5);assert.equal(shared.payload.occurrences,5);
 const summaries=await Promise.all(Array.from({length:4},()=>signals.aggregate()));
 const [summary]=summaries[0];assert.ok(summaries.every(items=>items[0].revision===1));assert.equal(summary.payload.distinctAccounts,5);assert.equal(summary.payload.occurrences,5);
 assert.ok(!JSON.stringify(summary).includes('private'));assert.ok(accounts.every(id=>!JSON.stringify(summary).includes(id)));
 assert.equal((await signals.record(signal(accounts[0]))).revision,1);
});
test('advisory lock document changes roll back together and persisted events reconcile one exact queue key',options,async()=>{
 await assert.rejects(service.withLock('atomic-rollback',async()=>{await service.save('observation','rollback-observation',{status:'test'});throw Error('injected');}),/injected/);
 assert.equal(await service.get('rollback-observation'),null);
 const original=service.enqueue;service.enqueue=async()=>{throw Error('enqueue interruption');};
 const event={id:'durability-crash',type:'dataset-ready',userId:accounts[0],projectId:'research',sourceVersion:'sha256:v1',privateText:'private snapshot'};
 try{await assert.rejects(service.ingestEvent(event),/interruption/);}finally{service.enqueue=original;}
 assert.equal((await service.reconcileQueued()).recovered,1);assert.equal((await service.reconcileQueued()).recovered,0);
 await Promise.all(Array.from({length:8},()=>service.ingestEvent(event)));
 const [record]=(await service.list('event',accounts[0])).filter(row=>row.payload.id===event.id);
 const queued=await database.query("SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND idempotency_key=$2",[owner,`evolution:${record.id}`]);
 assert.equal(queued.rows.length,1);assert.deepEqual(queued.rows[0].payload,{eventId:record.id,eventOwnerId:accounts[0]});assert.equal(record.revision,1);
});
test('trusted attribution reserves at the ceiling atomically and ignores browser-supplied mission fields',options,async()=>{
 const missionId=`evolution-mission-${randomUUID()}`;
 await service.save('mission',missionId,{moduleId:'tools',status:'ready',budget:{reservedCny:1}});
 const browser=await ledger.reserveModel(request({evolutionMissionId:missionId,evolutionModule:'tools',estimatedCost:0.1}));
 assert.equal(browser.evolutionMissionId,null);assert.equal(browser.evolutionModule,null);
 const outcomes=await Promise.allSettled(Array.from({length:2},()=>withEvolutionUsage({missionId,moduleId:'tools'},()=>ledger.reserveModel(request()))));
 assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
 const rejected=outcomes.find(result=>result.status==='rejected');assert.equal(rejected.reason.code,'usage_budget_exceeded');assert.equal(rejected.reason.details.window,'mission');
 const successful=outcomes.find(result=>result.status==='fulfilled').value;assert.equal(successful.evolutionMissionId,missionId);assert.equal(successful.reservedCost,0.6);
 await database.query("UPDATE evimed_usage.model_requests SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[successful.id]);
 await ledger.reconcileExpiredReservations();
 await assert.rejects(withEvolutionUsage({missionId,moduleId:'tools'},()=>ledger.reserveModel(request({estimatedCost:0.5}))),error=>error.details.window==='mission');
 const stored=(await database.query('SELECT status,reserved_cost FROM evimed_usage.model_requests WHERE id=$1',[successful.id])).rows[0];assert.equal(stored.status,'uncertain');assert.equal(Number(stored.reserved_cost),0.6);
});
test('rolling daily reservation races across internal projects never exceed their shared limit',options,async()=>{
 const cappedOwner=accounts[4];
 const attempts=await Promise.allSettled(Array.from({length:2},()=>ledger.reserveModel(request({userId:cappedOwner,projectId:'research',dailyLimit:1}))));
 assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);assert.equal(attempts.find(result=>result.status==='rejected').reason.details.window,'day');
});
test('mission allocation is atomic across coordinators and a resource-signature change reopens a dossier',options,async()=>{
 const P={version:1,budgetShares:{research:0.4}},policy={assignedPolicy:async()=>({id:'P',policy:P}),current:async()=>({policy:P})};
 const coordinator=()=>createEvolutionMissions({service,policy,map:{},taskPool:{},signals:{},config:{evolutionDailyBudgetCny:50,evolutionRunBudgetCny:10}});
 const a=coordinator(),b=coordinator();
 const allocated=await Promise.all(Array.from({length:6},(_,i)=>(i%2?a:b).create({id:`allocation-${i}`,moduleId:'tools',category:'research'})));
 assert.equal(allocated.filter(row=>row.id).length,2);assert.equal(allocated.filter(row=>row.id).reduce((sum,row)=>sum+row.payload.budget.reservedCny,0),20);
 const initial=await a.opportunity({id:'signature-opportunity',moduleId:'tools',sources:['data'],taskFamily:'conversion',evidenceRoots:['source:v1'],features:{coverageGap:true}});
 const waiting=await service.save('dossier',initial.id,{...initial.payload,status:'waiting_resource'},initial);
 const unchanged=await a.opportunity({...waiting.payload});assert.equal(unchanged.revision,waiting.revision);
 const changed=await a.opportunity({...waiting.payload,evidenceRoots:['source:v2']});assert.equal(changed.payload.status,'planned');assert.notEqual(changed.payload.resourceSignature,waiting.payload.resourceSignature);
});
test('real PostgreSQL worker admission permits exactly one heavy and two light concurrent leases',options,async()=>{
 for(let i=0;i<4;i++)await service.enqueue('build',{unit:i},`lane-heavy-${i}`);
 for(let i=0;i<5;i++)await service.enqueue('mission',{unit:i},`lane-light-${i}`);
 let release;const hold=new Promise(resolve=>{release=resolve;}),started=[];
 const workers=['heavy','heavy','heavy','light','light','light','light'].map(lane=>{
  const worker=new EvolutionWorker({service,lane,config:{evolutionEnabled:true,evolutionMaxConcurrency:1,evolutionLightConcurrency:2},callbacks:{dailyCost:async()=>0,admitRuntime:async()=>true}});
  worker.perform=async job=>{started.push(job);await hold;return{status:'complete'};};return worker;
 });
 const ticks=workers.map(worker=>worker.tick({kinds:['evolution-build','evolution-mission']}));
 try{
  const until=Date.now()+5000;while(started.length<3&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(started.length,3);assert.equal(started.filter(job=>job.kind==='evolution-build').length,1);assert.equal(started.filter(job=>job.kind==='evolution-mission').length,2);
  const live=await database.query("SELECT kind,count(*)::int AS n FROM evimed_product.jobs WHERE status='running' GROUP BY kind");
  assert.equal(live.rows.find(row=>row.kind==='evolution-build').n,1);assert.equal(live.rows.find(row=>row.kind==='evolution-mission').n,2);
 }finally{release();await Promise.all(ticks);await Promise.all(workers.map(worker=>worker.close()));}
});
test('persisted runtime attribution stays tenant and module bound; reservation replay cannot switch missions',options,async()=>{
 const missionId=`evolution-mission-${randomUUID()}`,secondId=`evolution-mission-${randomUUID()}`,runId=randomUUID();
 for(const id of [missionId,secondId])await service.save('mission',id,{moduleId:'runtime',status:'ready',budget:{reservedCny:1}});
 await service.save('run-attribution',`evolution-run-attribution-${randomUUID()}`,{missionId,moduleId:'runtime',projectId:'evimed-evolution',runIds:[runId]});
 const row=await ledger.reserveModel(request({runId,estimatedCost:0.2}));assert.equal(row.evolutionMissionId,missionId);assert.equal(row.evolutionModule,'runtime');
 const original=request({estimatedCost:0.1,now:new Date()});
 await withEvolutionUsage({missionId,moduleId:'runtime'},()=>ledger.reserveModel(original));
 await assert.rejects(withEvolutionUsage({missionId:secondId,moduleId:'runtime'},()=>ledger.reserveModel(original)),error=>error.code==='usage_reservation_conflict');
 await assert.rejects(withEvolutionUsage({missionId,moduleId:'tools'},()=>ledger.reserveModel(request({estimatedCost:0.1}))),error=>error.code==='usage_budget_exceeded'&&error.details.window==='mission');
 const foreign=await ledger.reserveModel(request({userId:accounts[3],projectId:'research',runId,estimatedCost:0.1}));assert.equal(foreign.evolutionMissionId,null);
});
