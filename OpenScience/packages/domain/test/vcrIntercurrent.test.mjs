// Round 2, R26: intercurrent events and the estimators of the beta_logit family as the domain states them (the scenario schema, the method version
// they need) and what an estimator answers (the alignment table the engine's known-truth cases N111g* hold the numbers of).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateEngineJob, VCR_ENGINE_METHODS } from '../src/vcrEngineJob.mjs'
import { validateScenario } from '../src/vcrScenarioSchemas.mjs'
import { questionRepresentability, vcrEstimandAlignment, VCR_QUESTION_MODEL_CAPABILITIES } from '../src/vcrResearchQuestion.mjs'

const P = (/** @type {number} */ value, basis = 'assumed') => ({ value, basis })
const ad = (/** @type {any} */ over = {}) => ({
  endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 60, nControl: 60 }, timeUnit: 'weeks', visits: [0, 26, 52],
  model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' } },
  treatment: { symptomatic: { pointsAt: P(-3), atWeek: 26, referenceAdas: 25, et50Weeks: P(8), washoutHalfLifeWeeks: P(4) } }, ...over,
})
const codes = (/** @type {readonly any[]} */ issues) => issues.map((i) => `${i.code}@${i.field}`)
const ic = { discontinuation: { shareControl: P(0.1), shareTreated: P(0.3), retrievedShare: P(0.5) } }

test('intercurrent events, the estimand and the new estimators are beta_logit scenarios with their numbers stated', () => {
  const run = (/** @type {any} */ over) => codes(validateScenario('patients.progression', ad(over)))
  assert.deepEqual(run({ intercurrent: ic, estimand: { strategy: 'treatment_policy' }, analysis: { kind: 'mmrm', data: 'on_treatment' } }), [])
  assert.deepEqual(run({ intercurrent: { ...ic, withdrawal: { treatedHazardRatio: P(1.5), progressionLogHazardPerSd: P(0.3) }, death: { share: P(0.05) }, offTreatment: { reboundLogit: P(0.2) } } }), [])
  for (const kind of ['mmrm', 'cmi_jump_to_reference', 'cmi_copy_reference']) assert.deepEqual(run({ analysis: { kind, delta: P(1), jackknifeGroups: 12 } }), [], kind)
  // a stop is stated by both arms and who stays in the study; a share is below one; a strategy is one of the two the engine computes a truth for
  assert.ok(run({ intercurrent: { discontinuation: { shareControl: P(0.1), shareTreated: P(0.3) } } }).some((c) => c.includes('retrievedShare')))
  assert.ok(run({ intercurrent: { discontinuation: { ...ic.discontinuation, shareTreated: P(1) } } }).length > 0)
  assert.ok(run({ estimand: { strategy: 'composite' } }).length > 0)
  assert.ok(run({ analysis: { kind: 'mmrm', data: 'whatever' } }).length > 0)
  assert.ok(run({ analysis: { kind: 'cmi_jump_to_reference', jackknifeGroups: 3 } }).length > 0)
  // the four other families do not take them
  const linear = { endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 60, nControl: 60 }, timeUnit: 'weeks', visits: [0, 26, 52],
    model: { family: 'linear', slope: { value: 0.5, basis: 'assumed' }, betweenPersonSd: { value: 0.2, basis: 'assumed' } }, baseline: { mean: P(20), sd: P(4) }, residualSd: P(2), treatment: { slowing: P(0.2) } }
  assert.ok(codes(validateScenario('patients.progression', { ...linear, intercurrent: ic })).length > 0)
  assert.ok(codes(validateScenario('patients.progression', { ...linear, analysis: { data: 'on_treatment' } })).length > 0)
})

test('a job that asks for them needs the method version that has them', () => {
  const spec = /** @type {any} */ (VCR_ENGINE_METHODS)['patients.progression']
  assert.equal(spec.version, '1.2.0')
  const job = (/** @type {string} */ methodVersion, /** @type {any} */ scenario) => ({ jobId: 'j1', studyId: 's1', kind: 'generate_progression', method: 'patients.progression', methodVersion, protocolVersion: 1, seed: 1, cpuSecondsLimit: 60, scenario, inputs: [{ kind: 'assumption', id: 'a_1@1' }] })
  const old = (/** @type {any} */ over) => codes(validateEngineJob(/** @type {any} */ (job('1.1.0', ad(over)))))
  assert.deepEqual(old({}), [])
  for (const over of [{ intercurrent: ic }, { estimand: { strategy: 'hypothetical' } }, { analysis: { kind: 'mmrm' } }, { analysis: { kind: 'cmi_copy_reference' } }, { analysis: { data: 'on_treatment' } }]) {
    assert.ok(old(over).length > 0, JSON.stringify(over))
  }
  assert.deepEqual(codes(validateEngineJob(/** @type {any} */ (job('1.2.0', ad({ intercurrent: ic, analysis: { kind: 'mmrm' } }))))), [])
})

test('the alignment of an estimator with a strategy is a table of what each uses and assumes', () => {
  const a = (/** @type {string} */ strategy, /** @type {string} */ estimator, /** @type {string} */ data) => vcrEstimandAlignment({ strategy, estimator, data }).state
  assert.equal(a('treatment_policy', 'mmrm', 'all_observed'), 'conditional')
  assert.equal(a('treatment_policy', 'ancova', 'all_observed'), 'conditional')
  assert.equal(a('treatment_policy', 'ancova', 'on_treatment'), 'not_aligned')
  assert.equal(a('treatment_policy', 'mmrm', 'on_treatment'), 'not_aligned')
  assert.equal(a('treatment_policy', 'cmi_jump_to_reference', 'on_treatment'), 'conditional')
  assert.equal(a('hypothetical', 'mmrm', 'on_treatment'), 'conditional')
  assert.equal(a('hypothetical', 'ancova', 'on_treatment'), 'conditional')
  assert.equal(a('hypothetical', 'mmrm', 'all_observed'), 'not_aligned')
  assert.equal(a('hypothetical', 'cmi_copy_reference', 'on_treatment'), 'not_aligned')
  for (const strategy of ['composite', 'while_on_treatment', 'principal_stratum', '']) assert.equal(a(strategy, 'mmrm', 'on_treatment'), 'not_computed')
  assert.match(vcrEstimandAlignment({ strategy: 'treatment_policy', estimator: 'ancova', data: 'on_treatment' }).sentence, /停药之前/)
})

test('the Alzheimer model represents the treatment-policy and the hypothetical strategy, and its data still estimate the hypothetical one', () => {
  const capability = /** @type {any} */ (VCR_QUESTION_MODEL_CAPABILITIES)['camd-adas-cog-11']
  assert.deepEqual([...capability.strategies], ['hypothetical', 'treatment_policy'])
  assert.deepEqual([...capability.calibration.strategies], ['hypothetical'])
  const states = questionRepresentability({ fields: { intercurrentEvents: [{ event: 'a', strategy: 'treatment_policy' }, { event: 'b', strategy: 'hypothetical' }, { event: 'c', strategy: 'composite' }] } }, 'camd-adas-cog-11').map((e) => e.state)
  assert.deepEqual(states, ['representable', 'representable', 'not_representable'])
})
