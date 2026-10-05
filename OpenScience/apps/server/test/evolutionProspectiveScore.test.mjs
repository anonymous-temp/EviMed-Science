import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEvolutionProspectiveScore, verifyOfficialProspectiveTarget, prospectiveNumericQuoteMatches, validProspectiveNumericReference } from '../src/evolutionProspectiveScore.mjs';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('official target verification has exact registry scope and no search-zero inference',async()=>{
  let calls=0;
  const dependencies={fetchImpl:async url=>{calls++;assert.equal(url,'https://clinicaltrials.gov/api/v2/studies/NCT12345678');return{ok:true,text:async()=>JSON.stringify({hasResults:false,protocolSection:{identificationModule:{nctId:'NCT12345678'}}})};}};
  const unknown=await verifyOfficialProspectiveTarget({targetIdentity:'doi:unknown'},dependencies);assert.equal(unknown.unpublished,null);assert.equal(calls,0);
  const official=await verifyOfficialProspectiveTarget({targetIdentity:'clinicaltrials.gov:NCT12345678:results'},dependencies);assert.equal(official.unpublished,true);assert.match(official.scope,/no claim about all publications/);
});
test('prospective score compares frozen numbers without gold in extraction, waits for gold and refuses changed pins',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'evolution-prospective-'));
  const id=`evolution-prospective-${'a'.repeat(64)}`,prediction='Relative risk estimate 0.8.';
  const payload={registrationEligible:true,actualPinnedToolUse:true,targetIdentity:'target',prediction,predictionHash:sha(prediction),transcriptHash:'transcript',producerRunId:'run',toolId:'tool',artifactDigest:'pin',frozenAt:'2026-10-04',modelReleasedAt:'2026-01-01'};
  let extractionCalls=0;const saved=[];
  const service={get:async()=>({id,payload}),now:()=>new Date('2026-10-20'),ingestEvent:async()=>{},save:async(...args)=>{saved.push(args);return{id:args[1],payload:args[2]};}};
  const pinned={ok:true,modelFamily:'deepseek',predictionHash:payload.predictionHash,transcriptHash:payload.transcriptHash,toolId:'tool',digest:'pin'};
  const scorer=createEvolutionProspectiveScore({service,config:{evaluationDataDir:root},verifyPinnedRun:async()=>pinned,extractPrediction:async input=>{extractionCalls++;assert.equal(input.text,prediction);assert.equal('gold' in input,false);assert.deepEqual(input.fields,['risk']);return{independent:true,modelFamily:'qwen',numeric:{risk:{value:0.8,quote:'0.8'}}};}});
  try {
    assert.equal((await scorer.score({registrationId:id})).status,'waiting');assert.equal(extractionCalls,0);
    await fs.mkdir(path.join(root,'paper-gold','prospective'),{recursive:true});
    await fs.writeFile(path.join(root,'paper-gold','prospective',`${id}.json`),JSON.stringify({registrationId:id,targetIdentity:'target',firstPublicAt:'2026-10-10',firstPublicEvidenceId:'official',independent:true,retracted:false,numeric:{risk:{value:0.8,absoluteTolerance:0.01}}}));
    const result=await scorer.score({registrationId:id});assert.equal(result.passed,true);assert.equal(extractionCalls,1);assert.equal(saved.length,2);assert.equal(saved[0][2].units[0].allStagesValid,false);assert.equal(saved[0][2].units[0].numericEvaluationPassed,true);assert.equal(payload.prediction,prediction);
    payload.score=result;assert.equal((await scorer.score({registrationId:id})).passed,true);assert.equal(extractionCalls,1);
    pinned.digest='changed';await assert.rejects(scorer.score({registrationId:id}),/original pinned/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('numeric quotation bonds match complete literals, signs, grouping and exponent values',()=>{
  for(const quote of ['21','1.5','0.001','-1','x1','1e2','1,000'])assert.equal(prospectiveNumericQuoteMatches(quote,1),false,quote);
  assert.equal(prospectiveNumericQuoteMatches('Risk estimate 1.',1),true);
  assert.equal(prospectiveNumericQuoteMatches('Effect −1.5.',-1.5),true);
  assert.equal(prospectiveNumericQuoteMatches('Count 1,000.',1000),true);
  assert.equal(prospectiveNumericQuoteMatches('Estimate 1e-2.',0.01),true);
  assert.equal(prospectiveNumericQuoteMatches('1',1,'Actual estimate 21.'),false);
  assert.equal(prospectiveNumericQuoteMatches('1',1,'Actual estimate 1.5.'),false);
  assert.equal(prospectiveNumericQuoteMatches('1',1,'Actual estimate -1.'),false);
  assert.equal(prospectiveNumericQuoteMatches('1',1,'Actual estimate 1.'),true);
  assert.equal(prospectiveNumericQuoteMatches('1.5kg',1),false);
});
test('malformed independent numeric gold is waiting without extraction or cached-score reuse',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'prospective-invalid-gold-')),id=`evolution-prospective-${'b'.repeat(64)}`;
  const payload={registrationEligible:true,actualPinnedToolUse:true,targetIdentity:'target',prediction:'Effect 1.',predictionHash:sha('Effect 1.'),frozenAt:'2026-10-04',modelReleasedAt:'2026-01-01'};
  let calls=0;const scorer=createEvolutionProspectiveScore({service:{get:async()=>({id,payload})},config:{evaluationDataDir:root},verifyPinnedRun:async()=>{calls++;return{};},extractPrediction:async()=>{calls++;return{};}});
  try{
    await fs.mkdir(path.join(root,'paper-gold','prospective'),{recursive:true});
    for(const reference of [{value:'1'},{interval:[2,1]},{value:1,absoluteTolerance:-1},{value:1,relativeTolerance:'1'},{value:1e308,relativeTolerance:1e308},{interval:[null,1]},null]){
      const gold={registrationId:id,targetIdentity:'target',firstPublicAt:'2026-10-10',firstPublicEvidenceId:'official',independent:true,retracted:false,numeric:{effect:reference}};
      payload.score={status:'scored',goldHash:sha(gold),passed:true};
      await fs.writeFile(path.join(root,'paper-gold','prospective',`${id}.json`),JSON.stringify(gold));
      assert.equal((await scorer.score({registrationId:id})).status,'waiting');assert.equal(calls,0);
    }
    assert.equal(validProspectiveNumericReference({interval:[-1,1],absoluteTolerance:0.01}),true);
    assert.equal(validProspectiveNumericReference({value:Infinity}),false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
