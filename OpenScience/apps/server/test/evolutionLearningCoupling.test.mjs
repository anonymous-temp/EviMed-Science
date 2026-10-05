import { relevantPlatformTools } from '../src/methodConsolidation.mjs';
import { handbookMissingComputation } from '../src/methodObservations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvolutionLearningCoupling } from '../src/evolutionLearningCoupling.mjs';
import { publishEvaluationGaps } from '../src/evolutionEvaluationGaps.mjs';
test('only repeated actually used handbook missing-computation observations create a private durable gap; publication links exact public pins',async()=>{
  const book={user_id:'researcher',id:'book',revision:3,payload:{capabilityId:'statistics',contentDigest:'immutable-body',body:'private text',observations:[{runId:'a',used:true,gapCodes:['method-missing']},{runId:'a',used:true,gapCodes:['method-missing']},{runId:'b',used:false,gapCodes:['method-missing']}]}};
  const events=[],writes=[];
  const service={ingestEvent:async event=>events.push(event),tools:async()=>[{id:'visible',payload:{status:'active',validationLevel:'V2',capabilityIds:['statistics'],revision:1,artifactDigest:'pin'}},{id:'wrong-capability',payload:{status:'active',validationLevel:'V2',capabilityIds:['other']}},{id:'hidden',payload:{status:'staged',validationLevel:'V2',capabilityIds:['statistics']}}]};
  const coupling=createEvolutionLearningCoupling({service,database:{query:async()=>({rows:[book]})},documents:{put:async(...args)=>writes.push(args)}});
  await coupling.scan();assert.equal(events.length,0);
  book.payload.observations.push({runId:'c',used:true,gapCodes:['method-missing']});
  await coupling.scan();await coupling.scan();assert.equal(events[0].id,events[1].id);assert.equal(events[0].userId,'researcher');assert.equal(JSON.stringify(events).includes('private text'),false);
  assert.equal(writes[0][3].contentDigest,'immutable-body');assert.equal(writes[0][3].body,'private text');assert.deepEqual(writes[0][3].platformToolReferences.map(row=>row.toolId),['visible']);assert.equal(writes[0][4].expectedRevision,3);
});
test('only independently replayed adjudication emits an opaque opportunity event; model assertions and raw gold never do',async()=>{
  const events=[],review={verdict:'paper_error',codeVerified:false,reviewerFamily:'qwen',evidenceIds:['public-source'],verificationProof:{proofHash:'a'.repeat(64)}};
  const evaluation={id:'eval',payload:{units:[{track:'E',allStagesValid:true,disagreement:review,gold:'secret gold',numeric:{estimate:21}}]}};
  const service={ingestEvent:async event=>events.push(event)};
  await publishEvaluationGaps(service,evaluation);assert.equal(events.length,0);
  review.codeVerified=true;await publishEvaluationGaps(service,evaluation);await publishEvaluationGaps(service,evaluation);
  assert.equal(events[0].type,'evaluation-adjudication');assert.equal(events[0].id,events[1].id);assert.equal(JSON.stringify(events).includes('secret'),false);assert.equal(JSON.stringify(events).includes('21'),false);
});

test('native MCP and socket tool-result envelopes yield only closed actual missing-computation errors',()=>{
  assert.equal(handbookMissingComputation({type:'tool',status:'completed',output:{isError:true,content:[{type:'text',text:JSON.stringify({error:{code:'tool_not_found',message:'private'}})}]}}),true);
  assert.equal(handbookMissingComputation({type:'tool',status:'completed',output:JSON.stringify({result:{error:{code:'method_missing'}}})}),true);
  assert.equal(handbookMissingComputation({type:'tool',status:'failed',error:{code:'command_not_found'}}),true);
  assert.equal(handbookMissingComputation({type:'text',status:'completed',output:'tool_not_found'}),false);
  assert.equal(handbookMissingComputation({type:'tool',status:'completed',output:{ok:false,message:'tool_not_found'}}),false);
  assert.equal(handbookMissingComputation({type:'tool',status:'completed',output:{error:{code:'invalid_input'}}}),false);
});

test('existing method-relations context is relevant, bounded and omits large source/data payloads explicitly',()=>{
  const tools=Array.from({length:35},(_,i)=>({id:`tool-${i}`,capabilityIds:['statistics'],digest:'pin',description:'Public description',papers:['secret-large'],dataRequirements:{rows:'private'}}));
  tools.push({id:'other',capabilityIds:['other'],description:'Unrelated'});
  const result=relevantPlatformTools(tools,[{payload:{capabilityId:'statistics'}}]);
  assert.equal(result.items.length,30);assert.equal(result.omitted,5);assert.equal(result.irrelevant,1);
  assert.equal(JSON.stringify(result).includes('secret-large'),false);assert.equal(JSON.stringify(result).includes('private'),false);
});
