import {digest} from '../../../evals/paper-gold/evaluator.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEvolutionScorerAudit,scorerAuditVerdict} from '../src/evolutionScorerAudit.mjs';
test('scorer audit samples frozen completed units, records disagreement and retries without re-review',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'scorer-audit-'));
 try {
  const directory=path.join(root,'paper-gold','cycles','cycle1');await fs.mkdir(directory,{recursive:true});
  const original={caseId:'case1',producerRunId:'run1',producerProjectId:'eval-paper-test',allStagesValid:true};
  const definition={hash:'frozen1',definition:{cases:[{id:'case1',type:'method',gold:{sourceHash:'source1',numeric:{}}}]}};
  definition.evaluatorCodeHash='code1';definition.hash=digest({definition:definition.definition,evaluatorCodeHash:definition.evaluatorCodeHash});
  const report={complete:true,evaluatorHash:definition.hash,units:[original]};
  await fs.writeFile(path.join(directory,'definition.json'),JSON.stringify(definition));await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report));
  const records=new Map();let calls=0;
  const service={get:async id=>records.get(id),now:()=>new Date('2026-10-05'),save:async(_kind,id,payload)=>{const row={id,payload};records.set(id,row);return row;}};
  const audit=createEvolutionScorerAudit({service,config:{evaluationDataDir:root},readEvidence:async()=>({transcript:{header:{completeness:'complete'}},numeric:{value:3}}),review:async request=>{assert.equal(request.original,undefined);calls++;return {independent:true,model:'qwen',evidenceIds:['source1'],stages:{method:{observed:true,valid:false},calculation:{observed:true,valid:true}}};}});
  const result=await audit.run({day:'2026-10-05'});assert.equal(result.payload.discrepancies,1);assert.equal(result.payload.findings[0].deterministicNumericPassed,null);
  await audit.run({day:'2026-10-05'});assert.equal(calls,1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'report.json'),'utf8')),report);
  assert.equal(JSON.stringify(result).includes('"numeric"'),false);
  records.clear(); report.units=[original,{...original,producerRunId:'run2'},{...original,producerRunId:'run3'}];
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report));
  let reviews=0, fail=true;
  const retryAudit=createEvolutionScorerAudit({service,config:{evaluationDataDir:root},readEvidence:async()=>({transcript:{header:{completeness:'complete'}}}),review:async request=>{assert.equal(request.original,undefined);reviews++;if(reviews===3 && fail)throw Error('interruption');return {independent:true,model:'qwen',evidenceIds:['source1'],stages:{method:{observed:true,valid:false},calculation:{observed:true,valid:true}}};}});
  await assert.rejects(retryAudit.run({day:'2026-10-06'}),/interruption/);fail=false;
  const resumed=await retryAudit.run({day:'2026-10-06'});assert.equal(reviews,4);assert.equal(resumed.payload.findings.length,3);
  records.clear();definition.definition.cases[0].gold.numeric={value:{value:2,absoluteTolerance:0}};
  definition.hash=digest({definition:definition.definition,evaluatorCodeHash:definition.evaluatorCodeHash});report.evaluatorHash=definition.hash;
  await fs.writeFile(path.join(directory,'definition.json'),JSON.stringify(definition));await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report));
  const proofWaiting=await retryAudit.run({day:'2026-10-08'});assert.equal(proofWaiting.payload.findings[0].status,'waiting-control-proof');assert.equal(reviews,4);
  definition.definition.cases[0].gold.sourceHash='changed';await fs.writeFile(path.join(directory,'definition.json'),JSON.stringify(definition));
  await assert.rejects(retryAudit.run({day:'2026-10-07'}),/integrity/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('missing completed transcript is explicitly waiting without invoking review',async()=>{
 const audit=createEvolutionScorerAudit({service:{get:async()=>null,save:async(_k,_i,payload)=>({payload}),now:()=>new Date()},config:{evaluationDataDir:'/nonexistent-evolution-audit'},readEvidence:async()=>null,review:async()=>{throw Error('must not call');}});
 const result=await audit.run({day:'2026-10-05'});assert.equal(result.payload.sampled,0);assert.equal(result.payload.eligibleUnits,0);
});

test('audit ruler keeps method applicable stages separate from seven-stage full research',()=>{
 const stages={method:{observed:true,valid:true},calculation:{observed:true,valid:true}};
 assert.equal(scorerAuditVerdict({type:'method'},{stages}).allStagesValid,true);
 assert.equal(scorerAuditVerdict({type:'method'},{stages}).fullResearchReproductionValid,false);
 assert.equal(scorerAuditVerdict({type:'research'},{stages}).allStagesValid,false);
 for(const id of ['question','recall','extraction','certainty','writing']) stages[id]={observed:true,valid:true};
 assert.equal(scorerAuditVerdict({type:'research'},{stages},'unexposed').fullResearchReproductionValid,true);
 assert.equal(scorerAuditVerdict({type:'research',inputAvailable:false},{stages}).allStagesValid,false);
});
