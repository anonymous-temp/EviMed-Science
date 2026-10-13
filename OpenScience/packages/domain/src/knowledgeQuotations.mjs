/**
 * The after-the-fact quotation label of a compiled page: for every source link, whether the quotation its title
 * carries is really in the document it names.
 *
 * Hidden knowledge:
 *
 * - **A label, never a condition.** The page is OpenViking's, written the way upstream writes it; nothing here changes
 *   it, refuses it or takes a sentence out of it. The outcome is a side record the reader lays over the page (✓ / ⚠),
 *   and a link with no quotation simply has none. This is the medical strength laid on top of a general workflow, not
 *   a gate in front of it (owner's ruling of 2026-10-12).
 * - **Presence is the platform's one comparison** (`quoteIsPresent`), against the text the platform itself captured
 *   from the document — the same bytes it pushed for the compile to read. The caller hands that text in by address, so
 *   this module knows nothing of where documents are kept.
 * - **The compile instruction asks for the quotation in the link's title** (`[标题](viking://…/src_….md "逐字原文")`).
 *   Measured over five compiles: 568 of 568 claim links carried one and 567 were verbatim in the document named.
 * - **A source link may have lost its `.md`** — one run wrote all 121 of its source links that way (the engine checks
 *   that a link falls inside the compile's sources, not that the file exists). The address is unambiguous either way,
 *   and `knowledgeSourceIdOfUri` reads both.
 * - **The list under 「来源」 / "Sources" names documents, not claims.** Links below that heading are reported apart
 *   (`inSourceList`), so a page's ratio of confirmed sentences is not diluted by its bibliography.
 *
 * @module @evimed/domain/knowledge-quotations
 */

import { quoteIsPresent } from './clinicalEvidence.mjs'
import { okfLinkPath, okfMarkdownLinks, splitOkfFrontmatter } from './okfMarkdown.mjs'

/** What one source link's quotation came to. `no_quotation` and `source_missing` are statements, not failures. */
export const KNOWLEDGE_QUOTATION_STATUSES = Object.freeze(['present', 'absent', 'no_quotation', 'source_missing'])

/** @typedef {'present' | 'absent' | 'no_quotation' | 'source_missing'} KnowledgeQuotationStatus */

/**
 * The knowledge-base document a resource address names: the `src_…` id in its last segment, with or without `.md`.
 * Null for any other address — a page, a directory, a file the platform did not push.
 * @param {unknown} uri @returns {string | null}
 */
export function knowledgeSourceIdOfUri(uri) {
  const last = String(uri ?? '').split('#')[0].replace(/\/+$/, '').split('/').pop() ?? ''
  return /^(src_[a-f0-9]{32})(?:\.md)?$/.exec(last)?.[1] ?? null
}

/**
 * @typedef {object} KnowledgeQuotationRecord
 * @property {string} page        the page's path in its tree
 * @property {string} sourceUri   the link's destination, decoded
 * @property {string | null} sourceId  the knowledge-base document it names, when it names one
 * @property {string} linkText
 * @property {string | null} quote
 * @property {boolean} inSourceList
 * @property {KnowledgeQuotationStatus} status
 * @property {number} index  the link's offset in the page's body
 */

/**
 * @param {ReadonlyArray<{ path: string, content: string }>} pages  the compiled tree
 * @param {{ sourceText: (uri: string, sourceId: string | null) => string | null | undefined,
 *   isSourceUri?: (uri: string) => boolean, present?: (text: string, quote: string) => boolean }} options
 *   `sourceText`: the captured text of the document an address names, or null when the platform holds none
 * @returns {{ records: KnowledgeQuotationRecord[], summary: { pages: number, sourceLinks: number, inSourceList: number,
 *   besideClaims: number, besideClaimsWithQuotation: number, present: number, absent: number, noQuotation: number,
 *   sourceMissing: number } }}
 */
export function checkPageQuotations(pages, { sourceText, isSourceUri = (uri) => uri.startsWith('viking://'), present = quoteIsPresent }) {
  /** @type {KnowledgeQuotationRecord[]} */
  const records = []
  let counted = 0
  for (const page of pages) {
    if (!/\.md$/i.test(String(page.path))) continue
    counted += 1
    const { body } = splitOkfFrontmatter(page.content)
    const listAt = body.search(/^##[ \t]+(?:来源|Sources)[ \t]*$/m)
    for (const link of okfMarkdownLinks(body)) {
      const uri = okfLinkPath(link.target)
      if (!isSourceUri(uri)) continue
      const sourceId = knowledgeSourceIdOfUri(uri)
      const quote = typeof link.title === 'string' && link.title.trim() ? link.title.trim() : null
      const text = sourceText(uri, sourceId)
      /** @type {KnowledgeQuotationStatus} */
      const status = text == null ? 'source_missing' : !quote ? 'no_quotation' : present(text, quote) ? 'present' : 'absent'
      records.push({ page: page.path, sourceUri: uri, sourceId, linkText: link.text, quote, inSourceList: listAt !== -1 && link.index > listAt, status, index: link.index })
    }
  }
  const beside = records.filter((record) => !record.inSourceList)
  const count = (/** @type {KnowledgeQuotationStatus} */ status) => beside.filter((record) => record.status === status).length
  return {
    records,
    summary: {
      pages: counted, sourceLinks: records.length, inSourceList: records.length - beside.length, besideClaims: beside.length,
      besideClaimsWithQuotation: beside.filter((record) => record.quote).length,
      present: count('present'), absent: count('absent'), noQuotation: count('no_quotation'),
      sourceMissing: records.filter((record) => record.status === 'source_missing').length,
    },
  }
}
