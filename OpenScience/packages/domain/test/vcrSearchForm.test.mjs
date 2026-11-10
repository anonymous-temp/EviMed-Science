import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vcrCampaignFromInput, vcrSearchFromForm, vcrCampaignManifest, vcrCampaignCandidates, vcrCampaignCanonical } from '../src/vcrExperimentSearch.mjs'

const BASE = {
  design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'time_to_event' },
  truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { kind: 'uniform', duration: 12, followup: 12 },
  analysis: { method: 'logrank', alpha: 0.025, sided: 1 },
}
const form = (/** @type {any} */ over = {}) => ({
  question: 'Smallest two-arm trial', method: 'design.simulate', scenario: BASE,
  vary: { 'design.nTreat+design.nControl': [[80, 80], [120, 120], [160, 160]] },
  goal: { minimize: 'expected_sample_size', power: 0.8 }, ...over,
})
const compile = (/** @type {any} */ over = undefined) => vcrCampaignFromInput(form(over))
const codes = (/** @type {any} */ over = undefined) => compile(over).issues.map((issue) => `${issue.code}@${issue.field}`)

test('a short form compiles to a frozen manifest with the evaluator written by code', () => {
  const out = compile()
  assert.deepEqual(out.issues, [])
  assert.equal(out.compiled, true)
  const m = /** @type {Record<string, any>} */ (out.manifest)
  assert.deepEqual(m.objective, { measure: 'expected_sample_size', direction: 'minimize', truth: 'alternative' })
  assert.deepEqual(m.space.truths.map((/** @type {any} */ t) => t.name), ['alternative', 'null'])
  assert.equal(m.space.truths[1].truth.hazardRatio, 1, 'the null world is derived, not typed')
  const errorControl = m.constraints.find((/** @type {any} */ c) => c.kind === 'error_control')
  assert.equal(errorControl.bound, 0.025, 'the error-control bound is the scenario\'s own alpha')
  assert.equal(errorControl.truth, 'null')
  assert.ok(m.constraints.some((/** @type {any} */ c) => c.measure === 'power' && c.bound === 0.8 && c.op === '>='))
  assert.equal(m.stages.screening.replicates, 500)
  assert.equal(m.stages.final.count, 3)
  assert.equal(m.budget.maxCandidates, 3)
  assert.ok(m.budget.cpuSeconds > 0 && m.budget.modelCalls === 0)
  // R36/D6: a simulated search with a screening stage spends its budget sequentially and its screening share by OCBA
  assert.deepEqual([m.budget.allocation, m.budget.screening], ['sequential', 'ocba'])
  assert.equal(vcrCampaignCandidates(m).length, 3)
  // paths that move together are rows, not a cartesian product
  assert.deepEqual(vcrCampaignCandidates(m).map((c) => c.set), [
    { 'design.nTreat': 80, 'design.nControl': 80 }, { 'design.nTreat': 120, 'design.nControl': 120 }, { 'design.nTreat': 160, 'design.nControl': 160 }])
})

test('a range on paths that move together is the same value for each path at every step', () => {
  // live R39 (2026-11-09): {from: 100, to: 300, step: 1} on design.nTreat+design.nControl was refused; the people per arm of two arms are one number
  const out = compile({ vary: { 'design.nTreat+design.nControl': { from: 100, to: 120, step: 10 } } })
  assert.deepEqual(out.issues, [])
  assert.deepEqual(vcrCampaignCandidates(/** @type {any} */ (out.manifest)).map((c) => c.set),
    [100, 110, 120].map((n) => ({ 'design.nTreat': n, 'design.nControl': n })))
  assert.ok(codes({ vary: { 'design.nTreat+design.nControl': { from: 100, to: 90, step: 10 } } }).includes('search_form_vary@vary.design.nTreat+design.nControl'), 'a bad range is still refused')
})

test('the same form is the same campaign, and a form equals the manifest it compiles to', () => {
  const a = /** @type {any} */ (compile().manifest)
  const b = /** @type {any} */ (compile({ question: 'Smallest two-arm trial' }).manifest)
  assert.equal(vcrCampaignCanonical(a), vcrCampaignCanonical(b))
  const again = vcrSearchFromForm(form())
  assert.deepEqual(vcrCampaignManifest(again.input).manifest, a, 'compiling is a pure function; a full manifest passes through the same freeze')
  assert.equal(vcrCampaignFromInput(again.input).compiled, false, 'a manifest (it has space) is not recompiled')
})

test('a range expands by code and an independent variable makes a grid', () => {
  const m = /** @type {any} */ (compile({ vary: { 'design.nTreat': { from: 80, to: 160, step: 40 }, 'accrual.duration': [12, 18] } }).manifest)
  assert.deepEqual(m.space.variables, [{ path: 'design.nTreat', values: [80, 120, 160] }, { path: 'accrual.duration', values: [12, 18] }])
  assert.equal(m.budget.maxCandidates, 6)
  const fine = /** @type {any} */ (compile({ vary: { 'analysis.alpha': { from: 0.01, to: 0.025, step: 0.005 } } }).manifest)
  assert.deepEqual(fine.space.variables[0].values, [0.01, 0.015, 0.02, 0.025], 'no floating-point drift in a range')
})

test('the alpha constraint is never loosened by a form', () => {
  assert.ok(codes({ vary: { 'analysis.alpha': [0.025, 0.05] } }).includes('campaign_alpha_relaxed@space.variables[0].values'))
  assert.ok(codes({ vary: { 'truth.hazardRatio': [0.6, 0.7] } }).some((c) => c.startsWith('campaign_value_frozen')))
  assert.ok(codes({ vary: { 'analysis.sided': [1, 2] } }).some((c) => c.startsWith('campaign_value_frozen')))
  // the form has no place to state a constraint of its own kind or a bound for the type I error
  assert.ok(codes({ constraints: [{ measure: 'type_one_error', op: '<=', bound: 0.2, kind: 'error_control', truth: 'null' }] }).includes('search_form_field_unknown@constraints'))
  assert.ok(codes({ goal: { minimize: 'expected_sample_size', typeOneError: 0.2 } }).includes('search_form_field_unknown@goal.typeOneError'))
  // a base scenario at alpha 0.05 holds the frozen bound at 0.05, not at the 0.025 default
  const wide = /** @type {any} */ (compile({ scenario: { ...BASE, analysis: { ...BASE.analysis, alpha: 0.05 } } }).manifest)
  assert.equal(wide.constraints.find((/** @type {any} */ c) => c.kind === 'error_control').bound, 0.05)
  // and atMost/atLeast can only add a design requirement, never an error-control one
  const extra = /** @type {any} */ (compile({ goal: { minimize: 'expected_sample_size', power: 0.9, atMost: { type_one_error: 0.2 } } }).manifest)
  assert.ok(extra.constraints.filter((/** @type {any} */ c) => c.kind === 'error_control').every((/** @type {any} */ c) => c.bound === 0.025))
})

test('a form that cannot be searched is refused with its reason', () => {
  assert.ok(codes({ vary: {} }).includes('search_form_vary@vary'))
  assert.ok(codes({ vary: { 'design.nTreat': { from: 10, to: 5, step: 1 } } }).includes('search_form_vary@vary.design.nTreat'))
  assert.ok(codes({ vary: { 'design.nTreat': { from: 1, to: 500, step: 1 } } }).includes('search_form_vary@vary.design.nTreat'), 'more than 50 values')
  assert.ok(codes({ vary: { 'design.nTreat': { from: 10, to: 210, step: 1 }, 'accrual.duration': { from: 6, to: 40, step: 1 } } }).some((c) => c.startsWith('search_form_vary') || c.startsWith('campaign_space_exceeds_budget')))
  assert.ok(codes({ goal: { minimize: 'expected_sample_size', maximize: 'power' } }).includes('search_form_goal@goal'))
  assert.ok(codes({ goal: { minimize: 'win_ratio', power: 0.8 } }).includes('campaign_measure_unknown@objective.measure'))
  assert.ok(codes({ goal: { minimize: 'expected_sample_size', power: 1.4 } }).includes('search_form_goal@goal.power'))
  assert.ok(codes({ scenario: {} }).includes('search_form_scenario@scenario'))
  assert.ok(codes({ method: 'design.nothing' }).includes('campaign_method_unsupported@method'))
  assert.ok(codes({ scenario: { ...BASE, truth: { hazardRatio: 1, controlMedian: 12 } } }).includes('search_form_scenario@scenario.truth'), 'no effect to design for')
  assert.ok(codes({ scenario: { ...BASE, design: { kind: 'single_arm' } } }).includes('search_form_null_truth@nullTruth'))
  assert.ok(codes({ vary: { 'design.nTreat+design.nControl': [[80, 80], [120]] } }).includes('search_form_vary@vary.design.nTreat+design.nControl'))
  assert.ok(codes({ extra: 1 }).includes('search_form_field_unknown@extra'))
  assert.equal(compile({ vary: {} }).manifest, null)
})

test('the budget follows the space and a stated budget is kept', () => {
  const m = /** @type {any} */ (compile({ budget: { maxCandidates: 10, cpuSeconds: 900 } }).manifest)
  assert.deepEqual([m.budget.maxCandidates, m.budget.cpuSeconds], [10, 900])
  assert.ok(codes({ budget: { maxCandidates: 2 } }).includes('campaign_space_exceeds_budget@budget.maxCandidates'))
  assert.ok(codes({ budget: { modelCalls: 5 } }).includes('search_form_field_unknown@budget.modelCalls'))
})

test('a dose search, an exact search and a disease search compile on their own worlds', () => {
  const dose = vcrCampaignFromInput({ method: 'design.dose', scenario: { design: { kind: 'boin', targetToxicity: 0.3, cohortSize: 3, maxPatients: 30 }, truth: { toxicity: [0.05, 0.12, 0.3, 0.45] } },
    vary: { 'design.kind': ['boin', 'keyboard'], 'design.cohortSize': [1, 3] }, goal: { maximize: 'correct_dose_probability', atMost: { patients_above_mtd: 6 } } })
  assert.deepEqual(dose.issues, [])
  const d = /** @type {any} */ (dose.manifest)
  assert.deepEqual(d.constraints.map((/** @type {any} */ c) => c.kind), ['safety'])
  assert.equal(d.space.truths[0].name, 'curve')
  const exact = vcrCampaignFromInput({ method: 'design.analytic', scenario: { design: { kind: 'two_arm_fixed', allocation: 0.5 }, endpoint: { type: 'time_to_event' },
    truth: { hazardRatio: 0.7, controlMedian: 12 }, analysis: { alpha: 0.025, power: 0.8, sided: 1 }, accrual: { duration: 12, followup: 12 } },
  vary: { 'design.allocation': [0.5, 0.6] }, goal: { minimize: 'required_patients', atMost: { required_events: 330 } } })
  assert.deepEqual(exact.issues, [])
  assert.equal(/** @type {any} */ (exact.manifest).stages.screening, null)
  // R36/D6: a simulated search spends its screening share by OCBA; an exact one has no screening, so neither the allocation nor OCBA applies
  assert.equal(/** @type {any} */ (exact.manifest).budget.screening, undefined)
  assert.equal(/** @type {any} */ (exact.manifest).budget.allocation, undefined)
  const disease = vcrCampaignFromInput({ method: 'patients.progression',
    scenario: { design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, population: { mmseRange: { value: [16, 26], basis: 'assumed' } }, analysis: { kind: 'change', visit: 78, alpha: 0.05 },
      treatment: { symptomatic: { pointsAt: { value: 2, basis: 'assumed' } } } },
    vary: { 'design.nTreat+design.nControl': [[100, 100], [200, 200]] }, goal: { minimize: 'total_sample_size' } })
  const dm = /** @type {any} */ (disease.manifest)
  assert.deepEqual(disease.issues.length ? disease.issues : [], [], JSON.stringify(disease.issues))
  assert.deepEqual(dm.space.truths.map((/** @type {any} */ t) => t.name), ['drug', 'none'])
  assert.equal(dm.space.scenario.treatment, undefined)
  assert.equal(dm.constraints.find((/** @type {any} */ c) => c.kind === 'error_control').bound, 0.05)
  // a disease search without a screening stage takes neither the sequential allocation nor OCBA screening
  assert.deepEqual([dm.budget.allocation, dm.budget.screening], [undefined, undefined])
  assert.equal(dm.stages.screening, null)
})
