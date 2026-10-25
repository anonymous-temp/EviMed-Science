import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PostgresStore } from '../src/store.mjs';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoSharedContext } from '../src/geoSharedContext.mjs';
import { PluginService } from '../src/pluginService.mjs';
import { RuntimeManager } from '../src/runtimeManager.mjs';
import { loadConfig } from '../src/config.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required',timeout:20000};
test('one-connection exclusive cutover writes durable successful receipts and preserves accepted prior epochs',options,async t=>{
 const isolated=await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'safecontext');
 const dataDir=await fs.mkdtemp('/tmp/n12-pg-');
 const config=loadConfig({dataDir,databaseUrl:isolated.url,stateStore:'postgres',databasePoolMax:1,databaseConnectionTimeoutMs:5000,runtimeMode:'kernel',runtimeProvider:'docker',runtimeSandboxMode:'docker',runtimeTransport:'unix',runtimeNetworkMode:'bridge',runtimeContainerImage:'evimed-runtime:test',runtimeIdleTimeoutMs:0,runtimeQuotaCheckIntervalMs:0,deepseekModel:'deepseek-flash',modelGatewayInternalUrl:'http://gateway:8787/internal/model/v1',modelGatewaySigningSecret:'shared-test-secret-long-enough-for-gateway'});
 const accounts=new PostgresStore(config);t.after(async()=>{await accounts.database.close();await isolated.drop();await fs.rm(dataDir,{recursive:true,force:true});});
 await accounts.createUser('owner','local-fixture-password','owner');const owner=await accounts.userById('owner'),project=await accounts.requireProject(owner,'default');
 const geoStore=new GeoStore({database:accounts.database});await geoStore.ready();await geoStore.addMember({geoId:(await geoStore.createProject({userId:owner.id,projectId:project.id,engines:['deepseek'],coverageDays:30})).id,userId:'member',role:'editor',invitedBy:owner.id});
 const documents=new ProductDocuments(accounts.database),manager=new RuntimeManager(config),plugin=new PluginService(accounts.database);
 manager.contextDocuments=documents;manager.contextPolicies=new GeoSharedContext({database:accounts.database,documents});manager.pluginService=plugin;
 manager.provider.preflight=async()=>{};manager.cleanupDocker=async()=>({cleaned:false});manager.waitUntilReady=async()=>{};
 manager.provider.launch=async()=>{const child=new EventEmitter();child.pid=123;return child;};manager.provider.close=async()=>{};
 manager.idleVerdict=async()=> 'idle';manager.pluginRuntimeBusy=async()=>false;
 manager.enforceProjectQuota=async()=>{};manager.makeRoomFor=async()=>{};manager.enforceRuntimeCapacity=()=>{};
 manager.runtimes.set(manager.key(project),{kind:'dsh',project,workspaceDir:project.workspaceDir,close:async()=>{},modelGatewayTokenJti:'prior-owned-epoch'});
 assert.deepEqual(await manager.ensureContextPolicyGeneration(project),{adopted:true});
 const receipt=await manager.launchedContextReceipt(project);assert.equal(receipt.state,'launched');assert.deepEqual(await manager.historicalContextReceipt(project,receipt.referenceId),receipt);
 await plugin.withAdmission(project,async()=>assert.equal((await manager.launchedContextReceipt(project)).generation,receipt.generation));
 await accounts.database.query("INSERT INTO evimed_product.plugin_prompt_admissions(id,user_id,project_id) VALUES ('00000000-0000-0000-0000-000000000001',$1,$2)",[project.userId,project.id]);
 const live=manager.runtimes.get(manager.key(project));delete live.contextLaunchReceipt;
 assert.deepEqual(await manager.ensureContextPolicyGeneration(project),{adopted:false,pending:true});assert.equal(manager.runtimes.get(manager.key(project)),live);
 await accounts.database.query('DELETE FROM evimed_product.plugin_prompt_admissions WHERE user_id=$1 AND project_id=$2',[project.userId,project.id]);
 assert.deepEqual(await manager.ensureContextPolicyGeneration(project),{adopted:true});
 const next=await manager.launchedContextReceipt(project);assert.notEqual(next.generation,receipt.generation);assert.equal(next.stateDirectory,receipt.stateDirectory);
 assert.deepEqual(await manager.historicalContextReceipt(project,receipt.referenceId),receipt);
 const restarted=new RuntimeManager(config);restarted.contextDocuments=documents;assert.deepEqual(await restarted.historicalContextReceipt(project,receipt.referenceId),receipt);
 await manager.closeAll();
});

async function admissionFixture(t,label) {
 const isolated=await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,label),dataDir=await fs.mkdtemp('/tmp/n12-race-');
 const config=loadConfig({dataDir,databaseUrl:isolated.url,stateStore:'postgres',databasePoolMax:1,databaseConnectionTimeoutMs:5000,runtimeMode:'kernel',runtimeProvider:'docker',runtimeSandboxMode:'docker',runtimeTransport:'unix',runtimeNetworkMode:'bridge',runtimeContainerImage:'evimed-runtime:test',runtimeIdleTimeoutMs:0,runtimeQuotaCheckIntervalMs:0,deepseekModel:'deepseek-flash',modelGatewayInternalUrl:'http://gateway:8787/internal/model/v1',modelGatewaySigningSecret:'shared-test-secret-long-enough-for-gateway'});
 const accounts=new PostgresStore(config);t.after(async()=>{await accounts.database.close();await isolated.drop();await fs.rm(dataDir,{recursive:true,force:true});});
 await accounts.createUser('owner','local-fixture-password','owner');const owner=await accounts.userById('owner'),project=await accounts.requireProject(owner,'default');
 const geoStore=new GeoStore({database:accounts.database});await geoStore.ready();await geoStore.addMember({geoId:(await geoStore.createProject({userId:owner.id,projectId:project.id,engines:['deepseek'],coverageDays:30})).id,userId:'member',role:'editor',invitedBy:owner.id});
 const documents=new ProductDocuments(accounts.database),manager=new RuntimeManager(config);manager.contextDocuments=documents;manager.contextPolicies=new GeoSharedContext({database:accounts.database,documents});manager.pluginService=new PluginService(accounts.database);
 manager.provider.preflight=async()=>{};manager.cleanupDocker=async()=>({cleaned:false});manager.waitUntilReady=async()=>{};manager.provider.launch=async()=>{const child=new EventEmitter();child.pid=123;return child;};manager.provider.close=async()=>{};manager.idleVerdict=async()=> 'idle';manager.pluginRuntimeBusy=async()=>false;manager.enforceProjectQuota=async()=>{};manager.makeRoomFor=async()=>{};manager.enforceRuntimeCapacity=()=>{};
 return {manager,accounts,documents,project};
}
test('admitted shared refresh and final queue/steer sends refuse withdrawals with one database client',options,async t=>{
 const f=await admissionFixture(t,'contextdispatch'),m=f.manager;let allowed=true;
 const row={id:'allowed',revision:1,projectId:f.project.id,payload:{capsuleId:'capsule',projectId:f.project.id,content:'authorized method before withdrawal',contentDigest:'a'.repeat(64),status:'approved',origin:'explicit',factKind:'method_preference',layer:'preferences'}};
 m.capsuleService={active:async()=>({items:[{capsuleId:'capsule'}]}),get:async()=>({payload:{}}),entries:async()=>({items:[row],nextCursor:null}),inForce:async()=>true,documents:{get:async()=>row}};m.contextItems={capsule:async()=>allowed};
 const runtime=await m.startKernel(f.project);m.runtimes.set(m.key(f.project),runtime);const receipt=await m.launchedContextReceipt(f.project);
 const originalAssert=m.assertPersonalSkillPromptGeneration.bind(m);m.assertPersonalSkillPromptGeneration=async(...args)=>{await originalAssert(...args);allowed=false;};
 const originalIndependent=f.accounts.database.withoutTransactionClient.bind(f.accounts.database);let nestedExclusive=0;
 f.accounts.database.withoutTransactionClient=work=>{if(f.accounts.database.transactionScope())nestedExclusive++;return originalIndependent(work);};
 await m.pluginService.withAdmission(f.project,async()=>{
  assert.deepEqual(await m.ensureContextPolicyGeneration(f.project),{adopted:false});
  allowed=false;await assert.rejects(m.ensureContextPolicyGeneration(f.project),{code:'runtime_context_unverified'});
 });
 const forwarded=[];m.callKernel=async(runtime,project,method)=>{forwarded.push(method);return {};};
 for(const mode of ['queue','steer']) {
  allowed=true;await assert.rejects(m.dispatchPrompt(f.project,`new-${mode}`,{text:'new prompt after withdrawal',mode}),{code:'runtime_context_unverified'});
  assert.deepEqual(forwarded,[]);assert.equal(m.runtimes.get(m.key(f.project)),runtime);assert.equal(runtime.modelGatewayTokenJti,receipt.generation);
 }
 assert.equal(nestedExclusive,0,'held admission never detaches to obtain an exclusive/second client');
 m.assertPersonalSkillPromptGeneration=originalAssert;allowed=true;
 m.callKernel=async(runtime,project,method)=>{forwarded.push(method);if(method==='session/create')allowed=false;return {};};
 await assert.rejects(m.dispatchPrompt(f.project,'withdraw-at-create',{text:'withdrawal immediately before actual prompt send'}),{code:'runtime_context_unverified'});
 assert.deepEqual(forwarded,['session/create'],'the final freshness assertion runs after session creation and before session/prompt');
 assert.deepEqual(await m.historicalContextReceipt(f.project,receipt.referenceId),receipt,'previous accepted epoch receipt survives refusal');
 await m.closeAll();
});
test('late shared activation failure commits no positive receipt under real PostgreSQL admission',options,async t=>{
 const f=await admissionFixture(t,'contextlatefailure');
 const prior=await f.manager.startKernel(f.project),accepted=prior.contextLaunchReceipt;await prior.close();
 let closed=false,failedGeneration=null;f.manager.provider.close=async()=>{closed=true;};
 f.manager.activateModelGatewayRuntime=(project,runtime)=>{failedGeneration=runtime.modelGatewayTokenJti;throw new Error('late activation failure');};
 await assert.rejects(f.manager.pluginService.withAdmission(f.project,()=>f.manager.startKernel(f.project)),/late activation failure/);
 assert.equal(closed,true);
 const receipts=(await f.documents.list(f.project.userId,'geo-plan-context',{projectId:f.project.id,filter:{recordType:'geo-runtime-context-launch'}})).items;
 assert.equal(receipts.length,1);assert.ok(receipts.every(row=>row.payload.generation!==failedGeneration));
 assert.deepEqual(await f.manager.historicalContextReceipt(f.project,accepted.referenceId),accepted,'successful accepted history remains readable after a later failed launch');
});

for(const boundary of ['readiness','final-authority','receipt-publication'])test(`an observed child exit at ${boundary} cannot publish a successful launch`,options,async t=>{
 const f=await admissionFixture(t,'contextexit'),m=f.manager;m.provider.afterExit=()=>{};
 const prior=await m.startKernel(f.project),accepted=prior.contextLaunchReceipt;await prior.close();
 let child,failedGeneration;
 m.provider.launch=async()=>{child=new EventEmitter();child.pid=321;return child;};
 const activate=m.activateModelGatewayRuntime.bind(m);m.activateModelGatewayRuntime=(project,runtime)=>{failedGeneration=runtime.modelGatewayTokenJti;return activate(project,runtime);};
 if(boundary==='readiness')m.waitUntilReady=async()=>{child.emit('exit',1,null);};
 if(boundary==='final-authority'){
  let checks=0;const assertDesired=m.assertSharedDesired.bind(m);
  m.assertSharedDesired=async(...args)=>{await assertDesired(...args);if(++checks===3)child.emit('exit',1,null);};
 }
 if(boundary==='receipt-publication'){
  const put=f.documents.put.bind(f.documents);
  f.documents.put=async(...args)=>{const saved=await put(...args);if(args[3]?.recordType==='geo-runtime-context-launch')child.emit('exit',1,null);return saved;};
 }
 await assert.rejects(m.pluginService.withAdmission(f.project,()=>m.startKernel(f.project)),{code:'runtime_exited'});
 assert.equal(m.activeModelGatewayTokens.has(failedGeneration),false);
 const receipts=(await f.documents.list(f.project.userId,'geo-plan-context',{projectId:f.project.id,filter:{recordType:'geo-runtime-context-launch'}})).items;
 assert.equal(receipts.length,1);assert.deepEqual(await m.historicalContextReceipt(f.project,accepted.referenceId),accepted);
 await new Promise(resolve=>setImmediate(resolve));
});


test('cold shared waiters coalesce one admission and verify a real successful launch receipt',options,async t=>{
 const f=await admissionFixture(t,'contextcoldwaiters'),m=f.manager;
 let finish,entered,boots=0,admissions=0;
 const gate=new Promise(resolve=>{finish=resolve;}),began=new Promise(resolve=>{entered=resolve;});
 const launch=m.provider.launch.bind(m.provider),admit=m.pluginService.withAdmission.bind(m.pluginService);
 m.provider.launch=async plan=>{boots++;entered();await gate;return launch(plan);};
 m.pluginService.withAdmission=(project,operation,settings)=>admit(project,async()=>{admissions++;return operation();},settings);
 const first=m.start(f.project);
 await began;
 const second=m.start({...f.project});
 finish();
 const [left,right]=await Promise.all([first,second]);
 assert.equal(left,right);assert.equal(boots,1);assert.equal(admissions,1);
 const receipt=await m.launchedContextReceipt(f.project);
 assert.equal(receipt.state,'launched');assert.equal(left.contextLaunchReceipt.referenceId,receipt.referenceId);
 assert.deepEqual(await m.historicalContextReceipt(f.project,receipt.referenceId),receipt);
 assert.equal(f.accounts.database.pool.totalCount,1);assert.equal(m.starts.size,0);
 await m.closeAll();
});

for(const change of ['withdrawal','policy-revision'])test(`a pool-one cold waiter refuses ${change} while its policy read is queued`,options,async t=>{
 const f=await admissionFixture(t,'contextcoldwithdrawal'),m=f.manager;
 let allowed=true,finish,entered,waiterQueued;
 const row={id:'allowed',revision:1,projectId:f.project.id,payload:{capsuleId:'capsule',projectId:f.project.id,content:'authorized before cold-start withdrawal',contentDigest:'a'.repeat(64),status:'approved',origin:'explicit',factKind:'method_preference',layer:'preferences'}};
 m.capsuleService={active:async()=>({items:[{capsuleId:'capsule'}]}),get:async()=>({payload:{}}),entries:async()=>({items:[row],nextCursor:null}),inForce:async()=>true,documents:{get:async()=>row}};
 m.contextItems={capsule:async()=>allowed};
 const prior=await m.startKernel(f.project),accepted=prior.contextLaunchReceipt;await prior.close();
 const gate=new Promise(resolve=>{finish=resolve;}),began=new Promise(resolve=>{entered=resolve;}),queued=new Promise(resolve=>{waiterQueued=resolve;});
 const launch=m.provider.launch.bind(m.provider),policy=m.contextPolicyFor.bind(m);
 m.provider.launch=async plan=>{entered();await gate;return launch(plan);};
 m.contextPolicyFor=async project=>{const reading=policy(project);if(project.waiter)waiterQueued();return reading;};
 const operator=new ControlPlaneDatabase({databaseUrl:m.config.databaseUrl,databasePoolMax:1,databaseConnectionTimeoutMs:500});
 await operator.migrate();
 const first=m.start(f.project);
 await began;
 const second=m.start({...f.project,waiter:true});
 const outcomes=Promise.allSettled([first,second]);
 try {
  await queued;assert.equal(f.accounts.database.pool.totalCount,1);
  if(change==='withdrawal')allowed=false;
  else await operator.query("UPDATE evimed_product.documents SET revision=revision+1 WHERE user_id=$1 AND kind='geo-plan-context' AND payload->>'recordType'='geo-native-context-policy'",[f.project.userId]);
 } finally {finish();await operator.close();}
 for(const outcome of await outcomes){assert.equal(outcome.status,'rejected');assert.equal(outcome.reason.code,'runtime_context_unverified');}
 assert.equal(m.runtimes.size,0);assert.equal(m.starts.size,0);assert.equal(m.coldStartAttempts.size,0);
 assert.deepEqual(await m.historicalContextReceipt(f.project,accepted.referenceId),accepted);
 const receipts=(await f.documents.list(f.project.userId,'geo-plan-context',{projectId:f.project.id,filter:{recordType:'geo-runtime-context-launch'}})).items;
 assert.equal(receipts.length,1,'the refused epoch publishes no positive launch proof');
});
