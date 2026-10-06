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
  // The unit carries no assessor identity, so a second model reading cannot be called independent of the first.
  assert.deepEqual({status:result.payload.findings[0].status,independent:result.payload.findings[0].independentOfAssessor,reviewed:result.payload.reviewed,rereads:result.payload.sameFamilyRereads,rate:result.payload.discrepancyRate,threshold:result.payload.discrepancyThreshold},{status:'same-family-reread',independent:false,reviewed:0,rereads:1,rate:1,threshold:null});
  // A reader of another family than the one that scored the unit is an independent review; the same family is a reread.
  for(const [assessmentModel,status] of [['deepseek-v4-pro','reviewed'],['qwen3.8-max','same-family-reread']]){
   records.clear();await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({...report,units:[{...original,assessmentModel}]}));
   assert.equal((await audit.run({day:'2026-10-05'})).payload.findings[0].status,status);
  }
  records.clear();await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report));await audit.run({day:'2026-10-05'});
  const again=calls;await audit.run({day:'2026-10-05'});assert.equal(calls,again);
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

// A frozen cycle of `count` completed units of one method case, the way the first test lays one out.
async function cycleOf(root, units, gold = { sourceHash: 'source1', numeric: {} }) {
 const directory = path.join(root, 'paper-gold', 'cycles', 'cycle1');
 await fs.mkdir(directory, { recursive: true });
 const definition = { definition: { cases: [{ id: 'case1', type: 'method', gold }] }, evaluatorCodeHash: 'code1' };
 definition.hash = digest({ definition: definition.definition, evaluatorCodeHash: definition.evaluatorCodeHash });
 await fs.writeFile(path.join(directory, 'definition.json'), JSON.stringify(definition));
 await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ complete: true, evaluatorHash: definition.hash, units }));
}
const memoryService = () => {
 const records = new Map();
 return { records, get: async id => records.get(id), now: () => new Date('2026-10-06'), save: async (_kind, id, payload) => { const row = { id, payload }; records.set(id, row); return row; } };
};
const completeTranscript = { header: { completeness: 'complete' } };
const methodReview = async () => ({ independent: true, model: 'deepseek-v4-flash', evidenceIds: ['source1'], stages: { method: { observed: true, valid: true }, calculation: { observed: true, valid: true } } });

// Release 6: the delivery receipt pinned three files of each run and five runs delivered more, so three of three sampled units
// answered waiting-control-proof, nothing was reviewed, and the stage printed passed:true.
test('a delivered file the receipt never pinned is listed on the finding and does not stop the audit; a pinned file that changed still does', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scorer-audit-unpinned-'));
 try {
  const unit = producerRunId => ({ caseId: 'case1', producerRunId, producerProjectId: 'eval-paper-test', allStagesValid: true, assessmentModel: 'qwen3.8-max-0902' });
  await cycleOf(root, [unit('run_report'), unit('run_scratch'), unit('run_changed')]);
  const service = memoryService();
  const unpinned = {
   run_report: [{ path: 'deliverables/paper-gold-analysis/report.md', reason: 'not_pinned_by_producer_receipt' }],
   run_scratch: [{ path: 'scratch/run_analysis.py', reason: 'not_pinned_by_producer_receipt' }, { path: 'scratch/analysis-inputs.json', reason: 'not_pinned_by_producer_receipt' }],
   run_changed: [],
  };
  const observedByRun = [];
  const audit = createEvolutionScorerAudit({ service, config: { evaluationDataDir: root },
   readEvidence: async sample => ({ transcript: completeTranscript, unverifiedArtifacts: unpinned[sample.producerRunId],
    artifactIssues: sample.producerRunId === 'run_changed' ? [{ path: 'deliverables/paper-gold-analysis/analysis.py', reason: 'producer_receipt_hash_unverified' }] : [],
    deliveredText: [{ path: 'deliverables/paper-gold-analysis/analysis.py', text: 'def analyze(**kw): ...' }] }),
   review: async request => { observedByRun.push(request.observed); return methodReview(); } });
  const result = (await audit.run({ day: '2026-10-06' })).payload;
  const byRun = Object.fromEntries(result.findings.map(row => [row.producerRunId, row]));
  assert.equal(byRun.run_report.status, 'reviewed');
  assert.deepEqual(byRun.run_report.unverifiedArtifacts, unpinned.run_report);
  assert.equal(byRun.run_scratch.status, 'reviewed');
  assert.deepEqual(byRun.run_scratch.unverifiedArtifacts, unpinned.run_scratch);
  assert.equal(byRun.run_changed.status, 'waiting-control-proof');
  assert.equal(byRun.run_changed.reason, 'artifact_unverified');
  assert.deepEqual(byRun.run_changed.artifactIssues, [{ path: 'deliverables/paper-gold-analysis/analysis.py', reason: 'producer_receipt_hash_unverified' }]);
  assert.equal(observedByRun.length, 2, 'only the two units without a blocking issue reach the reviewer');
  // The reviewer is shown the pinned text and the unpinned paths, never an unpinned file's text.
  assert.ok(observedByRun.every(observed => observed.deliveredText.length === 1 && observed.deliveredText[0].path.endsWith('analysis.py')));
  assert.deepEqual({ sampled: result.sampled, reviewed: result.reviewed, auditedUnits: result.auditedUnits, waitingUnits: result.waitingUnits, waitingByReason: result.waitingByReason, unitsWithUnverifiedArtifacts: result.unitsWithUnverifiedArtifacts, outcome: result.outcome, passed: result.passed },
   { sampled: 3, reviewed: 2, auditedUnits: 2, waitingUnits: 1, waitingByReason: { artifact_unverified: 1 }, unitsWithUnverifiedArtifacts: 2, outcome: 'partial', passed: false });
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an audit that reviewed none of a non-empty sample says so by count and reason and is not a pass', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scorer-audit-nothing-'));
 try {
  const unit = producerRunId => ({ caseId: 'case1', producerRunId, producerProjectId: 'eval-paper-test', allStagesValid: true, assessmentModel: 'qwen3.8-max-0902' });
  await cycleOf(root, [unit('run1'), unit('run2'), unit('run3')]);
  const audit = createEvolutionScorerAudit({ service: memoryService(), config: { evaluationDataDir: root },
   readEvidence: async () => ({ transcript: completeTranscript, artifactIssues: [{ path: 'analysis.py', reason: 'producer_receipt_hash_unverified' }] }),
   review: async () => { throw Error('must not be called'); } });
  const result = (await audit.run({ day: '2026-10-06' })).payload;
  assert.equal(result.status, 'complete');
  assert.deepEqual({ sampled: result.sampled, reviewed: result.reviewed, auditedUnits: result.auditedUnits, waitingUnits: result.waitingUnits, waitingByReason: result.waitingByReason, outcome: result.outcome, passed: result.passed, discrepancyRate: result.discrepancyRate },
   { sampled: 3, reviewed: 0, auditedUnits: 0, waitingUnits: 3, waitingByReason: { artifact_unverified: 3 }, outcome: 'nothing-audited', passed: false, discrepancyRate: null });
  const empty = createEvolutionScorerAudit({ service: memoryService(), config: { evaluationDataDir: '/nonexistent-evolution-audit' }, readEvidence: async () => null, review: async () => { throw Error('must not be called'); } });
  const none = (await empty.run({ day: '2026-10-06' })).payload;
  assert.deepEqual({ sampled: none.sampled, outcome: none.outcome, passed: none.passed }, { sampled: 0, outcome: 'no-sample', passed: false });
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});
