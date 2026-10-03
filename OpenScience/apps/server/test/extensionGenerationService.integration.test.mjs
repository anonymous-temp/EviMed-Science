import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {before,after,test} from 'node:test';
import {canonicalJson,EXTENSION_SAAS_CASE_IDS,extensionProofDigest} from '@evimed/domain';
import {createGeoTestDatabase} from './helpers/geoTestDatabase.mjs';
import {directorySize} from '../src/security.mjs';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {VcrStore} from '../src/vcrStore.mjs';
import {VcrDataStore} from '../src/vcrDataStore.mjs';
import {ExtensionAccess} from '../src/extensionAccess.mjs';
import {ExtensionService} from '../src/extensionService.mjs';
import {PluginService} from '../src/pluginService.mjs';
import {ExtensionGenerationService,verifyExtensionGeneration,extensionGenerationRoot} from '../src/extensionGenerationService.mjs';
import {ExtensionGenerationWorker} from '../src/extensionGenerationWorker.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??'',options={skip:!url&&'Isolated local PG generation fixture is required'};
if(url){const parsed=new URL(url);assert.equal(parsed.hostname,'127.0.0.1');assert.match(parsed.pathname,/evimed_test/);}
const h=value=>createHash('sha256').update(value).digest('hex'),d=value=>'sha256:'+h(canonicalJson(value));
const a={id:'generation_A_'+randomUUID()},b={id:'generation_B_'+randomUUID()},lead={id:'generation_lead_'+randomUUID()},viewer={id:'generation_viewer_'+randomUUID()};let studies,members,study, isolated,db,extensions,plugins,service,worker,runtime,root,proofEnabled=true,denied=false,failCandidate=false,kernelBusy=false,ledgerBusy=false,current=null,connectionAllowed=true;
const identities={baseRuntimeImageDigest:d('base'),adapterRevision:d('profile-adapter'),permissionProfileRevision:d('permission'),legacyCitationArtifactDigest:d('legacy-cite')};
const entry={id:'cowork-fixture',title:'Isolated bridge test fixture',coordinate:{kind:'npm',name:'cowork-fixture',version:'1.0.0'},executionClass:'isolated-tool',integrity:d('package-fixture'),settingsSchema:{rows:{type:'integer',min:1,max:100}}};
const artifact={...entry,artifactDigest:d('artifact-fixture'),adapterRevision:d('bridge-fixture'),suiteRevision:d('external-suite-fixture')};
// Synthetic authority controls exercise admission code only. These receipts
// never certify Cowork or any production/SaaS candidate and remain in this isolated fixture.
const proofAuthority=async({identity})=>{if(!proofEnabled)return null;const receipt={schemaVersion:1,identity,cases:EXTENSION_SAAS_CASE_IDS.map(caseId=>({caseId,status:'pass',observationDigests:[d('synthetic-control-'+caseId)],artifactDigests:[artifact.artifactDigest]}))};receipt.receiptDigest=extensionProofDigest(receipt,h);return{receipt,authority:{trustedReceiptDigests:new Set([receipt.receiptDigest]),trustedSurfaces:{client:false,browser:false,externalActions:false,descriptorDigest:d('fixture-surfaces')}}};};
const runtimeProof=candidate=>({reference:candidate.reference,runtimeGeneration:'fixture-runtime',baseRuntimeImageDigest:candidate.identity.baseRuntimeImageDigest,adapterRevision:candidate.identity.adapterRevision,permissionProfileRevision:candidate.identity.permissionProfileRevision,
  inventory:candidate.projection.plugins.map(plugin=>({extensionId:plugin.extensionId,artifactDigest:plugin.artifactDigest,configRevision:plugin.configRevision,configDigest:plugin.configDigest,enabled:plugin.enabled})),personal:candidate.projection.personal});
before(async()=>{if(!url)return;root=await fs.mkdtemp(path.join(os.tmpdir(),'extension-generation-'));await fs.mkdir(path.join(root,'skill-artifacts'));
  isolated=await createGeoTestDatabase(url,'extgenroles');db=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:1,databaseConnectionTimeoutMs:400});await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Generation A','development'),($2,'Generation B','development')",[a.id,b.id]);await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'p1','First',1048576),($1,'p2','Second',1048576),($2,'foreign','Other',1048576)",[a.id,b.id]);
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Lead','development'),($2,'Viewer','development')",[lead.id,viewer.id]);
  studies=new VcrStore({database:db});members=new VcrDataStore({database:db});await studies.ready();study=await studies.createStudy({userId:a.id,projectId:'p1',name:'Shared generation'});
  await members.addMember({studyId:study.id,userId:lead.id,role:'lead'});await members.addMember({studyId:study.id,userId:viewer.id,role:'viewer'});
  const access=new ExtensionAccess({store:{database:db,userById:async id=>({id}),requireProject:async(actor,id)=>{const row=(await db.query('SELECT id,user_id FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[actor.id,id])).rows[0];return row?{id,userId:row.user_id}:null;}},studyAccess:async(actor,id,{client})=>{const row=await studies.studyByControlProject(actor.id,id,client);const membership=row?await members.membershipAuthority(row.id,actor.id,client):null;return row?{ownerId:row.userId,roles:row.userId===actor.id?(denied?['viewer']:['lead']):membership.roles,epoch:row.userId===actor.id?null:membership.epoch}:null;},projectAccess:async(actor,id,{client}={})=>{const row=(await(client??db).query('SELECT id,user_id FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[actor.id,id])).rows[0];return row?{project:{id,userId:row.user_id},role:denied?'viewer':'owner'}:null;},connectionAccess:async(actor,ref)=>connectionAllowed&&actor.id===a.id&&ref==='connection-A'});
  extensions=new ExtensionService(db,{catalogue:[entry],access});plugins=new PluginService(db);
  service=new ExtensionGenerationService(db,{config:{dataDir:root,skillArtifactsRoot:path.join(root,'skill-artifacts'),maxGlobalBytes:8*1024*1024,maxOwnerBytes:4*1024*1024,minFreeBytes:1024},extensionService:extensions,pluginService:plugins,admittedArtifacts:[artifact],identities:async()=>({...identities}),proofAuthority});
  runtime={runtimeGeneration:()=> 'fixture-runtime',pluginRuntimeBusy:async()=>kernelBusy,currentGeneration:async()=>current,
    prepareGeneration:async(_project,candidate)=>({joined:true,manifestDigest:d(candidate)}),replaceGeneration:async(_project,candidate)=>{current=candidate;return{joined:true};},
    probeGeneration:async(_project,candidate)=>{if(failCandidate&&candidate.reference!==null)throw Object.assign(new Error('Fixture candidate refusal'),{code:'plugin_apply_failed'});return runtimeProof(candidate);},restoreGeneration:async(_project,candidate)=>{current=candidate;return{joined:true};}};
  worker=new ExtensionGenerationWorker({service,runtime,resolveProject:async job=>({id:job.projectId,userId:job.userId}),ledgerBusy:async()=>ledgerBusy});
});
after(async()=>{if(db){await db.query('DELETE FROM evimed_product.jobs WHERE user_id=ANY($1::text[])',[[a.id,b.id,lead.id,viewer.id]]);await db.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])',[[a.id,b.id,lead.id,viewer.id]]);await db.close();await isolated.drop();}if(root){for(const file of await fs.readdir(root,{recursive:true})){const target=path.join(root,file);const stat=await fs.lstat(target);if(stat.isDirectory())await fs.chmod(target,0o700);}await fs.rm(root,{recursive:true,force:true});}});
async function legacy(projectId,timeout){return plugins.documents.put(a.id,'plugin',`project:${projectId}:dsh-cite`,{schemaVersion:1,pluginId:'dsh-cite',binaryVersion:plugins.entry().version,enabled:true,settings:{timeoutMs:timeout}},{expectedRevision:0,projectId});}
async function add(projectId,key){const installed=await extensions.install(a,{coordinate:entry.coordinate,scope:'project',projectId,idempotencyKey:key});await db.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE id=$1",[installed.job.id]);const job=await extensions.jobs.claim(['extension-prepare'],'fixture-preparer');await extensions.jobs.finish(a.id,job.id,job.leaseToken,{installationId:installed.installation.id,installationRevision:1,integrity:entry.integrity,artifactDigest:artifact.artifactDigest,qualified:false});return installed;}
async function claim(state){const result=await db.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND kind='plugin-apply' AND payload->>'variant'='extension-generation-v1' AND (payload->>'stateRevision')::integer=$2 AND project_id=$3 ORDER BY created_at DESC LIMIT 1",[a.id,state.revision,state.projectId]);await db.query("UPDATE evimed_product.jobs SET run_after='1970-01-01'::timestamptz WHERE id=$1",[result.rows[0].id]);const claimed=await service.jobs.claim(['plugin-apply'],'fixture-dispatcher');assert.equal(claimed?.id,result.rows[0].id,'the fixture must claim its exact named generation job');return claimed;}
test('legacy compatibility migration twice preserves citation rows, settings and original history',options,async()=>{
  await legacy('p1',5000);await legacy('p2',9000);const before=await plugins.history(a,{id:'p1',userId:a.id});
  const first=await service.projectLegacy(a,'p1'),second=await service.projectLegacy(a,'p1');assert.equal(first.revision,second.revision);assert.equal(first.payload.sourceDocumentId,'project:p1:dsh-cite');assert.deepEqual(await plugins.history(a,{id:'p1',userId:a.id}),before);
});
test('two independent plugin configurations publish immutable scope-bound manifests with readable projection only',options,async()=>{
  const added=await add('p1','second-plugin');const saved=await extensions.saveProject(a,'p1',{expectedRevision:1,selections:[{installationId:added.installation.id,enabled:true,settings:{rows:7},connectionRefs:['connection-A']}]});
  const originalUmask=process.umask(0o077);let state;try{state=await service.reconcile(a,'p1',{expectedRevision:saved.revision});}finally{process.umask(originalUmask);}const manifest=state.payload.desired;assert.equal(manifest.projection.plugins.length,2);assert.equal(manifest.projection.plugins.find(p=>p.extensionId==='dsh-cite').settings.timeoutMs,5000);assert.equal(manifest.projection.plugins.find(p=>p.extensionId===entry.id).settings.rows,7);
  const verified=await verifyExtensionGeneration(service.config,{id:'p1',userId:a.id},manifest.reference);assert.deepEqual(verified,manifest);assert.equal((await fs.stat(path.join(extensionGenerationRoot(service.config,manifest.reference),'manifest.json'))).mode&0o777,0o400);
  const projection=path.join(extensionGenerationRoot(service.config,manifest.reference),'selected','projection.json');await fs.chmod(projection,0o400);const retryUmask=process.umask(0o077);try{assert.equal((await service.reconcile(a,'p1',{expectedRevision:saved.revision})).revision,state.revision);}finally{process.umask(retryUmask);}assert.equal((await fs.stat(projection)).mode&0o777,0o444);await assert.rejects(service.reconcile(b,'p1',{expectedRevision:saved.revision}),{status:404});
  const other=await service.reconcile(a,'p2',{expectedRevision:0});assert.equal(other.payload.desired.projection.plugins[0].settings.timeoutMs,9000);await assert.rejects(verifyExtensionGeneration(service.config,{id:'p2',userId:a.id},manifest.reference));
});
test('untrusted optional package is omitted with a finding while ordinary research/citation baseline stays selected',options,async()=>{
  proofEnabled=false;const selected=await extensions.project(a,'p1');const state=await service.reconcile(a,'p1',{expectedRevision:selected.revision});assert.deepEqual(state.payload.desired.projection.plugins.map(row=>row.extensionId),['dsh-cite']);assert.equal(state.payload.desired.findings[0].code,'extension_proof_untrusted');proofEnabled=true;
});
test('busy runtime defers application and changed desired revisions supersede queued old generation',options,async()=>{
  const selected=await extensions.project(a,'p1');const state=await service.reconcile(a,'p1',{expectedRevision:selected.revision});kernelBusy=null;const unknown=await claim(state);await worker.runClaimed(unknown);assert.equal((await service.jobs.get(a.id,unknown.id)).status,'queued');kernelBusy=true;const pending=await claim(state);await worker.runClaimed(pending);assert.equal((await service.jobs.get(a.id,pending.id)).status,'queued');assert.equal(current,null);kernelBusy=false;
  const changed=await extensions.saveProject(a,'p1',{expectedRevision:selected.revision,selections:selected.selections.map(row=>({installationId:row.installationId,enabled:row.enabled,settings:{rows:9},connectionRefs:['connection-A']}))});const newer=await service.reconcile(a,'p1',{expectedRevision:changed.revision});
  const old=await claim(state);assert.equal((await worker.runClaimed(old)).result.superseded,true);assert.equal((await service.current({id:'p1',userId:a.id})).payload.effective,null);assert.equal(newer.payload.desired.projection.plugins.find(p=>p.extensionId===entry.id).settings.rows,9);
});
test('exact runtime inventory proof, then failed optional boot restores the known good generation',options,async()=>{
  let state=await service.current({id:'p1',userId:a.id});const claimed=await claim(state);const done=await worker.runClaimed(claimed);assert.equal(done.result.phase,'effective');const good=(await service.current({id:'p1',userId:a.id})).payload.lastGood;
  const controls=await Promise.all([service.projectLegacy(a,'p1'),service.projectLegacy(a,'p2'),service.operationIdentity(a,'p1',entry.id,'fixture-runtime'),service.operationIdentity(a,'p1',entry.id,'fixture-runtime')]);assert.equal(db.pool.totalCount,1);const operation=controls[2];assert.equal(operation.userId,a.id);assert.equal(operation.extensionGenerationHash,good.reference.generationHash);assert.equal(operation.installationRevision,1);assert.deepEqual(Object.keys(operation).sort(),['accountCreatedAt','artifactDigest','descriptorId','extensionGenerationHash','installationId','installationRevision','membershipEpoch','ownerAccountCreatedAt','ownerId','projectCreatedAt','projectId','runtimeGeneration','userId']);await assert.rejects(service.operationIdentity(a,'p1',entry.id,'another-runtime'),{status:503});await assert.rejects(service.operationIdentity(b,'p1',entry.id,'fixture-runtime'),{status:404});
  const desired=await extensions.project(a,'p1');const changed=await extensions.saveProject(a,'p1',{expectedRevision:desired.revision,selections:desired.selections.map(row=>({installationId:row.installationId,enabled:true,settings:{rows:11},connectionRefs:['connection-A']}))});state=await service.reconcile(a,'p1',{expectedRevision:changed.revision});failCandidate=true;
  runtime.probeGeneration=async(_project,candidate)=>{if(candidate.reference?.generationHash!==good.reference.generationHash)throw Object.assign(new Error('Fixture failure'),{code:'plugin_apply_failed'});return runtimeProof(candidate);};
  const failed=await worker.runClaimed(await claim(state));assert.equal(failed.result.phase,'rolled-back');assert.equal((await service.current({id:'p1',userId:a.id})).payload.effective.reference.generationHash,good.reference.generationHash);assert.equal(current.reference.generationHash,good.reference.generationHash);failCandidate=false;runtime.probeGeneration=async(_project,candidate)=>runtimeProof(candidate);
});
test('the execution caller cannot borrow the installer connection and a revoked real lead cannot apply a queued generation',options,async()=>{
  await assert.rejects(service.operationIdentity(viewer,'p1',entry.id,'fixture-runtime','doc_read'),{status:403});
  const selected=await extensions.project(lead,'p1');const state=await service.reconcile(lead,'p1',{expectedRevision:selected.revision});
  const job=await claim(state);assert.equal(job.payload.actorId,lead.id);
  await members.removeMember({studyId:study.id,userId:lead.id,role:'lead'});
  await members.addMember({studyId:study.id,userId:lead.id,role:'lead'});
  const original=current;await worker.runClaimed(job);assert.equal((await service.jobs.get(a.id,job.id)).status,'failed');assert.equal(current,original);
  const renewed=await service.reconcile(lead,'p1',{expectedRevision:selected.revision});assert.notEqual(renewed.payload.desired.scope.actorMembershipEpoch,job.payload.actorMembershipEpoch);
  await members.addMember({studyId:study.id,userId:lead.id,role:'lead'});
});
test('generic healthy status without exact configuration inventory never marks a new generation effective',options,async()=>{
  const desired=await extensions.project(a,'p1');const changed=await extensions.saveProject(a,'p1',{expectedRevision:desired.revision,selections:desired.selections.map(row=>({installationId:row.installationId,enabled:true,settings:{rows:13},connectionRefs:['connection-A']}))});const state=await service.reconcile(a,'p1',{expectedRevision:changed.revision});const before=(await service.current({id:'p1',userId:a.id})).payload.effective;
  runtime.probeGeneration=async(_project,candidate)=>candidate.reference?.generationHash===state.payload.desired.reference.generationHash?{healthy:true}:runtimeProof(candidate);
  const done=await worker.runClaimed(await claim(state));assert.notEqual(done.result.phase,'effective');assert.equal((await service.current({id:'p1',userId:a.id})).payload.effective?.reference.generationHash,before.reference.generationHash);runtime.probeGeneration=async(_project,candidate)=>runtimeProof(candidate);
});

test('durable prompt admissions and ledger work defer the same exclusive apply without burning attempts',options,async()=>{
  const selected=await extensions.project(a,'p1');const changed=await extensions.saveProject(a,'p1',{expectedRevision:selected.revision,selections:selected.selections.map(row=>({installationId:row.installationId,enabled:true,settings:{rows:17},connectionRefs:['connection-A']}))});const state=await service.reconcile(a,'p1',{expectedRevision:changed.revision});
  const id=randomUUID();await db.query('INSERT INTO evimed_product.plugin_prompt_admissions(id,user_id,project_id) VALUES($1,$2,$3)',[id,a.id,'p1']);const promptJob=await claim(state);await worker.runClaimed(promptJob);assert.equal((await service.jobs.get(a.id,promptJob.id)).attempts,0);await db.query('DELETE FROM evimed_product.plugin_prompt_admissions WHERE id=$1',[id]);
  ledgerBusy=true;const ledgerJob=await claim(state);await worker.runClaimed(ledgerJob);assert.equal((await service.jobs.get(a.id,ledgerJob.id)).status,'queued');ledgerBusy=false;await service.jobs.cancel(a.id,ledgerJob.id);
});
test('a canceled lease or changed management authority cannot perform a runtime replacement',options,async()=>{
  const desired=await extensions.project(a,'p1');let changed=await extensions.saveProject(a,'p1',{expectedRevision:desired.revision,selections:desired.selections.map(row=>({installationId:row.installationId,enabled:true,settings:{rows:19},connectionRefs:['connection-A']}))});let state=await service.reconcile(a,'p1',{expectedRevision:changed.revision});let called=0;const replace=runtime.replaceGeneration;runtime.replaceGeneration=async(...args)=>{called++;return replace(...args);};
  const canceled=await claim(state);await service.jobs.cancel(a.id,canceled.id);assert.equal(await worker.runClaimed(canceled),null);assert.equal(called,0);
  changed=await extensions.saveProject(a,'p1',{expectedRevision:changed.revision,selections:desired.selections.map(row=>({installationId:row.installationId,enabled:true,settings:{rows:21},connectionRefs:['connection-A']}))});state=await service.reconcile(a,'p1',{expectedRevision:changed.revision});denied=true;assert.equal((await worker.runClaimed(await claim(state))).status,'failed');assert.equal(called,0);denied=false;runtime.replaceGeneration=replace;
});
test('a proven personal-state revision change supersedes an extension candidate on the shared project fence',options,async()=>{
  const desired=await extensions.project(a,'p1');const changed=await extensions.saveProject(a,'p1',{expectedRevision:desired.revision,selections:desired.selections.map(row=>({installationId:row.installationId,enabled:true,settings:{rows:22},connectionRefs:['connection-A']}))});const state=await service.reconcile(a,'p1',{expectedRevision:changed.revision});await service.documents.put(a.id,'extension-generation','personal-skills:project:p1',{desired:null,effective:null},{expectedRevision:0,projectId:'p1'});
  const outcome=await worker.runClaimed(await claim(state));assert.equal(outcome.status,'failed');assert.equal(outcome.error.code,'product_revision_conflict');assert.notEqual((await service.current({id:'p1',userId:a.id})).payload.phase,'effective');
});
test('a library retry preserves the already selected successful artifact revision',options,async()=>{
  const desired=await extensions.project(a,'p1'),id=desired.selections[0].installationId;const before=await service.reconcile(a,'p1',{expectedRevision:desired.revision});
  const retried=await extensions.retry(a,id,{expectedRevision:1});const after=await service.reconcile(a,'p1',{expectedRevision:desired.revision});assert.equal(after.payload.desired.reference.generationHash,before.payload.desired.reference.generationHash);assert.equal(after.payload.desired.projection.plugins.length,2);await extensions.cancelJob(a,retried.job.id);
});
test('combined artifact/personal storage and disk headroom block new bytes but permit immutable reuse',options,async()=>{
  const desired=await extensions.project(a,'p1'),same=await service.reconcile(a,'p1',{expectedRevision:desired.revision});const max=service.config.maxGlobalBytes;service.config.maxGlobalBytes=1;
  assert.equal((await service.reconcile(a,'p1',{expectedRevision:desired.revision})).payload.desired.reference.generationHash,same.payload.desired.reference.generationHash);
  const changed=await extensions.saveProject(a,'p1',{expectedRevision:desired.revision,selections:desired.selections.map(row=>({installationId:row.installationId,enabled:true,settings:{rows:23},connectionRefs:['connection-A']}))});
  await assert.rejects(service.reconcile(a,'p1',{expectedRevision:changed.revision}),{code:'extension_storage_capacity'});service.config.maxGlobalBytes=max;
  const oldFree=service.config.minFreeBytes;service.config.minFreeBytes=Number.MAX_SAFE_INTEGER;await assert.rejects(service.reconcile(a,'p1',{expectedRevision:changed.revision}),{code:'extension_storage_capacity'});service.config.minFreeBytes=oldFree;
  const generationBytes=await directorySize(path.join(root,'.openscience','extension-generations'),{maxEntries:50000});service.config.maxGlobalBytes=generationBytes+50000;
  const personalPad=path.join(root,'.openscience','personal-skill-generations','fixture-padding'),artifactPad=path.join(root,'skill-artifacts','fixture-padding');await fs.writeFile(personalPad,Buffer.alloc(30000));await fs.writeFile(artifactPad,Buffer.alloc(30000));
  await assert.rejects(service.reconcile(a,'p1',{expectedRevision:changed.revision}),{code:'extension_storage_capacity'});await fs.unlink(personalPad);await fs.unlink(artifactPad);service.config.maxGlobalBytes=max;
});

test('immutable projection tampering and forged qualification input are rejected',options,async()=>{
  const desired=await extensions.project(a,'p1');const state=await service.reconcile(a,'p1',{expectedRevision:desired.revision});const project={id:'p1',userId:a.id},file=path.join(extensionGenerationRoot(service.config,state.payload.desired.reference),'selected','projection.json');
  const bytes=await fs.readFile(file);await fs.chmod(file,0o600);await fs.writeFile(file,'{"forged":true}');await fs.chmod(file,0o444);await assert.rejects(verifyExtensionGeneration(service.config,project,state.payload.desired.reference));await fs.chmod(file,0o600);await fs.writeFile(file,bytes);await fs.chmod(file,0o444);
  await assert.rejects(service.reconcile(a,'p1',{expectedRevision:desired.revision,qualified:true}),{status:400});
});
test('revoked current connection grants remove only the optional extension and preserve baseline selection',options,async()=>{
  const desired=await extensions.project(a,'p1');connectionAllowed=false;const state=await service.reconcile(a,'p1',{expectedRevision:desired.revision});assert.deepEqual(state.payload.desired.projection.plugins.map(row=>row.extensionId),['dsh-cite']);assert.equal(state.payload.desired.findings[0].code,'extension_access_denied');connectionAllowed=true;
});
test('account epoch changes fence a queued generation and preserve completed research bytes',options,async()=>{
  const desired=await extensions.project(a,'p1');const state=await service.reconcile(a,'p1',{expectedRevision:desired.revision});const completed=path.join(root,'completed-research.txt');await fs.writeFile(completed,'preserved research fixture');
  await db.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id=$1",[a.id]);const failed=await worker.runClaimed(await claim(state));assert.equal(failed.status,'failed');assert.equal(failed.error.code,'unauthorized');assert.equal(await fs.readFile(completed,'utf8'),'preserved research fixture');
});

test('a first selected generation on an idle project without a runtime is started and verified rather than deferred forever',options,async()=>{
  denied=false;proofEnabled=true;kernelBusy=false;ledgerBusy=false;
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'cold-project','Cold generation',1048576)",[a.id]);
  await add('cold-project','cold-generation-install');
  const desired=await extensions.project(a,'cold-project'),state=await service.reconcile(a,'cold-project',{expectedRevision:desired.revision});
  const originalGeneration=runtime.runtimeGeneration,originalReplace=runtime.replaceGeneration;let started=false,replacements=0;
  runtime.runtimeGeneration=()=>started?'fixture-runtime':null;
  runtime.replaceGeneration=async(_project,candidate)=>{current=candidate;started=true;replacements++;return{joined:true};};
  try{const finished=await worker.runClaimed(await claim(state));assert.equal(finished.status,'succeeded');assert.equal(finished.result.phase,'effective');assert.equal(replacements,1);
    assert.equal((await service.current({id:'cold-project',userId:a.id})).payload.runtimeGeneration,'fixture-runtime');}
  finally{runtime.runtimeGeneration=originalGeneration;runtime.replaceGeneration=originalReplace;}
});
