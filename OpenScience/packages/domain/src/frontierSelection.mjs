/**
 * What makes a 前沿动态 item fit for 精选, in the parts code decides (c3-select, 2026-10-25).
 *
 * The review of 2026-10-25 measured the editor's score against 248 items two medical labellers judged (kappa 0.87): on the prompt that
 * was live, 精选 was a pick in 12.9% of its items and the score told a pick from the rest with an AUC of 0.61. The model's three parts
 * saturated (impact 30 on 31% of the items, every part at its maximum on 27%), and a fixed fact the platform holds — a roundup, a
 * preprint, a registry listing, a company's own release — never lowered them. This module is the code side of the fix:
 *
 * - **Ceilings** (`frontierScoreCeilings`): from the genre, the evidence type, a preprint, a registry-class source and — when
 *   c3-faith has read them — the study's design and size, the most a model-scored part may be. A ceiling is the prompt's own
 *   anchor made certain, never a new opinion; the tables are `frontier-selection.json`, which an editor extends.
 * - **Republishers** (`frontierRepublisher`): a source that republishes others' writing has its authority grade capped and never
 *   takes a floor place (`frontierFloorEligible`). They are named by registry id in the same table, not recognised by prose.
 * - **The practice-changing label** (`FRONTIER_PRACTICE_LIMITS`, `frontierPracticeAdmissible`, `frontierPracticeAdmit`): the model
 *   proposes it with a one-line reason and code admits it — eligible genres and evidence, a source that can carry it, a daily cap.
 *   It is rare on purpose: a team that reads closely says 6% of what it reads changes its practice, and most 「重磅」 items do not.
 *
 * Hidden knowledge:
 *
 * - The model's raw parts are kept (`items.editor_diagnostics.scoresRaw`); what a ceiling lowered is `reasons`, so a card that
 *   reads lower than the model said can be explained and a ceiling can be fitted without another model call.
 * - Everything here works without `studyFacts`: the design rows apply only when c3-faith has read the text, and a design the
 *   table does not name (`rct`, `meta-analysis`, `other` …) lowers nothing.
 *
 * @module @evimed/domain/frontierSelection
 */

import table from './frontier-selection.json' with { type: 'json' }
import { FRONTIER_SCORE_MAXIMA, frontierAuthorityScore } from './frontierVocabulary.mjs'

/** @typedef {{ impact?: number, novelty?: number, relevance?: number }} FrontierCeiling */
/** @typedef {{ authority: number, impact: number, novelty: number, relevance: number }} FrontierScoreParts */

const PARTS = /** @type {const} */ (['impact', 'novelty', 'relevance'])

/**
 * One ceiling row, checked: every part a whole number within its scale. A table that breaks this fails at load, where the editor
 * who broke it sees it, never as a part silently left uncapped.
 * @param {unknown} row @param {string} where @returns {Readonly<FrontierCeiling>}
 */
function ceilingRow(row, where) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const part of PARTS) {
    const value = /** @type {any} */ (row)?.[part]
    if (value === undefined) continue
    if (!Number.isInteger(value) || value < 0 || value > FRONTIER_SCORE_MAXIMA[part]) throw new Error(`frontier-selection.json: ${where}.${part} is not a whole number within 0-${FRONTIER_SCORE_MAXIMA[part]}`)
    out[part] = value
  }
  return Object.freeze(out)
}

/** @param {unknown} rows @param {string} where @returns {Readonly<Record<string, Readonly<FrontierCeiling>>>} */
function ceilingTable(rows, where) {
  return Object.freeze(Object.fromEntries(Object.entries(rows && typeof rows === 'object' ? rows : {}).map(([key, row]) => [key, ceilingRow(row, `${where}.${key}`)])))
}

/**
 * The republishers by registry source id: the name an editor reads, why, the authority grade they are capped at (1-5) and whether
 * they may take a floor place.
 * @type {Readonly<Record<string, Readonly<{ name: string, reason: string, authorityCap: number, floors: boolean }>>>}
 */
export const FRONTIER_REPUBLISHERS = Object.freeze(Object.fromEntries(Object.entries(table.republishers ?? {}).map(([id, row]) => {
  const cap = /** @type {any} */ (row).authorityCap
  if (!id.trim() || !Number.isInteger(cap) || cap < 1 || cap > 5) throw new Error(`frontier-selection.json: the republisher ${JSON.stringify(id)} has no authority cap of 1-5`)
  return [id, Object.freeze({ name: String(/** @type {any} */ (row).name ?? id), reason: String(/** @type {any} */ (row).reason ?? ''), authorityCap: cap, floors: /** @type {any} */ (row).floors === true })]
})))

const GENRE_CEILINGS = ceilingTable(table.ceilings?.genre, 'ceilings.genre')
const EVIDENCE_CEILINGS = ceilingTable(table.ceilings?.evidenceType, 'ceilings.evidenceType')
const DESIGN_CEILINGS = ceilingTable(table.ceilings?.design, 'ceilings.design')
/** @type {ReadonlyArray<Readonly<{ name: string, sources: ReadonlySet<string>, ceiling: Readonly<FrontierCeiling> }>>} */
const SOURCE_CLASS_CEILINGS = Object.freeze(Object.entries(table.ceilings?.sourceClass ?? {}).map(([name, row]) => Object.freeze({
  name, sources: new Set(/** @type {any} */ (row).sources ?? []), ceiling: ceilingRow(row, `ceilings.sourceClass.${name}`),
})))
const SMALL_STUDY = Object.freeze({
  below: Number(table.ceilings?.smallStudy?.below) || 0,
  designs: new Set(/** @type {string[]} */ (table.ceilings?.smallStudy?.designs ?? [])),
  ceiling: ceilingRow(table.ceilings?.smallStudy, 'ceilings.smallStudy'),
})

/**
 * The republisher a source is, or null. @param {unknown} sourceId
 * @returns {Readonly<{ name: string, reason: string, authorityCap: number, floors: boolean }> | null}
 */
export function frontierRepublisher(sourceId) {
  return typeof sourceId === 'string' && Object.hasOwn(FRONTIER_REPUBLISHERS, sourceId) ? FRONTIER_REPUBLISHERS[sourceId] : null
}

/**
 * Whether a source may take a floor place (a genre floor, the lane floor, the preprint lane): a republisher never. An unfilled floor
 * is better than a pick that rewrites another feed. @param {unknown} sourceId
 */
export function frontierFloorEligible(sourceId) {
  return frontierRepublisher(sourceId)?.floors !== false
}

/**
 * The model's parts after the ceilings code holds, and why each lowered part is lower. `parts.authority` is recomputed when the
 * source is a republisher (its grade is capped). Nothing is raised; a missing fact lowers nothing.
 *
 * The evidence type's ceilings apply only to a type code decided (`evidenceFixed`: the PubMed publication types, the registry): the
 * model's own evidence type is a guess a ceiling must not stand on — on the gold set it called the 解读 of a fifth universal definition
 * of myocardial infarction a 「review-opinion」.
 *
 * @param {{ parts: FrontierScoreParts, genre?: string | null, evidenceType?: string | null, evidenceFixed?: boolean, sourceType?: string | null,
 *           authority?: number | null, sourceId?: string | null, preprint?: boolean, flags?: readonly string[],
 *           studyFacts?: { design?: string | null, n?: number | null } | null }} input
 * @returns {{ parts: FrontierScoreParts, reasons: string[] }}
 */
export function frontierScoreCeilings({ parts, genre = null, evidenceType = null, evidenceFixed = false, sourceType = null, authority = null, sourceId = null, preprint = false, studyFacts = null }) {
  const out = { ...parts }
  /** @type {string[]} */
  const reasons = []
  const apply = (/** @type {Readonly<FrontierCeiling> | undefined} */ ceiling, /** @type {string} */ reason) => {
    if (!ceiling) return
    let lowered = false
    for (const part of PARTS) {
      const limit = ceiling[part]
      if (limit !== undefined && out[part] > limit) { out[part] = limit; lowered = true }
    }
    if (lowered) reasons.push(reason)
  }
  const republisher = frontierRepublisher(sourceId)
  if (republisher && Number(authority) > republisher.authorityCap) {
    const capped = frontierAuthorityScore({ authority: republisher.authorityCap, evidenceType, preprint })
    if (capped < out.authority) { out.authority = capped; reasons.push('republisher') }
  }
  if (genre && Object.hasOwn(GENRE_CEILINGS, genre)) apply(GENRE_CEILINGS[genre], `genre:${genre}`)
  if (evidenceFixed && evidenceType && Object.hasOwn(EVIDENCE_CEILINGS, evidenceType)) apply(EVIDENCE_CEILINGS[evidenceType], `evidence:${evidenceType}`)
  if (sourceId) for (const row of SOURCE_CLASS_CEILINGS) if (row.sources.has(sourceId)) apply(row.ceiling, `source:${row.name}`)
  void sourceType
  const design = typeof studyFacts?.design === 'string' ? studyFacts.design : null
  if (design && Object.hasOwn(DESIGN_CEILINGS, design)) apply(DESIGN_CEILINGS[design], `design:${design}`)
  const n = studyFacts?.n
  if (design && Number.isInteger(n) && /** @type {number} */ (n) > 0 && /** @type {number} */ (n) < SMALL_STUDY.below && SMALL_STUDY.designs.has(design)) apply(SMALL_STUDY.ceiling, 'small-study')
  return { parts: out, reasons }
}

// ───────────────────────── the practice-changing label ─────────────────────────

/**
 * How rare 「可能改变实践」 is (contract §P; the owner's reading of the research: practice changes for about 6% of what a team reads
 * closely, and 25% of what expert commentators pick, so a list of 60 cannot be all of it): at most `perDay` a day and at most
 * `shareOfSelected` of the day's 精选, never fewer than one when something qualifies and the day has any 精选; and the reason is one line.
 */
export const FRONTIER_PRACTICE_LIMITS = Object.freeze({ perDay: 3, shareOfSelected: 0.05, reasonChars: 60 })

/**
 * Who can carry the label: genres whose content is a decision or a result (not an opinion, a digest or a registry entry), the evidence
 * types that bind a prescriber, and a source with a grade of at least `minAuthority` (a regulator, a journal, a guideline body, a
 * credited outlet). A preprint, a company's own release and an unreviewed opinion never carry it.
 */
export const FRONTIER_PRACTICE_ELIGIBLE = Object.freeze({
  genres: Object.freeze(['paper', 'guideline', 'approval', 'safety', 'policy', 'conference', 'news', 'commentary']),
  evidenceTypes: Object.freeze(['rct', 'systematic-review', 'guideline', 'regulatory-decision', 'safety-notice']),
  minAuthority: 3,
})

/**
 * Whether an item the model proposed as practice-changing may carry the label at all (the cap is `frontierPracticeAdmit`'s).
 * @param {{ genre?: string | null, evidenceType?: string | null, authority?: number | null, preprint?: boolean, flags?: readonly string[] }} item
 */
export function frontierPracticeAdmissible({ genre = null, evidenceType = null, authority = null, preprint = false, flags = [] }) {
  if (preprint || flags.includes('retracted') || flags.includes('press-release')) return false
  return FRONTIER_PRACTICE_ELIGIBLE.genres.includes(/** @type {string} */ (genre))
    && FRONTIER_PRACTICE_ELIGIBLE.evidenceTypes.includes(/** @type {string} */ (evidenceType))
    && Number(authority) >= FRONTIER_PRACTICE_ELIGIBLE.minAuthority
}

/** The most labels a day with `selectedCount` items in 精选 carries. @param {number} selectedCount */
export function frontierPracticeCap(selectedCount) {
  const share = Math.floor(FRONTIER_PRACTICE_LIMITS.shareOfSelected * Math.max(0, selectedCount))
  return Math.min(FRONTIER_PRACTICE_LIMITS.perDay, Math.max(1, share))
}

/**
 * The reason as it is stored and shown: one line, whitespace folded, within `reasonChars`; null when there is none to show.
 * @param {unknown} value @returns {string | null}
 */
export function frontierPracticeReason(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!text) return null
  const chars = [...text]
  return chars.length <= FRONTIER_PRACTICE_LIMITS.reasonChars ? text : null
}

/**
 * The day's labels: of the items the model proposed that may carry it (`frontierPracticeAdmissible`), the best scored up to the day's
 * cap. A label already admitted stays and counts (selection is sticky). Pure: the mix hands it the day and writes back the result.
 * @param {ReadonlyArray<{ id: string, score: number | null, admitted?: boolean, proposed: boolean, admissible: boolean }>} candidates
 * @param {{ selectedCount: number }} day
 * @returns {{ admit: string[], cap: number }}
 */
export function frontierPracticeAdmit(candidates, { selectedCount }) {
  const cap = frontierPracticeCap(selectedCount)
  const kept = candidates.filter((item) => item.admitted === true)
  const room = Math.max(0, cap - kept.length)
  const fresh = candidates.filter((item) => item.admitted !== true && item.proposed && item.admissible)
    .sort((a, b) => (Number(b.score ?? -1) - Number(a.score ?? -1)) || String(a.id).localeCompare(String(b.id)))
  return { admit: fresh.slice(0, room).map((item) => item.id), cap }
}

// ───────────────────────── the tiers a score is drawn in ─────────────────────────

/**
 * The tiers the 「AI 评分」 pill is drawn in, on the score of 2026-10-25 (owner, 2026-10-23: three tiers, after AIHOT's pill; the
 * lines moved with the score, from 85 / 70): `high` from 76, `medium` from 60, `low` below. A selected card reads medium at least (the
 * selection line is 68, a floor place 62), as it did before the move. One table for the server's `scoreBand` and the web's fallback.
 */
export const FRONTIER_SCORE_TIERS = Object.freeze({ high: 76, medium: 60 })

/**
 * The tier a score reads in; null without a score. @param {unknown} score @returns {'high' | 'medium' | 'low' | null}
 */
export function frontierScoreTier(score) {
  if (score == null || score === '' || !Number.isFinite(Number(score))) return null
  const value = Number(score)
  return value >= FRONTIER_SCORE_TIERS.high ? 'high' : value >= FRONTIER_SCORE_TIERS.medium ? 'medium' : 'low'
}
