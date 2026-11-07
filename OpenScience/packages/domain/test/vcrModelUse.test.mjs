import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  VCR_MECHANISTIC_ENGINES, VCR_MECHANISTIC_REQUIRED, VCR_PREDICTION_MODES, assessModelUse, vcrExperimentCanonical, vcrExperimentIssues,
  vcrExperimentRecord, vcrMechanisticRuntimeIssues, vcrUnitsConvertible,
} from '../index.mjs'

const pack = {
  executable: true,
  executableModes: ['factual_forecast', 'intervention_comparison'],
  validation: [{ mode: 'factual_forecast', population: 'fixture-adults', endpoint: 'heart_rate', horizonHours: 24, evidenceRef: 'fixture-evidence' }],
}
const request = { mode: 'intervention_comparison', population: 'fixture-adults', endpoint: 'heart_rate', horizonHours: 24 }
const codes = (/** @type {any[]} */ list) => list.map((item) => item.code)

test('an executable but unvalidated comparison runs and says so; a model with no action input cannot run it', () => {
  const result = assessModelUse(pack, request)
  assert.deepEqual(result.executionIssues, [])
  assert.equal(result.premises.some((x) => x.code === 'use_not_validated'), true)
  const cannotRun = assessModelUse({ ...pack, executableModes: ['factual_forecast'] }, request)
  assert.equal(cannotRun.executionIssues.some((x) => x.code === 'intervention_input_unavailable'), true)
  assert.deepEqual(VCR_PREDICTION_MODES, ['factual_forecast', 'conditional_forecast', 'intervention_comparison'])
})

test('each premise stands alone and none stops the run', () => {
  const factual = { ...request, mode: 'factual_forecast' }
  assert.deepEqual(assessModelUse(pack, factual), { executionIssues: [], premises: [] })
  const independent = assessModelUse({ ...pack, validation: [{ ...pack.validation[0], independent: false }] }, factual)
  assert.deepEqual(codes(independent.premises), ['no_independent_data'])
  const beyond = assessModelUse(pack, { ...factual, horizonHours: 24 * 90 })
  assert.deepEqual(codes(beyond.premises), ['horizon_beyond_validation'])
  assert.deepEqual(beyond.executionIssues, [])
  assert.deepEqual(codes(assessModelUse(pack, { ...factual, population: 'children' }).premises), ['population_outside_validation'])
  assert.deepEqual(codes(assessModelUse(pack, { ...factual, endpoint: 'bp' }).premises), ['endpoint_outside_validation'])
  // missing provenance is never validation
  const bare = assessModelUse({ ...pack, validation: [{ ...pack.validation[0], evidenceRef: '' }] }, factual)
  assert.deepEqual(codes(bare.premises), ['provenance_missing', 'use_not_validated'])
  assert.deepEqual(bare.executionIssues, [])
})

test('only real execution issues refuse, each by its own code', () => {
  const factual = { ...request, mode: 'factual_forecast' }
  assert.deepEqual(codes(assessModelUse({ ...pack, executable: false }, factual).executionIssues), ['adapter_unavailable'])
  assert.deepEqual(codes(assessModelUse(null, factual).executionIssues), ['adapter_unavailable'])
  assert.deepEqual(codes(assessModelUse(pack, { ...factual, mode: 'cure_all' }).executionIssues), ['mode_unknown'])
  assert.deepEqual(codes(assessModelUse(pack, { ...factual, mode: 'conditional_forecast' }).executionIssues), ['mode_not_executable'])
  assert.deepEqual(codes(assessModelUse({ ...pack, outputs: ['hr'] }, { ...factual, outputs: ['hr', 'qt'] }).executionIssues), ['output_not_produced'])
  assert.deepEqual(codes(assessModelUse(pack, { ...factual, horizonHours: -1 }).executionIssues), ['invalid_parameters'])
  assert.deepEqual(codes(assessModelUse(pack, { ...factual, parameters: [{ name: 'sd', value: -1, min: 0 }] }).executionIssues), ['invalid_parameters'])
  assert.deepEqual(codes(assessModelUse(pack, { ...factual, units: [{ name: 'dose', from: 'mg', to: 'hours' }] }).executionIssues), ['units_not_convertible'])
  assert.deepEqual(assessModelUse(pack, { ...factual, units: [{ name: 'dose', from: 'mg', to: 'kg' }] }).executionIssues, [])
  assert.deepEqual(codes(assessModelUse(pack, { ...factual, authorized: false }).executionIssues), ['authorization_lost'])
  assert.deepEqual(codes(assessModelUse({ ...pack, limits: { maxHorizonHours: 12 } }, factual).executionIssues), ['runtime_limit_exceeded'])
  assert.equal(vcrUnitsConvertible('weeks', 'hours'), true)
  assert.equal(vcrUnitsConvertible('mg', 'mg/kg'), false)
})

test('an old card with none of the new fields is asked for nothing', () => {
  assert.deepEqual(assessModelUse({ name: 'old', card: {} }, { mode: 'factual_forecast' }), { executionIssues: [], premises: [] })
})

test('an experiment version has an identity that ignores key order and follows every frozen field', () => {
  const base = { question: 'q', populationRef: { id: 'p', version: '1' }, modelRef: { id: 'm', version: '2' }, predictionMode: 'conditional_forecast',
    actionTimes: [0, 12], seeds: [1, 2], horizon: { value: 52, unit: 'weeks' } }
  const hash = (/** @type {any} */ value) => createHash('sha256').update(vcrExperimentCanonical(value)).digest('hex')
  const reordered = Object.fromEntries(Object.entries(base).reverse())
  assert.equal(hash(base), hash(reordered))
  assert.notEqual(hash(base), hash({ ...base, seeds: [1, 3] }))
  assert.notEqual(hash(base), hash({ ...base, actionTimes: [0, 24] }))
  assert.notEqual(hash(base), hash({ ...base, modelRef: { id: 'm', version: '3' } }))
  assert.equal(vcrExperimentRecord({ ...base, extra: 1 }).extra, undefined)
  assert.deepEqual(vcrExperimentIssues(vcrExperimentRecord(base)), [])
  assert.deepEqual(vcrExperimentIssues(vcrExperimentRecord({ ...base, predictionMode: 'x', modelRef: { id: 'm' } })).map((i) => i.code), ['prediction_mode_unknown', 'reference_incomplete'])
})

test('the control plane view of the mechanism contract equals the engine source', () => {
  const r = readFileSync(new URL('../../../../项目代码/vcr-engine/R/population.R', import.meta.url), 'utf8')
  const strings = (/** @type {string} */ block) => [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  const required = /VCR_MECHANISTIC_REQUIRED <- c\(([^)]*)\)/.exec(r)?.[1]
  const engines = /spec\$engine %in% c\(([^)]*)\)/.exec(r)?.[1]
  assert.ok(required && engines, 'the engine source still states both lists')
  assert.deepEqual([...VCR_MECHANISTIC_REQUIRED], strings(required))
  assert.deepEqual([...VCR_MECHANISTIC_ENGINES], strings(engines))
  assert.equal(VCR_MECHANISTIC_REQUIRED.length, 13)
})

test('a declared solver the runtime lock lacks is an execution issue', () => {
  const lock = JSON.parse(readFileSync(new URL('../../../../项目代码/vcr-engine/R/package-lock.json', import.meta.url), 'utf8'))
  const names = lock.packages.map((/** @type {any} */ p) => p.package)
  const missing = vcrMechanisticRuntimeIssues({ engine: 'ospsuite' }, names)
  assert.deepEqual(missing.map((i) => i.code), ['runtime_unavailable'])
  assert.deepEqual(vcrMechanisticRuntimeIssues({ engine: 'desolve' }, [...names, 'deSolve']), [])
})

test('validation covers a use only within one entry; an entry with no horizon validated none (review stats P2-12)', () => {
  const two = { ...pack, validation: [
    { mode: 'factual_forecast', population: 'adults', endpoint: 'heart_rate', horizonHours: 24, evidenceRef: 'a', independent: true },
    { mode: 'factual_forecast', population: 'children', endpoint: 'bp', horizonHours: 8766, evidenceRef: 'b', independent: true }] }
  const mixed = assessModelUse(two, { mode: 'factual_forecast', population: 'children', endpoint: 'heart_rate', horizonHours: 8766 })
  assert.deepEqual(codes(mixed.premises), ['population_outside_validation', 'horizon_beyond_validation'], 'heart rate was validated in adults over a day only')
  assert.deepEqual(assessModelUse(two, { mode: 'factual_forecast', population: 'children', endpoint: 'bp', horizonHours: 8766 }).premises, [])
  const open = { ...pack, validation: [{ mode: 'factual_forecast', population: 'adults', endpoint: 'heart_rate', evidenceRef: 'a', independent: true }] }
  assert.deepEqual(codes(assessModelUse(open, { mode: 'factual_forecast', endpoint: 'heart_rate', horizonHours: 24 }).premises), ['horizon_beyond_validation'])
})
