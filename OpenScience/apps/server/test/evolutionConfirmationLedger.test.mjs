import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createEvolutionConfirmationLedger} from '../src/evolutionConfirmationLedger.mjs';
test('old cases stay development, fresh confirmation is globally consumed and a byte change creates a new freeze',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'evolution-confirmation-'));
 try{
  const ledger=createEvolutionConfirmationLedger({dataDir,evaluationDataDir:dataDir});
  const candidate={id:'candidate',files:{'scripts/candidate.py':'def candidate(x):return x'},entrypoint:'scripts/candidate.py:candidate'};
  const frozen=await ledger.freezeCandidate(candidate,{card:{id:'lineage',methodId:'method',modelReleasedAt:'2026-01-01',modelReleaseEvidenceId:'official-release-proof'}});
  assert.deepEqual(await ledger.freezeCandidate(candidate,{card:{id:'lineage',methodId:'method',modelReleasedAt:'2026-01-01',modelReleaseEvidenceId:'official-release-proof'}}),frozen);
  const hidden={hidden:true,kind:'published',independentQa:{passed:true},sourceHash:'a'.repeat(64)};
  const definition={methodId:'method',modelReleasedAt:'2026-01-01',modelReleaseEvidenceId:'official-release-proof',cases:[{...hidden,id:'old',sourceRoot:'old-study',earliestPublicAt:'2020-01-01'},{...hidden,id:'reserve',sourceRoot:'reserve-study',reserve:true},{...hidden,id:'new',sourceRoot:'new-study',earliestPublicAt:new Date(Date.parse(frozen.frozenAt)+1).toISOString()}]};
  const first=await ledger.assemble(definition,frozen,{minimumCases:2,requireTemporal:true});
  assert.deepEqual(first.cases.map(item=>item.id),['reserve','new']);
  const second=await ledger.assemble(definition,frozen,{minimumCases:2,requireTemporal:true});
  assert.equal(second.cases.length,0);
  const development=await ledger.assemble(definition,frozen,{purpose:'development'});
  assert.equal(development.cases.length,3);assert.equal(development.confirmatory,false);
  const changed=await ledger.freezeCandidate({...candidate,files:{'scripts/candidate.py':'def candidate(x):return x+1'}},{card:{id:'lineage',methodId:'method',modelReleasedAt:'2026-01-01',modelReleaseEvidenceId:'official-release-proof'}});
  assert.notEqual(changed.identity,frozen.identity);
  assert.equal((await ledger.assemble(definition,changed)).cases.length,0);
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
test('insufficient batches do not spend reserved assets',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'evolution-confirmation-'));
 try{
  const ledger=createEvolutionConfirmationLedger({dataDir,evaluationDataDir:dataDir});
  const frozen=await ledger.freezeCandidate({id:'c',files:{}},{card:{methodId:'m'}});
  const one={id:'one',sourceRoot:'one-study',hidden:true,reserve:true,sourceHash:'b'.repeat(64),independentQa:{passed:true}};
  assert.equal((await ledger.assemble({methodId:'m',cases:[one]},frozen)).cases.length,0);
  assert.equal((await ledger.assemble({methodId:'m',cases:[one]},frozen,{minimumCases:1})).cases.length,1);
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
test('actual evaluator waits on old corpus and admits a once-only post-freeze first answer batch',async()=>{
 const {mkdir,writeFile}=await import('node:fs/promises');
 const {createEvolutionCandidateEvaluator}=await import('../src/evolutionCandidateEvaluator.mjs');
 const {pythonExecVerify}=await import('./helpers/pythonExecVerify.mjs');
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'evolution-fresh-evaluator-'));
 try{
  const directory=path.join(dataDir,'paper-gold','candidate-cases');await mkdir(directory,{recursive:true});
  const row=(x,extra={})=>({id:`case-${x}`,hidden:true,kind:'published',publicationId:`paper-${x}`,sourceRoot:`study-${x}`,independentQa:{passed:true},sourceHash:String(x).repeat(64),input:{x},numeric:{value:{value:x,absoluteTolerance:0}},...extra});
  const definition={methodId:'method',modelReleasedAt:'2026-01-01',modelReleaseEvidenceId:'official-release-proof',frozen:true,referenceImplementation:{implementationId:'independent',language:'python',code:"import json,sys\nprint(json.dumps({'numeric':{'value':json.load(sys.stdin)['x']}}))\n"},cases:[row(3,{reserve:true}),row(5,{reserve:true})]};
  const file=path.join(directory,'method.json');await writeFile(file,JSON.stringify(definition));
  const record={calls:[]},candidate={id:'candidate',methodId:'method',modelReleasedAt:'2026-01-01',modelReleaseEvidenceId:'official-release-proof',entrypoint:'scripts/estimate.py:estimate',files:{'scripts/estimate.py':"def estimate(x):return {'value':x}"}};
  const evaluator=createEvolutionCandidateEvaluator({config:{dataDir,evaluationDataDir:dataDir},controller:{execVerify:pythonExecVerify(record)},auditCandidateExposure:async()=>({tier:'unexposed'})});
  await evaluator.freezeCandidate(candidate,{card:{methodId:'method',modelReleasedAt:'2026-01-01',modelReleaseEvidenceId:'official-release-proof'}});
  const old=await evaluator.evaluate(candidate,{card:{methodId:'method',modelReleasedAt:'2026-01-01',modelReleaseEvidenceId:'official-release-proof'},purpose:'confirmation'});
  assert.equal(old.ok,false);assert.equal(old.resourceCode,'fresh_confirmation_cases_incomplete');assert.equal(record.calls.length,0);
  await new Promise(resolve=>setTimeout(resolve,2));definition.cases.push(row(7,{earliestPublicAt:new Date().toISOString()}));await writeFile(file,JSON.stringify(definition));
  const confirmed=await evaluator.evaluate(candidate,{card:{methodId:'method',modelReleasedAt:'2026-01-01',modelReleaseEvidenceId:'official-release-proof'},purpose:'confirmation'});
  assert.equal(confirmed.ok,true);assert.equal(confirmed.confirmatory,true);assert.ok(confirmed.caseGroups.some(item=>item.freshness==='post-freeze-publication'));
  assert.equal(confirmed.assessments.length,3);assert.equal(confirmed.assessments.every(item=>item.replicate===0),true);
  await evaluator.recordFeedback(confirmed,{lineageId:'lineage'});
  const again=await evaluator.evaluate(candidate,{card:{methodId:'method',modelReleasedAt:'2026-01-01',modelReleaseEvidenceId:'official-release-proof'},purpose:'confirmation'});
  assert.equal(again.ok,false);assert.equal(again.resourceCode,'fresh_confirmation_cases_incomplete');
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
test('new case and method aliases cannot recycle a consumed study and unknown release proof cannot establish temporal freshness',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'evolution-root-ledger-'));
 try{
  const ledger=createEvolutionConfirmationLedger({dataDir,evaluationDataDir:dataDir});
  const frozen=await ledger.freezeCandidate({id:'one',files:{a:'x'}},{modelReleasedAt:'2026-01-01',modelReleaseEvidenceId:'official'});
  const item={id:'old-case',sourceRoot:'doi:study',hidden:true,reserve:true,sourceHash:'a'.repeat(64),independentQa:{passed:true}};
  assert.equal((await ledger.assemble({methodId:'one',cases:[item]},frozen,{minimumCases:1})).cases.length,1);
  const next=await ledger.freezeCandidate({id:'two',files:{a:'y'}});
  const alias={...item,id:'new-case',sourceHash:'b'.repeat(64)};
  assert.equal((await ledger.assemble({methodId:'new-method',cases:[alias]},next,{minimumCases:1})).cases.length,0);
  const fresh={...item,id:'fresh',sourceRoot:'doi:new-study',reserve:false,kind:'published',earliestPublicAt:new Date(Date.parse(next.frozenAt)+1).toISOString()};
  await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal((await ledger.assemble({methodId:'three',cases:[fresh]},next,{minimumCases:1,requireTemporal:true})).cases.length,0);
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
