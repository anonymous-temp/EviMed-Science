import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareContextGeneration, verifyContextGeneration, remediateStartupContext } from '../src/runtimeContextGeneration.mjs';
const policy = {kind:'geo-project',ownerId:'owner',controlProjectId:'project',geoProjectId:'geo',ownerCreatedAt:'2026-01-01',projectCreatedAt:'2026-01-02',policyVersion:1,revision:1,referenceId:'policy',namespace:{id:'namespace'}};
async function fixture(t) {
  const root=await fs.mkdtemp('/tmp/n12-context-'); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project={userId:'owner',id:'project',rootDir:path.join(root,'project'),workspaceDir:path.join(root,'project/workspace'),runtimeDir:path.join(root,'project/runtime'),metaDir:path.join(root,'project/meta')};
  await fs.mkdir(project.workspaceDir,{recursive:true}); return {config:{dataDir:root},project};
}
const materialize=async directory=>{await fs.mkdir(path.join(directory,'method'),{recursive:true});await fs.writeFile(path.join(directory,'method/SKILL.md'),'authorized method');await fs.writeFile(path.join(directory,'method/run.py'),'authorized attachment');return {count:1,contextPolicy:{policyRef:'policy'},identities:[{id:'method',revision:1}],learned:[],capsule:[],version:'1'};};
test('immutable context generation checks every body and attachment and has a distinct pending queue',async t=>{
 const {config,project}=await fixture(t);const one=await prepareContextGeneration(config,project,policy,materialize);
 const two=await prepareContextGeneration(config,project,policy,materialize);assert.equal(one.digest,two.digest);
 assert.equal(one.directory,two.directory);assert.ok(!one.directory.startsWith(project.workspaceDir));
 assert.equal((await verifyContextGeneration(config,project,one.reference)).digest,one.digest);
 const other=await prepareContextGeneration(config,project,{...policy,revision:2},materialize);assert.notEqual(one.pendingDirectory,other.pendingDirectory);
 await fs.mkdir(one.pendingHostDirectory,{recursive:true});await fs.writeFile(path.join(one.pendingHostDirectory,'old.json'),'old personal queue');
 assert.equal(await fs.readFile(path.join(one.pendingHostDirectory,'old.json'),'utf8'),'old personal queue');
 await fs.chmod(path.join(one.directory,'methods/method/run.py'),0o600);await fs.writeFile(path.join(one.directory,'methods/method/run.py'),'foreign text');
 await assert.rejects(verifyContextGeneration(config,project,one.reference),{code:'runtime_context_unverified'});
});
test('context generation refuses symlinks and forged manifests',async t=>{
 const {config,project}=await fixture(t); await assert.rejects(prepareContextGeneration(config,project,policy,async directory=>{await fs.mkdir(directory,{recursive:true});await fs.symlink('/etc/passwd',path.join(directory,'secret'));return {};}),{code:'runtime_context_unverified'});
 const one=await prepareContextGeneration(config,project,policy,materialize);await fs.chmod(path.join(one.directory,'manifest.json'),0o600);await fs.writeFile(path.join(one.directory,'manifest.json'),'{}');await assert.rejects(verifyContextGeneration(config,project,one.reference),{code:'runtime_context_unverified'});
});
test('startup remediation retains known producer context and ordinary research files',async t=>{
 const {config,project}=await fixture(t);await fs.mkdir(path.join(project.workspaceDir,'.evimed-brief'),{recursive:true});await fs.writeFile(path.join(project.workspaceDir,'.evimed-brief/private.md'),'private');await fs.writeFile(path.join(project.workspaceDir,'research.md'),'ordinary');
 const inventory=await remediateStartupContext(config,project,policy);assert.equal(inventory.length,1);assert.equal(await fs.readFile(path.join(inventory[0].recoveryDirectory,'private.md'),'utf8'),'private');assert.equal(await fs.readFile(path.join(project.workspaceDir,'research.md'),'utf8'),'ordinary');await assert.rejects(fs.stat(path.join(project.workspaceDir,'.evimed-brief')),{code:'ENOENT'});
});

import { EventEmitter } from 'node:events';
import { RuntimeManager, DockerRuntimeProvider, buildRuntimeLaunchPlan, capsuleMethodsHostDir } from '../src/runtimeManager.mjs';
import { contextPolicyIdentity } from '../src/geoContextItems.mjs';
const launchConfig = {runtimeProvider:'docker',runtimeMode:'kernel',runtimeSandboxMode:'docker',runtimeContainerBin:'docker',runtimeContainerImage:'evimed-runtime:test',runtimeTransport:'unix',runtimeNetworkMode:'bridge',runtimeCpuLimit:1,runtimeMemoryLimit:'1g',runtimePidsLimit:128,deepseekModel:'deepseek-flash',modelGatewayInternalUrl:'http://gateway:8787/internal/model/v1',modelGatewaySigningSecret:'shared-test-secret-long-enough-for-gateway',runtimeIdleTimeoutMs:0};
async function managerFixture(t) {
 const f=await fixture(t),manager=new RuntimeManager({...launchConfig,...f.config});
 manager.contextPolicies={forProject:async()=>policy};const rows=new Map();
 manager.contextDocuments={database:{transaction:async operation=>{const previous=new Map(rows);try{return await operation({});}catch(error){rows.clear();for(const [key,value] of previous)rows.set(key,value);throw error;}},withTransactionClient:async(_client,operation)=>operation()},put:async(userId,kind,id,payload,options)=>{rows.set(id,{id,kind,projectId:options.projectId,payload});},get:async(userId,kind,id)=>rows.get(id)??null};
 manager.provider.preflight=async()=>{};manager.cleanupDocker=async()=>({cleaned:false});manager.waitUntilReady=async()=>{};
 let plan; manager.provider.launch=async(project,input)=>{plan=input;const child=new EventEmitter();child.pid=123;return child;};manager.provider.close=async()=>{};
 return {...f,manager,rows,plan:()=>plan};
}
async function launch(f) {const runtime=await f.manager.startKernel(f.project);f.manager.runtimes.set(f.manager.key(f.project),runtime);return runtime;}
test('successful lifecycle receipts bind actual read-only mounts, isolated state, pending directory and namespace',async t=>{
 const f=await managerFixture(t);await fs.mkdir(capsuleMethodsHostDir(f.project),{recursive:true});await fs.writeFile(path.join(capsuleMethodsHostDir(f.project),'foreign.md'),'PRIVATE FOREIGN');
 const runtime=await launch(f),receipt=await f.manager.launchedContextReceipt(f.project),plan=f.plan();
 assert.equal(receipt.generation,runtime.modelGatewayTokenJti);assert.deepEqual(receipt.policy,contextPolicyIdentity(policy));
 assert.ok(plan.args.includes(`OPENVIKING_PENDING_DIR=${receipt.pendingDirectory}`));
 assert.ok(plan.args.includes(`type=bind,src=${receipt.contextDirectory}/methods,dst=/runtime/capsule-methods,readonly`));
 assert.ok(plan.args.includes(`type=bind,src=${receipt.stateDirectory},dst=/runtime`));
 assert.ok(!plan.args.some(value=>value.includes(capsuleMethodsHostDir(f.project))));
 assert.ok(!receipt.mounts.some(value=>value.includes(path.join(f.project.runtimeDir,'container-runtime'))));
 assert.equal(await fs.readFile(path.join(capsuleMethodsHostDir(f.project),'foreign.md'),'utf8'),'PRIVATE FOREIGN');
 assert.deepEqual(await f.manager.historicalContextReceipt(f.project,receipt.referenceId),receipt);
 f.manager.runtimes.clear();assert.deepEqual(await f.manager.historicalContextReceipt(f.project,receipt.referenceId),receipt);
});
test('owner, editor and disabled GEO all require the same fresh launch policy; withdrawals and epoch replacement refuse',async t=>{
 const f=await managerFixture(t);const runtime=await launch(f);
 for(const actor of ['owner','editor']) assert.equal((await f.manager.assertContextPolicyGeneration(f.project,{actor})).generation,runtime.modelGatewayTokenJti);
 f.manager.config.geoEnabled=false;assert.ok(await f.manager.launchedContextReceipt(f.project));
 f.manager.contextPolicies={forProject:async()=>({...policy,revision:2})};await assert.rejects(f.manager.assertContextPolicyGeneration(f.project),{code:'runtime_context_unverified'});
 f.manager.contextPolicies={forProject:async()=>policy};runtime.modelGatewayTokenJti='replacement';await assert.rejects(f.manager.launchedContextReceipt(f.project),{code:'runtime_context_unverified'});
});
test('failed launch never publishes a positive receipt and ordinary projects retain their existing mount',async t=>{
 const f=await managerFixture(t);f.manager.provider.launch=async()=>{throw new Error('launch refused');};await assert.rejects(f.manager.startKernel(f.project),/launch refused/);assert.equal(f.rows.size,0);
 const ordinary=buildRuntimeLaunchPlan({...launchConfig,...f.config},f.project,49152);assert.ok(ordinary.args.includes(`type=bind,src=${f.project.runtimeDir}/container-runtime,dst=/runtime`));assert.ok(!ordinary.args.some(value=>value.startsWith('OPENVIKING_PENDING_DIR=')));
 f.manager.contextPolicies={forProject:async()=>({kind:'owned',ownerId:'owner',controlProjectId:'project'})};f.manager.contextSharedProjects.clear();assert.equal(await f.manager.assertContextPolicyGeneration(f.project),null);
});
test('known shared projects fail closed without a resolver and AgentBay shared mounts are explicitly unsupported',async t=>{
 const f=await managerFixture(t);await f.manager.contextPolicyFor(f.project);f.manager.contextPolicies=null;await assert.rejects(f.manager.startKernel(f.project),{code:'runtime_context_unverified'});
 f.manager.contextPolicies={forProject:async()=>policy};f.manager.config.runtimeProvider='agentbay';await assert.rejects(f.manager.startKernel(f.project),{code:'runtime_context_provider_unsupported'});
});
test('busy work and pending prompts preserve the old runtime; idle cutover uses the existing exclusive fence and stop guard',async t=>{
 const f=await managerFixture(t),m=f.manager;const runtime={kind:'dsh',project:f.project,workspaceDir:f.project.workspaceDir};m.runtimes.set(m.key(f.project),runtime);
 let busy=true,pending=false,stops=0,scoped=0;const locks=[];
 m.idleVerdict=async()=>busy?'working':'idle';m.pluginRuntimeBusy=async()=>busy;
 m.pluginService={database:{transaction:async work=>work({query:async(sql,args)=>{locks.push(args);return {rows:[{acquired:true}]};}}),withTransactionClient:async(client,work)=>{scoped++;return work();}},scope:async()=>{},get:async()=>({desired:{revision:0,enabled:true,settings:{timeoutMs:15000}}}),hasPendingPrompts:async()=>pending};
 m.stopIdleRuntime=async(project,options)=>{assert.equal(options.evenIfConnected,true);if(!await options.guard()) return false;stops++;m.runtimes.delete(m.key(project));return true;};
 m.startAdmitted=async(project,options)=>{if(await options.replaceRuntime()) await launch(f);};
 assert.deepEqual(await m.ensureContextPolicyGeneration(f.project),{adopted:false,pending:true});assert.equal(stops,0);
 busy=false;pending=true;assert.deepEqual(await m.ensureContextPolicyGeneration(f.project),{adopted:false,pending:true});assert.equal(stops,0);
 pending=false;assert.deepEqual(await m.ensureContextPolicyGeneration(f.project),{adopted:true});assert.equal(stops,1);assert.ok(scoped);assert.ok(locks.every(args=>args[0]==='plugin-project:owner:project'));
});
test('concurrent generation construction is atomic and activation fanout re-resolves each shared project',async t=>{
 const f=await managerFixture(t);const results=await Promise.all(Array.from({length:6},()=>f.manager.prepareSharedContext(f.project,policy)));assert.equal(new Set(results.map(item=>item.digest)).size,1);
 await launch(f);let checks=0;f.manager.ensureContextPolicyGeneration=async()=>{checks++;return {adopted:false,pending:true};};
 const result=await f.manager.refreshCapsuleMethods({userId:'owner',sessionId:'already-seen'});assert.deepEqual(result,{refreshed:0,skipped:['runtime_context_pending']});assert.equal(checks,1);
});
test('provider independently rejects a tampered reference before constructing a launch plan',async t=>{
 const f=await managerFixture(t),generation=await f.manager.prepareSharedContext(f.project,policy);
 await fs.chmod(path.join(generation.directory,'manifest.json'),0o600);await fs.writeFile(path.join(generation.directory,'manifest.json'),'{}');
 const provider=new DockerRuntimeProvider(f.manager);await assert.rejects(provider.prepare(f.project,{port:49152,pluginConfig:{},capsuleMethodsMounted:0,contextGeneration:generation}),{code:'runtime_context_unverified'});
});
test('materialized shared capsules exclude foreign bytes and a source withdrawal blocks forwarding',async t=>{
 const f=await managerFixture(t);let allowed=true;
 const rows=[['allowed','project','allowed shared body'],['foreign','other-project','FOREIGN PRIVATE BODY']].map(([id,projectId,content])=>({id,revision:1,projectId,payload:{capsuleId:'capsule',projectId,content,contentDigest:'a'.repeat(64),status:'approved',origin:'explicit',factKind:'method_preference',layer:'preferences'}}));
 f.manager.capsuleService={active:async()=>({items:[{capsuleId:'capsule'}]}),get:async()=>({payload:{}}),entries:async()=>({items:rows,nextCursor:null}),inForce:async()=>true,documents:{get:async(user,kind,id)=>rows.find(row=>row.id===id)}};
 f.manager.contextItems={capsule:async(p,activation,row)=>allowed && row.id==='allowed'};
 await launch(f);const receipt=await f.manager.launchedContextReceipt(f.project);
 assert.ok(receipt.contextFiles.some(file=>file.path==='methods/allowed/SKILL.md'));assert.ok(!receipt.contextFiles.some(file=>file.path.includes('foreign')));
 assert.match(await fs.readFile(path.join(receipt.contextDirectory,'methods/allowed/SKILL.md'),'utf8'),/allowed shared body/);
 allowed=false;await assert.rejects(f.manager.assertContextPolicyGeneration(f.project),{code:'runtime_context_unverified'});
});

import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { platformSkillGenerationRoot, verifyPlatformSkillGeneration } from '../src/platformSkillSupply.mjs';
test('shared launches retain separately verified published platform skills and state their personal-byte restriction',async t=>{
 const f=await managerFixture(t),text='---\nname: Published method\ndescription: Public method\n---\nPublished platform body\n',sha=value=>createHash('sha256').update(value).digest('hex');
 const nativeName='platform-'+'a'.repeat(24),manifest={schemaVersion:1,pins:[{nativeName,digest:`sha256:${sha(text)}`,files:[{path:'SKILL.md',digest:`sha256:${sha(text)}`}]}]};
 const reference={schemaVersion:1,generationHash:sha(canonicalJson(manifest))},root=platformSkillGenerationRoot(f.manager.config,reference);
 await fs.mkdir(path.join(root,'skills',nativeName),{recursive:true});await fs.writeFile(path.join(root,'skills',nativeName,'SKILL.md'),text,{mode:0o444});await fs.writeFile(path.join(root,'manifest.json'),canonicalJson(manifest)+'\n',{mode:0o444});
 const generation=await verifyPlatformSkillGeneration(f.manager.config,reference);f.manager.platformSkillSupply={prepareForRuntime:async()=>generation};
 await launch(f);const receipt=await f.manager.launchedContextReceipt(f.project);assert.deepEqual(receipt.platformSkillReference,reference);
 assert.ok(f.plan().args.includes(`type=bind,src=${root}/skills,dst=/opt/evimed/platform-skills,readonly`));assert.equal(receipt.restrictions.personalExtensions,'excluded-until-shared-byte-authorization');
});

test('shared provider and common plans exclude a populated owner library while ordinary plans retain it',async t=>{
 const f=await managerFixture(t),library=path.join(f.config.dataDir,'users','owner','library');
 await fs.mkdir(library,{recursive:true});await fs.writeFile(path.join(library,'foreign.md'),'PRIVATE OWNER LIBRARY');
 f.project.baseDir=f.project.workspaceDir;await fs.mkdir(path.join(f.project.workspaceDir,'knowledge-base'),{recursive:true});await fs.writeFile(path.join(f.project.workspaceDir,'knowledge-base','project.md'),'PROJECT SOURCE');
 const generation=await f.manager.prepareSharedContext(f.project,policy),input={port:49152,pluginConfig:{revision:0,enabled:true,settings:{timeoutMs:15000}},capsuleMethodsMounted:0};
 const shared=await f.manager.provider.prepare(f.project,{...input,contextGeneration:generation}),ordinary=await f.manager.provider.prepare(f.project,input);
 assert.equal(shared.readOnlyViews.library,null);assert.ok(!shared.args.some(arg=>arg.includes(`src=${library},`)));
 assert.ok(shared.args.includes(`type=bind,src=${f.project.workspaceDir},dst=/workspace`));
 assert.ok(shared.args.includes(`type=bind,src=${f.project.workspaceDir}/knowledge-base,dst=/workspace/knowledge-base,readonly`));
 assert.ok(ordinary.args.includes(`type=bind,src=${library},dst=/workspace/library,readonly`));
 assert.equal(await fs.readFile(path.join(library,'foreign.md'),'utf8'),'PRIVATE OWNER LIBRARY');
 const common=buildRuntimeLaunchPlan({...launchConfig,...f.config},f.project,49152,{contextGeneration:generation});assert.equal(common.readOnlyViews.library,null);
});

test('post-readiness activation or final authority failure cannot publish a successful historical receipt',async t=>{
 for(const phase of ['activation','final-authority']) {
  const f=await managerFixture(t);let closed=false;f.manager.provider.close=async()=>{closed=true;};
  if(phase==='activation')f.manager.activateModelGatewayRuntime=()=>{throw new Error('late activation failure');};
  else { const activate=f.manager.activateModelGatewayRuntime.bind(f.manager);f.manager.activateModelGatewayRuntime=(project,runtime)=>{activate(project,runtime);f.manager.contextPolicies={forProject:async()=>({...policy,revision:2})};}; }
  await assert.rejects(f.manager.startKernel(f.project));assert.equal(closed,true);assert.equal(f.rows.size,0,`${phase} must precede positive receipt publication`);
  assert.equal(f.manager.runtimes.get(f.manager.key(f.project)),undefined);
 }
});
