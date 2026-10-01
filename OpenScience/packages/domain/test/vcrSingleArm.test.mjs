import assert from 'node:assert/strict'
import test from 'node:test'
import { validateEngineJob, validateScenario, vcrIsNullScenario, vcrReplicateFloorFor } from '@evimed/domain'

/** @returns {any} */
const exact = () => ({ design: { kind: 'single_arm', n: 40 }, endpoint: { type: 'binary' },
  truth: { nullRate: 0.2, responseRate: 0.4 },
  analysis: { method: 'exact_binomial', alternative: 'greater', sided: 1, alpha: 0.05 } })
const simon = () => ({ design: { kind: 'simon_two_stage', n1: 10, n: 29, r1: 1, r: 5 },
  endpoint: { type: 'binary' }, truth: { nullRate: 0.1, alternativeRate: 0.3, responseRate: 0.1 },
  analysis: { method: 'simon_boundary', sided: 1, alpha: 0.05 } })
const external = () => ({ design: { kind: 'single_arm_external', n: 200 }, endpoint: { type: 'binary' },
  truth: { controlRates: [0.2, 0.4], treatmentRates: [0.2, 0.4] },
  external: { kind: 'stratified_beta_binomial', n: 500, targetPrevalence: 0.5,
    sourcePrevalence: 0.3, parameterInformation: 1000, logOddsDrift: 0, sensitivityDrifts: [-0.2, 0, 0.2] },
  analysis: { method: 'stratified_risk_difference', estimand: 'ATT', sided: 1, alpha: 0.025 } })

test('single-arm scenarios require their own sizes, truth and analysis instead of two-arm defaults', () => {
  for (const scenario of [exact(), simon(), external()]) assert.deepEqual(validateScenario('design.simulate', scenario), [])
  const wrong = exact(); wrong.design.nTreat = 40; delete wrong.design.n
  assert.ok(validateScenario('design.simulate', wrong).some(x => x.field === 'scenario.design.n'))
  assert.ok(validateScenario('design.simulate', wrong).some(x => x.field === 'scenario.design.nTreat'))
  const incompatible = exact(); incompatible.analysis.sided = 2
  assert.ok(validateScenario('design.simulate', incompatible).some(x => x.code === 'scenario_value_invalid'))
  const boundary = simon(); boundary.design.n1 = 30
  assert.ok(validateScenario('design.simulate', boundary).some(x => x.field === 'scenario.design.n1'))
  const mislabeled = exact(); mislabeled.truth.null = true
  assert.ok(validateScenario('design.simulate', mislabeled).some(x => x.field === 'scenario.truth.null'))
  const missing = exact(); delete missing.analysis
  assert.ok(validateScenario('design.simulate', missing).some(x => x.field === 'scenario.analysis'))
  const surrogate = exact(); surrogate.analysis.method = 'risk_difference'
  assert.ok(validateScenario('design.simulate', surrogate).some(x => x.field === 'scenario.analysis.method'))
})

test('exact binary boundary rates and analytic contract are accepted without fabricated alternative values', () => {
  const scenario = exact(); scenario.truth = { nullRate: 0, responseRate: 1 }
  assert.deepEqual(validateScenario('design.analytic', scenario), [])
  scenario.analysis.alternative = 'two.sided'; scenario.analysis.sided = 2
  assert.deepEqual(validateScenario('design.simulate', scenario), [])
})

test('single-arm and external-control null laws choose the same 20000/5000 precision floors', () => {
  const scenario = exact(); assert.equal(vcrIsNullScenario(scenario), false)
  scenario.truth.responseRate = 0.2; assert.equal(vcrIsNullScenario(scenario), true)
  assert.equal(vcrReplicateFloorFor(scenario), 20000)
  assert.equal(vcrReplicateFloorFor(external()), 20000)
  assert.equal(vcrReplicateFloorFor(exact()), 5000)
  assert.equal(vcrIsNullScenario(simon()), true)
  const cancelingEffects = external(); cancelingEffects.truth.treatmentRates = [0.3, 0.3]
  assert.equal(vcrIsNullScenario(cancelingEffects), true, 'the declared target ATT determines the null, not stratum equality')
})

test('single-arm design grid projects new design and truth fields, validates every frozen cell', () => {
  const scenario = { ...exact(), designs: [{ n: 30 }, { n: 60 }], truths: [{ responseRate: 0.2 }, { responseRate: 0.4 }] }
  assert.deepEqual(validateScenario('design.grid', scenario), [])
  scenario.designs[0].n = 0
  assert.ok(validateScenario('design.grid', scenario).length > 0)
})

test('new methods cannot be recorded under old numerical versions, while old supported designs replay', () => {
  const job = { jobId: 'job_version', studyId: 'std_version', kind: 'design_simulation', method: 'design.simulate',
    methodVersion: '1.0.0', protocolVersion: 1, seed: 1, cpuSecondsLimit: 600, scenario: exact(), inputs: [{ kind: 'assumption', id: 'asm_version@1' }] }
  assert.ok(validateEngineJob(job).some(x => x.code === 'method_version_mismatch'))
  job.methodVersion = '1.1.0'; assert.deepEqual(validateEngineJob(job), [])
  job.methodVersion = '1.0.0'; job.scenario = { design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'binary' }, truth: { controlRate: 0.2, treatmentRate: 0.4 } }
  assert.deepEqual(validateEngineJob(job), [])
})
