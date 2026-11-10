// The signals export for the offline RSI lab (scripts/ops/rsi-signals-export.mjs), against a recorder in place of the database: which statements it
// sends and with which closed vocabularies, what it does with a count under the floor, and that it writes nothing. What the statements select from
// real rows is rsiSignalsExport.integration.test.mjs.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { EVOLUTION_GAP_CODES, EVOLUTION_LEAD_SOURCES, EVOLUTION_TRACKS, VCR_ENGINE_METHOD_IDS } from '@evimed/domain'
import { EVOLUTION_DATA_SHAPES, EVOLUTION_DEMAND_REASONS, EVOLUTION_OPERATIONS, EVOLUTION_SIGNAL_KINDS } from '../src/evolutionSignals.mjs'
import { EVOLUTION_MODULE_IDS } from '../src/evolutionUsage.mjs'
import { assertSucceeded, exportScript, runSignalsExport } from './helpers/rsiSignalsExportApp.mjs'

const signalRow = (accounts, occurrences, extra = {}) => ({ module: 'tools', kind: 'unmet-demand', capability: 'meta-analysis', operation: 'meta-analysis', data_shape: 'table', reason: 'missing-tool', accounts, occurrences, ...extra })
const leadRow = (accounts, occurrences, extra = {}) => ({ source: 'virtual-study', track: 'M', gap_code: 'method-missing', code: 'vcr-comparator', endpoint: 'time_to_event', accounts, occurrences, ...extra })

test('a combination under five accounts is listed without its counts, one at five is listed with them, and nothing else is written', async () => {
  const result = await runSignalsExport({ rows: {
    signals: [signalRow(4, 40), signalRow(5, 5, { operation: 'survival-analysis' }), signalRow(1, 1, { module: 'geo', operation: 'unknown' }), signalRow(120, 400, { module: 'memory', kind: 'availability' })],
    leads: [leadRow(4, 9), leadRow(6, 6, { source: 'communication', code: 'analysis-not-offered', endpoint: null }), leadRow(5, 7, { source: 'runtime-failure', code: 'connector', gap_code: 'connector', endpoint: null })] } })
  assertSucceeded(result)
  const { document } = result
  assert.deepEqual(Object.keys(document), ['schema', 'exportedAt', 'releaseId', 'from', 'to', 'timeZone', 'floor', 'signals', 'leads'])
  assert.deepEqual([document.schema, document.releaseId, document.from, document.to, document.timeZone, document.floor], ['rsi-signals-export-v1', 'release-test.1', '2026-09-01', '2026-10-31', 'Asia/Shanghai', 5])
  assert.match(document.exportedAt, /^\d{4}-\d{2}-\d{2}$/, 'a day and no finer time')
  assert.deepEqual(document.signals.map((row) => [row.module, row.operation, row.accounts, row.occurrences]), [
    ['geo', 'unknown', '<5', null], ['memory', 'meta-analysis', 120, 400], ['tools', 'meta-analysis', '<5', null], ['tools', 'survival-analysis', 5, 5]], 'sorted by code, a small count withheld with its occurrences')
  assert.deepEqual(document.leads, [
    { source: 'communication', track: 'M', gapCode: 'method-missing', code: 'analysis-not-offered', endpoint: null, accounts: 6, occurrences: 6 },
    { source: 'runtime-failure', track: 'M', gapCode: 'connector', code: 'connector', endpoint: null, accounts: 5, occurrences: 7 },
    { source: 'virtual-study', track: 'M', gapCode: 'method-missing', code: 'vcr-comparator', endpoint: 'time_to_event', accounts: '<5', occurrences: null }])
  for (const row of [...document.signals, ...document.leads]) assert.ok(!Object.keys(row).some((key) => /user|project|run|event|id$|text|title|name/i.test(key)), Object.keys(row).join())
  assert.deepEqual(Object.keys(document.signals[0]), ['module', 'kind', 'capability', 'operation', 'dataShape', 'reason', 'accounts', 'occurrences'])
  // No total is written: a withheld count could be got back by subtracting what is listed from it.
  assert.ok(!JSON.stringify(document).match(/total|sum/i))
})

test('the statements are one read-only transaction over the window, with the release\'s own closed vocabularies as their only lists', async () => {
  const result = await runSignalsExport({ from: '2026-09-01', to: '2026-10-31' })
  assertSucceeded(result)
  assert.deepEqual(result.document.signals, [])
  assert.deepEqual(result.document.leads, [])
  const [begin, signals, leads, commit] = result.queries
  assert.match(begin.sql, /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY$/)
  assert.equal(commit.sql, 'COMMIT')
  assert.equal(result.queries.length, 4)
  const capabilities = JSON.parse(await readFile(new URL('../../../packages/domain/src/capability-contracts.json', import.meta.url), 'utf8')).capabilities.map((row) => row.id)
  assert.deepEqual(signals.params, ['2026-09-01', 'Asia/Shanghai', '2026-10-31', ['open-domain-answer', 'unknown', ...capabilities], [...EVOLUTION_OPERATIONS], [...EVOLUTION_DATA_SHAPES],
    [...EVOLUTION_DEMAND_REASONS], [...EVOLUTION_MODULE_IDS], [...EVOLUTION_SIGNAL_KINDS]])
  const families = [...new Set(VCR_ENGINE_METHOD_IDS.map((id) => `vcr-${id.split('.')[0]}`))]
  assert.deepEqual(leads.params, ['2026-09-01', 'Asia/Shanghai', '2026-10-31', [...EVOLUTION_LEAD_SOURCES], [...EVOLUTION_TRACKS], [...EVOLUTION_GAP_CODES],
    [...EVOLUTION_GAP_CODES, 'analysis-not-offered', ...families, 'vcr-other'], ['continuous', 'binary', 'time_to_event']])
  assert.ok(signals.params[3].includes('meta-analysis') && signals.params[4].includes('survival-analysis'), 'the lists are the real ones, not empty stand-ins')
  // Both statements project every code through its list in the statement and read the window in the platform's zone.
  for (const query of [signals, leads]) {
    assert.match(query.sql, /AT TIME ZONE \$2::text/)
    assert.match(query.sql, /deleted_at IS NULL/)
    assert.doesNotMatch(query.sql, /user_id\s*(,|AS)|\bid\b\s*AS|project_id|payload\s*(,|AS)|payload->>'(?:projectId|sourceEventId|sourceVersion|provenanceRef)'/, 'no identifier is selected')
  }
  assert.match(signals.sql, /coalesce\(payload->>'state', 'active'\) = 'active'/)
  assert.match(leads.sql, /payload->>'scope' = 'owner'/)
  const code = await readFile(exportScript, 'utf8')
  assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/.test(code.replace(/\/\*[\s\S]*?\*\//g, '')), 'the export writes nothing')
})

test('the window is two days of the lab\'s own, or the export refuses to run', async () => {
  for (const args of [[], ['--from', '2026-09-01'], ['--from', '2026-11-01', '--to', '2026-10-01'], ['--from', 'last-month', '--to', '2026-10-31']]) {
    const result = await runSignalsExport({ args })
    assert.notEqual(result.status, 0, JSON.stringify(args))
    assert.match(result.stderr, /Usage: rsi-signals-export\.mjs --from YYYY-MM-DD --to YYYY-MM-DD/)
    assert.deepEqual(result.queries, [], 'nothing is asked of the database')
  }
})
