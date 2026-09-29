import assert from 'node:assert/strict'
import test from 'node:test'
import { runGate } from '../src/contractRegistry.mjs'

/** @param {Record<string, string>} files */
const verdict = (files) => runGate({ contractKind: 'statistical-analysis-package', files: new Map(Object.entries(files)) })
/** @param {unknown[]} analyses */
const results = (analyses) => JSON.stringify({ schemaVersion: 1, analyses })

test('statistical analysis keeps descriptive, partial and unknown-method results deliverable', () => {
  const result = verdict({
    'statistical-report.md': 'The observed mean is exploratory.',
    'analysis-results.json': results([
      { id: 'mean', status: 'complete', method: 'a future descriptive method', estimate: 2, n: 3 },
      { id: 'cox', status: 'unsupported', reason: 'Optional library unavailable.' },
    ]),
    'analysis.R': 'print(2)',
  })
  assert.equal(result.ok, true)
  assert.equal(result.metrics.statisticalComplete, 1)
  assert.equal(result.metrics.statisticalUnsupported, 1)
  assert.ok(result.issues.every((issue) => issue.severity === 'advisory'))
  assert.equal(result.issues.filter((issue) => issue.check === 'statistical-execution-provenance').length, 1)
})

test('mechanical numeric findings remain advisory and do not require uncertainty for descriptive summaries', () => {
  const result = verdict({ 'analysis-results.json': results([
    { id: 'valid', status: 'complete', estimate: 0, n: { independent: 4 } },
    { id: 'invalid', status: 'complete', estimate: null, interval: { lower: 3, upper: 1 }, pValue: 1.2, n: -1 },
    { id: 'failed', status: 'failed', estimate: null, reason: 'Singular fit.' },
  ]) })
  assert.equal(result.ok, true)
  for (const check of ['statistical-results-shape', 'statistical-finite-results']) assert.ok(result.issues.some((issue) => issue.check === check))
  assert.ok(result.issues.every((issue) => issue.severity === 'advisory'))
  assert.ok(!result.issues.some((issue) => issue.message.startsWith('valid:')))
  assert.ok(!result.issues.some((issue) => issue.message.includes('failed:')))
})

test('malformed results and fabricated receipts are findings, never package rejections', () => {
  const malformed = verdict({ 'analysis-results.json': '{broken', 'statistical-report.md': 'A valid partial report.' })
  assert.equal(malformed.ok, true)
  const receipt = verdict({ 'analysis-run.json': JSON.stringify({ executions: [{ script: { path: 'absent.py', sha256: 'invented' }, inputs: [], exitCode: 0 }] }) })
  assert.equal(receipt.ok, true)
  assert.ok(receipt.issues.some((issue) => issue.check === 'statistical-execution-provenance'))
})

test('missing optional traceability files produce one proportionate notice', () => {
  const result = verdict({ 'statistical-report.md': 'The available observations support only a descriptive comparison.' })
  assert.equal(result.ok, true)
  assert.equal(result.issues.length, 1)
})

test('native receipts require no fabricated specialist job id', () => {
  const stamp = { sha256: 'a'.repeat(64), path: 'analysis.py' }
  const execution = { script: stamp, inputs: [{ ...stamp, path: 'data.csv' }], argv: ['python', 'analysis.py'],
    versions: { interpreter: 'Python 3.12', libraries: {} }, exitCode: 0,
    startedAt: '2026-09-29T00:00:00Z', endedAt: '2026-09-29T00:01:00Z', sourcesUnchanged: true,
    output: { observedWrite: true, observation: 'created' } }
  const result = verdict({ 'analysis-results.json': results([{ id: 'mean', status: 'complete', estimate: 2 }]),
    'analysis-run.json': JSON.stringify({ schemaVersion: 1, executions: [execution] }), 'analysis.py': 'print(2)' })
  assert.deepEqual(result.issues, [])
})
