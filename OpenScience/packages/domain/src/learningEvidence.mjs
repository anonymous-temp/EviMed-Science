/**
 * What the learning loop counts as the researcher's reaction to a run: the closed vocabulary of one evidence event.
 *
 * Hidden knowledge: until 2026-10-23 the loop had one in-run signal (a message typed into a running turn, kept only as a count) and
 * one after-the-fact signal (`result-corrected`), and neither existed for the commonest correction there is: "no, shorter", sent as
 * the next turn. A native-memory account had no correction source at all, and nothing could tell a delivery the researcher accepted
 * from one they quietly redid. So every reaction is one row in the feedback ledger — `trigger_kind = 'learning-evidence'`,
 * `subject_type = 'run'`, `subject_id` the run reacted to — whose `detail` is this shape. The method counters read it
 * (`appliedCorrected`, `appliedClean`), the routine trigger reads it (`clean` is "no correction on the run"), and the operator's
 * report counts it. It is evidence, never a gate: nothing in the platform waits for one.
 *
 * Four kinds of evidence, five verdicts:
 *
 *  - `steer` — a message typed into the running turn. Always a correction (verdict `correction`): what was added mid-run is what the
 *    run did not have right, and no judge reads it.
 *  - `follow-up` — the first message of the next turn within thirty minutes, judged once by a small model for what it says about
 *    the previous run: `correction`, `preference`, `rejection`, `accept` or `none` (a new question).
 *  - `result-corrected` — a result corrected in the page (`resultCorrection.mjs`); always `correction`.
 *  - `silent` — a succeeded run that left a file and was reacted to by nobody by the time the next turn came or thirty minutes
 *    passed; verdict `none`. It carries the shape of what it left (`artifactShape.mjs`), because that is what a routine compares.
 *
 * `scope` is where the run's work happened (the capability, or `conversation`), `endedAt` when the run ended (a routine does not count a run that ended before
 * the account's last memory reset), and `shape` what a clean run left.
 *
 * `quote` is the person's own words, a verbatim substring of their message, checked in code before it is stored; `rule` is one
 * sentence a judge drew from them, in their language; `concerns` are the learned methods the run opened that the reaction is about,
 * each by identity and the digest of the body it opened.
 *
 * @module learningEvidence
 */

import { cleanArtifactShapes } from './artifactShape.mjs'

/** The ledger's trigger and subject type for one of these events. */
export const LEARNING_EVIDENCE_TRIGGER = 'learning-evidence'
export const LEARNING_EVIDENCE_SUBJECT_TYPE = 'run'

export const LEARNING_EVIDENCE_KINDS = Object.freeze(['steer', 'follow-up', 'result-corrected', 'silent'])
export const LEARNING_EVIDENCE_VERDICTS = Object.freeze(['correction', 'preference', 'rejection', 'accept', 'none'])

/** The verdicts that say the run was not right: a lesson, and a method it opened that did not help. */
export const LEARNING_CORRECTION_VERDICTS = Object.freeze(['correction', 'preference', 'rejection'])

/**
 * How long after a run finished its next turn is read as a reaction to it, and how long a run waits for one before it counts as
 * accepted in silence. Provisional (no distribution yet): long enough for a person to read a result and answer it, short enough
 * that the next message is still about it.
 */
export const LEARNING_FOLLOW_UP_WINDOW_MS = 30 * 60 * 1000

/** The bounds of one event's detail (the ledger holds 4 KiB of it). */
export const LEARNING_EVIDENCE_LIMITS = Object.freeze({ quote: 600, rule: 300, concerns: 8, id: 200, digest: 80, sessionId: 128, scope: 80, bytes: 4096 })

/** @param {unknown} value @param {number} max @returns {string} */
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/**
 * The detail of one evidence event, cleaned and bounded, or null when it is not one: the evidence and the verdict must be of the
 * closed vocabularies, and a correction-only kind (`steer`, `result-corrected`) cannot carry another verdict. Fitted to the ledger's
 * allowance by giving up the shape first, then the rule, then the end of the quotation.
 * @param {unknown} value
 * @returns {{ evidence: string, verdict: string, rule: string | null, quote: string | null, concerns: { id: string, digest: string }[],
 *   sessionId: string | null, at: string, scope?: string, endedAt?: string, shape?: import('./artifactShape.mjs').ArtifactShape[] } | null}
 */
export function cleanLearningEvidence(value) {
  const record = /** @type {any} */ (value)
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const evidence = String(record.evidence ?? '')
  if (!LEARNING_EVIDENCE_KINDS.includes(evidence)) return null
  let verdict = String(record.verdict ?? '')
  if (evidence === 'steer' || evidence === 'result-corrected') verdict = 'correction'
  else if (evidence === 'silent') verdict = 'none'
  if (!LEARNING_EVIDENCE_VERDICTS.includes(verdict)) return null
  const limits = LEARNING_EVIDENCE_LIMITS
  const at = Number.isFinite(Date.parse(String(record.at ?? ''))) ? new Date(String(record.at)).toISOString() : null
  if (!at) return null
  /** @type {{ id: string, digest: string }[]} */
  const concerns = []
  for (const entry of Array.isArray(record.concerns) ? record.concerns : []) {
    const id = text(entry?.id, limits.id)
    const digest = text(entry?.digest, limits.digest)
    if (id && digest && !concerns.some((held) => held.id === id)) concerns.push({ id, digest })
    if (concerns.length >= limits.concerns) break
  }
  const scope = text(record.scope, limits.scope)
  const shape = cleanArtifactShapes(record.shape)
  const endedAt = Number.isFinite(Date.parse(String(record.endedAt ?? ''))) ? new Date(String(record.endedAt)).toISOString() : null
  const detail = {
    evidence,
    verdict,
    rule: text(record.rule, limits.rule) || null,
    quote: text(record.quote, limits.quote) || null,
    concerns,
    sessionId: text(record.sessionId, limits.sessionId) || null,
    at,
    ...(scope ? { scope } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(shape.length ? { shape } : {}),
  }
  const size = () => new TextEncoder().encode(JSON.stringify(detail)).length
  if (size() > limits.bytes) delete detail.shape
  if (size() > limits.bytes) detail.rule = null
  while (size() > limits.bytes && detail.quote && detail.quote.length > 16) detail.quote = detail.quote.slice(0, Math.floor(detail.quote.length * 0.8))
  return size() > limits.bytes ? null : detail
}

/**
 * Whether an evidence event says the run was corrected: a steer, a result corrected in the page, or a follow-up whose verdict is a
 * correction, a preference or a rejection. A `silent` event, an accepted follow-up and a new question are the run left alone.
 * @param {{ evidence?: unknown, verdict?: unknown } | null | undefined} detail
 * @returns {boolean}
 */
export function isLearningCorrection(detail) {
  const evidence = String(detail?.evidence ?? '')
  if (evidence === 'steer' || evidence === 'result-corrected') return true
  return evidence === 'follow-up' && LEARNING_CORRECTION_VERDICTS.includes(String(detail?.verdict ?? ''))
}
