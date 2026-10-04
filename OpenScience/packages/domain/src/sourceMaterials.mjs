/**
 * Structured research materials: what a parsed document's tables, figures and
 * spreadsheets say about themselves, derived deterministically from the text the
 * parser returned (or from the cells of a spreadsheet) and nothing else.
 *
 * Hidden knowledge, measured on the in-house parser (probed on the production
 * host 2026-10-04, a 141-page PDF, 35 s): the answer is `{code, message, uuid,
 * timestamp, elapsed_ms, data}` and `data.content` is ONE string. Tables arrive
 * as GitHub-style Markdown (113 in that document); page footers appear only
 * where the document prints them ("2/ 141", as plain text); there is no heading
 * markup, no image reference, no page object, no region or bounding box and no
 * cell span. So this module derives what Markdown can state — which table, which
 * header, which cell — and records what it cannot (merged cells, multi-level
 * headers, the page, the region) as UNKNOWN, never as a guess:
 *
 * - a cell's address is its row and column in its table and its character span
 *   in the captured text, so `text.slice(start, end)` is the cell and a reader
 *   (or a test) can check that it is. Row 1 is the header row;
 * - a table's caption and footnotes are the lines next to it, found by closed
 *   formats (`Table 2`, `表 2`, a footnote marker and the line that begins with
 *   it) — never by reading prose;
 * - a cell's value is parsed only from closed formats: a number, a percentage,
 *   n/N, n (%), an estimate with its interval, mean ± SD, a p-value, a missing
 *   marker. A cell that carries digits and fits none of them is counted as
 *   UNEXTRACTED with its text kept; what it means is left to the
 *   `source-understanding` capability, as an inference kept apart from these
 *   parsed facts;
 * - unit, denominator and timepoint are read from the header (and a row label
 *   that is itself a timepoint) by closed vocabularies; a percentage's
 *   arithmetic against its denominator is checked and the verdict recorded
 *   either way;
 * - two consecutive tables with the same header are a possible continuation and
 *   are recorded as exactly that — `ambiguous` — unless the text itself says
 *   "(continued)" or 「续表」, which is `stated`.
 *
 * The page a unit is on is not here: it is computed from the original bytes by
 * `sourceMaterialsLocate.mjs`. A region (bounding box) stays unknown for every unit.
 *
 * No Node API: this module also loads in the browser and in plugin sandboxes.
 *
 * @module @evimed/domain/source-materials
 */

/** Bumped when a stored shape or a derivation rule changes; part of the extraction version. */
export const SOURCE_MATERIALS_VERSION = 1
/** The extraction version recorded beside the parser's own revision. */
export const SOURCE_MATERIALS_EXTRACTOR = 'evimed-materials@1'

/**
 * Bounds that keep one table inside a product record (256 KiB). Anything beyond
 * a bound is counted as unextracted and says so; it is never dropped silently.
 */
export const SOURCE_MATERIAL_LIMITS = Object.freeze({
  maxTables: 400,
  maxCellsPerTable: 1000,
  maxCellChars: 1000,
  maxFigures: 300,
  maxSupplements: 100,
  maxFootnotesPerTable: 24,
  maxCaptionChars: 600,
  maxSheets: 40,
})

/**
 * How a value in a format is located: by page, by sheet cell, by delimited row and
 * column, in an image, or by its place in the flow of the text. `unaddressed` is a
 * spreadsheet whose cells could not be read as cells: the parser's Markdown of it
 * has tables and no sheet addresses, so its values have no location in the workbook.
 */
export const SOURCE_PAGINATIONS = Object.freeze(['paginated', 'sheet', 'delimited', 'image', 'flow', 'unaddressed'])
/** Where a value came from. `graph_estimated` is reserved for a value read off a figure by the digitizer; this module never produces one. */
export const SOURCE_VALUE_ORIGINS = Object.freeze(['reported', 'ocr', 'graph_estimated'])
/** The closed formats a cell is parsed into; anything else is text. */
export const SOURCE_VALUE_KINDS = Object.freeze([
  'number', 'percent', 'count_percent', 'fraction', 'fraction_percent', 'estimate_interval',
  'mean_sd', 'paren_pair', 'interval', 'p_value', 'bound', 'date', 'boolean', 'error', 'missing',
])
/** What the parser's output says about where on the page a unit is: nothing. Written on every table and figure so the absence is a stated fact, not a silence. */
export const SOURCE_MATERIAL_REGION_UNKNOWN = Object.freeze({ status: 'unknown', reason: 'parser_sends_no_regions' })
/** The kinds that count as a value in the ledger: a date, a flag, an error and a missing marker are typed cells, not values. */
const NON_VALUE_KINDS = new Set(['date', 'boolean', 'error', 'missing'])
export const SOURCE_TABLE_STATUSES = Object.freeze(['structured', 'unextracted'])
export const SOURCE_TABLE_UNEXTRACTED_REASONS = Object.freeze(['html_table', 'invalid_table', 'headerless_rows', 'table_limit', 'derivation_failed'])
export const SOURCE_CONTINUATION_BASES = Object.freeze(['caption_marker', 'same_header', 'same_columns'])
export const SOURCE_CONTINUATION_CERTAINTIES = Object.freeze(['stated', 'ambiguous'])

/** @typedef {{ status: 'located' | 'ambiguous' | 'unknown', pages?: number[], candidates?: number[], basis?: string, reason?: string }} MaterialPage */
/** @typedef {{ r: number, c: number, t: string, s?: number, e?: number, a?: string, v?: Record<string, any>, fn?: string[], formula?: string, truncated?: boolean }} MaterialCell */
/** @typedef {Record<string, any>} MaterialTable */
/** @typedef {{ unit?: string, denominator?: number, timepoint?: Record<string, any>, hints?: Set<string>, ciLevel?: number }} HeaderContext */

/** @param {unknown} value @returns {string} */
const str = (value) => (typeof value === 'string' ? value : '')

/**
 * The text a capture stores: the parser's text without a byte-order mark and
 * with every line ending folded to LF. Offsets in this module are into this
 * text — the one `normalizeSourceText` chunks — and a test holds the two equal.
 * @param {unknown} raw @returns {string}
 */
export function materialCaptureText(raw) {
  return str(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/**
 * A text reduced to the letters and digits a reader compares: Unicode
 * compatibility-folded, lower-cased, everything else removed. Two renderings of
 * one cell — the parser's and the PDF text layer's — agree on this when they
 * agree on what the cell says, whatever they do with spaces, hyphenation, line
 * breaks and punctuation.
 * @param {unknown} value @returns {string}
 */
export function materialSkeleton(value) {
  return str(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** How values in a file format are located. @param {unknown} format @returns {'paginated' | 'sheet' | 'delimited' | 'image' | 'flow'} */
export function sourceMaterialsPagination(format) {
  const value = str(format).toLowerCase()
  if (['pdf', 'doc', 'docx', 'ppt', 'pptx', 'rtf'].includes(value)) return 'paginated'
  if (['xlsx', 'xlsm', 'xls'].includes(value)) return 'sheet'
  if (['csv', 'tsv'].includes(value)) return 'delimited'
  if (['jpg', 'jpeg', 'png', 'bmp', 'gif'].includes(value)) return 'image'
  return 'flow'
}

// ---------------------------------------------------------------------------
// Lines and Markdown rows
// ---------------------------------------------------------------------------

/** @param {string} text @returns {{ start: number, end: number, text: string }[]} */
function linesOf(text) {
  /** @type {{ start: number, end: number, text: string }[]} */
  const lines = []
  let start = 0
  while (start <= text.length) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = text.length
    lines.push({ start, end, text: text.slice(start, end) })
    start = end + 1
  }
  return lines
}

const blank = (/** @type {string} */ line) => line.trim() === ''

/** A pipe that is not escaped. @param {string} line */
function hasPipe(line) {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '\\') { index += 1; continue }
    if (line[index] === '|') return true
  }
  return false
}

/**
 * The cells of one Markdown table row, trimmed, with absolute offsets.
 * @param {string} text @param {number} lineStart @param {number} lineEnd
 * @returns {{ s: number, e: number, t: string }[]}
 */
function splitRow(text, lineStart, lineEnd) {
  /** @type {{ s: number, e: number, t: string }[]} */
  const cells = []
  let index = lineStart
  while (index < lineEnd && (text[index] === ' ' || text[index] === '\t')) index += 1
  if (text[index] === '|') index += 1
  let cellStart = index
  /** @param {number} from @param {number} to */
  const push = (from, to) => {
    let s = from
    let e = to
    while (s < e && /\s/.test(text[s])) s += 1
    while (e > s && /\s/.test(text[e - 1])) e -= 1
    cells.push({ s, e, t: text.slice(s, e) })
  }
  for (let cursor = index; cursor < lineEnd; cursor += 1) {
    if (text[cursor] === '\\' && text[cursor + 1] === '|') { cursor += 1; continue }
    if (text[cursor] === '|') { push(cellStart, cursor); cellStart = cursor + 1 }
  }
  if (text.slice(cellStart, lineEnd).trim() !== '') push(cellStart, lineEnd)
  return cells
}

/** A Markdown delimiter row: every cell is dashes with optional colons. @param {{ t: string }[]} cells */
const isDelimiterRow = (cells) => cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.t))

// ---------------------------------------------------------------------------
// Closed formats: footnote markers, units, timepoints, caption labels
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const SUPERSCRIPTS = {
  '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁰': '0',
  'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵉ': 'e', 'ᶠ': 'f', 'ᵍ': 'g', 'ʰ': 'h', 'ⁱ': 'i', 'ʲ': 'j', 'ᵏ': 'k',
}
const TRAILING_MARKER = /(?:<sup>\s*([^<]{1,8}?)\s*<\/sup>|\^([A-Za-z0-9*†‡§¶‖,]{1,8})\^|([¹²³⁴⁵⁶⁷⁸⁹⁰ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏ]+)|\\?(\*{1,3})|([†‡§¶‖]+))\s*$/

/**
 * The footnote markers a cell ends with, and the text before them. Only the
 * explicit marker forms count — `<sup>a</sup>`, `^a^`, a superscript character, a
 * trailing `*` `†` `‡` `§` `¶` — never a bare letter, which may just be a letter.
 * @param {string} raw @returns {{ core: string, markers: string[] }}
 */
export function materialCellMarkers(raw) {
  let core = raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').trim()
  /** @type {string[]} */
  const markers = []
  for (let guard = 0; guard < 4; guard += 1) {
    const found = TRAILING_MARKER.exec(core)
    if (!found || found.index === 0) break
    const [, sup, caret, superscript, stars, symbols] = found
    if (sup) markers.unshift(...sup.split(/[,\s]+/).filter(Boolean))
    else if (caret) markers.unshift(...caret.split(',').filter(Boolean))
    else if (superscript) markers.unshift(...[...superscript].map((character) => SUPERSCRIPTS[character] ?? character))
    else if (stars) markers.unshift(stars)
    else if (symbols) markers.unshift(...[...symbols])
    core = core.slice(0, found.index).trimEnd()
  }
  return { core, markers: [...new Set(markers)] }
}

/** The units a header may state, compared lower-case. Closed on purpose: a header word that is not here is not a unit. */
const UNITS = new Set([
  '%', 'mg', 'g', 'kg', 'µg', 'μg', 'ug', 'ng', 'pg', 'mg/dl', 'mg/l', 'g/l', 'g/dl', 'ng/ml', 'pg/ml', 'mmol/l', 'µmol/l', 'μmol/l', 'umol/l',
  'mmhg', 'kg/m²', 'kg/m2', 'cm', 'mm', 'm', 'ml', 'l', 'iu', 'u/l', 'iu/l', 'bpm', 'year', 'years', 'yr', 'yrs', 'y',
  'month', 'months', 'mo', 'week', 'weeks', 'wk', 'day', 'days', 'd', 'hour', 'hours', 'h', 'min', 'minutes', 'seconds', 's',
  'ms', 'events', 'person-years', 'mg/kg', 'mg/day', 'mg/d', 'ml/min', 'ml/min/1.73m²', 'ml/min/1.73 m²', '°c', 'score', 'points',
])

/**
 * What a header cell states: a unit, a denominator (`N = 120`), a timepoint, and
 * which closed statistical abbreviations it carries. `count_percent` is the
 * header of an `n (%)` column — a percent unit alone ("HbA1c (%)") is not that.
 * @param {string} header @returns {HeaderContext & { hints: Set<string> }}
 */
export function materialHeaderContext(header) {
  const folded = header.normalize('NFKC')
  /** @type {Set<string>} */
  const hints = new Set()
  /** @type {HeaderContext & { hints: Set<string> }} */
  const context = { hints }
  // A unit is a parenthesised group or a later comma-separated part ("Age, years"),
  // never the variable's own name: a column headed "M" is not a column of metres.
  const candidates = [
    ...[...folded.matchAll(/[([]([^()[\]]{1,28})[)\]]/g)].map((match) => match[1].trim()),
    ...folded.split(',').slice(1).map((part) => part.replace(/[([][^()[\]]*[)\]]/g, '').trim()),
  ]
  for (const candidate of candidates) {
    if (UNITS.has(candidate.toLowerCase())) { context.unit = candidate; break }
  }
  const denominator = /\b[nN]\s*=\s*(\d{1,3}(?:,\d{3})+|\d+)\b/.exec(folded)
  if (denominator) context.denominator = Number(denominator[1].replace(/,/g, ''))
  const timepoint = materialTimepoint(folded, false)
  if (timepoint) context.timepoint = timepoint
  if (/\b(?:n|no\.?|number|count|events?|patients?|subjects?|participants?)\b[^()]{0,40}\(\s*%\s*\)/i.test(folded)) hints.add('count_percent')
  if (/±/.test(folded) || /\(\s*sd\s*\)/i.test(folded)) hints.add('mean_sd')
  if (/\(\s*se\s*\)/i.test(folded)) hints.add('mean_se')
  if (/^\s*p(?![a-z])/i.test(folded) || /\bp[\s-]*value\b/i.test(folded) || /\bp\s+for\b/i.test(folded)) hints.add('p_value')
  const level = /\b(\d{2})\s*%\s*(?:ci|cri)\b/i.exec(folded)
  if (level) context.ciLevel = Number(level[1])
  // "n (%)" says what the cells are (a count and its percentage), not that a count is measured in percent.
  if (hints.has('count_percent') && context.unit === '%') delete context.unit
  return context
}

/** @type {Record<string, string>} */
const TIMEPOINT_UNITS = { week: 'week', weeks: 'week', wk: 'week', w: 'week', day: 'day', days: 'day', d: 'day', month: 'month', months: 'month', mo: 'month', m: 'month', year: 'year', years: 'year', yr: 'year', y: 'year', visit: 'visit', cycle: 'cycle' }
/** @type {Record<string, string>} */
const CJK_TIME_UNITS = { 周: 'week', 天: 'day', 日: 'day', 月: 'month', 年: 'year' }

/**
 * A timepoint in a closed format: `Baseline`, `Week 12`, `W12`, `Day 28`, `12 weeks`,
 * `第 12 周`. Anchored (the whole text is the timepoint) for a row label, found
 * anywhere for a header.
 * @param {string} text @param {boolean} anchored
 * @returns {Record<string, any> | null}
 */
export function materialTimepoint(text, anchored) {
  const value = text.normalize('NFKC').trim()
  /** @param {string} pattern */
  const wrap = (pattern) => new RegExp(anchored ? `^${pattern}$` : `\\b${pattern}\\b`, 'i')
  if (anchored ? /^(?:baseline|screening|bl)$/i.test(value) : /\b(?:baseline|screening)\b/i.test(value)) return { kind: 'baseline' }
  const word = wrap(String.raw`(week|weeks|wk|day|days|month|months|mo|year|years|yr|visit|cycle)\s*(\d{1,3})`).exec(value)
  if (word) return { unit: TIMEPOINT_UNITS[word[1].toLowerCase()], n: Number(word[2]) }
  const leading = wrap(String.raw`(\d{1,3})[\s-]*(weeks?|days?|months?|years?)`).exec(value)
  if (leading) return { unit: TIMEPOINT_UNITS[leading[2].toLowerCase()], n: Number(leading[1]) }
  const short = anchored ? /^([wdmy])\s*(\d{1,3})$/i.exec(value) : null
  if (short) return { unit: TIMEPOINT_UNITS[short[1].toLowerCase()], n: Number(short[2]) }
  const cjk = new RegExp(anchored ? String.raw`^第?\s*(\d{1,3})\s*([周天日月年])$` : String.raw`第?\s*(\d{1,3})\s*([周天日月年])`).exec(value)
  if (cjk) return { unit: CJK_TIME_UNITS[cjk[2]], n: Number(cjk[1]) }
  if (anchored ? /^基线$/.test(value) : /基线/.test(value)) return { kind: 'baseline' }
  return null
}

const TABLE_LABEL = /^[\s*_#>]*((?:(?:supplementary|supplemental|extended data|online|appendix)\s+)?(?:table|tab\.)\s*[A-Za-z]?\d+[A-Za-z]?|e-?table\s*\d+[A-Za-z]?|(?:附)?表\s*[A-Za-z]?\d+[A-Za-z]?)(?=$|[\s.:：．|\-–—*_)）])/i
const FIGURE_LABEL = /^[\s*_#>]*((?:(?:supplementary|supplemental|extended data|online)\s+)?(?:figure|fig\.?)\s*[A-Za-z]?\d+[A-Za-z]?|e-?figure\s*\d+[A-Za-z]?|(?:附)?图\s*[A-Za-z]?\d+[A-Za-z]?)(?=$|[.:：．|\-–—*_)）])/i
const CONTINUED_MARK = /\(\s*(?:continued|cont\.?|续)\s*\)|续表|\bcontinued\b/i
const PAGE_FOOTER = /^\s*(?:[-–—]\s*)?(?:(?:page|p\.|第)\s*)?\d{1,4}\s*(?:\/|of|页)?\s*(?:\d{1,4})?\s*(?:页)?(?:\s*[-–—])?\s*$/i

/** A caption's label when the line is a caption in a closed format. @param {string} line @param {RegExp} pattern */
function captionLabel(line, pattern) {
  const found = pattern.exec(line)
  return found ? found[1].trim() : null
}

/** A label in the form a comparison reads: lower-case letters and digits. @param {string} label */
export function materialLabelKey(label) { return materialSkeleton(label).replace(/^(?:supplementary|supplemental)/, 's') }

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const INT = String.raw`\d{1,3}(?:,\d{3})+|\d+`
const NUM = String.raw`[+\-−]?(?:(?:${INT})(?:[.·]\d+)?|\.\d+)`
const SEP = String.raw`(?:\s*(?:–|—|~|∼|至|;|,)\s*|\s+to\s+|\s+-\s+)`
/** Between two bare numbers a comma may be a decimal comma and a hyphen a sign or an id: only a dash, a tilde, 至 or "to" is an interval. */
const SEP_BARE = String.raw`(?:\s*(?:–|—|~|∼|至)\s*|\s+to\s+|\s+-\s+)`
const PATTERNS = {
  fractionPercent: new RegExp(String.raw`^(${INT})\s*/\s*(${INT})\s*[(\[]\s*(${NUM})\s*%?\s*[)\]]$`),
  fraction: new RegExp(String.raw`^(${INT})\s*/\s*(${INT})$`),
  estimateInterval: new RegExp(String.raw`^(${NUM})\s*%?\s*[(\[]\s*(${NUM})\s*%?${SEP}(${NUM})\s*%?\s*[)\]]$`),
  parenPair: new RegExp(String.raw`^(${NUM})\s*[(\[]\s*(${NUM})\s*(%?)\s*[)\]]$`),
  meanSd: new RegExp(String.raw`^(${NUM})\s*±\s*(${NUM})$`),
  interval: new RegExp(String.raw`^(${NUM})\s*%?${SEP_BARE}(${NUM})\s*%?$`),
  percent: new RegExp(String.raw`^(${NUM})\s*%$`),
  number: new RegExp(String.raw`^(${NUM})$`),
  groupSize: new RegExp(String.raw`^n\s*=\s*(${INT})$`, 'i'),
  bound: new RegExp(String.raw`^([<>≤≥]|<=|>=)\s*(${NUM})\s*(%?)$`),
  pValue: new RegExp(String.raw`^p\s*([<>=≤≥]|<=|>=)?\s*(${NUM})$`, 'i'),
}
const MISSING = /^(?:n\/?a|n\.a\.|nr|ne|nc|nd|‒|–|—|-|…|\.{3}|\/|not reported|not applicable|not estimable|未报告|不适用|未提供)$/i

/** @param {string} token @returns {number} */
function toNumber(token) { return Number(token.replace(/−/g, '-').replace(/,/g, '').replace(/·/g, '.')) }
/** @param {string} token */
function decimalsOf(token) { return /[.·](\d+)$/.exec(token.trim())?.[1].length ?? 0 }
const ROUNDING_EPSILON = 1e-9

/**
 * Whether a reported percentage is the one its count and denominator give, to
 * the rounding its own decimals allow.
 * @param {number} count @param {number} denominator @param {number} reported @param {string} reportedToken
 * @returns {{ computed: number, consistent: boolean } | null}
 */
function percentCheck(count, denominator, reported, reportedToken) {
  if (!(denominator > 0) || count < 0) return null
  const computed = (100 * count) / denominator
  const tolerance = 0.5 * 10 ** -decimalsOf(reportedToken) + ROUNDING_EPSILON
  return { computed: Math.round(computed * 10_000) / 10_000, consistent: Math.abs(computed - reported) <= tolerance }
}

/** Kinds whose header denominator is a fact about them. */
const DENOMINATOR_KINDS = new Set(['count_percent', 'paren_pair'])
/** Kinds an interval level applies to. */
const LEVEL_KINDS = new Set(['estimate_interval', 'interval'])
/** Kinds a header's unit describes: a measurement. A percent, a count with its percent and a p-value carry their own. */
const UNIT_KINDS = new Set(['number', 'mean_sd', 'interval', 'estimate_interval', 'paren_pair', 'bound'])

/**
 * A parsed value with what its header and row state about it: the unit, the
 * header's denominator, the timepoint. Absent where nothing was stated.
 * @param {Record<string, any>} value @param {HeaderContext} context @param {Record<string, any> | null} rowTimepoint
 */
function withContext(value, context, rowTimepoint) {
  const timepoint = rowTimepoint ?? context.timepoint
  return {
    ...value,
    ...(context.unit && UNIT_KINDS.has(value.kind) && value.unit === undefined ? { unit: context.unit } : {}),
    ...(Number.isSafeInteger(context.denominator) && DENOMINATOR_KINDS.has(value.kind) && value.denominator === undefined
      ? { denominator: { n: context.denominator, basis: 'header' } } : {}),
    ...(context.ciLevel && LEVEL_KINDS.has(value.kind) && value.level === undefined ? { level: context.ciLevel } : {}),
    ...(timepoint && value.timepoint === undefined ? { timepoint } : {}),
  }
}

/**
 * A cell's context: its column's header and its row's label. The statistic a
 * row reports ("mean (SD)", "n (%)") and its unit usually sit in the row label,
 * the group and its N in the column header; both are stated, so both apply. The
 * row's own unit wins over the column's, and the header's denominator over the row's.
 * @param {HeaderContext} column @param {HeaderContext | null} row @returns {HeaderContext}
 */
function mergeContexts(column, row) {
  // A column that is its own statistic (a p-value, an interval at a level) does not take the row's.
  if (!row || column.ciLevel || column.hints?.has('p_value')) return column
  return {
    unit: row.unit ?? column.unit,
    denominator: column.denominator ?? row.denominator,
    timepoint: column.timepoint,
    ciLevel: column.ciLevel ?? row.ciLevel,
    hints: new Set([...(column.hints ?? []), ...(row.hints ?? [])]),
  }
}

/**
 * Parse one cell by the closed formats, in the context its header and row give.
 * Returns the typed value (`value: null` for text), or `undefined` for an empty
 * cell. Unknown stays unknown: a field is present only when the cell or its
 * header stated it.
 * @param {string} cellText
 * @param {HeaderContext} [context]
 * @param {Record<string, any> | null} [rowTimepoint]
 * @returns {{ value: Record<string, any> | null, markers: string[], core: string } | undefined}
 */
export function parseMaterialCell(cellText, context = {}, rowTimepoint = null) {
  const raw = cellText.replace(/\\\|/g, '|').trim()
  if (!raw) return undefined
  const { core: marked, markers } = materialCellMarkers(raw)
  // The parser may emit the four HTML entities Markdown text needs; they are decoded, nothing else is.
  const core = marked.normalize('NFKC').replace(/\\\*/g, '*').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').trim()
  const hints = context.hints ?? new Set()
  /** @param {Record<string, any> | null} value */
  const result = (value) => ({ value: value ? withContext(value, context, rowTimepoint) : null, markers, core })
  if (!core) return result(null)
  if (MISSING.test(core)) return { value: { kind: 'missing', mark: core }, markers, core }
  let match = PATTERNS.fractionPercent.exec(core)
  if (match) {
    const [n, N, p] = [toNumber(match[1]), toNumber(match[2]), toNumber(match[3])]
    const check = percentCheck(n, N, p, match[3])
    return result({ kind: 'fraction_percent', n, N, percent: p, denominator: { n: N, basis: 'cell' }, ...(check ? { percentCheck: check } : {}) })
  }
  // A date is a typed cell and not a value; a group size ("n = 45") is a count that says what it is.
  if (/^\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?$/.test(core)) return { value: { kind: 'date', text: core }, markers, core }
  match = PATTERNS.groupSize.exec(core)
  if (match) return result({ kind: 'number', x: toNumber(match[1]), quantity: 'n' })
  match = PATTERNS.fraction.exec(core)
  if (match) return result({ kind: 'fraction', n: toNumber(match[1]), N: toNumber(match[2]), denominator: { n: toNumber(match[2]), basis: 'cell' } })
  match = PATTERNS.estimateInterval.exec(core)
  if (match) return result({ kind: 'estimate_interval', estimate: toNumber(match[1]), lower: toNumber(match[2]), upper: toNumber(match[3]) })
  match = PATTERNS.parenPair.exec(core)
  if (match) {
    const lead = toNumber(match[1])
    const inner = toNumber(match[2])
    const denominator = Number.isSafeInteger(context.denominator) ? /** @type {number} */ (context.denominator) : null
    if (hints.has('count_percent') || match[3] === '%') {
      const check = denominator ? percentCheck(lead, denominator, inner, match[2]) : null
      return result({ kind: 'count_percent', n: lead, percent: inner, ...(check ? { percentCheck: check } : {}) })
    }
    if (hints.has('mean_sd')) return result({ kind: 'mean_sd', mean: lead, sd: inner })
    if (hints.has('mean_se')) return result({ kind: 'mean_sd', mean: lead, se: inner })
    // The meaning of the parenthesis is not stated, so it stays a pair; the
    // arithmetic against the header's denominator is a fact recorded beside it.
    const implied = denominator ? percentCheck(lead, denominator, inner, match[2]) : null
    return result({ kind: 'paren_pair', lead, inner, ...(implied ? { asPercentOfDenominator: implied } : {}) })
  }
  match = PATTERNS.meanSd.exec(core)
  if (match) return result({ kind: 'mean_sd', mean: toNumber(match[1]), sd: toNumber(match[2]) })
  match = PATTERNS.pValue.exec(core)
  if (match) return result({ kind: 'p_value', operator: match[1] ?? '=', p: toNumber(match[2]) })
  match = PATTERNS.bound.exec(core)
  if (match) {
    return hints.has('p_value') && !match[3]
      ? result({ kind: 'p_value', operator: match[1], p: toNumber(match[2]) })
      : result({ kind: 'bound', operator: match[1], x: toNumber(match[2]), ...(match[3] ? { percent: true } : {}) })
  }
  match = PATTERNS.interval.exec(core)
  if (match && !PATTERNS.number.test(core)) return result({ kind: 'interval', lower: toNumber(match[1]), upper: toNumber(match[2]) })
  match = PATTERNS.percent.exec(core)
  if (match) return result({ kind: 'percent', x: toNumber(match[1]) })
  match = PATTERNS.number.exec(core)
  if (match) {
    const x = toNumber(match[1])
    return hints.has('p_value') && x >= 0 && x <= 1 ? result({ kind: 'p_value', operator: '=', p: x }) : result({ kind: 'number', x })
  }
  return result(null)
}

/**
 * A cell that starts like a number but fits no closed format is counted, never
 * claimed. An identifier that merely contains digits ("S001") is a label.
 * @param {string} text
 */
const looksNumeric = (text) => /^[([<>≤≥~≈+\-−±]?\s*\.?\d/.test(materialCellMarkers(text).core.normalize('NFKC'))

// ---------------------------------------------------------------------------
// Markdown tables
// ---------------------------------------------------------------------------

/**
 * One Markdown table's cells, typed, with the relations its header gives.
 * @param {{ s: number, e: number, t: string }[][]} rows row 0 is the header
 */
function buildMarkdownCells(rows) {
  const [headerRow, ...bodyRows] = rows
  const header = headerRow.map((cell, index) => ({ c: index + 1, t: cell.t, s: cell.s, e: cell.e }))
  const contexts = headerRow.map((cell) => materialHeaderContext(cell.t))
  /** @type {MaterialCell[]} */
  const cells = []
  /** @type {Set<string>} */
  const markersUsed = new Set()
  let unextracted = 0
  let beyondLimit = 0
  /** @type {{ rows: number, of: number } | null} */
  let truncated = null
  let budget = SOURCE_MATERIAL_LIMITS.maxCellsPerTable
  /** @param {{ s: number, e: number, t: string }} cell @param {number} r @param {number} c @param {Record<string, any> | null} value @param {string[]} markers */
  const entry = (cell, r, c, value, markers) => {
    /** @type {MaterialCell} */
    const made = { r, c, t: cell.t.slice(0, SOURCE_MATERIAL_LIMITS.maxCellChars), s: cell.s, e: cell.e }
    if (cell.t.length > SOURCE_MATERIAL_LIMITS.maxCellChars) made.truncated = true
    if (markers.length) { made.fn = markers; for (const marker of markers) markersUsed.add(marker) }
    if (value) made.v = value
    return made
  }
  for (let c = 0; c < headerRow.length; c += 1) {
    if (!headerRow[c].t) continue
    cells.push(entry(headerRow[c], 1, c + 1, null, materialCellMarkers(headerRow[c].t).markers))
    budget -= 1
  }
  for (let index = 0; index < bodyRows.length; index += 1) {
    const row = bodyRows[index]
    const label = row[0]?.t ?? ''
    const labelCore = label ? materialCellMarkers(label).core : ''
    const rowTimepoint = labelCore ? materialTimepoint(labelCore, true) : null
    const rowContext = labelCore ? materialHeaderContext(labelCore) : null
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c]
      if (!cell.t) continue
      if (budget <= 0) {
        // Past the cap a cell is not typed, only counted when it starts like a number.
        truncated ??= { rows: index, of: bodyRows.length }
        if (looksNumeric(cell.t)) beyondLimit += 1
        continue
      }
      const column = c + 1
      // The first column is the row label by convention (stated on the table as
      // `labelColumn`); a label is not a value.
      const parsed = column === 1 && row.length > 1 ? null : parseMaterialCell(cell.t, mergeContexts(contexts[c] ?? { hints: new Set() }, rowContext), rowTimepoint)
      const markers = parsed ? parsed.markers : materialCellMarkers(cell.t).markers
      if (!parsed?.value && parsed && looksNumeric(parsed.core)) unextracted += 1
      cells.push(entry(cell, index + 2, column, parsed?.value ?? null, markers))
      budget -= 1
    }
  }
  return { cells, header, unextracted: unextracted + beyondLimit, markersUsed, truncated }
}

/**
 * Footnote lines beneath a table, with the marker each begins with. A plain
 * letter counts as a marker only when a cell of the table carries it; a symbol
 * marker counts whenever a line begins with it.
 * @param {{ start: number, end: number, text: string }[]} lines @param {number} after first line after the table
 * @param {Set<string>} used
 */
function footnotesAfter(lines, after, used) {
  /** @type {{ marker: string, text: string, start: number, end: number }[]} */
  const notes = []
  /** @type {{ text: string, start: number, end: number }[]} */
  const tableNotes = []
  let index = after
  if (index < lines.length && blank(lines[index].text)) index += 1
  for (; index < lines.length && notes.length + tableNotes.length < SOURCE_MATERIAL_LIMITS.maxFootnotesPerTable; index += 1) {
    const line = lines[index]
    if (blank(line.text)) break
    const body = line.text.trim()
    const offset = line.start + line.text.indexOf(body)
    const lead = /^(?:<sup>\s*([^<]{1,6}?)\s*<\/sup>|\^([A-Za-z0-9*†‡§¶‖]{1,6})\^|([*†‡§¶‖]+)|([a-z])(?:[.)]\s*|\s+)(?=[A-Z0-9([])|\(([a-z])\)\s*|([¹²³⁴⁵⁶⁷⁸⁹⁰ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏ]+)\s*)/.exec(body)
    if (lead) {
      const explicit = lead[1] ?? lead[2] ?? lead[3] ?? (lead[6] ? [...lead[6]].map((character) => SUPERSCRIPTS[character] ?? character).join('') : undefined)
      const marker = explicit ?? lead[4] ?? lead[5]
      if (marker && (explicit !== undefined || used.has(marker))) {
        notes.push({ marker, text: body.slice(lead[0].length).trim().slice(0, 600), start: offset, end: line.end })
        continue
      }
    }
    if (/^(?:notes?|abbreviations?|source|data are|data presented|values are|values shown|注|备注)\s*[:：.]?/i.test(body)) {
      tableNotes.push({ text: body.slice(0, 600), start: offset, end: line.end })
      continue
    }
    break
  }
  return { notes, tableNotes }
}

/**
 * Every table, figure and supplement reference in a document's text, from the
 * parser's Markdown. Pure: the same text gives the same structure, with offsets
 * into the capture text (`materialCaptureText`).
 *
 * @param {{ text: unknown }} input
 * @returns {{ text: string, tables: MaterialTable[], figures: Record<string, any>[], supplements: Record<string, any>[], limits: string[] }}
 */
export function deriveMarkdownStructure({ text: rawText }) {
  const text = materialCaptureText(rawText)
  const lines = linesOf(text)
  /** @type {string[]} */
  const limits = []
  /** @type {MaterialTable[]} */
  const tables = []
  /** @type {Record<string, any>[]} */
  const figures = []
  let inFence = false
  let fence = ''
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const fenced = /^\s*(`{3,}|~{3,})/.exec(line.text)
    if (fenced) {
      if (!inFence) { inFence = true; fence = fenced[1][0] } else if (fenced[1][0] === fence) inFence = false
      continue
    }
    if (inFence) continue
    // An HTML table is not read: its spans are exactly what Markdown cannot say.
    // The unit is recorded, as unextracted, with the digits it held.
    if (/<table[\s>]/i.test(line.text)) {
      let j = i
      while (j < lines.length && !/<\/table\s*>/i.test(lines[j].text)) j += 1
      const last = Math.min(j, lines.length - 1)
      const block = text.slice(line.start, lines[last].end)
      const digits = [...block.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].filter((cell) => looksNumeric(cell[1])).length
      tables.push({ kind: 'table', status: 'unextracted', reason: 'html_table', start: line.start, end: lines[last].end, firstLine: i, lastLine: last, region: SOURCE_MATERIAL_REGION_UNKNOWN, valueCandidates: digits })
      i = last
      continue
    }
    if (!hasPipe(line.text) || i + 1 >= lines.length || !hasPipe(lines[i + 1].text)) continue
    const headerCells = splitRow(text, line.start, line.end)
    const delimiter = splitRow(text, lines[i + 1].start, lines[i + 1].end)
    if (!isDelimiterRow(delimiter)) {
      // Rows with no header above them: a table that went on past a page break
      // without repeating its header. They cannot be read (what a column holds is
      // not stated), so they are one unextracted unit with the digits they hold,
      // and the continuation pass says what they may continue.
      if (headerCells.length < 2 || splitRow(text, lines[i + 1].start, lines[i + 1].end).length < 2) continue
      let last = i + 1
      while (last + 1 < lines.length && !blank(lines[last + 1].text) && hasPipe(lines[last + 1].text)) last += 1
      let digits = 0
      for (let k = i; k <= last; k += 1) for (const cell of splitRow(text, lines[k].start, lines[k].end)) if (looksNumeric(cell.t)) digits += 1
      tables.push({ kind: 'table', status: 'unextracted', reason: 'headerless_rows', start: line.start, end: lines[last].end, firstLine: i, lastLine: last,
        region: SOURCE_MATERIAL_REGION_UNKNOWN, columns: headerCells.length, valueCandidates: digits })
      i = last
      continue
    }
    let last = i + 1
    while (last + 1 < lines.length && !blank(lines[last + 1].text) && hasPipe(lines[last + 1].text)) last += 1
    const start = line.start
    const end = lines[last].end
    if (headerCells.length !== delimiter.length) {
      tables.push({ kind: 'table', status: 'unextracted', reason: 'invalid_table', start, end, firstLine: i, lastLine: last, valueCandidates: 0 })
      i = last
      continue
    }
    if (tables.length >= SOURCE_MATERIAL_LIMITS.maxTables) {
      if (!limits.includes('table_limit')) limits.push('table_limit')
      let digits = 0
      for (let k = i + 2; k <= last; k += 1) for (const cell of splitRow(text, lines[k].start, lines[k].end)) if (looksNumeric(cell.t)) digits += 1
      tables.push({ kind: 'table', status: 'unextracted', reason: 'table_limit', start, end, firstLine: i, lastLine: last, valueCandidates: digits })
      i = last
      continue
    }
    const rows = [headerCells]
    for (let k = i + 2; k <= last; k += 1) rows.push(splitRow(text, lines[k].start, lines[k].end))
    try {
      const built = buildMarkdownCells(rows)
      if (built.truncated && !limits.includes('cell_limit')) limits.push('cell_limit')
      tables.push({
        kind: 'table', status: 'structured', start, end, firstLine: i, lastLine: last, region: SOURCE_MATERIAL_REGION_UNKNOWN,
        rows: rows.length, columns: headerCells.length, labelColumn: 1,
        // What Markdown cannot say stays unknown on the record rather than absent.
        spans: 'unknown', headerLevels: 'unknown', header: built.header, cells: built.cells,
        unextracted: built.unextracted, ...(built.truncated ? { truncated: built.truncated } : {}),
        raggedRows: rows.slice(1).filter((row) => row.length !== headerCells.length).length,
        markersUsed: built.markersUsed,
      })
    } catch {
      tables.push({ kind: 'table', status: 'unextracted', reason: 'derivation_failed', start, end, firstLine: i, lastLine: last, valueCandidates: 0 })
    }
    i = last
  }

  // Caption, heading, adjacent text and footnotes: the lines next to each table.
  // A caption line above a table is that table's; a caption below one is claimed
  // only when no other table already owns the line.
  /** @type {Set<number>} */
  const claimed = new Set()
  for (const [index, table] of tables.entries()) {
    table.index = index + 1
    table.id = `tbl-${index + 1}`
    let before = table.firstLine - 1
    let skipped = 0
    while (before >= 0 && blank(lines[before].text) && skipped < 2) { before -= 1; skipped += 1 }
    if (before >= 0 && !blank(lines[before].text) && !hasPipe(lines[before].text)) {
      // A caption may wrap: walk up while the lines above are not blank.
      let top = before
      while (top - 1 >= 0 && !blank(lines[top - 1].text) && !hasPipe(lines[top - 1].text) && before - top < 4) top -= 1
      let found = null
      for (let k = top; k <= before && !found; k += 1) {
        const label = captionLabel(lines[k].text, TABLE_LABEL)
        if (label) found = { k, label }
      }
      if (found) {
        const body = lines.slice(found.k, before + 1).map((entry) => entry.text.trim()).join(' ').slice(0, SOURCE_MATERIAL_LIMITS.maxCaptionChars)
        table.caption = { label: found.label, text: body, placement: 'before', start: lines[found.k].start, end: lines[before].end }
        for (let k = found.k; k <= before; k += 1) claimed.add(k)
      } else {
        const heading = /^(#{1,6})\s+(.+)$/.exec(lines[before].text.trim())
        const body = lines[before].text.trim()
        if (heading) table.heading = { level: heading[1].length, text: heading[2].trim().slice(0, 300), start: lines[before].start, end: lines[before].end }
        else if (body.length <= 300) table.adjacent = { text: body, start: lines[before].start, end: lines[before].end }
      }
    }
  }
  for (const table of tables) {
    let footnoteFrom = table.lastLine + 1
    if (!table.caption) {
      let after = table.lastLine + 1
      if (after < lines.length && blank(lines[after].text)) after += 1
      const label = after < lines.length && !claimed.has(after) ? captionLabel(lines[after].text, TABLE_LABEL) : null
      if (label) {
        table.caption = { label, text: lines[after].text.trim().slice(0, SOURCE_MATERIAL_LIMITS.maxCaptionChars), placement: 'after', start: lines[after].start, end: lines[after].end }
        footnoteFrom = after + 1
      }
    }
    if (table.status === 'structured') {
      const { notes, tableNotes } = footnotesAfter(lines, Math.min(footnoteFrom, lines.length), table.markersUsed)
      table.footnotes = notes.map((note) => ({
        ...note, cells: table.cells.filter((/** @type {MaterialCell} */ cell) => cell.fn?.includes(note.marker)).map((/** @type {MaterialCell} */ cell) => `${cell.r}:${cell.c}`),
      }))
      table.notes = tableNotes
      table.orphanMarkers = [...table.markersUsed].filter((marker) => !notes.some((note) => note.marker === marker))
      table.orphanNotes = table.footnotes.filter((/** @type {{ cells: string[] }} */ note) => note.cells.length === 0).length
    }
  }

  // A second table with the same header, beside the first with nothing between
  // but a page footer, is possibly its continuation; only the text can say so.
  for (let index = 1; index < tables.length; index += 1) {
    const previous = tables[index - 1]
    const table = tables[index]
    if (previous.status !== 'structured' || (table.status !== 'structured' && table.reason !== 'headerless_rows')) continue
    const gap = lines.slice(previous.lastLine + 1, table.firstLine).map((entry) => entry.text.trim()).filter(Boolean)
    if (gap.length > 6) continue
    const marked = Boolean(table.caption && CONTINUED_MARK.test(table.caption.text))
      || gap.some((entry) => entry.length <= 120 && CONTINUED_MARK.test(entry))
    // Rows with no header can only be the same width as the table above them.
    const sameHeader = table.reason !== 'headerless_rows' && previous.columns === table.columns
      && previous.header.every((/** @type {{ t: string }} */ cell, /** @type {number} */ position) => materialSkeleton(cell.t) === materialSkeleton(table.header[position].t))
    const quiet = gap.length <= 3 && gap.every((entry) => PAGE_FOOTER.test(entry) || (entry.length <= 120 && (CONTINUED_MARK.test(entry) || TABLE_LABEL.test(entry))))
    if (marked) table.continuation = { prior: previous.id, basis: 'caption_marker', certainty: sameHeader ? 'stated' : 'ambiguous' }
    else if (sameHeader && quiet) table.continuation = { prior: previous.id, basis: 'same_header', certainty: 'ambiguous' }
    else if (table.reason === 'headerless_rows' && table.columns === previous.columns && quiet) table.continuation = { prior: previous.id, basis: 'same_columns', certainty: 'ambiguous' }
    if (table.continuation) previous.continuedBy = table.id
  }

  // Figures: a caption in a closed format, or an image reference.
  for (let i = 0; i < lines.length && figures.length < SOURCE_MATERIAL_LIMITS.maxFigures; i += 1) {
    const line = lines[i]
    const label = captionLabel(line.text, FIGURE_LABEL)
    const image = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(line.text)
    if (!label && !image) continue
    let last = i
    while (last + 1 < lines.length && !blank(lines[last + 1].text) && !hasPipe(lines[last + 1].text) && last - i < 4) last += 1
    const caption = label ? lines.slice(i, last + 1).map((entry) => entry.text.trim()).join(' ').slice(0, SOURCE_MATERIAL_LIMITS.maxCaptionChars) : null
    figures.push({
      kind: 'figure', index: figures.length + 1, id: `fig-${figures.length + 1}`,
      ...(label ? { label, caption: { text: caption, start: line.start, end: lines[last].end } } : {}),
      ...(image ? { image: { alt: image[1].slice(0, 300), ref: image[2].slice(0, 300) } } : {}),
      start: line.start, end: lines[last].end, region: SOURCE_MATERIAL_REGION_UNKNOWN,
      // No digitization here: what a figure plots is unknown, said so, and a
      // value later read off it carries the origin `graph_estimated`.
      axes: { status: 'unknown', reason: 'no_digitization' }, values: { status: 'unknown', reason: 'no_digitization' },
    })
    i = last
  }

  const supplements = supplementReferences(text, tables)
  for (const table of tables) {
    delete table.firstLine
    delete table.lastLine
    delete table.markersUsed
  }
  return { text, tables, figures, supplements, limits }
}

const SUPPLEMENT_REFERENCE = new RegExp(String.raw`(?:\b(?:Supplementa(?:ry|l)|Extended Data|Online|Additional)\s+(?:Table|Figure|Fig\.?|Material|Methods?|Data|File|Appendix)s?\s*[A-Za-z]?\d*[A-Za-z]?\b|\b(?:Table|Fig(?:ure)?)s?\.?\s+S\d+[A-Za-z]?\b|\be-?(?:Table|Figure)\s*\d+[A-Za-z]?\b|\bAppendix\s+[A-Z0-9]\b|附表\s*\d+|补充(?:材料|表|图)\s*\d*)`, 'g')

/**
 * Where the text points at supplementary material. A reference that names a
 * table the document itself holds is linked to it; every other one stays
 * unlinked, with the reason, because no attached file is known to the document.
 * @param {string} text @param {MaterialTable[]} tables
 */
function supplementReferences(text, tables) {
  /** @type {Map<string, Record<string, any>>} */
  const found = new Map()
  for (const match of text.matchAll(SUPPLEMENT_REFERENCE)) {
    if (found.size >= SOURCE_MATERIAL_LIMITS.maxSupplements) break
    const label = match[0].trim()
    const key = materialLabelKey(label)
    if (!key || found.has(key)) continue
    const own = tables.find((table) => table.caption?.label && materialLabelKey(table.caption.label) === key)
    // A link the document prints in the same line is the supplement's address, as printed; it is not fetched or trusted here.
    const lineEnd = text.indexOf('\n', match.index)
    const href = /https?:\/\/[^\s)>\]"']+/.exec(text.slice(match.index, lineEnd < 0 ? text.length : lineEnd))?.[0]
    found.set(key, {
      label, start: match.index, end: match.index + match[0].length, ...(href ? { href: href.replace(/[.,;]+$/, '').slice(0, 300) } : {}),
      kind: /fig|图/i.test(label) ? 'figure' : /table|表/i.test(label) ? 'table' : /appendix/i.test(label) ? 'appendix' : 'material',
      ...(own ? { linked: { tableId: own.id } } : { linked: 'unknown', reason: 'supplement_not_attached' }),
    })
  }
  return [...found.values()]
}

// ---------------------------------------------------------------------------
// Delimited text and spreadsheets
// ---------------------------------------------------------------------------

/** A column's letters: 1 is A, 27 is AA. @param {number} column @returns {string} */
export function materialColumnLetters(column) {
  let n = column
  let letters = ''
  while (n > 0) {
    const rest = (n - 1) % 26
    letters = String.fromCharCode(65 + rest) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

/** `B7` from a column and a row. @param {number} column @param {number} row */
export const materialAddress = (column, row) => `${materialColumnLetters(column)}${row}`

/** @param {string} address @returns {{ r: number, c: number } | null} */
export function materialAddressParts(address) {
  const match = /^([A-Za-z]{1,3})([1-9]\d{0,6})$/.exec(address)
  if (!match) return null
  let c = 0
  for (const character of match[1].toUpperCase()) c = c * 26 + (character.charCodeAt(0) - 64)
  return { r: Number(match[2]), c }
}

/**
 * A sheet or delimited file's cells as one table, with the header read as a
 * candidate: the first row, when every cell in it is text and a later row holds
 * a number. A sheet states no header, so the candidate is recorded with its
 * basis and `declared: false`. Header-derived unit, denominator and timepoint are
 * applied to the cells beneath it.
 * @param {{ id: string, name: string | null, kind: 'sheet' | 'delimited', raw: { r: number, c: number, t: string, s?: number, e?: number, pre: Record<string, any> | null, numeric?: boolean, formula?: string }[],
 *   merges?: string[], dimensions?: Record<string, any>, truncated?: { cells: number, of: number } | null, beyond?: number }} input
 * @returns {MaterialTable}
 */
function tableFromCells({ id, name, kind, raw, merges = [], dimensions, truncated = null, beyond = 0 }) {
  const rows = [...new Set(raw.map((cell) => cell.r))].sort((a, b) => a - b)
  const numbered = (/** @type {Record<string, any> | null} */ value) => Boolean(value) && !NON_VALUE_KINDS.has(value?.kind) && value?.kind !== 'p_value'
  const first = raw.filter((cell) => cell.r === rows[0])
  const headerRow = rows.length > 1 && first.length > 0 && first.every((cell) => !cell.pre) && raw.some((cell) => cell.r !== rows[0] && numbered(cell.pre))
    ? rows[0] : null
  /** @type {Map<number, ReturnType<typeof materialHeaderContext>>} */
  const contexts = new Map()
  if (headerRow) for (const cell of raw) if (cell.r === headerRow) contexts.set(cell.c, materialHeaderContext(cell.t))
  /** @type {MaterialCell[]} */
  const cells = raw.map((cell) => {
    const context = contexts.get(cell.c)
    let value = headerRow !== null && cell.r === headerRow ? null : cell.pre
    if (value && context && cell.r !== headerRow) {
      value = cell.numeric ? withContext(value, context, null) : (parseMaterialCell(cell.t, context, null)?.value ?? value)
    }
    return {
      r: cell.r, c: cell.c, a: materialAddress(cell.c, cell.r), t: cell.t.slice(0, SOURCE_MATERIAL_LIMITS.maxCellChars),
      ...(cell.t.length > SOURCE_MATERIAL_LIMITS.maxCellChars ? { truncated: true } : {}),
      ...(Number.isSafeInteger(cell.s) ? { s: cell.s, e: cell.e } : {}),
      ...(value ? { v: value } : {}),
      ...(cell.formula ? { formula: cell.formula.slice(0, 500) } : {}),
    }
  })
  return {
    kind, id, name, status: 'structured', rows: Math.max(0, ...cells.map((cell) => cell.r)), columns: Math.max(0, ...cells.map((cell) => cell.c)),
    cells, ...(dimensions ? { dimensions } : {}), ...(merges.length ? { merges } : {}),
    header: headerRow ? { row: headerRow, basis: 'first_row_text_then_numbers', declared: false } : null,
    spans: kind === 'sheet' ? (merges.length ? 'merged_ranges' : 'none') : 'none', headerLevels: 'unknown',
    unextracted: cells.filter((cell) => !cell.v && cell.formula === undefined && looksNumeric(cell.t) && cell.r !== headerRow).length + beyond,
    ...(truncated ? { truncated } : {}),
  }
}

/**
 * Parse CSV or TSV into cells with exact spans. Quoted fields (RFC 4180) may
 * hold the delimiter, quotes and newlines; a quoted cell's span includes its quotes.
 * @param {{ text: unknown, delimiter?: ',' | '\t' | ';' }} input
 * @returns {{ text: string, tables: MaterialTable[], figures: never[], supplements: never[], limits: string[] }}
 */
export function deriveDelimitedStructure({ text: rawText, delimiter = ',' }) {
  const text = materialCaptureText(rawText)
  /** @type {{ r: number, c: number, t: string, s: number, e: number, pre: Record<string, any> | null }[]} */
  const raw = []
  /** @type {string[]} */
  const limits = []
  let beyond = 0
  let total = 0
  let row = 1
  let column = 1
  let index = 0
  const length = text.length
  for (;;) {
    let start = index
    let value
    let end
    if (text[index] === '"') {
      value = ''
      index += 1
      for (; index < length; index += 1) {
        if (text[index] === '"') {
          if (text[index + 1] === '"') { value += '"'; index += 1; continue }
          index += 1
          break
        }
        value += text[index]
      }
      // Anything between a closing quote and the delimiter stays inside the field's span.
      while (index < length && text[index] !== delimiter && text[index] !== '\n') index += 1
      end = index
    } else {
      while (index < length && text[index] !== delimiter && text[index] !== '\n') index += 1
      end = index
      while (start < end && /\s/.test(text[start])) start += 1
      while (end > start && /\s/.test(text[end - 1])) end -= 1
      value = text.slice(start, end)
    }
    if (value !== '') {
      total += 1
      if (raw.length < SOURCE_MATERIAL_LIMITS.maxCellsPerTable) {
        raw.push({ r: row, c: column, t: value, s: start, e: end, pre: parseMaterialCell(value, {}, null)?.value ?? null })
      } else if (looksNumeric(value)) beyond += 1
    }
    if (index >= length) break
    if (text[index] === '\n') { row += 1; column = 1 } else column += 1
    index += 1
  }
  if (total > raw.length) limits.push('cell_limit')
  if (!raw.length) return { text, tables: [], figures: [], supplements: [], limits }
  const table = tableFromCells({ id: 'tbl-1', name: null, kind: 'delimited', raw, truncated: total > raw.length ? { cells: raw.length, of: total } : null, beyond })
  table.index = 1
  table.start = 0
  table.end = text.length
  return { text, tables: [table], figures: [], supplements: [], limits }
}

/**
 * Cells a spreadsheet reader reported, as tables: each sheet is one, and a
 * cell's address is its sheet address. A value the workbook stores as a number is
 * that number, whatever its display format (kept as `numberFormat`); a text cell
 * goes through the same closed formats as a parsed table cell. A formula keeps
 * its text, and its cached value only when the file holds one — a formula nobody
 * computed has no value here.
 * @param {{ sheets: unknown }} input
 * @returns {{ tables: MaterialTable[], limits: string[] }}
 */
export function deriveSheetStructure({ sheets }) {
  /** @type {MaterialTable[]} */
  const tables = []
  /** @type {string[]} */
  const limits = []
  for (const sheet of (Array.isArray(sheets) ? sheets : []).slice(0, SOURCE_MATERIAL_LIMITS.maxSheets)) {
    const input = Array.isArray(sheet?.cells) ? sheet.cells : []
    // A sheet the reader did not open (its bounding box is too large) is a sheet nobody read: said, not dropped.
    if (sheet?.skipped && !limits.includes('sheet_too_large')) limits.push('sheet_too_large')
    const kept = input.slice(0, SOURCE_MATERIAL_LIMITS.maxCellsPerTable)
    const truncated = input.length > kept.length || Boolean(sheet?.truncated)
    if (truncated && !limits.includes('cell_limit')) limits.push('cell_limit')
    /** @type {{ r: number, c: number, t: string, pre: Record<string, any> | null, numeric?: boolean, formula?: string }[]} */
    const raw = []
    for (const cell of kept) {
      const parts = materialAddressParts(String(cell?.a ?? ''))
      if (!parts) continue
      const formula = typeof cell.f === 'string' && cell.f ? cell.f : undefined
      /** @type {Record<string, any> | null} */
      let pre = null
      let text = ''
      let numeric = false
      if (cell.k === 'n' && typeof cell.v === 'number' && Number.isFinite(cell.v)) {
        pre = { kind: 'number', x: cell.v, ...(cell.nf && cell.nf !== 'General' ? { numberFormat: String(cell.nf).slice(0, 40) } : {}) }
        text = String(cell.v)
        numeric = true
      } else if (cell.k === 'd') { pre = { kind: 'date', x: String(cell.v) }; text = String(cell.v) }
      else if (cell.k === 'b') { pre = { kind: 'boolean', x: Boolean(cell.v) }; text = String(Boolean(cell.v)) }
      else if (cell.k === 'e') { pre = { kind: 'error', code: String(cell.v).slice(0, 20) }; text = String(cell.v) }
      else if (cell.k === 's') { text = String(cell.v ?? ''); pre = parseMaterialCell(text, {}, null)?.value ?? null }
      if (text === '' && !formula) continue
      raw.push({ r: parts.r, c: parts.c, t: text, pre, numeric, ...(formula ? { formula } : {}) })
    }
    if (!raw.length) continue
    const table = tableFromCells({
      id: `sheet-${tables.length + 1}`, name: String(sheet?.name ?? '').slice(0, 120), kind: 'sheet', raw,
      merges: Array.isArray(sheet?.merges) ? sheet.merges.slice(0, 200).map(String) : [],
      dimensions: sheet?.dimensions && typeof sheet.dimensions === 'object' ? sheet.dimensions : undefined,
      truncated: truncated ? { cells: kept.length, of: Number.isSafeInteger(sheet?.totalCells) ? sheet.totalCells : input.length } : null,
      beyond: Number.isSafeInteger(sheet?.beyond) ? sheet.beyond : 0,
    })
    table.index = tables.length + 1
    table.start = null
    table.end = null
    table.sheetState = sheet?.state === 'hidden' || sheet?.state === 'veryHidden' ? sheet.state : 'visible'
    tables.push(table)
  }
  return { tables, limits }
}

/**
 * The cells of a structured table that hold a value: a typed cell that is not a
 * date, a flag, an error or a missing marker, and not a sheet's header row.
 * @param {MaterialTable} table @returns {MaterialCell[]}
 */
export function materialTableValues(table) {
  if (table?.status !== 'structured' || !Array.isArray(table.cells)) return []
  return table.cells.filter((/** @type {MaterialCell} */ cell) => cell.v && !NON_VALUE_KINDS.has(cell.v.kind))
}
