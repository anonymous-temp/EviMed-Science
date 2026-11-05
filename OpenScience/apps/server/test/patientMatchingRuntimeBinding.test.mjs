import assert from 'node:assert/strict';
import {test} from 'node:test';
import {patientMatchingDispatchDescriptor,patientMatchingContinuationOptions} from '../src/patientMatchingRuntimeBinding.mjs';
test('cold continuation admits only its verified selected generation and checks the actual worker before boot',async()=>{
 let inspected=0,proof=0;
 const lifecycle={selectForRuntime:async()=>({reference:{generationHash:'selected'}}),resolveTool:async()=>{proof++;return {generation:'live'};}};
 const runtime={runtimeGeneration:()=>null,inspectPatientMatchingWorker:async()=>{inspected++;}};
 const ready=await patientMatchingDispatchDescriptor({lifecycle,runtime,project:{}});assert.equal(ready.generation,'selected');assert.equal(inspected,1);assert.equal(proof,0);
 runtime.runtimeGeneration=()=> 'boot';assert.equal((await patientMatchingDispatchDescriptor({lifecycle,runtime,project:{}})).generation,'live');assert.equal(proof,1);
});
test('page-origin continuation uses its original conversation without inventing an origin run',()=>{
 const options=patientMatchingContinuationOptions({runs:[],conversation:{agentId:'vcr-matching'},sessionId:'root',originRunId:null,text:'Resume task'});assert.equal(options.continuationRoute.effectiveAgentId,'vcr-matching');
 const latest=patientMatchingContinuationOptions({runs:[{id:'new',sessionId:'root',question:'new'},{id:'old',sessionId:'root',question:'old'}],conversation:{},sessionId:'root',text:'Resume'});assert.equal(latest.originalQuestion,'new');
 assert.throws(()=>patientMatchingContinuationOptions({runs:[{id:'foreign',sessionId:'other'}],conversation:{},sessionId:'root',originRunId:'foreign',text:'Resume'}),{code:'patient_matching_origin_unavailable'});
});
