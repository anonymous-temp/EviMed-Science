/**
 * Whether a capability, a tool, a skill or an extension can really be used on
 * THIS deployment, and why the product says so.
 *
 * Hidden knowledge: until this module the product could say what a capability
 * claims (`capability-display.json`: its title, its limits, an `evaluation`
 * block generated from the offline acceptance ledger that no code read) but
 * never whether it had ever delivered *here*. What a deployment really did was
 * already written down — the run ledger, tool outcomes in the transcripts, the
 * engines' own `/health`, the connector registry, the extension labels — and
 * none of it reached the catalogue. A package count says how much is on disk;
 * a mock runtime says nothing about a real kernel; an outside probe says what
 * one release audit saw once. None of those is "it ran here".
 *
 * Six states, read as a ladder and never as a score:
 *
 *   source-planned  the source names it; this deployment (or this account) does
 *                   not carry it yet
 *   installed       carried and offered, with no known blocker, and not once
 *                   exercised successfully on this deployment
 *   executable      this exact version has completed a real operation here
 *   limited         it can be asked, and something it needs is missing or the
 *                   latest operation did not succeed — the reason names what
 *   unavailable     the deployment declines it (a tool not offered, a module
 *                   off, an engine never configured) or the runtime says it
 *                   does not mount it
 *   unverified      the honest default: nothing here can be believed either
 *                   way (a mock runtime, no collector, an unreadable record,
 *                   a record still being assembled)
 *
 * It is a LABEL (owner ruling 2026-10-04): it never hides a capability,
 * disables a button or refuses a dispatch. A capability whose engine is down
 * still dispatches and reports `blocked` through its own mechanism; this only
 * says, in advance and truthfully, that it is likely to.
 *
 * Two things are kept apart on purpose. The evidence for a state is a closed
 * list of record sources (`AVAILABILITY_RECORD_SOURCES`), so a reader of the
 * export can tell "the engine answered /health" from "a run delivered". And the
 * qualification labels of the extension centre are a different axis: they say
 * whether a combination was MEASURED, and are carried beside a state, never
 * folded into it.
 *
 * Pure: no clock, no files, no database. The control plane's collector turns
 * finished runs into observations, `foldOperation` is the one place a record
 * changes, and `projectAvailability` is the one place a state is decided.
 *
 * @module @evimed/domain/src/capabilityAvailability
 */

import { DISPLAY_TIME_ZONE, agendaLocalDate } from './agendaSchedule.mjs'
import { connectorCredentialSpec } from './connectorCredentials.mjs'
import { errorCodeMessage, errorCodeOutcome } from './errorCodes.mjs'
import { mcpToolName } from './toolNames.mjs'
import { toolViewPhrase } from './toolViewPhrases.mjs'

/** The six states, in the order a reader should think of them. */
export const CAPABILITY_AVAILABILITY_STATES = Object.freeze(['source-planned', 'installed', 'executable', 'limited', 'unavailable', 'unverified'])

/** What a state is about. A tool has no version; the other three do. */
export const AVAILABILITY_SUBJECT_KINDS = Object.freeze(['capability', 'tool', 'skill', 'extension'])

/**
 * Where the fact that decided a state was read. A closed list, so the export
 * says which kind of record stands behind each label.
 */
export const AVAILABILITY_RECORD_SOURCES = Object.freeze([
  'source-catalogue',
  'deployment-composition',
  'operation-record',
  'engine-health',
  'connector-registry',
  'method-validation',
  'runtime-mode',
  'extension-installation',
  'collector',
  'image-recipe',
  'package-record',
])

/** The product's word for each state; read by the capability page and the export. */
export const AVAILABILITY_STATE_LABELS_ZH = Object.freeze({
  'source-planned': '规划中',
  installed: '已安装',
  executable: '可运行',
  limited: '受限',
  unavailable: '不可用',
  unverified: '未验证',
})

/** The operation record's schema version, and the export's. */
export const AVAILABILITY_RECORD_VERSION = 1

/** How many recent durations and costs a record keeps: the median of these is its "typical". */
export const AVAILABILITY_SAMPLE_LIMIT = 21

/**
 * @typedef {'source-planned'|'installed'|'executable'|'limited'|'unavailable'|'unverified'} AvailabilityState
 * @typedef {'capability'|'tool'|'skill'|'extension'} AvailabilitySubjectKind
 */

/**
 * A reason is a code from the closed table below plus, when it names a thing,
 * the identifier of that thing — a tool's base name, a connector id, an error
 * code. Never a sentence: the words are `describeAvailability`'s.
 * @typedef {object} AvailabilityReason
 * @property {string} code
 * @property {string} [detail]
 * @property {string} source one of AVAILABILITY_RECORD_SOURCES
 * @property {Record<string, unknown>} [facts] non-secret facts the record cites (an engine's answer, a label)
 */

/** @param {string | undefined} detail @returns {string} */
const verbOf = (detail) => {
  const base = String(detail ?? '')
  return (base && toolViewPhrase(mcpToolName(base))?.verb) || '一项工具'
}

/** The day a reader is told something last worked, in the deployment's display zone, not the UTC day. @param {unknown} value @returns {string | null} */
const dayOf = (value) => {
  const time = Date.parse(String(value ?? ''))
  return Number.isFinite(time) ? agendaLocalDate(DISPLAY_TIME_ZONE, new Date(time)) : null
}

/** @param {Record<string, unknown>} context @returns {string} */
const versionPhrase = (context) => {
  const version = typeof context.version === 'string' && context.version ? context.version : ''
  return version ? `${version} 版` : ''
}

/** A software or data name as a reader meets it: distributions are written with hyphens, never as an identifier. @param {unknown} name @returns {string} */
const softwareOf = (name) => String(name ?? '').replace(/_/gu, '-')

/** @param {unknown} kind @returns {string} */
const nounOf = (kind) => (kind === 'tool' ? '这个工具' : kind === 'extension' ? '这个扩展' : kind === 'skill' ? '这个技能' : '这个能力')

/**
 * Every reason a state can carry: its state, and its sentence for a reader. The
 * state lives here and nowhere else, so a caller cannot say `limited` for a code
 * that means `unavailable`.
 * @type {Readonly<Record<string, readonly [AvailabilityState, (detail: string | undefined, context: Record<string, unknown>) => string]>>}
 */
const REASONS = Object.freeze({
  // The source names it; this deployment or this account does not carry it.
  'not-in-this-deployment': ['source-planned', () => '目录里列了它，这个部署还没有安装。'],
  'not-installed': ['source-planned', (_d, c) => `目录里有，你还没有安装${c.kind === 'extension' ? '这个扩展' : ''}。`],
  installing: ['source-planned', () => '正在准备，完成后才能使用。'],
  // Carried and offered; never exercised successfully here.
  'no-successful-operation': ['installed', (_d, c) => `${versionPhrase(c)}已${c.kind === 'tool' ? '提供' : '安装'}，还没有在这个部署上成功${c.kind === 'tool' ? '调用' : '运行'}过。`],
  // An operation of this exact version has completed here.
  'succeeded-here': ['executable', (_d, c) => {
    const day = dayOf(c.lastSuccessAt)
    return `${versionPhrase(c)}已在这个部署上成功${c.kind === 'tool' ? '调用' : '运行'}过${day ? `，最近一次是 ${day}` : ''}。`
  }],
  // It can be asked, and something it needs is missing or just failed.
  'engine-not-ready': ['limited', (d, c) => `分析引擎（${verbOf(d)}）${c.engineState === 'unreachable' ? '现在连不上' : '现在没有就绪'}；提交后仍会受理，受阻时会如实说明。`],
  'data-source-not-configured': ['limited', (d) => `数据源「${connectorCredentialSpec(String(d ?? ''))?.title ?? '一个外部数据源'}」这个部署没有配置，使用时可以添加你自己的凭据；其余部分照常。`],
  // 「虚拟临研」's statistics engine: composed and not answering, or not composed at all. Neither stops a study: the steps
  // that do not compute stand, and a computation submitted now is accepted and continues by itself once the engine is back.
  'vcr-engine-not-answering': ['limited', () => '统计计算引擎现在没有回应；提交的计算会被受理，引擎恢复后自动继续。'],
  'vcr-engine-not-configured': ['limited', () => '这个部署没有接入统计计算引擎；需要计算的那一步暂不可用，其余步骤照常。'],
  'method-unmeasured': ['limited', () => '方法的数值验证还没有完成，结果按未验证的方法对待。'],
  'optional-tool-not-offered': ['limited', (d) => `「${verbOf(d)}」在这个部署上没有提供；其余部分照常。`],
  // A package carried here needs software, data or weights that this deployment's runtime does not have.
  'dependency-software-missing': ['limited', (d) => `它用到的软件「${softwareOf(d)}」运行环境里没有；需要它的方法会受阻，其余部分照常。`],
  'dependency-version-differs': ['limited', (d, c) => `它指定「${softwareOf(d)}」${String(c.wanted ?? '')}，运行环境装的是 ${String(c.have ?? '')}；结果以运行环境的版本为准。`],
  'dependency-data-missing': ['limited', (d) => `它需要的数据或模型权重「${softwareOf(d)}」这个部署没有提供；其余部分照常。`],
  'last-operation-failed': ['limited', (d, c) => {
    const earlier = dayOf(c.lastSuccessAt)
    return `最近一次${c.kind === 'tool' ? '调用' : '运行'}没有成功（${errorCodeMessage(String(d ?? ''))}）${earlier ? `；此前成功过，最近一次是 ${earlier}` : ''}。`
  }],
  // The deployment declines it, or the runtime says it does not mount it.
  'tool-not-offered': ['unavailable', (d) => `「${verbOf(d)}」在这个部署上没有提供。`],
  'required-tool-not-offered': ['unavailable', (d) => `它依赖的「${verbOf(d)}」在这个部署上没有提供。`],
  'engine-not-configured': ['unavailable', (d) => `分析引擎（${verbOf(d)}）这个部署没有配置。`],
  'module-off': ['unavailable', () => '对应的功能模块在这个部署上没有开启。'],
  'module-not-open': ['unavailable', () => '对应的功能模块还没有向你的账号开放。'],
  'not-mounted': ['unavailable', (d) => `运行环境没有挂载「${verbOf(d)}」：调用时被告知它不存在。`],
  removed: ['unavailable', () => '已移除。'],
  unsupported: ['unavailable', () => '它需要的运行方式，这个部署不支持。'],
  'preparation-failed': ['unavailable', (d) => `准备没有成功（${errorCodeMessage(String(d ?? ''))}）。`],
  // Nothing here can be believed either way.
  'mock-runtime': ['unverified', () => '当前是模拟运行环境，不能证明真实可运行。'],
  // Carried and prepared, but this kind of subject's use is not collected, so nothing here proves it runs.
  'use-not-collected': ['unverified', (_d, c) => `${versionPhrase(c)}已准备好，但${nounOf(c.kind)}的实际使用还没有统计，无法确认能否运行。`],
  // A dependency whose presence could not be read is not called present.
  'dependency-unchecked': ['unverified', (d) => `它需要的「${softwareOf(d)}」暂时无法核对是否具备，无法确认能否运行。`],
  'collector-off': ['unverified', () => '这个部署没有统计实际运行的情况，无法确认。'],
  'collector-pending': ['unverified', () => '正在整理这个部署上已完成的运行，暂时无法确认。'],
  'records-unreadable': ['unverified', () => '实际运行的情况暂时读不到，无法确认。'],
})

/** Every reason code, for the exporters' and the tests' sake. */
export const AVAILABILITY_REASON_CODES = Object.freeze(Object.keys(REASONS))

/** @param {string} code @returns {AvailabilityState | null} the state a reason code belongs to */
export function availabilityReasonState(code) {
  return REASONS[code]?.[0] ?? null
}

/**
 * One operation record: what finished operations of one (capability, version),
 * one tool, one skill or one extension say about it on this deployment.
 *
 * `lastSuccess` and `lastFailure` carry the join the collector made — which run,
 * dispatch and session, which result versions were produced, which skill
 * versions were loaded — so the release audit can cite what the deployment did.
 * Those references are opaque ids of accounts' own work: the ordinary catalogue
 * never shows them, the operator export does.
 *
 * @typedef {object} OperationRef
 * @property {string} at ISO time the operation finished
 * @property {string | null} [code] a failure's error code
 * @property {string | null} [runId]
 * @property {string | null} [dispatchId]
 * @property {string | null} [sessionId]
 * @property {string | null} [projectId]
 * @property {number} [resultVersions] result versions this operation produced
 * @property {number} [boundResultVersions] of which each digest is bound to its producer's own receipt
 * @property {{ name: string, source: string, version: string | null, digest: string | null }[]} [skills] skill versions loaded
 *
 * @typedef {object} OperationRecord
 * @property {number} schemaVersion
 * @property {AvailabilitySubjectKind} kind
 * @property {string} id
 * @property {string} version '' for a tool
 * @property {number} operations
 * @property {number} successes
 * @property {number} failures
 * @property {number} notMounted calls the runtime answered "unknown tool"
 * @property {string | null} firstAt
 * @property {OperationRef | null} lastSuccess
 * @property {OperationRef | null} lastFailure
 * @property {OperationRef | null} lastNotMounted
 * @property {number[]} durationsMs recent successful durations, newest last
 * @property {number[]} costsCny recent successful settled costs, newest last
 * @property {number} resultVersions
 * @property {number} boundResultVersions
 */

/**
 * One finished operation as the collector saw it. `count` is how many calls of a
 * tool in one run ended this way; a capability observation is always one.
 *
 * @typedef {object} OperationObservation
 * @property {AvailabilitySubjectKind} kind
 * @property {string} id
 * @property {string} [version]
 * @property {'succeeded' | 'failed' | 'not-mounted'} outcome
 * @property {OperationRef} ref
 * @property {number} [count]
 * @property {number | null} [durationMs]
 * @property {number | null} [costCny]
 */

/** @param {unknown} value @returns {number} */
const count = (value) => (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : 0)

/** @param {unknown} value @returns {string | null} */
const timeOrNull = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null)

/** @param {unknown} value @returns {string | null} */
const idOrNull = (value) => (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/.test(value) ? value : null)

/**
 * A reference as it may be stored: bounded, with every field optional but the
 * time. Anything that does not read as a reference is dropped, never repaired.
 * @param {unknown} value @returns {OperationRef | null}
 */
function normalizeRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = /** @type {Record<string, any>} */ (value)
  const at = timeOrNull(raw.at)
  if (!at) return null
  const skills = Array.isArray(raw.skills)
    ? raw.skills.slice(0, 16).flatMap((/** @type {any} */ skill) => {
      const name = typeof skill?.name === 'string' && skill.name && skill.name.length <= 160 ? skill.name : null
      const source = typeof skill?.source === 'string' && /^[a-z][a-z-]{0,23}$/.test(skill.source) ? skill.source : null
      if (!name || !source) return []
      const digest = typeof skill.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(skill.digest) ? skill.digest : null
      const version = typeof skill.version === 'string' && skill.version.length <= 64 ? skill.version : null
      return [{ name, source, version, digest }]
    })
    : []
  return {
    at,
    ...(typeof raw.code === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(raw.code) ? { code: raw.code } : {}),
    runId: idOrNull(raw.runId),
    dispatchId: idOrNull(raw.dispatchId),
    sessionId: idOrNull(raw.sessionId),
    projectId: idOrNull(raw.projectId),
    ...(count(raw.resultVersions) ? { resultVersions: count(raw.resultVersions) } : {}),
    ...(count(raw.boundResultVersions) ? { boundResultVersions: count(raw.boundResultVersions) } : {}),
    ...(skills.length ? { skills } : {}),
  }
}

/** @param {unknown} value @returns {number[]} */
const samples = (value) => (Array.isArray(value)
  ? value.filter((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0).slice(-AVAILABILITY_SAMPLE_LIMIT)
  : [])

/**
 * A stored record, read back. Total: a record that does not read as one is
 * `null`, so a bad row can lose its own history and nothing else.
 * @param {unknown} value @returns {OperationRecord | null}
 */
export function normalizeOperationRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = /** @type {Record<string, any>} */ (value)
  if (!AVAILABILITY_SUBJECT_KINDS.includes(raw.kind) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 200) return null
  const version = typeof raw.version === 'string' && raw.version.length <= 200 ? raw.version : ''
  const successes = count(raw.successes)
  const failures = count(raw.failures)
  const notMounted = count(raw.notMounted)
  return {
    schemaVersion: AVAILABILITY_RECORD_VERSION,
    kind: raw.kind,
    id: raw.id,
    version,
    operations: successes + failures + notMounted,
    successes,
    failures,
    notMounted,
    firstAt: timeOrNull(raw.firstAt),
    lastSuccess: normalizeRef(raw.lastSuccess),
    lastFailure: normalizeRef(raw.lastFailure),
    lastNotMounted: normalizeRef(raw.lastNotMounted),
    durationsMs: samples(raw.durationsMs),
    costsCny: samples(raw.costsCny),
    resultVersions: count(raw.resultVersions),
    boundResultVersions: count(raw.boundResultVersions),
  }
}

/** @param {{ kind: AvailabilitySubjectKind, id: string, version?: string }} subject @returns {OperationRecord} */
export function emptyOperationRecord(subject) {
  return /** @type {OperationRecord} */ (normalizeOperationRecord({ kind: subject.kind, id: subject.id, version: subject.version ?? '' }))
}

/** @param {string | null | undefined} left @param {string | null | undefined} right @returns {boolean} whether `left` is later than `right` */
const later = (left, right) => Boolean(left) && (!right || Date.parse(/** @type {string} */ (left)) > Date.parse(right))

/**
 * Fold one observation into a record. The only place a record changes, and pure:
 * the same record and observation always give the same result. It is NOT
 * idempotent by itself — folding an observation twice counts it twice — and
 * does not try to be: exactly-once is the collector's job, which folds inside
 * the lease-checked transaction that completes the one job per run.
 *
 * A time never moves backwards: `lastSuccess` is replaced only by a later
 * finish, so a late job for an older run cannot hide a newer one.
 *
 * @param {OperationRecord | null} record @param {OperationObservation} observation @returns {OperationRecord}
 */
export function foldOperation(record, observation) {
  const base = record ?? emptyOperationRecord({ kind: observation.kind, id: observation.id, version: observation.version })
  const ref = normalizeRef(observation.ref)
  if (!ref) return base
  const calls = Math.max(1, count(observation.count) || 1)
  const next = { ...base, firstAt: base.firstAt && Date.parse(base.firstAt) <= Date.parse(ref.at) ? base.firstAt : ref.at }
  if (observation.outcome === 'succeeded') {
    next.successes += calls
    if (later(ref.at, base.lastSuccess?.at)) next.lastSuccess = ref
    if (typeof observation.durationMs === 'number' && Number.isFinite(observation.durationMs) && observation.durationMs >= 0) {
      next.durationsMs = [...base.durationsMs, observation.durationMs].slice(-AVAILABILITY_SAMPLE_LIMIT)
    }
    if (typeof observation.costCny === 'number' && Number.isFinite(observation.costCny) && observation.costCny >= 0) {
      next.costsCny = [...base.costsCny, observation.costCny].slice(-AVAILABILITY_SAMPLE_LIMIT)
    }
    next.resultVersions += count(ref.resultVersions)
    next.boundResultVersions += count(ref.boundResultVersions)
  } else if (observation.outcome === 'failed') {
    next.failures += calls
    if (later(ref.at, base.lastFailure?.at)) next.lastFailure = ref
  } else if (observation.outcome === 'not-mounted') {
    next.notMounted += calls
    if (later(ref.at, base.lastNotMounted?.at)) next.lastNotMounted = ref
  } else {
    return base
  }
  next.operations = next.successes + next.failures + next.notMounted
  return next
}

/** The middle of a list of numbers; null for none. The "typical" of a record: one outlier cannot move it. @param {readonly number[]} values @returns {number | null} */
export function typicalOf(values) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * What a record says, without the references. This is the part an ordinary
 * reader may be given: counts and times, never another account's run or project.
 * @param {OperationRecord | null} record
 * @returns {{ operations: number, successes: number, failures: number, notMounted: number, firstAt: string | null,
 *   lastSuccessAt: string | null, lastFailureAt: string | null, lastFailureCode: string | null,
 *   typicalDurationMs: number | null, typicalCostCny: number | null, resultVersions: number, boundResultVersions: number } | null}
 */
export function summarizeOperations(record) {
  if (!record) return null
  return {
    operations: record.operations,
    successes: record.successes,
    failures: record.failures,
    notMounted: record.notMounted,
    firstAt: record.firstAt,
    lastSuccessAt: record.lastSuccess?.at ?? null,
    lastFailureAt: record.lastFailure?.at ?? null,
    lastFailureCode: record.lastFailure?.code ?? null,
    typicalDurationMs: typicalOf(record.durationsMs),
    typicalCostCny: typicalOf(record.costsCny),
    resultVersions: record.resultVersions,
    boundResultVersions: record.boundResultVersions,
  }
}

/**
 * Whether a finished run is evidence about the capability it ran, and which way.
 *
 * `succeeded` is a delivery: the run ended on its own and, for a capability that
 * owes files, left some. `failed` is a run that ended in an error the
 * capability, a source or an engine is answerable for. A cancel says nothing,
 * and neither does a run the platform stopped or a ceiling refused before
 * anything ran (`errorCodeOutcome` `stopped` / `capped`): those are not facts
 * about the capability, and counting them would turn one release switch into a
 * wave of `limited` labels. `null` is "no evidence".
 *
 * @param {{ status: string, errorCode?: string | null, artifacts?: number, resultVersions?: number, requiresFiles?: boolean }} run
 * @returns {'succeeded' | 'failed' | null}
 */
export function operationOutcomeOfRun(run) {
  if (run.status === 'succeeded') {
    const delivered = count(run.artifacts) > 0 || count(run.resultVersions) > 0
    return run.requiresFiles === false || delivered ? 'succeeded' : 'failed'
  }
  if (run.status !== 'failed') return null
  const kind = errorCodeOutcome(String(run.errorCode ?? ''))
  return kind === 'stopped' || kind === 'capped' ? null : 'failed'
}

/**
 * @typedef {object} AvailabilityInput
 * @property {{ kind: AvailabilitySubjectKind, id: string, version?: string | null }} subject
 * @property {AvailabilityReason[]} [reasons] what the deployment composition, the engines, the connectors and the
 *   installation say about the subject, in the caller's order of importance; each carries its own state
 * @property {OperationRecord | null} [operations] the record of exactly this subject and version
 * @property {{ state: 'ready' | 'pending' | 'off' | 'unreadable' }} [collector]
 * @property {{ mode: string }} [runtime]
 */

/**
 * @typedef {object} AvailabilityEntry
 * @property {AvailabilitySubjectKind} kind
 * @property {string} id
 * @property {string | null} version
 * @property {AvailabilityState} state
 * @property {AvailabilityReason} reason the deciding fact
 * @property {AvailabilityReason[]} also every other limit that holds, never deciding
 * @property {ReturnType<typeof summarizeOperations>} operations
 * @property {string} label
 * @property {string} text
 */

/**
 * The ladder. Evidence is read from the strongest claim to the weakest, and the
 * first rung that holds decides:
 *
 *   1  not carried            -> source-planned (or unavailable when it was removed or refused)
 *   2  declined by the build  -> unavailable
 *   3  a known limit          -> limited, naming it
 *   4  a mock runtime         -> unverified; nothing a mock did is a fact about a real kernel
 *   5  no usable collector    -> unverified
 *   6  its own record         -> the runtime says it is not mounted: unavailable;
 *                                a success not older than the last failure: executable;
 *                                otherwise the last operation failed: limited
 *   7  a caller's own unproven reason, then a record still forming -> unverified
 *   8  nothing against it     -> installed
 *
 * Rung 3 sits above 6 on purpose: a missing engine or data source is a fact about
 * today, a success is a fact about the past, and a label that said `executable`
 * over a missing engine would be true of last week and false of now. The record
 * is still returned beside the state, so the success is not lost.
 *
 * @param {AvailabilityInput} input @returns {AvailabilityEntry}
 */
export function projectAvailability(input) {
  const subject = input.subject
  const version = subject.version == null || subject.version === '' ? null : String(subject.version)
  const reasons = (input.reasons ?? []).filter((reason) => availabilityReasonState(reason.code))
  const record = input.operations ?? null
  const collector = input.collector?.state ?? 'ready'
  const summary = summarizeOperations(record)
  /** @param {AvailabilityState} state @param {AvailabilityReason} reason @param {AvailabilityReason[]} [also] @returns {AvailabilityEntry} */
  const decided = (state, reason, also = []) => {
    const entry = { kind: subject.kind, id: subject.id, version, state, reason, also, operations: summary, label: '', text: '' }
    const described = describeAvailability(entry)
    return { ...entry, label: described.label, text: described.text }
  }
  const of = (/** @type {AvailabilityState} */ state) => reasons.filter((reason) => availabilityReasonState(reason.code) === state)
  const [planned] = of('source-planned')
  if (planned) return decided('source-planned', planned)
  const [declined] = of('unavailable')
  if (declined) return decided('unavailable', declined)
  const limits = of('limited')
  if (limits.length) return decided('limited', limits[0], limits.slice(1))
  if (input.runtime?.mode === 'mock') return decided('unverified', { code: 'mock-runtime', source: 'runtime-mode' })
  if (collector === 'off') return decided('unverified', { code: 'collector-off', source: 'collector' })
  if (collector === 'unreadable') return decided('unverified', { code: 'records-unreadable', source: 'collector' })
  const lastSuccessAt = record?.lastSuccess?.at ?? null
  const lastNotMounted = record?.lastNotMounted ?? null
  if (lastNotMounted && later(lastNotMounted.at, lastSuccessAt)) {
    return decided('unavailable', { code: 'not-mounted', detail: subject.id, source: 'operation-record', facts: { at: lastNotMounted.at } })
  }
  const lastFailure = record?.lastFailure ?? null
  if (lastSuccessAt && !later(lastFailure?.at, lastSuccessAt)) {
    return decided('executable', { code: 'succeeded-here', source: 'operation-record', facts: { at: lastSuccessAt } })
  }
  if (lastFailure) {
    return decided('limited', { code: 'last-operation-failed', detail: lastFailure.code ?? 'unknown', source: 'operation-record', facts: { at: lastFailure.at } })
  }
  // A reason the caller already knows says nothing can be proven for this subject, whichever way the collector stands.
  const [unproven] = of('unverified')
  if (unproven) return decided('unverified', unproven)
  if (collector === 'pending') return decided('unverified', { code: 'collector-pending', source: 'collector' })
  return decided('installed', { code: 'no-successful-operation', source: 'operation-record' })
}

/**
 * The words a reader is shown for an entry: the state's label and the reason's
 * sentence, in the product's Chinese. The one place the sentences are written, so
 * the capability page, the catalogue API and the export cannot disagree.
 * @param {{ kind: string, version?: string | null, state: AvailabilityState, reason: AvailabilityReason, operations?: ReturnType<typeof summarizeOperations> }} entry
 * @returns {{ label: string, text: string }}
 */
export function describeAvailability(entry) {
  const known = REASONS[entry.reason.code]
  const facts = entry.reason.facts ?? {}
  const context = {
    kind: entry.kind,
    version: entry.version ?? null,
    lastSuccessAt: entry.operations?.lastSuccessAt ?? null,
    engineState: typeof facts.engineState === 'string' ? facts.engineState : null,
    wanted: typeof facts.wanted === 'string' ? facts.wanted : null,
    have: typeof facts.have === 'string' ? facts.have : null,
  }
  return {
    label: AVAILABILITY_STATE_LABELS_ZH[entry.state] ?? AVAILABILITY_STATE_LABELS_ZH.unverified,
    text: known ? known[1](entry.reason.detail, context) : `${nounOf(entry.kind)}的状态暂时无法说明。`,
  }
}

/**
 * The counts of a list of entries by state, every state present, for the
 * operators' gauges and the export's header.
 * @param {readonly { state: string }[]} entries @returns {Record<AvailabilityState, number>}
 */
export function countAvailabilityStates(entries) {
  const counts = /** @type {Record<AvailabilityState, number>} */ (Object.fromEntries(CAPABILITY_AVAILABILITY_STATES.map((state) => [state, 0])))
  for (const entry of entries) if (Object.hasOwn(counts, entry.state)) counts[/** @type {AvailabilityState} */ (entry.state)] += 1
  return counts
}
