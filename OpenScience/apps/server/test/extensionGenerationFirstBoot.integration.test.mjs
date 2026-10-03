import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {RuntimeManager} from '../src/runtimeManager.mjs';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {PluginService} from '../src/pluginService.mjs';
import {ExtensionAccess} from '../src/extensionAccess.mjs';
import {ExtensionService} from '../src/extensionService.mjs';
import {ExtensionGenerationService} from '../src/extensionGenerationService.mjs';
import {SkillLibraryService} from '../src/skillLibraryService.mjs';
import {SkillLibraryArtifacts} from '../src/skillLibraryArtifacts.mjs';
import {PersonalSkillGenerationService} from '../src/personalSkillGenerationService.mjs';
import {createGeoTestDatabase} from './helpers/geoTestDatabase.mjs';
const configured=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,options={skip:!configured&&'An isolated local PostgreSQL fixture is required'};
const hash=value=>'sha256:'+createHash('sha256').update(canonicalJson(value)).digest('hex');
test('actual manager composite first boot preserves frozen PG personal revision; ordinary boot still initializes personal state and stale candidates refuse',options,async()=>{
 const isolated=await createGeoTestDatabase(configured,'compositeboot'),database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:1,databaseConnectionTimeoutMs:1000}),root=await fs.mkdtemp(path.join(os.tmpdir(),'composite-first-boot-'));
 try{
  await database.migrate();const user={id:'first_boot_'+randomUUID()},project={userId:user.id,id:'project'};
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'First boot fixture','development')",[user.id]);await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'First boot project',1048576)",[user.id,project.id]);
  await fs.mkdir(path.join(root,'skill-artifacts'));
  const identities={baseRuntimeImageDigest:hash('base'),adapterRevision:hash('adapter'),permissionProfileRevision:hash('permission'),legacyCitationArtifactDigest:hash('legacy')},plugins=new PluginService(database),artifacts=new SkillLibraryArtifacts({root:path.join(root,'skill-artifacts')}),skills=new SkillLibraryService(database,{artifacts,projectAccess:async(actor,selected)=>{assert.equal(actor.id,user.id);assert.equal(selected.userId,user.id);}});
  const personal=new PersonalSkillGenerationService(database,{config:{dataDir:root,skillArtifactsRoot:path.join(root,'skill-artifacts'),runtimeProvider:'docker',maxGlobalBytes:1024*1024,maxOwnerBytes:1024*1024,minFreeBytes:1024},skillService:skills,pluginService:plugins,resolveUser:async()=>user,identities:async()=>({baseRuntimeImageDigest:identities.baseRuntimeImageDigest,adapterRevision:identities.adapterRevision,permissionProfileRevision:identities.permissionProfileRevision}),ledgerBusy:async()=>false});
  const access=new ExtensionAccess({projectAccess:async(actor,id,{client}={})=>{const row=(await(client??database).query('SELECT user_id,id FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[actor.id,id])).rows[0];return row?{project:{id:row.id,userId:row.user_id},role:'owner'}:null;}}),extensions=new ExtensionService(database,{catalogue:[],access});
  const composite=new ExtensionGenerationService(database,{config:{dataDir:root,skillArtifactsRoot:path.join(root,'skill-artifacts'),maxGlobalBytes:1024*1024,maxOwnerBytes:1024*1024,minFreeBytes:1024},extensionService:extensions,pluginService:plugins,admittedArtifacts:[],identities:async()=>identities,proofAuthority:async()=>null});
  const snapshot=()=>database.transaction(client=>database.withTransactionClient(client,()=>composite.snapshot(user,project.id,client)));
  const frozen=await composite.reconcile(user,project.id,{expectedRevision:0}),candidate=frozen.payload.desired;
  const exactJobId=(await database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND project_id=$2 AND kind='plugin-apply' AND payload->'reference'->>'generationHash'=$3",[user.id,project.id,candidate.reference.generationHash])).rows[0].id;
  const exactJob=await composite.jobs.get(user.id,exactJobId);assert.equal(candidate.bindings.personalRevision,0);assert.equal(await personal.current(project),null);
  const manager=new RuntimeManager({runtimeProvider:'docker',runtimeMode:'kernel',dataDir:root});manager.pluginService=plugins;manager.personalSkillGenerations=personal;manager.syncCapsuleMethods=async()=>({count:0});
  const stopped=Object.assign(new Error('Provider boundary deliberately stops before Docker/kernel launch'),{code:'fixture_provider_boundary'});let captured;
  // Real manager runs through actual PG services. The final provider boundary
  // stops startup; this fixture never supplies a successful kernel or proof.
  manager.provider={preflight:async()=>{},prepare:async(_project,plan)=>{captured=plan;throw stopped;}};
  manager.extensionGenerationOverrides.set(manager.key(project),candidate);await assert.rejects(manager.startKernel(project),error=>error===stopped);assert.equal(captured.extensionGeneration,candidate);assert.equal(captured.personalSkillGeneration,null);assert.equal(await personal.current(project),null);
  const unchanged=await snapshot();assert.equal(unchanged.manifest.reference.generationHash,candidate.reference.generationHash);assert.equal(unchanged.manifest.bindings.personalRevision,0);
  const admitted=await database.transaction(client=>database.withTransactionClient(client,()=>composite.assertCurrent(exactJob,candidate,client)));assert.equal(admitted.userId,user.id);assert.equal(admitted.id,project.id);
  manager.extensionGenerationOverrides.delete(manager.key(project));await assert.rejects(manager.startKernel(project),error=>error===stopped);const initialized=await personal.current(project);assert.ok(initialized.revision>0);assert.ok(initialized.payload.desired.reference);assert.equal(initialized.payload.desired.pins.length,0);
  const changed=await snapshot();assert.notEqual(changed.manifest.reference.generationHash,candidate.reference.generationHash);assert.ok(changed.manifest.bindings.personalRevision>0);
  // A candidate is still exact: an independently changed personal revision
  // remains a conflict rather than being ignored as semantically equivalent.
  await assert.rejects(database.transaction(client=>database.withTransactionClient(client,()=>composite.assertCurrent(exactJob,candidate,client))),{code:'product_revision_conflict'});
 }finally{await database.close();await isolated.drop();await fs.rm(root,{recursive:true,force:true});}
});
