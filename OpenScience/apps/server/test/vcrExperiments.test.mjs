// The campaign's read model (`presentCampaign`), pure over a stored row: what the lab page and the conversation read of a campaign the
// domain's own state machine ran to its stop on a deterministic fake engine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vcrCampaignAdvance, vcrCampaignInitialState, vcrCampaignManifest, vcrCampaignRecord, VCR_PREMISES_DECISIVE_MAX } from '@evimed/domain';
import { presentCampaign, VCR_CAMPAIGN_STOP_TEXT_ZH } from '../src/vcrExperiments.mjs';

const ID = 'b'.repeat(64);
const input = {
  question: '最小样本量',
  objective: { measure: 'expected_sample_size', direction: 'minimize', truth: 'alternative' },
  constraints: [{ measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' },
    { measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null' }],
  space: { method: 'design.simulate', scenario: { design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'continuous' },
    truth: { effect: 0.4, sd: 1 }, analysis: { method: 'ttest', alpha: 0.025, sided: 1 } },
  truths: [{ name: 'alternative', truth: { effect: 0.4, sd: 1 } }, { name: 'null', truth: { effect: 0, sd: 1 } }],
  variables: [{ path: 'design.nTreat', values: [60, 100, 140, 180] }] },
  stages: { screening: { replicates: 400 }, final: { count: 2 } },
  budget: { maxCandidates: 4, cpuSeconds: 1000 }, reference: 3,
};

/** Run to the stop with a fake engine: power by size, a type I error of 0.02. */
function finished() {
  const { manifest } = vcrCampaignManifest(input);
  let state = vcrCampaignInitialState(manifest);
  for (let i = 0; i < 50; i++) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity: ID });
    state = next;
    if (action.type !== 'evaluate') break;
    const unit = action.unit, n = unit.scenario.design.nTreat, reps = unit.stage === 'screening' ? 400 : unit.truth === 'null' ? 20000 : 5000;
    const p = unit.truth === 'null' ? 0.02 : Math.round((1 - Math.exp(-n / 70)) * reps) / reps;
    const label = unit.stage === 'screening' ? { precision: 'screening' } : {};
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: unit.key, unit } }, unit, { jobId: `job_${unit.key}`, resultId: `res_${unit.key}`, state: 'succeeded', seed: unit.seed, replicates: reps,
      measures: [{ name: unit.truth === 'null' ? 'type_one_error' : 'power', value: p, mcse: Math.sqrt(p * (1 - p) / reps), simulated: true, source: 'synthetic', ...label },
        { name: 'expected_sample_size', value: n * 2, mcse: 0, simulated: true, source: 'synthetic', ...label }], cpuSeconds: 1, queueSeconds: 2, wallSeconds: 3 });
  }
  return { id: 'cmp_1', kind: 'campaign', identity: ID, manifest, state, status: 'stopped', created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:10:00Z' };
}

test('the read model lists every candidate with its stage, objective, verdicts and the bound each was judged at', () => {
  const view = presentCampaign(finished());
  assert.equal(view.stop.reason, 'acceptable_precision');
  assert.equal(view.stop.text, VCR_CAMPAIGN_STOP_TEXT_ZH.acceptable_precision);
  assert.equal(view.candidates.length, 4);
  const small = view.candidates.find((c) => c.key === 'c000');
  assert.equal(small.status, 'eliminated');
  assert.match(small.reasonText, /初筛时功效已明显不满足约束/);
  const best = view.candidates.find((c) => c.key === view.best);
  assert.equal(best.stage, 'final');
  assert.equal(best.objective.final.stage, 'final');
  assert.equal(best.objective.screening.stage, 'screening', 'the screening number is shown as screening, beside the final one');
  const [power, alpha] = best.constraints;
  assert.equal(power.screening.final, false, 'a screening verdict is provisional');
  assert.equal(power.final.status, 'pass');
  assert.equal(power.final.boundKind, 'clopper_pearson');
  assert.equal(power.final.judgedAt.unit, '%');
  assert.equal(alpha.screening, null, 'the null truth is not screened: error control is judged on final runs only');
  assert.equal(alpha.final.status, 'pass');
  assert.ok(view.budget.used.queueSeconds > 0 && view.budget.used.units === view.candidates.reduce((n, c) => n + c.resultIds.length, 0));
  assert.ok(view.againstReference && view.againstReference.difference.value < 0, 'the best design is smaller than the reference');
});

test('the premises block holds the fixed alpha, the two precisions and the model-conditional reading, at most five decisive and no back-office words', () => {
  const view = presentCampaign(finished());
  const keys = view.premises.map((row) => row.key);
  for (const key of ['alpha', 'campaign:precision', 'campaign:bound', 'campaign:conditional']) assert.ok(keys.includes(key), key);
  assert.ok(view.premises.filter((row) => row.decisive).length <= VCR_PREMISES_DECISIVE_MAX);
  const words = [...view.premises.map((row) => `${row.label}${row.value}`), view.stop.text, ...view.candidates.map((c) => `${c.statusText}${c.reasonText ?? ''}`)].join('\n');
  for (const banned of ['virtual_trial', 'job_', 'design.simulate', 'screeningReplicates', 'experiment_candidate', 'campaign', 'MCSE']) assert.ok(!words.includes(banned), banned);
  assert.ok(!/「|」/.test(words), 'UI copy quotes with “”');
});
