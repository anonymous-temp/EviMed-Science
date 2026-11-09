// Round 2, R29 to R31: where the drug effect of the Alzheimer simulation comes from, as the domain states it: the marketed inhibitor and the background
// (tier A), the antibody chain (tier B) in the scenario schema and the method version they need, and the effect prior of evidence the researcher holds (tier C).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as domain from '../index.mjs'
import { validateEngineJob } from '../src/vcrEngineJob.mjs'
import { validateScenario, VCR_MECHANISM_DRUGS, VCR_MECHANISM_LINKS, VCR_REFERENCE_DRUGS } from '../src/vcrScenarioSchemas.mjs'
import { vcrEffectPriorFromEstimate, vcrEffectPriorFromPool } from '../src/vcrEffectPrior.mjs'

const ad = (/** @type {any} */ treatment = {}) => ({
  endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 60, nControl: 60 }, timeUnit: 'weeks', visits: [0, 26, 52, 78],
  model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' } }, treatment,
})
const codes = (/** @type {readonly any[]} */ issues) => issues.map((i) => `${i.code}@${i.field}`)
const chain = { drug: 'aducanumab', regimen: { maintenanceMgPerKg: 10, titrationMgPerKg: [1, 1, 3, 3, 6, 6], intervalWeeks: 4 }, atWeek: 78 }

test('a marketed inhibitor, a background inhibitor and the antibody chain are keys of the Alzheimer treatment, and nothing else is', () => {
  assert.deepEqual([...VCR_REFERENCE_DRUGS], ['donepezil', 'galantamine', 'rivastigmine'])
  assert.deepEqual([...VCR_MECHANISM_DRUGS], ['aducanumab', 'lecanemab'])
  assert.deepEqual([...VCR_MECHANISM_LINKS], ['pang_2023'], 'the one link with an ADAS-Cog reading; Ren 2025 is on the CDR-SB')
  const run = (/** @type {any} */ treatment) => codes(validateScenario('patients.progression', ad(treatment)))
  assert.deepEqual(run({ reference: { drug: 'donepezil', doseMg: 10 } }), [])
  assert.deepEqual(run({ background: { drug: 'galantamine', doseMg: 16, weeksBefore: 52 }, diseaseModifying: { fraction: { value: 0.2, basis: 'assumed' } } }), [])
  assert.deepEqual(run({ mechanism: chain }), [])
  assert.deepEqual(run({ mechanism: { ...chain, drug: 'lecanemab' } }), [], 'lecanemab is accepted by the schema and refused by the engine, by name')
  assert.deepEqual(run({ reference: { drug: 'memantine', doseMg: 10 } }).length > 0, true)
  assert.deepEqual(run({ reference: { drug: 'donepezil', doseMg: 0 } }).length > 0, true)
  assert.deepEqual(run({ reference: { drug: 'donepezil' } }), ['scenario_field_missing@scenario.treatment.reference.doseMg'])
  assert.deepEqual(run({ mechanism: { ...chain, link: 'ren_2025' } }).length > 0, true)
  assert.deepEqual(run({ mechanism: { drug: 'aducanumab', atWeek: 78 } }), ['scenario_field_missing@scenario.treatment.mechanism.regimen'])
})

test('a scenario using them is a 1.2.0 scenario and an older label refuses it', () => {
  const job = (/** @type {any} */ treatment, /** @type {string} */ version) => ({ jobId: 'job_x', studyId: 'std_x', kind: 'generate_progression', method: 'patients.progression', methodVersion: version,
    protocolVersion: 1, scenario: ad(treatment), inputs: [{ kind: 'assumption', id: 'asm_x@1' }], seed: 1, cpuSecondsLimit: 60, cores: 1 })
  const issues = (/** @type {any} */ treatment, /** @type {string} */ version) => validateEngineJob(job(treatment, version)).filter((i) => i.field === 'methodVersion').map((i) => i.code)
  for (const treatment of [{ reference: { drug: 'donepezil', doseMg: 10 } }, { background: { drug: 'donepezil', doseMg: 10, weeksBefore: 26 } }, { mechanism: chain }]) {
    assert.deepEqual(issues(treatment, '1.2.0'), [])
    assert.deepEqual(issues(treatment, '1.1.0'), ['method_version_mismatch'])
  }
})

const pool = (/** @type {any} */ over = {}) => ({ id: 'res_pool1', kind: 'evidence_pool', diagnostics: { scale: 'identity', k: 4, distribution: { kind: 'normal', mean: -2.1, sd: 0.8, basis: 'prediction', confidenceSd: 0.3, tau: 0.7 }, ...over } })

test('a pooling becomes a tier-C effect prior that names its result, its estimand and the spread it is', () => {
  const out = vcrEffectPriorFromPool(pool(), { estimand: { treatment: 'donepezil 10 mg', population: 'mild to moderate AD', endpoint: 'ADAS-cog change at 24 weeks' } })
  assert.equal(out.ok, true)
  assert.deepEqual(/** @type {any} */ (out).distribution, { family: 'normal', parameters: { mean: -2.1, sd: 0.8 },
    source: { kind: 'model_result', objectRef: 'res_pool1', note: 'pooled studies; estimand: donepezil 10 mg; mild to moderate AD; ADAS-cog change at 24 weeks' }, tier: 'C' })
  assert.equal(/** @type {any} */ (out).basis, 'prediction')
  assert.ok(/** @type {any} */ (out).premises.some((/** @type {string} */ s) => s.includes('ICH E9(R1) A.4') && s.includes('may not be the one this study asks')))
  // the distribution is one the scenario schema accepts as the symptomatic effect, with the tier-C words
  const sc = ad({ symptomatic: { pointsAt: { distribution: /** @type {any} */ (out).distribution }, atWeek: 26, referenceAdas: 25, et50Weeks: { value: 8, basis: 'assumed' } } })
  assert.deepEqual(codes(validateScenario('patients.progression', sc)), [])
  // a confidence spread says it understates, an estimand left out says so, both still run
  const thin = vcrEffectPriorFromPool(pool({ distribution: { kind: 'normal', mean: -2, sd: 0.3, basis: 'confidence' } }))
  assert.equal(thin.ok, true)
  assert.ok(/** @type {any} */ (thin).premises.some((/** @type {string} */ s) => s.includes('understated')))
  assert.ok(/** @type {any} */ (thin).premises.some((/** @type {string} */ s) => s.includes('did not state the estimand')))
  assert.equal(/** @type {any} */ (thin).estimand.stated, false)
})

test('what cannot be put on this model is refused by name and says why', () => {
  assert.equal(/** @type {any} */ (vcrEffectPriorFromPool(pool({ scale: 'log', distribution: { kind: 'lognormal', mean: -0.2, sd: 0.1 } }))).reason, 'effect_prior_scale_unsupported')
  assert.equal(/** @type {any} */ (vcrEffectPriorFromPool({ id: 'res_x', diagnostics: {} })).reason, 'effect_prior_not_a_pooling')
  assert.equal(/** @type {any} */ (vcrEffectPriorFromPool(pool({ endpoint: { unit: 'CDR-SB points' } }), { unit: 'points' })).reason, 'effect_prior_unit_mismatch')
  assert.equal(/** @type {any} */ (vcrEffectPriorFromPool(pool(), { target: 'power' })).reason, 'effect_prior_target_unknown')
})

test('a phase-2 estimate is a normal with the spread it states, and a spread nobody gave is never guessed', () => {
  const se = vcrEffectPriorFromEstimate({ estimate: -3, se: 0.9, own: true, estimand: 'ADAS-cog 11 change at week 24, treatment policy, mild-to-moderate AD' })
  assert.equal(se.ok, true)
  assert.deepEqual(/** @type {any} */ (se).distribution.parameters, { mean: -3, sd: 0.9 })
  assert.equal(/** @type {any} */ (se).distribution.source.kind, 'stated')
  assert.ok(/** @type {any} */ (se).distribution.source.note.includes('the researcher\'s own phase-2 estimate'))
  assert.ok(/** @type {any} */ (se).premises.some((/** @type {string} */ s) => s.includes('optimistic, selected')))
  const ci = vcrEffectPriorFromEstimate({ estimate: -2.67, lower: -3.31, upper: -2.02, citation: 'Birks and Harvey 2018, Cochrane CD001190' })
  assert.equal(ci.ok, true)
  assert.ok(Math.abs(/** @type {any} */ (ci).distribution.parameters.sd - (3.31 - 2.02) / (2 * 1.959963984540054)) < 1e-8)
  assert.equal(/** @type {any} */ (ci).distribution.source.kind, 'literature')
  assert.equal(/** @type {any} */ (vcrEffectPriorFromEstimate({ estimate: -3 })).reason, 'effect_prior_spread_missing')
  assert.equal(/** @type {any} */ (vcrEffectPriorFromEstimate({ estimate: -3, se: -1 })).reason, 'effect_prior_spread_invalid')
  assert.equal(/** @type {any} */ (vcrEffectPriorFromEstimate({ estimate: -3, lower: 1, upper: 0 })).reason, 'effect_prior_spread_invalid')
  assert.equal(/** @type {any} */ (vcrEffectPriorFromEstimate(/** @type {any} */ ({}))).reason, 'effect_prior_estimate_missing')
})

test('the module is exported from the package index', () => {
  for (const name of ['vcrEffectPriorFromPool', 'vcrEffectPriorFromEstimate', 'VCR_EFFECT_PRIOR_TARGETS', 'VCR_REFERENCE_DRUGS', 'VCR_MECHANISM_DRUGS', 'VCR_MECHANISM_LINKS']) {
    assert.ok(name in domain, name)
  }
})

test('a pooled difference in points is never a disease-modifying share, and an estimate must say which unit it is in (review S1)', () => {
  // the reviewer's case: a pooled -0.3 +/- 0.5 points was written as share ~ Normal(-0.3, 0.5)
  const near = vcrEffectPriorFromPool(pool({ distribution: { kind: 'normal', mean: -0.3, sd: 0.5, basis: 'confidence' } }), { target: 'disease_modifying_fraction' })
  assert.equal(/** @type {any} */ (near).ok, false)
  assert.equal(/** @type {any} */ (near).reason, 'effect_prior_target_scale')
  for (const mean of [-1.8, 1.8]) assert.equal(/** @type {any} */ (vcrEffectPriorFromPool(pool({ distribution: { kind: 'normal', mean, sd: 0.6, basis: 'prediction' } }), { target: 'disease_modifying_fraction' })).reason, 'effect_prior_target_scale')
  assert.equal(vcrEffectPriorFromPool(pool({ distribution: { kind: 'normal', mean: -0.3, sd: 0.5, basis: 'confidence' } }), { target: 'symptomatic_points' }).ok, true, 'the same pooling is the symptomatic change')
  assert.equal(/** @type {any} */ (vcrEffectPriorFromEstimate({ estimate: -2, se: 0.5 }, { target: 'disease_modifying_fraction' })).reason, 'effect_prior_target_scale', 'points are not a share')
  assert.equal(/** @type {any} */ (vcrEffectPriorFromEstimate({ estimate: 0.2, se: 0.1, scale: 'share' }, { target: 'symptomatic_points' })).reason, 'effect_prior_target_scale')
  assert.equal(vcrEffectPriorFromEstimate({ estimate: 0.2, se: 0.1, scale: 'share' }, { target: 'disease_modifying_fraction' }).ok, true, 'a share the researcher states as a share is a share')
})
