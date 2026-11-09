// Round 2, R23 and R25: the people table and the effect distribution as the domain states them (the scenario schema, the method version they
// need, the comparison that names a record) and the launch record that replaced the dormant one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as domain from '../index.mjs'
import { vcrDesignExperiment, vcrDesignExperimentCanonical, VCR_DISEASE_EXPERIMENT_ALIGNED_FIELDS } from '../src/vcrExperiment.mjs'
import { validateEngineJob, VCR_ENGINE_METHODS } from '../src/vcrEngineJob.mjs'
import { validateScenario, VCR_PEOPLE_MODES, VCR_PROGRESSION_PARAMETER_SETS } from '../src/vcrScenarioSchemas.mjs'

const methods = VCR_ENGINE_METHODS
const ad = (/** @type {any} */ treatment = {}, /** @type {any} */ over = {}) => ({
  endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 60, nControl: 60 }, timeUnit: 'weeks', visits: [0, 26, 52],
  model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' } }, treatment, ...over,
})
const SOURCE = { kind: 'literature', citation: 'a published effect estimate' }
const dist = (/** @type {string} */ family, /** @type {any} */ parameters, /** @type {string} */ tier = 'A') => ({ distribution: { family, parameters, source: SOURCE, tier } })
const codes = (/** @type {readonly any[]} */ issues) => issues.map((i) => `${i.code}@${i.field}`)
const sym = (/** @type {any} */ pointsAt) => ({ symptomatic: { pointsAt, atWeek: 26, referenceAdas: 25, et50Weeks: { value: 8, basis: 'assumed' } } })

test('the progression method is 1.2.0 and still reads what 1.0.0 and 1.1.0 wrote', () => {
  const spec = /** @type {any} */ (methods)['patients.progression']
  assert.equal(spec.version, '1.2.0')
  assert.deepEqual([...spec.compatibleVersions], ['1.0.0', '1.1.0'])
  assert.deepEqual(VCR_PEOPLE_MODES, ['paired_counterfactual', 'resampled_trials'])
  assert.deepEqual(VCR_PROGRESSION_PARAMETER_SETS, { 'camd-adas-cog-11': 'adsim-3.0' })
})

test('an effect is a number with its basis, or a distribution with its family, parameters, source and tier, never both', () => {
  const run = (/** @type {any} */ treatment) => codes(validateScenario('patients.progression', ad(treatment)))
  assert.deepEqual(run(sym({ value: -2.5, basis: 'assumed' })), [], 'the number as before')
  assert.deepEqual(run(sym(dist('normal', { mean: -2, sd: 1 }))), [])
  assert.deepEqual(run({ diseaseModifying: { fraction: dist('beta', { shape1: 2, shape2: 8 }, 'B') } }), [])
  for (const [family, parameters] of /** @type {Array<[string, any]>} */ ([['fixed', { value: -2 }], ['normal', { mean: 0, sd: 1 }], ['truncated_normal', { mean: 0, sd: 1, lower: -3, upper: 3 }], ['lognormal', { meanlog: 0, sdlog: 1 }],
    ['beta', { shape1: 1, shape2: 1 }], ['uniform', { min: -3, max: -1 }], ['empirical_draws', { values: [-1, -2, -3] }]])) {
    assert.deepEqual(run(sym(dist(family, parameters))), [], family)
  }
  const missing = (/** @type {string} */ part) => { const e = dist('normal', { mean: -2, sd: 1 }); delete (/** @type {any} */ (e.distribution))[part]; return run(sym(e)) }
  assert.deepEqual(missing('source'), ['scenario_field_missing@scenario.treatment.symptomatic.pointsAt.distribution.source'])
  assert.deepEqual(missing('tier'), ['scenario_field_missing@scenario.treatment.symptomatic.pointsAt.distribution.tier'])
  assert.deepEqual(run(sym(dist('normal', { mean: -2 }))), ['scenario_field_missing@scenario.treatment.symptomatic.pointsAt.distribution.parameters.sd'])
  assert.equal(run(sym(dist('normal', { mean: -2, sd: 1 }, 'Z')))[0].split('@')[0], 'scenario_value_invalid')
  assert.ok(run(sym({ value: -2, basis: 'assumed', ...dist('normal', { mean: -2, sd: 1 }) })).length > 0, 'a number and a distribution together')
  assert.ok(run(sym({ distribution: { family: 'normal', parameters: { mean: -2, sd: 1 }, source: { kind: 'stated' }, tier: 'stated' } })).length > 0, 'a source names a citation, an object or a note')
  assert.ok(run(sym({ distribution: { family: 'cauchy', parameters: {}, source: SOURCE, tier: 'A' } })).length > 0, 'a family outside the closed list')
  // a parameter of another family is not a key of this one
  assert.ok(run(sym(dist('normal', { mean: -2, sd: 1, shape1: 2 }))).length > 0)
})

test('a people table and the instantiate step are beta_logit scenarios of their own shape', () => {
  const people = { inputId: 'res_1:progression-people', mode: 'paired_counterfactual' }
  const base = ad(sym({ value: -2.5, basis: 'assumed' }), { people })
  assert.deepEqual(codes(validateScenario('patients.progression', base)), [])
  const { design: _d, ...paired } = base
  assert.deepEqual(codes(validateScenario('patients.progression', paired)), [], 'a paired run needs no group sizes: it runs everyone in the record')
  const { design: _e, ...resampled } = { ...base, people: { ...people, mode: 'resampled_trials' } }
  assert.deepEqual(codes(validateScenario('patients.progression', resampled)), ['scenario_field_missing@scenario.design'], 'a resampled run needs them')
  assert.ok(codes(validateScenario('patients.progression', { ...base, people: { ...people, mode: 'everyone' } })).length > 0)
  const inst = { timeUnit: 'weeks', model: base.model, instantiate: { n: 400 } }
  assert.deepEqual(codes(validateScenario('patients.progression', inst)), [], 'the step states no endpoint, design or visits')
  assert.deepEqual(codes(validateScenario('patients.progression', { ...inst, instantiate: { covariates: { inputId: 'x', columns: { mmse: 'MMSE' } } } })).filter((c) => !c.includes('inputId')), [])
  assert.ok(codes(validateScenario('patients.progression', { ...inst, instantiate: {} })).length > 0, 'n or a population table')
  assert.ok(codes(validateScenario('patients.progression', { timeUnit: 'weeks', model: { family: 'linear' }, instantiate: { n: 3 } })).length > 0, 'the other families have no record')
})

test('a job that uses the 1.2.0 features is refused under an older label and accepted at 1.2.0', () => {
  const job = (/** @type {any} */ scenario, /** @type {string} */ methodVersion) => ({ jobId: 'j1', studyId: 's1', kind: 'generate_progression', method: 'patients.progression', methodVersion, protocolVersion: 1, seed: 1,
    cpuSecondsLimit: 60, scenario, inputs: [{ kind: 'assumption', id: 'a_1@1' }] })
  const distributed = ad(sym(dist('normal', { mean: -2, sd: 1 })))
  assert.deepEqual(validateEngineJob(job(distributed, '1.2.0')), [])
  assert.ok(codes(validateEngineJob(job(distributed, '1.1.0'))).some((c) => c.startsWith('method_version_mismatch')))
  assert.ok(codes(validateEngineJob(job(distributed, '1.0.0'))).some((c) => c.startsWith('method_version_mismatch')))
  // a 1.1.0 scenario keeps its label
  assert.deepEqual(validateEngineJob(job(ad(sym({ value: -2.5, basis: 'assumed' })), '1.1.0')), [])
})

test('a comparison names a record of people and how the arms use it; it is frozen with the record and the mode', () => {
  const arms = (/** @type {any} */ over = {}) => [{ name: 'none', method: 'patients.progression', scenario: ad({}, over) }, { name: 'symptomatic', method: 'patients.progression', scenario: ad(sym({ value: -2.5, basis: 'assumed' }), over) }]
  const input = (/** @type {any} */ people, /** @type {any} */ over = undefined) => ({ question: 'q', arms: arms(over), comparison: { measures: ['power'], reference: 'none' }, ...(people ? { people } : {}) })
  const frozen = vcrDesignExperiment(input({ recordId: 'res_1', mode: 'paired_counterfactual' }), { methods })
  assert.deepEqual(frozen.issues, [])
  assert.deepEqual(frozen.record?.people, { recordId: 'res_1', mode: 'paired_counterfactual' })
  const bytes = (/** @type {any} */ people = undefined) => vcrDesignExperimentCanonical(/** @type {any} */ (vcrDesignExperiment(input(people), { methods }).record))
  assert.notEqual(bytes({ recordId: 'res_1', mode: 'paired_counterfactual' }), bytes({ recordId: 'res_1', mode: 'resampled_trials' }), 'another mode is another experiment')
  assert.notEqual(bytes({ recordId: 'res_1', mode: 'resampled_trials' }), bytes({ recordId: 'res_2', mode: 'resampled_trials' }), 'another record is another experiment')
  assert.notEqual(bytes({ recordId: 'res_1', mode: 'resampled_trials' }), bytes(undefined), 'with and without a record')
  assert.equal(vcrDesignExperiment(input(undefined), { methods }).record?.people, undefined, 'no people key when none is named')
  const bad = (/** @type {any} */ people, /** @type {any} */ over = undefined) => codes(vcrDesignExperiment(input(people, over), { methods }).issues)
  assert.deepEqual(bad({ recordId: 'bad id', mode: 'resampled_trials' }), ['experiment_value_invalid@people.recordId'])
  assert.deepEqual(bad({ recordId: 'res_1', mode: 'all' }), ['experiment_value_invalid@people.mode'])
  assert.deepEqual(bad({ recordId: 'res_1', mode: 'resampled_trials' }, { population: { mmseRange: { value: [16, 26], basis: 'assumed' } } }).filter((c) => c.startsWith('experiment_people_conflict')).length, 2, 'both arms')
  assert.deepEqual(bad({ recordId: 'res_1', mode: 'resampled_trials' }, { model: { ...ad().model, uncertainty: 'new_study' } }).filter((c) => c.startsWith('experiment_people_conflict')).length, 2)
  const design = { question: 'q', arms: ['a', 'b'].map((name) => ({ name, method: 'design.simulate', scenario: { design: { kind: 'two_arm_fixed', nTreat: 50, nControl: 50 }, endpoint: { type: 'continuous' }, truth: { effect: 0.5, sd: 1 }, analysis: { method: 'ttest', alpha: 0.025, sided: 1 } } })),
    comparison: { measures: ['power'], reference: 'a' }, people: { recordId: 'res_1', mode: 'paired_counterfactual' } }
  assert.deepEqual(codes(vcrDesignExperiment(design, { methods }).issues), ['experiment_people_unsupported@people'])
  assert.ok(VCR_DISEASE_EXPERIMENT_ALIGNED_FIELDS.includes('population'), 'the same people are still an aligned definition')
})

test('the dormant launch record is gone: one experiment record exists and it is the design experiment\'s', () => {
  for (const name of ['vcrExperimentRecord', 'vcrExperimentIssues', 'vcrExperimentCanonical', 'VCR_EXPERIMENT_FIELDS']) assert.equal(/** @type {any} */ (domain)[name], undefined, name)
  assert.equal(typeof domain.vcrDesignExperiment, 'function')
  assert.equal(typeof domain.vcrDesignExperimentCanonical, 'function')
})
