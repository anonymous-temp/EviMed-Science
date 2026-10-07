/**
 * The module names the owner replaced on 2026-10-07 — 「循证传播」 went back to
 * 「循证 GEO」, and 「虚拟临研」 became 「虚拟临床研究」 — and how long the old
 * ones keep finding things.
 *
 * A researcher who learned the old name types it into a search box. For three
 * months the search boxes over tools, skills and plugins read it as the new
 * name, so the answer is the row they were after instead of an empty list; the
 * old name is never shown back. After {@link RETIRED_NAME_SEARCH_UNTIL} the
 * alias is gone: the old name is a word like any other and finds only what
 * contains it.
 *
 * Each retired name sits on a line marked `retired-word-ok`, the marker the
 * retired-words guards (web and server) read as "this is data about the old
 * name, not a sentence that uses it".
 *
 * Only the search is aliased. The ledgers, URLs, identifiers and stored
 * conversations keep what they hold.
 *
 * @module @evimed/domain/src/retiredNames
 */

/**
 * The last day the old names are read as the new ones: 2027-01-07, three
 * months after the rename. Past it {@link searchNeedles} stops adding the
 * alias; the module can then be deleted with its callers.
 */
export const RETIRED_NAME_SEARCH_UNTIL = '2027-01-07'

/** @type {ReadonlyArray<Readonly<{ retired: string, now: string }>>} */
export const RETIRED_MODULE_NAMES = Object.freeze([
  Object.freeze({ retired: '循证传播', now: '循证 GEO' }), // retired-word-ok
  Object.freeze({ retired: '虚拟临研', now: '虚拟临床研究' }), // retired-word-ok
])

/**
 * The strings a search over product text should try for what the researcher
 * typed: the query as typed, lowercased, and — while the alias lasts — the
 * same query with each retired module name read as its current name. Matching
 * any one of them counts as a hit, so a row that still holds the old name
 * (a note, a stored title) is found by the old name as well.
 * @param {string} query
 * @param {number} [now] epoch milliseconds; the one clock, injectable for tests
 * @returns {string[]}
 */
export function searchNeedles(query, now = Date.now()) {
  const typed = String(query ?? '').trim().toLowerCase()
  if (!typed) return []
  const needles = [typed]
  if (now <= Date.parse(`${RETIRED_NAME_SEARCH_UNTIL}T23:59:59Z`)) {
    let read = typed
    for (const { retired, now: current } of RETIRED_MODULE_NAMES) read = read.split(retired).join(current.toLowerCase())
    if (read !== typed) needles.push(read)
  }
  return needles
}

/**
 * Whether any of a row's texts holds what the researcher typed, by
 * {@link searchNeedles}. An empty query matches everything.
 * @param {string} query
 * @param {ReadonlyArray<string | null | undefined>} texts
 * @param {number} [now]
 */
export function searchMatches(query, texts, now = Date.now()) {
  const needles = searchNeedles(query, now)
  if (!needles.length) return true
  const haystack = texts.map((text) => String(text ?? '').toLowerCase())
  return needles.some((needle) => haystack.some((text) => text.includes(needle)))
}
