/**
 * What the learning loop counts as the researcher's reaction to a run: the closed vocabulary of one evidence event.
 *
 * Hidden knowledge: until 2026-10-23 the loop had one in-run signal (a message typed into a running turn, kept only as a count) and
 * one after-the-fact signal (`result-corrected`), and neither existed for the commonest correction there is: "no, shorter", sent as
 * the next turn. A native-memory account had no correction source at all, and nothing could tell a delivery the researcher accepted
 * from one they quietly redid. So every reaction is one row in the feedback ledger — `trigger_kind = 'learning-evidence'`,
 * `subject_type = 'run'`, `subject_id` the run reacted to — whose `detail` is this shape. The method counters read it
 * (`appliedCorrected`, `appliedClean`), the routine trigger reads it (`clean` is "kept, and no correction on the run": since 2026-10-25
 * silence is unknown, not approval, `learningRunOutcome`), and the operator's report counts it. It is evidence, never a gate: nothing in
 * the platform waits for one.
 *
 * Five kinds of evidence, six verdicts:
 *
 *  - `steer` — a message typed into the running turn, read by the same judge as a follow-up when the run finishes (`correction`,
 *    `preference`, `rejection`, `accept` or `none`: a run that has not finished cannot be `adopt`ed). A steer nobody could read
 *    (the judge was down) is `correction`: what was added mid-run is, by where it was typed, what the run did not have.
 *  - `follow-up` — the first message of the next turn within thirty minutes, judged once by a small model for what it says about
 *    the previous run: `correction`, `preference`, `rejection`, `accept`, `none` (a new question) or `adopt` (the person asks that the
 *    way the work was just done be kept for the same kind of work: the strongest signal there is, because it is both an acceptance and
 *    a lesson).
 *  - `result-corrected` — a result corrected in the page (`resultCorrection.mjs`); always `correction`.
 *  - `used` — the owner opened or downloaded one of the run's delivered files after the run finished, through the control plane.
 *    No words, verdict `none`; once per run. Silence is unknown and not approval, so a file taken is the only reaction short of
 *    words that says the work was kept.
 *  - `silent` — a succeeded run that left a file and was reacted to by nobody by the time the next turn came or thirty minutes
 *    passed; verdict `none`. It carries the shape of what it left (`artifactShape.mjs`), because that is what a routine compares.
 *    It counts for nothing: neither clean nor corrected.
 *
 * What a run's events add up to is `learningRunOutcome`: `corrected` (any correction, whenever it came), `clean` (accepted, adopted or
 * used, and never corrected) or `unknown` (silence, a new question, a message that is about something else).
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

export const LEARNING_EVIDENCE_KINDS = Object.freeze(['steer', 'follow-up', 'result-corrected', 'silent', 'used'])
export const LEARNING_EVIDENCE_VERDICTS = Object.freeze(['correction', 'preference', 'rejection', 'accept', 'none', 'adopt'])

/** The verdicts that say the run was not right: a lesson, and a method it opened that did not help. */
export const LEARNING_CORRECTION_VERDICTS = Object.freeze(['correction', 'preference', 'rejection'])

/** The verdicts that say the run was kept: it is clean, and `adopt` is also a lesson at once. */
export const LEARNING_ACCEPT_VERDICTS = Object.freeze(['accept', 'adopt'])

/** The verdicts that carry a rule and a quotation of the person's words: what a judge must ground in the message. */
export const LEARNING_RULE_VERDICTS = Object.freeze([...LEARNING_CORRECTION_VERDICTS, 'adopt'])

/** What a steer can say: a run still going cannot be adopted. */
export const LEARNING_STEER_VERDICTS = Object.freeze(['correction', 'preference', 'rejection', 'accept', 'none'])

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
 * closed vocabularies, a result corrected in the page is always a correction, silence and a use say nothing in words (`none`), and a
 * steer carries the verdict its judge gave it, or `correction` when nobody read it. Fitted to the ledger's
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
  if (evidence === 'steer') verdict = LEARNING_STEER_VERDICTS.includes(verdict) ? verdict : 'correction'
  else if (evidence === 'result-corrected') verdict = 'correction'
  else if (evidence === 'silent' || evidence === 'used') verdict = 'none'
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
 * Whether an evidence event says the run was corrected: a result corrected in the page, or a steer or follow-up whose verdict is a
 * correction, a preference or a rejection (a steer nobody judged is a correction). Silence, a use, an acceptance, an adoption and a new
 * question are the run left alone.
 * @param {{ evidence?: unknown, verdict?: unknown } | null | undefined} detail
 * @returns {boolean}
 */
export function isLearningCorrection(detail) {
  const evidence = String(detail?.evidence ?? '')
  if (evidence === 'result-corrected') return true
  if (evidence === 'steer') return !detail?.verdict || LEARNING_CORRECTION_VERDICTS.includes(String(detail.verdict))
  return evidence === 'follow-up' && LEARNING_CORRECTION_VERDICTS.includes(String(detail?.verdict ?? ''))
}

/**
 * Whether an evidence event says the work was kept: the person's own acceptance or adoption on the next turn, or the file taken.
 * @param {{ evidence?: unknown, verdict?: unknown } | null | undefined} detail
 * @returns {boolean}
 */
export function isLearningKept(detail) {
  const evidence = String(detail?.evidence ?? '')
  if (evidence === 'used') return true
  return evidence === 'follow-up' && LEARNING_ACCEPT_VERDICTS.includes(String(detail?.verdict ?? ''))
}

/**
 * What a run's evidence adds up to. `corrected`: any correction, whenever it came. `clean`: kept (accepted, adopted, or its file
 * taken) and never corrected. `unknown`: everything else — silence is not approval, and a message about something else says nothing
 * about the work. A routine counts only clean runs, and so do the counters of the methods the run opened.
 * @param {readonly ({ evidence?: unknown, verdict?: unknown } | null | undefined)[]} details every event of one run
 * @returns {'corrected' | 'clean' | 'unknown'}
 */
export function learningRunOutcome(details) {
  const events = Array.isArray(details) ? details : []
  if (events.some((detail) => isLearningCorrection(detail))) return 'corrected'
  return events.some((detail) => isLearningKept(detail)) ? 'clean' : 'unknown'
}
