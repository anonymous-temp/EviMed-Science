/**
 * Claim-level evidence work, as data in and data out.
 *
 * Hidden knowledge: what a clinical child used to do with scripts it wrote
 * itself. A 20-minute clinical run spent most of its steps on bookkeeping —
 * building the evidence matrix with `build_matrix.py` and `make_claims2.py`,
 * then renumbering citations and reassembling the reference list with
 * `assemble3.py`, `render.py` and a family of `fix*.py` (review appendix E §1,
 * plan §9.1). Every one of those scripts was a fresh reading of the same
 * grammar the gate reads, written under time pressure, and the gate then
 * disagreed with it. These two functions do the same two jobs with the gate's
 * own grammar (`@evimed/domain/clinical-evidence`), deterministically:
 *
 *   - `upsertClaim` writes or replaces one claim in the matrix by its id;
 *   - `renderClinicalReport` renumbers citations by first appearance, merges a
 *     source listed twice, rebuilds the reference list in that order, carries
 *     the new numbers into the matrix, and hides visible claim markers.
 *
 * Neither judges language. What a claim says, which source supports it and how
 * the report argues stay the model's; these keep the bookkeeping consistent.
 * Build to delete: a model that keeps a numbered bibliography consistent on
 * its own makes the renderer unnecessary; the upsert's per-claim verdict is
 * the gate's and outlives it.
 *
 * @module @evimed/dsh-socket/src/claimTools
 */

import { EVIDENCE_MATRIX_OUTPUT } from '@evimed/domain'
import {
  citationSpans,
  hideVisibleClaimMarkers,
  markedClaimIds,
  parseReferenceEntry,
  referenceIdentifiers,
  referenceListBounds,
} from '@evimed/domain/clinical-evidence'

/** The clinical contract's two files, as the contract registry names them. */
export const CLAIM_MATRIX_FILE = EVIDENCE_MATRIX_OUTPUT
export const CLAIM_REPORT_FILE = 'clinical-evidence-report.md'

/** Claim verdicts a session remembers; the oldest is forgotten first. */
export const CLAIM_VERDICT_MEMORY = 512

/** Findings one upsert returns about its claim. A claim with more is a claim to rewrite. */
export const CLAIM_ISSUE_LIMIT = 20

/** The claim-id shape the gate accepts. */
const CLAIM_ID = /^CLM-(\d{3,6})$/

/** The heading a rebuilt reference list gets when the report had none. */
const DEFAULT_REFERENCE_HEADING = '## 参考文献'

/**
 * A matrix read from disk: `{ claims: [...] }` with every other root field
 * kept. An absent file is an empty matrix; a file that is not a JSON object
 * with a `claims` array is refused rather than rewritten, because the only way
 * to "fix" it here would be to drop what the run wrote.
 * @param {string | null | undefined} text
 * @returns {{ ok: true, matrix: Record<string, any> } | { ok: false, reason: string }}
 */
export function readMatrix(text) {
  if (text == null || !String(text).trim()) return { ok: true, matrix: { claims: [] } }
  let parsed
  try {
    parsed = JSON.parse(String(text))
  } catch (error) {
    return { ok: false, reason: `clinical-evidence-matrix.json is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix its syntax first — a value containing a double quote must escape it (\\").` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'clinical-evidence-matrix.json must be one JSON object with a `claims` array.' }
  }
  if (parsed.claims === undefined) return { ok: true, matrix: { ...parsed, claims: [] } }
  if (!Array.isArray(parsed.claims)) return { ok: false, reason: 'clinical-evidence-matrix.json has a `claims` field that is not an array.' }
  return { ok: true, matrix: parsed }
}

/**
 * The next free claim id: one past the highest in the matrix, three digits at
 * least, so a run that lets the tool number its claims gets CLM-001, CLM-002…
 * @param {readonly any[]} claims @returns {string}
 */
export function nextClaimId(claims) {
  let highest = 0
  for (const claim of claims) {
    const match = CLAIM_ID.exec(String(claim?.claimId ?? ''))
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return `CLM-${String(highest + 1).padStart(3, '0')}`
}

/**
 * Write one claim into the matrix: replaced in place when its id is already
 * there, appended otherwise, given the next free id when it has none.
 * Idempotent — the same claim twice leaves one row.
 * @param {Record<string, any>} matrix @param {Record<string, any>} claim
 * @returns {{ matrix: Record<string, any>, claim: Record<string, any>, created: boolean }}
 */
export function upsertClaim(matrix, claim) {
  const claims = Array.isArray(matrix?.claims) ? [...matrix.claims] : []
  const claimId = typeof claim?.claimId === 'string' && claim.claimId.trim() ? claim.claimId.trim() : nextClaimId(claims)
  const written = { ...claim, claimId }
  const at = claims.findIndex((entry) => entry?.claimId === claimId)
  if (at >= 0) claims[at] = written
  else claims.push(written)
  return { matrix: { ...matrix, claims }, claim: written, created: at < 0 }
}

/**
 * The shortest faithful spelling of a citation list: ascending, a run of three
 * or more written as a range, ASCII separators — the form both of the gate's
 * citation readers accept.
 * @param {readonly number[]} numbers @returns {string}
 */
function citationList(numbers) {
  const sorted = [...new Set(numbers)].sort((left, right) => left - right)
  /** @type {string[]} */
  const parts = []
  for (let index = 0; index < sorted.length;) {
    let end = index
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1
    if (end - index >= 2) parts.push(`${sorted[index]}-${sorted[end]}`)
    else for (let at = index; at <= end; at += 1) parts.push(String(sorted[at]))
    index = end + 1
  }
  return `[${parts.join(', ')}]`
}

/**
 * The reference-list entry a claim's own metadata can stand in for, when the
 * report cites a number nobody wrote an entry for.
 * @param {Record<string, any> | undefined} claim @returns {string}
 */
function entryFromClaim(claim) {
  const parts = [claim?.sourceTitle, claim?.identifier, claim?.sourceUrl]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
  return parts.join('. ')
}

/**
 * Renumber, merge, rebuild and sync.
 *
 * Numbers are assigned in order of first appearance in the prose (everything
 * outside the reference list, the same prose the closure check reads). Two
 * entries naming one work by the same DOI, PMID or URL (`referenceIdentifiers`)
 * become one number. Entries the prose never cites keep a number after the
 * cited ones, and numbers only a claim carries come last with an entry built
 * from that claim; both are listed, never dropped, because deleting a source
 * is a judgement and the gate already says which ones the prose never cites.
 * A cited number with neither an entry nor a claim to build one from is
 * reported unresolved. Nothing changes when nothing needs to: a report already
 * in order comes back byte for byte.
 *
 * @param {{ reportText: string, matrix?: Record<string, any> | null }} input
 * @returns {{
 *   text: string,
 *   matrix: Record<string, any> | null,
 *   changed: { report: boolean, matrix: boolean },
 *   references: number,
 *   markersSynced: number,
 *   renumbered: boolean,
 *   merged: { from: number, into: number }[],
 *   added: number[],
 *   uncited: number[],
 *   unresolved: { citations: number[], claims: string[] },
 * }}
 */
export function renderClinicalReport({ reportText, matrix = null }) {
  const original = String(reportText ?? '')
  const markers = hideVisibleClaimMarkers(original)
  const text = markers.text
  const bounds = referenceListBounds(text)
  const listStart = bounds?.headingStart ?? text.length
  const listEnd = bounds?.end ?? text.length

  // The existing entries, each with the continuation lines under it; lines
  // before the first entry are the list's preface and stay where they are.
  /** @type {Map<number, { lines: string[] }>} */
  const entries = new Map()
  /** @type {string[]} */
  const preface = []
  /** @type {string[]} */
  const listedLines = []
  if (bounds) {
    /** @type {{ lines: string[] } | null} */
    let current = null
    for (const line of text.slice(bounds.headingEnd, listEnd).split('\n')) {
      if (!line.trim()) continue
      const entry = parseReferenceEntry(line)
      if (!entry && !current) {
        preface.push(line)
        continue
      }
      listedLines.push(line)
      if (entry && !entries.has(entry.number)) {
        current = { lines: [entry.text] }
        entries.set(entry.number, current)
      } else {
        // A continuation line — or a number listed a second time, kept under
        // the first rather than silently lost.
        current?.lines.push(entry ? line.trim() : line)
      }
    }
  }

  // Citations in the prose, in reading order: everything outside the list.
  const spans = citationSpans(text).filter((span) => span.start < listStart || span.start >= listEnd)
  /** @type {number[]} */
  const citedOrder = []
  for (const span of spans) for (const number of span.numbers) if (!citedOrder.includes(number)) citedOrder.push(number)

  const claims = Array.isArray(matrix?.claims) ? matrix.claims : []
  /** @type {Map<number, Record<string, any>>} */
  const claimByNumber = new Map()
  for (const claim of claims) {
    for (const number of [claim?.referenceNumber, ...(Array.isArray(claim?.referenceNumbers) ? claim.referenceNumbers : [])]) {
      if (Number.isInteger(number) && !claimByNumber.has(number)) claimByNumber.set(number, claim)
    }
  }
  const byNumber = (/** @type {number} */ left, /** @type {number} */ right) => left - right
  const uncitedEntries = [...entries.keys()].filter((number) => !citedOrder.includes(number)).sort(byNumber)
  const claimOnly = [...claimByNumber.keys()].filter((number) => !citedOrder.includes(number) && !entries.has(number)).sort(byNumber)

  // One work, one number. A number whose entry (or, with no entry, whose
  // claim) names a DOI, PMID or URL already seen merges into the number that
  // named it first.
  /** @type {Map<number, number>} */
  const canonical = new Map()
  /** @type {Map<string, number>} */
  const byIdentifier = new Map()
  /** @type {{ from: number, into: number }[]} */
  const merged = []
  for (const number of [...citedOrder, ...uncitedEntries, ...claimOnly]) {
    if (canonical.has(number)) continue
    const body = entries.get(number)?.lines.join(' ') ?? entryFromClaim(claimByNumber.get(number))
    const identifiers = body ? [...referenceIdentifiers(body)] : []
    const into = identifiers.map((identifier) => byIdentifier.get(identifier)).find((value) => value !== undefined)
    if (into !== undefined && into !== number) {
      canonical.set(number, into)
      merged.push({ from: number, into })
      continue
    }
    canonical.set(number, number)
    for (const identifier of identifiers) if (!byIdentifier.has(identifier)) byIdentifier.set(identifier, number)
  }

  /** @type {Map<number, number>} canonical old number -> new number */
  const assigned = new Map()
  let next = 1
  /** @param {number} number @returns {{ number: number, fresh: boolean }} */
  const assign = (number) => {
    const root = canonical.get(number) ?? number
    const fresh = !assigned.has(root)
    if (fresh) assigned.set(root, next++)
    return { number: /** @type {number} */ (assigned.get(root)), fresh }
  }
  for (const number of citedOrder) assign(number)
  /** @type {number[]} */
  const uncited = []
  for (const number of [...uncitedEntries, ...claimOnly]) {
    const placed = assign(number)
    if (placed.fresh) uncited.push(placed.number)
  }
  /** @param {number} number */
  const renumber = (number) => assigned.get(canonical.get(number) ?? number) ?? number
  const renumbered = merged.length > 0 || [...canonical.keys()].some((number) => renumber(number) !== number)

  // The list as it should read: in the new order, `n. ` form (the one form
  // every reader of the list understands), the first spelling of a merged work
  // kept.
  /** @type {string[]} */
  const lines = []
  /** @type {number[]} */
  const added = []
  /** @type {number[]} */
  const unresolvedCitations = []
  for (const [root, number] of [...assigned.entries()].sort((left, right) => left[1] - right[1])) {
    const entry = entries.get(root)
    if (entry) {
      lines.push(`${number}. ${entry.lines[0]}`, ...entry.lines.slice(1))
      continue
    }
    const built = entryFromClaim(claimByNumber.get(root))
    if (built) {
      lines.push(`${number}. ${built}`)
      added.push(number)
    } else {
      unresolvedCitations.push(number)
    }
  }

  // Citations rewritten only where their numbers change, so a report already
  // in order keeps its own spelling.
  let prose = ''
  let cursor = 0
  for (const span of spans) {
    const mapped = span.numbers.map(renumber)
    const same = mapped.every((number, index) => number === span.numbers[index])
    prose += text.slice(cursor, span.start) + (same ? span.raw : citationList(mapped))
    cursor = span.end
  }
  prose += text.slice(cursor)

  let rendered = prose
  const listChanged = lines.length !== listedLines.length || lines.some((line, index) => line !== listedLines[index].trimEnd())
  if (listChanged && (lines.length || bounds)) {
    // Offsets moved with the rewritten citations before the list; the list
    // holds none of them, so it is found again rather than recomputed.
    const proseBounds = referenceListBounds(prose)
    const heading = bounds ? text.slice(bounds.headingStart, bounds.headingEnd) : DEFAULT_REFERENCE_HEADING
    const section = [heading, '', ...preface, ...(preface.length ? [''] : []), ...lines, ''].join('\n')
    if (proseBounds) {
      const tail = prose.slice(proseBounds.end)
      rendered = `${prose.slice(0, proseBounds.headingStart)}${section}${tail ? `\n${tail}` : ''}`
    } else {
      rendered = `${prose.replace(/\s*$/, '')}\n\n${section}`
    }
  }

  // The matrix follows the numbers.
  let claimsRepointed = 0
  const syncedClaims = claims.map((claim) => {
    if (!claim || typeof claim !== 'object') return claim
    const synced = { ...claim }
    let moved = false
    if (Number.isInteger(claim.referenceNumber) && renumber(claim.referenceNumber) !== claim.referenceNumber) {
      synced.referenceNumber = renumber(claim.referenceNumber)
      moved = true
    }
    if (Array.isArray(claim.referenceNumbers)) {
      const numbers = [...new Set(claim.referenceNumbers.map((/** @type {any} */ number) => (Number.isInteger(number) ? renumber(number) : number)))]
      if (numbers.length !== claim.referenceNumbers.length || numbers.some((number, index) => number !== claim.referenceNumbers[index])) {
        synced.referenceNumbers = numbers
        moved = true
      }
    }
    if (moved) claimsRepointed += 1
    return moved ? synced : claim
  })

  const matrixIds = new Set(claims.map((claim) => claim?.claimId).filter(Boolean))
  const unresolvedClaims = matrix ? [...new Set(markedClaimIds(rendered))].filter((id) => !matrixIds.has(id)).sort() : []

  return {
    text: rendered,
    matrix: matrix ? { ...matrix, claims: syncedClaims } : null,
    changed: { report: rendered !== original, matrix: claimsRepointed > 0 },
    references: lines.filter((line) => /^\d+\.\s/.test(line)).length,
    markersSynced: markers.hidden + claimsRepointed,
    renumbered,
    merged,
    added,
    uncited,
    unresolved: { citations: unresolvedCitations, claims: unresolvedClaims },
  }
}
