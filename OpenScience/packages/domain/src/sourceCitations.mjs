import { quoteIsPresent } from './clinicalEvidence.mjs'

/** Keep citation metadata out of visible prose, including an unfinished streaming comment.
 * @param {string} text
 */
export function sourceCitationProse(text) {
  return text.replace(/<!--\s*evimed-source:[\s\S]*?(?:-->|$)/g, '')
}

/** Machine-readable references in reply comments; the visible reply keeps ordinary prose and source titles.
 * @param {unknown} text
 * @returns {Array<{sourceId: string, quote: string}>}
 */
export function sourceCitationReferences(text) {
  const refs = []
  const seen = new Set()
  for (const match of String(text ?? '').slice(0, 200_000).matchAll(/<!--\s*evimed-source:\s*(\{[^\n]{1,8000}?\})\s*-->/g)) {
    try {
      const value = JSON.parse(match[1])
      if (!/^src_[a-f0-9]{32}$/.test(value.sourceId) || typeof value.quote !== 'string'
        || value.quote.trim().length < 4 || value.quote.length > 2000) continue
      const key = `${value.sourceId}:${value.quote}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push({ sourceId: value.sourceId, quote: value.quote })
      if (refs.length === 20) break
    } catch { /* a malformed comment is not a reference */ }
  }
  return refs
}

/** The report's quotation check, with UTF-16 offsets only when the preserved passage is unambiguous.
 * Page numbers come exclusively from the capture's page map; neither the model nor a search hit supplies them.
 * @param {{text: string, quote: string, pageMap?: Array<{page: number, start: number, end: number}>}} input
 */
export function locateSourceQuotation({ text, quote, pageMap = [] }) {
  if (!quoteIsPresent(text, quote)) return { status: 'quote_not_found', start: null, end: null, page: null }
  const start = text.indexOf(quote)
  if (start < 0 || text.indexOf(quote, start + 1) >= 0) return { status: 'verified', start: null, end: null, page: null }
  const end = start + quote.length
  const pages = pageMap.filter(row => Number.isInteger(row.page) && row.page > 0 && row.start <= start && row.end >= end)
  return { status: 'verified', start, end, page: pages.length === 1 ? pages[0].page : null }
}
