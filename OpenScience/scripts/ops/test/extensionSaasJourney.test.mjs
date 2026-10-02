import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { validatePrivateCampaignInputs, validatePrivateRuntimeMounts, controlledCampaignTurn, validateFullRuntimeImagePreflight, safeCampaignDiagnosticCode, safeCampaignStackFrames, resolveCampaignProject } from '../extension-saas-acceptance-journey.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createShortCampaignRoot } from '../extension-saas-acceptance-journey.mjs';
import { assertAssessmentFixtureRoot, assertShortFixtureParentSnapshots, ASSESSMENT_SHORT_PARENT } from '../extension-saas-acceptance-manifest.mjs';
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
 const actual={Id:'a'.repeat(64),Image:expected.imageId,Config:{User:'10001:10001',Env:['DSH_TELEMETRY_DISABLED=1'],Labels:{'open-science.user':'owner','open-science.project':'project'}},State:{Running:true},HostConfig:{ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],NetworkMode:network.Name},NetworkSettings:{Networks:{[network.Name]:{NetworkID:network.Id}}},Mounts:[{Type:'bind',Source:'/owned/workspace',Destination:'/workspace',RW:true}]};
 assert.equal(validatePrivateRuntimeMounts(actual,expected).uid,10001);
 for(const changed of [{...actual,Config:{...actual.Config,User:'0:0'}},{...actual,Mounts:[{...actual.Mounts[0],Source:'/owned'}]},{...actual,Mounts:[{...actual.Mounts[0],Source:'/owned/admission/record'}]},{...actual,Config:{...actual.Config,Env:['DEEPSEEK_API_KEY=synthetic-canary']}}])assert.throws(()=>validatePrivateRuntimeMounts(changed,expected));
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
