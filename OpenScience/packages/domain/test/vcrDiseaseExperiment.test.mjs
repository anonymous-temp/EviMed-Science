import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  vcrDesignExperiment, vcrDesignExperimentCanonical, vcrExperimentAlignment, vcrDiseaseHypothesis, VCR_DISEASE_EXPERIMENT_ALIGNED_FIELDS,
} from '../src/vcrExperiment.mjs'
import {
  vcrCampaignManifest, vcrCampaignCandidates, vcrCampaignUnit, vcrCampaignInitialState, vcrCampaignAdvance, vcrCampaignRecord,
  vcrCampaignVerdict, vcrScenarioDerivedMeasures,
} from '../src/vcrExperimentSearch.mjs'
import { validateEngineJob, VCR_ENGINE_METHODS } from '../src/vcrEngineJob.mjs'

const methods = VCR_ENGINE_METHODS
const ID = 'b'.repeat(64)

/** The Alzheimer trial the lab runs: the CAMD model, 78 weeks, with the drug hypothesis `treatment` the arm states. */
const ad = (/** @type {any} */ treatment = {}, /** @type {any} */ over = {}) => ({
  endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 200, nControl: 200 }, timeUnit: 'weeks', visits: [0, 13, 26, 39, 52, 65, 78],
  model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' }, uncertainty: 'new_study' },
  population: { mmseRange: { value: [16, 26], basis: 'assumed' } }, treatment, analysis: { kind: 'change', visit: 78, alpha: 0.05 }, ...over,
})
const SYMPTOMATIC = { symptomatic: { pointsAt: { value: -2.5, basis: 'assumed' }, atWeek: 24, referenceAdas: 25, et50Weeks: { value: 1, basis: 'assumed' } } }
const MODIFYING = { diseaseModifying: { fraction: { value: 0.3, basis: 'assumed' } } }
const three = { question: 'What does each kind of drug effect do to the same trial?', arms: [
  { name: '安慰剂', method: 'patients.progression', scenario: ad({}) },
  { name: '对症假设', method: 'patients.progression', scenario: ad(SYMPTOMATIC) },
  { name: '改病假设', method: 'patients.progression', scenario: ad(MODIFYING) }],
comparison: { measures: ['expected_difference', 'simulated_difference'], reference: '安慰剂' } }

test('three named Alzheimer arms freeze as one disease experiment and every arm is a job the engine accepts', () => {
  const { record, issues } = vcrDesignExperiment(three, { methods })
  assert.deepEqual(issues, [])
  assert.equal(record?.kind, 'disease')
  assert.equal(record?.arms[1].version, methods['patients.progression'].version)
  for (const arm of /** @type {any[]} */ (record?.arms ?? [])) {
    const job = { jobId: 'job_x', studyId: 'std_x', kind: 'generate_progression', method: arm.method, methodVersion: arm.version, protocolVersion: 1,
      scenario: arm.scenario, inputs: [], seed: 7, cpuSecondsLimit: 60 }
    assert.deepEqual(validateEngineJob(job).map((issue) => `${issue.code}@${issue.field}`), [], arm.name)
  }
  const edited = /** @type {Record<string, any>} */ (vcrDesignExperiment({ ...three, arms: [three.arms[0], { ...three.arms[1], scenario: ad({ symptomatic: { ...SYMPTOMATIC.symptomatic, pointsAt: { value: -3, basis: 'assumed' } } }) }, three.arms[2]] }, { methods }).record)
  assert.notEqual(vcrDesignExperimentCanonical(record ?? {}), vcrDesignExperimentCanonical(edited), 'a changed hypothesis is a new experiment version')
})

test('a disease arm and a design arm are never one comparison; a saved result may be attached to either', () => {
  const codes = (/** @type {any} */ input) => vcrDesignExperiment(input, { methods }).issues.map((issue) => `${issue.code}@${issue.field}`)
  const design = { name: 'd', method: 'design.simulate', scenario: { design: { kind: 'two_arm_fixed', nTreat: 10, nControl: 10 }, endpoint: { type: 'continuous' }, truth: { effect: -1, sd: 2 } } }
  assert.ok(codes({ ...three, arms: [three.arms[0], design] }).includes('experiment_arms_mixed@arms'))
  assert.deepEqual(codes({ ...three, arms: [three.arms[0], { name: 'saved', resultId: 'res_ad1' }] }), [])
})

test('what the arms must agree on is the people, the model, the visits and the analysis; only the hypothesis may differ', () => {
  const arms = [{ name: 'a', scenario: ad({}) }, { name: 'b', scenario: ad(SYMPTOMATIC) }]
  const agree = Object.fromEntries(vcrExperimentAlignment(arms, VCR_DISEASE_EXPERIMENT_ALIGNED_FIELDS).map((row) => [row.field, row.aligned]))
  assert.ok(Object.values(agree).every(Boolean), 'two arms that differ only in treatment are aligned on every field')
  const drift = Object.fromEntries(vcrExperimentAlignment([arms[0], { name: 'c', scenario: ad(SYMPTOMATIC, { design: { nTreat: 300, nControl: 300 } }) }], VCR_DISEASE_EXPERIMENT_ALIGNED_FIELDS).map((row) => [row.field, row.aligned]))
  assert.equal(drift.design, false)
  assert.equal(drift.visits, true)
})

test('the hypothesis of an arm is read as the engine reads it', () => {
  assert.equal(vcrDiseaseHypothesis(ad({})), 'none')
  assert.equal(vcrDiseaseHypothesis(ad(SYMPTOMATIC)), 'symptomatic')
  assert.equal(vcrDiseaseHypothesis(SYMPTOMATIC), 'symptomatic', 'the treatment block itself reads the same')
  assert.equal(vcrDiseaseHypothesis(ad(MODIFYING)), 'disease_modifying')
  assert.equal(vcrDiseaseHypothesis(ad({ ...SYMPTOMATIC, ...MODIFYING })), 'both')
  assert.equal(vcrDiseaseHypothesis(ad({ diseaseModifying: { fraction: { value: 0, basis: 'assumed' } } })), 'none')
  assert.equal(vcrDiseaseHypothesis(null), 'none')
})

// --- a design search over the Alzheimer trial ----------------------------------------------------------------------------------------

/** The base scenario of a search leaves the drug to the worlds. @param {any} scenario */
const withoutTreatment = (scenario) => { const { treatment: _t, ...rest } = scenario; return rest }
const search = (/** @type {any} */ over = {}) => ({
  question: 'The smallest Alzheimer trial that detects a stated drug effect',
  objective: { measure: 'total_sample_size', direction: 'minimize', truth: 'drug' },
  constraints: [
    { measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'drug' },
    { measure: 'type_one_error', op: '<=', bound: 0.05, kind: 'error_control', truth: 'null' },
  ],
  space: { method: 'patients.progression', scenario: withoutTreatment(ad()), truths: [{ name: 'drug', truth: { ...SYMPTOMATIC, ...MODIFYING } }, { name: 'null', truth: {} }],
    candidates: [100, 200, 300, 400].map((n) => ({ name: `${n}/arm`, set: { 'design.nTreat': n, 'design.nControl': n } })) },
  stages: { final: { count: 4 } }, budget: { maxCandidates: 4, cpuSeconds: 3600 },
  ...over,
})
const manifestOf = (/** @type {any} */ over = {}) => { const out = vcrCampaignManifest(search(over)); assert.deepEqual(out.issues, []); return /** @type {Record<string, any>} */ (out.manifest) }
const codes = (/** @type {any} */ over) => vcrCampaignManifest(search(over)).issues.map((issue) => `${issue.code}@${issue.field}`)

test('a search over sample size and duration freezes with the drug hypothesis as the evaluator', () => {
  const manifest = manifestOf()
  assert.equal(manifest.stages.screening, null)
  assert.equal(manifest.space.truths.length, 2)
  const duration = manifestOf({ space: { ...search().space, candidates: [26, 52, 78].map((w) => ({ name: `${w} weeks`, set: { visits: [0, 13, 26, 39, 52, 65, 78].filter((v) => v <= w), 'analysis.visit': w } })) } })
  assert.equal(vcrCampaignCandidates(duration).length, 3)
})

test('the disease search refuses what would move the evaluator or invent a precision stage', () => {
  assert.ok(codes({ space: { ...search().space, variables: [{ path: 'treatment.diseaseModifying.fraction', values: [{ value: 0.1 }, { value: 0.5 }] }], candidates: undefined } }).some((c) => c.startsWith('campaign_value_frozen')))
  assert.ok(codes({ space: { ...search().space, candidates: [{ name: 'k', set: { 'model.uncertainty': 'typical_study' } }] } }).some((c) => c.startsWith('campaign_value_frozen')))
  assert.ok(codes({ stages: { screening: { replicates: 500 }, final: { count: 2 } } }).includes('campaign_value_invalid@stages.screening'))
  assert.ok(codes({ stages: { final: { count: 2, replicates: 100 } } }).includes('campaign_final_below_floor@stages.final.replicates'))
  // the type I error is judged under a world with no drug effect, and never against a bound above the analysis's own 5%
  assert.ok(codes({ constraints: [{ measure: 'type_one_error', op: '<=', bound: 0.05, kind: 'error_control', truth: 'drug' }] }).includes('campaign_error_control_truth@constraints[0].truth'))
  assert.ok(codes({ constraints: [{ measure: 'type_one_error', op: '<=', bound: 0.1, kind: 'error_control', truth: 'null' }] }).includes('campaign_alpha_relaxed@constraints[0].bound'))
  assert.ok(codes({ space: { ...search().space, scenario: ad(SYMPTOMATIC) } }).includes('campaign_value_frozen@space.scenario.treatment'))
  assert.ok(codes({ objective: { measure: 'enrolment_cost', direction: 'minimize', truth: 'drug' } }).includes('campaign_measure_unknown@objective.measure'))
})

test('a unit states the drug world and no precision block, and is a job the engine accepts', () => {
  const manifest = manifestOf()
  const [candidate] = vcrCampaignCandidates(manifest)
  for (const truth of ['drug', 'null']) {
    const unit = vcrCampaignUnit(manifest, ID, candidate, 'final', truth)
    assert.equal(unit.kind, 'generate_progression')
    assert.equal(unit.scenario.evaluation, undefined)
    assert.equal(unit.scenario.design.nTreat, 100)
    assert.equal(vcrDiseaseHypothesis(unit.scenario), truth === 'null' ? 'none' : 'both')
    const job = { jobId: 'job_x', studyId: 'std_x', kind: unit.kind, method: unit.method, methodVersion: unit.version, protocolVersion: 1,
      scenario: unit.scenario, inputs: [], seed: unit.seed, cpuSecondsLimit: 60 }
    assert.deepEqual(validateEngineJob(job).map((issue) => `${issue.code}@${issue.field}`), [], truth)
  }
})

test('the sample size and the last visit are arithmetic on the scenario, not estimates', () => {
  assert.deepEqual(vcrScenarioDerivedMeasures('patients.progression', ad({})).map((m) => [m.name, m.value, m.source]),
    [['total_sample_size', 400, 'calculated'], ['last_visit_weeks', 78, 'calculated']])
  assert.deepEqual(vcrScenarioDerivedMeasures('design.simulate', {}), [])
})

/** A fake engine: the power of the change at the last visit grows with the people enrolled, and the null's rejection rate is `nullRate`. */
const fake = (/** @type {any} */ unit, /** @type {number} */ nullRate = 0.03) => {
  const n = unit.scenario.design.nTreat + unit.scenario.design.nControl
  const isNull = vcrDiseaseHypothesis(unit.scenario) === 'none'
  const p = isNull ? nullRate : 1 - Math.exp(-n / 300)
  const reps = 5000
  const k = Math.round(p * reps) / reps
  const s = Math.sqrt(k * (1 - k) / reps)
  return { jobId: `job_${unit.key}`, state: 'succeeded', replicates: reps, seed: unit.seed, cpuSeconds: 30, queueSeconds: 1, wallSeconds: 31,
    measures: [{ name: isNull ? 'type_one_error' : 'power', value: k, mcse: s, simulated: true, source: 'synthetic' },
      { name: 'expected_difference', value: isNull ? 0 : -1.4, mcse: null, simulated: false, source: 'calculated' }] }
}
const drive = (/** @type {any} */ manifest, /** @type {any} */ engine = fake) => {
  let state = vcrCampaignInitialState(manifest)
  /** @type {any[]} */
  const units = []
  for (let i = 0; i < 100; i++) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity: ID })
    state = next
    if (action.type !== 'evaluate') return { state, action, units }
    const unit = /** @type {any} */ (action.unit)
    units.push(unit)
    state = { ...state, inFlight: { unitKey: unit.key } }
    state = vcrCampaignRecord(manifest, state, unit, engine(unit))
  }
  throw new Error('campaign did not stop')
}

test('the search finds the smallest enrolment whose power bound clears and keeps the null at its level', () => {
  const manifest = manifestOf()
  const { state, action, units } = drive(manifest)
  assert.equal(action.reason, 'acceptable_precision')
  assert.equal(units.length, 8, 'every candidate under both worlds, each once, all final')
  assert.ok(units.every((unit) => unit.stage === 'final'))
  assert.equal(new Set(units.map((unit) => unit.seed)).size, 8, 'no two units share a stream')
  const verdict = vcrCampaignVerdict(manifest, state)
  // power(n) = 1 - exp(-n/300): 200 in total (100 per arm) 0.49, 400 -> 0.74, 600 -> 0.86: the 300-per-arm trial is the smallest to clear 0.8
  assert.equal(verdict.best, 'c002')
  assert.ok(!verdict.feasible.includes('c000') && !verdict.feasible.includes('c001'))
  const nullVerdicts = state.candidates.c002.evaluations['final:null'].measures.map((/** @type {any} */ m) => m.name)
  assert.ok(nullVerdicts.includes('total_sample_size') && nullVerdicts.includes('type_one_error'))
})

test('a type I error at the analysis\'s own level is inconclusive, never a pass: the test is not calibrated by construction', () => {
  const manifest = manifestOf()
  const conservative = vcrCampaignVerdict(manifest, drive(manifest).state)
  assert.ok(conservative.feasible.length >= 1, 'a null rate clearly below the bound passes')
  const atLevel = drive(manifest, (/** @type {any} */ unit) => fake(unit, 0.05))
  const verdict = vcrCampaignVerdict(manifest, atLevel.state)
  assert.equal(verdict.feasible.length, 0, 'a test that rejects 5% of the time cannot be shown to reject at most 5%')
  assert.ok(verdict.inconclusive.length >= 1)
})
