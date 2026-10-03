import assert from 'node:assert/strict';
import test from 'node:test';
import {RuntimeManager} from '../src/runtimeManager.mjs';
const project={userId:'fixture-owner',id:'fixture-project'};
const currentImage='sha256:'+'a'.repeat(64);
const baseline={reference:null,identity:{baseRuntimeImageDigest:currentImage,adapterRevision:'sha256:'+'b'.repeat(64),permissionProfileRevision:'sha256:'+'c'.repeat(64)},projection:{plugins:[],personal:{reference:null,pins:[]}}};

test('preparation refuses an obsolete base or unbounded baseline tool selection before native replacement',async()=>{
  const manager=new RuntimeManager({runtimeIdleTimeoutMs:0});manager.inspectRuntimeImage=async()=>({imageId:currentImage});
  assert.equal((await manager.prepareGeneration(project,baseline)).joined,true);
  await assert.rejects(manager.prepareGeneration(project,{...baseline,identity:{...baseline.identity,baseRuntimeImageDigest:'sha256:'+'d'.repeat(64)}}),{code:'extension_contract_invalid'});
  await assert.rejects(manager.prepareGeneration(project,{...baseline,projection:{...baseline.projection,plugins:[{extensionId:'arbitrary-plugin',enabled:true}]}}),{code:'extension_contract_invalid'});
});
test('idle replacement is joined, while actual native busy observation leaves the captured runtime untouched',async()=>{
  const manager=new RuntimeManager({runtimeIdleTimeoutMs:0});manager.inspectRuntimeImage=async()=>({imageId:currentImage});
  let busy=true,stops=0,starts=0;manager.pluginRuntimeBusy=async()=>busy;manager.stop=async()=>{stops++;};manager.startAdmitted=async()=>{starts++;assert.deepEqual(manager.extensionGenerationOverrides.get(manager.key(project)),baseline);return{};};
  await assert.rejects(manager.replaceGeneration(project,baseline),{code:'plugin_runtime_busy'});assert.equal(stops,0);
  busy=false;assert.deepEqual(await manager.replaceGeneration(project,baseline),{joined:true});assert.equal(stops,1);assert.equal(starts,1);assert.equal(manager.extensionGenerationOverrides.size,0);
  manager.startAdmitted=async()=>{throw new Error('controlled startup failure');};await assert.rejects(manager.restoreGeneration(project,baseline),/controlled startup failure/u);assert.equal(manager.extensionGenerationOverrides.size,0);
});
test('target native registry facts are joined to unchanged runtime epoch, not caller permission flags',async()=>{
  const manager=new RuntimeManager({runtimeIdleTimeoutMs:0});manager.runtimes.set(manager.key(project),{modelGatewayTokenJti:'actual-epoch'});
  manager.callKernel=async(_runtime,_project,method,args)=>{assert.equal(method,'evimedPlugins/extensionInvocationFacts');assert.deepEqual(args,{request:{sessionId:'actual-session'}});return{sessionId:'actual-session',agentId:'actual-session',tools:['doc_read'],running:true,origin:'root'};};
  assert.deepEqual(await manager.extensionInvocationFacts(project,'actual-session'),{sessionId:'actual-session',agentId:'actual-session',tools:['doc_read'],running:true,origin:'root',runtimeGeneration:'actual-epoch'});
  manager.callKernel=async()=>{manager.runtimes.get(manager.key(project)).modelGatewayTokenJti='replacement';return{sessionId:'actual-session',agentId:'actual-session',tools:['doc_read'],running:true,origin:'root'};};
  await assert.rejects(manager.extensionInvocationFacts(project,'actual-session'),{code:'extension_access_denied'});
});

test('stale composite refuses new queued turns definitively, permits only verified active steer, and safe baseline remains usable',async()=>{
  const manager=new RuntimeManager({runtimeIdleTimeoutMs:0}),runtime={modelGatewayTokenJti:'captured',extensionGeneration:{...baseline,reference:{generationHash:'old-generation'}}};manager.runtimes.set(manager.key(project),runtime);manager.extensionGenerationResolver=async()=>null;
  await assert.rejects(manager.assertPersonalSkillPromptGeneration(project,{sessionId:'active-session',mode:'queue'}),{code:'extension_contract_invalid',definitivelyRejected:true});
  manager.callKernel=async()=>({items:[{sessionId:'active-session',running:true},{sessionId:'idle-session',running:false}]});
  await manager.assertPersonalSkillPromptGeneration(project,{sessionId:'active-session',mode:'steer'});
  await assert.rejects(manager.assertPersonalSkillPromptGeneration(project,{sessionId:'idle-session',mode:'steer'}),{definitivelyRejected:true});
  runtime.extensionGeneration=baseline;await manager.assertPersonalSkillPromptGeneration(project,{sessionId:'ordinary',mode:'queue'});
});
