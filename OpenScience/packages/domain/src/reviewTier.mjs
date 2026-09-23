/**
 * Which review a piece of work gets, from properties code can decide.
 *
 * Hidden knowledge: "does everything get reviewed?" has a one-word answer —
 * everything is *classified*, and most of it gets nothing. The classifier
 * never reads language (principle 1); it reads what a deliverable claims to be
 * and what a reply visibly contains. A greeting and a plain answer are L0 and
 * cost nothing, which is the literature's default as much as ours: most
 * sentences of ordinary text hold no checkable claim (VeriScore), and
 * verifying unconditionally made FLARE's answers worse, not better
 * (principle 12).
 *
 * - **L0** — no citation, no medicine: nothing to check.
 * - **L1** — a conversation reply that cites (a numbered marker, a DOI, a
 *   PMID, a link) or names a medicine: checked after it is shown, never held.
 * - **L2** — a written deliverable: full-coverage deterministic checks, one
 *   pass of the independent editor, one repair round inside the run.
 * - **L3** — a deliverable whose numbers come from a computation (an engine or
 *   a profiling script): L2, plus the stated results traced to the
 *   computation's own output.
 * - **safety** — a flag, not a tier: a clinical deliverable, or a reply naming
 *   a medicine, adds the pharmacist's items to whichever tier it is in.
 *
 * Internal packages (a method candidate, a source digest) are the platform's
 * own bookkeeping and are never reviewed (2026-09-21: a reviewer set on a
 * SKILL.md raised four 「contradictions」 and cost the run twelve minutes).
 *
 * @module @evimed/domain/reviewTier
 */

import { isClinicalContractKind } from './contractKinds.mjs'
import { referenceIdentifiers } from './clinicalEvidence.mjs'
import { mentionedMedicines } from './safetyRules.mjs'

/** @typedef {'L0'|'L1'|'L2'|'L3'} ReviewTier */

export const REVIEW_TIERS = Object.freeze(/** @type {const} */ (['L0', 'L1', 'L2', 'L3']))

/**
 * Deliverables whose results are computed: an engine job (Mendelian
 * randomization, meta-analysis, bibliometrics, pharmacovigilance signals,
 * topic evidence mapping) or the dataset profiler. Their report states
 * numbers a computation produced, and those are traced to its output.
 */
export const COMPUTED_CONTRACT_KINDS = Object.freeze([
  'dataset-scoping-package',
  'mendelian-randomization-report',
  'meta-analysis-report',
  'bibliometric-analysis-report',
  'adr-analysis-report',
  'research-topic-report',
])

/**
 * Deliverables no review is set on: the learning loop's and the source
 * pipeline's own packages, and the autopilot's JSON plans, which state no
 * claim a reader acts on.
 */
export const UNREVIEWED_CONTRACT_KINDS = Object.freeze([
  'source-understanding',
  'method-candidate',
  'method-relations',
  'episode-plan',
  'agenda-delta',
  'analysis-plan',
  'reproducibility-pack',
  'surveillance-diff',
  'hypothesis-set',
])

/**
 * The review a deliverable of this kind gets.
 * @param {string} contractKind
 * @returns {{ tier: 'L2'|'L3' | null, safety: boolean }}
 */
export function deliverableReviewTier(contractKind) {
  const kind = String(contractKind ?? '')
  if (!kind || UNREVIEWED_CONTRACT_KINDS.includes(kind)) return { tier: null, safety: false }
  return {
    tier: COMPUTED_CONTRACT_KINDS.includes(kind) ? 'L3' : 'L2',
    safety: isClinicalContractKind(kind),
  }
}

/** A numbered citation marker in prose: `[3]`, `[1, 4]`, `[2–5]`. */
const CITATION_MARKER = /\[\d{1,3}(?:\s*[-–,，]\s*\d{1,3})*\]/
const LINK = /https?:\/\/[^\s)>\]]+/

/**
 * The review a conversation reply gets, and why.
 * @param {string} replyText
 * @returns {{ tier: 'L0'|'L1', cites: boolean, medicines: string[] }}
 */
export function replyReviewTier(replyText) {
  const text = String(replyText ?? '')
  if (!text.trim()) return { tier: 'L0', cites: false, medicines: [] }
  const cites = CITATION_MARKER.test(text) || LINK.test(text) || referenceIdentifiers(text).size > 0
  const medicines = mentionedMedicines(text)
  return { tier: cites || medicines.length ? 'L1' : 'L0', cites, medicines }
}
