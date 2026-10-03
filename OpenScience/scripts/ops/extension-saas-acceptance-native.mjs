/** Real fixed native kernel boundary. Synthetic model/gateway transport cannot prove hosted authority or vendor billing. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assessmentDockerEnvironment} from './extension-saas-acceptance-docker.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readAcceptanceInputs} from './extension-saas-acceptance-inputs.mjs';
import { RuntimeManager } from '../../apps/server/src/runtimeManager.mjs';
import { ExtensionGenerationService, extensionGenerationRoot } from '../../apps/server/src/extensionGenerationService.mjs';
import { ExtensionGenerationWorker, assertExtensionGenerationRuntimeProof } from '../../apps/server/src/extensionGenerationWorker.mjs';
import { ExtensionOperationService } from '../../apps/server/src/extensionOperationService.mjs';
import { ExtensionOperationWorker } from '../../apps/server/src/extensionOperationWorker.mjs';
import { canonicalJson } from '@evimed/domain';
import { openScopedFileNoFollow, readStableFileHandle } from '../../apps/server/src/security.mjs';
const exec=promisify(execFile), hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const DIGEST=/^sha256:[a-f0-9]{64}$/;
/** A campaign calls the real manager/worker; duck-typed fixtures cannot become measured runtime evidence. */
function campaignGenerationServices(app, project, job) {
 const runtime=app?.runtimeManager,service=app?.hostedExtensions?.generations,worker=app?.pluginApplyWorker?.generationWorker;
 if(!(runtime instanceof RuntimeManager)||!(service instanceof ExtensionGenerationService)||!(worker instanceof ExtensionGenerationWorker)
  ||worker.runtime!==runtime||worker.service!==service||job?.userId!==project?.userId||job?.projectId!==project?.id||job.status!=='running'||!worker.canHandle(job))throw new Error('real_generation_campaign_required');
 return{runtime,service,worker};
}
/** Operator-side reads use the trusted host workspace, never the kernel's /workspace alias. */
export async function readCampaignWorkspaceArtifact({dataDir,workspaceDir},relativePath) {
 if(typeof relativePath!=='string'||relativePath.split('/').some(part=>!part||part==='.'||part==='..')||path.isAbsolute(relativePath)||relativePath.includes('\\'))throw new Error('invalid_completed_artifact');
 if(typeof dataDir!=='string'||typeof workspaceDir!=='string'||!path.isAbsolute(dataDir)||!path.isAbsolute(workspaceDir)
  ||!workspaceDir.startsWith(dataDir+path.sep)||await fs.realpath(dataDir)!==dataDir||await fs.realpath(workspaceDir)!==workspaceDir)throw new Error('invalid_completed_artifact');
 const opened=await openScopedFileNoFollow(workspaceDir,path.join(workspaceDir,relativePath));
 try{if(opened.stat.size<1||opened.stat.size>8*1024*1024||opened.stat.nlink!==1)throw new Error('completed_artifact_unbounded');return await readStableFileHandle(opened.handle,opened.stat);}finally{await opened.handle.close();}
}
/** A completed job's trusted scope and publication record, not a kernel path, bind the host read. */
export async function readCampaignDocumentOutput(app,project,job,sessionId,expectedArtifactPath) {
 if(job?.status!=='succeeded'||job.payload?.request?.operation!=='doc_write'||job.payload?.invocation?.sessionId!==sessionId
  ||job.payload.scope?.projectId!==project.id||(job.payload.scope.ownerId??job.payload.scope.userId)!==project.userId
  ||!['ipynb','xlsx'].includes(job.payload.request.format)||job.result?.format!==job.payload.request.format
  ||expectedArtifactPath!=='outputs/extensions/'+job.payload.request.targetId+'.'+job.payload.request.format
  ||job.result?.artifactPath!==expectedArtifactPath||!/^outputs\/extensions\/[A-Za-z0-9_-]+\.(?:ipynb|xlsx)$/.test(expectedArtifactPath)
  ||!/^[a-f0-9]{64}$/.test(job.result.sha256??''))throw new Error('invalid_completed_artifact');
 const workspace=await app.hostedExtensions.documents.projectRoot(job.payload.scope,null);
 if(workspace!==project.workspaceDir)throw new Error('invalid_completed_artifact');
 const bytes=await readCampaignWorkspaceArtifact({dataDir:app.config.dataDir,workspaceDir:workspace},job.result.artifactPath);
 if(hash(bytes)!==job.result.sha256)throw new Error('invalid_completed_artifact');
 return{bytes,path:path.join(workspace,job.result.artifactPath)};
}
async function completedWorkspaceDigest(runtime,project,relativePath) {
 return 'sha256:'+hash(await readCampaignWorkspaceArtifact({dataDir:runtime.config.dataDir,workspaceDir:project.workspaceDir},relativePath));
}
/** Root provisions a genuinely pending native turn and an owned leased normal apply job before this call. */
export async function observeRuntimeBusyDeferral({app,project,job,completedArtifact}) {
 const{runtime,service,worker}=campaignGenerationServices(app,project,job);
 assert.equal(await runtime.pluginRuntimeBusy(project),true);
 const before=await service.current(project),generation=runtime.runtimeGeneration(project),active=runtime.currentGeneration(project);
 assert(before?.payload.effective&&active&&generation);assert.equal(canonicalJson(before.payload.effective.reference),canonicalJson(active.reference));
 const preserved=await completedWorkspaceDigest(runtime,project,completedArtifact);
 await worker.runClaimed(job);
 const queued=await service.jobs.get(job.userId,job.id),after=await service.current(project);
 assert.equal(queued.status,'queued');assert.equal(queued.leaseToken,null);
 assert.equal(runtime.runtimeGeneration(project),generation);assert.equal(canonicalJson(runtime.currentGeneration(project)),canonicalJson(active));
 assert.equal(canonicalJson(after.payload.effective),canonicalJson(before.payload.effective));
 assert.equal(await completedWorkspaceDigest(runtime,project,completedArtifact),preserved);
 return{caseId:'SAAS-18',scope:'actual-runtime-manager-native-busy-generation-deferral',setup:'Real owned pending native turn and leased normal generation apply; no patched busy/probe result',
  expected:'Native busy update defers and preserves active generation and completed workspace bytes',actual:{runtimeGeneration:generation,jobId:job.id,jobStatus:queued.status,completedArtifactDigest:preserved},qualified:false};
}
/** Root injects only a bounded physical startup fault in the owned candidate, never a fake successful proof or changed ledger row. */
export async function observeRuntimeCandidateRollback({app,project,job,completedArtifact}) {
 const{runtime,service,worker}=campaignGenerationServices(app,project,job);
 assert.equal(await runtime.pluginRuntimeBusy(project),false);
 const before=await service.current(project),active=runtime.currentGeneration(project);
 assert(before?.payload.lastGood&&active);assert.equal(canonicalJson(before.payload.lastGood.reference),canonicalJson(active.reference));
 assert.notEqual(canonicalJson(before.payload.desired.reference),canonicalJson(active.reference));
 const preserved=await completedWorkspaceDigest(runtime,project,completedArtifact);
 await worker.runClaimed(job);
 const after=await service.current(project),settled=await service.jobs.get(job.userId,job.id);
 assert.equal(settled.status,'succeeded');assert.equal(settled.result.phase,'rolled-back');assert.equal(settled.result.error,'plugin_apply_failed');
 assert.equal(after.payload.phase,'rolled-back');assert.equal(canonicalJson(after.payload.effective.reference),canonicalJson(before.payload.lastGood.reference));
 assert.equal(canonicalJson(runtime.currentGeneration(project).reference),canonicalJson(before.payload.lastGood.reference));
 const proof=await runtime.probeGeneration(project,after.payload.effective);
 assertExtensionGenerationRuntimeProof(after.payload.effective,proof,runtime.runtimeGeneration(project));
 assert.equal(await completedWorkspaceDigest(runtime,project,completedArtifact),preserved);
 return{caseId:'SAAS-18',scope:'actual-runtime-manager-failed-candidate-rollback',setup:'Normal leased apply; externally observed bounded physical candidate startup failure; actual restore and probe',
  expected:'Failed candidate restores exact still-authorized lastGood and preserves completed research',actual:{jobId:job.id,jobStatus:settled.status,phase:after.payload.phase,
   restoredGenerationHash:after.payload.effective.reference.generationHash,runtimeGeneration:proof.runtimeGeneration,completedArtifactDigest:preserved},qualified:false};
}
/** Pure target fence. A reused name/image is insufficient: immutable ID, fresh creation and candidate generation mount must all agree. */
export function validateCandidateFaultTarget(actual,expected) {
 const labels=actual?.Config?.Labels,mount=actual?.HostConfig?.Mounts?.find(item=>item.Target==='/opt/evimed/extensions');
 const physical=actual?.Mounts?.find(item=>item.Destination==='/opt/evimed/extensions');
 if(!/^[a-f0-9]{64}$/.test(actual?.Id??'')||actual.Id===expected.previousId||actual.Name!=='/'+expected.containerName
  ||actual.Image!==expected.imageId||labels?.['open-science.web.runtime']!=='true'||labels?.['open-science.user']!==expected.ownerId
  ||labels?.['open-science.project']!==expected.projectId||!Number.isFinite(Date.parse(actual.Created))||Date.parse(actual.Created)<expected.attemptStartedAt
  ||actual.State?.Running!==true||actual.Config?.User!=='10001:10001'||actual.HostConfig?.ReadonlyRootfs!==true||!actual.HostConfig?.CapDrop?.includes('ALL')
  ||!actual.HostConfig?.SecurityOpt?.some(value=>value==='no-new-privileges'||value==='no-new-privileges:true')||mount?.ReadOnly!==true||physical?.RW!==false
  ||(expected.dataVolume?mount.Type!=='volume'||mount.Source!==expected.dataVolume||mount.VolumeOptions?.Subpath!==expected.selectedRelativePath
   :mount.Type!=='bind'||mount.Source!==expected.selectedPath))throw new Error('candidate_fault_identity_unconfirmed');
 return actual.Id;
}
/** Actual serial campaign only. Kill one independently inspected new candidate ID, then let the unmodified worker restore/probe lastGood. */
export async function runRuntimeCandidateFailureControl({app,project,job,completedArtifact,signal=null}) {
 const{runtime,service}=campaignGenerationServices(app,project,job),config=runtime.config;
 const live=runtime.runtimes.get(runtime.key(project)),state=await service.current(project),candidate=state?.payload.desired;
 if(!live?.containerName||!candidate?.reference||candidate.reference.generationHash===state.payload.lastGood?.reference?.generationHash)throw new Error('candidate_fault_setup_incomplete');
 const command=async args=>(await exec(config.runtimeContainerBin,args,{timeout:5000,maxBuffer:128*1024,env:assessmentDockerEnvironment(),...(signal?{signal}:{})})).stdout.trim();
 const inspect=async target=>JSON.parse(await command(['inspect','--format','{{json .}}',target]));
 const prior=await inspect(live.containerName),selectedPath=path.join(extensionGenerationRoot(config,candidate.reference),'selected');
 if(!/^[a-f0-9]{64}$/.test(prior.Id)||prior.Image!==candidate.identity.baseRuntimeImageDigest)throw new Error('candidate_fault_setup_incomplete');
 const expected={previousId:prior.Id,containerName:live.containerName,imageId:candidate.identity.baseRuntimeImageDigest,
  ownerId:project.userId,projectId:project.id,attemptStartedAt:Date.now(),selectedPath,dataVolume:config.runtimeDataVolume,
  selectedRelativePath:path.relative(config.dataDir,selectedPath).split(path.sep).join('/')};
 let finished=false,injected=null,watcherFailure=null;
 const watcher=(async()=>{
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
   if(finished)break;
   signal?.throwIfAborted();
   let found;try{found=await inspect(expected.containerName);}catch(error){if(!/No such (?:object|container)/i.test(error.stderr??''))throw error;}
   if(found&&found.Id!==prior.Id){
    const id=validateCandidateFaultTarget(found,expected);
    // Independently reread protected canonical generation bytes and identity immediately before destructive fault injection.
    const verified=await service.verifyManifest(project,candidate.reference);
    if(canonicalJson(verified)!==canonicalJson(candidate))throw new Error('candidate_fault_manifest_changed');
    validateCandidateFaultTarget(await inspect(id),expected);
    await command(['kill','--signal','KILL',id]);
    injected={containerId:id,generationHash:candidate.reference.generationHash,manifestDigest:'sha256:'+hash(canonicalJson(candidate)),imageId:expected.imageId};return;
   }
   await new Promise(resolve=>setTimeout(resolve,100));
  }
 })().catch(error=>{watcherFailure=error;});
 let observed,failure;
 try{observed=await observeRuntimeCandidateRollback({app,project,job,completedArtifact});}catch(error){failure=error;}finally{finished=true;}
 await watcher;
 if(watcherFailure)throw watcherFailure;
 if(!injected)throw Object.assign(new Error('candidate_startup_identity_not_observed'),{code:'candidate_startup_identity_not_observed',qualified:false});
 if(failure)throw failure;
 return{...observed,actual:{...observed.actual,startupFault:injected}};
}
/** The queued job must come from the real native gateway; caller performs a real API/membership/credential revocation. */
export async function observeQueuedOperationRevocation({app,project,jobId,revoke,completedArtifact}) {
 const service=app?.hostedExtensions?.operations,worker=app?.hostedExtensions?.worker,runtime=app?.runtimeManager;
 if(!(service instanceof ExtensionOperationService)||!(worker instanceof ExtensionOperationWorker)||!(runtime instanceof RuntimeManager)
  ||worker.service!==service||typeof revoke!=='function'||worker.running||worker.active.size)throw new Error('real_queued_revocation_campaign_required');
 const queued=await service.jobs.get(project.userId,jobId);
 assert.equal(queued?.kind,'extension-execute');assert.equal(queued.status,'queued');assert.equal(queued.projectId,project.id);
 assert.equal(queued.payload.dispatch,null);assert(queued.payload.auth.invocation);
 const preserved=await completedWorkspaceDigest(runtime,project,completedArtifact);
 await revoke();
 await worker.tick();
 const failed=await service.jobs.get(project.userId,jobId);
 assert.equal(failed.status,'failed');assert.equal(failed.payload.dispatch,null);
 assert(['extension_access_denied','extension_proof_stale','product_state_unavailable','project_not_found','not_found','ENOENT','file_not_found'].includes(failed.error?.code));
 assert.equal(await completedWorkspaceDigest(runtime,project,completedArtifact),preserved);
 return{caseId:'SAAS-05',scope:'actual-native-queued-operation-current-authority-revocation',
  setup:'Real native-gateway queued operation; real current-authority revocation; unmodified leased worker refuses before dispatch',
  expected:'Queued revoked native request cannot dispatch; completed permitted bytes remain',actual:{jobId,status:failed.status,code:failed.error.code,dispatch:null,completedArtifactDigest:preserved},qualified:false};
}
export function validateNativeObservation(value,{pin,enabled}) {
 assert.equal(value.kernel,pin);assert.equal(value.uid,10001);assert.equal(value.readOnlyProjection,true);
 assert.deepEqual(value.nativeTools,enabled?['doc_read','doc_write']:[]);assert.equal(value.citation.timeoutMs,enabled?4000:5000);
 assert(Number.isSafeInteger(value.gatewayCalls)&&Number.isSafeInteger(value.modelCalls));
 if(enabled){assert(value.gatewayCalls>0);assert(value.modelCalls>0);assert.deepEqual(value.contextObservations,{forgedActorRefusedBeforeGateway:true,failedToolPreserved:true,priorSourceRetained:true,changedSourceAndAssumptionRetained:true,refusalEncoding:'completed-tool-with-error-output',turns:4});}else{assert.equal(value.gatewayCalls,0);assert.equal(value.modelCalls,0);assert.equal(value.contextObservations,null);}
 return value;
}
export async function runNativeBoundaryControls({image,signal=null}) {
 assert.match(image,DIGEST);
 const source=await fs.readFile(new URL('../../apps/server/test/fixtures/extensionNativeKernel.mjs',import.meta.url));
 const fixtureSHA=hash(source), pin=JSON.parse(await fs.readFile(new URL('../../deps-version.json',import.meta.url),'utf8')).dsh.version;
 const dockerEnv=assessmentDockerEnvironment(), owner='evimed-saas-native-'+randomUUID(), controls=[];
 const command=async(args,timeout=10000,currentSignal=signal)=>{const result=await exec('docker',args,{timeout,maxBuffer:256*1024,env:dockerEnv,...(currentSignal?{signal:currentSignal}:{})});return result.stdout.trim();};
 const ownership=createNativeAssessmentOwnership(command,owner);
 const create=args=>ownership.create(args), remove=id=>ownership.remove(id);
 let report, failure, cleanupFailure;
 try {
  const imageInfo=JSON.parse(await command(['image','inspect',image]))[0];assert.equal(imageInfo.Id,image);assert.equal(imageInfo.Os,'linux');
  const probe=await create(['--user','10001:10001','--memory','128m','--pids-limit','32','--entrypoint','node',image,'-e',"const fs=require('fs'),crypto=require('crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync('/fixture/fixture.mjs')).digest('hex'))"]);
  const embeddedSHA=await command(['start','-a',probe]);await remove(probe);
  if(embeddedSHA!==fixtureSHA)throw Object.assign(new Error('native_fixture_source_stale'),{code:'native_fixture_source_stale',expectedFixtureSHA:fixtureSHA,actualFixtureSHA:embeddedSHA});
  for(const enabled of [true,false]) {
   signal?.throwIfAborted();const scenario=enabled?'enabled':'disabled',volume=owner+'-'+scenario;
   await ownership.volume(volume);
   const keeper=await create(['--user','0:0','--memory','128m','--pids-limit','32','--mount',`type=volume,source=${volume},target=/projection`,'--entrypoint','node',image,'-e',`const fs=require('fs');fs.copyFileSync('/fixture/generations/${scenario}/projection.json','/projection/projection.json');fs.chmodSync('/projection',0o755);fs.chmodSync('/projection/projection.json',0o444);setInterval(()=>{},1000);`]);
   await command(['start',keeper]);await command(['exec',keeper,'node','-e',"require('fs').statSync('/projection/projection.json')"]);
   const id=await create(['--user','10001:10001','--cpus','1','--memory','512m','--pids-limit','64','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','--mount',`type=volume,source=${volume},target=/opt/evimed/extensions,readonly`,'--entrypoint','node',image,'/fixture/fixture.mjs']);
   const actual=JSON.parse(await command(['inspect',id]))[0];assert.equal(actual.Id,id);assert.equal(actual.Image,image);assert.equal(actual.Config.User,'10001:10001');assert.equal(actual.HostConfig.NetworkMode,'none');assert.equal(actual.HostConfig.ReadonlyRootfs,true);assert(actual.HostConfig.CapDrop.includes('ALL'));assert.equal(actual.Mounts.length,1);assert.equal(actual.Mounts.find(row=>row.Destination==='/opt/evimed/extensions').RW,false);
   const result=validateNativeObservation(JSON.parse(await command(['start','-a',id],45000)),{pin,enabled});controls.push({scenario,...result});
   await remove(id);await remove(keeper);await ownership.removeVolume(volume);
  }
  const enabled=controls[0],disabled=controls[1], common={imageId:image,architecture:imageInfo.Architecture,fixtureSHA,sourceMatched:true};
  const observation=(caseId,expected,actual)=>({caseId,scope:'actual-pinned-native-kernel-component',setup:'Real UID10001/native SDK/registry/session/tool history; synthetic-provider-contract and synthetic local gateway, fixture generation SETUP, no hosted grants/qualification',expected,actual:{...common,...actual}});
  report={qualified:false,controls,observations:[
   observation('SAAS-04','Actual root call context reaches bridge; forged actor parameter refused before gateway while original pending native call correlated',{rootPendingCallObserved:true,nativeRegistrySessionFactsObserved:true,forgedActorRefusedBeforeGateway:enabled.contextObservations.forgedActorRefusedBeforeGateway,gatewayCalls:enabled.gatewayCalls,uncovered:'Child delegation, queued hosted callbacks and current durable signed actor binding'}),
   observation('SAAS-13','Selected native registry exposes doc_read/doc_write, disabled generation exposes neither',{enabledTools:enabled.nativeTools,disabledTools:disabled.nativeTools,disabledGatewayCalls:disabled.gatewayCalls,uncovered:'Actual blocked-child/nested PTC permission exercise'}),
   observation('SAAS-18','Actual pending native call reports busy and verifyExtensions refuses probing while active',{busyVerifyRefusal:true,uncovered:'RuntimeManager update during other project execution and actual failed candidate rollback'}),
   observation('SAAS-19','Real four-turn history and controlled outbound model context retain changed sources/numeric assumptions and both tool failures',{pendingCall:'native_owned_call',userTurn:'native-prompt',...enabled.contextObservations,uncovered:'Compaction/discovery provenance and actual provider/scientific content'})
  ],cleanup:{physicallyJoined:true},limitation:'Native component fixture controls only; full hosted grants/default app/current serving image and provider billing not measured.'};
 }catch(error){failure=error;}finally{
  try{await ownership.cleanup();}catch(error){cleanupFailure=error;}
 }
 if(cleanupFailure||!ownership.empty())throw Object.assign(new Error('native_cleanup_unconfirmed'),{code:'native_cleanup_unconfirmed'});if(failure)throw failure;return report;
}

/** Test-driver lifecycle, not serving execution authority. Track intent before daemon mutation, then clean immutable IDs only. */
export function createNativeAssessmentOwnership(command,owner) {
 if(typeof command!=='function'||!/^evimed-saas-native-[a-f0-9-]{36}$/.test(owner))throw new Error('native_owner_refused');
 const scopes=new Map(),volumes=new Set();let sequence=0;
 const missing=error=>/No such (?:object|container|volume)/i.test(error.stderr??'');
 const inspect=async target=>{try{return JSON.parse(await command(['inspect',target],5000,null))[0];}catch(error){if(missing(error))return null;throw error;}};
 const matches=(actual,scope)=>actual&&/^[a-f0-9]{64}$/.test(actual.Id)&&actual.Config.Labels?.['io.evimed.saas-campaign']===owner&&actual.Config.Labels?.['io.evimed.saas-instance']===scope.name;
 const removeScope=async scope=>{
  const actual=await inspect(scope.id??scope.name);
  if(scope.id&&!actual){if(await inspect(scope.name))throw new Error('native_name_replacement_retained');scopes.delete(scope.name);return;}
  if(!actual){scopes.delete(scope.name);return;}
  if(!matches(actual,scope)||(scope.id&&actual.Id!==scope.id)||(!scope.id&&actual.Name!=='/'+scope.name))throw new Error('native_container_ownership_unknown');
  scope.id=actual.Id;await command(['rm','-f',scope.id,'-v'],10000,null);
  if(await inspect(scope.id))throw new Error('native_container_still_present');
  // Do not erase an uncertain replacement under the reserved name or claim complete cleanup.
  if(await inspect(scope.name))throw new Error('native_name_replacement_retained');scopes.delete(scope.name);
 };
 const removeVolume=async name=>{
  let row;try{row=JSON.parse(await command(['volume','inspect',name],5000,null))[0];}catch(error){if(missing(error)){volumes.delete(name);return;}throw error;}
  if(row.Name!==name||row.Labels?.['io.evimed.saas-campaign']!==owner)throw new Error('native_volume_ownership_unknown');
  await command(['volume','rm',name],10000,null);volumes.delete(name);
 };
 return{
  async create(args){const name=owner+'-'+(++sequence),scope={name,id:null};scopes.set(name,scope);
   const id=await command(['create','--pull','never','--name',name,'--label','io.evimed.saas-campaign='+owner,'--label','io.evimed.saas-instance='+name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/runtime:ro,noexec,nosuid,nodev,size=1m,mode=0555','--tmpfs','/workspace:ro,noexec,nosuid,nodev,size=1m,mode=0555',...args]);
   if(!/^[a-f0-9]{64}$/.test(id))throw new Error('native_create_identity_unconfirmed');scope.id=id;return id;},
  async remove(id){const scope=[...scopes.values()].find(row=>row.id===id);if(!scope)throw new Error('native_container_not_registered');await removeScope(scope);},
  async volume(name){if(!name.startsWith(owner+'-'))throw new Error('native_volume_not_owned');volumes.add(name);await command(['volume','create','--label','io.evimed.saas-campaign='+owner,'--driver','local','--opt','type=tmpfs','--opt','device=tmpfs','--opt','o=size=4m,mode=0755',name]);},
  removeVolume,
  async cleanup(){let failed=false;for(const scope of [...scopes.values()])try{await removeScope(scope);}catch{failed=true;}
   if(!scopes.size)for(const name of [...volumes])try{await removeVolume(name);}catch{failed=true;}
   if(failed||scopes.size||volumes.size)throw new Error('native_cleanup_unconfirmed');},
  empty:()=>scopes.size===0&&volumes.size===0
 };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const abort=new AbortController(),interrupted=()=>abort.abort();process.once('SIGTERM',interrupted);process.once('SIGINT',interrupted);
 try{if(process.argv.length!==2)throw new Error('no_public_native_arguments');const inputs=await readAcceptanceInputs(process.env.EVIMED_EXTENSION_ACCEPTANCE_INPUTS);process.stdout.write(JSON.stringify(await runNativeBoundaryControls({image:inputs.images.nativeKernelImageId,signal:abort.signal}))+'\n');}
 catch(error){process.stderr.write(JSON.stringify({status:'failed',qualified:false,code:error.code??'native_boundary_incomplete'})+'\n');process.exitCode=1;}
 finally{process.removeListener('SIGTERM',interrupted);process.removeListener('SIGINT',interrupted);}
}
