import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBenchmarkDefinition } from './benchmarks.mjs';
test('question ruler remains executable while missing research inputs and method gaps remain explicit',()=>{
 const d=deriveBenchmarkDefinition({cases:[{id:'paper',type:'research',rewrite:{question:'Question'},gold:{inputAvailable:false}}]});
 assert.deepEqual(d.cases.map(x=>x.type),['question','research']);
 assert.equal(d.benchmarkGaps.length,2);
 assert.equal(d.cases[0].gold.inputAvailable,false);
});
test('method ruler discloses only published inputs and keeps independently checked gold out of prompt',()=>{
 const d=deriveBenchmarkDefinition({cases:[]},[{methodId:'method',frozen:true,cases:[{id:'paper',kind:'published',publicationId:'10.1234/a',sourceHash:'a'.repeat(64),input:{n:30},numeric:{estimate:{value:9876}},independentQa:{passed:true},independentImplementation:{implementationId:'R',numeric:{estimate:9876}}}]}]);
 assert.equal(d.cases[0].type,'method');assert.equal(d.cases[0].track,'M');
 assert.match(d.cases[0].input,/30/);assert.doesNotMatch(d.cases[0].input,/9876/);
 assert.equal(d.cases[0].gold.numeric.estimate.value,9876);
});

test('missing-input research ruler scores a real refusal scope separately from full research',async()=>{
 const {scoreUnit}=await import('./evaluator.mjs');
 const d=deriveBenchmarkDefinition({cases:[{id:'paper',type:'question',rewrite:{question:'Commission a research report'},gold:{inputAvailable:false,benchmarkScope:'question-only',numeric:{},applicableStages:['question','method','certainty','writing'],stageChecks:{question:['q'],method:['m'],certainty:['c'],writing:['w']}}}]});
 const research=d.cases.find(row=>row.type==='research');assert.ok(research);assert.equal(research.gold.benchmarkScope,'research-input-unavailable');
 const score=await scoreUnit({id:research.id,checks:{q:true,m:true,c:true,w:true},exposureTier:'unexposed'},{...research.gold,type:research.type});
 assert.equal(score.applicableStagesValid,true);assert.equal(score.allStagesValid,false);assert.equal(score.fullResearchReproductionValid,false);
 for(const stage of ['recall','extraction','calculation'])assert.equal(score.stages[stage].observed,false);
});
