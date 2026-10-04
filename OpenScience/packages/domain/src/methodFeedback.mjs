/**
 * What later became of the results a learned method was used for: the scientific axis of a method's record
 * (plan 2026-10-02 §11.3 N14).
 *
 * `learning.observations` (`methodGraph.mjs`) say how the DELIVERY of a run that used the method ended: accepted,
 * repaired, rejected. This is the other axis, and the two are never merged. A delivery that was accepted says nothing
 * about whether its numbers were right, and a result a researcher later corrected says nothing about whether the
 * delivery was accepted. What this module holds is the evidence of the second kind that the platform can establish
 * without a human adjudicating anything: a trusted recalculation of a result reproduced it or did not (N06's replay),
 * the researcher corrected it through the anchored revision (N12's `result-corrected` pair), and what the engine's own
 * diagnostics said about the data the result was calculated from.
 *
 * Hidden knowledge:
 *
 * - **Joined by identifiers, never by name or by time.** A signal is about one immutable result version. That version
 *   names the run that produced it (`producer.runId`), the run's ledger names the learned methods it READ, by the
 *   digest of the file it was given, and the entry here is bound to the content digest of the revision of the method
 *   that file was. A method that was only mounted and passed over earned nothing and is charged with nothing; a result
 *   whose run read no method is no one's evidence. Changing a method's body does not move an entry to the new body: an
 *   entry stays under the revision it was made under, which is what lets a regression be pinned to one revision and a
 *   rollback go to the exact one before it.
 * - **Association, never cause.** A result that was corrected after a method was used is a result that was corrected
 *   after a method was used. Nothing here says the method caused the error or that a method that was used when nothing
 *   went wrong caused the numbers to be right: `causalBenefit` is `unproven` in every summary, and a paid on/off study
 *   is not proposed to settle it. What the record can support is the sequential test the delivery axis already uses
 *   (`methodHarmTest`): whether the results produced under one revision were found wrong at a rate that revision's
 *   neighbours were not.
 * - **Unknown is a value.** A replay on another engine than the original's, a replay whose numbers were not compared,
 *   a correction whose two versions could not be read and a result with no engine diagnostics are recorded as what they
 *   are or not recorded; none is read as agreement. Applicability is `unknown` unless the engine raised or ran its own
 *   diagnostics, and `unflagged` is not `applicable`: the diagnostics check some of a method's assumptions and say
 *   nothing about the rest.
 * - **A label, never a gate.** Nothing here refuses a result, a revision or a method. What acts on this record is the
 *   method lifecycle (`retirementProposal`), and it acts by returning the method to an earlier body or stopping it,
 *   both of which a researcher can undo.
 *
 * Pure, browser-safe, no I/O, no hashing (the entry's identity is cut by the control plane, which has a hash).
 * @module @evimed/domain/methodFeedback
 */

import { hasSensitiveText } from './sensitiveText.mjs'
import { isMethodDigest } from './methodSkill.mjs'

/** The version of the record's shape. */
export const METHOD_FEEDBACK_VERSION = 1

/**
 * What happened to one result. `replay_*` come from a trusted recalculation (same code, same environment, same method
 * record) of the result's own recipe; `*_corrected` from the researcher's correction of it, named by what the two
 * versions' bytes show changed (`resultCorrection.mjs` `kind`).
 */
export const METHOD_FEEDBACK_SIGNALS = Object.freeze([
  'replay_agreed', 'replay_differed', 'evidence_corrected', 'analytic_corrected', 'presentation_corrected', 'correction_unreadable',
])

/**
 * Which way a signal points. `neutral` is recorded and never read by the lifecycle: a restyled figure is not a
 * scientific error, and a correction whose versions could not be compared is not a finding.
 */
export const METHOD_FEEDBACK_POLARITY = Object.freeze({
  replay_agreed: 'supports',
  replay_differed: 'against',
  evidence_corrected: 'against',
  analytic_corrected: 'against',
  presentation_corrected: 'neutral',
  correction_unreadable: 'neutral',
})

/** What the engine's own diagnostics said about the data. `unflagged` is not `applicable`. */
export const METHOD_APPLICABILITY_STATES = Object.freeze(['unknown', 'flagged', 'unflagged'])

/** How many entries one method record keeps. The oldest go first; a count is never a megabyte. */
export const METHOD_FEEDBACK_LIMIT = 60

/** What a method's record says about how it was left: returned to an earlier body, or stopped. */
export const METHOD_LINK_TYPES = Object.freeze(['rolled_back_for_regression', 'retired_for_regression'])

/** How many revision links one method keeps. */
export const METHOD_LINK_LIMIT = 20

/** How many result versions a method's provenance names as what it was learnt from. */
export const METHOD_RESULT_LINK_LIMIT = 8

/** The most a declared scope takes of one method. */
export const METHOD_SCOPE_LIMITS = Object.freeze({ applicability: 400, counterexample: 300, counterexamples: 8 })

const CODE = /^[a-z][a-z0-9_]{0,63}$/
const ENTRY_ID = /^sf_[a-f0-9]{32}$/
const VERSION_ID = /^rv_[a-f0-9]{64}$/

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** @param {unknown} value @param {number} max */
const bounded = (value, max) => (typeof value === 'string'
  ? [...value].map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char)).join('').replace(/\s+/g, ' ').trim().slice(0, max)
  : '')

/** @param {unknown} value @returns {string | null} */
const versionIdOf = (value) => (typeof value === 'string' && VERSION_ID.test(value) ? value : null)

/** @param {unknown} value @returns {string | null} */
const hexOf = (value) => (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null)

/** @param {unknown} value @returns {string | null} */
const timeOf = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null)

/** @param {unknown} value @param {number} limit @returns {string[]} */
const codesOf = (value, limit) => (Array.isArray(value)
  ? [...new Set(value.filter((code) => typeof code === 'string' && CODE.test(code)))].sort().slice(0, limit) : [])

/* ------------------------------------------------------------------ signals */

/** What a correction's kind says about the result it corrected. */
const SIGNAL_BY_CORRECTION_KIND = Object.freeze({
  analytic: 'analytic_corrected', evidence: 'evidence_corrected', presentation: 'presentation_corrected', unknown: 'correction_unreadable',
})

/**
 * The signal one correction is, from its closed `kind` (decided from the two versions' bytes, never from the researcher's
 * words). A kind this module does not know reads as `correction_unreadable`: unknown, which is a value.
 * @param {{ kind?: unknown } | null | undefined} correction a projected correction (`projectResultCorrection`)
 * @returns {string}
 */
export function feedbackSignalFromCorrection(correction) {
  const kind = String(correction?.kind ?? '')
  return Object.hasOwn(SIGNAL_BY_CORRECTION_KIND, kind) ? /** @type {Record<string, string>} */ (SIGNAL_BY_CORRECTION_KIND)[kind] : 'correction_unreadable'
}

/**
 * The signal one recalculation is, or why it is none.
 *
 * Trusted means the replay ran on what the original ran on: the code, the environment and the method record are the
 * same (`replayEnvironment`). A replay on a changed engine still runs, and its numbers are shown, but a difference
 * there may be the engine's and not the original's, so it is not evidence about the method the original's run used.
 * Numbers that were not compared are not an agreement.
 * @param {any} comparison the replay's recorded comparison: `{ environment: { status }, numbers: { status } }`
 * @returns {{ signal: string | null, numbers: string | null, reason: string | null }}
 */
export function feedbackSignalFromReplay(comparison) {
  if (!isRecord(comparison)) return { signal: null, numbers: null, reason: 'no_comparison' }
  const environment = comparison.environment?.status
  if (environment !== 'same') return { signal: null, numbers: null, reason: environment === 'differs' ? 'environment_differs' : 'environment_unknown' }
  const numbers = comparison.numbers?.status
  if (numbers === 'identical' || numbers === 'within-tolerance') return { signal: 'replay_agreed', numbers, reason: null }
  if (numbers === 'changed') return { signal: 'replay_differed', numbers, reason: null }
  return { signal: null, numbers: null, reason: 'not_assessed' }
}

/**
 * What the engine's own diagnostics say about whether the method's conditions held for this data.
 *
 * `raised` is the list the engine wrote into its output (`diagnostics`, each `{ code }` or a code); `known` is the
 * codes the method's own record lists. A code the record does not list is not read: the vocabulary is the record's, so
 * an engine cannot talk a method into a condition nobody wrote down. `unknown` when the engine wrote no list at all.
 * @param {{ raised: unknown, known: Iterable<string> | null | undefined }} input
 * @returns {{ state: 'unknown' | 'flagged' | 'unflagged', basis: 'none' | 'engine_diagnostics', codes: string[] }}
 */
export function diagnosticApplicability({ raised, known }) {
  if (!Array.isArray(raised)) return { state: 'unknown', basis: 'none', codes: [] }
  const listed = new Set(known ?? [])
  const codes = codesOf(raised.map((item) => (isRecord(item) ? item.code : item)).filter((code) => listed.has(code)), 8)
  return codes.length ? { state: 'flagged', basis: 'engine_diagnostics', codes } : { state: 'unflagged', basis: 'engine_diagnostics', codes: [] }
}

/* ------------------------------------------------------------------ entries */

/**
 * One entry as the record keeps it: a closed projection, bounded, with every identifier checked for its shape. Throws
 * when an entry does not name what it is about — a signal with no result version, a digest that is not a method's.
 *
 * `digest` is the content digest of the revision of the method (or handbook) the producing run read. `result` is the
 * version the signal is about; `successor` is a correction's system-generated successor, kept as the second half of the
 * pair and never as evidence of its own. `replay` and `event` name the recalculation or the feedback event that is the
 * signal's source, so every entry can be traced to a record that exists independently.
 * @param {unknown} raw
 */
export function projectMethodFeedback(raw) {
  const source = isRecord(raw) ? raw : {}
  if (typeof source.id !== 'string' || !ENTRY_ID.test(source.id)) throw new Error('A method feedback entry has an identity.')
  if (!METHOD_FEEDBACK_SIGNALS.includes(/** @type {any} */ (source.signal))) throw new Error('A method feedback entry names a known signal.')
  if (typeof source.digest !== 'string' || !isMethodDigest(source.digest)) throw new Error('A method feedback entry names the revision it was made under.')
  const at = timeOf(source.at)
  const resultVersionId = versionIdOf(source.result?.versionId)
  const resultDigest = hexOf(source.result?.digest)
  if (!at || !resultVersionId || !resultDigest) throw new Error('A method feedback entry names the result version it is about.')
  const successorId = versionIdOf(source.successor?.versionId)
  const outputId = versionIdOf(source.replay?.outputVersionId)
  const replayId = bounded(source.replay?.id, 200)
  const numbers = ['identical', 'within-tolerance', 'changed'].includes(source.replay?.numbers) ? /** @type {string} */ (source.replay.numbers) : null
  const eventId = bounded(source.event?.id, 200)
  const applicability = isRecord(source.applicability) ? source.applicability : {}
  const state = METHOD_APPLICABILITY_STATES.includes(applicability.state) ? /** @type {string} */ (applicability.state) : 'unknown'
  return {
    schemaVersion: METHOD_FEEDBACK_VERSION,
    id: source.id,
    signal: /** @type {string} */ (source.signal),
    at,
    digest: source.digest,
    used: 'invoked',
    runId: bounded(source.runId, 160) || null,
    result: { versionId: resultVersionId, digest: resultDigest },
    successor: successorId ? { versionId: successorId, digest: hexOf(source.successor?.digest) } : null,
    replay: replayId ? { id: replayId, outputVersionId: outputId, numbers } : null,
    event: eventId ? { id: eventId } : null,
    kind: ['analytic', 'evidence', 'presentation', 'unknown'].includes(source.kind) ? /** @type {string} */ (source.kind) : null,
    applicability: state === 'unknown' ? { state, basis: 'none', codes: [] }
      : { state, basis: 'engine_diagnostics', codes: state === 'flagged' ? codesOf(applicability.codes, 8) : [] },
  }
}

/** A record with no entries yet. */
export function emptyScientific() {
  return { schemaVersion: METHOD_FEEDBACK_VERSION, entries: /** @type {any[]} */ ([]) }
}

/**
 * Whether the record already holds an entry of this identity.
 * @param {any} scientific @param {string} id
 */
export function hasMethodFeedback(scientific, id) {
  return Array.isArray(scientific?.entries) && scientific.entries.some((/** @type {any} */ entry) => entry?.id === id)
}

/**
 * Add one entry to a record, once: an entry of an identity the record already holds changes nothing (one result
 * version, one signal source, one entry, however often the join replays), and the oldest entries go when the record is
 * full. Returns the record it was given when nothing was added.
 * @param {any} scientific @param {unknown} entry
 */
export function foldMethodFeedback(scientific, entry) {
  const current = isRecord(scientific) && Array.isArray(scientific.entries) ? scientific : emptyScientific()
  const cleaned = projectMethodFeedback(entry)
  if (hasMethodFeedback(current, cleaned.id)) return scientific ?? current
  return { schemaVersion: METHOD_FEEDBACK_VERSION, entries: [...current.entries, cleaned].slice(-METHOD_FEEDBACK_LIMIT) }
}

/* --------------------------------------------------------------- readings */

/**
 * What became of each result version produced under one revision, one outcome per version, in the order it was
 * learned. A version with a signal against it and a signal for it reads as against: the recalculation that agreed does
 * not take back the correction that followed, and a neutral signal is not read. This is the series the sequential test
 * reads (`scientificRegression`).
 * @param {any} scientific @param {string} digest
 * @returns {{ versionId: string, polarity: 'supports' | 'against', at: string, entryId: string }[]}
 */
export function scientificOutcomes(scientific, digest) {
  /** @type {Map<string, { versionId: string, polarity: 'supports' | 'against', at: string, entryId: string }>} */
  const byVersion = new Map()
  for (const entry of Array.isArray(scientific?.entries) ? scientific.entries : []) {
    if (entry?.digest !== digest) continue
    const polarity = /** @type {Record<string, string>} */ (METHOD_FEEDBACK_POLARITY)[entry.signal]
    if (polarity !== 'supports' && polarity !== 'against') continue
    const prior = byVersion.get(entry.result.versionId)
    const outranks = prior && prior.polarity === 'supports' && polarity === 'against'
    if (!prior || outranks) byVersion.set(entry.result.versionId, { versionId: entry.result.versionId, polarity, at: entry.at, entryId: entry.id })
  }
  return [...byVersion.values()].sort((left, right) => left.at.localeCompare(right.at) || left.versionId.localeCompare(right.versionId))
}

/**
 * What one revision's record says, for a reader: how many results it was used for, how many were reproduced and how
 * many were not or were corrected, the applicability the engine's diagnostics gave, and the results that count against
 * it. `causalBenefit` is `unproven` in every summary: this is what happened after the method was used, not what the
 * method did.
 * @param {any} scientific @param {string} digest
 */
export function methodScientific(scientific, digest) {
  const entries = (Array.isArray(scientific?.entries) ? scientific.entries : []).filter((/** @type {any} */ entry) => entry?.digest === digest)
  const outcomes = scientificOutcomes(scientific, digest)
  const flagged = entries.filter((/** @type {any} */ entry) => entry.applicability?.state === 'flagged')
  const unflagged = entries.some((/** @type {any} */ entry) => entry.applicability?.state === 'unflagged')
  const neutral = new Set(entries.filter((/** @type {any} */ entry) => /** @type {Record<string, string>} */ (METHOD_FEEDBACK_POLARITY)[entry.signal] === 'neutral')
    .map((/** @type {any} */ entry) => entry.result.versionId))
  const supports = outcomes.filter((outcome) => outcome.polarity === 'supports').length
  const against = outcomes.filter((outcome) => outcome.polarity === 'against').length
  const againstIds = new Set(outcomes.filter((outcome) => outcome.polarity === 'against').map((outcome) => outcome.entryId))
  return {
    digest,
    results: new Set(entries.map((/** @type {any} */ entry) => entry.result.versionId)).size,
    supports, against, assessed: supports + against, neutral: neutral.size,
    applicability: flagged.length ? 'flagged' : unflagged ? 'unflagged' : 'unknown',
    causalBenefit: 'unproven',
    counterexamples: entries.filter((/** @type {any} */ entry) => againstIds.has(entry.id)).slice(-8).reverse().map((/** @type {any} */ entry) => ({
      versionId: entry.result.versionId, signal: entry.signal, kind: entry.kind, at: entry.at,
      ...(entry.event ? { eventId: entry.event.id } : {}), ...(entry.replay ? { replayId: entry.replay.id } : {}) })),
    limits: flagged.slice(-8).reverse().map((/** @type {any} */ entry) => ({ versionId: entry.result.versionId, codes: entry.applicability.codes, at: entry.at })),
  }
}

/* -------------------------------------------------------------------- scope */

/**
 * The scope a distillation declared for a method, in its own words: the situation it is for and the situations it must
 * not be loaded into (`method-candidate.json`, `applicability` and `counterexamples`). Bounded, and an entry that
 * carries what `hasSensitiveText` names is dropped, as the method's own body would be refused. Null when there is
 * nothing to keep. It restates `applies_when` and `not_when` so the two can be compared; it is read by the next
 * distillation and by a reader, never matched against a task by code.
 * @param {unknown} value
 * @returns {{ applicability: string, counterexamples: string[] } | null}
 */
export function cleanMethodScope(value) {
  if (!isRecord(value)) return null
  const keep = (/** @type {unknown} */ text, /** @type {number} */ max) => {
    const cleaned = bounded(text, max)
    return cleaned && !hasSensitiveText(cleaned) ? cleaned : ''
  }
  const applicability = keep(value.applicability, METHOD_SCOPE_LIMITS.applicability)
  const counterexamples = (Array.isArray(value.counterexamples) ? value.counterexamples : [])
    .map((/** @type {unknown} */ text) => keep(text, METHOD_SCOPE_LIMITS.counterexample)).filter(Boolean).slice(0, METHOD_SCOPE_LIMITS.counterexamples)
  return applicability || counterexamples.length ? { applicability, counterexamples } : null
}

/* -------------------------------------------------------------------- links */

/**
 * The result versions a method was learnt from, as its provenance keeps them: the original a researcher corrected and
 * the successor the platform generated, each by its immutable identity. This is the recorded link a later change of one
 * of the sources the results rest on (N15) finds the method by.
 * @param {unknown} value @returns {{ role: 'original' | 'successor', versionId: string, digest: string | null }[]}
 */
export function projectMethodResultLinks(value) {
  /** @type {{ role: 'original' | 'successor', versionId: string, digest: string | null }[]} */
  const links = []
  for (const item of Array.isArray(value) ? value : []) {
    const versionId = versionIdOf(item?.versionId)
    if (!versionId || !['original', 'successor'].includes(item?.role)) continue
    if (links.some((link) => link.versionId === versionId && link.role === item.role)) continue
    links.push({ role: item.role, versionId, digest: hexOf(item.digest) })
  }
  return links.slice(0, METHOD_RESULT_LINK_LIMIT)
}

/**
 * The older links with the newer ones after them, once each, newest kept when the list is full.
 * @param {unknown} before @param {unknown} after
 */
export function mergeMethodResultLinks(before, after) {
  /** @type {{ role: 'original' | 'successor', versionId: string, digest: string | null }[]} */
  const merged = []
  for (const link of [...projectMethodResultLinks(before), ...projectMethodResultLinks(after)]) {
    if (!merged.some((item) => item.role === link.role && item.versionId === link.versionId)) merged.push(link)
  }
  return merged.slice(-METHOD_RESULT_LINK_LIMIT)
}

/**
 * One revision link: that a method was returned to an earlier body, or stopped, because the results produced under the
 * body it held showed a regression, and which entries showed it. A trusted write by the lifecycle, bounded all the same.
 * @param {unknown} raw
 */
export function projectMethodLink(raw) {
  const source = isRecord(raw) ? raw : {}
  if (!METHOD_LINK_TYPES.includes(/** @type {any} */ (source.type))) throw new Error('A method link names a known type.')
  const at = timeOf(source.at)
  if (!at || typeof source.fromDigest !== 'string' || !isMethodDigest(source.fromDigest)) throw new Error('A method link names the revision it left.')
  const count = (/** @type {unknown} */ value) => (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : 0)
  return {
    type: /** @type {string} */ (source.type),
    at,
    fromDigest: source.fromDigest,
    toDigest: typeof source.toDigest === 'string' && isMethodDigest(source.toDigest) ? source.toDigest : null,
    results: count(source.results),
    against: count(source.against),
    evidence: (Array.isArray(source.evidence) ? source.evidence : []).filter((/** @type {unknown} */ id) => typeof id === 'string' && ENTRY_ID.test(id)).slice(0, 8),
  }
}

/**
 * The links a method already has with one more, the newest last and the list bounded.
 * @param {unknown} links @param {unknown} link
 */
export function appendMethodLink(links, link) {
  const kept = (Array.isArray(links) ? links : []).flatMap((/** @type {unknown} */ item) => { try { return [projectMethodLink(item)] } catch { return [] } })
  return [...kept, projectMethodLink(link)].slice(-METHOD_LINK_LIMIT)
}
