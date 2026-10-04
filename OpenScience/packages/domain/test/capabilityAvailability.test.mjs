// The availability ladder and the operation record, as pure functions. What
// these pin is the row's own named failure cases: a package count or a mock
// runtime never yields "executable", an exact version is what a success is
// tied to, an unsupported operation is named, and install / use / update /
// remove / rollback / restart each move the state the way the facts moved.
import assert from 'node:assert/strict'
import test from 'node:test'

import * as domain from '../index.mjs'

// The inputs below are deliberately loose literals (a bad `kind`, a missing time, a weird outcome are the cases
// under test), so the functions are reached through handles that take them as they are.
const { AVAILABILITY_REASON_CODES, AVAILABILITY_SAMPLE_LIMIT, AVAILABILITY_STATE_LABELS_ZH, CAPABILITY_AVAILABILITY_STATES, availabilityReasonState, countAvailabilityStates, typicalOf } = domain
const describeAvailability = /** @type {(entry: any) => { label: string, text: string }} */ (domain.describeAvailability)
const emptyOperationRecord = /** @type {(subject: any) => any} */ (domain.emptyOperationRecord)
const foldOperation = /** @type {(record: any, observation: any) => any} */ (domain.foldOperation)
const normalizeOperationRecord = /** @type {(value: unknown) => any} */ (domain.normalizeOperationRecord)
const operationOutcomeOfRun = /** @type {(run: any) => string | null} */ (domain.operationOutcomeOfRun)
const projectAvailability = /** @type {(input: any) => any} */ (domain.projectAvailability)
const summarizeOperations = /** @type {(record: any) => any} */ (domain.summarizeOperations)

/** @param {string} at @param {Record<string, any>} [extra] */
const ref = (at, extra = {}) => ({ at, runId: `run_${at.slice(0, 10)}`, dispatchId: 'dispatch-1', sessionId: 'session-1', projectId: 'project-1', ...extra })
/** @param {string} at @param {Record<string, any>} [extra] */
const success = (at, extra = {}) => ({ kind: 'capability', id: 'adr-analysis', version: '1.3.1', outcome: 'succeeded', ref: ref(at), ...extra })
/** @param {string} at @param {string} [code] @param {Record<string, any>} [extra] */
const failure = (at, code = 'specialist_agent_unavailable', extra = {}) => ({ kind: 'capability', id: 'adr-analysis', version: '1.3.1', outcome: 'failed', ref: ref(at, { code }), ...extra })

/** @param {any[]} observations */
const recordOf = (...observations) => observations.reduce((record, observation) => foldOperation(record, observation), /** @type {any} */ (null))
const subject = { kind: 'capability', id: 'adr-analysis', version: '1.3.1' }

test('six states, each with the product word, and every reason belongs to exactly one of them', () => {
  assert.deepEqual([...CAPABILITY_AVAILABILITY_STATES], ['source-planned', 'installed', 'executable', 'limited', 'unavailable', 'unverified'])
  for (const state of CAPABILITY_AVAILABILITY_STATES) assert.match(AVAILABILITY_STATE_LABELS_ZH[/** @type {keyof typeof AVAILABILITY_STATE_LABELS_ZH} */ (state)], /^[一-鿿]+$/, state)
  const used = new Set()
  for (const code of AVAILABILITY_REASON_CODES) {
    const state = availabilityReasonState(code)
    assert.ok(state && CAPABILITY_AVAILABILITY_STATES.includes(state), `${code} names no state`)
    used.add(state)
    const { text } = describeAvailability({ kind: 'capability', version: '1.0.0', state, reason: { code, detail: 'meta_analysis', source: 'collector' }, operations: null })
    assert.match(text, /[一-鿿]/, `${code}: the sentence is Chinese`)
    assert.doesNotMatch(text, /[a-z]+_[a-z_]+/, `${code}: no identifier in front of a reader`)
  }
  assert.deepEqual([...used].sort(), [...CAPABILITY_AVAILABILITY_STATES].sort(), 'every state is reachable through a reason')
  assert.equal(availabilityReasonState('no-such-code'), null)
})

test('unverified is the honest default: nothing known, nothing claimed', () => {
  const entry = projectAvailability({ subject, collector: { state: 'off' } })
  assert.equal(entry.state, 'unverified')
  assert.equal(entry.reason.code, 'collector-off')
  assert.equal(entry.label, '未验证')
  // And an input that says nothing at all about a collector is read as a working one with an empty record.
  assert.equal(projectAvailability({ subject }).state, 'installed')
})

test('a package count never yields executable: only an operation does', () => {
  // There is no input for "how many packages are on disk"; what stands for presence is an empty record.
  for (const operations of [null, emptyOperationRecord(subject)]) {
    const entry = projectAvailability({ subject, operations })
    assert.equal(entry.state, 'installed')
    assert.equal(entry.reason.code, 'no-successful-operation')
    assert.notEqual(entry.state, 'executable')
  }
  // Failures alone are not a success either.
  const failedOnly = projectAvailability({ subject, operations: recordOf(failure('2026-10-02T00:00:00.000Z')) })
  assert.equal(failedOnly.state, 'limited')
  assert.equal(failedOnly.reason.code, 'last-operation-failed')
  assert.equal(failedOnly.reason.detail, 'specialist_agent_unavailable')
})

test('a mock runtime never yields executable, installed or any claim about a real kernel', () => {
  const operations = recordOf(success('2026-10-03T00:00:00.000Z'))
  const mocked = projectAvailability({ subject, operations, runtime: { mode: 'mock' } })
  assert.equal(mocked.state, 'unverified')
  assert.equal(mocked.reason.code, 'mock-runtime')
  assert.equal(mocked.reason.source, 'runtime-mode')
  assert.equal(projectAvailability({ subject, operations, runtime: { mode: 'kernel' } }).state, 'executable')
  // What the composition says is still true under a mock, so a known limit is still shown.
  const limited = projectAvailability({ subject, runtime: { mode: 'mock' }, reasons: [{ code: 'method-unmeasured', source: 'method-validation' }] })
  assert.equal(limited.state, 'limited')
})

test('executable is the exact version that really ran, and the newest fact wins', () => {
  const ran = recordOf(success('2026-10-03T08:00:00.000Z', { durationMs: 600_000 }))
  const entry = projectAvailability({ subject, operations: ran })
  assert.equal(entry.state, 'executable')
  assert.equal(entry.version, '1.3.1')
  assert.match(entry.text, /1\.3\.1 版/)
  assert.match(entry.text, /2026-10-03/)
  // A later failure makes it limited, and names the code and when it last worked.
  const worse = recordOf(success('2026-10-03T08:00:00.000Z'), failure('2026-10-04T08:00:00.000Z', 'specialist_execution_failed'))
  const after = projectAvailability({ subject, operations: worse })
  assert.equal(after.state, 'limited')
  assert.equal(after.reason.detail, 'specialist_execution_failed')
  assert.match(after.text, /2026-10-03/)
  assert.equal(after.operations?.successes, 1, 'the success is not lost, only outranked')
  // A later success heals it, whatever order the jobs finished in.
  const healed = recordOf(failure('2026-10-04T08:00:00.000Z'), success('2026-10-05T08:00:00.000Z'), success('2026-10-03T08:00:00.000Z'))
  assert.equal(projectAvailability({ subject, operations: healed }).state, 'executable')
  assert.equal(healed.lastSuccess.at, '2026-10-05T08:00:00.000Z', 'a late job for an older run cannot hide a newer one')
})

test('a missing engine or data source is a fact about today and outranks a success from the past', () => {
  const ran = recordOf(success('2026-10-03T08:00:00.000Z'))
  const down = projectAvailability({ subject, operations: ran, reasons: [{ code: 'engine-not-ready', detail: 'drug_safety_analysis', source: 'engine-health', facts: { engineState: 'unreachable' } }] })
  assert.equal(down.state, 'limited')
  assert.equal(down.reason.code, 'engine-not-ready')
  assert.match(down.text, /现在连不上/)
  assert.match(down.text, /提交后仍会受理/, 'a limited capability still dispatches and reports blocked by its own mechanism')
  assert.equal(down.operations?.lastSuccessAt, '2026-10-03T08:00:00.000Z')
  const missing = projectAvailability({ subject: { kind: 'capability', id: 'mendelian-randomization', version: '1.0.0' }, reasons: [{ code: 'data-source-not-configured', detail: 'opengwas', source: 'connector-registry' }] })
  assert.equal(missing.state, 'limited')
  assert.match(missing.text, /OpenGWAS/)
  assert.match(missing.text, /添加你自己的凭据/)
  // Several limits: the first decides, the rest are carried, never dropped.
  const several = projectAvailability({ subject, reasons: [
    { code: 'optional-tool-not-offered', detail: 'web_read', source: 'deployment-composition' },
    { code: 'method-unmeasured', source: 'method-validation' },
  ] })
  assert.equal(several.reason.code, 'optional-tool-not-offered')
  assert.deepEqual(several.also.map((/** @type {any} */ reason) => reason.code), ['method-unmeasured'])
})

test('what the deployment declines is unavailable, and the reader is told which tool', () => {
  const entry = projectAvailability({ subject: { kind: 'tool', id: 'frontier_search' }, reasons: [{ code: 'tool-not-offered', detail: 'frontier_search', source: 'deployment-composition' }] })
  assert.equal(entry.state, 'unavailable')
  assert.equal(entry.version, null, 'a tool has no version')
  assert.match(entry.text, /在这个部署上没有提供/)
  // Declined outranks a known limit and a success.
  const both = projectAvailability({ subject, operations: recordOf(success('2026-10-03T08:00:00.000Z')), reasons: [
    { code: 'method-unmeasured', source: 'method-validation' },
    { code: 'required-tool-not-offered', detail: 'drug_safety_analysis', source: 'deployment-composition' },
  ] })
  assert.equal(both.state, 'unavailable')
  assert.equal(both.reason.code, 'required-tool-not-offered')
})

test('a runtime that answered "unknown tool" after the last success says unavailable, and a later success undoes it', () => {
  const tool = { kind: 'tool', id: 'web_read' }
  const notMounted = { kind: 'tool', id: 'web_read', outcome: 'not-mounted', ref: ref('2026-10-04T01:00:00.000Z'), count: 2 }
  const worked = { kind: 'tool', id: 'web_read', outcome: 'succeeded', ref: ref('2026-10-03T01:00:00.000Z'), count: 5 }
  const record = recordOf(worked, notMounted)
  assert.equal(record.successes, 5)
  assert.equal(record.notMounted, 2)
  const entry = projectAvailability({ subject: tool, operations: record })
  assert.equal(entry.state, 'unavailable')
  assert.equal(entry.reason.code, 'not-mounted')
  assert.match(entry.text, /读网页/)
  assert.equal(projectAvailability({ subject: tool, operations: foldOperation(record, { ...worked, ref: ref('2026-10-05T01:00:00.000Z') }) }).state, 'executable')
})

test('a record still forming is unverified only until something is known', () => {
  assert.equal(projectAvailability({ subject, collector: { state: 'pending' } }).reason.code, 'collector-pending')
  const known = projectAvailability({ subject, collector: { state: 'pending' }, operations: recordOf(success('2026-10-03T08:00:00.000Z')) })
  assert.equal(known.state, 'executable', 'a success already folded is a fact whether or not the backlog is empty')
  const unreadable = projectAvailability({ subject, collector: { state: 'unreadable' }, operations: recordOf(success('2026-10-03T08:00:00.000Z')) })
  assert.equal(unreadable.state, 'unverified')
  assert.equal(unreadable.reason.code, 'records-unreadable')
})

test('a record folds counts, the newest times, bounded samples and a median that one outlier cannot move', () => {
  let record = null
  for (let day = 1; day <= 30; day += 1) {
    record = foldOperation(record, success(`2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`, {
      durationMs: day === 30 ? 9_000_000 : 60_000 * 20, costCny: 1.5, ...{},
    }))
  }
  record = foldOperation(record, failure('2026-09-15T12:00:00.000Z', 'specialist_agent_unavailable'))
  assert.equal(record.successes, 30)
  assert.equal(record.failures, 1)
  assert.equal(record.operations, 31)
  assert.equal(record.durationsMs.length, AVAILABILITY_SAMPLE_LIMIT)
  assert.equal(record.firstAt, '2026-09-01T00:00:00.000Z')
  const summary = summarizeOperations(record)
  assert.equal(summary?.typicalDurationMs, 60_000 * 20, 'the 150-minute outlier does not move the typical')
  assert.equal(summary?.typicalCostCny, 1.5)
  assert.equal(summary?.lastFailureCode, 'specialist_agent_unavailable')
  assert.equal(typicalOf([]), null)
  assert.equal(typicalOf([4, 1, 3, 2]), 2.5)
})

test('result versions and skill versions ride on the reference the audit cites, and the summary leaves them out', () => {
  const skills = [
    { name: 'adr-analysis', source: 'delegated', version: '1.3.1', digest: null },
    { name: 'personal-1', source: 'personal', version: null, digest: `sha256:${'a'.repeat(64)}` },
  ]
  const record = recordOf(success('2026-10-03T08:00:00.000Z', { ref: ref('2026-10-03T08:00:00.000Z', { resultVersions: 3, boundResultVersions: 2, skills }) }))
  assert.equal(record.resultVersions, 3)
  assert.equal(record.boundResultVersions, 2)
  assert.equal(record.lastSuccess.runId, 'run_2026-10-03')
  assert.equal(record.lastSuccess.skills.length, 2)
  const summary = /** @type {any} */ (summarizeOperations(record))
  assert.equal(summary.boundResultVersions, 2)
  assert.equal(JSON.stringify(summary).includes('run_2026'), false, 'an ordinary reader is never handed another account\'s run id')
  assert.equal(JSON.stringify(summary).includes('project-1'), false)
})

test('a stored record is read back whole, or not at all', () => {
  const record = recordOf(success('2026-10-03T08:00:00.000Z'), failure('2026-10-04T08:00:00.000Z'))
  assert.deepEqual(normalizeOperationRecord(JSON.parse(JSON.stringify(record))), record, 'a restart reads back what was written')
  for (const bad of [null, 'x', [], {}, { kind: 'capability' }, { kind: 'nope', id: 'x' }, { kind: 'tool', id: '' }]) assert.equal(normalizeOperationRecord(bad), null)
  const clean = normalizeOperationRecord({ kind: 'tool', id: 'web_read', successes: -3, failures: 'many', lastSuccess: { at: 'yesterday' }, durationsMs: [1, 'x', -4, Infinity] })
  assert.equal(clean?.successes, 0)
  assert.equal(clean?.failures, 0)
  assert.equal(clean?.lastSuccess, null)
  assert.deepEqual(clean?.durationsMs, [1])
  // An observation with no usable time is not folded: there is nothing to say when it happened.
  assert.equal(foldOperation(null, { kind: 'tool', id: 'web_read', outcome: 'succeeded', ref: { at: 'never' } }).operations, 0)
  assert.equal(foldOperation(null, { kind: 'tool', id: 'web_read', outcome: /** @type {any} */ ('weird'), ref: ref('2026-10-03T08:00:00.000Z') }).operations, 0)
})

test('a finished run is evidence only when it says something about the capability', () => {
  assert.equal(operationOutcomeOfRun({ status: 'succeeded', artifacts: 2 }), 'succeeded')
  assert.equal(operationOutcomeOfRun({ status: 'succeeded', artifacts: 0, resultVersions: 1 }), 'succeeded')
  assert.equal(operationOutcomeOfRun({ status: 'succeeded', artifacts: 0 }), 'failed', 'a capability that owes files and left none did not deliver')
  assert.equal(operationOutcomeOfRun({ status: 'succeeded', artifacts: 0, requiresFiles: false }), 'succeeded', 'an answer-mode capability delivers in its reply')
  assert.equal(operationOutcomeOfRun({ status: 'failed', errorCode: 'specialist_agent_unavailable' }), 'failed')
  assert.equal(operationOutcomeOfRun({ status: 'failed', errorCode: 'some_new_code' }), 'failed', 'an unknown code is a failure, never a guess at success')
  assert.equal(operationOutcomeOfRun({ status: 'failed', errorCode: 'runtime_canceled' }), null, 'a platform stop says nothing about the capability')
  assert.equal(operationOutcomeOfRun({ status: 'failed', errorCode: 'usage_budget_exceeded' }), null, 'nor does a ceiling')
  assert.equal(operationOutcomeOfRun({ status: 'canceled' }), null)
  assert.equal(operationOutcomeOfRun({ status: 'running' }), null)
})

test('install, use, update, remove, rollback and restart of an extension each move the state the way the facts moved', () => {
  /** @param {string} version */
  const ext = (version) => ({ kind: 'extension', id: 'cowork-docs', version })
  /** @param {string} version @param {string} at */
  const run = (version, at) => ({ kind: 'extension', id: 'cowork-docs', version, outcome: 'succeeded', ref: ref(at) })
  /** @type {any} */
  let records = new Map()
  /** @param {string} version */
  const keyOf = (version) => `extension\0cowork-docs\0${version}`
  /** @param {any} observation */
  const fold = (observation) => { const key = keyOf(observation.version); records.set(key, foldOperation(records.get(key) ?? null, observation)) }
  /** @param {string} version @param {any[]} [reasons] */
  const read = (version, reasons = []) => projectAvailability({ subject: ext(version), reasons, operations: records.get(keyOf(version)) ?? null })

  // install: asked for, being prepared -> named by the catalogue, not carried yet
  assert.equal(read('1.0.0', [{ code: 'installing', source: 'extension-installation' }]).state, 'source-planned')
  // prepared and waiting: carried, never used
  assert.equal(read('1.0.0').state, 'installed')
  // a prepared extension whose use nobody collects is unverified, with its own reason, even with the collector working
  const unproven = read('1.0.0', [{ code: 'use-not-collected', source: 'collector' }])
  assert.equal(unproven.state, 'unverified')
  assert.equal(unproven.reason.code, 'use-not-collected')
  assert.match(unproven.text, /还没有统计/)
  // use: a real operation of exactly this version
  fold(run('1.0.0', '2026-10-03T01:00:00.000Z'))
  assert.equal(read('1.0.0').state, 'executable')
  // update: the new exact version has never run, however well the old one did
  const updated = read('1.1.0')
  assert.equal(updated.state, 'installed')
  assert.equal(updated.version, '1.1.0')
  assert.match(updated.text, /1\.1\.0 版/)
  // ... and the old version's own history is untouched
  assert.equal(read('1.0.0').state, 'executable')
  fold(run('1.1.0', '2026-10-04T01:00:00.000Z'))
  assert.equal(read('1.1.0').state, 'executable')
  // remove: gone, whatever it did before
  const removed = read('1.1.0', [{ code: 'removed', source: 'extension-installation' }])
  assert.equal(removed.state, 'unavailable')
  assert.equal(removed.reason.code, 'removed')
  assert.equal(removed.operations?.successes, 1, 'the record outlives the installation')
  // rollback: the bytes of 1.0.0 are the bytes that ran before, so its success still stands
  assert.equal(read('1.0.0').state, 'executable')
  // restart: records are durable; what was written is what is read, and the state is the same
  const before = read('1.0.0')
  records = new Map([...records].map(([key, record]) => [key, normalizeOperationRecord(JSON.parse(JSON.stringify(record)))]))
  assert.deepEqual(read('1.0.0'), before)
  // an operation this deployment does not support is named, not hidden
  const unsupported = projectAvailability({ subject: { kind: 'extension', id: 'local-tool', version: '1.0.0' }, reasons: [{ code: 'unsupported', detail: 'local-only', source: 'extension-installation' }] })
  assert.equal(unsupported.state, 'unavailable')
  assert.equal(unsupported.reason.detail, 'local-only')
  assert.match(unsupported.text, /不支持/)
  const failed = projectAvailability({ subject: ext('2.0.0'), reasons: [{ code: 'preparation-failed', detail: 'extension_contract_invalid', source: 'extension-installation' }] })
  assert.equal(failed.state, 'unavailable')
})

test('counting entries by state names every state, including the empty ones', () => {
  const counts = countAvailabilityStates([{ state: 'executable' }, { state: 'executable' }, { state: 'limited' }, { state: 'bogus' }])
  assert.deepEqual(counts, { 'source-planned': 0, installed: 0, executable: 2, limited: 1, unavailable: 0, unverified: 0 })
})
