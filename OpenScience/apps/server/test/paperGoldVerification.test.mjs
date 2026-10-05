import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, scoreUnit } from '../../../evals/paper-gold/evaluator.mjs';
import { verifyPaperGoldCode, bindPaperGoldReview, bindPaperGoldStageAssessment } from '../src/paperGoldVerification.mjs';
import { pythonExecVerify } from './helpers/pythonExecVerify.mjs';
const hash = 'a'.repeat(64);
function fixture() {
  const input = { values: [1, 2] };
  const gold = { type: 'method', sourceHash: hash, numeric: { total: { value: 4, absoluteTolerance: 0 } }, preservedEvidence: [{ id: 'primary', sourceHash: hash, numericQuotes:['Synthetic published worked example: values 1 and 2; stated total 4.'] }],
    stageChecks: { method: ['method_supported'] }, deterministicVerification: { entrypoint: 'scripts/analysis.py:analyze', implementationId: 'platform', input, inputHash: digest(input), sourceHash: hash,
      // A sum scales with its terms: the relation the replay runs on an input the run never saw.
      relations: [{ kind: 'scale', inputs: ['values'], outputs: { total: 1 } }],
      independentQa: { passed: true, executor: 'independent-base-R' }, independentImplementation: { implementationId: 'base-R', sourceHash: hash, numeric: { total: 3 } }, tolerances: { total: { absoluteTolerance: 0 } } } };
  const unit = { numeric: { total: 3 }, checks: { method_supported: true }, modelFamily: 'deepseek', assessmentEvidence: { deliveredText: [{ path: 'scripts/analysis.py', text: 'def analyze(values):\n    return {"total": sum(values)}\n' }] } };
  return { gold, unit };
}
const response = { model: 'qwen3.5-plus', modelReported: true, value: { verdict: 'paper_error', evidenceIds: ['primary'], reason: 'Independent arithmetic and published number disagree.' } };

test('actual isolated replay against independent reference can validate code without forcing incorrect paper agreement', async () => {
  const { unit, gold } = fixture(); const record = { calls: [] }, controller = { execVerify: pythonExecVerify(record) };
  const verification = await verifyPaperGoldCode({ unit, gold, controller });
  assert.equal(verification.verified, true, verification.reason);
  assert.deepEqual(record.calls.slice(0, 2).map(call => call.input), [{ values: [1, 2] }, { values: [1, 2] }]); assert.match(record.calls[0].code, /runpy.run_path/);
  assert.equal(record.calls.length, 3); assert.notDeepEqual(record.calls[2].input, { values: [1, 2] }); assert.equal(verification.proof.behaviouralChecks, 1);
  // The disclosed input alone used to be the whole replay: code that returns the number it was shown replayed identically.
  const constant = structuredClone(unit); constant.assessmentEvidence.deliveredText[0].text = 'def analyze(**arguments):\n    return {"total": 3}\n';
  assert.deepEqual(await verifyPaperGoldCode({ unit: constant, gold, controller }), { verified: false, reason: 'behavioural_replay_failed' });
  // A descriptor with no relation, or only one a constant satisfies, cannot verify code at all.
  const bare = structuredClone(gold); delete bare.deterministicVerification.relations;
  assert.deepEqual(await verifyPaperGoldCode({ unit, gold: bare, controller }), { verified: false, reason: 'behavioural_replay_unavailable' });
  const invariantOnly = structuredClone(gold); invariantOnly.deterministicVerification.relations = [{ kind: 'permute', arrays: [{ path: 'values', axes: [0] }] }];
  assert.deepEqual(await verifyPaperGoldCode({ unit, gold: invariantOnly, controller }), { verified: false, reason: 'behavioural_replay_unavailable' });
  const verdict = bindPaperGoldReview({ result: response, config: { reviewProvider: 'dashscope' }, unit, gold, verification });
  const scored = await scoreUnit(unit, gold, { verifyCode: async()=>verification, review: async context => {
    assert.equal(context.gold, gold); assert.equal(context.unit, unit); return verdict;
  } });
  assert.equal(scored.numeric.total.valid, false);
  assert.equal(scored.stages.calculation.valid, true);
  assert.match(scored.disagreement.verificationProof.proofHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(scored.disagreement).includes('values'), false);
});

test('model claims, runtime self-checks, missing/altered descriptors and unmatched numbers cannot establish verification', async () => {
  const { unit, gold } = fixture(); unit.codeVerified = true; unit.deterministicChecks = [{ valid: true }];
  const noDescriptor = await verifyPaperGoldCode({ unit, gold: { ...gold, deterministicVerification: undefined } });
  assert.equal(noDescriptor.verified, false);
  const bound = bindPaperGoldReview({ result: { ...response, value: { ...response.value, codeVerified: true } }, config: { reviewProvider: 'dashscope' }, unit, gold, verification: noDescriptor });
  assert.equal(bound.codeVerified, false);
  const changed = structuredClone(gold); changed.deterministicVerification.input.values = [4];
  assert.equal((await verifyPaperGoldCode({ unit, gold: changed, controller: { execVerify() { throw new Error('must not execute'); } } })).verified, false);
  const wrong = await verifyPaperGoldCode({ unit, gold, controller: { execVerify: async () => ({ ok: true, joined: true, executionStarted: true, output: '{"total":4}' }) } });
  assert.equal(wrong.verified, false);
  assert.throws(() => bindPaperGoldReview({ result: { ...response, modelReported: false }, config: { reviewProvider: 'dashscope' }, unit, gold, verification: { verified: true } }), /cross-family/);
  assert.throws(() => bindPaperGoldReview({ result: { ...response, value: { ...response.value, evidenceIds: ['invented-source'] } }, config: { reviewProvider: 'dashscope' }, unit, gold, verification: { verified: true } }), /preserved evidence/);
});

test('both execution completion and replicate agreement are necessary', async () => {
  const { unit, gold } = fixture();
  const unfinished = await verifyPaperGoldCode({ unit, gold, controller: { execVerify: async () => ({ ok: true, joined: true, output: '{"total":3}' }) } });
  assert.equal(unfinished.verified, false);
  let calls = 0;
  const changed = await verifyPaperGoldCode({ unit, gold, controller: { execVerify: async () => ({ ok: true, joined: true, executionStarted: true, output: ++calls === 1 ? '{"total":3}' : '{"total":2}' }) } });
  assert.equal(changed.verified, false); assert.equal(calls, 2);
});


test('matching fabricated JSON cannot bypass required isolated code replay',async()=>{
 const {unit,gold}=fixture();gold.numeric.total.value=3;
 const absent=await scoreUnit({...unit,assessmentEvidence:{deliveredText:[]}},gold);
 assert.equal(absent.numeric.total.valid,true);assert.equal(absent.stages.calculation.valid,false);assert.equal(absent.deterministicVerificationRequired,true);
 for(const mode of ['missing','wrong','changed-input']){
  const actual=structuredClone(unit),reference=structuredClone(gold);if(mode==='missing')actual.assessmentEvidence.deliveredText=[];if(mode==='changed-input')reference.deterministicVerification.input.values=[9];
  const verifyCode=({unit,gold})=>verifyPaperGoldCode({unit,gold,controller:{execVerify:async()=>({ok:true,joined:true,executionStarted:true,output:'{"total":99}'})}});
  const scored=await scoreUnit(actual,reference,{verifyCode});assert.equal(scored.numeric.total.valid,true);assert.equal(scored.stages.calculation.valid,false);assert.equal(scored.codeVerified,false);
 }
});
test('runtime forged checks never overwrite independent QA rejection or invalid source/provider proof',()=>{
 const {unit,gold}=fixture();unit.checks={method_supported:true};
 const good={model:'qwen3.5-plus',modelReported:true,value:{checks:{method_supported:false},evidenceIds:['primary'],gaps:[]}};
 const rejected=bindPaperGoldStageAssessment({result:good,config:{reviewProvider:'dashscope'},unit,gold});assert.equal(rejected.checks.method_supported,false);assert.equal(rejected.independentAssessment,true);
 for(const result of [{...good,modelReported:false},{...good,value:{checks:{method_supported:true},evidenceIds:['invented-source'],gaps:[]}}]){
  const bound=bindPaperGoldStageAssessment({result,config:{reviewProvider:'dashscope'},unit,gold});assert.equal(bound.checks.method_supported,false);assert.equal(bound.independentAssessment,false);
 }
 const accepted=bindPaperGoldStageAssessment({result:{...good,value:{...good.value,checks:{method_supported:true,undeclared_check:true}}},config:{reviewProvider:'dashscope'},unit,gold});assert.deepEqual(accepted.checks,{method_supported:true});
});

test('opaque evidence IDs cannot justify exempting incorrect published numbers',()=>{
 const {unit,gold}=fixture();gold.preservedEvidence=[{id:'primary',sourceHash:hash}];
 const bound=bindPaperGoldReview({result:response,config:{reviewProvider:'dashscope'},unit,gold,verification:{verified:true,proof:{proofHash:hash}}});
 assert.equal(bound.codeVerified,false);assert.equal(bound.verificationFailure,'primary_evidence_uninspectable');
});

// Live scoped cycle, 2026-10-05: a delivered random-effects meta-analysis replayed twice within the independent
// reference's tolerance and was then refused `behavioural_replay_failed`. Its function returned the 37 study rows
// (with their weights) beside the six pooled statistics; reordering the studies left all six where they were and
// moved 372 row leaves, and the meta ruler's permutation held every numeric leaf still.
test('a meta-analysis that also reports its study rows is verified: a reordering holds the pooled statistics still, not the rows', async () => {
  const { methodRulerRelations, relationIssues } = await import('../../../evals/paper-gold/behavioural.mjs');
  const studies = [{ yi: 0.21, vi: 0.04 }, { yi: 0.47, vi: 0.09 }, { yi: -0.05, vi: 0.02 }, { yi: 0.33, vi: 0.06 }, { yi: 0.9, vi: 0.05 }];
  // DerSimonian–Laird, written once here as the independent reference.
  const dl = rows => { const w = rows.map(r => 1 / r.vi), sw = w.reduce((a, b) => a + b, 0), fixed = rows.reduce((a, r, i) => a + w[i] * r.yi, 0) / sw;
    const q = rows.reduce((a, r, i) => a + w[i] * (r.yi - fixed) ** 2, 0), c = sw - w.reduce((a, b) => a + b * b, 0) / sw, tau = Math.max(0, (q - (rows.length - 1)) / c);
    const ws = rows.map(r => 1 / (r.vi + tau)), sws = ws.reduce((a, b) => a + b, 0), pooled = rows.reduce((a, r, i) => a + ws[i] * r.yi, 0) / sws, se = Math.sqrt(1 / sws);
    return { pooled_log: pooled, ci_lower_log: pooled - 1.959963984540054 * se, ci_upper_log: pooled + 1.959963984540054 * se, tau_squared: tau, q_statistic: q, n_studies: rows.length }; };
  const reference = dl(studies); assert.ok(reference.tau_squared > 0, 'the fixture has heterogeneity, so every statistic is exercised');
  const input = { studies }, relations = methodRulerRelations('meta-reml');
  assert.ok(relations.every(relation => relationIssues(relation).length === 0));
  const gold = { type: 'research', sourceHash: hash, numeric: Object.fromEntries(Object.entries(reference).map(([key, value]) => [key, { value, absoluteTolerance: 1e-9 }])),
    deterministicVerification: { entrypoint: 'deliverables/paper-gold-analysis/analysis.py:analyze', implementationId: 'delivered', input, inputHash: digest(input), sourceHash: hash, relations,
      independentQa: { passed: true, executor: 'independent' }, independentImplementation: { implementationId: 'independent', sourceHash: hash, numeric: reference },
      tolerances: Object.fromEntries(Object.keys(reference).map(key => [key, { absoluteTolerance: 1e-9 }])) } };
  const pooled = 'w=[1/s["vi"] for s in studies]; sw=sum(w); fixed=sum(a*s["yi"] for a,s in zip(w,studies))/sw\n    q=sum(a*(s["yi"]-fixed)**2 for a,s in zip(w,studies)); c=sw-sum(a*a for a in w)/sw; tau=max(0.0,(q-(len(studies)-1))/c)\n    ws=[1/(s["vi"]+tau) for s in studies]; sws=sum(ws); est=sum(a*s["yi"] for a,s in zip(ws,studies))/sws; se=(1/sws)**0.5\n';
  const summary = '"pooled_log":est,"ci_lower_log":est-1.959963984540054*se,"ci_upper_log":est+1.959963984540054*se,"tau_squared":tau,"q_statistic":q,"n_studies":len(studies)';
  const delivered = text => ({ numeric: reference, assessmentEvidence: { deliveredText: [{ path: 'deliverables/paper-gold-analysis/analysis.py', text }] } });
  const controller = { execVerify: pythonExecVerify({}) };
  // The shape the live unit delivered: the pooled statistics, the rows in the order given, and which study weighs most.
  const withRows = await verifyPaperGoldCode({ unit: delivered(`def analyze(studies, **_):\n    ${pooled}    return {${summary},"max_weight_study":ws.index(max(ws)),"per_study":[{"yi":s["yi"],"vi":s["vi"],"random_weight":a} for a,s in zip(ws,studies)]}\n`), gold, controller });
  assert.equal(withRows.verified, true, withRows.reason); assert.equal(withRows.proof.behaviouralChecks, 2);
  // What the relations are for is unchanged. A function that recites the numbers it was shown fails the scaling...
  const recited = await verifyPaperGoldCode({ unit: delivered(`def analyze(**_):\n    return ${JSON.stringify(reference)}\n`), gold, controller });
  assert.deepEqual(recited, { verified: false, reason: 'behavioural_replay_failed' });
  // ...and one whose pooled statistics depend on the order of the studies fails the reordering: it replays the given
  // order exactly, scales as it should, and gives another answer for the same studies in another order.
  // (a position-weighted mean over the plain mean: unchanged by the scaling, changed by any reordering).
  const position = rows => rows.reduce((a, r, i) => a + (i + 1) * r.yi, 0) / rows.reduce((a, r) => a + r.yi, 0);
  const ordered = await verifyPaperGoldCode({ unit: delivered(`def analyze(studies, **_):\n    ${pooled}    position=sum((i+1)*s["yi"] for i,s in enumerate(studies))/sum(s["yi"] for s in studies)\n    est=est if abs(position-${JSON.stringify(position(studies))})<1e-9 else est*1.5\n    return {${summary}}\n`), gold, controller });
  assert.deepEqual(ordered, { verified: false, reason: 'behavioural_replay_failed' });
});
