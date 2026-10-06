import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvolutionResourceAcquisition} from '../src/evolutionResourceAcquisition.mjs';
test('tool acquisition requires evaluator references and measured persisted eligibility',async()=>{
 let eligible=false,scouts=0;
 const service={get:async()=>({id:'dossier',payload:{eligibility:{eligible},prerequisites:eligible?[]:['independent-reference-inputs']}})};
 const acquire=createEvolutionResourceAcquisition({service,scout:{scout:async()=>{scouts++;eligible=true;}},candidateEvaluator:{prepareCases:async()=>({ok:false,resourceCode:'missing_numeric_truth'})},loops:{}});
 const result=await acquire({id:'mission',moduleId:'tools',opportunityId:'dossier'});
 assert.equal(scouts,1);assert.equal(result.ready,false);assert.equal(result.reason,'missing_numeric_truth');
});
test('development smoke cannot clear unknown or confirmation prerequisites',async()=>{
 const observed=[];
 const service={get:async()=>({id:'dossier',payload:{prerequisites:['fresh-confirmation-tasks','missing-numeric-truth']}}),list:async()=>[]};
 const acquire=createEvolutionResourceAcquisition({service,scout:{},candidateEvaluator:{},loops:{prepareModuleTasks:async input=>{observed.push(input.phase);return {status:'ready'};},missions:{opportunity:async()=>assert.fail('No evidence allows clearing prerequisites.')}}});
 const result=await acquire({id:'mission',moduleId:'geo',opportunityId:'dossier'});
 assert.equal(result.ready,false);assert.deepEqual(result.remainingPrerequisites,['fresh-confirmation-tasks','missing-numeric-truth']);assert.deepEqual(observed,['development']);assert.ok(result.sourceRequestIds.includes('arxiv-agent-self-improvement'));
});
