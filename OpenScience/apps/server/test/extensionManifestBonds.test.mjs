import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson,canonicalExtensionCoordinate,extensionGenerationIdentity} from '@evimed/domain';
import {ExtensionGenerationService,verifyExtensionGeneration} from '../src/extensionGenerationService.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>'sha256:'+sha(canonicalJson(value));
function rehash(manifest){const{reference:_reference,...content}=manifest;manifest.reference={ownerHash:sha('owner'),projectHash:sha('project'),generationHash:sha(canonicalJson({...content,domainIdentity:extensionGenerationIdentity(manifest.identity,{ownerId:manifest.scope.ownerId,projectId:manifest.scope.projectId},sha)}))};return manifest;}
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'manifest-bonds-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const coordinate={kind:'github',repository:'Jesse-njx/dsh-cowork',commit:'a'.repeat(40)};
 // Synthetic receipt bytes exercise the immutable format only. No qualifier,
 // runtime or serving deployment accepts this fixture as measured compatibility.
 const plugin={extensionId:'cowork',coordinate,integrity:digest('package'),artifactDigest:digest('artifact'),adapterRevision:digest('adapter'),configRevision:1,configDigest:digest({enabled:true,settings:{},connectionRefs:[]}),enabled:true,settings:{},connectionRefs:[],executionClass:'isolated-tool',receiptDigest:digest('synthetic format control')};
 const binding={extensionId:plugin.extensionId,installationId:'installation',actorId:'owner',actorMembershipEpoch:null,installationRevision:1,prepareJobId:'prepare',coordinate:canonicalExtensionCoordinate(coordinate),integrity:plugin.integrity,artifactDigest:plugin.artifactDigest,configDigest:plugin.configDigest,receiptDigest:plugin.receiptDigest};
 const scope={ownerId:'owner',projectId:'project',actorId:'owner',actorAccountCreatedAt:'epoch',actorMembershipEpoch:null,ownerAccountCreatedAt:'epoch',projectCreatedAt:'project-epoch'};
 const identity={ownerId:'owner',projectId:'project',baseRuntimeImageDigest:digest('image'),adapterRevision:digest('base adapter'),permissionProfileRevision:digest('permission'),selections:[{extensionId:plugin.extensionId,artifactDigest:plugin.artifactDigest,configRevision:1,configDigest:plugin.configDigest,connectionRefs:[]}],skills:[]};
 const manifest=rehash({schemaVersion:1,identity,scope,bindings:{desiredRevision:1,legacyRevision:0,personalRevision:0,installations:[binding]},projection:{plugins:[plugin],personal:{reference:null,pins:[]}},findings:[]});
 const config={dataDir:root,skillArtifactsRoot:path.join(root,'skills'),maxGlobalBytes:4*1024*1024,maxOwnerBytes:4*1024*1024,minFreeBytes:1};
 const service=new ExtensionGenerationService({}, {config,extensionService:{},pluginService:{},admittedArtifacts:[],identities:async()=>identity,proofAuthority:null});
 const project={id:'project',userId:'owner'},client={query:async()=>({rows:[]})};
 return{config,service,project,client,manifest};
}
test('ordinary immutable receipt format and the existing citation projection remain readable',async t=>{
 const f=await fixture(t);const legacy={extensionId:'dsh-cite',coordinate:{kind:'npm',name:'dsh-cite',version:'0.3.2'},integrity:digest('legacy'),artifactDigest:digest('legacy'),configRevision:0,configDigest:digest({enabled:true,settings:{timeoutMs:9000}}),enabled:true,settings:{timeoutMs:9000},connectionRefs:[],compatibility:'legacy-citation-v1',sourceDocumentId:'legacy-row'};
 f.manifest.projection.plugins.push(legacy);f.manifest.identity.selections.push({extensionId:legacy.extensionId,artifactDigest:legacy.artifactDigest,configRevision:legacy.configRevision,configDigest:legacy.configDigest,connectionRefs:[]});rehash(f.manifest);
 await f.service.publish(f.project,f.manifest,f.client);assert.deepEqual(await verifyExtensionGeneration(f.config,f.project,f.manifest.reference),f.manifest);
});
test('rehashing cannot hide duplicate, dangling, mixed or inconsistent installation bonds',async t=>{
 const f=await fixture(t);
 const changes=[
  m=>m.bindings.installations.push(structuredClone(m.bindings.installations[0])),
  m=>m.bindings.installations.push({...m.bindings.installations[0],extensionId:'dangling'}),
  m=>m.projection.plugins.push(structuredClone(m.projection.plugins[0])),
  m=>{m.bindings.installations[0].configDigest=digest('wrong');},
  m=>{m.bindings.installations[0].artifactDigest=digest('wrong');},
  m=>{m.bindings.installations[0].integrity=digest('wrong');},
  m=>{m.bindings.installations[0].coordinate='github:Jesse-njx/dsh-cowork@'+'b'.repeat(40);},
  m=>{m.bindings.installations[0].receiptDigest=digest('wrong');},
  m=>{m.bindings.installations[0].assessmentAdmissionDigest=digest('private');},
  m=>{m.projection.plugins[0].assessmentAdmissionDigest=digest('private');},
  m=>{m.projection.plugins[0].compatibility='legacy-citation-v1';},
  m=>{m.scope.projectId='foreign';m.identity.projectId='foreign';},
 ];
 for(const change of changes){const value=structuredClone(f.manifest);change(value);rehash(value);await assert.rejects(f.service.publish(f.project,value,f.client));await assert.rejects(verifyExtensionGeneration(f.config,f.project,value.reference));}
});
