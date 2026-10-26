import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeGeoMetrics, geoMetricMembers, geoSurfaceKey, previewGeoQuestionImport } from '../index.mjs'
const contract = { samplingMode: 'one_shot', engines: ['deepseek'], repeats: 1, metricIds: ['M-01'], reportPresentation: 'summary', sourceBasis: 'answers' }
test('import preserves exact originals and duplicate rows without inventing classification or provenance', () => {
  const result = previewGeoQuestionImport({ contract, rows: [{ text: '  Original question?\n', originalId: '001', originalGroup: 'Buying', clientTags: ['client'] }, { text: 'Original question?' }] })
  assert.equal(result.rows[0].text, '  Original question?\n')
  assert.equal(result.rows[0].kind, 'client')
  assert.equal(result.rows[0].collectedAt, null)
  assert.equal(result.rows[0].classificationStatus, 'unclassified')
  assert.equal(result.rows[0].pool, null)
  assert.deepEqual(previewGeoQuestionImport({ contract: result.contract, rows: result.rows }).rows, result.rows)
  assert.equal(result.actualRows, 2)
  assert.equal(result.plannedCalls, 2)
  assert.deepEqual(result.duplicateCandidates, [{ rowIndexes: [0, 1] }])
})
test('import contract and row validation reject unknowns without dropping original records', () => {
  for (const input of [
    { contract: { ...contract, repeats: 2 }, rows: [{ text: 'q' }] },
    { contract: { ...contract, metricIds: ['fabricated'] }, rows: [{ text: 'q' }] },
    { contract, rows: [{ text: 'q', kind: 'real' }] },
    { contract, rows: [{ text: '' }] },
    { contract, rows: [{ text: 'q', rewritten: true }] },
  ]) assert.throws(() => previewGeoQuestionImport(input))
})

test('one-shot observations keep the 30-answer floor, drop only the inferential interval, and differ from recurring coverage', () => {
  const row = { snapshotId: 's1', questionId: 'q1', groupId: 'g1', pool: 'P2', engine: 'deepseek', status: /** @type {const} */ ('valid'), facts: { brands: [{ name: 'Product', ours: true, count: 1 }] } }
  const measured = computeGeoMetrics([row], { engines: ['deepseek'], samplingMode: 'one_shot' })
  const cell = measured.cells.find((c) => c.scope === 'engine' && c.metricId === 'M-01')
  assert.ok(cell)
  // One answer is k of n, never a rate a page may rank or compare (2026-10-25: every sub-floor cell read `ok`).
  assert.deepEqual([cell.numerator, cell.denominator, cell.status], [1, 1, 'insufficient'])
  assert.equal(cell.reason, 'one_shot_descriptive')
  assert.equal(cell.ciLow, null)
  assert.equal(cell.ciHigh, null)
  const thirty = Array.from({ length: 30 }, (_, i) => ({ ...row, snapshotId: `s${i}`, questionId: `q${i}` }))
  const floor = computeGeoMetrics(thirty, { engines: ['deepseek'], samplingMode: 'one_shot' }).cells.find((c) => c.scope === 'engine' && c.metricId === 'M-01')
  assert.deepEqual([floor?.status, floor?.value, floor?.ciLow, floor?.reason], ['ok', 100, null, 'one_shot_descriptive'], 'at the floor a one-shot rate is descriptive, with no interval')
  const recurring = computeGeoMetrics([row], { engines: ['deepseek'] }).cells.find((c) => c.scope === 'engine' && c.metricId === 'M-01')
  assert.ok(recurring)
  assert.equal(recurring.status, 'insufficient')
  assert.notEqual(geoSurfaceKey({ measurementContract: contract }), geoSurfaceKey({ measurementContract: { ...contract, samplingMode: 'recurring' } }))
})

test('one-shot unclassified rows have the exact engine rate membership', () => {
  const rows = [1, 2].map((i) => ({ snapshotId: `s${i}`, questionId: `q${i}`, groupId: 'g', pool: null, engine: 'deepseek', status: /** @type {const} */ ('valid'), facts: { brands: [{ name: 'Product', ours: true, count: 1 }] } }))
  const options = { engines: ['deepseek'], samplingMode: 'one_shot' }
  const measured = computeGeoMetrics(rows, options)
  const rate = measured.cells.find((c) => c.scope === 'engine' && c.metricId === 'M-01')
  assert.ok(rate)
  assert.equal(rate.denominator, 2)
  const members = geoMetricMembers(rows, rate, options)
  assert.equal(members.rows.length, rate.denominator)
  assert.equal(rate.value, 100)
  const refusal = measured.cells.find((c) => c.scope === 'project' && c.metricId === 'M-20' && c.variant === 'refusal')
  assert.ok(refusal)
  assert.equal(geoMetricMembers(rows, refusal, options).rows.length, refusal.denominator)
})

test('mixed contracts keep one-shot unclassified answers as descriptive members and exclude unclassified recurring rows', () => {
  const rows = [
    { snapshotId: 'once', questionId: 'q1', groupId: 'g1', pool: null, engine: 'deepseek', status: /** @type {const} */ ('valid'), surface: { measurementContract: { samplingMode: 'one_shot' } }, facts: { brands: [{ name: 'Product', ours: true, count: 1 }] } },
    { snapshotId: 'repeat', questionId: 'q2', groupId: 'g2', pool: 'P2', engine: 'deepseek', status: /** @type {const} */ ('valid'), surface: { measurementContract: { samplingMode: 'recurring' } }, facts: { brands: [] } },
    { snapshotId: 'invalid-pool', questionId: 'q3', groupId: 'g3', pool: null, engine: 'deepseek', status: /** @type {const} */ ('valid'), surface: { measurementContract: { samplingMode: 'recurring' } }, facts: { brands: [] } },
  ]
  const options = { engines: ['deepseek'], samplingMode: 'mixed' }
  const metrics = computeGeoMetrics(rows, options)
  const rate = metrics.cells.find((c) => c.scope === 'engine' && c.metricId === 'M-01')
  assert.ok(rate)
  assert.equal(rate.denominator, 2)
  assert.equal(rate.value, 50)
  assert.equal(rate.status, 'insufficient', 'a mix of contracts lifts no floor')
  assert.equal(rate.reason, 'mixed_contract_descriptive')
  assert.equal(rate.ciLow, null)
  assert.equal(rate.ciHigh, null)
  assert.deepEqual(geoMetricMembers(rows, rate, options).rows.map((row) => row.snapshotId).sort(), ['once', 'repeat'])
  const refusal = metrics.cells.find((c) => c.scope === 'project' && c.metricId === 'M-20' && c.variant === 'refusal')
  assert.ok(refusal)
  assert.equal(geoMetricMembers(rows, refusal, options).rows.length, refusal.denominator)
})
