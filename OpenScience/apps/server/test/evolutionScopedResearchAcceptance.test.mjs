import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateScopedReference,prepareScopedResearch,closeScopedApp} from '../../../scripts/ops/evolution-scoped-research-acceptance.mjs';
import {scoreUnit} from '../../../evals/paper-gold/evaluator.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const sourceHash=sha('Synthetic test study input');
 const proof={publicationId:'10.1234/synthetic-test',sourceHash,numericComparisonPassed:true,input:{tauEstimator:'DL',studies:Array.from({length:37},()=>({yi:0,vi:1}))},fullResearchReproductionValid:false,actualReplicates:[{point:0},{point:0}],numeric:{point:{value:0,absoluteTolerance:0}},independentReference:{implementationId:'independent-test-mean',sourceHash,numeric:{point:0}}};
 const bytes=Buffer.from(JSON.stringify(proof)),author='Synthetic fixture author documentation.';
 const manifest={id:'synthetic-test',proofHash:sha(bytes),authorDocumentHash:sha(author),dataHash:proof.sourceHash,publicationId:proof.publicationId};
 return {manifest,proof,bytes,author};
}
test('scoped receipt refuses mutation and failed independent replicate without treating numeric checks as semantic QA',()=>{
 const f=fixture();assert.equal(validateScopedReference(f).numericComparisonPassed,true);
 assert.throws(()=>validateScopedReference({...f,author:f.author+' altered'}),/integrity/);
 const changed={...f.proof,actualReplicates:[{point:0},{point:1}]};const bytes=Buffer.from(JSON.stringify(changed));
 assert.throws(()=>validateScopedReference({...f,bytes,manifest:{...f.manifest,proofHash:sha(bytes)}}),/numeric comparison/);
});
test('fresh independent semantic admission is resumable and positive scoped score cannot become whole research',async t=>{
 const evaluationDataDir=await fs.mkdtemp(path.join(os.tmpdir(),'scoped-gold-'));t.after(()=>fs.rm(evaluationDataDir,{recursive:true,force:true}));
 const f=fixture();let calls=0;const app={config:{reviewProvider:'dashscope',reviewModel:'qwen-test'},usageLedger:{},store:{userById:async()=>({id:'operator'}),projectFor:async()=>({})},evolution:{service:{owner:async()=>'operator',withLock:async(_key,op)=>op()}}};
 const args={app,evaluationDataDir,loadReference:async()=>f,review:async()=>{calls++;return {value:{passed:true,issues:[]},model:'qwen-test',modelReported:true};}};
 const historical=path.join(evaluationDataDir,'paper-gold/cycles/acceptance-scoped-research-meta-v6/definition.json');await fs.mkdir(path.dirname(historical),{recursive:true});await fs.writeFile(historical,'immutable historical v6 bytes');
 const prepared=await prepareScopedResearch(args);assert.equal(prepared.cycleId,'acceptance-scoped-research-meta-v7');assert.equal(await fs.readFile(historical,'utf8'),'immutable historical v6 bytes');assert.equal(prepared.admitted,true);assert.equal(prepared.fullResearchEligible,false);
 const frozen=JSON.parse(await fs.readFile(path.join(evaluationDataDir,'paper-gold/cycles',prepared.cycleId,'definition.json'),'utf8'));
 const c=frozen.definition.cases[0];assert.equal(c.gold.deterministicVerification.entrypoint,'deliverables/paper-gold-analysis/analysis.py:analyze');assert.match(c.input,/producer receipt/);assert.match(c.input,/callable analysis.py itself/);assert.equal(c.rewrite.variants.length,3);assert.equal(frozen.definition.replicates,2);
 const unit={numeric:{point:0},exposureTier:'unexposed',checks:{question_aligned:true,method_supported:true,certainty_supported:true,writing_sources_bound:true}},gold={...c.gold,type:'research'};
 const missingProof=await scoreUnit(unit,gold);assert.equal(missingProof.applicableStagesValid,false);assert.equal(missingProof.fullResearchReproductionValid,false);
 let verifications=0;
 const score=await scoreUnit(unit,gold,{verifyCode:async()=>{verifications++;return {verified:true,proof:{kind:'isolated-independent-replay',replicates:2,sourceHash:gold.sourceHash,proofHash:'a'.repeat(64)}};}});
 assert.equal(verifications,1);
 assert.equal(score.applicableStagesValid,true);assert.equal(score.fullResearchReproductionValid,false);assert.equal(score.stages.recall.observed,false);assert.equal(score.stages.extraction.observed,false);
 const resumed=await prepareScopedResearch(args);assert.equal(resumed.resumed,true);assert.equal(calls,1);
});
test('failed independent semantic QA remains rejected and is never retried or promoted on numeric proof alone',async t=>{
 const evaluationDataDir=await fs.mkdtemp(path.join(os.tmpdir(),'scoped-rejected-'));t.after(()=>fs.rm(evaluationDataDir,{recursive:true,force:true}));
 const f=fixture();let calls=0;const app={config:{reviewProvider:'dashscope'},store:{userById:async()=>({id:'operator'}),projectFor:async()=>({})},evolution:{service:{owner:async()=>'operator',withLock:async(_key,op)=>op()}}};
 const args={app,evaluationDataDir,loadReference:async()=>f,review:async()=>{calls++;return {value:{passed:false,issues:['unsupported scope']},model:'qwen-test',modelReported:true};}};
 assert.equal((await prepareScopedResearch(args)).admitted,false);assert.equal((await prepareScopedResearch(args)).admitted,false);assert.equal(calls,1);
 await assert.rejects(fs.readFile(path.join(evaluationDataDir,'paper-gold/cycles/acceptance-scoped-research-meta-v7/definition.json')),/ENOENT/);
});

test('detached semantic preparation closes its store after an unstarted HTTP listener',async()=>{
 let closed=0;await closeScopedApp({close:async()=>{throw Object.assign(new Error('not listening'),{code:'ERR_SERVER_NOT_RUNNING'});},store:{close:async()=>{closed++;}}});assert.equal(closed,1);
 await assert.rejects(closeScopedApp({close:async()=>{throw Object.assign(new Error('database failure'),{code:'DB_ERROR'});}}),/database failure/);
});
