/**
 * What the knowledge base accepts, where each accepted format is read, and how
 * a character offset in a parsed document becomes a page number.
 *
 * Hidden knowledge: the format list is not ours to invent. It is the in-house
 * parsing API's own table (`docs/api/API.md` v0.5.0, 支持的文件格式, and
 * `server.py` `DocumentHandler.SUPPORTED_FORMATS`), minus the audio and video
 * formats that table lists and marks 「暂不支持」 — the service accepts the
 * upload and then has nothing to say about it. Plain-text formats are read here
 * instead, byte for byte, even when the API would take them: the delivery gate
 * matches quotations verbatim, so a local read of a text file is strictly
 * better than a round trip that might re-flow it, and it costs no credit.
 *
 * One module for the server and the browser, so the upload refusal and the
 * picker's `accept` list cannot disagree about a format.
 *
 * @module @evimed/domain/source-documents
 */

/** Parsed by the in-house API (metadata by its model, text by Alibaba DocMind). */
export const SOURCE_API_FORMATS = Object.freeze([
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'xlsm',
  'jpg', 'jpeg', 'png', 'bmp', 'gif',
  'epub', 'mobi', 'htm', 'html', 'rtf',
])

/** Read locally and kept byte-exact: what the file says is what a quotation
 *  is checked against. `txt` and `md` are on the API's list too and stay here. */
export const SOURCE_LOCAL_TEXT_FORMATS = Object.freeze([
  'txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'r', 'py', 'sql',
])

/** Listed by the API and not parsed by it, plus the recordings a researcher is
 *  likely to try. Refused by name so the reason can say why. */
export const SOURCE_MEDIA_FORMATS = Object.freeze([
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'mp3', 'wav', 'aac', 'm4a', 'flac',
])

/** Everything the knowledge base accepts, for the upload check and the picker. */
export const KNOWLEDGE_BASE_FORMATS = Object.freeze(
  [...new Set([...SOURCE_API_FORMATS, ...SOURCE_LOCAL_TEXT_FORMATS])].sort(),
)

/** A file name's format: its extension, lower-cased, without the dot; `''`
 *  when it has none. A leading dot is a hidden file, not an extension.
 * @param {unknown} name @returns {string} */
export function sourceFileFormat(name) {
  const base = String(name ?? '').replaceAll('\\', '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/**
 * Where a file of this name is read.
 *
 * `local` — read byte-exact on the control plane; `api` — sent to the parsing
 * API; `media` — a recording, refused with the reason; `unsupported` — anything
 * else, refused with the list.
 * @param {unknown} name @returns {'local' | 'api' | 'media' | 'unsupported'}
 */
export function sourceFormatRoute(name) {
  const format = sourceFileFormat(name)
  if (SOURCE_LOCAL_TEXT_FORMATS.includes(format)) return 'local'
  if (SOURCE_API_FORMATS.includes(format)) return 'api'
  if (SOURCE_MEDIA_FORMATS.includes(format)) return 'media'
  return 'unsupported'
}

/** A page's parse state, in the parser's own words (plan §2.4). */
export const SOURCE_PAGE_STATUSES = Object.freeze(['ok', 'empty', 'ocr_failed'])

/** Pages beyond this are not mapped: a map that large is one product record's
 *  worth of numbers, and no document a researcher uploads has that many. */
export const SOURCE_PAGE_MAP_MAX_PAGES = 6000

/**
 * A page map re-expressed in the offsets of the text the capture stores.
 *
 * `normalizeSourceText` removes a leading byte-order mark and folds CRLF into
 * LF, so every offset past one of those removals moves. A page map left in the
 * parser's offsets would put every page marker, and every quotation's page,
 * one character further off per Windows line ending — on a scanned guideline
 * that is the wrong page within a few paragraphs. This applies exactly the same
 * removals and nothing else: a lone CR becomes LF in place and moves nothing.
 *
 * Returns `null` for a map that is not a list of well-formed, ordered,
 * non-overlapping pages inside the text: a page map that cannot be trusted is
 * dropped, and the document is still ingested without one.
 *
 * @param {string} rawText the parser's text, before normalization
 * @param {unknown} pageMap `[{ page, start, end, status }]`, UTF-16 offsets into `rawText`
 * @returns {{ page: number, start: number, end: number, status: string }[] | null}
 */
export function normalizeSourcePageMap(rawText, pageMap) {
  const text = String(rawText ?? '')
  if (!Array.isArray(pageMap) || pageMap.length === 0 || pageMap.length > SOURCE_PAGE_MAP_MAX_PAGES) return null
  /** @type {{ page: number, start: number, end: number, status: string }[]} */
  const pages = []
  let previousEnd = 0
  let previousPage = 0
  for (const entry of pageMap) {
    if (!entry || typeof entry !== 'object') return null
    const { page, start, end, status } = /** @type {Record<string, unknown>} */ (entry)
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
    const [pageNumber, from, to] = /** @type {[number, number, number]} */ ([page, start, end])
    if (pageNumber <= previousPage || from < previousEnd || to < from || to > text.length) return null
    if (typeof status !== 'string' || !SOURCE_PAGE_STATUSES.includes(status)) return null
    pages.push({ page: pageNumber, start: from, end: to, status })
    previousEnd = to
    previousPage = pageNumber
  }
  /** @type {number[]} raw indices `normalizeSourceText` removes, ascending */
  const removed = []
  if (text.charCodeAt(0) === 0xFEFF) removed.push(0)
  for (let index = text.indexOf('\r\n'); index !== -1; index = text.indexOf('\r\n', index + 2)) removed.push(index)
  /** @param {number} offset */
  const shift = (offset) => {
    let low = 0
    let high = removed.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (removed[middle] < offset) low = middle + 1
      else high = middle
    }
    return offset - low
  }
  return pages.map((entry) => ({ ...entry, start: shift(entry.start), end: shift(entry.end) }))
}

/**
 * The page a character offset falls on — how a quotation becomes 「第 N 页」.
 *
 * An offset inside a page's span is on that page. An offset in the gap between
 * two spans (the whitespace a parser leaves between pages) belongs to the page
 * that follows, which is where the quoted words begin. An empty page occupies
 * no characters and is never the answer. `null` when there is no map, or the
 * offset is past the last page.
 *
 * @param {readonly { page: number, start: number, end: number }[] | null | undefined} pageMap
 * @param {number} offset UTF-16 offset into the captured text
 * @returns {number | null}
 */
export function sourcePageForOffset(pageMap, offset) {
  if (!Array.isArray(pageMap) || !Number.isSafeInteger(offset) || offset < 0) return null
  const pages = pageMap.filter((entry) => entry && entry.end > entry.start)
  let low = 0
  let high = pages.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (pages[middle].end <= offset) low = middle + 1
    else high = middle
  }
  return low < pages.length ? pages[low].page : null
}
