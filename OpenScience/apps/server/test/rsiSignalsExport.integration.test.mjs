// The signals export (scripts/ops/rsi-signals-export.mjs) against the product ledger's real schema: what its two statements count, which rows they
// leave out, and that a tenant's own words — in every free field a record has, and in the codes themselves — never reach what is pushed to the lab.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { EVOLUTION_GAP_CODES, EVOLUTION_LEAD_SOURCES, EVOLUTION_TRACKS, VCR_ENGINE_METHOD_IDS } from '@evimed/domain'
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs'
import { EVOLUTION_DATA_SHAPES, EVOLUTION_DEMAND_REASONS, EVOLUTION_OPERATIONS, EVOLUTION_SIGNAL_KINDS } from '../src/evolutionSignals.mjs'
import { EVOLUTION_MODULE_IDS } from '../src/evolutionUsage.mjs'
import { migrateProductStore } from '../src/productPersistence.mjs'
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs'
import { assertSucceeded, runSignalsExport } from './helpers/rsiSignalsExportApp.mjs'

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? ''
const options = { skip: !databaseUrl && 'Local test Postgres is not configured' }
/** Every string a tenant could have put in a record. None of it may appear in the output. */
const TENANT = 'ACME-Hospital-Oncology-7'
const users = Array.from({ length: 8 }, (_, i) => `${TENANT}-user-${i + 1}`)
const owner = `${TENANT}-evolution-owner`
let isolated, database

before(async () => {
  if (!databaseUrl) return
  isolated = await createGeoTestDatabase(databaseUrl, 'sigx')
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 })
  await migrateProductStore(database)
  for (const id of [owner, ...users]) await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,$2,'development')", [id, `${TENANT} ${id}`])
})
after(async () => {
  if (!database) return
  await database.close()
  await isolated.drop()
})

// Platform days are Asia/Shanghai ones: the window 2026-09-01..2026-10-31 is 2026-08-31T16:00Z up to 2026-10-31T16:00Z.
const IN = '2026-09-15T04:00:00Z', FIRST_INSTANT = '2026-08-31T16:00:00Z', LAST_INSTANT = '2026-10-31T15:59:59Z', AFTER = '2026-10-31T16:00:00Z', BEFORE = '2026-08-31T15:59:59Z'
let sequence = 0
async function put(user, recordType, payload, { at = IN, deleted = false, kind = 'knowledge' } = {}) {
  const id = `${recordType}-${TENANT}-${sequence += 1}`
  await database.query('INSERT INTO evimed_product.documents(user_id,kind,id,payload,created_at,updated_at,deleted_at) VALUES ($1,$2,$3,$4,$5,$5,$6)',
    [user, kind, id, { recordType, ...payload }, at, deleted ? at : null])
  return id
}
const signal = (user, codes, extra = {}, when) => put(user, 'evolution-signal', { moduleId: 'tools', kind: 'unmet-demand', codes, projectId: `${TENANT}-project`, sourceEventId: `${TENANT}-event`,
  sourceVersion: `${TENANT}-version`, provenanceRef: `${TENANT}-ref`, firstSeenAt: IN, count: 1, scope: 'owner', ...extra }, when)
const CODES = { capability: 'meta-analysis', operation: 'meta-analysis', dataShape: 'table', reason: 'missing-tool' }
/** Every string a row of the output holds is a member of a list the release owns (or a capability id, or a withheld count): a row is its codes and two counts. */
const CAPABILITIES = ['open-domain-answer', 'unknown', 'meta-analysis']
const SIGNAL_WORDS = new Set([...EVOLUTION_MODULE_IDS, ...EVOLUTION_SIGNAL_KINDS, ...CAPABILITIES, ...EVOLUTION_OPERATIONS, ...EVOLUTION_DATA_SHAPES, ...EVOLUTION_DEMAND_REASONS, '<5'])
const LEAD_WORDS = new Set([...EVOLUTION_LEAD_SOURCES, 'unknown', ...EVOLUTION_TRACKS, ...EVOLUTION_GAP_CODES, 'analysis-not-offered', 'vcr-other', 'other', 'continuous', 'binary', 'time_to_event', '<5',
  ...VCR_ENGINE_METHOD_IDS.map((id) => `vcr-${id.split('.')[0]}`)])
const strangers = (rows, words) => rows.flatMap((row) => Object.values(row)).filter((value) => typeof value === 'string' && !words.has(value))
const rowCounts = async () => (await database.query('SELECT count(*)::int AS n, coalesce(sum(revision),0)::int AS r FROM evimed_product.documents')).rows[0]

test('signals are counted by their closed codes over distinct accounts, and nothing a tenant wrote gets out', options, async () => {
  // Six accounts, twice each, a combination the floor lets through.
  for (const user of users.slice(0, 6)) { await signal(user, CODES); await signal(user, CODES) }
  // Three accounts on another combination: listed, withheld.
  for (const user of users.slice(0, 3)) await signal(user, { ...CODES, operation: 'survival-analysis', dataShape: 'time-to-event' })
  // Codes a tenant typed: every one falls back to `unknown` (the reason to `unsupported`), and the groups they fall into are merged, counted over distinct accounts.
  const hostile = { capability: `${TENANT}-secret-capability`, operation: `${TENANT} operation`, dataShape: `${TENANT}/shape`, reason: `${TENANT} reason` }
  for (const user of users.slice(0, 5)) await signal(user, hostile, { moduleId: 'geo', kind: 'geo-misconception' })
  for (const user of users.slice(4, 7)) await signal(user, { capability: 'unknown', operation: 'unknown', dataShape: 'unknown', reason: 'unsupported' }, { moduleId: 'geo', kind: 'geo-misconception' })
  // Left out: a module or kind the release does not have, a withdrawn or suspended assessment, a deleted record, another record type, other days.
  for (const user of users) await signal(user, CODES, { moduleId: `${TENANT}-module` })
  for (const user of users) await signal(user, CODES, { kind: `${TENANT}-kind` })
  for (const user of users) await signal(user, CODES, { sourceRevision: 1, state: 'invalidated' })
  for (const user of users) await signal(user, CODES, { sourceRevision: 1, state: 'suspended' })
  for (const user of users) await signal(user, CODES, {}, { deleted: true })
  for (const user of users) await put(user, 'evolution-signal-summary', { moduleId: 'tools', kind: 'unmet-demand', codes: CODES, state: 'active' })
  for (const user of users) await signal(user, CODES, {}, { at: BEFORE })
  for (const user of users) await signal(user, CODES, {}, { at: AFTER })
  // The two instants that are in: the first and the last of the window's days.
  await signal(users[6], { ...CODES, operation: 'network-analysis', dataShape: 'network' }, {}, { at: FIRST_INSTANT })
  for (const user of users.slice(0, 5)) await signal(user, { ...CODES, operation: 'network-analysis', dataShape: 'network' }, {}, { at: LAST_INSTANT })

  const before = await rowCounts()
  const result = await runSignalsExport({ databaseUrl: isolated.url })
  assertSucceeded(result)
  assert.deepEqual(await rowCounts(), before, 'the export wrote nothing')
  const { document } = result
  const find = (row) => document.signals.find((entry) => Object.entries(row).every(([key, value]) => entry[key] === value))
  assert.deepEqual(find({ module: 'tools', operation: 'meta-analysis' }), { module: 'tools', kind: 'unmet-demand', capability: 'meta-analysis', operation: 'meta-analysis', dataShape: 'table', reason: 'missing-tool', accounts: 6, occurrences: 12 })
  assert.deepEqual(find({ operation: 'survival-analysis' }), { module: 'tools', kind: 'unmet-demand', capability: 'meta-analysis', operation: 'survival-analysis', dataShape: 'time-to-event', reason: 'missing-tool', accounts: '<5', occurrences: null })
  assert.deepEqual(find({ module: 'geo' }), { module: 'geo', kind: 'geo-misconception', capability: 'unknown', operation: 'unknown', dataShape: 'unknown', reason: 'unsupported', accounts: 7, occurrences: 8 },
    'five accounts with codes of their own words and three with plain unknowns are seven accounts, one of them in both')
  assert.deepEqual(find({ operation: 'network-analysis' }), { module: 'tools', kind: 'unmet-demand', capability: 'meta-analysis', operation: 'network-analysis', dataShape: 'network', reason: 'missing-tool', accounts: 6, occurrences: 6 },
    'the first and the last instant of the window are in')
  assert.equal(document.signals.length, 4, 'nothing else was read: no unknown module or kind, no withdrawn or deleted record, no summary, no other day')
  assert.deepEqual(document.leads, [])
  assert.ok(!result.stdout.includes('ACME'), 'no tenant string — a user, project, event, version, reference or code — is in the output')
  assert.deepEqual(strangers(document.signals, SIGNAL_WORDS), [], 'every value of every row is a code of the release\'s own lists')
  assert.deepEqual(new Set(document.signals.flatMap((row) => Object.keys(row))), new Set(['module', 'kind', 'capability', 'operation', 'dataShape', 'reason', 'accounts', 'occurrences']))
  // Run again: the same file but for nothing at all.
  assert.equal((await runSignalsExport({ databaseUrl: isolated.url })).stdout, result.stdout)
})

test('leads are counted over the accounts that met them, by closed code, and a tenant\'s code or endpoint is not one', options, async () => {
  const lead = (payload) => put(owner, 'evolution-lead', { track: 'M', gapCode: 'method-missing', status: 'queued', distinctAccounts: 99, entityKeys: [`${TENANT}-drug`], papers: [{ doi: `${TENANT}-doi` }], method: `${TENANT}-method`, ...payload })
  const met = async (leadId, accounts, extra = {}, when) => { for (const user of accounts) await put(user, 'evolution-lead-occurrence', { leadId, eventId: `${TENANT}-event`, projectId: `${TENANT}-project`, at: IN, scope: 'owner', ...extra }, when) }
  // A 虚拟临床研究 method-missing lead the engine does not publish, five accounts: counted.
  await met(await lead({ source: 'virtual-study', code: 'vcr-comparator', endpoint: 'time_to_event' }), users.slice(0, 5))
  // GEO's analysis-not-offered, two accounts: listed, withheld.
  await met(await lead({ source: 'communication', code: 'analysis-not-offered' }), users.slice(0, 2))
  // A run that found no connector (the leads that are filed today): its gap code is its code.
  await met(await lead({ source: 'runtime-failure', gapCode: 'connector', code: 'connector', track: 'U' }), users)
  // A lead whose every code is a tenant's own: the source, track, gap code, code and endpoint each fall back.
  await met(await lead({ source: `${TENANT}-source`, track: `${TENANT}-track`, gapCode: `${TENANT}-gap`, code: `${TENANT}-code`, endpoint: `${TENANT}-endpoint` }), users.slice(0, 6))
  // Left out: an occurrence that was not an account's own, one outside the window, a deleted one, and a record that is no occurrence.
  const other = await lead({ source: 'autopilot', gapCode: 'method-implementation', code: 'method-implementation' })
  await met(other, users, { scope: 'platform' })
  await met(other, users, {}, { at: AFTER })
  await met(other, users, {}, { deleted: true })
  for (const user of users) await put(user, 'evolution-lead', { source: 'autopilot', gapCode: 'method-implementation', code: 'method-implementation', track: 'M' })

  const result = await runSignalsExport({ databaseUrl: isolated.url })
  assertSucceeded(result)
  assert.deepEqual(result.document.leads, [
    { source: 'communication', track: 'M', gapCode: 'method-missing', code: 'analysis-not-offered', endpoint: null, accounts: '<5', occurrences: null },
    { source: 'runtime-failure', track: 'U', gapCode: 'connector', code: 'connector', endpoint: null, accounts: 8, occurrences: 8 },
    { source: 'unknown', track: 'unknown', gapCode: 'unknown', code: 'other', endpoint: null, accounts: 6, occurrences: 6 },
    { source: 'virtual-study', track: 'M', gapCode: 'method-missing', code: 'vcr-comparator', endpoint: 'time_to_event', accounts: 5, occurrences: 5 },
  ])
  assert.ok(!result.stdout.includes('ACME'))
  assert.deepEqual(strangers(result.document.leads, LEAD_WORDS), [], 'every value of every row is a code of the release\'s own lists')
  assert.deepEqual(new Set(result.document.leads.flatMap((row) => Object.keys(row))), new Set(['source', 'track', 'gapCode', 'code', 'endpoint', 'accounts', 'occurrences']))
})

test('a window with nothing in it is two empty lists', options, async () => {
  const result = await runSignalsExport({ databaseUrl: isolated.url, from: '2025-01-01', to: '2025-01-31' })
  assertSucceeded(result)
  assert.deepEqual([result.document.signals, result.document.leads], [[], []])
})
