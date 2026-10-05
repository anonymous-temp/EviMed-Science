import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyPaperGoldCode} from '../src/paperGoldVerification.mjs';
import {digest} from '../../../evals/paper-gold/evaluator.mjs';
import {validateScopedQaReuse,prepareScopedResearch} from '../../../scripts/ops/evolution-scoped-research-acceptance.mjs';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateAlignedProposal,prepareAlignedFaers,alignedVerificationDescriptor} from '../../../scripts/ops/evolution-aligned-faers-acceptance.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(index=0){
 const source=Buffer.from(`synthetic source ${index}`),sourceHash=sha(source),x={a:12,b:88,c:6,d:94},ror=x.a*x.d/(x.b*x.c),se=Math.sqrt(1/x.a+1/x.b+1/x.c+1/x.d),numeric={ROR:ror,lower:Math.exp(Math.log(ror)-1.96*se),upper:Math.exp(Math.log(ror)+1.96*se)};
 const variants=['Analyze this reporting comparison.','Evaluate the specified reporting association.','Prepare the requested reporting analysis.'];
 const record={id:`fixture-${index}`,publicationId:`10.1000/fixture${index}`,methodCaseId:`method-${index}`,sourceHash,title:'Synthetic test only',sourceBond:{tableId:'fixture-table'},source:{pmcid:'PMC123'},input:{counts:x,adjustedCounts:x,continuityCorrection:0,cellDefinitions:{},method:'ROR'},numericGold:Object.fromEntries(Object.entries(numeric).map(([key,value])=>[key,{value,absoluteTolerance:1e-8}])),existingNumericQa:{passed:true,executor:'synthetic-reference'},independentNumericReference:{implementationId:'synthetic-R',numeric},independentSemanticQa:{status:'not_executed'},fullResearchReproductionValid:false,questionVariants:variants,proposedVariants:variants.map(v=>v+' Supplied counts only.')};
 return {record,descriptor:{publicationId:record.publicationId,methodCaseId:record.methodCaseId,sourceHash},source,context:''};
}
test('published aggregate validation rejects changed bytes, correction and numeric sign',()=>{
 const f=fixture();assert.equal(validateAlignedProposal(f.record,f.descriptor,f.source),true);
 assert.throws(()=>validateAlignedProposal(f.record,f.descriptor,Buffer.from('changed')),/identity/);
 const correction=structuredClone(f.record);correction.input.continuityCorrection=.5;assert.throws(()=>validateAlignedProposal(correction,f.descriptor,f.source),/aggregate/);
 const wrong=structuredClone(f.record);wrong.numericGold.ROR.value*=-1;assert.throws(()=>validateAlignedProposal(wrong,f.descriptor,f.source),/numeric/);
});
test('fresh independent QA caches pass and failure without repeat payment; dispatch inputs contain no expected numeric gold',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aligned-faers-'));let calls=0;
 const records=Array.from({length:5},(_,i)=>fixture(i));const load=async()=>({manifest:{cases:records.map(f=>f.descriptor),methodReportHash:'fixture-report'},records});
 const app={config:{reviewProvider:'bailian',reviewModel:'qwen-plus',evolutionDailyBudgetCny:50},evolution:{service:{withLock:async(_key,fn)=>fn(),owner:async()=>'owner'}},store:{userById:async()=>({id:'owner'}),projectFor:async()=>({})}};
 const review=async()=>{calls++;return {value:{passed:calls!==5,issues:calls===5?['invalid comparator']:[]},model:'qwen-plus',modelReported:true};};
 try{
  const options={app,evaluationDataDir:directory,load,review};const first=await prepareAlignedFaers(options);assert.equal(calls,5);assert.equal(first.admittedPublications,4);assert.equal(first.missing,1);
  const second=await prepareAlignedFaers(options);assert.equal(second.resumed,true);assert.equal(calls,5);
  const saved=JSON.parse(await fs.readFile(path.join(directory,'paper-gold/cycles/acceptance-aligned-faers-v6/definition.json'),'utf8'));
  assert.equal(saved.definition.replicates,2);assert.equal(saved.definition.cases.length,8);
  for(const c of saved.definition.cases){assert.equal(c.rewrite.variants.length,3);assert.equal(c.capabilityId,c.type==='research'?'statistical-analysis':'adr-analysis');assert.equal(c.gold.benchmarkScope.includes('full-research'),c.type==='research');assert.ok(!c.input.includes('numericGold'));assert.ok(!c.input.includes(String(c.gold.numeric.lower.value)));if(c.type==='question')assert.ok(!c.input.includes('Supplied counts'));else assert.ok(c.input.includes('Supplied counts'));}
  assert.equal(saved.definition.unavailable[0].reason,'independent_semantic_qa_failed');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('reviewer without actual independent model proof is not admitted',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aligned-faers-'));
 const records=Array.from({length:5},(_,i)=>fixture(i));const app={config:{reviewProvider:'bailian',reviewModel:'qwen-plus',evolutionDailyBudgetCny:50},evolution:{service:{withLock:async(_key,fn)=>fn(),owner:async()=>'owner'}},store:{userById:async()=>({id:'owner'}),projectFor:async()=>({})}};
 try{const result=await prepareAlignedFaers({app,evaluationDataDir:directory,load:async()=>({manifest:{},records}),review:async()=>({value:{passed:true},model:'qwen-plus',modelReported:false})});assert.equal(result.admittedPublications,0);assert.equal(result.missing,5);}finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('aligned callable verification binds original counts/correction and requires actual delivered output',async()=>{
 const {record}=fixture();const descriptor=alignedVerificationDescriptor(record),gold={numeric:record.numericGold,sourceHash:record.sourceHash,deterministicVerification:descriptor};
 const unit={numeric:record.independentNumericReference.numeric,assessmentEvidence:{deliveredText:[{path:'deliverables/paper-gold-analysis/analysis.py',text:'def analyze(a,b,c,d,continuityCorrection=0): return {}'}]}};
 let calls=0;const controller={execVerify:async request=>{calls++;assert.deepEqual(request.input,{a:12,b:88,c:6,d:94,continuityCorrection:0});return {ok:true,joined:true,executionStarted:true,output:JSON.stringify(record.independentNumericReference.numeric)};}};
 assert.equal((await verifyPaperGoldCode({controller,unit,gold})).verified,true);assert.equal(calls,2);
 const changed=structuredClone(gold);changed.deterministicVerification.input.a=13;assert.equal((await verifyPaperGoldCode({controller,unit,gold:changed})).verified,false);assert.equal(calls,2);
 const missing=structuredClone(unit);missing.assessmentEvidence.deliveredText=[];assert.equal((await verifyPaperGoldCode({controller,unit:missing,gold})).verified,false);
});
test('prior scoped semantic QA reuse is bound to exact preserved source/input/question identity',()=>{
 const manifest={proofHash:'original-source-proof'},definition={referenceProofHash:manifest.proofHash,scopedAnalysis:true},frozen={definition,evaluatorCodeHash:'old-evaluator'};frozen.hash=digest(frozen);const cached={identity:'exact-question-and-input',review:{value:{passed:true},modelReported:true,model:'qwen-plus'}};
 assert.equal(validateScopedQaReuse({cached,frozen,identity:cached.identity,manifest}),cached.review);
 assert.throws(()=>validateScopedQaReuse({cached,frozen,identity:'changed-input',manifest}),/unchanged/);
 assert.throws(()=>validateScopedQaReuse({cached,frozen,identity:cached.identity,manifest:{proofHash:'changed-source'}}),/unchanged/);
});

test('supplied Meta scope routes to statistical analysis and reuses source-bound QA without a new model call',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'scoped-route-'));let calls=0;
 const manifest={id:'synthetic-scoped-test',proofHash:'proofhash',dataHash:'a'.repeat(64),authorDocumentHash:'b'.repeat(64),publicationId:'10.1000/synthetic'},proof={sourceHash:manifest.dataHash,publicationId:manifest.publicationId,input:{studies:Array.from({length:37},()=>({yi:0,vi:1})),tauEstimator:'DL'},numeric:{pooled_log:{value:0,absoluteTolerance:1e-8}},numericComparisonPassed:true,independentReference:{implementationId:'synthetic-R',numeric:{pooled_log:0}}};
 const loadReference=async()=>({manifest,proof,author:'Synthetic 37-study fixture, not scientific evidence.'});
 const app={config:{reviewProvider:'dashscope',reviewModel:'qwen-plus',evolutionDailyBudgetCny:50},evolution:{service:{withLock:async(_key,fn)=>fn(),owner:async()=>'owner'}},store:{userById:async()=>({id:'owner'}),projectFor:async()=>({})}};
 const review=async()=>{calls++;return {value:{passed:true,issues:[]},modelReported:true,model:'qwen-plus'};};
 try{
  await prepareScopedResearch({app,evaluationDataDir:directory,cycleId:'prior-scoped',reuseFromCycleId:null,review,loadReference});
  await prepareScopedResearch({app,evaluationDataDir:directory,cycleId:'new-scoped',reuseFromCycleId:'prior-scoped',review,loadReference});assert.equal(calls,1);
  const frozen=JSON.parse(await fs.readFile(path.join(directory,'paper-gold/cycles/new-scoped/definition.json'),'utf8')),c=frozen.definition.cases[0];assert.equal(c.capabilityId,'statistical-analysis');assert.equal(c.gold.benchmarkScope,'positive-scoped-analysis-not-full-research');assert.ok(!c.gold.applicableStages.includes('recall'));assert.ok(c.gold.deterministicVerification);assert.equal(frozen.definition.replicates,2);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
