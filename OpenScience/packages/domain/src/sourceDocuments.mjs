/**
 * Where each file of the knowledge base is read, and how a character offset in
 * a parsed document becomes a page number.
 *
 * Hidden knowledge: no list here decides what may be kept. Until 2026-10-13 the
 * knowledge base took twenty-nine extensions — the in-house parsing API's own
 * table (`docs/api/API.md` v0.5.0, 支持的文件格式, and `server.py`
 * `DocumentHandler.SUPPORTED_FORMATS`) and eleven text formats — and refused
 * the rest with 415, so a project's `src/`, a notebook, a `.tex` manuscript and
 * a `Makefile` could not be kept beside the papers they belong to. A file is
 * kept whatever it is now; the lists only say who reads its text:
 *
 * - Plain text is read here, byte for byte, even when the API would take it:
 *   the delivery gate matches quotations verbatim, so a local read of a text
 *   file is strictly better than a round trip that might re-flow it, and it
 *   costs no credit. A name these lists do not know is text when its bytes are
 *   (`sourceBytesAreText`) — `Makefile`, `LICENSE`, `Dockerfile.evimed`.
 * - PDF, Office and images go to the parsing API, as its table says.
 * - Whatever is left — an archive, a binary with a name nobody listed — is
 *   handed to the engine's own parsers where a deployment has them.
 * - A recording is read by nothing: the API's table lists audio and video and
 *   marks them 「暂不支持」, and the engine keeps them as they are.
 *
 * A file nothing could read text out of is kept as an original with no text
 * (`SOURCE_ORIGINAL_CODES`): listed and opened like any other, searched by
 * nothing.
 *
 * One module for the server and the browser, so the two cannot disagree about a
 * format.
 *
 * @module @evimed/domain/source-documents
 */

/** Parsed by the in-house API (metadata by its model, text by Alibaba DocMind). */
export const SOURCE_API_FORMATS = Object.freeze([
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'xlsm',
  'jpg', 'jpeg', 'png', 'bmp', 'gif',
  'epub', 'mobi', 'htm', 'html', 'rtf',
])

/** Source code, scripts, configuration and structured text: what a row calls 「代码」 before anyone has read it. */
export const SOURCE_CODE_FORMATS = Object.freeze([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyi', 'r', 'rmd', 'qmd', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'swift', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'lua', 'pl', 'pm', 'scala', 'm', 'mm', 'jl', 'do', 'ado', 'sas', 'sps', 'stan', 'css', 'scss', 'less', 'vue',
  'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'gradle', 'cmake', 'mk',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'ipynb', 'bst', 'cls', 'sty',
])

/** Read locally and kept byte-exact: what the file says is what a quotation
 *  is checked against. `txt` and `md` are on the API's list too and stay here;
 *  a notebook is the JSON text it is, a message the text it is. */
export const SOURCE_LOCAL_TEXT_FORMATS = Object.freeze([
  'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'adoc', 'org', 'tex', 'bib', 'log', 'srt', 'vtt', 'eml',
  'csv', 'tsv', 'xml', 'svg',
  ...SOURCE_CODE_FORMATS,
])

/** Recordings: listed by the API and not parsed by it, plus the ones a
 *  researcher is likely to add. Known by name, so one is kept as an original
 *  without a byte of it being read first — a recording can be gigabytes. */
export const SOURCE_MEDIA_FORMATS = Object.freeze([
  'mp4', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'mpg', 'mpeg', 'flv', '3gp', 'ogv',
  'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'amr',
])

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
 * Where a file of this name is read, as far as a name can say.
 *
 * `local` — read byte-exact on the control plane; `api` — sent to the parsing
 * API; `media` — a recording, read by nothing and kept as an original;
 * `engine` — a name no list knows: its bytes decide (`sourceReadRoute`), text
 * being read locally and anything else handed to the engine's parsers.
 * @param {unknown} name @returns {'local' | 'api' | 'media' | 'engine'}
 */
export function sourceFormatRoute(name) {
  const format = sourceFileFormat(name)
  if (SOURCE_LOCAL_TEXT_FORMATS.includes(format)) return 'local'
  if (SOURCE_API_FORMATS.includes(format)) return 'api'
  if (SOURCE_MEDIA_FORMATS.includes(format)) return 'media'
  return 'engine'
}

/** How many leading bytes say whether a file is text. */
export const SOURCE_TEXT_SAMPLE_BYTES = 8192

/**
 * Whether bytes are text, by what they are and not by what the file is called:
 * the sampled prefix holds no NUL byte and is well-formed UTF-8. A sequence the
 * sample cuts in two at its end is not an error; an empty file is text.
 *
 * Deterministic and deliberately narrow. A text file in another encoding with a
 * name no list knows is not recognised and goes to the engine's parsers — the
 * known text formats are decoded more generously where they are read.
 * @param {Uint8Array} bytes @returns {boolean}
 */
export function sourceBytesAreText(bytes) {
  const sample = bytes.subarray(0, SOURCE_TEXT_SAMPLE_BYTES)
  if (sample.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true })
    return true
  } catch {
    return false
  }
}

/**
 * Where these bytes under this name are read: the name's route, corrected by
 * the bytes where the name cannot know. A name no list knows is `local` when
 * its bytes are text. A name on the text list whose bytes hold a NUL is not
 * text whatever it is called (`.ts` is TypeScript and an MPEG transport stream
 * alike) and is the engine's to try.
 * @param {unknown} name @param {Uint8Array} bytes the file, or at least its first `SOURCE_TEXT_SAMPLE_BYTES`
 * @returns {'local' | 'api' | 'media' | 'engine'}
 */
export function sourceReadRoute(name, bytes) {
  const route = sourceFormatRoute(name)
  if (route === 'engine') return sourceBytesAreText(bytes) ? 'local' : 'engine'
  if (route === 'local') return bytes.subarray(0, SOURCE_TEXT_SAMPLE_BYTES).includes(0) ? 'engine' : 'local'
  return route
}

/**
 * Why a document is kept as an original with no text — what its record carries
 * (`payload.original.code`) and the registry has a sentence for. None of them is
 * a failure: the file is stored, listed and opened; it is searched by nothing
 * and nothing is pushed to the engine for it.
 *
 * `source_original_media` — a recording; nothing here transcribes one.
 * `source_original_unread` — no parser this deployment has reads the format.
 * `source_original_engine_failed` — the engine's parsers were asked and could not read it this time.
 * `source_original_no_text` — it was read, and there was no text in it.
 */
export const SOURCE_ORIGINAL_CODES = Object.freeze([
  'source_original_media', 'source_original_unread', 'source_original_engine_failed', 'source_original_no_text',
])

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
 * A document's text with a marker line where each page begins:
 * `<!-- page N -->`, or `<!-- page N: empty -->` / `<!-- page N: ocr_failed -->`
 * for a page the parser read nothing from.
 *
 * An HTML comment because the materialized `index.md` is Markdown: it renders
 * as nothing, and the model reading the file still sees where each page starts.
 * A marker gets a line of its own and never replaces a character, so the text
 * between two markers is exactly that page's text and a quotation taken from
 * inside one page matches the stored capture verbatim.
 *
 * @param {string} text the captured text
 * @param {readonly { page: number, start: number, end: number, status?: string }[] | null | undefined} pageMap
 * @returns {string}
 */
export function renderSourcePageMarkers(text, pageMap) {
  const value = String(text ?? '')
  if (!Array.isArray(pageMap) || pageMap.length === 0) return value
  let rendered = ''
  let cursor = 0
  for (const entry of pageMap) {
    const at = Math.min(Math.max(entry.start, cursor), value.length)
    rendered += value.slice(cursor, at)
    cursor = at
    const status = entry.status && entry.status !== 'ok' ? `: ${entry.status}` : ''
    const before = rendered === '' || rendered.endsWith('\n') ? '' : '\n'
    rendered += `${before}<!-- page ${entry.page}${status} -->\n`
  }
  return rendered + value.slice(cursor)
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

/**
 * What a document in the personal library is to its reader, whatever state
 * the project source behind it is in.
 *
 * `ready` — its read-only copy is current and in the search scope.
 * `processing` — the source is still being parsed, or its copy is being written.
 * `failed` — the source could not be parsed (or its analysis was canceled).
 * `detached` — no project holds the document any more (its source, or its
 * project, was deleted, or the file went missing): the library keeps the last
 * copy it made, readable and searchable, but nothing re-parses it and there is
 * no understanding left to publish from it.
 */
export const LIBRARY_ITEM_STATUSES = Object.freeze(['ready', 'processing', 'failed', 'detached'])
