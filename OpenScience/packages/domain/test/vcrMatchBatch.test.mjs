import assert from 'node:assert/strict'
import test from 'node:test'

import { VCR_JOB_KINDS, VCR_JOB_METHODS, VCR_RETIRED_JOB_KINDS, VCR_SLOW_LOCAL_METHODS, validateMatchBatchScenario } from '../index.mjs'

test('the retired match_extract stays a stored job kind and method, and nothing runs it on the slow lane', () => {
  assert.deepEqual([...VCR_RETIRED_JOB_KINDS], ['match_extract'])
  assert.ok(VCR_JOB_KINDS.includes('match_extract'))
  assert.equal(VCR_JOB_METHODS.match_extract, 'matching.extract')
  assert.deepEqual([...VCR_SLOW_LOCAL_METHODS], ['matching.judge', 'matching.import_records'])
  assert.ok(VCR_JOB_KINDS.indexOf('match_extract') < VCR_JOB_KINDS.indexOf('forecast_trajectories'), 'the forecast kinds stay last')
})

test('a scenario is held to the shape of the batch method that runs it, and a retired or unknown method has none', () => {
  const codes = (/** @type {string} */ method, /** @type {any} */ scenario) => validateMatchBatchScenario(method, scenario).map((issue) => `${issue.code}@${issue.field}`)
  assert.deepEqual(codes('matching.nothing', {}), ['method_unknown@method'])
  assert.deepEqual(codes('matching.extract', {}), ['method_unknown@method'])
  assert.deepEqual(codes('matching.import_records', { mode: 'notes', inputs: [{ sourceId: 'src_1', generation: 1, sha256: 'a'.repeat(64) }], text: 'a record' }), ['scenario_field_unknown@scenario.text'])
  assert.ok(codes('matching.judge', {}).includes('scenario_field_required@scenario.direction'))
})
