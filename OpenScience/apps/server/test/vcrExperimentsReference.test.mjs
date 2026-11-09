// A comparison whose reference arm has no result (refused at enqueue, or failed) says its contrasts are unassessed; it never shows an
// empty contrast list as if there were nothing to compare (round 2, F06: the same defect class as a campaign's screened-out reference).
// The campaign read model carries the reference-only role the same way.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vcrCampaignAdvance, vcrCampaignInitialState, vcrCampaignManifest, vcrCampaignRecord } from '@evimed/domain';
import { presentCampaign, VcrExperiments } from '../src/vcrExperiments.mjs';

const study = { id: 'study_1' };
const result = { id: 'res_b', executionId: null, measures: [{ name: 'power', value: 0.8, mcse: 0.004, simulated: true }], diagnostics: {} };
const experiments = (/** @type {Record<string, any>} */ arms) => new VcrExperiments({ store: {
  one: async () => ({ id: 'exp_1', kind: 'experiment', manifest: { kind: 'design', question: 'q', purpose: 'p', arms: [{ name: 'A', scenario: {} }, { name: 'B', scenario: {} }],
    comparison: { measures: ['power'], reference: 'A' } }, state: { arms } }),
  result: async (/** @type {string} */ _s, /** @type {string} */ id) => (id === 'res_b' ? result : null),
  resultOfJob: async () => null,
}, jobs: null });

test('a refused reference leaves every contrast unassessed and says so', async () => {
  const view = /** @type {any} */ (await experiments({ A: { refused: { code: 'unsupported' } }, B: { resultId: 'res_b' } }).view(study, 'exp_1'));
  const contrasts = view.comparison[0].contrasts;
  assert.equal(contrasts.length, 1, 'the other arm still has its row');
  assert.equal(contrasts[0].coupling, 'reference_unavailable');
  assert.equal(contrasts[0].difference, null);
  assert.match(contrasts[0].couplingText, /对照方案没有算出结果/);
});

test('a campaign candidate kept only as the reference reads as a comparison, not a result', () => {
  const { manifest } = vcrCampaignManifest({ question: 'q', objective: { measure: 'power', direction: 'maximize', truth: 'alternative' }, reference: 0,
    constraints: [{ measure: 'power', op: '>=', bound: 0.5, kind: 'design', truth: 'alternative' }],
    space: { method: 'design.simulate', scenario: { design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'continuous' }, truth: { effect: 0.4, sd: 1 }, analysis: { method: 'ttest', alpha: 0.025, sided: 1 } },
      truths: [{ name: 'alternative', truth: { effect: 0.4, sd: 1 } }, { name: 'null', truth: { effect: 0, sd: 1 } }], variables: [{ path: 'design.nTreat', values: [60, 140] }] },
    stages: { screening: { replicates: 400 }, final: { count: 1 } }, budget: { maxCandidates: 2, cpuSeconds: 1000 }, stopRules: { minImprovement: 0.01 } });
  const identity = 'c'.repeat(64);
  let state = vcrCampaignInitialState(manifest);
  for (let i = 0; i < 20; i++) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity });
    state = next;
    if (action.type !== 'evaluate') break;
    const unit = action.unit, p = unit.candidate === 'c000' ? (unit.stage === 'screening' ? 0.1 : 0.55) : 0.8, reps = unit.stage === 'screening' ? 400 : 20000;
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: unit.key, unit } }, unit, { jobId: `j_${unit.key}`, resultId: `r_${unit.key}`, state: 'succeeded', seed: unit.seed, replicates: reps,
      measures: [{ name: 'power', value: p, mcse: Math.sqrt(p * (1 - p) / reps), simulated: true, source: 'synthetic' }], cpuSeconds: 1, queueSeconds: 1, wallSeconds: 1 });
  }
  const view = presentCampaign({ id: 'cmp_1', kind: 'campaign', identity, manifest, state, status: 'stopped', created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T00:01:00Z' });
  assert.equal(view.best, 'c001');
  assert.equal(view.candidates.find((c) => c.key === 'c000')?.statusText, '仅作对照');
  assert.ok(view.improvement != null && view.improvementBound?.basis === 'independent_error');
});
