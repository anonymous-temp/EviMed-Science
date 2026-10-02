import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNativeObservation, runNativeBoundaryControls, observeRuntimeBusyDeferral, observeRuntimeCandidateRollback, observeQueuedOperationRevocation, validateCandidateFaultTarget } from '../extension-saas-acceptance-native.mjs';
test('startup fault control fences immutable new candidate by owner/project/image/generation mount and creation time',()=>{
 const expected={previousId:'a'.repeat(64),containerName:'fixture',imageId:'sha256:'+'a'.repeat(64),ownerId:'owner',projectId:'project',attemptStartedAt:1000,
  selectedPath:'/owned/generation-new/selected',dataVolume:null};
 const actual={Id:'b'.repeat(64),Name:'/fixture',Image:expected.imageId,Created:new Date(1001).toISOString(),State:{Running:true},
  Config:{User:'10001:10001',Labels:{'open-science.web.runtime':'true','open-science.user':'owner','open-science.project':'project'}},
  HostConfig:{ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Mounts:[{Target:'/opt/evimed/extensions',Type:'bind',Source:expected.selectedPath,ReadOnly:true}]},
  Mounts:[{Destination:'/opt/evimed/extensions',RW:false}]};
 assert.equal(validateCandidateFaultTarget(actual,expected),actual.Id);
 for(const changed of [{...actual,Id:expected.previousId},{...actual,Created:new Date(999).toISOString()},
  {...actual,Image:'sha256:'+'b'.repeat(64)}, {...actual,Config:{Labels:{...actual.Config.Labels,'open-science.user':'foreign'}}},
  {...actual,HostConfig:{Mounts:[{...actual.HostConfig.Mounts[0],Source:'/owned/generation-old/selected'}]}},
  {...actual,State:{Running:false}}, {...actual,Mounts:[{Destination:'/opt/evimed/extensions',RW:true}]}]) {
  assert.throws(()=>validateCandidateFaultTarget(changed,expected),/identity_unconfirmed/);
 }
});
test('main-path campaign helpers cannot convert duck-typed runtime/worker observations to measurements',async()=>{
 for(const observe of [observeRuntimeBusyDeferral,observeRuntimeCandidateRollback,observeQueuedOperationRevocation]) {
  await assert.rejects(observe({app:{runtimeManager:{pluginRuntimeBusy:async()=>true},hostedExtensions:{}},project:{userId:'fixture',id:'fixture'},job:{status:'running'},revoke:async()=>{}}),/real_.*campaign_required/);
 }
});
test('native observation validation requires actual pin/registry and controlled gateway outcomes',()=>{
 const row={kernel:'fixture',uid:10001,readOnlyProjection:true,nativeTools:['doc_read','doc_write'],gatewayCalls:1,modelCalls:2,citation:{timeoutMs:4000},contextObservations:{forgedActorRefusedBeforeGateway:true,failedToolPreserved:true,priorSourceRetained:true,changedSourceAndAssumptionRetained:true,refusalEncoding:'completed-tool-with-error-output',turns:4}};
 assert.throws(()=>validateNativeObservation(row,{pin:'different',enabled:true}));
 assert.throws(()=>validateNativeObservation({...row,nativeTools:['shell']},{pin:'fixture',enabled:true}));
 assert.throws(()=>validateNativeObservation({...row,gatewayCalls:0},{pin:'fixture',enabled:true}));
 assert.throws(()=>validateNativeObservation({...row,gatewayCalls:1,nativeTools:[]},{pin:'fixture',enabled:false}));
 assert.equal(validateNativeObservation(row,{pin:'fixture',enabled:true}).uid,10001);
});
test('actual prepared native image exercises current fixture bytes, selected tools and pending history', {skip:!process.env.EVIMED_EXTENSION_ACCEPTANCE_INPUTS&&'Fresh protected preparer inputs required; stale/missing image is not a pass',timeout:120000},async()=>{
 const {readAcceptanceInputs}=await import('../extension-saas-acceptance-inputs.mjs'); const inputs=await readAcceptanceInputs(process.env.EVIMED_EXTENSION_ACCEPTANCE_INPUTS);
 const result=await runNativeBoundaryControls({image:inputs.images.nativeKernelImageId});
 assert.equal(result.qualified,false);assert.equal(result.cleanup.physicallyJoined,true);assert.equal(result.controls.length,2);assert.equal(result.controls[1].gatewayCalls,0);
 assert.deepEqual(result.observations.map(row=>row.caseId),['SAAS-04','SAAS-13','SAAS-18','SAAS-19']);
});

test('uncertain daemon create reconciles predetermined owned name then removes captured immutable ID',async()=>{
 const {createNativeAssessmentOwnership}=await import('../extension-saas-acceptance-native.mjs');
 const owner='evimed-saas-native-11111111-1111-1111-1111-111111111111',id='d'.repeat(64),name=owner+'-1';let exists=false;const removed=[];
 const missing=()=>{throw Object.assign(new Error('missing'),{stderr:'No such object'});};
 const command=async args=>{if(args[0]==='create'){exists=true;throw new Error('controlled timeout after actual daemon creation');}if(args[0]==='inspect'){if(!exists)return missing();return JSON.stringify([{Id:id,Name:'/'+name,Config:{Labels:{'io.evimed.saas-campaign':owner,'io.evimed.saas-instance':name}}}]);}if(args[0]==='rm'){removed.push(args[2]);exists=false;return'';}throw new Error('unexpected command');};
 const lifecycle=createNativeAssessmentOwnership(command,owner);await assert.rejects(lifecycle.create([]));assert.equal(lifecycle.empty(),false);await lifecycle.cleanup();assert.deepEqual(removed,[id]);assert.equal(lifecycle.empty(),true);
});
test('unknown inventory or same-name replacement is retained and cannot become cleanup confirmation',async()=>{
 const {createNativeAssessmentOwnership}=await import('../extension-saas-acceptance-native.mjs');
 const owner='evimed-saas-native-22222222-2222-2222-2222-222222222222',original='d'.repeat(64),name=owner+'-1';let removals=0;
 const command=async args=>{if(args[0]==='create')return original;if(args[0]==='inspect'){if(args[1]===original)throw Object.assign(new Error('gone'),{stderr:'No such object'});return JSON.stringify([{Id:'e'.repeat(64),Name:'/'+name,Config:{Labels:{'io.evimed.saas-campaign':owner,'io.evimed.saas-instance':name}}}]);}if(args[0]==='rm')removals++;throw new Error('unexpected command');};
 const lifecycle=createNativeAssessmentOwnership(command,owner);await lifecycle.create([]);await assert.rejects(lifecycle.cleanup(),/native_cleanup_unconfirmed/);assert.equal(removals,0);assert.equal(lifecycle.empty(),false);
 const unknown=createNativeAssessmentOwnership(async()=>{throw new Error('inventory unavailable');},owner);await assert.rejects(unknown.create([]));await assert.rejects(unknown.cleanup());assert.equal(unknown.empty(),false);
});
test('volume mutation failure remains tracked until owned physical inventory confirms removal',async()=>{
 const {createNativeAssessmentOwnership}=await import('../extension-saas-acceptance-native.mjs');
 const owner='evimed-saas-native-33333333-3333-3333-3333-333333333333',name=owner+'-enabled';let exists=false;
 const command=async args=>{if(args[1]==='create'){exists=true;throw new Error('controlled CLI failure after volume create');}if(args[1]==='inspect')return JSON.stringify([{Name:name,Labels:{'io.evimed.saas-campaign':owner}}]);if(args[1]==='rm'){exists=false;return'';}throw new Error('unexpected command');};
 const lifecycle=createNativeAssessmentOwnership(command,owner);await assert.rejects(lifecycle.volume(name));assert.equal(lifecycle.empty(),false);await lifecycle.cleanup();assert.equal(exists,false);assert.equal(lifecycle.empty(),true);
});
