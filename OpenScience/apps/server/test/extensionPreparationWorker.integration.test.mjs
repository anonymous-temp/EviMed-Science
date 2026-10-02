import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {before,after,test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {canonicalJson} from '@evimed/domain';
import {ExtensionToolController,extensionToolArtifactDigest} from '../src/extensionToolController.mjs';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {ExtensionAccess} from '../src/extensionAccess.mjs';
import {ExtensionService} from '../src/extensionService.mjs';
import {ExtensionPreparationWorker} from '../src/extensionPreparationWorker.mjs';
import {migrateProductStore} from '../src/productPersistence.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??'',options={skip:!url&&'Local PostgreSQL fixture URL required'};
if(url){const parsed=new URL(url);assert.equal(parsed.hostname,'127.0.0.1');assert.match(parsed.pathname,/evimed_test_extension_worker/);}
const sha=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const entry={id:'admitted-fixture',title:'Fixture',coordinate:{kind:'npm',name:'admitted-fixture',version:'1.0.0'},integrity:sha('package'),executionClass:'isolated-tool'};
const artifact={...entry,artifactDigest:sha('real-transport-fixture-artifact-binding')};
let db,service,controller,worker,role='owner';const user={id:'extension_worker_'+randomUUID()},other={id:'extension_worker_other_'+randomUUID()};
const prepared=()=>({coordinate:'npm:admitted-fixture@1.0.0',integrity:entry.integrity,artifactDigest:artifact.artifactDigest,qualified:false,joined:true});
const barrier=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
before(async()=>{if(!url)return;db=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:6,databaseConnectionTimeoutMs:2000});await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Worker fixture','development'),($2,'Other fixture','development')",[user.id,other.id]);
  await migrateProductStore(db);await db.query("DELETE FROM evimed_product.jobs j WHERE user_id LIKE 'extension_worker_%' AND NOT EXISTS(SELECT 1 FROM evimed_control.users u WHERE u.id=j.user_id)");
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'owned-project','Worker fixture',1048576)",[user.id]);
  const access=new ExtensionAccess({projectAccess:async(actor,id)=>{const result=await db.query('SELECT user_id,id FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[actor.id,id]);return result.rows[0]?{project:{id,userId:actor.id},role}:null;}});
  service=new ExtensionService(db,{catalogue:[entry],access});controller={admissionAvailable:async()=>true,prepare:async()=>prepared()};worker=new ExtensionPreparationWorker({service,controller,admittedArtifacts:[artifact]});
});
after(async()=>{if(db){await db.query('DELETE FROM evimed_product.jobs WHERE user_id=ANY($1::text[])',[[user.id,other.id]]);await db.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])',[[user.id,other.id]]);await db.close();}});
const due=async added=>{await db.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE id=$1",[added.job.id]);return added;};
const install=async key=>due(await service.install(user,{coordinate:entry.coordinate,scope:'library',idempotencyKey:key}));
const job=async added=>service.jobs.get(user.id,added.job.id);
test('lease-finished real PG preparation binds installation revision and artifact without effective or qualification claim',options,async()=>{
  const added=await install('prepared');const finished=await worker.run();assert.equal(finished.id,added.job.id);assert.equal(finished.status,'succeeded');assert.equal(finished.result.artifactDigest,artifact.artifactDigest);
  const row=await service.get(user,added.installation.id);assert.equal(row.phase,'waiting');assert.equal(row.effective,false);assert.equal(row.evidenceState,'source-assessed');
});
test('cross-user installation references and unsupported packages fail before trusted controller dispatch',options,async()=>{
  const added=await install('foreign-reference');await db.query('UPDATE evimed_product.jobs SET user_id=$2 WHERE id=$1',[added.job.id,other.id]);let calls=0;controller.prepare=async()=>{calls++;return prepared();};
  const finished=await worker.run();assert.equal(finished.status,'failed');assert.equal(calls,0);assert.equal((await service.get(user,added.installation.id)).effective,false);
});
test('revision changes while controller is preparing cannot land old artifact on the updated installation',options,async()=>{
  const added=await install('revision-change'),entered=barrier(),release=barrier();controller.prepare=async()=>{entered.resolve();await release.promise;return prepared();};
  const running=worker.run();await Promise.race([entered.promise,running.then(outcome=>{throw new Error('Preparation completed before barrier: '+JSON.stringify({status:outcome?.status,code:outcome?.error?.code}));})]);const updated=await service.retry(user,added.installation.id,{expectedRevision:1});release.resolve();const finished=await running;
  assert.equal(finished.status,'failed');assert.equal(finished.error.code,'product_revision_conflict');assert.equal((await service.get(user,added.installation.id)).revision,2);await service.cancelJob(user,updated.job.id);
});
test('expired and reclaimed real PG lease cannot finish or cancel the newer attempt',options,async()=>{
  const added=await install('lease-change'),entered=barrier(),release=barrier();controller.prepare=async()=>{entered.resolve();await release.promise;return prepared();};
  const running=worker.run();await Promise.race([entered.promise,running.then(outcome=>{throw new Error('Preparation completed before barrier: '+JSON.stringify({status:outcome?.status,code:outcome?.error?.code}));})]);const captured=structuredClone(worker.active.get(added.job.id).identity);
  await db.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[added.job.id]);
  const claimed=await service.jobs.claim(['extension-prepare'],'fixture-new-worker');await assert.rejects(worker.cancelPreparation({...captured,leaseToken:claimed.leaseToken}),{status:409});release.resolve();assert.equal(await running,null);
  const current=await job(added);assert.equal(current.leaseToken,claimed.leaseToken);assert.equal(current.status,'running');await service.jobs.cancel(user.id,added.job.id);
});
test('wrong artifact or caller qualification cannot become a prepared installation',options,async()=>{
  const added=await install('wrong-artifact');controller.prepare=async()=>({...prepared(),artifactDigest:sha('different'),qualified:true});const finished=await worker.run();assert.equal(finished.status,'failed');assert.equal((await service.get(user,added.installation.id)).phase,'failed');
});
test('project epoch and current management role are rechecked before artifact admission',options,async()=>{
  const added=await due(await service.install(user,{coordinate:entry.coordinate,scope:'project',projectId:'owned-project',idempotencyKey:'project-epoch'}));await db.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id='owned-project'",[user.id]);
  let calls=0;controller.prepare=async()=>{calls++;return prepared();};assert.equal((await worker.run()).status,'failed');assert.equal(calls,0);
  await due(await service.install(user,{coordinate:entry.coordinate,scope:'project',projectId:'owned-project',idempotencyKey:'role-change'}));role='viewer';assert.equal((await worker.run()).status,'failed');assert.equal(calls,0);role='owner';assert.equal((await job(added)).result,null);
});
test('current account epoch is checked again after actual leased preparation transport returns',options,async()=>{
  const added=await install('account-epoch'),entered=barrier(),release=barrier();controller.prepare=async()=>{entered.resolve();await release.promise;return prepared();};
  const running=worker.run();await Promise.race([entered.promise,running.then(outcome=>{throw new Error('Preparation completed before barrier: '+JSON.stringify({status:outcome?.status,code:outcome?.error?.code}));})]);await db.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id=$1",[user.id]);release.resolve();const finished=await running;assert.equal(finished.status,'failed');assert.equal(finished.error.code,'unauthorized');assert.equal((await job(added)).result,null);
});

async function actualController(){
  const image=process.env.COWORK_TEST_IMAGE;if(!image)throw new Error('Actual immutable Cowork image is required for this PG/container case');
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../'),adapter=path.join(root,'OpenScience/scripts/runtime/extensions/cowork');
  const directory=await fs.mkdtemp(path.join(root,'.evimed-local/extensions/build/fixtures/worker-'));
  const h=bytes=>createHash('sha256').update(bytes).digest('hex');
  const pinned={id:'cowork-portable',title:'Cowork',executionClass:'isolated-tool',coordinate:{kind:'github',repository:'Jesse-njx/dsh-cowork',commit:'2ae5cf755c4294a1e988eebf3b12dd062425d84c'},integrity:'sha256:f9bae51a0c0c5858aedfa17fb2ba71f7d4db4c84b27ba959061cdaefd77fa95b',imageId:image,closureExpectedSHA:h(await fs.readFile(path.join(root,'.evimed-local/extensions/build/cowork-final-mode-20261002/context/dependency-closure.json'))),runnerSHA:h(await fs.readFile(path.join(adapter,'runner.mjs'))),policySHA:h(await fs.readFile(path.join(adapter,'policy.mjs'))),inventorySHA:h(await fs.readFile(path.join(adapter,'image-inventory.mjs')))};
  pinned.adapterDigest='sha256:'+h(canonicalJson({runnerSHA:pinned.runnerSHA,policySHA:pinned.policySHA,inventorySHA:pinned.inventorySHA}));pinned.artifactDigest=extensionToolArtifactDigest(pinned);
  const runtime=new ExtensionToolController({admittedDescriptors:[pinned],stateRoot:directory,adapterRoot:adapter,inputRoot:path.join(directory,'public'),
    resolvePreparation:async(identity,descriptor)=>{const current=await service.jobs.get(user.id,identity.jobId);
      if(current?.status!=='running'||current.leaseToken!==identity.leaseToken||current.attempts!==identity.attempts)throw Object.assign(new Error('Fixture attempt changed'),{code:'product_state_unavailable'});
      return{identity,descriptorId:descriptor.id,artifactDigest:descriptor.artifactDigest};}});
  service.entries.set(pinned.id,pinned);return{pinned,runtime,directory};
}
test('actual Docker inventory and adapter proof complete a real PG leased preparation, still unqualified',options,async()=>{
  const {pinned,runtime,directory}=await actualController();
  try{const added=await due(await service.install(user,{coordinate:pinned.coordinate,scope:'library',idempotencyKey:'actual-cowork'}));
    const actualWorker=new ExtensionPreparationWorker({service,controller:runtime,admittedArtifacts:[pinned]});const finished=await actualWorker.run();assert.equal(finished.status,'succeeded');assert.equal(finished.result.artifactDigest,pinned.artifactDigest);assert.equal(finished.result.qualified,false);
    assert.equal((await service.get(user,added.installation.id)).phase,'waiting');assert.equal((await service.get(user,added.installation.id)).effective,false);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('service cancellation of real leased Docker preparation waits for physical join and matching attempt',options,async()=>{
  const {pinned,runtime,directory}=await actualController();const entered=barrier(),release=barrier();let containerName;
  const original=runtime.startContainer.bind(runtime);runtime.startContainer=async(scope,...args)=>{containerName=scope.name;entered.resolve();await release.promise;return original(scope,...args);};
  try{const added=await due(await service.install(user,{coordinate:pinned.coordinate,scope:'library',idempotencyKey:'actual-cancel'}));
    const actualWorker=new ExtensionPreparationWorker({service,controller:runtime,admittedArtifacts:[pinned]});service.cancelPreparation=identity=>actualWorker.cancelPreparation(identity);
    const pending=actualWorker.run();await Promise.race([entered.promise,pending.then(outcome=>{throw new Error('Preparation completed before barrier: '+JSON.stringify({status:outcome?.status,code:outcome?.error?.code}));})]);
    const captured=structuredClone(actualWorker.active.get(added.job.id).identity);await assert.rejects(actualWorker.cancelPreparation({...captured,attempts:captured.attempts+1}),{status:409});
    const aborted=barrier();runtime.active.get(added.job.id).abort.signal.addEventListener('abort',()=>aborted.resolve(),{once:true});const canceled=service.cancelJob(user,added.job.id);await aborted.promise;
    assert.equal((await job(added)).status,'running');release.resolve();assert.equal((await canceled).status,'canceled');assert.equal(await pending,null);
    assert.throws(()=>execFileSync('docker',['inspect',containerName],{stdio:'ignore'}));assert.equal(await runtime.admissionAvailable(),true);
  }finally{release.resolve();service.cancelPreparation=null;await fs.rm(directory,{recursive:true,force:true});}
});

test('expired preparation holds host capacity until the exact original attempt is joined, then resumes saved intent',options,async()=>{
  const added=await install('original-attempt-recovery'),claimed=await service.jobs.claim(['extension-prepare'],'expired-fixture');
  await db.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[claimed.id]);
  let joined=false,received;
  controller.cancelPreparation=async identity=>{received=identity;return{identity,settled:joined,joined,physicallyAbsent:joined};};
  await worker.recover();assert.equal((await job(added)).status,'running');assert.equal(received.leaseToken,claimed.leaseToken);
  joined=true;await worker.recover();const recovered=await job(added);assert.equal(recovered.status,'queued');assert.equal(recovered.leaseToken,null);
  controller.prepare=async()=>prepared();assert.equal((await worker.run()).status,'succeeded');
});

test('a restarted preparation worker durably retries post-preparation activation scheduling without re-running the artifact',options,async()=>{
  const added=await install('activation-recovery');controller.prepare=async()=>prepared();let calls=0;
  const scheduling=new ExtensionPreparationWorker({service,controller,admittedArtifacts:[artifact],onPrepared:async()=>{calls++;throw Object.assign(new Error('fixture unavailable'),{code:'product_state_unavailable'});}});
  assert.equal((await scheduling.run()).status,'succeeded');assert.equal((await job(added)).result.activationIntentQueued,undefined);
  const restarted=new ExtensionPreparationWorker({service,controller,admittedArtifacts:[artifact],onPrepared:async()=>{calls++;}});
  await restarted.reconcilePrepared();assert.equal((await job(added)).result.activationIntentQueued,true);
  const prior=calls;await restarted.reconcilePrepared();assert.equal(calls,prior);
});
