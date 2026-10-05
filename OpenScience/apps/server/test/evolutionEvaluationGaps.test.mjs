import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationGapClusters, saveEvolutionEvaluation } from '../src/evolutionEvaluationGaps.mjs';
test('closed gaps cluster by public capability and track without exposing gold or arbitrary prose',()=>{
  const units=[{track:'P',capabilityId:'mendelian-randomization',gaps:['method_missing',null,'private-answer','implementation'],gold:'secret',numeric:{answer:21}}, {track:'P',capabilityId:'mendelian-randomization',gaps:['method_missing']}, {track:'E',unsupported:true}, {track:'E',exposureTier:'unknown',gaps:['connector']}, {track:'E',benchmarkScope:'missing-input-response',allStagesValid:false}];
  const result=evaluationGapClusters({units});
  assert.equal(result.length,3);assert.equal(result.find(row=>row.gapCode==='method-missing'&&row.track==='P').count,2);
  assert.equal(JSON.stringify(result).includes('secret'),false);assert.equal(JSON.stringify(result).includes('21'),false);
  assert.ok(result.every(row=>Object.keys(row).sort().join() === ['track','gapCode','methodId','capabilityId','count'].sort().join()));
});
test('actual numeric and observed stage failures produce actionable closed gaps while null observations do not',()=>{
  const result=evaluationGapClusters({units:[{track:'E',numeric:{rr:{valid:false}}},{track:'M',allStagesValid:false,stages:{writing:{observed:true,valid:false}}},{track:'U',allStagesValid:false,stages:{method:{observed:false,valid:false}}}]});
  assert.deepEqual(result.map(row=>row.gapCode),['method-implementation','writing']);
});
test('persist then publish retries the same event identity after interruption',async()=>{
  const events=new Map();let fail=true;const row={id:'evaluation',payload:{units:[{track:'P',gaps:['method_missing']}]}};
  const service={save:async()=>row,ingestEvent:async event=>{if(fail){fail=false;throw new Error('interrupted');}events.set(event.id,event);}};
  await assert.rejects(saveEvolutionEvaluation(service,row.id,row.payload),/interrupted/);
  await saveEvolutionEvaluation(service,row.id,row.payload);await saveEvolutionEvaluation(service,row.id,row.payload);
  assert.equal(events.size,1);assert.equal([...events.values()][0].type,'evaluation-gap');
});
