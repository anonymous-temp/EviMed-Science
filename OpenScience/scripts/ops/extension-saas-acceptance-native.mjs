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
const exec=promisify(execFile), hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const DIGEST=/^sha256:[a-f0-9]{64}$/;
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
