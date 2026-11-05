import test from 'node:test'
import assert from 'node:assert/strict'
import { renderResearchReport } from '../report.mjs'

test('report shows returned measures, uncertainty, limitations and unverified inputs without dumping internal fields', () => {
  const report = renderResearchReport({ method: 'design.simulate', methodVersion: '1', conclusion: 'not_estimable', notEstimableRule: 'insufficient_events', secretInternal: 'do-not-show', measures: [{ name: 'power', value: 0.8, unit: 'proportion', interval: { kind: 'confidence', low: 0.7, high: 0.9, level: 0.95 }, mcse: 0.02 }] }, { job: { scenario: { truth: { effect: 0.3 } }, inputs: [{ kind: 'assumption', id: 'asm_a@1' }] }, sources: [{ field: 'truth.effect', publication: '1234', quote: 'an asserted estimate' }] })
  assert.match(report, /power \| 0\.8 \| proportion \| confidence 0\.7 to 0\.9 \(level 0\.95\) \| 0\.02/)
  assert.match(report, /insufficient_events/)
  assert.match(report, /not been verified/)
  assert.match(report, /truth.effect/)
  assert.doesNotMatch(report, /do-not-show/)
})

test('hosted reports preserve frozen inputs, checked quotations and evidence versions without claiming semantic verification', () => {
  const request = { job: { scenario: { truth: { hazardRatio: 0.7 } }, inputs: [{ kind: 'assumption', id: 'effect@2' }] },
    parameterProvenance: { bindings: [{ path: 'truth.hazardRatio', value: 0.7, unit: 'ratio', context: 'treatment vs control', quote: 'hazard ratio 0.7' }] },
    sources: [{ field: 'truth.controlMedian', publication: 'PMID 123', quote: '12 months' }],
    sourceChecks: [{ field: 'truth.controlMedian', state: 'carried', message: 'Source quotation checked; applicability is separate.' }],
    bound: [{ key: 'control-median', version: 3, path: 'truth.controlMedian', value: 12 }] }
  const report = renderResearchReport({ method: 'design.analytic', methodVersion: '1.4.0', measures: [] }, request)
  assert.match(report, /assumption effect@2/)
  assert.match(report, /original quotation: hazard ratio 0.7/)
  assert.match(report, /interpretation remains an assumption/)
  assert.match(report, /carried: Source quotation checked/)
  assert.match(report, /control-median \(version 3\)/)
  assert.doesNotMatch(report, /No source bindings|inputs: none/)
})

test('a successful computation cannot hide failed or unavailable population quality checks', () => {
  const report = renderResearchReport({ method: 'population.synthpop', methodVersion: '1.4.0', conclusion: 'estimable', measures: [],
    diagnostics: { quality: { bands: { worstKsD: 'red', sPMSE: 'unknown' }, fidelity: { global: { available: false } }, disclosure: { available: false } } } }, null)
  assert.match(report, /not a quality pass/)
  assert.match(report, /worstKsD \| red/)
  assert.match(report, /sPMSE \| unknown/)
  assert.match(report, /Unavailable or unknown checks were not passed/)
  assert.match(report, /no privacy guarantee/)
})

test('a combined research record does not claim every measure belongs to its requested method or seed', () => {
  const report = renderResearchReport({ method: 'design.analytic', methodVersion: '1.4.0', measures: [], diagnostics: { stageResults: {
    analytic: { stage: 'analytic', method: 'design.analytic', methodVersion: '1.4.0', conclusion: 'estimable' },
    simulation: { stage: 'simulation', method: 'design.simulate', methodVersion: '1.5.0', conclusion: 'estimable', stale: true },
  } } }, null)
  assert.match(report, /Requested method: design.analytic/)
  assert.match(report, /different scenarios or random seeds/)
  assert.match(report, /simulation \| design.simulate \| 1.5.0/)
  assert.match(report, /Carried forward; not rerun/)
})
