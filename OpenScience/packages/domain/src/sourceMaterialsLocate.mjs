/**
 * Where a structured unit is: its page, resolved from the document's own bytes,
 * and the ledger that says how many of a source's values were located, ambiguous,
 * unlocated, unextracted or failed.
 *
 * Hidden knowledge: the in-house parser sends no pages, no regions and no boxes
 * (see `sourceMaterials.mjs`). For a PDF the platform holds the original bytes,
 * so a page is found the only way it can be found without the parser's help:
 * each row of each table is looked up in the PDF's own text layer, page by page,
 * by the letters and digits it carries (`materialSkeleton`). The rule is the
 * brief's, and it has no cleverness in it:
 *
 * - a row found on exactly one page is on that page (`located`);
 * - a row found on several pages is `ambiguous`, with the candidates — never
 *   narrowed by the order of the document, because nothing here proves the
 *   parser kept that order;
 * - a row found nowhere is `unknown`, with the reason: the document has pages
 *   with no text layer (a scan — the parser read those by OCR), or the text just
 *   does not match.
 *
 * A region (bounding box) is unknown for every unit; this module never writes
 * one. Nothing here is a judgment about whether a value is right: a located
 * value is a value with a place, and "source links alone do not establish
 * correct extraction" (plan §11.3 N02).
 *
 * @module @evimed/domain/source-materials-locate
 */
import {
  SOURCE_MATERIALS_EXTRACTOR,
  SOURCE_MATERIALS_VERSION,
  deriveMarkdownStructure,
  materialCaptureText,
  materialSkeleton,
  materialTableValues,
} from './sourceMaterials.mjs'

export const SOURCE_MATERIAL_LOCATION_STATUSES = Object.freeze(['located', 'ambiguous', 'unknown'])
/** Why a unit's page is unknown. A reason is a fact about this document or this deployment, never a verdict on the unit. */
export const SOURCE_MATERIAL_PAGE_UNKNOWN_REASONS = Object.freeze([
  'format_without_page_source', 'locator_unavailable', 'locator_failed', 'source_too_large', 'no_text_layer',
  'no_match', 'too_short', 'locator_budget', 'not_requested',
])
/** What the page job measured of a document. `mapped`: pages were read and at least one has a text layer. */
export const SOURCE_MATERIAL_PAGES_STATUSES = Object.freeze(['mapped', 'no_text_layer', 'unavailable', 'not_paginated', 'failed'])
export const SOURCE_MATERIAL_COVERAGE_STATUSES = Object.freeze(['extracted', 'partial', 'unavailable', 'failed'])

export const SOURCE_LOCATE_LIMITS = Object.freeze({
  /** Rows looked up across all pages, per source: each row is one substring search per page. */
  maxRowChecks: 30_000,
  /** A row whose letters and digits come to fewer than this is too short to place. */
  minRowNeedle: 4,
  /** A cell shorter than this does not count towards the cell-level match. */
  minCellNeedle: 2,
  minCaptionNeedle: 12,
})

/** @typedef {{ status: 'located' | 'ambiguous' | 'unknown', pages?: number[], candidates?: number[], basis?: string, reason?: string }} MaterialPage */
/** @typedef {{ page: number, text: string, hasTextLayer?: boolean }} PdfPageText */

/**
 * The page of one row, from a table's run-length `rowPages`.
 * @param {Record<string, any>} table @param {number} row @returns {MaterialPage}
 */
export function materialRowPage(table, row) {
  for (const run of Array.isArray(table?.rowPages) ? table.rowPages : []) {
    if (row >= run.from && row <= run.to) {
      const { from: _from, to: _to, ...page } = run
      return /** @type {MaterialPage} */ (page)
    }
  }
  return { status: 'unknown', reason: table?.page?.reason ?? 'not_requested' }
}

/** @param {number[]} values */
const uniqueSorted = (values) => [...new Set(values)].sort((a, b) => a - b)

/**
 * Locate every structured unit on the PDF's own pages.
 *
 * @param {{ tables: Record<string, any>[], figures?: Record<string, any>[], pages: PdfPageText[], pageCount?: number }} input
 *   `pageCount` is the document's page count when the text of fewer pages was read: a unit found nowhere then may be on a page nobody read.
 * @returns {{ tables: Record<string, any>[], figures: Record<string, any>[], info: { status: string, pageCount: number, textLayerPages: number, noTextLayerPages: number[], rowChecks: number, budgetSpent: boolean } }}
 */
export function locateUnitsOnPages({ tables, figures = [], pages, pageCount = pages.length }) {
  const indexed = pages.map((entry) => ({ page: entry.page, skeleton: materialSkeleton(entry.text), hasTextLayer: entry.hasTextLayer !== false && materialSkeleton(entry.text).length > 0 }))
  const withText = indexed.filter((entry) => entry.hasTextLayer)
  const noText = indexed.filter((entry) => !entry.hasTextLayer).map((entry) => entry.page)
  /** @param {string} needle @returns {number[]} */
  const pagesContaining = (needle) => withText.filter((entry) => entry.skeleton.includes(needle)).map((entry) => entry.page)
  /** @param {string} reason @returns {MaterialPage} */
  const unknownFor = (reason) => ({
    status: 'unknown',
    reason: reason !== 'no_match' ? reason : pageCount > pages.length ? 'source_too_large' : noText.length ? 'no_text_layer' : reason,
  })
  let rowChecks = 0
  let budgetSpent = false

  const locatedTables = tables.map((table) => {
    if (table.status !== 'structured' || !Array.isArray(table.cells)) return { ...table, page: { status: 'unknown', reason: 'not_requested' } }
    /** @type {Map<number, { c: number, skeleton: string }[]>} */
    const byRow = new Map()
    for (const cell of table.cells) {
      const skeleton = materialSkeleton(cell.t)
      if (!skeleton) continue
      byRow.set(cell.r, [...(byRow.get(cell.r) ?? []), { c: cell.c, skeleton }])
    }
    /** @type {{ row: number, page: MaterialPage }[]} */
    const results = []
    for (const [row, cells] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
      if (rowChecks >= SOURCE_LOCATE_LIMITS.maxRowChecks) { budgetSpent = true; results.push({ row, page: { status: 'unknown', reason: 'locator_budget' } }); continue }
      rowChecks += 1
      const ordered = cells.sort((a, b) => a.c - b.c)
      const whole = ordered.map((cell) => cell.skeleton).join('')
      if (whole.length < SOURCE_LOCATE_LIMITS.minRowNeedle) { results.push({ row, page: { status: 'unknown', reason: 'too_short' } }); continue }
      let found = pagesContaining(whole)
      let basis = 'row_text'
      if (!found.length) {
        // The cells may come out of the PDF in another order: every cell of the
        // row on one page still places it, when there are at least two to place.
        const parts = ordered.filter((cell) => cell.skeleton.length >= SOURCE_LOCATE_LIMITS.minCellNeedle)
        if (parts.length >= 2) {
          found = withText.filter((entry) => parts.every((cell) => entry.skeleton.includes(cell.skeleton))).map((entry) => entry.page)
          basis = 'cell_text'
        }
      }
      results.push({ row, page: found.length === 1 ? { status: 'located', pages: found, basis }
        : found.length > 1 ? { status: 'ambiguous', candidates: found, basis } : unknownFor('no_match') })
    }
    // Rows with the same outcome run together, so a long table is a few entries.
    /** @type {Record<string, any>[]} */
    const rowPages = []
    for (const { row, page } of results) {
      const last = rowPages[rowPages.length - 1]
      const same = last && last.to === row - 1 && JSON.stringify({ ...last, from: 0, to: 0 }) === JSON.stringify({ ...page, from: 0, to: 0 })
      if (same) last.to = row
      else rowPages.push({ from: row, to: row, ...page })
    }
    const located = uniqueSorted(results.flatMap((entry) => entry.page.status === 'located' ? entry.page.pages ?? [] : []))
    const ambiguous = uniqueSorted(results.flatMap((entry) => entry.page.status === 'ambiguous' ? entry.page.candidates ?? [] : []))
    /** @type {MaterialPage} */
    let page
    if (located.length) page = { status: 'located', pages: located, basis: 'rows' }
    else if (ambiguous.length) page = { status: 'ambiguous', candidates: ambiguous, basis: 'rows' }
    else {
      const caption = materialSkeleton(table.caption?.text)
      const named = caption.length >= SOURCE_LOCATE_LIMITS.minCaptionNeedle ? pagesContaining(caption) : []
      if (named.length === 1) page = { status: 'located', pages: named, basis: 'caption_text' }
      else if (named.length > 1) page = { status: 'ambiguous', candidates: named, basis: 'caption_text' }
      else page = unknownFor(results.find((entry) => entry.page.reason && entry.page.reason !== 'too_short')?.page.reason ?? 'no_match')
    }
    return { ...table, page, rowPages }
  })

  const locatedFigures = figures.map((figure) => {
    const caption = materialSkeleton(figure.caption?.text)
    if (caption.length < SOURCE_LOCATE_LIMITS.minCaptionNeedle) return { ...figure, page: unknownFor('too_short') }
    const found = pagesContaining(caption)
    return { ...figure, page: found.length === 1 ? { status: 'located', pages: found, basis: 'caption_text' }
      : found.length > 1 ? { status: 'ambiguous', candidates: found, basis: 'caption_text' } : unknownFor('no_match') }
  })
  return {
    tables: locatedTables, figures: locatedFigures,
    info: { status: withText.length ? 'mapped' : 'no_text_layer', pageCount: Math.max(pageCount, indexed.length), textLayerPages: withText.length, noTextLayerPages: noText.slice(0, 200), rowChecks, budgetSpent },
  }
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/**
 * How many of one table's values are located, ambiguous, unlocated, unextracted
 * or failed, by the format's way of locating a value:
 *
 * - `paginated` (a PDF, a Word file): a value is located when its row's page is
 *   known, ambiguous when several pages could hold it, unlocated otherwise — its
 *   table and cell are still known, which is not the same as a place in the
 *   document;
 * - `sheet` and `delimited`: the sheet address, or the row and column, is the
 *   location, and is exact;
 * - `flow` (text, Markdown, HTML): the table and cell and their character span;
 * - `image`: a scan has no pages and the text is the parser's reading of pixels —
 *   unlocated, said so.
 *
 * @param {Record<string, any>} table @param {string} pagination
 */
export function materialTableCounts(table, pagination) {
  const counts = { total: 0, located: 0, ambiguous: 0, unlocated: 0, unextracted: 0, failed: 0 }
  if (table?.status !== 'structured') {
    const candidates = Number.isSafeInteger(table?.valueCandidates) ? table.valueCandidates : 0
    if (table?.reason === 'derivation_failed') counts.failed += candidates
    else counts.unextracted += candidates
    counts.total = counts.unextracted + counts.failed
    return counts
  }
  for (const cell of materialTableValues(table)) {
    counts.total += 1
    if (pagination === 'paginated') {
      const status = materialRowPage(table, cell.r).status
      if (status === 'located') counts.located += 1
      else if (status === 'ambiguous') counts.ambiguous += 1
      else counts.unlocated += 1
    } else if (pagination === 'image') counts.unlocated += 1
    else counts.located += 1
  }
  counts.unextracted += Number.isSafeInteger(table.unextracted) ? table.unextracted : 0
  counts.total += Number.isSafeInteger(table.unextracted) ? table.unextracted : 0
  return counts
}

/**
 * The per-source ledger of structured materials: the extraction version, the
 * source hash, and what was located, ambiguous, unlocated, unextracted or failed.
 * Every count is derived here from the units themselves, so the ledger and the
 * records cannot disagree.
 *
 * @param {{ tables: Record<string, any>[], figures?: Record<string, any>[], supplements?: Record<string, any>[], pagination: string, format: string,
 *   pages: { status: string, pageCount?: number, textLayerPages?: number, noTextLayerPages?: number[], reason?: string },
 *   extraction: { materials?: string, parser?: string, locator?: string }, sourceSha256?: string | null, textSha256?: string | null,
 *   limits?: string[], failure?: string | null, unavailable?: string | null, now?: string }} input
 *   `failure` is the code a derivation failed with; `unavailable` is why none was attempted. Neither leaves a count unsaid: both are
 *   ledgers with their numbers at zero and the reason beside them.
 */
export function sourceMaterialsCoverage({ tables, figures = [], supplements = [], pagination, format, pages, extraction, sourceSha256 = null, textSha256 = null, limits = [], failure = null, unavailable = null, now }) {
  const values = { total: 0, located: 0, ambiguous: 0, unlocated: 0, unextracted: 0, failed: 0 }
  const tableCounts = { total: tables.length, structured: 0, unextracted: 0, failed: 0, continued: 0, continuedAmbiguous: 0 }
  const footnotes = { linked: 0, orphanMarkers: 0, orphanNotes: 0 }
  for (const table of tables) {
    if (table.status === 'structured') tableCounts.structured += 1
    else if (table.reason === 'derivation_failed') tableCounts.failed += 1
    else tableCounts.unextracted += 1
    if (table.continuation) { tableCounts.continued += 1; if (table.continuation.certainty === 'ambiguous') tableCounts.continuedAmbiguous += 1 }
    const counts = materialTableCounts(table, pagination)
    for (const key of /** @type {const} */ (['total', 'located', 'ambiguous', 'unlocated', 'unextracted', 'failed'])) values[key] += counts[key]
    footnotes.linked += (table.footnotes ?? []).filter((/** @type {{ cells: string[] }} */ note) => note.cells.length > 0).length
    footnotes.orphanMarkers += (table.orphanMarkers ?? []).length
    footnotes.orphanNotes += table.orphanNotes ?? 0
  }
  /** @type {string[]} */
  const reasons = [...limits]
  if (unavailable) reasons.push(unavailable)
  if (pages.reason && !reasons.includes(pages.reason)) reasons.push(pages.reason)
  if (pages.status === 'no_text_layer' || pagination === 'image') reasons.push('scanned_or_image_source')
  if (figures.length) reasons.push('figures_not_digitized')
  const origin = pagination === 'image' || pages.status === 'no_text_layer' ? 'ocr' : 'reported'
  const trouble = tableCounts.unextracted + tableCounts.failed + values.unextracted + values.failed
  const status = failure ? 'failed' : unavailable ? 'unavailable' : trouble > 0 || limits.length ? 'partial' : 'extracted'
  return {
    version: SOURCE_MATERIALS_VERSION,
    status, ...(failure ? { failure } : {}), ...(unavailable ? { unavailable } : {}),
    format, pagination, origin,
    // Where an OCR reading or a graph-estimated value is involved its uncertainty is unknown, and said so.
    ...(origin === 'ocr' ? { uncertainty: 'unknown' } : {}),
    extraction: { materials: SOURCE_MATERIALS_EXTRACTOR, ...extraction },
    sourceSha256, textSha256,
    pages,
    tables: tableCounts, values,
    figures: { total: figures.length, captioned: figures.filter((figure) => figure.caption).length, valuesKnown: 0 },
    footnotes,
    supplements: { referenced: supplements.length, linked: supplements.filter((entry) => entry.linked && entry.linked !== 'unknown').length },
    reasons: [...new Set(reasons)],
    ...(now ? { at: now } : {}),
  }
}

/**
 * What is wrong with a coverage record as stored, or an empty list. The counts
 * must add up, every status must be in its vocabulary and the hashes must be
 * hashes: a ledger that does not hold together is never stored as one.
 * @param {any} coverage @returns {string[]}
 */
export function sourceMaterialsCoverageIssues(coverage) {
  /** @type {string[]} */
  const issues = []
  if (!coverage || typeof coverage !== 'object') return ['coverage must be an object.']
  if (coverage.version !== SOURCE_MATERIALS_VERSION) issues.push('coverage.version is not this contract.')
  if (!SOURCE_MATERIAL_COVERAGE_STATUSES.includes(coverage.status)) issues.push('coverage.status is not in the vocabulary.')
  if (!SOURCE_MATERIAL_PAGES_STATUSES.includes(coverage.pages?.status)) issues.push('coverage.pages.status is not in the vocabulary.')
  for (const key of ['sourceSha256', 'textSha256']) {
    if (coverage[key] != null && !/^[a-f0-9]{64}$/.test(String(coverage[key]))) issues.push(`coverage.${key} is not a SHA-256.`)
  }
  const values = coverage.values ?? {}
  const sum = ['located', 'ambiguous', 'unlocated', 'unextracted', 'failed'].reduce((total, key) => total + (Number.isSafeInteger(values[key]) ? values[key] : NaN), 0)
  if (!(sum === values.total)) issues.push('coverage.values does not add up.')
  const tables = coverage.tables ?? {}
  if (!(tables.structured + tables.unextracted + tables.failed === tables.total)) issues.push('coverage.tables does not add up.')
  return issues
}

// ---------------------------------------------------------------------------
// A quotation's place
// ---------------------------------------------------------------------------

const PAGE_MARKER = /^<!--\s*page\s+(\d{1,5})(?::\s*([a-z_]+))?\s*-->$/

/**
 * The page markers a captured text carries (`<!-- page N -->`, one per line, as
 * `renderSourcePageMarkers` writes them), with the span each page covers.
 * @param {string} text @returns {{ page: number, start: number, end: number, status: string }[]}
 */
export function materialPageSegments(text) {
  /** @type {{ page: number, markerEnd: number, status: string, markerStart: number }[]} */
  const markers = []
  let offset = 0
  for (const line of text.split('\n')) {
    const found = PAGE_MARKER.exec(line.trim())
    if (found) markers.push({ page: Number(found[1]), markerStart: offset, markerEnd: offset + line.length, status: found[2] ?? 'ok' })
    offset += line.length + 1
  }
  return markers.map((marker, index) => ({
    page: marker.page, status: marker.status, start: Math.min(marker.markerEnd + 1, text.length), end: markers[index + 1]?.markerStart ?? text.length,
  }))
}

/**
 * Where a quotation sits in a text: its table, row and cell where it lies inside
 * one, and its page where the text carries page markers. `matches` is the
 * platform's one quote comparison (`quoteIsPresent`), passed in so this module
 * holds no second one: the quote is looked for in each table, row and cell *slice*
 * with the same rule the gate and the reader's ✓ use.
 *
 * Every answer says what it does not know: a quote in prose has no table, a text
 * without page markers has no page, and several tables holding the quote are
 * candidates, not a pick.
 *
 * @param {{ text: string, quote: string, matches: (haystack: string, needle: string) => boolean,
 *   structure?: { tables: Record<string, any>[] } | null }} input
 * @returns {{ status: 'located' | 'ambiguous' | 'unknown', table?: Record<string, any>, row?: number, cell?: Record<string, any>, candidates?: Record<string, any>[], rowCandidates?: number[], cellCandidates?: Record<string, any>[], page: MaterialPage, reason?: string }}
 */
export function locateQuoteInText({ text, quote, matches, structure = null }) {
  const capture = materialCaptureText(text)
  const derived = structure ?? deriveMarkdownStructure({ text: capture })
  /** @type {MaterialPage} */
  let page = { status: 'unknown', reason: 'no_page_markers' }
  const segments = materialPageSegments(capture)
  if (segments.length) {
    const found = segments.filter((segment) => segment.end > segment.start && matches(capture.slice(segment.start, segment.end), quote)).map((segment) => segment.page)
    page = found.length === 1 ? { status: 'located', pages: found, basis: 'page_marker' }
      : found.length > 1 ? { status: 'ambiguous', candidates: found, basis: 'page_marker' } : { status: 'unknown', reason: 'quote_spans_pages_or_not_found' }
  }
  const structured = derived.tables.filter((/** @type {Record<string, any>} */ table) => table.status === 'structured')
  /** @type {Record<string, any>[]} */
  const holders = []
  for (const table of structured) {
    const slice = Number.isSafeInteger(table.start) && Number.isSafeInteger(table.end) ? capture.slice(table.start, table.end) : null
    const joined = table.cells.map((/** @type {{ t: string }} */ cell) => cell.t).join(' ')
    if ((slice !== null && matches(slice, quote)) || matches(joined, quote)) holders.push(table)
  }
  /** @param {Record<string, any>} table */
  const brief = (table) => ({ id: table.id, index: table.index, kind: table.kind, ...(table.caption?.label ? { label: table.caption.label } : {}), ...(table.name ? { name: table.name } : {}) })
  if (!holders.length) {
    return { status: page.status === 'located' ? 'located' : page.status === 'ambiguous' ? 'ambiguous' : 'unknown', page, reason: 'not_in_a_table' }
  }
  if (holders.length > 1) return { status: 'ambiguous', candidates: holders.slice(0, 8).map(brief), page, reason: 'several_tables' }
  const table = holders[0]
  // Row, then cell, by the same comparison, over the slices of the table.
  /** @type {Map<number, { s?: number, e?: number, cells: any[] }>} */
  const rows = new Map()
  for (const cell of table.cells) {
    const entry = rows.get(cell.r) ?? { cells: [] }
    entry.cells.push(cell)
    if (Number.isSafeInteger(cell.s)) { entry.s = Math.min(entry.s ?? cell.s, cell.s); entry.e = Math.max(entry.e ?? cell.e, cell.e) }
    rows.set(cell.r, entry)
  }
  const rowHits = [...rows.entries()].filter(([, row]) => (Number.isSafeInteger(row.s) && matches(capture.slice(row.s, row.e), quote))
    || matches(row.cells.map((/** @type {{ t: string }} */ cell) => cell.t).join(' '), quote)).map(([r]) => r)
  const tablePage = table.rowPages ? null : table.page
  if (rowHits.length !== 1) {
    return { status: 'located', table: brief(table), ...(rowHits.length > 1 ? { rowCandidates: rowHits.slice(0, 8) } : {}), page: page.status !== 'unknown' ? page : (tablePage ?? page) }
  }
  const row = rowHits[0]
  const cellHits = rows.get(row)?.cells.filter((/** @type {{ t: string }} */ cell) => matches(cell.t, quote)) ?? []
  const rowPage = materialPageOfRow(table, row)
  const resolvedPage = page.status !== 'unknown' ? page : (rowPage ?? tablePage ?? page)
  if (cellHits.length === 1) {
    const cell = cellHits[0]
    return { status: 'located', table: brief(table), row, cell: { row: cell.r, column: cell.c, ...(cell.a ? { address: cell.a } : {}),
      ...(headerTextOf(table, cell.c) ? { header: headerTextOf(table, cell.c) } : {}) }, page: resolvedPage }
  }
  return { status: 'located', table: brief(table), row, ...(cellHits.length > 1 ? { cellCandidates: cellHits.slice(0, 8).map((/** @type {{ r: number, c: number }} */ cell) => ({ row: cell.r, column: cell.c })) } : {}), page: resolvedPage }
}

/** @param {Record<string, any>} table @param {number} column */
function headerTextOf(table, column) {
  if (Array.isArray(table.header)) return table.header.find((/** @type {{ c: number }} */ cell) => cell.c === column)?.t ?? null
  const row = table.header?.row
  return row ? (table.cells.find((/** @type {{ r: number, c: number }} */ cell) => cell.r === row && cell.c === column)?.t ?? null) : null
}

/** @param {Record<string, any>} table @param {number} row @returns {MaterialPage | null} */
function materialPageOfRow(table, row) {
  if (!Array.isArray(table.rowPages)) return null
  const page = materialRowPage(table, row)
  return page.status === 'unknown' && page.reason === 'not_requested' ? null : page
}
