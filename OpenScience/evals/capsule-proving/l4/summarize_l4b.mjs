#!/usr/bin/env node
/** Compact P34 evidence; raw bodies, prompts and receipts remain on the lab. */
import {readFile,writeFile} from 'node:fs/promises';
const root='/srv/evimed/runs';
const load=file=>readFile(file,'utf8').then(JSON.parse);
const partial=process.argv.includes('--partial'),runs=[];
for(const size of [50,200,600])for(const arm of ['off','on']) {
  const runId=`l4b-${size}-${arm}-${arm==='on'?8:6}`;
  let report;try{report=await load(`${root}/${runId}/report.json`);}catch(error){if(partial&&error.code==='ENOENT')continue;throw error;}
  if(!partial&&report.passes.length!==20)throw new Error(`${runId} is incomplete`);
  const passes=report.passes.map(({pass,modelCalls,modelSteps,costCnyPeakUpper,lock,recall,recordedRecall,harmfulCanonicalMerges,retired,wallMs,result,embeddingTokens,embeddingCostCnyUpper})=>({
    pass,embeddingTokens,embeddingCostCnyUpper,recall:recordedRecall,judgeRecall:recall,modelCalls,modelSteps,costCnyPeakUpper,lockHeldOperationMs:lock.heldMs,lockWaitMs:lock.waitMs,
    wallMs,harmfulCanonicalMerges,retired,backlog:result.coverage?.backlog??null,pendingBuilds:result.coverage?.pendingBuilds??null,
    examined:result.coverage?.examined??null,enqueued:result.coverage?.enqueued??null,
    candidatePairs:result.coverage?.candidatePairs??null,decideFailed:result.coverage?.decideFailed??null,
    blockedUnproven:result.coverage?.blockedUnproven??null,
    callOverrun:result.coverage?.callOverrun??null,
  }));
  const library=await load(`${root}/${runId}/library.json`);
  const canonicalMergesCreated=library.documents.rows.filter(row=>row.kind==='method'
    &&(row.payload.provenance?.pendingRetirements??[]).length>=2).length;
  runs.push({runId,size,arm,completedPasses:passes.length,modelCallBudget:arm==='on'?report.modelCallBudget:null,sourceDigests:report.sourceDigests,
    scope:report.scope,budgetSemantics:arm==='on'?report.budgetSemantics:'Legacy limit: at most six changed groups per pass; no provider-call allowance.' ,markers:passes.filter(pass=>[1,5,20].includes(pass.pass)),passes,
    modelCalls:passes.reduce((sum,p)=>sum+p.modelCalls,0),costCnyPeakUpper:passes.reduce((sum,p)=>sum+p.costCnyPeakUpper,0),
    canonicalMergesCreated,harmfulCanonicalMerges:Math.max(...passes.map(p=>p.harmfulCanonicalMerges))});
}
const spend=(await readFile(`${root}/l4b-p34-spend.jsonl`,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const audit=await load(`${root}/l4b-p34-miss-audit.json`);
const superseded=[];
for(const size of [50,200,600]) {
  const runId=`l4b-${size}-on-6`,report=await load(`${root}/${runId}/report.json`);
  superseded.push({runId,completedPasses:report.passes.length,harmfulCanonicalMerges:Math.max(...report.passes.map(pass=>pass.harmfulCanonicalMerges)),
    firstHarmfulPass:report.passes.find(pass=>pass.harmfulCanonicalMerges)?.pass??null,
    disposition:size===50?'Superseded by the guarded rerun.':'Stopped after finding a planted subset folded into a merge; records preserved.'});
}
const result={schema:'p34-l4b/1',at:new Date().toISOString(),complete:runs.length===6&&runs.every(run=>run.completedPasses===20),
  switches:{OPEN_SCIENCE_METHOD_CONSOLIDATION_QUEUE_ENABLED:false,OPEN_SCIENCE_METHOD_CONSOLIDATION_RECALL_ENABLED:false,
    OPEN_SCIENCE_METHOD_PENDING_RETIREMENT_MOUNT_ENABLED:false,OPEN_SCIENCE_METHOD_CONSOLIDATION_MODEL_CALLS:12},
  arms:'off: queue and recall false; on: queue and recall true. Mount filter is covered by product tests, not this relation experiment.',
  implementation:{legacyCap:'CONSOLIDATION_LIMITS.maxGroups=6 and maxBuilds=6 bound paid work; they are not a pass-wide database lock.',
    queue:'Persistent versioned pairs, incremental incident edges, similarity/recency priority with an aging slot, shared account call allowance and rotating namespaces.',
    visibility:'GET /api/methods summary.consolidation and open_science_learning_consolidation_backlog expose unexamined and deferred-build counts.',
    pendingRetirementMount:'One guarded condition skips an original only while an approved canonical names its exact current digest.',
    mergeReview:'Independent bidirectional equivalence review before recording a merge relation; automatic folding additionally requires exactly equal applicability fields. Paraphrased scopes retain reviewed relations but separate memories.'},
  validation:{selectedTests:214,newScaleTests:25,existingServerTests:179,l4Tests:10,changedServerFileLint:'passed',
    serverTypecheck:'Not clean: 19 diagnostics in unchanged files; completed before the final retry-age metadata edit. No changed-file diagnostic in that completed check.'},
  plantedPairsPerKind:{50:8,200:16,600:16},supersededSwitchOnRuns:superseded,
  historicalFloorCalibration:{source:'results-2026-11-10.json',sizes:[50,200,600],floorOff:.50,floorOn:.60,
    candidatesOff:[164,680,2106],candidatesOn:[137,422,1625],screenPositiveRecallOffAndOn:[.875,5/6,5/6]},
  missAudit:{scope:audit.scope,counts:audit.counts,positiveJudgeStorage:audit.positiveJudgeStorage,
    samples:audit.records.map(({size,floor,kind,a,b,stage,diagnostic,predictions,together})=>({size,floor,kind,a,b,stage,
      originalCosine:diagnostic.score,groupIds:together.map(group=>group.groupId),judgedRelations:predictions}))},
  costs:{capCny:150,receiptGuardCny:140,receiptedPaidCallsWithPilots:spend.length,
    modelCostCnyPeakUpperWithPilots:spend.reduce((sum,row)=>sum+row.costCny,0),
    finalModelCostCnyPeakUpper:runs.reduce((sum,run)=>sum+run.costCnyPeakUpper,0),
    finalEmbeddingCostCnyUpper:runs.reduce((sum,run)=>sum+run.passes.reduce((n,p)=>n+(p.embeddingCostCnyUpper??0),0),0),
    balanceBefore:'2026-11-11T05:38:09Z balance 1837.36',balanceAfter:(await readFile(`${root}/BUDGET-LAST`,'utf8')).trim(),
    scope:'Token-based conservative peak-rate model estimate (input 2, cached input .04, output 8 CNY/M); not an invoice. Embeddings billed separately. Interrupted pilot requests may have no returned usage receipt; shared balance includes other lanes.'},
  limitations:['One draw per arm on public planted libraries; rules repeat across sizes.',
    'Stored-relation recall reads method heads, including retired methods and resolved relation records; judge recall is cumulative over completed decisions.',
    'Harmful merges count known planted nonduplicate pairs named together in a canonical pendingRetirements record; unlabelled pairs are not independently adjudicated.',
    'Direct model-step transport; product LearningService, ProductDocuments, relation writer, queue and PostgreSQL authority. No DSH.',
    'L4 composes one owned library with no contextProvenance. Namespace-budget rotation is covered by a separate two-scope product test; it is not an L4 measurement.',
    'Source digests are retained per arm. Retry-age fairness metadata was finalized during the batch; failure/retry coverage is separately unit-tested.',
    'All original planted duplicate pairs paraphrase their applicability fields. The conservative automatic-folding guard therefore withholds their replacement, even when the independent review records a duplicate relation. Canonical-creation counts are reported separately.',
    'Lock hold is time executing the library operation under its PostgreSQL advisory lock; final COMMIT overhead is excluded.',
    'The call allowance controls admission between bounded steps; an admitted repair can finish above it. Actual calls and overrun are reported.',
    'The queued allowance covers DECIDE/BUILD calls. The pre-existing ten-description limit and embedding requests are separate; pass receipts include all model calls.',
    'Retirement policy and active-library cap are unchanged. Superseded/retired snapshots become obsolete; current pair versions are queued.',
    'Old 0.60 calibration applies to the original summary screen, not proof of recall for the union of new retrieval views.'],runs};
await writeFile(`${root}/l4b-p34-results.json`,JSON.stringify(result,null,1));
process.stdout.write(JSON.stringify({complete:result.complete,costs:result.costs,runs:runs.map(({runId,completedPasses,markers,harmfulCanonicalMerges})=>({runId,completedPasses,markers,harmfulCanonicalMerges}))},null,1)+'\n');
