import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { validatePrivateCampaignInputs, validatePrivateRuntimeMounts, campaignPhysicalInspectionMetadata, controlledCampaignTurn, validateFullRuntimeImagePreflight, safeCampaignDiagnosticCode, safeCampaignStackFrames, safeCampaignFailureDetails, dispatchOrdinaryCampaignTurn, resolveCampaignProject, campaignGenerationReady, campaignGenerationStatus, observeCampaignGenerationProbe, observeCampaignPreparation, observeCampaignGenerationLifecycle, assertNativeCampaignOperator, CAMPAIGN_RUNTIME_LIMITS } from '../extension-saas-acceptance-journey.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createShortCampaignRoot } from '../extension-saas-acceptance-journey.mjs';
import { assertAssessmentFixtureRoot, assertShortFixtureParentSnapshots, ASSESSMENT_SHORT_PARENT, assessmentShortParent } from '../extension-saas-acceptance-manifest.mjs';
test('full runtime default empty USER is only image metadata; launch UID pin and separate physical proof remain mandatory',()=>{
 const image={Id:'sha256:'+'a'.repeat(64),Os:'linux',Architecture:'amd64',Config:{User:''}},expected={imageId:image.Id,platform:'linux/amd64',launchUser:'10001:10001'};
 const observed=validateFullRuntimeImagePreflight(image,expected);assert.equal(observed.defaultImageUser,'');assert.equal(observed.physicalContainerUidProof,'required-before-measurement');
 assert.equal(validateFullRuntimeImagePreflight({...image,Config:{}},expected).defaultImageUser,'');
 assert.throws(()=>validateFullRuntimeImagePreflight({...image,Config:{User:null}},expected));
 assert.throws(()=>validateFullRuntimeImagePreflight({...image,Config:{User:10001}},expected));
 assert.throws(()=>validateFullRuntimeImagePreflight(image,{...expected,launchUser:'0:0'}));
 assert.throws(()=>validateFullRuntimeImagePreflight(image,{...expected,platform:'linux/arm64'}));
 assert.throws(()=>validateFullRuntimeImagePreflight({...image,Config:{User:'root'}},expected));
});
test('diagnostics expose closed internal guard codes and typed product codes, never arbitrary stderr/provider text',()=>{
 assert.equal(safeCampaignDiagnosticCode(new Error('full_runtime_image_preflight_refused')),'full_runtime_image_preflight_refused');
 assert.equal(safeCampaignDiagnosticCode({code:'extension_access_denied',message:'unrelated private value'}),'extension_access_denied');
 assert.equal(safeCampaignDiagnosticCode(new Error('Command failed: private-provider-key=must-not-print')),'assessment_failed');
 assert.equal(safeCampaignDiagnosticCode({code:'secret value with spaces',message:'private-provider-key=must-not-print'}),'assessment_failed');
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../');
 const frames=safeCampaignStackFrames({stack:'Error: private-provider-key=must-not-print\n at run (file://'+repo+'/OpenScience/apps/server/src/extensionToolController.mjs:25:8)\n at unknown (/private/tmp/private-key.js:4:5)'});
 assert.deepEqual(frames,[{file:'OpenScience/apps/server/src/extensionToolController.mjs',line:25,column:8}]);assert.equal(JSON.stringify(frames).includes('private-provider-key'),false);
});
test('trusted project resolution hydrates store actor and never derives private roots from public HTTP user DTO',async()=>{
 const actor={user:{id:'owner'},projectId:'default'},hydrated={id:'owner',rootDir:'/owned/users/owner'};
 const app={store:{userById:async id=>{assert.equal(id,actor.user.id);return hydrated;},requireProject:async(user,id)=>{assert.equal(user,hydrated);assert.equal(id,actor.projectId);return{id,userId:user.id};}}};
 assert.deepEqual(await resolveCampaignProject(app,actor),{id:'default',userId:'owner'});
 await assert.rejects(resolveCampaignProject({store:{userById:async()=>null}},actor),/actor_unavailable/);
});
test('candidate setup fails fast on its exact desired generation terminal job and keeps typed rootcause',async()=>{
 const project={userId:'owner',id:'project'},hash='a'.repeat(64),state={payload:{phase:'waiting',desired:{reference:{generationHash:hash}}}};
 const app={hostedExtensions:{generations:{current:async()=>state}},store:{database:{query:async(_sql,args)=>{assert.deepEqual(args,[project.userId,project.id,hash]);return{rows:[{id:'owned-job',status:'failed',error:{code:'runtime_exited'}}]};}}}};
 await assert.rejects(campaignGenerationReady(app,project),error=>error.code==='runtime_exited'&&error.terminalJob.id==='owned-job');
 app.store.database.query=async()=>({rows:[{id:'owned-job',status:'queued'}]});assert.equal(await campaignGenerationReady(app,project),null);
 const controller=new AbortController();controller.abort(new DOMException('Assessment interrupted.','AbortError'));assert.throws(()=>controller.signal.throwIfAborted(),{name:'AbortError'});
});
test('short Unix transport root is exact canonical operator-owned700 with protected400 identity marker',async()=>{
 const root=await createShortCampaignRoot();
 try{
  assert.equal(path.dirname(root),ASSESSMENT_SHORT_PARENT);assert.match(path.basename(root),/^[a-f0-9]{10}$/);assert.equal(await assertAssessmentFixtureRoot(root),root);
  assert(Buffer.byteLength(path.join(root,'.runtime-sockets','a'.repeat(24),'dsh.sock'))+1<=104);
  const marker=path.join(root,'root-ownership.json');assert.equal((await fs.stat(marker)).mode&0o7777,0o400);
  await fs.chmod(marker,0o600);await assert.rejects(assertAssessmentFixtureRoot(root),/unsafe_assessment_root/);
  await fs.chmod(marker,0o400);await fs.chmod(root,0o755);await assert.rejects(assertAssessmentFixtureRoot(root),/unsafe_assessment_root/);
  await assert.rejects(assertAssessmentFixtureRoot('/private/tmp/ordinary-unowned-root'),/invalid_assessment_root/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('shortroot common reader rejects writable/replaced/wrong-owner parent snapshots without mutating the shared live preparation parent',()=>{
 const snapshot={realPath:ASSESSMENT_SHORT_PARENT,directory:true,symlink:false,uid:process.getuid(),mode:0o700,dev:1,ino:2};
 assert.doesNotThrow(()=>assertShortFixtureParentSnapshots(snapshot,{...snapshot}));
 for(const changed of [{...snapshot,mode:0o755},{...snapshot,uid:snapshot.uid+1},{...snapshot,ino:3},{...snapshot,symlink:true},{...snapshot,realPath:'/untrusted/evimed-extension-acceptance'}])assert.throws(()=>assertShortFixtureParentSnapshots(snapshot,changed),/unsafe_assessment_parent/);
});
test('private staged CLI accepts only closed setup tuple or protected measurement state reference',()=>{
 const setup={schemaVersion:1,phase:'setup',acceptanceInputsPath:'/private/tmp/owned/acceptance-inputs.json',runtimeImageId:'sha256:'+'a'.repeat(64),databaseUrl:'postgresql://fixture@127.0.0.1/evimed_test',gatewayHost:'host.lima.internal',mountMode:'volume-subpath',deadlineMs:30000};
 assert.equal(validatePrivateCampaignInputs(setup).phase,'setup');
 for(const value of [{...setup,qualified:true},{...setup,gatewayHost:'example.com'},{...setup,databaseUrl:'postgresql://fixture@127.0.0.1/evimed_test?host=example.com'},{...setup,phase:'publish'},{...setup,deepseekApiKey:'secret'}])assert.throws(()=>validatePrivateCampaignInputs(value));
 assert.equal(validatePrivateCampaignInputs({schemaVersion:1,phase:'measure',statePath:'/private/tmp/owned/campaign-state.json',deadlineMs:30000}).phase,'measure');
 assert.throws(()=>validatePrivateCampaignInputs({schemaVersion:1,phase:'measure',statePath:'/private/tmp/owned/campaign-state.json',deadlineMs:30000,physicalVerified:true}));
});
test('physical setup validation rejects root authority mounts, runtime root UID and telemetry/provider env without supplied pass flags',()=>{
 const network={Name:'owned-network',Id:'b'.repeat(64),Internal:true,Driver:'bridge',Labels:{'io.evimed.campaign-root':'sha256:'+createHash('sha256').update(canonicalJson('/owned')).digest('hex')}};
 const expected={imageId:'sha256:'+'a'.repeat(64),ownerId:'owner',projectId:'project',authorityRoot:'/owned/admission',qualificationRoot:'/owned/qualification',dataDir:'/owned',network};
 const actual={Id:'a'.repeat(64),Image:expected.imageId,Config:{User:'10001:10001',Env:['DSH_TELEMETRY_DISABLED=1'],Labels:{'open-science.user':'owner','open-science.project':'project'}},State:{Running:true},HostConfig:{ReadonlyRootfs:true,NanoCpus:1_000_000_000,Memory:1536*1024*1024,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],NetworkMode:network.Name},NetworkSettings:{Networks:{[network.Name]:{NetworkID:network.Id}}},Mounts:[{Type:'bind',Source:'/owned/workspace',Destination:'/workspace',RW:true}]};
 assert.equal(validatePrivateRuntimeMounts(actual,expected).uid,10001);
 for(const changed of [{...actual,HostConfig:{...actual.HostConfig,NanoCpus:2_000_000_000,Memory:8*1024*1024*1024}},{...actual,HostConfig:{...actual.HostConfig,Memory:0}},{...actual,Config:{...actual.Config,User:'0:0'}},{...actual,Mounts:[{...actual.Mounts[0],Source:'/owned'}]},{...actual,Mounts:[{...actual.Mounts[0],Source:'/owned/admission/record'}]},{...actual,Config:{...actual.Config,Env:['DEEPSEEK_API_KEY=synthetic-canary']}}])assert.throws(()=>validatePrivateRuntimeMounts(changed,expected));
});
test('controlled transport emits registered real tool requests by explicit stage and cannot invent a missing native tool',()=>{
 const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',key=id+':read-write',plans=new Map([[key,[{name:'doc_read',input:{resourceId:'public-fixture'}}]]]),counts=new Map();
 const body={messages:[{role:'user',content:'EVIMED_ASSESSMENT_STAGE:'+key}],tools:[{name:'doc_read'}]};
 const first=controlledCampaignTurn(body,plans,counts);assert.equal(first.name,'doc_read');assert.equal(first.input.resourceId,'public-fixture');
 assert.equal(controlledCampaignTurn(body,plans,counts).name,undefined);
 assert.throws(()=>controlledCampaignTurn({...body,tools:[{name:'read'}]},plans,new Map()),/not_registered/);
 const ancillaryCounts=new Map();assert.equal(controlledCampaignTurn({...body,tools:[]},plans,ancillaryCounts).ancillary,true);assert.equal(ancillaryCounts.size,0);
 assert.throws(()=>controlledCampaignTurn({...body,messages:[{role:'user',content:'EVIMED_ASSESSMENT_STAGE:'+id+':unknown'}]},plans,new Map()),/unexpected/);
});

test('native fixtures require production-shaped mount ownership and explicit closed-controller limits',()=>{
 assert.doesNotThrow(()=>assertNativeCampaignOperator('linux',10001));
 for(const [platform,uid] of [['linux',1000],['linux',0],['darwin',10001]])assert.throws(()=>assertNativeCampaignOperator(platform,uid),/operator_uid/);
 assert.deepEqual(CAMPAIGN_RUNTIME_LIMITS,{runtimeCpuLimit:'1',runtimeMemoryLimit:'1536m'});assert.equal(Object.isFrozen(CAMPAIGN_RUNTIME_LIMITS),true);
});

test('native UID10001 has a distinct short root and never widens earlier UID1000 evidence',()=>{
 const parent=assessmentShortParent('linux',10001);assert.notEqual(parent,assessmentShortParent('linux',1000));
 assert.equal(parent,'/tmp/evimed-extension-acceptance-10001');
 assert.ok(Buffer.byteLength(parent+'/0123456789/.runtime-sockets/'+ 'a'.repeat(24)+'/dsh.sock')+1<=104);
 assert.equal(assessmentShortParent('darwin',10001),'/private/tmp/evimed-extension-acceptance');
});

test('succeeded apply job with rollback/failed outcome terminates desired campaign without waiting for deadline',async()=>{
 const project={userId:'owner',id:'project'},hash='a'.repeat(64),state={revision:7,payload:{phase:'rolled-back',desired:{reference:{generationHash:hash},projection:{plugins:[{assessmentAdmissionDigest:'private'}]}}}},job={id:'exact-owned-job',status:'succeeded',attempts:1,result:{phase:'rolled-back',error:'plugin_apply_failed',privatePayload:'must-not-leak'}};
 const app={hostedExtensions:{generations:{current:async()=>state}},store:{database:{query:async(_sql,args)=>{assert.deepEqual(args,['owner','project',hash]);return{rows:[job]};}}}};
 await assert.rejects(campaignGenerationReady(app,project),error=>error.code==='plugin_apply_failed'&&error.generationStatus.phase==='rolled-back'&&error.terminalJob.resultPhase==='rolled-back'&&!JSON.stringify(error.generationStatus).includes('must-not-leak'));
 job.result.phase='failed';state.payload.phase='failed';await assert.rejects(campaignGenerationReady(app,project),error=>error.generationStatus.job.status==='succeeded'&&error.generationStatus.job.resultPhase==='failed');
 job.result={superseded:true};assert.equal(await campaignGenerationReady(app,project),null);
});

test('pre-cleanup generation snapshot is bounded to exact owned hash and excludes credentials/payload/lease/error messages',async()=>{
 const project={userId:'owner',id:'project'},hash='b'.repeat(64),state={revision:8,payload:{phase:'waiting',desired:{reference:{generationHash:hash},projection:{plugins:[]}},effective:null,privateToken:'must-not-leak'}};
 const app={hostedExtensions:{generations:{current:async()=>state}},store:{database:{query:async(sql,args)=>{assert.ok(sql.includes("payload->>'variant'='extension-generation-v1'"));assert.ok(sql.includes('LIMIT 1'));assert.deepEqual(args,['owner','project',hash]);return{rows:[{id:'owned',status:'running',attempts:2,error:{code:'plugin_apply_failed',message:'must-not-leak'},payload:{token:'must-not-leak'},lease_token:'must-not-leak',result:{privateValue:'must-not-leak'}}]};}}}};
 const snapshot=await campaignGenerationStatus(app,project);assert.equal(snapshot.phase,'waiting');assert.equal(snapshot.desiredHash,hash);assert.equal(snapshot.job.status,'running');assert.equal(snapshot.job.attempts,2);assert.equal(JSON.stringify(snapshot).includes('must-not-leak'),false);
});

test('private probe observer preserves strict successful proof and original failure without leaking native message values',async()=>{
 const originalError=Object.assign(new Error('extension_probe_registrations_invalid private-token-must-not-leak'),{code:'plugin_apply_failed'}),candidate={reference:{generationHash:'c'.repeat(64)}},records=[],proof={actualProof:true},manager={marker:'real',async probeGeneration(project,input,extra){assert.equal(extra,'retained-extra');assert.equal(this.marker,'real');assert.equal(input,candidate);if(project.fail)throw originalError;return proof;}};
 const original=manager.probeGeneration,restore=observeCampaignGenerationProbe(manager,async record=>records.push(record));assert.equal(await manager.probeGeneration({},candidate,'retained-extra'),proof);assert.equal(records.length,0);
 await assert.rejects(manager.probeGeneration({fail:true},candidate,'retained-extra'),error=>error===originalError);assert.equal(records[0].nativeCode,'extension_probe_registrations_invalid');assert.equal(JSON.stringify(records).includes('private-token-must-not-leak'),false);restore();assert.equal(manager.probeGeneration,original);
});

test('preparation diagnostics distinguish controller timeout vs cancel and preserve exact result/error/this/arguments',async()=>{
 const result={joined:true,artifactDigest:'exact'},records=[],failure=Object.assign(new Error('private-payload-must-not-leak'),{code:'product_state_unavailable',canceled:false}),body={identity:'private-payload-must-not-leak'},options={signal:'exact-signal'};let time=100;
 const controller={marker:'actual',admissionAvailable(){return this.marker;},cancelPreparation(value){return value;},async prepare(input,settings,extra){assert.equal(this.marker,'actual');assert.equal(input,body);assert.equal(settings,options);assert.equal(extra,'extra');time+=15003;if(this.fail)throw failure;return result;}};
 const observed=observeCampaignPreparation(controller,async evidence=>records.push(evidence),()=>time);assert.equal(await observed.prepare(body,options,'extra'),result);assert.equal(records[0].elapsedMs,15003);assert.equal(records[0].joined,true);assert.equal(observed.admissionAvailable(),'actual');
 controller.fail=true;await assert.rejects(observed.prepare(body,options,'extra'),error=>error===failure);assert.equal(records[1].canceled,false);assert.equal(records[1].elapsedMs,15003);failure.canceled=true;await assert.rejects(observed.prepare(body,options,'extra'),error=>error===failure);assert.equal(records[2].canceled,true);assert.equal(JSON.stringify(records).includes('private-payload-must-not-leak'),false);
 const failedSink=observeCampaignPreparation(controller,async()=>{throw new Error('sink-failed');});await assert.rejects(failedSink.prepare(body,options,'extra'),error=>error===failure);
});

test('full lifecycle observer preserves every stage receiver/all arguments/value/error and never changes proof verdict',async()=>{
 const candidate={reference:{generationHash:'d'.repeat(64)},projection:{plugins:[{extensionId:'cowork-portable',artifactDigest:'artifact',configRevision:1,configDigest:'config',enabled:true}],personal:{reference:null,pins:[]}},identity:{baseRuntimeImageDigest:'image',adapterRevision:'adapter',permissionProfileRevision:'permission'}},project={id:'owned'},records=[],failure=Object.assign(new Error('extension_probe_config_invalid private-secret-must-not-leak'),{code:'plugin_apply_failed'}),proof={reference:candidate.reference,runtimeGeneration:'epoch',inventory:candidate.projection.plugins,personal:candidate.projection.personal,...candidate.identity},prepared={joined:true,manifestDigest:'sha256:'+createHash('sha256').update(canonicalJson(candidate)).digest('hex')};
 let clock=1;const manager={marker:'actual',runtimeGeneration(input){assert.equal(input,project);return'epoch';}};
 for(const name of ['prepareGeneration','replaceGeneration','probeGeneration','restoreGeneration'])manager[name]=async function(input,value,extra){assert.equal(this,manager);assert.equal(input,project);assert.equal(value,candidate);assert.equal(extra,'all-args');clock+=5;if(this.failStage===name)throw failure;return name==='probeGeneration'?proof:prepared;};
 const originals=new Map(Object.entries(manager)),restore=observeCampaignGenerationLifecycle(manager,async value=>records.push(value),()=>clock);
 for(const stage of ['prepareGeneration','replaceGeneration','probeGeneration','restoreGeneration'])assert.equal(await manager[stage](project,candidate,'all-args'),stage==='probeGeneration'?proof:prepared);
 assert.equal(records.length,8);const native=records.find(row=>row.stage==='probeGeneration'&&row.outcome==='succeeded');assert.ok(Object.values(native.proofMatches).every(Boolean));assert.deepEqual(native.inventoryCounts,{actual:1,expected:1});assert.equal(native.elapsedMs,5);assert.equal(records[1].manifestDigestMatch,true);
 proof.inventory=[];proof.adapterRevision='changed';await manager.probeGeneration(project,candidate,'all-args');const mismatch=records.at(-1);assert.equal(mismatch.proofMatches.inventory,false);assert.equal(mismatch.proofMatches.adapterRevision,false);assert.equal(mismatch.proofMatches.reference,true);
 for(const stage of ['prepareGeneration','replaceGeneration','probeGeneration','restoreGeneration']){manager.failStage=stage;await assert.rejects(manager[stage](project,candidate,'all-args'),error=>error===failure);assert.equal(records.at(-1).outcome,'failed');assert.equal(records.at(-1).nativeCode,'extension_probe_config_invalid');}
 assert.equal(JSON.stringify(records).includes('private-secret-must-not-leak'),false);restore();for(const stage of ['prepareGeneration','replaceGeneration','probeGeneration','restoreGeneration'])assert.equal(manager[stage],originals.get(stage));
});
test('lifecycle diagnostics stop at32 records while all real operations continue and sink errors do not alter errors',async()=>{
 const error=Object.assign(new Error('actual'),{code:'plugin_apply_failed'}),manager={runtimeGeneration:()=>null};let calls=0;
 for(const name of ['prepareGeneration','replaceGeneration','probeGeneration','restoreGeneration'])manager[name]=async()=>{calls++;if(manager.fail)throw error;return{joined:true};};
 const records=[];observeCampaignGenerationLifecycle(manager,async value=>records.push(value));for(let i=0;i<25;i++)await manager.prepareGeneration({},null);assert.equal(calls,25);assert.equal(records.length,32);
 const second={...manager};for(const name of ['prepareGeneration','replaceGeneration','probeGeneration','restoreGeneration'])second[name]=async()=>{throw error;};observeCampaignGenerationLifecycle(second,async()=>{throw new Error('sink-failed');});await assert.rejects(second.replaceGeneration({},null),actual=>actual===error);
});

test('actual Docker omitted ReadOnly false is normalized narrowly while volume ownership/subpaths and explicit invalid flags still refuse',()=>{
 const root='/owned',rootDigest='sha256:'+createHash('sha256').update(canonicalJson(root)).digest('hex'),network={Name:'owned',Id:'b'.repeat(64),Internal:true,Driver:'bridge',Labels:{'io.evimed.campaign-root':rootDigest}},volume={Name:'owned-volume',Driver:'local',Options:{type:'none',o:'bind',device:root},Labels:{'io.evimed.campaign-root':rootDigest}},expected={imageId:'sha256:'+'a'.repeat(64),ownerId:'owner',projectId:'project',authorityRoot:'/owned/admission',qualificationRoot:'/owned/qualification',dataDir:root,dataVolume:volume.Name,volume,network};
 const planned={Type:'volume',Source:volume.Name,Target:'/workspace',VolumeOptions:{Subpath:'users/owner/projects/project/workspace'}},actual={Id:'a'.repeat(64),Image:expected.imageId,Config:{User:'10001:10001',Env:['PRIVATE_TOKEN=must-not-leak'],Labels:{'open-science.user':'owner','open-science.project':'project',private:'must-not-leak'}},State:{Running:true},HostConfig:{ReadonlyRootfs:true,NanoCpus:1_000_000_000,Memory:1536*1024*1024,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],NetworkMode:network.Name,Mounts:[planned]},NetworkSettings:{Networks:{[network.Name]:{NetworkID:network.Id,IPAMConfig:{private:'must-not-leak'}}}},Mounts:[{Type:'volume',Source:'/var/lib/docker/volumes/owned-volume/_data',Name:volume.Name,Destination:'/workspace',RW:true}]};
 assert.equal(validatePrivateRuntimeMounts(actual,expected).uid,10001);assert.equal(Object.hasOwn(planned,'ReadOnly'),false);
 for(const flag of [null,'false',0,true])assert.throws(()=>validatePrivateRuntimeMounts({...actual,HostConfig:{...actual.HostConfig,Mounts:[{...planned,ReadOnly:flag}]}},expected),/volume_identity/);
 assert.equal(validatePrivateRuntimeMounts({...actual,HostConfig:{...actual.HostConfig,Mounts:[{...planned,ReadOnly:false}]}},expected).uid,10001);
 for(const subpath of ['','../workspace','admission','qualification','.openscience/../workspace'])assert.throws(()=>validatePrivateRuntimeMounts({...actual,HostConfig:{...actual.HostConfig,Mounts:[{...planned,VolumeOptions:{Subpath:subpath}}]}},expected));
 for(const changed of [{...volume,Driver:'other'},{...volume,Options:{...volume.Options,device:'/other'}},{...volume,Labels:{}}])assert.throws(()=>validatePrivateRuntimeMounts(actual,{...expected,volume:changed}),/volume_identity/);
 assert.throws(()=>validatePrivateRuntimeMounts({...actual,Mounts:[{...actual.Mounts[0],RW:null}]},expected),/volume_identity/);
 const metadata=campaignPhysicalInspectionMetadata(actual,volume,network);assert.equal(JSON.stringify(metadata).includes('must-not-leak'),false);assert.equal(Object.hasOwn(metadata.container.HostConfig.Mounts[0],'ReadOnly'),false);assert.equal(metadata.volume.Options.device,root);
});

test('shared private-phase exception diagnostic identifies reference errors and only bounded numeric protocol facts',()=>{
 const secret='private-provider-must-not-leak',error=Object.assign(new ReferenceError(secret),{status:403,expected:200,actual:secret,stderr:secret,payload:{secret}}),diagnostic=safeCampaignFailureDetails(error);
 assert.equal(diagnostic.errorName,'ReferenceError');assert.deepEqual(diagnostic.protocolNumbers,{status:403,expected:200});assert.equal(JSON.stringify(diagnostic).includes(secret),false);
 assert.equal(safeCampaignFailureDetails({name:secret,message:secret,code:secret}).errorName,'UnknownError');
 assert.equal(Object.hasOwn(safeCampaignFailureDetails({status:-1,statusCode:99999,expected:'200'}),'protocolNumbers'),false);
});

test('ordinary driver creates native session then binds open-domain before dispatch; rejected binding never dispatches',async()=>{
 const actor={headers:{Cookie:'fixture-only'}},calls=[],input={dispatchId:'owned-dispatch',text:'controlled fixture'},request=async(base,current,route,method,body,expected)=>{assert.equal(base,'http://127.0.0.1:1');assert.equal(current,actor);calls.push({route,method,body,expected});if(route==='/api/runtime/sessions')return{id:'native-owned'};if(route.startsWith('/api/research-sessions/'))return{sessionId:'native-owned',mode:'open-domain'};return{id:'owned-run'};};
 const result=await dispatchOrdinaryCampaignTurn('http://127.0.0.1:1',actor,input,null,request);assert.equal(result.run.id,'owned-run');assert.deepEqual(calls.map(call=>call.route),['/api/runtime/sessions','/api/research-sessions/native-owned','/api/agent-runs/dispatch']);assert.deepEqual(calls[1].body,{mode:'open-domain'});assert.equal(calls[2].body.line,'answer');assert.equal(calls[2].body.automated,true);
 const failure=Object.assign(new Error('owned binding denied'),{code:'extension_access_denied'}),blocked=[];await assert.rejects(dispatchOrdinaryCampaignTurn('http://127.0.0.1:1',actor,input,null,async(_base,_actor,route)=>{blocked.push(route);if(route==='/api/runtime/sessions')return{id:'native-owned'};throw failure;}),error=>error===failure);assert.deepEqual(blocked,['/api/runtime/sessions','/api/research-sessions/native-owned']);
 const wrongBinding=[];await assert.rejects(dispatchOrdinaryCampaignTurn('http://127.0.0.1:1',actor,input,null,async(_base,_actor,route)=>{wrongBinding.push(route);return route==='/api/runtime/sessions'?{id:'native-owned'}:{sessionId:'foreign-session',mode:'open-domain'};}),/session_binding/);assert.equal(wrongBinding.length,2);
 const mockCalls=[];await assert.rejects(dispatchOrdinaryCampaignTurn('http://127.0.0.1:1',actor,input,null,async(_base,_actor,route)=>{mockCalls.push(route);return{id:'web_mock_fixture'};}),/real_generation/);assert.equal(mockCalls.length,1);
});

import {createWebApiApp} from '../../../apps/server/src/server.mjs';
import os from 'node:os';
test('ordinary owned HTTP binding enables answer dispatch while another account cannot inherit the binding',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'campaign-session-contract-')),app=createWebApiApp({dataDir:root,port:0,runtimeMode:'mock',stateStore:'file',databaseUrl:'',localAutoConfig:false,devAuth:false,authMode:'local',selfRegistrationEnabled:true,operatorUsers:'test-bootstrap-only',bootstrapUser:'test-bootstrap-only',bootstrapPassword:'synthetic-contract-test-only',deepseekProviderEnabled:false,deepseekApiKey:'',dashscopeApiKey:'',learningEnabled:false,reviewEnabled:false,llmRoutingEnabled:false});
 try{const address=await app.listen(0,'127.0.0.1'),base='http://127.0.0.1:'+address.port,actors=[];
  for(const username of ['fixture-owner','fixture-other']){const response=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'synthetic-contract-password',name:username,warm:false})}),data=(await response.json()).data;assert.equal(response.status,201);actors.push({headers:{Cookie:response.headers.get('set-cookie').split(';')[0],'X-Open-Science-CSRF':data.csrfToken,'X-Open-Science-Project':'default'}});const me=await fetch(base+'/api/me',{headers:actors.at(-1).headers});assert.equal((await me.json()).data.operator,false);}
  // Transport stub names a session only; public auth, binding and ledger routes
  // are real. This contract test makes no native/model/qualification claim.
  app.runtimeManager.createRuntimeSession=async()=>({id:'native-contract-session'});
  const raw=await fetch(base+'/api/agent-runs/dispatch',{method:'POST',headers:{...actors[0].headers,'content-type':'application/json'},body:JSON.stringify({sessionId:'native-contract-session',dispatchId:'before-binding',text:'fixture',line:'answer',automated:true})});assert.equal(raw.status,400);assert.equal((await raw.json()).code,'invalid_agent_run');
  const result=await dispatchOrdinaryCampaignTurn(base,actors[0],{dispatchId:'after-binding',text:'fixture'});assert.ok(result.run.id);
  const otherList=await fetch(base+'/api/research-sessions',{headers:actors[1].headers});assert.deepEqual((await otherList.json()).data,[]);
  const otherDispatch=await fetch(base+'/api/agent-runs/dispatch',{method:'POST',headers:{...actors[1].headers,'content-type':'application/json'},body:JSON.stringify({sessionId:result.session.id,dispatchId:'foreign-binding',text:'fixture',line:'answer',automated:true})});assert.equal(otherDispatch.status,400);assert.equal((await otherDispatch.json()).code,'invalid_agent_run');
 }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});
