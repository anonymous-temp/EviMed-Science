/**
 * Every report-shaped contract kind reads its own structured output.
 *
 * Nine kinds shared one validator that checked file existence and Markdown
 * hygiene and nothing else. A probe run against the live gate on 2026-09-10
 * delivered `meta-analysis-run.json` containing `{ this is not json`,
 * `signals.csv` containing `ror=not-a-number`, and receipts consisting of a
 * single `[` — and every one of them came back `ok: true` with zero findings.
 * The engine had run, or had not; nothing in the package could tell you which,
 * and nothing in the gate looked.
 *
 * These are the mutations, one per kind, and they are advisory on purpose: the
 * blocking budget is spent and none of these checks has an observed
 * distribution yet. What they buy today is that the run is told, and that the
 * ledger can count how often it happens.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { runGate } from '../src/contractRegistry.mjs'

/** The kinds that fall through to the shared report validator. */
const REPORT_SHAPED = [
  'drug-evaluation-report',
  'drug-selection-report',
  'off-label-report',
  'meta-analysis-report',
  'mendelian-randomization-report',
  'bibliometric-analysis-report',
  'peer-review-report',
  'adr-analysis-report',
  'dataset-scoping-package',
]

/** @param {string} kind @param {Record<string, string>} files @param {string[]} [declared] */
const gate = (kind, files, declared = Object.keys(files)) => runGate({
  contractKind: kind,
  files: new Map(Object.entries(files)),
  expectedOutputs: declared.map((path) => ({ path, required: true })),
})

/** @param {any} verdict @returns {string[]} */
const codes = (verdict) => verdict.issues.map((/** @type {any} */ entry) => entry.code)

test('an unparseable run receipt is reported, for every report-shaped kind', () => {
  for (const kind of REPORT_SHAPED) {
    const receipt = `${kind.replace(/-report$|-package$/, '')}-run.json`
    const verdict = gate(kind, { 'report.md': '# 报告\n\n一段干净的正文。\n', [receipt]: '{ this is not json' })
    assert.ok(
      codes(verdict).includes('deliverable_json_unparseable'),
      `${kind} accepted an unparseable receipt: ${JSON.stringify(codes(verdict))}`,
    )
    // Advisory, so the package is still delivered and the run is told.
    const raised = verdict.issues.find((/** @type {any} */ entry) => entry.code === 'deliverable_json_unparseable')
    assert.ok(raised)
    assert.equal(raised.severity, 'advisory')
    assert.equal(raised.check, 'structured-output')
    assert.equal(verdict.ok, true, `${kind} must not start blocking on a check with no distribution behind it`)
  }
})

test('a receipt that names no engine job is reported', () => {
  const verdict = gate('meta-analysis-report', {
    'report.md': '# 报告\n\n正文。\n',
    'meta-analysis-run.json': JSON.stringify({ status: 'succeeded', artifacts: [] }),
  })
  assert.ok(codes(verdict).includes('deliverable_run_receipt_unbound'), JSON.stringify(codes(verdict)))
})

test('a receipt naming an artifact the package does not contain is reported', () => {
  const verdict = gate('adr-analysis-report', {
    'report.md': '# 报告\n\n正文。\n',
    'adr-analysis-run.json': JSON.stringify({ jobId: 'job_1', status: 'succeeded', artifacts: ['signals.csv'] }),
  })
  assert.ok(codes(verdict).includes('deliverable_run_artifact_missing'), JSON.stringify(codes(verdict)))
})

test('a complete receipt raises nothing', () => {
  const verdict = gate('adr-analysis-report', {
    'report.md': '# 报告\n\n正文。\n',
    'signals.csv': 'drug,event,ror\nmetformin,nausea,1.2\n',
    'adr-analysis-run.json': JSON.stringify({ jobId: 'job_1', status: 'succeeded', artifacts: ['signals.csv'] }),
  })
  assert.deepEqual(
    codes(verdict).filter((/** @type {string} */ code) => code.startsWith('deliverable_')),
    [],
    JSON.stringify(verdict.issues),
  )
})

test('a receipt admitting a degraded engine step names the steps', () => {
  const verdict = gate('bibliometric-analysis-report', {
    'report.md': '# 报告\n\n正文。\n',
    'bibliometric-analysis-run.json': JSON.stringify({
      jobId: 'job_1', status: 'succeeded', artifacts: [], degraded: true,
      modules: { query_generation: { status: 'failed', reason: 'httpx missing' }, network_analysis: { status: 'ok' } },
    }),
  })
  const raised = verdict.issues.find((/** @type {any} */ entry) => entry.code === 'deliverable_run_degraded')
  assert.ok(raised, JSON.stringify(codes(verdict)))
  assert.match(raised.message, /query_generation \(httpx missing\)/)
  assert.doesNotMatch(raised.message, /network_analysis/, 'a step that worked is not a finding')
  assert.equal(raised.severity, 'advisory')

  // Not degraded, nothing said. And an engine that reports no ledger at all is
  // not treated as one that reported no degradation.
  const clean = gate('bibliometric-analysis-report', {
    'report.md': '# 报告\n\n正文。\n',
    'bibliometric-analysis-run.json': JSON.stringify({ jobId: 'job_1', status: 'succeeded', artifacts: [] }),
  })
  assert.deepEqual(codes(clean).filter((/** @type {string} */ code) => code === 'deliverable_run_degraded'), [])
})

test('a table that is not a table is reported, and a quoted comma is not a column', () => {
  const single = gate('adr-analysis-report', { 'report.md': '# 报告\n\n正文。\n', 'signals.csv': 'ror=not-a-number\n' })
  assert.ok(codes(single).includes('deliverable_table_shape'), JSON.stringify(codes(single)))

  const ragged = gate('adr-analysis-report', {
    'report.md': '# 报告\n\n正文。\n',
    'signals.csv': 'drug,event,ror\nmetformin,nausea\n',
  })
  const raised = ragged.issues.find((/** @type {any} */ entry) => entry.code === 'deliverable_table_shape')
  assert.ok(raised, JSON.stringify(codes(ragged)))
  assert.equal(raised.line, 2, 'the finding must name the row the reader should look at')

  // A comma inside a quoted field is data, not a column boundary. Counting it
  // as one would report every well-formed citation ledger as ragged.
  const quoted = gate('adr-analysis-report', {
    'report.md': '# 报告\n\n正文。\n',
    'signals.csv': 'drug,event,note\nmetformin,nausea,"mild, transient"\n',
  })
  assert.deepEqual(codes(quoted).filter((/** @type {string} */ code) => code === 'deliverable_table_shape'), [])
})

test('an empty declared file is still the required-output finding, not a shape one', () => {
  // The two checks must not double-report: an absent table is already a
  // blocking required-output issue and does not need a second voice.
  const verdict = gate('adr-analysis-report', { 'report.md': '# 报告\n\n正文。\n', 'signals.csv': '' })
  assert.ok(codes(verdict).includes('required_output_empty'))
  assert.deepEqual(codes(verdict).filter((/** @type {string} */ code) => code === 'deliverable_table_shape'), [])
})
