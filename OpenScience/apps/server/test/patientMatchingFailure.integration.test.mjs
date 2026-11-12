import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createPatientMatchingGatewayHandler } from '../src/patientMatchingGateway.mjs';
import { HOST_ABI } from '@evimed/patient-matching-core';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createVcrPatientContext } from '../src/vcrPatientContext.mjs';
import { createPatientMatchingHostAdapter } from '../src/patientMatchingHostAdapter.mjs';
import { validateMatchingResult } from '@evimed/patient-matching-core';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL&&'An isolated local test PostgreSQL is required',timeout:30000};
let db,isolated,dir,vcr,adapter,study,seq=0;
const messages=new Map(), origin={userId:'failure-owner',projectId:'failure-project',rootSessionId:'failure-root',runId:'offline-failure-test',callId:'call-original',rootCallId:'call-original',pluginGeneration:'generation-test'};
before(async()=>{
  if(!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL)return;
  isolated=await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'failureisolation');
  db=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});await migrateProductStore(db);
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('failure-owner','Offline Fixture','development')");
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('failure-owner','failure-project','Offline Failure Fixture',10000000)");
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'matching-failure-fixture-'));
  const config={vcrEnabled:true,vcrAudience:'all',vcrProviderAgreements:true,vcrDataPlaneDir:dir,deepseekBaseUrl:'https://model.invalid'};
  vcr=composeVcr({config,productDatabase:db});await vcr.store.ready();
  vcr.patientContext=createVcrPatientContext({store:vcr.store,dataStore:vcr.dataStore,dataPlane:vcr.dataPlane,documents:vcr.documents,subjectKnown:vcr.subjectKnown,transcript:async()=>({sessionId:origin.rootSessionId,messages:[...messages].map(([position,text])=>({seq:position,role:'user',source:'user',parts:[{type:'text',text}]}))}),isHumanMessage:async()=>true});
  adapter=createPatientMatchingHostAdapter({vcr,documents:new ProductDocuments(db),config});study=await vcr.store.taskContext(origin);
});
after(async()=>{await db?.close();await isolated?.drop();if(dir)await fs.rm(dir,{recursive:true,force:true});});
const invoke=(port,operation,input,acting=origin)=>adapter.dispatch({port,operation,input,origin:acting});
async function fixture(count=2,clauses=1){
  const subjects=[];
  for(let index=0;index<count;index++){messages.set(++seq,`Offline synthetic patient ${seq}. Age 62 years.`);subjects.push((await vcr.patientContext(study,{messageSeq:seq},origin)).subjectKey);}
  const protocol=await vcr.matchStore.saveProtocolVersion({studyId:study.id,userId:origin.userId,title:'Offline protocol',criteria:Array.from({length:clauses},(_,index)=>({kind:'inclusion',sourceText:`Adult age requirement ${index}: at least18 years.`}))});
  const prepared=(await invoke('ExecutionPort','assess',{phase:'prepare',protocolVersionId:protocol.id,subjectKeys:subjects})).data;
  return {prepared,subjects,protocol};
}
function decision(prepared,index=0){
  const pair=prepared.task.selectedPairs[index],profile=prepared.trialProfiles.find(item=>item.trialId===pair.trialId),bundle=prepared.evidenceBundles[index];
  return {schemaVersion:'1',decisionId:`decision-${prepared.executionId}-${index}`,revision:'1',scope:prepared.task.scope,...pair,state:'complete',clinicalEligibility:'eligible',recommendation:{priority:null,rationale:'Synthetic model fixture'},criteria:profile.criteria.map(criterion=>({criterionId:criterion.criterionId,kind:'inclusion',verdict:'satisfied',basis:'stated',evidenceIds:[bundle.patientPassages[0].evidenceId],assumptions:[],reason:'Synthetic model evidence fixture'})),sourceRefs:bundle.sources,profileDigest:prepared.profileDigest,producer:{kind:'model',modelProfileDigest:prepared.profileDigest,executionId:prepared.executionId},evidenceBundleId:bundle.bundleId,unresolvedFacts:[],assumptions:[]};
}
const input=(prepared,phase,decisions)=>({phase,taskId:prepared.task.taskId,executionId:prepared.executionId,profileDigest:prepared.profileDigest,native:{childId:'offline-child',messageId:'offline-message',stopReason:'error'},diagnostics:['invalid_json'],...(decisions===undefined?{}:{decisions})});
test('a malformed first segment is checkpointed and the next authorized segment proceeds',options,async()=>{
  const {prepared,subjects}=await fixture(2,13);assert.equal(prepared.task.selectedPairs.length,1);
  const failed=await invoke('ResultPort','save',input(prepared,'failure'));
  assert.equal(failed.data.counts.failed,1);assert.equal(failed.data.counts.pending,1);validateMatchingResult(failed.data);
  const failure=failed.data.rows.find(row=>row.state==='failed');assert.equal(failure.producer.kind,'runtime');assert.deepEqual(failure.criteria,[]);assert.equal(failure.recommendation.priority,null);assert.equal(failure.clinicalEligibility,'not-assessed');
  assert.equal((await adapter.pending(origin,prepared.task.taskId)).cursor,1);
  const next=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:prepared.task.taskId},{...origin,callId:'next-call'})).data;
  assert.equal(next.task.selectedPairs[0].subjectKey,subjects[1]);
  const saved=await invoke('ResultPort','save',input(next,'commit',[decision(next)]),{...origin,callId:'next-call'});
  assert.equal(saved.data.state,'partial');assert.equal((await adapter.pending(origin,prepared.task.taskId)).pending,false);
});
test('valid model siblings survive bad metadata and missing siblings become empty failures',options,async()=>{
  const {prepared}=await fixture(3),valid=decision(prepared),bad=decision(prepared,1);bad.producer.executionId='forged';
  const saved=await invoke('ResultPort','save',input(prepared,'commit',[valid,bad]));
  assert.equal(saved.data.counts.complete,1);assert.equal(saved.data.counts.failed,2);assert.equal(saved.data.rows.find(row=>row.current).decisionId,valid.decisionId);
  assert.equal((await adapter.pending(origin,prepared.task.taskId)).pending,false);
  const job=await invoke('JobPort','get',{taskId:prepared.task.taskId,jobId:prepared.task.taskId});assert.equal(job.data.next,null);assert.equal(job.data.state,'partial');
});
test('explicit continue retries failed pairs only and keeps historical failure truth',options,async()=>{
  const {prepared}=await fixture(2),saved=await invoke('ResultPort','save',input(prepared,'commit',[decision(prepared)]));
  const continued=await invoke('JobPort','continue',{taskId:prepared.task.taskId,jobId:prepared.task.taskId});
  assert.equal(continued.data.result.counts.complete,1);assert.equal(continued.data.result.counts.pending,1);assert.ok(continued.data.next);
  const historical=await adapter.resultOf(origin,prepared.task.taskId,saved.data.resultId);assert.equal(historical.counts.failed,1);
  const retry=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:prepared.task.taskId},{...origin,callId:'retry-call'})).data;
  assert.equal(retry.task.selectedPairs.length,1);assert.equal(retry.task.selectedPairs[0].subjectKey,prepared.task.selectedPairs[1].subjectKey);
});
test('failure saves are idempotent and cannot accept caller clinical decisions or stale execution epochs',options,async()=>{
  const {prepared}=await fixture(1),saved=await invoke('ResultPort','save',input(prepared,'failure'));
  const duplicate=await invoke('ResultPort','save',input(prepared,'failure'));assert.equal(duplicate.data.resultId,saved.data.resultId);
  const meta=await adapter.repository.get(prepared.task.scope,prepared.task.taskId);assert.equal(meta.payload.rowIds.length,1);
  const other=await fixture(1);await assert.rejects(invoke('ResultPort','save',input(other.prepared,'failure',[])),{code:'patient_matching_native_result_invalid'});
  await invoke('JobPort','continue',{taskId:other.prepared.task.taskId,jobId:other.prepared.task.taskId});
  await assert.rejects(invoke('ResultPort','save',input(other.prepared,'failure')),{code:'patient_matching_execution_superseded'});
});
test('cancelled, changed-source and denied-source executions create no fake failure checkpoints',options,async()=>{
  const cancelled=await fixture(1);await invoke('JobPort','cancel',{taskId:cancelled.prepared.task.taskId,jobId:cancelled.prepared.task.taskId});assert.equal((await invoke('ResultPort','save',input(cancelled.prepared,'failure'))).status,'cancelled');
  const changed=await fixture(1);messages.set(++seq,'Corrected synthetic patient age63.');await vcr.patientContext(study,{messageSeq:seq,subjectKey:changed.subjects[0]},origin);await assert.rejects(invoke('ResultPort','save',input(changed.prepared,'failure')),{code:'patient_matching_source_changed'});
  const denied=await fixture(1),original=vcr.documents.judgeReads;vcr.documents.judgeReads=async()=>({patientLevel:false,permitted:[false]});
  try{await assert.rejects(invoke('ResultPort','save',input(denied.prepared,'failure')),{code:'patient_matching_model_access_denied'});}finally{vcr.documents.judgeReads=original;}
  for(const f of [cancelled,changed,denied])assert.equal((await adapter.repository.get(f.prepared.task.scope,f.prepared.task.taskId)).payload.rowIds.length,0);
});
test('a persistence failure rolls back valid and failed siblings together',options,async()=>{
  const {prepared}=await fixture(2),original=vcr.matchJudgments.save;let calls=0;
  vcr.matchJudgments.save=async entry=>{if(++calls===2)throw new Error('Synthetic disk failure');return original.call(vcr.matchJudgments,entry);};
  try{await assert.rejects(invoke('ResultPort','save',input(prepared,'commit',[decision(prepared)])),/Synthetic disk failure/);}finally{vcr.matchJudgments.save=original;}
  const meta=await adapter.repository.get(prepared.task.scope,prepared.task.taskId);assert.deepEqual(meta.payload.rowIds,[]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_vcr.match_judgments WHERE answer->>'matchingTaskId'=$1",[prepared.task.taskId])).rows[0].n,0);
});
test('failed live-document writes retain the source-erasure fence',options,async()=>{
  const {prepared}=await fixture(1),original=vcr.matchJudgments.save;
  vcr.matchJudgments.save=async entry=>{await db.query('UPDATE evimed_vcr.source_files SET erased_at=now() WHERE id=ANY($1::text[])',[entry.documentIds]);return original.call(vcr.matchJudgments,entry);};
  try{await assert.rejects(invoke('ResultPort','save',input(prepared,'failure')),{code:'patient_matching_source_withdrawn'});}finally{vcr.matchJudgments.save=original;}
  assert.deepEqual((await adapter.repository.get(prepared.task.scope,prepared.task.taskId)).payload.rowIds,[]);
});
test('computed model claims without a preserved receipt fail only their own authorized pair',options,async()=>{
  const {prepared}=await fixture(2),bad=decision(prepared,1);bad.criteria[0].basis='computed';
  const saved=await invoke('ResultPort','save',input(prepared,'commit',[decision(prepared),bad]));
  assert.equal(saved.data.counts.complete,1);assert.equal(saved.data.counts.failed,1);
  assert.deepEqual(saved.data.rows.find(row=>row.state==='failed').criteria,[]);
});
test('failed checkpoints become retryable when their sources change without hiding their historical failure',options,async()=>{
  const {prepared,subjects}=await fixture(1),saved=await invoke('ResultPort','save',input(prepared,'failure'));
  messages.set(++seq,'Updated synthetic patient age65.');await vcr.patientContext(study,{messageSeq:seq,subjectKey:subjects[0]},origin);
  const pending=await adapter.pending(origin,prepared.task.taskId);assert.equal(pending.pending,true);assert.equal(pending.remaining,1);
  assert.equal((await adapter.resultOf(origin,prepared.task.taskId,saved.data.resultId)).rows[0].state,'failed');
});

test('failure checkpoint transport stays bound to the original pending matching operation',options,async()=>{
  const {prepared}=await fixture(1),handler=createPatientMatchingGatewayHandler({vcrEnabled:true},{assertActiveModelGatewayToken:()=>({userId:origin.userId,projectId:origin.projectId})},{vcr,adapter,resolveInvocation:async()=>({...origin,tool:'match_assess',args:{taskId:prepared.task.taskId}})});
  async function call(body){const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{method:'POST',url:'/internal/patient-matching/v1/port',headers:{authorization:'Bearer offline-fixture'}});let status,value;await handler(req,{writeHead:code=>{status=code;},end:text=>{value=JSON.parse(text);}});return{status,value};}
  const envelope={abi:HOST_ABI,port:'ResultPort',operation:'save',invocation:{tool:'match_assess',callId:origin.callId,sessionId:origin.rootSessionId,agentId:origin.rootSessionId,args:{taskId:prepared.task.taskId}},input:input(prepared,'failure')};
  assert.equal((await call({...envelope,input:{...envelope.input,decisions:[]}})).status,403);
  assert.equal((await call({...envelope,input:{...envelope.input,taskId:'outside-task'}})).status,403);
  const accepted=await call(envelope);assert.equal(accepted.status,200);assert.equal(accepted.value.data.failureCheckpoint.saved,true);
});
test('another patient bundle cannot escape per-pair failure isolation in a shared trial',options,async()=>{
  const {prepared}=await fixture(2),valid=decision(prepared),bad=decision(prepared,1),otherBundle=prepared.evidenceBundles[0];
  assert.equal(valid.trialId,bad.trialId);
  bad.evidenceBundleId=otherBundle.bundleId;bad.sourceRefs=otherBundle.sources;
  bad.criteria=bad.criteria.map(criterion=>({...criterion,evidenceIds:[]}));
  const saved=await invoke('ResultPort','save',input(prepared,'commit',[valid,bad]));
  assert.equal(saved.data.counts.complete,1);assert.equal(saved.data.counts.failed,1);validateMatchingResult(saved.data);
  assert.equal(saved.data.rows.find(row=>row.current).decisionId,valid.decisionId);
  const failed=saved.data.rows.find(row=>row.subjectKey===bad.subjectKey);
  assert.equal(failed.state,'failed');assert.equal(failed.producer.kind,'runtime');assert.equal(failed.clinicalEligibility,'not-assessed');
  assert.deepEqual(failed.criteria,[]);assert.equal(failed.evidenceBundleId,prepared.evidenceBundles[1].bundleId);
  assert.deepEqual(failed.sourceRefs,prepared.evidenceBundles[1].sources);
});
