// The campaign's read model (`presentCampaign`), pure over a stored row: what the lab page and the conversation read of a campaign the
// domain's own state machine ran to its stop on a deterministic fake engine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vcrCampaignAdvance, vcrCampaignInitialState, vcrCampaignManifest, vcrCampaignRecord, VCR_PREMISES_DECISIVE_MAX } from '@evimed/domain';
import { presentCampaign, refusedText, VcrExperiments, VCR_CAMPAIGN_STOP_TEXT_ZH } from '../src/vcrExperiments.mjs';

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

test('the design search says which efficacy hypotheses it simulated and a fixed alpha in percent, with no generic disclaimer and no engine words', () => {
  const view = presentCampaign(finished());
  const byKey = Object.fromEntries(view.premises.map((row) => [row.key, row]));
  assert.equal(byKey.alpha.value, '固定为 2.5%，搜索中不能放宽。');
  assert.equal(byKey['campaign:conditional'].value, '结果是在“alternative”“null”这 2 个疗效假设下模拟的；疗效假设变了，最优方案可能不同。');
  assert.doesNotMatch(Object.values(byKey).map((row) => row.value).join(''), /不估计药物的真实疗效|保守上界|新的随机数|真值情景/);
  assert.equal(view.objective.label.includes('_'), false);
  assert.equal(VCR_CAMPAIGN_STOP_TEXT_ZH.budget_exhausted, '计算预算已用完；已完成的方案保留。');
});

test('a refused arm reads in words, never as an error code', () => {
  assert.deepEqual(refusedText(['invalid_parameters', 'units_not_convertible']), ['这一组的参数不合法，无法计算。', '这一组里有单位无法换算，无法计算。']);
  assert.deepEqual(refusedText(['adapter_missing', 'something_new']), ['这一组的设置无法用所选方法计算。']);
  assert.deepEqual(refusedText(undefined), []);
  assert.equal(refusedText(['experiment_result_screening'])[0], '初筛的结果不能放进实验比较。');
  assert.match(VCR_CAMPAIGN_STOP_TEXT_ZH.inconclusive_at_precision, /无法确定是否满足/);
  assert.doesNotMatch(VCR_CAMPAIGN_STOP_TEXT_ZH.inconclusive_at_precision, /没有可行|no feasible/);
});

test('the design search\'s own measures have Chinese names', async () => {
  const { measureLabel } = await import('../src/vcrViewsKit.mjs');
  assert.equal(measureLabel('sample_size'), '样本量');
  assert.equal(measureLabel('cost'), '平均费用');
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

// --- the Alzheimer disease-response search ---------------------------------------------------------------------------------------------

const AD = { endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 100, nControl: 100 }, timeUnit: 'weeks', visits: [0, 26, 52, 78, 130],
  model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' } }, analysis: { kind: 'change', visit: 78, alpha: 0.05 } };

/** An Alzheimer search run to its stop on a fake engine whose power grows with the people enrolled. */
function finishedDisease() {
  const { manifest, issues } = vcrCampaignManifest({
    question: '最小入组', objective: { measure: 'total_sample_size', direction: 'minimize', truth: 'drug' },
    constraints: [{ measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'drug' }],
    space: { method: 'patients.progression', scenario: AD, truths: [{ name: 'drug', truth: { diseaseModifying: { fraction: { value: 0.3, basis: 'assumed' } } } }],
      candidates: [100, 200, 300].map((n) => ({ set: { 'design.nTreat': n, 'design.nControl': n } })) },
    stages: { final: { count: 3 } }, budget: { maxCandidates: 3, cpuSeconds: 1000 } });
  assert.deepEqual(issues, []);
  let state = vcrCampaignInitialState(manifest);
  for (let i = 0; i < 20; i++) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity: ID });
    state = next;
    if (action.type !== 'evaluate') break;
    const unit = action.unit, n = unit.scenario.design.nTreat * 2, p = Math.round((1 - Math.exp(-n / 250)) * 5000) / 5000;
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: unit.key, unit } }, unit, { jobId: `job_${unit.key}`, resultId: `res_${unit.key}`, state: 'succeeded', seed: unit.seed, replicates: 5000,
      measures: [{ name: 'power', value: p, mcse: Math.sqrt(p * (1 - p) / 5000), simulated: true, source: 'synthetic' }], cpuSeconds: 1, queueSeconds: 1, wallSeconds: 2 });
  }
  return { id: 'cmp_ad', kind: 'campaign', identity: ID, manifest, state, status: 'stopped', created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:10:00Z' };
}

test('an Alzheimer search shows the calculated enrolment, the smallest feasible size and the claims of the model in the one block', () => {
  const view = presentCampaign(finishedDisease());
  assert.equal(view.method, 'patients.progression');
  assert.deepEqual(view.candidates.map((c) => c.objective.final.value), [200, 400, 600].map((n) => n), 'enrolment is the scenario\'s own sum');
  assert.equal(view.best, 'c002', 'power 1 - exp(-n / 250): only 600 people clear 0.8');
  assert.equal(view.stop.reason, 'acceptable_precision');
  const keys = view.premises.map((row) => row.key);
  for (const key of ['campaign:bound', 'progression:ad:effect', 'progression:ad:parameters', 'progression:ad:scope', 'progression:ad:regulatory']) assert.ok(keys.includes(key), key);
  assert.ok(!keys.includes('campaign:conditional'), 'the model-conditional sentence is the Alzheimer one');
  assert.ok(view.premises.filter((row) => row.decisive).length <= VCR_PREMISES_DECISIVE_MAX);
  const scope = view.premises.find((row) => row.key === 'progression:ad:scope');
  assert.match(scope.value, /超过两年的部分是外推/, 'a candidate visit beyond two years is said to be an extrapolation');
  const text = view.premises.map((row) => `${row.label}${row.value}`).join('\n');
  assert.match(text, /不是对某个药物疗效的预测/);
  assert.match(text, /不适用于这里的计算/, 'no 2013 regulatory status is inherited');
  for (const banned of ['patients.progression', 'beta_logit', 'total_sample_size', 'job_', 'campaign']) assert.ok(!text.includes(banned), banned);
  assert.ok(!/「|」/.test(text));
});

test('a campaign undecided at its precision says so and what would decide it (review stats P1-1, P1-2)', () => {
  const { manifest } = vcrCampaignManifest(input);
  let state = vcrCampaignInitialState(manifest);
  for (let i = 0; i < 50; i++) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity: ID });
    state = next;
    if (action.type !== 'evaluate') break;
    const unit = action.unit, n = unit.scenario.design.nTreat, reps = unit.stage === 'screening' ? 400 : unit.truth === 'null' ? 20000 : 5000;
    // a test whose real size is at alpha: the conservative bound cannot pass it at 20,000 replicates
    const p = unit.truth === 'null' ? 0.025 : Math.round((1 - Math.exp(-n / 70)) * reps) / reps;
    const label = unit.stage === 'screening' ? { precision: 'screening' } : {};
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: unit.key, unit } }, unit, { jobId: `job_${unit.key}`, state: 'succeeded', seed: unit.seed, replicates: reps,
      measures: [{ name: unit.truth === 'null' ? 'type_one_error' : 'power', value: p, mcse: Math.sqrt(p * (1 - p) / reps), simulated: true, source: 'synthetic', ...label },
        { name: 'expected_sample_size', value: n * 2, mcse: 0, simulated: true, source: 'synthetic', ...label }], cpuSeconds: 1 });
  }
  const view = presentCampaign({ id: 'cmp_2', kind: 'campaign', identity: ID, manifest, state, status: 'stopped', created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:10:00Z' });
  assert.equal(view.stop.reason, 'inconclusive_at_precision');
  assert.equal(view.stop.text, VCR_CAMPAIGN_STOP_TEXT_ZH.inconclusive_at_precision);
  const undecided = view.candidates.filter((c) => c.constraints[1].final?.status === 'inconclusive');
  assert.ok(undecided.length > 0);
  assert.deepEqual(undecided[0].constraints[1].final.needed, { replicates: null, reason: 'estimate_at_bound' });
  assert.equal(undecided[0].constraints[1].final.calibration, null);
  // F4: the closest design with its undecided constraint, its value and error, and the advice for a rate sitting on its bound
  assert.equal(view.best, null);
  assert.ok(view.undecided.closest, 'the best of the designs no constraint failed');
  assert.equal(view.undecided.closest.constraints[0].measure, 'type_one_error');
  assert.equal(view.undecided.closest.constraints[0].estimate.value, 2.5, 'shown in percent like every simulated rate');
  assert.ok(view.undecided.closest.constraints[0].estimate.mcse > 0);
  const advice = view.undecided.advice.join('\n');
  assert.match(advice, /再多模拟几次也判断不出来/);
  assert.match(advice, /检验水准定得更低（例如 2\.2%，约束仍是 2\.5%）/);
  assert.match(advice, /模拟误差约 0\.11%/);
  assert.match(advice, /新的实验方案/);
  assert.doesNotMatch(advice, /增加复核次数/, 'more replicates are not offered where they cannot decide');
  assert.ok(!/「|」/.test(advice));
});

test('a rate near its bound is told how many more replicates would decide it, and a searched analysis level is said in the premise (F4)', () => {
  const { manifest } = vcrCampaignManifest({ ...input, space: { ...input.space, variables: [...input.space.variables, { path: 'analysis.alpha', values: [0.02, 0.025] }] },
    budget: { ...input.budget, maxCandidates: 200 } });
  assert.ok(manifest, 'the analysis level is accepted as a variable');
  const row = () => ({ id: 'cmp_3', kind: 'campaign', identity: ID, manifest, status: 'stopped', created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:10:00Z',
    state: { ...vcrCampaignInitialState(manifest), finalists: [], stop: { reason: 'inconclusive_at_precision' } } });
  const view = presentCampaign(row());
  const alpha = view.premises.find((premise) => premise.key === 'alpha');
  assert.match(alpha.value, /约束固定为 2\.5%.*检验水准也在搜索范围内/);
  assert.equal(view.constraints[1].bound, 0.025, 'the frozen constraint is what it was');
});

// --- the short form of a search (R10): startCampaign freezes what the domain compiles, and refuses what it cannot ---------------------------

const FORM = {
  method: 'design.simulate', scenario: input.space.scenario, nullTruth: { effect: 0, sd: 1 },
  vary: { 'design.nTreat+design.nControl': [[60, 60], [100, 100], [140, 140]] }, goal: { minimize: 'expected_sample_size', power: 0.8 },
};

test('a campaign starts from the short form and stores the manifest the domain compiled, evaluator included', async () => {
  /** @type {any[]} */
  const inserted = [];
  const store = { one: async (/** @type {string} */ _sql, /** @type {any[]} */ params) => { inserted.push(params); return { id: params[0] }; } };
  const experiments = new VcrExperiments({ store, jobs: null });
  experiments.advance = async () => {};
  experiments.view = async () => ({ kind: 'campaign' });
  const started = await experiments.startCampaign({ id: 'std_1', userId: 'u1' }, FORM, { userId: 'u1' });
  assert.equal(started.created, true);
  const stored = JSON.parse(inserted[0][4]);
  assert.equal(stored.constraints.find((/** @type {any} */ c) => c.kind === 'error_control').bound, 0.025, 'the frozen error-control bound is the scenario\'s own alpha');
  assert.equal(stored.space.truths.length, 2);
  // the same short form in the same study is the same campaign; a full manifest that compiles to it is too
  const again = await experiments.startCampaign({ id: 'std_1', userId: 'u1' }, JSON.parse(JSON.stringify(FORM)), { userId: 'u1' });
  assert.equal(inserted[1][0], inserted[0][0]);
  assert.equal(again.created, true);
});

test('a short form that cannot be searched is refused with its reason and starts nothing', async () => {
  const store = { one: async () => { throw new Error('nothing is stored for a refused form'); } };
  const experiments = new VcrExperiments({ store, jobs: null });
  await assert.rejects(experiments.startCampaign({ id: 'std_1', userId: 'u1' }, { ...FORM, vary: { 'analysis.alpha': [0.025, 0.05] } }, { userId: 'u1' }),
    (/** @type {any} */ error) => error.code === 'vcr_campaign_invalid' && /campaign_alpha_relaxed/.test(JSON.stringify(error.details ?? error.message ?? error)));
  await assert.rejects(experiments.startCampaign({ id: 'std_1', userId: 'u1' }, { ...FORM, vary: {} }, { userId: 'u1' }), { code: 'vcr_campaign_invalid' });
});
