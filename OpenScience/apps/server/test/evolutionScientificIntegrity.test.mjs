import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evolutionServiceFixture} from './helpers/evolutionServiceFixture.mjs';
import {EvolutionMaintenance} from '../src/evolutionMaintenance.mjs';
import {evolutionScientificUse} from '../src/evolutionScientificUse.mjs';
test('managed module research counts as real use and no-harm alone cannot promote V4',async()=>{
 for(const route of ['geo:content','vcr:analysis','autopilot:research'])assert.equal(evolutionScientificUse('research',{automated:true,effectiveRouteReason:route}).researcherOwned,true);
 const f=evolutionServiceFixture(),maintenance=new EvolutionMaintenance({service:f.service});
 const tool=await f.service.registerTool({id:'tool',track:'M',artifactDigest:'digest',holdoutCases:[]});
 await f.service.save('tool','tool',{...tool.payload,validationLevel:'V3'},tool);
 for(let i=0;i<8;i++)await maintenance.observe('tool',{runId:`run-${i}`,userId:`account-${i}`,callId:`call-${i}`,invoked:true,outcome:'accepted'});
 assert.equal((await f.service.get('tool')).payload.validationLevel,'V3');
 await maintenance.observe('tool',{runId:'run-0',userId:'account-0',invoked:true,outcome:'accepted',positiveEvidence:{verified:true,kind:'verified-uncorrected-result'}});
 assert.equal((await f.service.get('tool')).payload.validationLevel,'V4');
 assert.equal((await f.service.get('tool')).payload.usage.attributablePositiveResults,1);
 await maintenance.observe('tool',{runId:'run-0',userId:'account-0',invoked:true,outcome:'accepted',positiveEvidence:{verified:true,kind:'verified-uncorrected-result'}});
 assert.equal((await f.service.get('tool')).payload.usage.attributablePositiveResults,1);
});
test('two revision alarms label the lineage and open review without stopping it',async()=>{
 const f=evolutionServiceFixture(),proposals=[],maintenance=new EvolutionMaintenance({service:f.service,callbacks:{proposeReview:async input=>proposals.push(input)}});
 for(const id of ['root','child']){
  const tool=await f.service.registerTool({id,track:'M',artifactDigest:`digest-${id}`,lineage:{rootId:'root',parents:id==='root'?[]:['root']},holdoutCases:[]});
  const current=await f.service.save('tool',id,{...tool.payload,usage:{...tool.payload.usage,harm:{state:'harm',reviewId:`review-${id}`}}},tool);
  await maintenance.reviewLineageAlerts(current);
 }
 assert.equal(proposals.length,1);assert.equal(proposals[0].category,'lineage-harm');
 for(const id of ['root','child']){const row=await f.service.get(id);assert.equal(row.payload.status,'active');assert.ok(row.payload.labels.includes('two-recent-alarms'));}
});
