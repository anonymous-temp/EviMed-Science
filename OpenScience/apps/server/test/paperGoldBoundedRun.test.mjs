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
 const definition={replicates:2,cases:[{id:'private-paper',type:'research',policy:{aliases:['private-id']},rewrite:{writer:'flash',qaExecutor:'qwen',qaPassed:true,question:'Estimate a population association.',variants:['Estimate association A.','Estimate association B.','Estimate association C.']},gold}]};
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

test('an administrative refusal is retried a bounded number of times; the unit is then recorded unscored and the cycle moves on',async t=>{
 const {PaperGoldAdministrativeDeferral,PAPER_GOLD_ADMINISTRATIVE_ATTEMPTS,platformDispatch}=await import('../../../evals/paper-gold/run.mjs');
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'gold-retry-bound-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const definition={replicates:2,cases:[{id:'a',type:'question',policy:{aliases:[]},rewrite:{writer:'flash',qaExecutor:'qwen',qaPassed:true,question:'Produce a report.',variants:['Produce report A.','Produce report B.','Produce report C.']},gold:{numeric:{},inputAvailable:false,benchmarkScope:'question-only',stageChecks:{}}}]};
 const refused=[];let dispatched=0;
 const adapter={noToolBaseline:async()=>({}),baselineMemorized:()=>false,dispatch:async request=>{
  if(request.replicate===1){refused.push(request.attempt);throw new PaperGoldAdministrativeDeferral({id:`quota-${request.attempt}`,status:'failed',errorCode:'runtime_spend_limit_reached'},`eval-paper-attempt-${request.attempt}`);}
  dispatched++;return {run:{id:`actual-${request.replicate}`}};
 },extract:async()=>({numeric:{},exposureTier:'unknown'})};
 // Every resumption used to dispatch the refused unit again, in a fresh project, for as long as it was asked to.
 for(let round=0;round<PAPER_GOLD_ADMINISTRATIVE_ATTEMPTS;round++)await assert.rejects(runCycle({dataDir,cycleId:'bounded-retry',definition,adapter}),{code:'paper_gold_administrative_deferred'});
 assert.deepEqual(refused,Array.from({length:PAPER_GOLD_ADMINISTRATIVE_ATTEMPTS},(_,attempt)=>attempt));
 const report=await runCycle({dataDir,cycleId:'bounded-retry',definition,adapter});
 assert.equal(refused.length,PAPER_GOLD_ADMINISTRATIVE_ATTEMPTS,'the unit is not dispatched again once its attempts are spent');
 assert.equal(dispatched,5);assert.equal(report.units.length,5);
 assert.deepEqual(report.unscored.map(({caseId,variant,replicate,reason,attempts})=>({caseId,variant,replicate,reason,attempts})),[{caseId:'a',variant:0,replicate:1,reason:'administrative_retry_limit',attempts:PAPER_GOLD_ADMINISTRATIVE_ATTEMPTS}]);
 // Unscored is not scored: the cycle is settled (nothing more will be dispatched) and it is not complete.
 assert.equal(report.complete,false);assert.equal(report.settled,true);assert.deepEqual(report.cases,[]);
 const again=await runCycle({dataDir,cycleId:'bounded-retry',definition,adapter});assert.equal(refused.length,PAPER_GOLD_ADMINISTRATIVE_ATTEMPTS);assert.equal(again.unscored.length,1);
 await assert.rejects(platformDispatch({base:'http://unused.invalid',headers:{},caseRecord:{id:'a'},replicate:0,cycleId:'c',attempt:PAPER_GOLD_ADMINISTRATIVE_ATTEMPTS}),/administrative dispatch attempt/);
});

test('each unit records the purpose the server\'s own rule gives its run, and the report says what the evolution budget did not hold',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'gold-spend-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const definition={replicates:2,cases:[{id:'a',type:'question',policy:{aliases:[]},rewrite:{writer:'flash',qaExecutor:'qwen',qaPassed:true,question:'Produce a report.',variants:['Produce report A.','Produce report B.','Produce report C.']},gold:{numeric:{},inputAvailable:false,benchmarkScope:'question-only',stageChecks:{}}}]};
 // The in-process dispatcher stamps the platform's route reason; the public dispatch route computes its own and never takes one from a caller.
 const adapter={noToolBaseline:async()=>({}),baselineMemorized:()=>false,extract:async()=>({numeric:{},exposureTier:'unknown'}),
  dispatch:async request=>({run:request.replicate<4?{id:`in-process-${request.replicate}`,effectiveAgentId:'meta-analysis',effectiveRouteReason:'platform-evolution'}:{id:`public-${request.replicate}`,effectiveAgentId:'meta-analysis',effectiveRouteReason:'choice:meta-analysis',automated:true}})};
 const report=await runCycle({dataDir,cycleId:'spend',definition,adapter});
 assert.deepEqual(report.units.map(unit=>unit.spendPurpose),['evolution','evolution','evolution','evolution','kernel','kernel']);
 assert.deepEqual(report.spend,{byPurpose:{evolution:4,kernel:2},outsideEvolutionBudget:2});
});

test('the memorisation baseline is not asked of a method case, and one recalled number is enough to flag a paper',async t=>{
 const {paperGoldBaselineMemorized:rule}=await import('../src/paperGoldEvaluator.mjs');
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'gold-baseline-scope-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const rewrite={writer:'flash',qaExecutor:'qwen',qaPassed:true,question:'Apply the method to the supplied inputs.',variants:['Apply the method A.','Apply the method B.','Apply the method C.']};
 // A method case hands the run its inputs: asking a model to guess its answer without them could never match and was recorded as "not memorised".
 const definition={replicates:2,cases:[{id:'method-case',type:'method',policy:{aliases:[]},rewrite,gold:{numeric:{effect:{value:2,absoluteTolerance:0}},stageChecks:{method:['method']}}}]};
 let asked=0;
 const report=await runCycle({dataDir,cycleId:'method-baseline',definition,adapter:{noToolBaseline:async()=>{asked++;return {numeric:{effect:2}};},baselineMemorized:()=>true,dispatch:async request=>({run:{id:`run-${request.replicate}`}}),extract:async()=>({numeric:{effect:2},checks:{method:true}})}});
 assert.equal(asked,0);assert.equal(report.units.length,6);
 const progress=JSON.parse(await fs.readFile(path.join(dataDir,'paper-gold/cycles/method-baseline/progress.json'),'utf8'));
 assert.deepEqual({memorized:progress.baselines['method-case'].memorized,applicable:progress.baselines['method-case'].applicable,reason:progress.baselines['method-case'].reason},{memorized:null,applicable:false,reason:'inputs_disclosed_method_case'});
 // The production rule: the model is told to omit what it is unsure of, so "every field matches" almost never fired.
 const gold={baselineNumeric:{'analysis.hr':{value:0.72,printed:'0.72',absoluteTolerance:0.005},'analysis.lower':{value:0.61,printed:'0.61',absoluteTolerance:0.005},'analysis.upper':{value:0.85,printed:'0.85',absoluteTolerance:0.005}}};
 assert.equal(rule({numeric:{'analysis.hr':0.72}},gold),true,'the primary estimate recalled alone');
 assert.equal(rule({numeric:{'analysis.hr':0.9,'analysis.upper':0.3}},gold),false);assert.equal(rule({numeric:{}},gold),false);assert.equal(rule({},{numeric:{}}),false);
});
