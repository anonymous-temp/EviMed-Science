import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson,canonicalExtensionCoordinate,extensionGenerationIdentity} from '@evimed/domain';
import {ExtensionGenerationService,verifyExtensionGeneration,extensionMountIdentity} from '../src/extensionGenerationService.mjs';
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
function withoutReceipts(manifest){delete manifest.projection.plugins[0].receiptDigest;delete manifest.bindings.installations[0].receiptDigest;return rehash(manifest);}
test('a generation that carries no qualification receipt is a valid immutable generation, and the receipt bonds still hold when one is present',async t=>{
 const f=await fixture(t);
 // New generations bind no receipt: how far a package has been measured is a label beside the generation (owner ruling 2026-10-04).
 const unlabelled=withoutReceipts(structuredClone(f.manifest));
 await f.service.publish(f.project,unlabelled,f.client);assert.deepEqual(await verifyExtensionGeneration(f.config,f.project,unlabelled.reference),unlabelled);
 // Generations written before that still verify, receipt and all.
 const legacy=structuredClone(f.manifest);await f.service.publish(f.project,legacy,f.client);assert.deepEqual(await verifyExtensionGeneration(f.config,f.project,legacy.reference),legacy);
 // But a receipt on one side only, a malformed one, or a receipt beside an assessment admission is never a bond.
 const changes=[
  m=>{delete m.bindings.installations[0].receiptDigest;},
  m=>{delete m.projection.plugins[0].receiptDigest;},
  m=>{m.projection.plugins[0].receiptDigest='not-a-digest';m.bindings.installations[0].receiptDigest='not-a-digest';},
  m=>{m.projection.plugins[0].assessmentAdmissionDigest=digest('private');m.bindings.installations[0].assessmentAdmissionDigest=digest('private');},
 ];
 for(const change of changes){const value=structuredClone(f.manifest);change(value);rehash(value);await assert.rejects(verifyExtensionGeneration(f.config,f.project,value.reference));await assert.rejects(f.service.publish(f.project,value,f.client));}
 // The same refusals hold for a generation without receipts: an admission digest nobody composed is not a bond either.
 const stray=withoutReceipts(structuredClone(f.manifest));stray.projection.plugins[0].assessmentAdmissionDigest=digest('private');rehash(stray);
 await assert.rejects(verifyExtensionGeneration(f.config,f.project,stray.reference));
});
test('what a generation mounts is its code identity: evidence moves nothing, what binds the code moves it',async t=>{
 const f=await fixture(t);const base=extensionMountIdentity(f.manifest);
 assert.match(base,/^[a-f0-9]{64}$/);
 // Labels. A release moves the source revisions; a re-measurement moves or removes the receipt.
 const evidence=[
  m=>{m.identity.adapterRevision=digest('adapter after a release');},
  m=>{m.identity.permissionProfileRevision=digest('permission after a release');},
  m=>{m.projection.plugins[0].adapterRevision=digest('proof adapter after a release');},
  m=>{m.projection.plugins[0].receiptDigest=digest('re-measured');m.bindings.installations[0].receiptDigest=digest('re-measured');},
  m=>{delete m.projection.plugins[0].receiptDigest;delete m.bindings.installations[0].receiptDigest;},
  m=>{m.reference={ownerHash:sha('other'),projectHash:sha('other'),generationHash:sha('other')};},
 ];
 for(const change of evidence){const value=structuredClone(f.manifest);change(value);assert.equal(extensionMountIdentity(value),base);}
 // What binds the code that runs, who may run it and what it is configured with.
 const code=[
  m=>{m.identity.baseRuntimeImageDigest=digest('another image');},
  m=>{m.projection.plugins[0].artifactDigest=digest('another artifact');},
  m=>{m.projection.plugins[0].integrity=digest('another package');},
  m=>{m.projection.plugins[0].configDigest=digest('another configuration');},
  m=>{m.projection.plugins[0].configRevision=2;},
  m=>{m.projection.plugins[0].enabled=false;},
  m=>{m.projection.plugins[0].settings={rows:3};},
  m=>{m.projection.plugins[0].connectionRefs=['connection'];},
  m=>{m.projection.plugins[0].coordinate={...m.projection.plugins[0].coordinate,commit:'c'.repeat(40)};},
  m=>{m.bindings.installations[0].installationRevision=2;},
  m=>{m.bindings.installations[0].prepareJobId='another-preparation';},
  m=>{m.bindings.desiredRevision=2;},
  m=>{m.scope.projectCreatedAt='another-project-epoch';},
  m=>{m.projection.personal.pins=[{skillId:'s',revision:1,digest:digest('s')}];},
  m=>{m.projection.plugins[0].assessmentAdmissionDigest=digest('assessment');},
  m=>{m.projection.plugins.push({extensionId:'another',coordinate:m.projection.plugins[0].coordinate});},
 ];
 for(const change of code){const value=structuredClone(f.manifest);change(value);assert.notEqual(extensionMountIdentity(value),base);}
});
