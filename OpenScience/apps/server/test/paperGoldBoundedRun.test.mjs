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

test('administrative quota preserves scored checkpoints, avoids assessment and resumes with a fresh attempt',async t=>{
 const {PaperGoldAdministrativeDeferral}=await import('../../../evals/paper-gold/run.mjs');
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'gold-administrative-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const definition={replicates:2,cases:[{id:'a',type:'question',policy:{aliases:[]},rewrite:{writer:'flash',qaExecutor:'qwen',qaPassed:true,question:'Produce a report.',variants:['Produce report A.','Produce report B.','Produce report C.']},gold:{numeric:{},inputAvailable:false,benchmarkScope:'question-only',stageChecks:{}}}]};
 let quota=true,extractions=0,assessments=0,baseline=0;const attempts=[];
 const adapter={noToolBaseline:async()=>{baseline++;return {};},baselineMemorized:()=>false,dispatch:async request=>{
  attempts.push([request.replicate,request.attempt]);
  if(request.replicate===1&&quota)throw new PaperGoldAdministrativeDeferral({id:'actual-quota',status:'failed',errorCode:'runtime_spend_limit_reached'},'eval-paper-test');
  return {run:{id:`actual-${request.replicate}-${request.attempt}`}};
 },extract:async()=>{extractions++;return {numeric:{},exposureTier:'unknown'};},assess:async unit=>{assessments++;return unit;}};
 await assert.rejects(runCycle({dataDir,cycleId:'administrative',definition,adapter}),{code:'paper_gold_administrative_deferred'});
 const file=path.join(dataDir,'paper-gold/cycles/administrative/progress.json');const prior=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(prior.rows.length,1);assert.equal(extractions,1);assert.equal(assessments,1);assert.equal(prior.dispatchAttempts['a:0:1'],1);
 assert.equal(prior.administrativeStops[0].runId,'actual-quota');assert.equal(prior.administrativeStops[0].cause,'unknown');assert.ok(!('window' in prior.administrativeStops[0]));
 quota=false;const resumed=await runCycle({dataDir,cycleId:'administrative',definition,adapter,maxNewUnits:1});
 assert.deepEqual(attempts,[[0,0],[1,0],[1,1]]);assert.equal(baseline,1);assert.equal(resumed.units.length,2);assert.deepEqual(resumed.units[0],prior.rows[0]);assert.equal(resumed.complete,false);
 assert.throws(()=>new PaperGoldAdministrativeDeferral({id:'scientific',status:'failed',errorCode:'runtime_session_error'},'eval-paper-test'));
 assert.throws(()=>new PaperGoldAdministrativeDeferral({id:'active',status:'running',errorCode:'runtime_spend_limit_reached'},'eval-paper-test'));
 for(const status of [undefined,'unknown','cancelled','succeeded'])assert.throws(()=>new PaperGoldAdministrativeDeferral({id:'malformed',status,errorCode:'runtime_spend_limit_reached'},'eval-paper-test'));
 for(const id of [undefined,1,'',' '])assert.throws(()=>new PaperGoldAdministrativeDeferral({id,status:'failed',errorCode:'runtime_spend_limit_reached'},'eval-paper-test'));
 for(const projectId of [undefined,1,'',' '])assert.throws(()=>new PaperGoldAdministrativeDeferral({id:'failed',status:'failed',errorCode:'runtime_spend_limit_reached'},projectId));
});

test('administrative retry uses a fresh project policy namespace and dispatch, stable within each attempt',async()=>{
 const {paperGoldDispatchIdentity}=await import('../src/paperGoldEvaluator.mjs');
 const original=paperGoldDispatchIdentity('cycle','case',0),retry=paperGoldDispatchIdentity('cycle','case',0,1);
 assert.notEqual(original.projectId,retry.projectId);assert.notEqual(original.dispatchId,retry.dispatchId);
 assert.deepEqual(retry,paperGoldDispatchIdentity('cycle','case',0,1));assert.deepEqual(original,paperGoldDispatchIdentity('cycle','case',0,0));
 assert.throws(()=>paperGoldDispatchIdentity('cycle','case',0,-1));
});

test('ordinary scientific terminal failure is assessed once and is not an administrative retry',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'gold-scientific-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const definition={replicates:2,cases:[{id:'a',type:'question',policy:{aliases:[]},rewrite:{writer:'flash',qaExecutor:'qwen',qaPassed:true,question:'Produce a report.',variants:['Produce report A.','Produce report B.','Produce report C.']},gold:{numeric:{},inputAvailable:false,benchmarkScope:'question-only',stageChecks:{}}}]};
 let assessed=0;const calls=[];
 const adapter={noToolBaseline:async()=>({}),baselineMemorized:()=>false,dispatch:async x=>{calls.push([x.replicate,x.attempt]);return {run:{id:`failed-${x.replicate}`,status:'failed',errorCode:'runtime_session_error'}};},extract:async()=>({numeric:{},exposureTier:'unknown',gaps:['model_capability']}),assess:async unit=>{assessed++;return unit;}};
 const first=await runCycle({dataDir,cycleId:'scientific',definition,adapter,maxNewUnits:1});assert.equal(first.units.length,1);assert.equal(first.units[0].fullResearchReproductionValid,false);
 await runCycle({dataDir,cycleId:'scientific',definition,adapter,maxNewUnits:1});assert.deepEqual(calls,[[0,0],[1,0]]);assert.equal(assessed,2);
 const progress=JSON.parse(await fs.readFile(path.join(dataDir,'paper-gold/cycles/scientific/progress.json'),'utf8'));assert.deepEqual(progress.administrativeStops,[]);assert.deepEqual(progress.dispatchAttempts,{});
});
