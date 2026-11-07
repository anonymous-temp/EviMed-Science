// @ts-nocheck -- fixtures are loose JSON-shaped objects; the module under test is type-checked
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vcrDesignExperiment, vcrDesignExperimentCanonical, vcrExperimentAlignment } from '../src/vcrExperiment.mjs'
import { VCR_ENGINE_METHODS } from '../src/vcrEngineJob.mjs'

const methods = VCR_ENGINE_METHODS
const scenario = (nTreat) => ({ design: { kind: 'two_arm_fixed', nTreat, nControl: nTreat }, endpoint: { type: 'time_to_event' },
  truth: { hazardRatio: 0.7, controlMedian: 12 }, analysis: { method: 'logrank', alpha: 0.025, sided: 1 }, accrual: { kind: 'uniform', duration: 12, followup: 12 } })
const three = { question: 'Which of three sizes?', arms: [
  { name: '小', method: 'design.simulate', scenario: scenario(100) }, { name: '中', method: 'design.simulate', scenario: scenario(150) },
  { name: '已有结果', resultId: 'res_abc' }], comparison: { measures: ['power', 'expected_sample_size'], reference: '小' } }

test('a design experiment freezes named arms, attached results and its comparison', () => {
  const { record, issues } = vcrDesignExperiment(three, { methods })
  assert.deepEqual(issues, [])
  assert.equal(record.arms[0].version, methods['design.simulate'].version)
  assert.deepEqual(record.arms[2], { name: '已有结果', resultId: 'res_abc' })
  const changed = vcrDesignExperiment({ ...three, arms: [three.arms[0], { ...three.arms[1], scenario: scenario(160) }, three.arms[2]] }, { methods }).record
  assert.notEqual(vcrDesignExperimentCanonical(record), vcrDesignExperimentCanonical(changed), 'an edited arm is a new experiment version')
  const reordered = vcrDesignExperiment(JSON.parse(JSON.stringify({ comparison: three.comparison, arms: three.arms, question: three.question })), { methods }).record
  assert.equal(vcrDesignExperimentCanonical(record), vcrDesignExperimentCanonical(reordered))
})

test('arms are refused by name: duplicates, non-design methods, precision blocks and a reference that is not an arm', () => {
  const codes = (input) => vcrDesignExperiment(input, { methods }).issues.map((issue) => `${issue.code}@${issue.field}`)
  assert.ok(codes({ ...three, arms: [three.arms[0], three.arms[0]] }).includes('experiment_value_invalid@arms'))
  assert.ok(codes({ ...three, arms: [three.arms[0], { name: 'x', method: 'comparator.maic', scenario: {} }] }).includes('experiment_method_unsupported@arms[1].method'))
  assert.ok(codes({ ...three, arms: [three.arms[0], { name: 'x', method: 'design.simulate', scenario: { ...scenario(10), evaluation: { version: 1 } } }] })
    .includes('experiment_value_invalid@arms[1].scenario.evaluation'))
  assert.ok(codes({ ...three, comparison: { measures: ['power'], reference: 'none' } }).includes('experiment_value_invalid@comparison.reference'))
  assert.ok(codes({ ...three, arms: [three.arms[0]] }).includes('experiment_arms_invalid@arms'))
})

test('alignment says which frozen definitions the arms share and never counts an unknown arm as agreeing', () => {
  const rows = vcrExperimentAlignment([{ name: 'a', scenario: scenario(100) }, { name: 'b', scenario: { ...scenario(150), analysis: { method: 'logrank', alpha: 0.05, sided: 1 } } }, { name: 'c', scenario: null }])
  const by = Object.fromEntries(rows.map((row) => [row.field, row]))
  assert.equal(by.endpoint.aligned, false, 'an unknown arm leaves alignment unproven')
  assert.deepEqual(by.endpoint.unknown, ['c'])
  const two = Object.fromEntries(vcrExperimentAlignment([{ name: 'a', scenario: scenario(100) }, { name: 'b', scenario: { ...scenario(150), analysis: { method: 'logrank', alpha: 0.05, sided: 1 } } }]).map((row) => [row.field, row]))
  assert.equal(two.endpoint.aligned, true)
  assert.equal(two['analysis.alpha'].aligned, false)
})
