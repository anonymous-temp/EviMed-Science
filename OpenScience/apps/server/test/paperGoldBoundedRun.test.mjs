import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runCycle} from '../../../evals/paper-gold/run.mjs';
test('one-unit pilot preserves six-unit freeze and resumes without repeating dispatch or baseline',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'gold-bounded-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const definition={replicates:2,cases:[{id:'a',type:'question',policy:{aliases:[]},rewrite:{writer:'flash',qaExecutor:'qwen',qaPassed:true,question:'Produce a report.',variants:['Produce report A.','Produce report B.','Produce report C.']},gold:{numeric:{},inputAvailable:false,benchmarkScope:'question-only',stageChecks:{}}}]};
 let calls=0,baselines=0;
 const adapter={noToolBaseline:async()=>{baselines++;return {};},baselineMemorized:()=>false,dispatch:async()=>({run:{id:`actual-${++calls}`}}),extract:async()=>({numeric:{},exposureTier:'unknown',stages:{}})};
 const first=await runCycle({dataDir,cycleId:'bounded-fixture',definition,adapter,maxNewUnits:1});
 assert.equal(first.complete,false);assert.equal(first.units.length,1);assert.equal(first.plannedUnits,6);assert.deepEqual(first.cases,[]);
 const checkpoint=path.join(dataDir,'paper-gold/cycles/bounded-fixture/progress.json');
 const historical=JSON.parse(await fs.readFile(checkpoint,'utf8'));historical.baselines.a=false;await fs.writeFile(checkpoint,JSON.stringify(historical));
 const resumed=await runCycle({dataDir,cycleId:'bounded-fixture',definition,adapter});
 assert.equal(resumed.complete,true);assert.equal(resumed.units.length,6);assert.equal(calls,6);assert.equal(baselines,1);assert.equal(resumed.evaluatorHash,first.evaluatorHash);assert.equal(resumed.units[0].fullResearchReproductionValid,false);
});

test('memorization baseline receives only declared outcome names and preserves the actual answer proof in control checkpoint',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'gold-baseline-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const gold={numeric:{'analysis.effect':{value:987.654321,absoluteTolerance:0,quote:'hidden-primary-quote'}}};
 const definition={replicates:2,cases:[{id:'private-paper',type:'method',policy:{aliases:['private-id']},rewrite:{writer:'flash',qaExecutor:'qwen',qaPassed:true,question:'Estimate a population association.',variants:['Estimate association A.','Estimate association B.','Estimate association C.']},gold}]};
 let seen;
 const answer={numeric:{'analysis.effect':987.654321},baselineReceipt:{model:'observed-test-model',providerRequestId:'observed-request'}};
 const report=await runCycle({dataDir,cycleId:'baseline-fixture',definition,adapter:{noToolBaseline:async request=>{seen=request;return answer;},baselineMemorized:(result,reference)=>result.numeric['analysis.effect']===reference.numeric['analysis.effect'].value,dispatch:async()=>{throw new Error('Memorized paper must never dispatch');}}});
 assert.deepEqual(seen,{prompt:'Estimate a population association.',numericFields:['analysis.effect'],tools:[],toolChoice:'none'});
 assert.equal(JSON.stringify(seen).includes('987.654321'),false);assert.equal(JSON.stringify(seen).includes('private-id'),false);assert.equal(JSON.stringify(seen).includes('hidden-primary-quote'),false);
 assert.equal(report.excluded[0].excluded,'possible_memorization');assert.equal(report.units.length,0);
 const progress=JSON.parse(await fs.readFile(path.join(dataDir,'paper-gold/cycles/baseline-fixture/progress.json'),'utf8'));
 assert.deepEqual(progress.baselines['private-paper'].answer,answer);assert.match(progress.baselines['private-paper'].answerHash,/^[a-f0-9]{64}$/);assert.equal(progress.baselines['private-paper'].memorized,true);
});
