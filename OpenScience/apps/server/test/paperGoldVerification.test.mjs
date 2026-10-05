import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, scoreUnit } from '../../../evals/paper-gold/evaluator.mjs';
import { verifyPaperGoldCode, bindPaperGoldReview, bindPaperGoldStageAssessment } from '../src/paperGoldVerification.mjs';
const hash = 'a'.repeat(64);
function fixture() {
  const input = { values: [1, 2] };
  const gold = { type: 'method', sourceHash: hash, numeric: { total: { value: 4, absoluteTolerance: 0 } }, preservedEvidence: [{ id: 'primary', sourceHash: hash, numericQuotes:['Synthetic published worked example: values 1 and 2; stated total 4.'] }],
    stageChecks: { method: ['method_supported'] }, deterministicVerification: { entrypoint: 'scripts/analysis.py:analyze', implementationId: 'platform', input, inputHash: digest(input), sourceHash: hash,
      independentQa: { passed: true, executor: 'independent-base-R' }, independentImplementation: { implementationId: 'base-R', sourceHash: hash, numeric: { total: 3 } }, tolerances: { total: { absoluteTolerance: 0 } } } };
  const unit = { numeric: { total: 3 }, checks: { method_supported: true }, modelFamily: 'deepseek', assessmentEvidence: { deliveredText: [{ path: 'scripts/analysis.py', text: 'def analyze(values):\n    return {"total": sum(values)}\n' }] } };
  return { gold, unit };
}
const response = { model: 'qwen3.5-plus', modelReported: true, value: { verdict: 'paper_error', evidenceIds: ['primary'], reason: 'Independent arithmetic and published number disagree.' } };

test('actual isolated replay against independent reference can validate code without forcing incorrect paper agreement', async () => {
  const { unit, gold } = fixture(); let calls = 0;
  const verification = await verifyPaperGoldCode({ unit, gold, controller: { execVerify: async request => {
    calls++; assert.deepEqual(request.input, { values: [1, 2] }); assert.match(request.code, /runpy.run_path/);
    return { ok: true, joined: true, executionStarted: true, output: '{"total":3}' };
  } } });
  assert.equal(calls, 2); assert.equal(verification.verified, true);
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
