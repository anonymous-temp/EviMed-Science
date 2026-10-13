// The answer protocol: writing and reading the evimed-source comments, and checking each against the document it names.
import { quoteIsPresent } from '@evimed/domain/clinical-evidence'

const MARKER = /<!--\s*evimed-source:\s*(\{[^\n]{1,8000}?\})\s*-->/g

/** What a document id looks like. A page id (`page:…`) or an invented id never matches. */
export const SOURCE_ID = /^src_[a-f0-9]{32}$/

/**
 * The quotation lengths a reader can use. These are the limits the platform's page contract had when the first results were
 * recorded (2026-10-12); that contract was removed with the self-built compiler, so the harness keeps the two numbers itself
 * and every run, old or new, is checked by one rule.
 */
export const QUOTE_LIMITS = Object.freeze({ minChars: 10, maxChars: 600 })

/**
 * One evimed-source comment. `<` and `>` are escaped in the JSON, so a quotation that holds `-->` is still one comment and
 * still the same string when parsed.
 * @param {string} sourceId @param {string} quote @returns {string}
 */
export function sourceMarker(sourceId, quote) {
  return `<!-- evimed-source:${JSON.stringify({ sourceId, quote }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`
}

/**
 * Every evimed-source comment in a reply, as written (an id that is not a document id is kept, because citing a page or an
 * invented id is a failure to count, not a comment to skip).
 * @param {string} text @returns {Array<{ sourceId: string, quote: string }>}
 */
export function parseMarkers(text) {
  const found = []
  for (const match of String(text ?? '').matchAll(MARKER)) {
    try {
      const value = JSON.parse(match[1])
      found.push({ sourceId: typeof value?.sourceId === 'string' ? value.sourceId : '', quote: typeof value?.quote === 'string' ? value.quote : '' })
    } catch { found.push({ sourceId: '', quote: '' }) }
  }
  return found
}

/** The reply as a reader sees it: the comments are metadata. @param {string} text */
export function stripMarkers(text) {
  return String(text ?? '').replace(MARKER, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * One quotation against the document it names, by the platform's one comparison (`quoteIsPresent`).
 *  - `quote_invalid`: the id is not a document id (a page, an invented id), or the quotation is under 10 or over 600 characters;
 *  - `source_unavailable`: a well-formed id that is not a document of the knowledge base;
 *  - `quote_not_found`: the document does not say it;
 *  - `verified`.
 * @param {{ sourceId: unknown, quote: unknown }} entry
 * @param {(sourceId: string) => { text: string } | null} resolve  documents only; pages and unknown ids resolve to null
 * @returns {{ status: 'verified' | 'quote_not_found' | 'source_unavailable' | 'quote_invalid' }}
 */
export function checkCitation(entry, resolve) {
  if (typeof entry?.quote !== 'string' || entry.quote.trim().length < QUOTE_LIMITS.minChars || entry.quote.length > QUOTE_LIMITS.maxChars
    || !SOURCE_ID.test(String(entry.sourceId))) return { status: 'quote_invalid' }
  const document = resolve(String(entry.sourceId))
  if (!document || typeof document.text !== 'string') return { status: 'source_unavailable' }
  return { status: quoteIsPresent(document.text, entry.quote) ? 'verified' : 'quote_not_found' }
}

/**
 * The code check of a reply's citations: each marker against the document it names. A marker naming a knowledge page counts
 * separately (`pageCited`) and, like any marker whose id is not a document's, does not verify.
 * @param {string} answer
 * @param {(sourceId: string) => { text: string } | null} resolve  documents only; pages and unknown ids resolve to null
 * @returns {{ markerCount: number, verified: number, verifiedRate: number | null, byStatus: Record<string, number>, pageCited: number }}
 */
export function checkAnswerCitations(answer, resolve) {
  const markers = parseMarkers(answer)
  const byStatus = {}
  let verified = 0
  let pageCited = 0
  for (const marker of markers) {
    if (marker.sourceId.startsWith('page:')) pageCited += 1
    const checked = checkCitation(marker, resolve)
    byStatus[checked.status] = (byStatus[checked.status] ?? 0) + 1
    if (checked.status === 'verified') verified += 1
  }
  return { markerCount: markers.length, verified, verifiedRate: markers.length ? verified / markers.length : null, byStatus, pageCited }
}
