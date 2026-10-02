import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { canonicalJson, canonicalExtensionCoordinate, extensionGenerationIdentity, extensionProofAdapterRevision } from '@evimed/domain';
import { createExtensionAssessmentAuthority, assertExtensionAssessmentAuthority, EXTENSION_ASSESSMENT_DOMAIN } from '../src/extensionAssessmentAuthority.mjs';
import { ExtensionGenerationService, verifyExtensionGeneration, extensionGenerationRoot } from '../src/extensionGenerationService.mjs';
const D='sha256:'+'a'.repeat(64);
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'assessment-authority-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const recordPath=path.join(root,'admission.json'),keys=generateKeyPairSync('ed25519'),now=Date.parse('2026-10-03T12:00:00Z');
  const entry={id:'fixture',coordinate:{kind:'npm',name:'fixture',version:'1.0.0'},executionClass:'isolated-tool',integrity:D},artifact={artifactDigest:D,adapterRevision:D};
  const composed=extensionProofAdapterRevision(D,D,value=>createHash('sha256').update(value).digest('hex'));
  const identity={sourceCommit:null,adapterRevision:composed,runtimeImageDigest:D,dshVersion:'0.1.7-rc.2',permissionProfileRevision:D,suiteRevision:D};
  const scope={ownerId:'owner',actorId:'owner',ownerAccountCreatedAt:'owner-epoch',actorAccountCreatedAt:'owner-epoch',actorMembershipEpoch:null,projectId:'project',projectCreatedAt:'project-epoch'};
  const facts={catalogueId:entry.id,coordinate:canonicalExtensionCoordinate(entry.coordinate),sourceCommit:null,packageIntegrity:D,artifactDigest:D,containedImageDigest:D,adapterDigest:D,adapterRevision:composed,runtimeImageDigest:D,dshVersion:identity.dshVersion,permissionProfileRevision:D,suiteRevision:D,sourcePolicyDigest:D,descriptorDigest:D,fixtureRootDigest:D,databaseNamespace:'fixture-db',installerMembershipEpoch:null,...scope};
  const record={...facts,assessmentId:'fixture-measurement',issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+1000).toISOString(),allowedOperations:['doc_read','doc_write']};
  const write=async value=>{const payload={schemaVersion:1,admissions:[value]},domain=EXTENSION_ASSESSMENT_DOMAIN;const signature=sign(null,Buffer.from(canonicalJson({domain,payload})),keys.privateKey).toString('base64');await fs.chmod(recordPath,0o600).catch(()=>{});await fs.writeFile(recordPath,canonicalJson({domain,payload,signature})+'\n',{mode:0o400});await fs.chmod(recordPath,0o400);};await write(record);
  let current={...facts};const options={root,recordPath,publicKey:keys.publicKey.export({type:'spki',format:'pem'}),currentFacts:async()=>({...current,entry,artifact,identity}),now:()=>now};
  return{authority:createExtensionAssessmentAuthority(options),options,write,record,facts,change:value=>{current=value;},context:{entry,artifact,identity,scope,operation:'doc_read'},recordPath};
}
test('opaque constructor-only admission measures exact protected tuple, never returns a qualification receipt',async t=>{
 const f=await fixture(t),bond=await f.authority.admit(f.context);assert.match(bond.assessmentAdmissionDigest,/^sha256:[a-f0-9]{64}$/);assert.equal(bond.receiptDigest,undefined);assert.ok(Object.isFrozen(f.authority));assert.ok(Object.isFrozen(bond));assert.throws(()=>assertExtensionAssessmentAuthority({...f.authority}));assert.throws(()=>assertExtensionAssessmentAuthority(JSON.parse(JSON.stringify(f.authority))));
 assert.throws(()=>new ExtensionGenerationService(null,{config:{},extensionService:null,pluginService:null,admittedArtifacts:[],identities:null,proofAuthority:null,assessmentAuthority:{admit:()=>bond}}));
});
test('every protected tuple and epoch drift refuses current admission',async t=>{
 const f=await fixture(t);for(const field of Object.keys(f.facts)){f.change({...f.facts,[field]:'drifted'});await assert.rejects(f.authority.admit(f.context),{code:'extension_access_denied'},field);}f.change(f.facts);await f.authority.admit(f.context);
});
test('owner null membership is explicit and never aliases absent facts, smuggled epochs or unknown signed fields',async t=>{
 const f=await fixture(t);
 for(const field of ['actorMembershipEpoch','installerMembershipEpoch']){
  const absent={...f.facts};delete absent[field];f.change(absent);await assert.rejects(f.authority.admit(f.context),{code:'extension_access_denied'});
  f.change(f.facts);const unsignedField={...f.record};delete unsignedField[field];await f.write(unsignedField);await assert.rejects(f.authority.admit(f.context),{code:'extension_access_denied'});
 }
 await f.write({...f.record,actorMembershipEpoch:'smuggled-membership'});await assert.rejects(f.authority.admit(f.context),{code:'extension_access_denied'});
 await f.write({...f.record,unknownMembershipAuthority:true});await assert.rejects(f.authority.admit(f.context),{code:'extension_access_denied'});
 await f.write(f.record);const absentScope={...f.context.scope};delete absentScope.actorMembershipEpoch;
 await assert.rejects(f.authority.admit({...f.context,scope:absentScope}),{code:'extension_access_denied'});
});
test('private collaborating actor and installer epochs are independently signed and revoke/regrant invalidates both',async t=>{
 const f=await fixture(t),epoch=JSON.stringify({studyId:'study',members:[{role:'lead',createdAt:'2026-10-03 12:00:00+00'}]}),scope={...f.context.scope,actorId:'collaborator',actorAccountCreatedAt:'collaborator-epoch',actorMembershipEpoch:epoch};
 const facts={...f.facts,...scope,installerMembershipEpoch:epoch};f.facts=facts;f.change(facts);f.context.scope=scope;
 await f.write({...f.record,...facts});await f.authority.admit(f.context);
 const m=await immutableManifest(f);assert.deepEqual(await verifyExtensionGeneration(m.config,m.project,m.manifest.reference,{assessmentAuthority:f.authority}),m.manifest);
 for(const field of ['actorMembershipEpoch','installerMembershipEpoch']){
  f.change({...facts,[field]:null});await assert.rejects(f.authority.admit(f.context),{code:'extension_access_denied'});
  f.change({...facts,[field]:JSON.stringify({studyId:'study',members:[{role:'lead',createdAt:'2026-10-03 12:01:00+00'}]})});await assert.rejects(f.authority.admit(f.context),{code:'extension_access_denied'});
 }
 f.change(facts);await assert.rejects(async()=>{const changed=await immutableManifest(f,{},manifest=>{manifest.bindings.installations[0].actorMembershipEpoch=null;});return verifyExtensionGeneration(changed.config,changed.project,changed.manifest.reference,{assessmentAuthority:f.authority});},{code:'extension_access_denied'});
 await assert.rejects(async()=>{const mixed=await immutableManifest(f,{},manifest=>{manifest.scope.actorId='owner';manifest.scope.actorAccountCreatedAt='owner-epoch';manifest.scope.actorMembershipEpoch=null;});return verifyExtensionGeneration(mixed.config,mixed.project,mixed.manifest.reference,{assessmentAuthority:f.authority});},{code:'extension_access_denied'});
});
test('expired, future-issued, revoked, disallowed and writable admissions refuse',async t=>{
 const f=await fixture(t);await assert.rejects(f.authority.admit({...f.context,operation:'network_fetch'}));
 for(const patch of [{expiresAt:'2020-01-01T00:00:00Z'},{issuedAt:'2030-01-01T00:00:00Z'},{allowedOperations:['network_fetch']},{allowedOperations:['doc_read','doc_read']}]){await f.write({...f.record,...patch});await assert.rejects(f.authority.admit(f.context));}
 await f.write(f.record);await fs.chmod(f.recordPath,0o600);await assert.rejects(f.authority.admit(f.context));await fs.unlink(f.recordPath);await assert.rejects(f.authority.admit(f.context));
});
test('independently pinned controller key and protected record bytes cannot be replaced by web authority',async t=>{
 const f=await fixture(t),foreign=generateKeyPairSync('ed25519');const independent=createExtensionAssessmentAuthority({...f.options,publicKey:foreign.publicKey.export({type:'spki',format:'pem'})});await assert.rejects(independent.admit(f.context));
 await fs.chmod(f.recordPath,0o600);const envelope=JSON.parse(await fs.readFile(f.recordPath,'utf8'));envelope.payload.admissions[0].allowedOperations=['doc_read'];await fs.writeFile(f.recordPath,canonicalJson(envelope)+'\n');await fs.chmod(f.recordPath,0o400);await assert.rejects(f.authority.admit(f.context));
});

async function immutableManifest(f, patch={}, mutate=()=>{}) {
 const hash=value=>createHash('sha256').update(value).digest('hex');
 const bond=await f.authority.admit(f.context),configDigest='sha256:'+hash(canonicalJson({enabled:true,settings:{},connectionRefs:[]}));
 const plugin={extensionId:'fixture',coordinate:f.context.entry.coordinate,integrity:D,artifactDigest:D,adapterRevision:f.context.identity.adapterRevision,configRevision:1,configDigest,enabled:true,settings:{},connectionRefs:[],executionClass:'isolated-tool',...bond,...patch};
 const identity={ownerId:'owner',projectId:'project',baseRuntimeImageDigest:D,adapterRevision:D,permissionProfileRevision:D,selections:[{extensionId:'fixture',artifactDigest:D,configRevision:1,configDigest,connectionRefs:[]}],skills:[]};
 const binding={extensionId:'fixture',installationId:'installation',installationRevision:1,actorId:f.context.scope.actorId,actorMembershipEpoch:f.facts.installerMembershipEpoch,prepareJobId:'prepared',coordinate:canonicalExtensionCoordinate(f.context.entry.coordinate),artifactDigest:D,integrity:D,configDigest,...bond,...(patch.receiptDigest?{receiptDigest:patch.receiptDigest}:{})};
 const manifest={schemaVersion:1,identity,scope:f.context.scope,bindings:{desiredRevision:1,legacyRevision:0,personalRevision:0,installations:[binding]},projection:{plugins:[plugin],personal:{pins:[],reference:null}},findings:[]};
 mutate(manifest);
 const generationHash=hash(canonicalJson({...manifest,domainIdentity:extensionGenerationIdentity(identity,{ownerId:'owner',projectId:'project'},hash)}));
 manifest.reference={ownerHash:hash('owner'),projectHash:hash('project'),generationHash};
 const config={dataDir:path.dirname(f.recordPath)},root=extensionGenerationRoot(config,manifest.reference);
 await fs.mkdir(path.join(root,'selected'),{recursive:true,mode:0o700});
 for(const directory of [path.dirname(path.dirname(root)),path.dirname(root),root])await fs.chmod(directory,0o700);
 await fs.chmod(path.join(root,'selected'),0o755);
 await fs.writeFile(path.join(root,'manifest.json'),canonicalJson(manifest)+'\n',{mode:0o400});
 await fs.writeFile(path.join(root,'selected','projection.json'),canonicalJson(manifest.projection)+'\n',{mode:0o444});
 return {manifest,config,project:{id:'project',userId:'owner'},root};
}
test('public immutable verifier refuses assessment, private exact reader permits and XOR refuses both bonds',async t=>{
 const f=await fixture(t),m=await immutableManifest(f);
 await assert.rejects(verifyExtensionGeneration(m.config,m.project,m.manifest.reference));
 assert.deepEqual(await verifyExtensionGeneration(m.config,m.project,m.manifest.reference,{assessmentAuthority:f.authority}),m.manifest);
 const service=new ExtensionGenerationService(null,{config:{...m.config,maxGlobalBytes:1,maxOwnerBytes:1,minFreeBytes:1},extensionService:null,pluginService:null,admittedArtifacts:[],identities:null,proofAuthority:null,assessmentAuthority:f.authority});
 assert.deepEqual(await service.verifyManifest(m.project,m.manifest.reference),m.manifest);
 const ordinary=new ExtensionGenerationService(null,{config:{...m.config,maxGlobalBytes:1,maxOwnerBytes:1,minFreeBytes:1},extensionService:null,pluginService:null,admittedArtifacts:[],identities:null,proofAuthority:null});
 await assert.rejects(ordinary.verifyManifest(m.project,m.manifest.reference));
 const both=await immutableManifest(f,{receiptDigest:D});await assert.rejects(verifyExtensionGeneration(both.config,both.project,both.manifest.reference,{assessmentAuthority:f.authority}));
 await fs.chmod(path.join(m.root,'manifest.json'),0o600);await fs.writeFile(path.join(m.root,'manifest.json'),'{}\n');await fs.chmod(path.join(m.root,'manifest.json'),0o400);
 await assert.rejects(verifyExtensionGeneration(m.config,m.project,m.manifest.reference,{assessmentAuthority:f.authority}));
});
test('real generation worker uses constructor-bound candidate verification before normal prepare and proof',async t=>{
 const {ExtensionGenerationWorker}=await import('../src/extensionGenerationWorker.mjs');
 const f=await fixture(t),m=await immutableManifest(f),client={query:async()=>({rows:[{acquired:true}]})};
 const database={transaction:work=>work(client),withTransactionClient:(_client,work)=>work()};
 const service=new ExtensionGenerationService(database,{config:{...m.config,maxGlobalBytes:1,maxOwnerBytes:1,minFreeBytes:1},extensionService:null,pluginService:{hasPendingPrompts:async()=>false},admittedArtifacts:[],identities:null,proofAuthority:null,assessmentAuthority:f.authority});
 const state={revision:1,payload:{desired:m.manifest,lastGood:null}},job={id:'job',userId:'owner',projectId:'project',leaseToken:'lease',kind:'plugin-apply',payload:{variant:'extension-generation-v1',reference:m.manifest.reference,stateRevision:1}};
 service.current=async()=>state;service.assertCurrent=async()=>m.project;service.markEffective=async()=>{};
 service.jobs={renew:async()=>true,finishWithLease:async(_u,_i,_l,result,work)=>{await work(client);return result;},fail:async()=>{throw new Error('Worker incorrectly refused the private candidate');}};
 let prepared=false;
 const runtime={pluginRuntimeBusy:async()=>false,currentGeneration:async()=>null,runtimeGeneration:()=> 'runtime',prepareGeneration:async()=>{prepared=true;return{joined:true,manifestDigest:'sha256:'+createHash('sha256').update(canonicalJson(m.manifest)).digest('hex')};},replaceGeneration:async()=>({joined:true}),probeGeneration:async()=>({reference:m.manifest.reference,runtimeGeneration:'runtime',...Object.fromEntries(['baseRuntimeImageDigest','adapterRevision','permissionProfileRevision'].map(key=>[key,m.manifest.identity[key]])),inventory:m.manifest.projection.plugins.map(plugin=>({extensionId:plugin.extensionId,artifactDigest:plugin.artifactDigest,configRevision:plugin.configRevision,configDigest:plugin.configDigest,enabled:plugin.enabled})),personal:m.manifest.projection.personal})};
 const worker=new ExtensionGenerationWorker({service,runtime,resolveProject:async()=>m.project,ledgerBusy:async()=>false});
 assert.equal((await worker.runClaimed(job)).phase,'effective');assert.equal(prepared,true);
});

test('canonical assessment manifests refuse every actual plugin and generation tuple drift',async t=>{
 const f=await fixture(t);
 const mutations=[
  m=>{m.projection.plugins[0].coordinate={kind:'npm',name:'other',version:'2.0.0'};},
  m=>{m.projection.plugins[0].integrity='sha256:'+'b'.repeat(64);},
  m=>{m.projection.plugins[0].artifactDigest='sha256:'+'b'.repeat(64);m.identity.selections[0].artifactDigest=m.projection.plugins[0].artifactDigest;},
  m=>{m.projection.plugins[0].adapterRevision='sha256:'+'b'.repeat(64);},
  m=>{m.projection.plugins[0].executionClass='local-only';},
  m=>{m.projection.plugins[0].compatibility='unknown';},
  m=>{m.projection.plugins[0].sourceDocumentId='/raw/path';},
  m=>{m.scope.unknownAuthority=true;},
  m=>{m.bindings.unknownAuthority=true;},
  ...['baseRuntimeImageDigest','adapterRevision','permissionProfileRevision','ownerId','projectId'].map(field=>m=>{m.identity[field]='sha256:'+'b'.repeat(64);}),
  ...['ownerAccountCreatedAt','actorAccountCreatedAt','projectCreatedAt','actorId'].map(field=>m=>{m.scope[field]='changed';}),
  m=>{m.scope.actorMembershipEpoch='changed';},
  m=>{m.bindings.installations[0].actorMembershipEpoch='changed';},
  m=>{delete m.scope.actorMembershipEpoch;},
  m=>{delete m.bindings.installations[0].actorMembershipEpoch;},
  m=>{m.bindings.installations[0].coordinate='npm:other@2.0.0';},
  m=>{m.bindings.installations.push({...m.bindings.installations[0],extensionId:'dangling'});},
  m=>{m.bindings.installations[0].unknownAuthority=true;},
  m=>{m.bindings.installations.push({...m.bindings.installations[0]});}
 ];
 for(const [index,mutate] of mutations.entries()){await assert.rejects(async()=>{const m=await immutableManifest(f,{},mutate);return verifyExtensionGeneration(m.config,m.project,m.manifest.reference,{assessmentAuthority:f.authority});},`drift ${index}`);}
});

test('ordinary receipt-shaped immutable verifier remains unchanged without assessment constructor authority',async t=>{
 const f=await fixture(t),m=await immutableManifest(f,{},manifest=>{for(const row of [manifest.projection.plugins[0],manifest.bindings.installations[0]]){delete row.assessmentAdmissionDigest;row.receiptDigest=D;}});
 assert.deepEqual(await verifyExtensionGeneration(m.config,m.project,m.manifest.reference),m.manifest);
});

test('protected reader refuses wrong ownership, writable roots and parents, and symlinked roots',async t=>{
 const f=await fixture(t),wrong=createExtensionAssessmentAuthority({...f.options,expectedOwnerUid:process.getuid()+1});
 await assert.rejects(wrong.admit(f.context));
 const root=f.options.root;
 for(const mode of [0o755,0o770,0o777]){await fs.chmod(root,mode);await assert.rejects(f.authority.admit(f.context));}await fs.chmod(root,0o700);
 const parent=path.join(root,'unsafe-parent'),nested=path.join(parent,'private');await fs.mkdir(nested,{recursive:true,mode:0o700});await fs.chmod(parent,0o777);
 const nestedRecord=path.join(nested,'record.json');await fs.copyFile(f.recordPath,nestedRecord);await fs.chmod(nestedRecord,0o400);
 const nestedReader=createExtensionAssessmentAuthority({...f.options,root:nested,recordPath:nestedRecord});await assert.rejects(nestedReader.admit(f.context));
 await fs.chmod(parent,0o700);await nestedReader.admit(f.context);
 const link=path.join(root,'linked-private');await fs.symlink(nested,link);
 const linked=createExtensionAssessmentAuthority({...f.options,root:link,recordPath:path.join(link,'record.json')});await assert.rejects(linked.admit(f.context));
});
test('record UID is checked independently of a correctly owned private root',async t=>{
 const f=await fixture(t),open=fs.open.bind(fs),record=await fs.stat(f.recordPath);let observedRecord=false;
 t.mock.method(fs,'open',async(...args)=>{
  const handle=await open(...args);
  // Linux opens through pinned /proc/self/fd parents; match the file, not its spelling.
  return new Proxy(handle,{get(target,key){if(key==='stat')return async()=>{const stat=await target.stat();if(stat.dev===record.dev&&stat.ino===record.ino){observedRecord=true;Object.defineProperty(stat,'uid',{value:process.getuid()+1});}return stat;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 });
 await assert.rejects(f.authority.admit(f.context),{code:'extension_access_denied'});
 assert.equal(observedRecord,true,'the actual protected record descriptor was inspected');
});
