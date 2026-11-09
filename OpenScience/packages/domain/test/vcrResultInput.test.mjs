// Plan R31 completion (stream A4): `result` is a lineage input kind. A caller names a result of the study by its node (`result:<id>@<version>`),
// the version is part of the id, and the engine receives it as a lineage input with nothing but a hash and a frozen value besides.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VCR_INPUT_KINDS, VCR_VERSIONED_INPUT_KINDS, lineageNode, validateCallerInputs, validateEngineJob } from '../index.mjs'

const codes = (/** @type {readonly any[]} */ issues) => issues.map((i) => `${i.code}@${i.field}`)

test('a result is an input kind with a versioned id, and the caller may name it', () => {
  assert.ok(VCR_INPUT_KINDS.includes('result'))
  assert.ok(VCR_VERSIONED_INPUT_KINDS.includes('result'))
  const node = lineageNode('result', 'res_pool1', 3)
  assert.equal(node, 'result:res_pool1@3')
  assert.deepEqual(codes(validateCallerInputs([{ kind: 'result', id: node }])), [])
  assert.deepEqual(codes(validateCallerInputs([{ kind: 'result', id: 'result:res_pool1' }])), ['input_version_missing@inputs[0].id'])
  assert.deepEqual(codes(validateCallerInputs([{ kind: 'result', id: node, location: 'x' }])), ['input_location_forbidden@inputs[0].location'])
})

test('the engine accepts the result input as a lineage input and refuses a table\'s keys on it', () => {
  const job = (/** @type {any} */ input) => ({ jobId: 'job_x', studyId: 'std_x', kind: 'generate_progression', method: 'patients.progression', methodVersion: '1.2.0', protocolVersion: 1,
    scenario: { endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 60, nControl: 60 }, timeUnit: 'weeks', visits: [0, 26, 52, 78],
      model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' } },
      treatment: { symptomatic: { pointsAt: { distribution: { family: 'normal', parameters: { mean: -2.1, sd: 0.8 }, source: { kind: 'model_result', objectRef: 'res_pool1' }, tier: 'C' } }, atWeek: 26, referenceAdas: 25, et50Weeks: { value: 8, basis: 'assumed' } } } },
    inputs: [input], seed: 1, cpuSecondsLimit: 60, cores: 1 })
  assert.deepEqual(codes(validateEngineJob(job({ kind: 'result', id: 'result:res_pool1@3' }))), [])
  assert.deepEqual(codes(validateEngineJob(job({ kind: 'result', id: 'result:res_pool1@3', hash: 'a'.repeat(64) }))), [])
  assert.deepEqual(codes(validateEngineJob(job({ kind: 'result', id: 'result:res_pool1' }))), ['input_version_missing@inputs[0].id'])
  assert.ok(codes(validateEngineJob(job({ kind: 'result', id: 'result:res_pool1@3', location: 'x' }))).includes('input_field_unknown@inputs[0].location'))
})
