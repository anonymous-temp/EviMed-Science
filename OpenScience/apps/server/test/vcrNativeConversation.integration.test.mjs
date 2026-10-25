import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { VcrOrchestrator } from '../src/vcrOrchestrator.mjs';
import { vcrRuntimeWrite } from '../src/vcrGateway.mjs';
import { vcrScenarioHash } from '../src/vcrJobs.mjs';
import { vcrComputedOutputHash } from '../src/vcrEngineClient.mjs';
import { deleteVcrProjectRows } from '../src/vcrStoreBase.mjs';
import { createVcrGatewayHandler } from '../src/vcrGateway.mjs';
import { verifyVcrInvocation } from '../src/vcrExecutionContext.mjs';
import { vcrSchemaSql } from '../src/vcrPersistence.mjs';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createVcrPatientContext } from '../src/vcrPatientContext.mjs';
import { VcrConversationCompletions,createVcrCompletionResolver } from '../src/vcrConversationCompletions.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Owned local PostgreSQL is required'};
let isolated,database,dir,vcr;
before(async()=>{
 if(options.skip)return; isolated=await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'vcrnative');
 database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:8,databaseConnectionTimeoutMs:2000});dir=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-native-'));
 vcr=composeVcr({productDatabase:database,config:{vcrEnabled:true,vcrAudience:'all',vcrDataPlaneDir:dir,vcrProviderAgreements:true,
  vcrProviderAgreementReference:'Local synthetic fixture',deepseekBaseUrl:'https://model.invalid',vcrMaxConcurrentJobs:1}});await vcr.store.ready();
});
after(async()=>{await database?.close();await isolated?.drop();if(dir)await fs.rm(dir,{recursive:true,force:true});});
const origin=session=>({userId:'owner',projectId:'default',rootSessionId:session,sessionId:session,runId:'run',callId:'call'});
test('concurrent native sessions in one ordinary project get independent idempotent task contexts',options,async()=>{
 const [a,b,again]=await Promise.all([vcr.store.taskContext(origin('a')),vcr.store.taskContext(origin('b')),vcr.store.taskContext(origin('a'))]);
 assert.notEqual(a.id,b.id);assert.equal(a.id,again.id);assert.equal(a.scope,'conversation');assert.equal(a.purpose,'task');
 assert.equal(await vcr.store.studyByControlProject('owner','default'),null);assert.equal(a.conversationSessionId,'a');
});
test('patient context preserves original human material and rejects assistant, platform or foreign sources',options,async()=>{
 const study=await vcr.store.taskContext(origin('patient'));study.cloudContext={runId:'run',sessionId:'patient'};
 const page={sessionId:'patient',messages:[{role:'user',source:'user',seq:1,turnStartSeq:0,parts:[{type:'text',text:'Synthetic patient aged 62. No prior infarction.'}]},
  {role:'assistant',source:'system',seq:2,parts:[{type:'text',text:'Model invented a diagnosis.'}]}]};
 const intake=createVcrPatientContext({store:vcr.store,dataStore:vcr.dataStore,dataPlane:vcr.dataPlane,documents:vcr.documents,transcript:async()=>page,isHumanMessage:async()=>true});
 const admitted=await intake(study,{messageSeq:1},origin('patient'));assert.equal(admitted.ok,true);assert.ok(admitted.subjectKey);assert.equal(admitted.valueSource,'extracted');
 const again=await intake(study,{messageSeq:1},origin('patient'));assert.equal(admitted.documentId,again.documentId);assert.equal(admitted.subjectKey,again.subjectKey);
 const document=await vcr.documents.runtimeRead(study,{subjectKey:admitted.subjectKey,documentId:admitted.documentId});assert.equal(document.text,page.messages[0].parts[0].text);
 await assert.rejects(intake(study,{messageSeq:2},origin('patient')),{code:'vcr_patient_context_invalid'});
 await assert.rejects(intake(study,{text:'Model prose'},origin('patient')),{code:'vcr_patient_context_invalid'});
 const foreign=createVcrPatientContext({store:vcr.store,dataStore:vcr.dataStore,dataPlane:vcr.dataPlane,documents:vcr.documents,
  transcript:async()=>page,isHumanMessage:async()=>false,sources:{get:async()=>({userId:'other',projectId:'default',payload:{connector:{type:'upload'}}})}});
 await assert.rejects(foreign(study,{sourceId:'foreign'},origin('patient')),{code:'vcr_patient_context_invalid'});
 await assert.rejects(foreign(study,{messageSeq:1},origin('patient')),{code:'vcr_patient_context_invalid'});
 assert.equal(Number((await vcr.store.one('SELECT count(*) AS n FROM evimed_vcr.matching_candidates')).n),0);
});
test('durable completion reconciliation survives duplicate retries and never redirects busy/deleted sessions',options,async()=>{
 const study=await vcr.store.taskContext(origin('completion'));
 await vcr.store.query(`INSERT INTO evimed_vcr.jobs (id,study_id,user_id,kind,method,method_version,state,scenario,scenario_hash,seed,cpu_seconds_limit,max_attempts,idempotency_key,checkpoint,finished_at)
  VALUES ('job_completion',$1,'owner','design_analytic','design.analytic','1.1.0','failed','{}','hash',1,60,3,'completion',$2::jsonb,now())`,[study.id,JSON.stringify({conversationOrigin:origin('completion')})]);
 let busy=true,dispatches=0,attempts=0;const identities=[];const accepted=new Set();
 const completions=new VcrConversationCompletions({store:vcr.store,resolve:async()=>({user:{id:'owner'},project:{id:'default'},session:{mode:'open-domain'}}),
  inbox:async()=>({running:busy,queued:0}),dispatch:async(_u,_p,sid,id)=>{assert.equal(sid,'completion');identities.push(id);attempts++;if(!accepted.has(id)){accepted.add(id);dispatches++;}if(attempts===1)throw new Error('Lost accepted dispatch response');return{dispatchStatus:'accepted'};},notify:async()=>{}});
 await completions.tick();assert.equal(dispatches,0);await vcr.store.query("UPDATE evimed_vcr.conversation_completions SET run_after=now()");busy=false;
 await completions.tick();await vcr.store.query("UPDATE evimed_vcr.conversation_completions SET run_after=now()");await completions.tick();await completions.tick();
 assert.equal(dispatches,1);assert.equal(new Set(identities).size,1);assert.equal(Number((await vcr.store.one('SELECT count(*) AS n FROM evimed_vcr.conversation_completions')).n),1);
});
test('local matching claims while a physical engine job occupies the engine lane',options,async()=>{
 await vcr.store.query('DELETE FROM evimed_vcr.jobs');
 const study=await vcr.store.taskContext(origin('lane'));vcr.jobs.engine={configured:()=>true,status:async()=>({state:'running'})};
 const analytic={design:{kind:'two_arm_fixed'},endpoint:{type:'binary'},truth:{controlRate:0.3,treatmentRate:0.5}};
 const heavy=await vcr.jobs.enqueue({studyId:study.id,userId:'owner',kind:'design_analytic',scenario:analytic,idempotencyKey:'heavy'});
 assert.equal((await vcr.jobs.claim({lane:'engine'}))[0].id,heavy.job.id);
 const local=await vcr.jobs.enqueue({studyId:study.id,userId:'owner',kind:'match_criteria',scenario:{criteria:[{id:'age',kind:'inclusion',type:'demographic',state:'satisfied'}]},idempotencyKey:'local'});
 const claimed=await vcr.jobs.claim({lane:'local'});assert.equal(claimed[0].id,local.job.id);
 assert.deepEqual(await vcr.jobs.claim({lane:'engine'}),[]);
});

test('native VCR gateway opens tasks in the exact root session and rejects changed tool arguments',options,async()=>{
 const project={id:'global',userId:'gateway_user'};const nativeInput={what:'study'};
 const runtime={assertActiveModelGatewayToken:()=>({userId:project.userId,projectId:project.id}),sessionTranscript:async(_p,sessionId)=>({sessionId,truncated:false,turns:[{startSeq:1,end:null}],messages:[{turnStartSeq:1,parts:[{type:'tool',callId:'call',status:'pending',tool:'mcp__evimed__vcr_read',input:nativeInput}]}]})};
 const handler=createVcrGatewayHandler({vcrEnabled:true},runtime,{vcr,resolveInvocation:async(_i,header,operation,body)=>verifyVcrInvocation({header,operation,body,project,runtimeManager:runtime,resolveSession:()=>null,runs:[{id:'run_gateway',sessionId:'global_a'},{id:'run_gateway_b',sessionId:'global_b'}]})});
 const invoke=async(session,body)=>{const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{method:'POST',url:'/internal/vcr/v1/read',headers:{authorization:'Bearer test','x-evimed-execution-context':JSON.stringify({v:1,sessionId:session,callId:'call'})}});let status,answer;const res={writeHead:code=>{status=code;},end:bytes=>{answer=JSON.parse(bytes);}};await handler(req,res);return{status,answer};};
 const a=await invoke('global_a',{what:'study'}),b=await invoke('global_b',{what:'study'});assert.equal(a.status,200);assert.equal(b.status,200);
 const contexts=await vcr.store.rows("SELECT id,conversation_session_id FROM evimed_vcr.studies WHERE user_id='gateway_user'");assert.equal(contexts.length,2);assert.notEqual(contexts[0].id,contexts[1].id);
 assert.equal((await invoke('global_a',{what:'matching'})).status,403);
});
test('legacy retired-role grants remain readable and can be revoked while new active grants are refused',options,async()=>{
 const study=await vcr.store.taskContext(origin('legacy_grant'));const source=await vcr.dataPlane.registerSource({studyId:study.id,userId:'owner',name:'Legacy grant fixture'});
 await vcr.store.query('ALTER TABLE evimed_vcr.grants DROP CONSTRAINT IF EXISTS grants_role_check');await vcr.store.query('ALTER TABLE evimed_vcr.grants DROP CONSTRAINT IF EXISTS vcr_grants_active_roles');
 await vcr.store.query("INSERT INTO evimed_vcr.grants (id,source_id,study_id,user_id,grantee,role) VALUES ('legacy_grant',$1,$2,'owner','legacy_site','site')",[source.id,study.id]);
 await vcr.store.query(vcrSchemaSql());
 const revoked=await vcr.dataStore.revokeGrant({grantId:'legacy_grant',studyId:study.id,actor:'owner'});assert.ok(revoked.revokedAt);
 await assert.rejects(vcr.store.query("INSERT INTO evimed_vcr.grants (id,source_id,study_id,user_id,grantee,role) VALUES ('new_retired',$1,$2,'owner','legacy_site','site')",[source.id,study.id]),{code:'23514'});
});
test('a failed post-commit consumer is replayed before a native completion is delivered',options,async()=>{
 const study=await vcr.store.taskContext(origin('hook_retry'));
 const queued=await vcr.jobs.enqueue({studyId:study.id,userId:'owner',kind:'design_analytic',scenario:{design:{kind:'two_arm_fixed'},endpoint:{type:'binary'},truth:{controlRate:0.3,treatmentRate:0.5}},idempotencyKey:'hook_retry',detail:{conversationOrigin:origin('hook_retry')}});
 let calls=0;vcr.jobs.addFinishHook(async done=>{if(done.job.id===queued.job.id){calls++;if(calls===1)throw Object.assign(new Error('Consumer temporarily unavailable'),{code:'consumer_unavailable'});}});
 await vcr.store.query("UPDATE evimed_vcr.jobs SET state='running',lease_owner=$2,lease_until=now()+interval '5 minutes' WHERE id=$1",[queued.job.id,vcr.jobs.owner]);
 await vcr.jobs.finish(queued.job.id,{status:'failed',error:{code:'test_failure',message:'Synthetic failure'}});
 assert.equal(calls,1);let delivered=0;
 const service=new VcrConversationCompletions({store:vcr.store,jobs:vcr.jobs,resolve:async()=>({user:{id:'owner'},project:{id:'default'},session:{mode:'open-domain'}}),
  inbox:async()=>({running:false,queued:0}),dispatch:async()=>{delivered++;},notify:async()=>{}});
 await service.tick();assert.equal(calls,2);assert.equal(delivered,1);await service.tick();assert.equal(delivered,1);
});
test('patient intake shares its transaction client and succeeds concurrently with a one-connection pool',options,async()=>{
 const small=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:1,databaseConnectionTimeoutMs:1000});
 try {
  const module=composeVcr({productDatabase:small,config:{vcrEnabled:true,vcrAudience:'all',vcrDataPlaneDir:dir,vcrProviderAgreements:true,
   vcrProviderAgreementReference:'Local synthetic fixture',deepseekBaseUrl:'https://model.invalid'}});await module.store.ready();
  const study=await module.store.taskContext(origin('one_connection'));study.cloudContext={runId:'run',sessionId:'one_connection'};
  const intake=createVcrPatientContext({store:module.store,dataStore:module.dataStore,dataPlane:module.dataPlane,documents:module.documents,
   transcript:async()=>({sessionId:'one_connection',messages:[{role:'user',source:'user',seq:1,parts:[{type:'text',text:'Synthetic user note, age 62.'}]}]}),isHumanMessage:async()=>true});
  const results=await Promise.all([intake(study,{messageSeq:1},origin('one_connection')),intake(study,{messageSeq:1},origin('one_connection'))]);
  assert.equal(results[0].documentId,results[1].documentId);assert.equal(results[0].subjectKey,results[1].subjectKey);
 } finally {await small.close();}
});
test('a hidden programme session resolves its scheduler-owned study instead of an empty task context',options,async()=>{
 const study=await vcr.store.createStudy({userId:'programme_owner',projectId:'programme_project',name:'Programme fixture'});
 await vcr.store.query("INSERT INTO evimed_vcr.schedule_marks (study_id,key,user_id,kind,state,dispatch_id) VALUES ($1,'run:definition','programme_owner','run','running','vcr-dispatch-fixture')",[study.id]);
 const nativeOrigin={userId:'programme_owner',projectId:'programme_project',rootSessionId:'hidden_step',sessionId:'hidden_step',runId:'hidden_run',callId:'call',dispatchId:'vcr-dispatch-fixture',programme:true};
 const handler=createVcrGatewayHandler({vcrEnabled:true},{assertActiveModelGatewayToken:()=>({userId:'programme_owner',projectId:'programme_project'})},{vcr,resolveInvocation:async()=>nativeOrigin});
 const req=Readable.from([Buffer.from(JSON.stringify({what:'study'}))]);Object.assign(req,{method:'POST',url:'/internal/vcr/v1/read',headers:{authorization:'Bearer test','x-evimed-execution-context':'trusted-fixture'}});
 let status;await handler(req,{writeHead:code=>{status=code;},end:()=>{}});assert.equal(status,200);
 const rows=await vcr.store.rows("SELECT scope FROM evimed_vcr.studies WHERE project_id='programme_project'");assert.deepEqual(rows,[{scope:'project'}]);
});
test('selected matching batches retain the verified origin before enqueue commit',options,async()=>{
 const study=await vcr.store.taskContext(origin('selected_matching'));study.executionOrigin=origin('selected_matching');study.completionOrigin=origin('selected_matching');
 const previous=vcr.matching.matchScenario;
 try {
  vcr.matching.matchScenario=async()=>({ok:true,protocolVersionId:'protocol_selected',scenario:{criteria:[{id:'age',kind:'inclusion',type:'demographic',state:'unknown'}]},inputs:[]});
  const batch=await vcr.matching.enqueuePanel(study,{protocolVersionIds:['protocol_selected']});assert.equal(batch.jobs.length,1);
  const job=await vcr.store.one('SELECT checkpoint,run_id FROM evimed_vcr.jobs WHERE id=$1',[batch.jobs[0].jobId]);assert.equal(job.checkpoint.conversationOrigin.rootSessionId,'selected_matching');assert.equal(job.run_id,'run');
 } finally {vcr.matching.matchScenario=previous;}
});
test('aggregate calculation terminal records reconcile into the same original-conversation outbox without creating a study',options,async()=>{
 await migrateProductStore(database);
 await database.query("INSERT INTO evimed_control.users (id,name,auth_type) VALUES ('owner','Synthetic owner','development') ON CONFLICT DO NOTHING");
 await database.query("INSERT INTO evimed_control.projects (user_id,id,name,quota_bytes) VALUES ('owner','default','Synthetic project',1000000) ON CONFLICT DO NOTHING");
 const payload={recordType:'result-replay',state:'succeeded',requestedBy:'owner',outputVersionId:'result_version_fixture',initial:{continuation:{schema:1,kind:'native-calculation'},producer:{sessionId:'replay_child',parentSessionId:'aggregate_root',runId:'original_run',callId:'original_call'}}};
 await database.query(`INSERT INTO evimed_product.documents (user_id,kind,id,project_id,payload) VALUES ('owner','result-replay','replay_fixture','default',$1::jsonb)`,[JSON.stringify(payload)]);
 let session;const service=new VcrConversationCompletions({store:vcr.store,resolve:async()=>({user:{id:'owner'},project:{id:'default'},session:{mode:'open-domain'}}),
  inbox:async()=>({running:false,queued:0}),dispatch:async(_u,_p,sid,_id,_text,options)=>{session=sid;assert.ok(options.systemSupplement.includes('research_calculate'));},notify:async()=>{}});
 await service.reconcileReplays();await service.reconcileReplays();await service.deliver();
 assert.equal(session,'aggregate_root');const rows=await vcr.store.rows("SELECT study_id,job_id FROM evimed_vcr.conversation_completions WHERE payload->>'replayId'='replay_fixture'");assert.deepEqual(rows,[{study_id:null,job_id:null}]);
});

test('a pending completion is suppressed when its study is deleted although the ordinary session survives',options,async()=>{
 const study=await vcr.store.taskContext(origin('deleted_study'));
 const resolver=createVcrCompletionResolver({accounts:{userById:async()=>({id:'owner'}),requireProject:async()=>({id:'default'})},studies:vcr.store,sessions:{get:async()=>({mode:'open-domain'})},allows:()=>true});
 const row={user_id:'owner',project_id:'default',study_id:study.id,root_session_id:'deleted_study'};
 assert.ok((await resolver(row)).session);await vcr.store.softDeleteStudy(study.id,'owner');assert.equal((await resolver(row)).session,null);
});
test('aggregate failed jobs are read from the job ledger even when the replay document still says running',options,async()=>{
 const payload={recordType:'result-replay',state:'running',cleanup:'confirmed',requestedBy:'owner',jobId:'replay_failed_job',initial:{continuation:{schema:1,kind:'native-calculation'},producer:{sessionId:'aggregate_failed_root',runId:'original_run',callId:'failed_call'}}};
 await database.query(`INSERT INTO evimed_product.jobs (id,user_id,project_id,kind,idempotency_key,payload,status,error) VALUES ('replay_failed_job','owner','default','result-replay','failed_fixture','{}','failed','{"code":"result_replay_timeout"}')`);
 await database.query(`INSERT INTO evimed_product.documents (user_id,kind,id,project_id,payload) VALUES ('owner','result-replay','replay_failed','default',$1::jsonb)`,[JSON.stringify(payload)]);
 const service=new VcrConversationCompletions({store:vcr.store,resolve:async()=>null,inbox:async()=>null,dispatch:async()=>{},notify:async()=>{}});await service.reconcileReplays();
 const row=await vcr.store.one("SELECT payload FROM evimed_vcr.conversation_completions WHERE payload->>'replayId'='replay_failed'");assert.equal(row.payload.state,'failed');assert.equal(row.payload.error.code,'result_replay_timeout');
});

test('deleting an ordinary project removes every conversation task scope and its outbox rows',options,async()=>{
 const a=await vcr.store.taskContext({userId:'delete_owner',projectId:'delete_project',rootSessionId:'a'});
 const b=await vcr.store.taskContext({userId:'delete_owner',projectId:'delete_project',rootSessionId:'b'});
 const removed=await vcr.store.transaction(client=>deleteVcrProjectRows(client,'delete_owner','delete_project'));
 assert.equal(removed.deleted,true);assert.deepEqual(new Set(removed.artifacts.studyIds),new Set([a.id,b.id]));
 assert.equal((await vcr.store.rows("SELECT 1 FROM evimed_vcr.studies WHERE project_id='delete_project'")).length,0);
});
test('omitting execution context cannot mutate a sibling project study from a shared runtime',options,async()=>{
 const study=await vcr.store.createStudy({userId:'shared_owner',projectId:'shared_project',name:'Existing project study'});
 const handler=createVcrGatewayHandler({vcrEnabled:true},{assertActiveModelGatewayToken:()=>({userId:'shared_owner',projectId:'shared_project'})},{vcr});
 const req=Readable.from([Buffer.from(JSON.stringify({what:'definition',data:{question:'Forged sibling write'}}))]);Object.assign(req,{method:'POST',url:'/internal/vcr/v1/write',headers:{authorization:'Bearer test'}});
 let status;await handler(req,{writeHead:code=>{status=code;},end:()=>{}});assert.equal(status,403);assert.equal(await vcr.store.latestDefinition(study.id),null);
});
test('local scheduling is bounded and lets another account advance while one holds a local slot',options,async()=>{
 const study=await vcr.store.taskContext({userId:'fair_owner',projectId:'fair_project',rootSessionId:'fair_root'});
 const job=await vcr.jobs.enqueue({studyId:study.id,userId:'fair_owner',kind:'match_criteria',scenario:{criteria:[{id:'age',kind:'inclusion',type:'demographic',state:'unknown'}]},idempotencyKey:'fair_local'});
 const claimed=await vcr.jobs.claim({lane:'local',limit:4});assert.ok(claimed.some(row=>row.id===job.job.id));
 const running=await vcr.store.rows("SELECT user_id FROM evimed_vcr.jobs WHERE state='running' AND method='matching.evaluate'");assert.ok(running.length<=2);assert.equal(running.filter(row=>row.user_id==='owner').length,1);
});
test('reconciliation finalizes committed result lineage before continuing',options,async()=>{
 const study=await vcr.store.taskContext(origin('landed_result'));
 vcr.orchestrator=new VcrOrchestrator({store:vcr.store,jobs:vcr.jobs,config:{vcrEnabled:true}});
 const saved=await vcrRuntimeWrite({store:vcr.store,service:vcr.service,study,what:'trial_scenario',items:[{label:'Synthetic design',design:'two_arm_fixed',endpointType:'binary',configuration:{design:{kind:'two_arm_fixed'},truth:{controlRate:0.3,treatmentRate:0.5}}}]});assert.equal(saved.ok,true);
 const subjectId=saved.ids[0],scenario={design:{kind:'two_arm_fixed'},endpoint:{type:'binary'},truth:{controlRate:0.3,treatmentRate:0.5}};
 const queued=await vcr.jobs.enqueue({studyId:study.id,userId:'owner',kind:'design_analytic',scenario,idempotencyKey:'landed_result',detail:{node:`trial_scenario:${subjectId}@1`,subjectId,resultKind:'trial_scenario',conversationOrigin:origin('landed_result')}});
 await vcr.store.query("UPDATE evimed_vcr.jobs SET state='running',lease_owner=$2,lease_until=now()+interval '5 minutes' WHERE id=$1",[queued.job.id,vcr.jobs.owner]);
 const result={jobId:queued.job.id,status:'succeeded',method:'design.analytic',methodVersion:'1.1.0',scenarioHash:vcrScenarioHash(scenario),seed:queued.job.seed,replicates:null,conclusion:'estimable',counts:{realPatients:0,events:null,effectiveSampleSize:null,generatedRecords:0},measures:[{name:'required_n',value:120,source:'assumed',simulated:false}],diagnostics:{},tables:[],manifest:{engineVersion:'fixture',rVersion:'fixture',packageLockHash:'a'.repeat(64)}};result.manifest.outputHash=vcrComputedOutputHash(result);
 const hooks=vcr.jobs.finishHooks;vcr.jobs.finishHooks=[];let finished;
 try {finished=await vcr.jobs.finish(queued.job.id,{status:'succeeded',result,outputHash:result.manifest.outputHash});} finally {vcr.jobs.finishHooks=hooks;}
 assert.equal((await vcr.store.trialScenarios(study.id))[0].resultId,finished.result.id);
 assert.equal((await vcr.store.rows("SELECT 1 FROM evimed_vcr.dependencies WHERE study_id=$1 AND to_node=$2",[study.id,`result:${finished.result.id}@${finished.result.version}`])).length,0);
 await vcr.store.query("UPDATE evimed_vcr.jobs SET checkpoint=checkpoint-'completionHooksApplied' WHERE id=$1",[queued.job.id]);
 let continued=0;const completions=new VcrConversationCompletions({store:vcr.store,jobs:vcr.jobs,resolve:async row=>row.root_session_id==='landed_result' ? {user:{id:'owner'},project:{id:'default'},session:{}} : null,
  inbox:async()=>({running:false,queued:0}),dispatch:async()=>{assert.equal((await vcr.store.trialScenarios(study.id))[0].resultId,finished.result.id);continued++;},notify:async()=>{}});
 await completions.tick();assert.equal((await vcr.store.trialScenarios(study.id))[0].resultId,finished.result.id);assert.equal((await vcr.store.rows("SELECT 1 FROM evimed_vcr.dependencies WHERE study_id=$1 AND to_node=$2",[study.id,`result:${finished.result.id}@${finished.result.version}`])).length,1);assert.equal(continued,1);await completions.tick();assert.equal(continued,1);
});

test('historical terminal aggregate calculations without an owned continuation marker never resume old conversations',options,async()=>{
 const payload={recordType:'result-replay',state:'succeeded',cleanup:'confirmed',requestedBy:'owner',outputVersionId:'old_result',initial:{producer:{sessionId:'old_conversation',runId:'old_run',callId:'old_call'}}};
 await database.query(`INSERT INTO evimed_product.documents (user_id,kind,id,project_id,payload) VALUES ('owner','result-replay','historical_replay','default',$1::jsonb)`,[JSON.stringify(payload)]);
 const service=new VcrConversationCompletions({store:vcr.store,resolve:async()=>null,inbox:async()=>null,dispatch:async()=>{throw new Error('Historical conversation must not resume');},notify:async()=>{}});await service.reconcileReplays();
 assert.equal((await vcr.store.rows("SELECT 1 FROM evimed_vcr.conversation_completions WHERE payload->>'replayId'='historical_replay'")).length,0);
});

test('historical finish-consumer replay preserves the current generation pointer and population quality',options,async()=>{
 const study=await vcr.store.taskContext(origin('superseded_consumer'));
 const population=await vcr.store.savePopulation({studyId:study.id,userId:'owner',name:'Synthetic population',kind:'scenario'});
 const old=await vcr.store.recordResult({studyId:study.id,userId:'owner',kind:'population',subjectId:population.id,conclusion:'estimable',counts:{generatedRecords:100},measures:[],diagnostics:{}});
 const current=await vcr.store.recordResult({studyId:study.id,userId:'owner',kind:'population',subjectId:population.id,conclusion:'estimable',counts:{generatedRecords:200},measures:[],diagnostics:{}});
 await vcr.store.query("UPDATE evimed_vcr.populations SET quality='{\"currentGeneration\":true}'::jsonb WHERE id=$1",[population.id]);
 await vcr.orchestrator.onJobFinished({job:{id:'historical_finished',studyId:study.id,kind:'generate_population',state:'succeeded',checkpoint:{node:`population:${population.id}@${population.version}`,subjectId:population.id,resultKind:'population'}},result:old});
 const retained=await vcr.store.one('SELECT result_id,quality FROM evimed_vcr.populations WHERE id=$1',[population.id]);assert.equal(retained.result_id,current.id);assert.deepEqual(retained.quality,{currentGeneration:true});
});

test('reply facts isolate ended ordinary task conversations, canonical and programme scopes without creating contexts',options,async()=>{
 const userId='reply_owner',projectId='reply_project';
 const legacy=await vcr.store.createStudy({userId,projectId,name:'Legacy reply fixture'});await vcr.store.setConversationSession(legacy.id,'legacy_reply');
 const a=await vcr.store.taskContext({userId,projectId,rootSessionId:'reply_a'}),b=await vcr.store.taskContext({userId,projectId,rootSessionId:'reply_b'});
 for(const [study,value] of [[legacy,11],[a,71],[b,91]]) await vcr.store.recordResult({studyId:study.id,userId,kind:'trial_scenario',conclusion:'estimable',counts:{generatedRecords:0},measures:[{name:'required_n',value}],diagnostics:{}});
 await vcr.store.query("INSERT INTO evimed_vcr.schedule_marks (study_id,key,user_id,kind,state,dispatch_id) VALUES ($1,'reply-programme',$2,'run','done','reply_dispatch')",[legacy.id,userId]);
 const before=Number((await vcr.store.one('SELECT count(*) AS n FROM evimed_vcr.studies WHERE user_id=$1',[userId])).n);
 const facts=async(sessionId,extra={})=>vcr.service.replyCheckFacts({userId,projectId,sessionId,run:{id:'finished_reply_run',status:'succeeded',sessionId,...extra.run},...extra});
 const values=held=>held.results.flatMap(result=>result.measures).map(measure=>measure.value);
 assert.deepEqual(values(await facts('reply_a')),[71]);assert.deepEqual(values(await facts('reply_b')),[91]);assert.deepEqual(values(await facts('legacy_reply')),[11]);assert.equal(await facts('unrelated_reply'),null);
 assert.equal(await facts('reply_a',{studyId:b.id}),null);assert.equal(await facts('reply_a',{run:{id:'mismatch',status:'succeeded',sessionId:'reply_b'}}),null);
 const programme=await facts('hidden_reply',{run:{id:'ended_programme',status:'succeeded',sessionId:'hidden_reply',effectiveRouteReason:'vcr:analysis',dispatchId:'reply_dispatch'}});assert.equal(programme.studyId,legacy.id);
 await vcr.store.softDeleteStudy(a.id,userId);assert.equal(await facts('reply_a'),null);assert.deepEqual(values(await facts('reply_b')),[91]);
 assert.equal(Number((await vcr.store.one('SELECT count(*) AS n FROM evimed_vcr.studies WHERE user_id=$1',[userId])).n),before);
});
