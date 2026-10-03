/** Actual PostgreSQL principal/installation reads; preparation rows below are
 * explicit synthetic fixtures, NOT a measured SDK preparation or SaaS receipt.
 * The optional image observation is read-only. No runtime or model is started.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalExtensionCoordinate, canonicalJson, extensionGenerationIdentity } from '@evimed/domain';
import { ControlPlaneDatabase } from '../../../apps/server/src/controlPlaneDatabase.mjs';
import { ProductJobs, ProductDocuments } from '../../../apps/server/src/productStore.mjs';
import { VcrStore } from '../../../apps/server/src/vcrStore.mjs';
import { VcrDataStore } from '../../../apps/server/src/vcrDataStore.mjs';
import { VcrMembers } from '../../../apps/server/src/vcrMembers.mjs';
import { createGeoTestDatabase } from '../../../apps/server/test/helpers/geoTestDatabase.mjs';
import { createShortCampaignRoot } from '../extension-saas-acceptance-journey.mjs';
import { createAssessmentDescriptor, prepareAssessmentDeployment } from '../extension-saas-acceptance-manifest.mjs';
import { createAssessmentCurrentFacts } from '../extension-saas-acceptance-composition.mjs';
import { ASSESSMENT_FACT_FIELDS, writeMeasurementAdmission } from '../extension-saas-acceptance-authority.mjs';
import { createExtensionAssessmentAuthority } from '../../../apps/server/src/extensionAssessmentAuthority.mjs';
import { verifyExtensionGeneration, extensionGenerationRoot } from '../../../apps/server/src/extensionGenerationService.mjs';
import { deploymentGenerationIdentities } from '../../../apps/server/src/extensionDeployment.mjs';

const databaseUrl=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,imageId=process.env.EVIMED_ASSESSMENT_TEST_RUNTIME_IMAGE;
test('real PG independently binds owner manager and prepared lead installer, rejects tamper/revocation/regrant and retains read ability semantics',
 {skip:!databaseUrl||!imageId},async()=>{
 const isolated=await createGeoTestDatabase(databaseUrl,'assessmentsubjects'),root=await createShortCampaignRoot();
 let database,extraRoot;
 try{
  database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:5000});
  await database.migrate();
  const studies=new VcrStore({database}),data=new VcrDataStore({database}),members=new VcrMembers({store:data});await studies.ready();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) SELECT id,id,'development' FROM unnest($1::text[]) id",[['owner','lead','viewer','outsider']]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('owner','shared','Synthetic',1048576)");
  const study=await studies.createStudy({userId:'owner',projectId:'shared',name:'Synthetic principal comparison'});
  await members.add({actor:'owner',studyId:study.id,userId:'lead',role:'lead'});
  await members.add({actor:'owner',studyId:study.id,userId:'viewer',role:'viewer'});
  const descriptor=await createAssessmentDescriptor({imageId,integrity:'sha256:'+'a'.repeat(64),closureExpectedSHA:'a'.repeat(64)});
  const deployment=await prepareAssessmentDeployment(root,descriptor,'sha256:'+'b'.repeat(64));
  const entry=deployment.catalogue[0],documents=new ProductDocuments(database),jobs=new ProductJobs(database);
  const epoch=async userId=>(await database.query('SELECT created_at::text AS epoch FROM evimed_control.users WHERE id=$1',[userId])).rows[0].epoch;
  const prepare=async(userId,installationId,projectTarget=null)=>{
   const actorEpoch=await epoch(userId),queued=await jobs.enqueue(userId,'extension-prepare',{
    installationId,installationRevision:1,coordinate:canonicalExtensionCoordinate(entry.coordinate),integrity:entry.integrity,accountCreatedAt:actorEpoch,projectTarget,
   },{idempotencyKey:'synthetic:'+installationId});
   const claimed=await jobs.claim(['extension-prepare'],'synthetic-fixture',{leaseMs:60000});assert.equal(claimed.id,queued.id);
   await jobs.finish(userId,claimed.id,claimed.leaseToken,{installationId,installationRevision:1,artifactDigest:descriptor.artifactDigest,integrity:entry.integrity});
   await documents.put(userId,'extension-installation',installationId,{coordinate:entry.coordinate,integrity:entry.integrity,prepareJobId:queued.id},{expectedRevision:0});
   return{extensionId:entry.id,artifactDigest:descriptor.artifactDigest,installationId,actorId:userId,
    actorMembershipEpoch:userId==='owner'?null:(await data.membershipAuthority(study.id,userId)).epoch,installationRevision:1,prepareJobId:queued.id};
  };
  const leadBinding=await prepare('lead','lead-install'),ownerBinding=await prepare('owner','owner-install');
  const selection=binding=>({catalogueId:entry.id,coordinate:entry.coordinate,integrity:entry.integrity,installationId:binding.installationId,actorId:binding.actorId});
  await documents.put('owner','extension-defaults','extensions:project:shared',{selections:[selection(leadBinding)]},{expectedRevision:0,projectId:'shared'});
  const config={dataDir:root,runtimeContainerImage:imageId,runtimeContainerBin:'docker'},project={id:'shared',userId:'owner'};
  const facts=createAssessmentCurrentFacts({getConfig:()=>config,getDatabase:()=>database});
  const initial=await facts({project,actor:{id:'owner'}});
  assert.equal(initial.actorId,'owner');assert.equal(initial.installerId,'lead');assert.equal(initial.actorMembershipEpoch,null);
  assert.equal(initial.installerAccountCreatedAt,await epoch('lead'));assert.equal(initial.installerMembershipEpoch,(await data.membershipAuthority(study.id,'lead')).epoch);
  const managerScope=Object.fromEntries(['ownerId','actorId','ownerAccountCreatedAt','actorAccountCreatedAt','actorMembershipEpoch','projectId','projectCreatedAt'].map(field=>[field,initial[field]]));
  const context={project,entry:initial.entry,artifact:initial.artifact,identity:initial.identity,managerScope,installerBinding:leadBinding,actor:{id:'lead'},
   scope:{...managerScope,actorId:'lead',actorAccountCreatedAt:initial.installerAccountCreatedAt},operation:'doc_read'};
  const record={...Object.fromEntries(ASSESSMENT_FACT_FIELDS.map(field=>[field,initial[field]])),assessmentId:'actual-pg-principals',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),allowedOperations:['doc_read','doc_write']};
  const signed=await writeMeasurementAdmission({root,admissions:[record]}),authority=createExtensionAssessmentAuthority({...signed,currentFacts:facts});
  await authority.admit(context);
  const scopedBinding=await prepare('lead','lead-project-install',{ownerId:'owner',projectId:'shared',projectCreatedAt:initial.projectCreatedAt,membershipEpoch:initial.installerMembershipEpoch});
  const projectContext={...context,installerBinding:scopedBinding};assert.equal((await facts(projectContext)).installerId,'lead');
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('owner','other','Second synthetic',1048576)");
  const otherStudy=await studies.createStudy({userId:'owner',projectId:'other',name:'Other synthetic'});
  await members.add({actor:'owner',studyId:otherStudy.id,userId:'lead',role:'lead'});
  const otherEpoch=(await data.membershipAuthority(otherStudy.id,'lead')).epoch;
  const otherProjectEpoch=(await database.query("SELECT created_at::text AS epoch FROM evimed_control.projects WHERE user_id='owner' AND id='other'")).rows[0].epoch;
  const otherContext={...context,project:{id:'other',userId:'owner'},managerScope:{...managerScope,projectId:'other',projectCreatedAt:otherProjectEpoch},
   installerBinding:{...scopedBinding,actorMembershipEpoch:otherEpoch}};
  await assert.rejects(facts(otherContext));
  // An account-scoped prepared library CAN serve that second authorized study.
  assert.equal((await facts({...otherContext,installerBinding:{...leadBinding,actorMembershipEpoch:otherEpoch}})).installerId,'lead');
  await database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id='owner' AND id='shared'");
  await assert.rejects(facts(projectContext));
  await database.query("UPDATE evimed_control.projects SET created_at=$1::timestamptz WHERE user_id='owner' AND id='shared'",[initial.projectCreatedAt]);
  // Real DB facts for a lead's historical configuration and today's owner
  // invocation are separately signed, then checked against one immutable file.
  const leadScope={...managerScope,actorId:'lead',actorAccountCreatedAt:initial.installerAccountCreatedAt,actorMembershipEpoch:initial.installerMembershipEpoch};
  const leadContext={...context,managerScope:leadScope},leadFacts=await facts(leadContext);
  const leadRecord={...record,...Object.fromEntries(ASSESSMENT_FACT_FIELDS.map(field=>[field,leadFacts[field]])),assessmentId:'lead-generation-manager'};
  const ownerRecord={...record,assessmentId:'owner-native-invoker'};
  extraRoot=await createShortCampaignRoot();
  const multi=await writeMeasurementAdmission({root:extraRoot,admissions:[leadRecord,ownerRecord]});
  const splitAuthority=createExtensionAssessmentAuthority({...multi,currentFacts:facts}),bond=await splitAuthority.admit(leadContext);
  const sha=value=>createHash('sha256').update(value).digest('hex'),configDigest='sha256:'+sha(canonicalJson({enabled:true,settings:{},connectionRefs:[]}));
  const baseIdentity=deploymentGenerationIdentities(deployment,imageId),identity={ownerId:'owner',projectId:'shared',baseRuntimeImageDigest:baseIdentity.baseRuntimeImageDigest,
   adapterRevision:baseIdentity.adapterRevision,permissionProfileRevision:baseIdentity.permissionProfileRevision,
   selections:[{extensionId:entry.id,artifactDigest:descriptor.artifactDigest,configRevision:1,configDigest,connectionRefs:[]}],skills:[]};
  const pin={extensionId:entry.id,coordinate:entry.coordinate,integrity:entry.integrity,artifactDigest:descriptor.artifactDigest,adapterRevision:initial.adapterRevision,
   configRevision:1,configDigest,enabled:true,settings:{},connectionRefs:[],executionClass:'isolated-tool',...bond};
  const manifest={schemaVersion:1,identity,scope:leadScope,bindings:{desiredRevision:1,legacyRevision:0,personalRevision:0,
   installations:[{...leadBinding,coordinate:canonicalExtensionCoordinate(entry.coordinate),integrity:entry.integrity,configDigest,...bond}]},projection:{plugins:[pin],personal:{pins:[],reference:null}},findings:[]};
  const generationHash=sha(canonicalJson({...manifest,domainIdentity:extensionGenerationIdentity(identity,{ownerId:'owner',projectId:'shared'},sha)}));
  manifest.reference={ownerHash:sha('owner'),projectHash:sha('shared'),generationHash};
  const generationDirectory=extensionGenerationRoot(config,manifest.reference);await fs.mkdir(path.join(generationDirectory,'selected'),{mode:0o700,recursive:true});
  await fs.chmod(path.join(generationDirectory,'selected'),0o755);
  await fs.writeFile(path.join(generationDirectory,'manifest.json'),canonicalJson(manifest)+'\n',{mode:0o400});
  await fs.writeFile(path.join(generationDirectory,'selected/projection.json'),canonicalJson(manifest.projection)+'\n',{mode:0o444});
  assert.equal((await verifyExtensionGeneration(config,project,manifest.reference,{assessmentAuthority:splitAuthority,assessmentContext:{callerScope:managerScope,operation:'doc_read'}})).scope.actorId,'lead');
  await assert.rejects(verifyExtensionGeneration(config,project,manifest.reference,{assessmentAuthority:splitAuthority,assessmentContext:{callerScope:{...managerScope,actorId:'outsider'},operation:'doc_read'}}));
  await database.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id='owner'");
  await assert.rejects(verifyExtensionGeneration(config,project,manifest.reference,{assessmentAuthority:splitAuthority,assessmentContext:{callerScope:managerScope,operation:'doc_read'}}));
  // Restore only this synthetic test row so subsequent cases isolate installer
  // revocation rather than repeatedly failing on the already changed caller.
  await database.query("UPDATE evimed_control.users SET created_at=$1::timestamptz WHERE id='owner'",[managerScope.actorAccountCreatedAt]);
  for(const field of ['actorId','installationId','prepareJobId']){
   await assert.rejects(authority.admit({...context,installerBinding:{...leadBinding,[field]:'outsider'}}));
  }
  // A desired change does not silently substitute the active immutable binding.
  await documents.put('owner','extension-defaults','extensions:project:shared',{selections:[selection(ownerBinding)]},{expectedRevision:1,projectId:'shared'});
  assert.equal((await facts(context)).installerId,'lead');await authority.admit(context);
  const ownerOnly=await facts({project,actor:{id:'owner'}});assert.equal(ownerOnly.installerId,'owner');assert.equal(ownerOnly.installerMembershipEpoch,null);
  assert.equal(ownerOnly.actorAccountCreatedAt,ownerOnly.installerAccountCreatedAt);
  await members.remove({actor:'owner',studyId:study.id,userId:'lead',role:'lead'});
  await assert.rejects(authority.admit(context));
  await assert.rejects(verifyExtensionGeneration(config,project,manifest.reference,{assessmentAuthority:splitAuthority,assessmentContext:{callerScope:managerScope,operation:'doc_read'}}));
  await members.add({actor:'owner',studyId:study.id,userId:'lead',role:'lead'});
  await assert.rejects(facts(context));
  const freshContext={...context,installerBinding:{...leadBinding,actorMembershipEpoch:(await data.membershipAuthority(study.id,'lead')).epoch}};
  const regranted=await facts(freshContext);assert.notEqual(regranted.installerMembershipEpoch,initial.installerMembershipEpoch);
  // A NEW authorized selection binds the new member incarnation without
  // requiring the historical preparation's membershipEpoch to equal it.
  assert.equal((await facts({...freshContext,installerBinding:{...scopedBinding,actorMembershipEpoch:regranted.installerMembershipEpoch}})).installerId,'lead');
  await assert.rejects(authority.admit(context));
  const viewerScope={...managerScope,actorId:'viewer',actorAccountCreatedAt:await epoch('viewer'),actorMembershipEpoch:(await data.membershipAuthority(study.id,'viewer')).epoch};
  const viewerRead={...freshContext,managerScope:viewerScope};assert.equal((await facts(viewerRead)).actorId,'viewer');
  await assert.rejects(facts({...viewerRead,operation:'doc_write'}));
  await assert.rejects(facts({...viewerRead,operation:undefined}));
  await members.remove({actor:'owner',studyId:study.id,userId:'viewer',role:'viewer'});
  await assert.rejects(facts(viewerRead));
  await members.add({actor:'owner',studyId:study.id,userId:'viewer',role:'viewer'});
  assert.notEqual((await facts(viewerRead)).actorMembershipEpoch,viewerScope.actorMembershipEpoch);
  // Old account-era prepared metadata cannot become live again after recreation.
  await database.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id='lead'");
  await assert.rejects(facts(context));
 }finally{await database?.close();await isolated.drop();await fs.rm(root,{recursive:true,force:true});if(extraRoot)await fs.rm(extraRoot,{recursive:true,force:true});}
});
