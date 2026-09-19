/**
 * Retraction and correction notices on a cited work.
 *
 * Hidden knowledge: Crossref carries them on the work itself. A work that was
 * retracted, corrected or given an expression of concern lists each notice in
 * `updated-by` — the notice's own DOI, its type, when, and whether the
 * publisher deposited it or the Retraction Watch database (Crossref's since
 * 2023) recorded it; the notice in turn lists the work in `update-to`.
 * Verified on 2026-09-19 against the live REST API: Wakefield 1998
 * (10.1016/s0140-6736(97)11096-0) carries a 2004 correction and the 2010
 * retraction, both `source: "retraction-watch"`, and
 * `works?filter=doi:A,doi:B&select=DOI,updated-by` answers many works in one
 * request.
 *
 * What a reader is shown is a notice, never a verdict (principle 13): the card
 * says the work was retracted and links the notice; whether the claim still
 * stands is the report's to argue. Nothing here gates a delivery — the
 * retraction check the gate will one day run is `retractionCheck.mjs`, and it
 * is a notice too until a measured distribution says otherwise.
 *
 * Crossref's update types are a closed vocabulary, so the mapping is a table,
 * not a pattern (principle 5). Types that do not change what a reader should
 * make of the work — an addendum, a new version, a comment — are not shown.
 *
 * @module @evimed/domain/source-updates
 */

/** The kinds a source card shows, most serious first. */
export const SOURCE_UPDATE_KINDS = Object.freeze([
  'retraction',
  'partial_retraction',
  'withdrawal',
  'removal',
  'expression_of_concern',
  'correction',
])

/** Crossref `type` → the kind shown. Corrigenda and errata are corrections. */
const CROSSREF_UPDATE_TYPES = new Map([
  ['retraction', 'retraction'],
  ['partial_retraction', 'partial_retraction'],
  ['withdrawal', 'withdrawal'],
  ['removal', 'removal'],
  ['expression_of_concern', 'expression_of_concern'],
  ['correction', 'correction'],
  ['corrigendum', 'correction'],
  ['erratum', 'correction'],
])

/** Chinese badge text. */
export const SOURCE_UPDATE_LABELS_ZH = Object.freeze({
  retraction: '已撤稿',
  partial_retraction: '部分撤稿',
  withdrawal: '已撤回',
  removal: '已移除',
  expression_of_concern: '编辑部关注声明',
  correction: '有更正',
})

/**
 * How much the notice changes what the work can carry: `withdrawn` — it no
 * longer stands as published; `concern` — the journal itself has doubts;
 * `corrected` — read the corrected version.
 */
export const SOURCE_UPDATE_WEIGHT = Object.freeze({
  retraction: 'withdrawn',
  partial_retraction: 'withdrawn',
  withdrawal: 'withdrawn',
  removal: 'withdrawn',
  expression_of_concern: 'concern',
  correction: 'corrected',
})

const DOI_PATTERN = /^10\.\d{4,9}\/[^\s]{1,300}$/

/**
 * A DOI in the one form Crossref and this code compare: lower-case, no
 * resolver prefix, no sentence punctuation after it. Null when it is not one.
 * @param {unknown} value @returns {string | null}
 */
export function doiOf(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[.,;)\]]+$/, '')
    .toLowerCase()
  return DOI_PATTERN.test(text) ? text : null
}

/**
 * @typedef {object} SourceUpdate
 * @property {string} kind one of SOURCE_UPDATE_KINDS
 * @property {string | null} noticeDoi the notice's own DOI, lower-case
 * @property {string | null} date YYYY-MM-DD, when Crossref gives one
 * @property {'publisher' | 'retraction-watch' | null} source who recorded it
 */

/** @param {any} updated @returns {string | null} */
function noticeDate(updated) {
  const stamp = typeof updated?.['date-time'] === 'string' ? updated['date-time'] : null
  if (stamp && /^\d{4}-\d{2}-\d{2}/.test(stamp)) return stamp.slice(0, 10)
  const parts = Array.isArray(updated?.['date-parts']?.[0]) ? updated['date-parts'][0] : null
  if (!parts || !Number.isInteger(parts[0])) return null
  const [year, month = 1, day = 1] = parts
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * The notices one Crossref work record carries about itself, most serious
 * first, one per notice.
 * @param {any} work a `message` or an `items[]` entry of the Crossref REST API
 * @returns {SourceUpdate[]}
 */
export function sourceUpdatesFromCrossref(work) {
  const entries = Array.isArray(work?.['updated-by']) ? work['updated-by'] : []
  /** @type {Map<string, SourceUpdate>} */
  const updates = new Map()
  for (const entry of entries) {
    const kind = CROSSREF_UPDATE_TYPES.get(String(entry?.type ?? '').trim().toLowerCase())
    if (!kind) continue
    const noticeDoi = doiOf(entry?.DOI)
    const recordedBy = String(entry?.source ?? '').trim().toLowerCase()
    const update = {
      kind,
      noticeDoi,
      date: noticeDate(entry?.updated),
      source: recordedBy === 'retraction-watch' || recordedBy === 'publisher' ? /** @type {'publisher' | 'retraction-watch'} */ (recordedBy) : null,
    }
    const key = `${kind}\u0000${noticeDoi ?? ''}`
    // The same notice recorded twice (publisher and Retraction Watch) is one
    // notice; the publisher's own record is kept when there are both.
    if (!updates.has(key) || update.source === 'publisher') updates.set(key, update)
  }
  return [...updates.values()].sort((left, right) => (
    SOURCE_UPDATE_KINDS.indexOf(left.kind) - SOURCE_UPDATE_KINDS.indexOf(right.kind)
    || String(left.date ?? '').localeCompare(String(right.date ?? ''))
  ))
}
