/**
 * The shape of a delivered file, as far as a program can say it without reading its prose: what a `routine` lesson compares.
 *
 * Hidden knowledge: "the same kind of work, done again" has to be decided by something other than the capability id alone once
 * the ordinary conversation can teach (2026-10-23). A weekly report with the same sections, a workbook with the same sheets and
 * header row, a script with the same top-level definitions are the same shape; three `.docx` files about three unrelated things
 * are not. The shape is a format plus a bounded list of structural labels (headings, slide titles, sheet names and header cells,
 * top-level definitions), read from the file by a reader on the server (`apps/server/src/artifactShapes.mjs`) and stored beside
 * the run; this module is only the closed vocabulary around it: how a label is cleaned and when two shapes match. Nothing here
 * reads a word of a document's text for meaning (principle 1). A bare format supplies too little evidence for a routine.
 *
 * Provisional numbers, chosen before there is a distribution to read: a label set of at least `ARTIFACT_SHAPE_MIN_LABELS` on both
 * sides must overlap by `ARTIFACT_SHAPE_MATCH_JACCARD`.
 *
 * @module artifactShape
 */

/** How many labels one file's shape keeps, and how long a label may be. */
export const ARTIFACT_SHAPE_LIMITS = Object.freeze({ labels: 16, labelChars: 40, files: 4 })

/** A primary file needs at least this much structure to support a match. */
export const ARTIFACT_SHAPE_MIN_LABELS = 2

/** The overlap (Jaccard) two label sets need to be the same shape. */
export const ARTIFACT_SHAPE_MATCH_JACCARD = 0.5

/** @typedef {{ format: string, labels: string[], scriptRelated?: boolean }} ArtifactShape */

/**
 * A structural label cleaned for comparison: lower case, white space folded, every run of digits one `#` (so "Q3 summary" and
 * "Q4 summary" are one label), bounded. Empty when nothing is left.
 * @param {unknown} value @returns {string}
 */
export function normalizeShapeLabel(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ARTIFACT_SHAPE_LIMITS.labelChars)
}

/**
 * One file's shape as the ledger keeps it, or null for something that is not one. Labels are cleaned, de-duplicated in order and
 * bounded; a format is a short lower-case extension.
 * @param {unknown} value @returns {ArtifactShape | null}
 */
export function cleanArtifactShape(value) {
  const record = /** @type {any} */ (value)
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const format = String(record.format ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
  if (!format) return null
  /** @type {string[]} */
  const labels = []
  for (const entry of Array.isArray(record.labels) ? record.labels : []) {
    const label = normalizeShapeLabel(entry)
    if (label && !labels.includes(label)) labels.push(label)
    if (labels.length >= ARTIFACT_SHAPE_LIMITS.labels) break
  }
  return { format, labels, ...(record.scriptRelated === true ? { scriptRelated: true } : {}) }
}

/**
 * A run's files as shapes, in a fixed order (by format, then labels) so two runs that made the same things in another order
 * compare equal. Files past the bound are left out.
 * @param {unknown} shapes @returns {ArtifactShape[]}
 */
export function cleanArtifactShapes(shapes) {
  /** @type {ArtifactShape[]} */
  const cleaned = []
  for (const entry of Array.isArray(shapes) ? shapes : []) {
    const shape = cleanArtifactShape(entry)
    if (shape) cleaned.push(shape)
  }
  return cleaned
    .sort((left, right) => Number(Boolean(left.scriptRelated)) - Number(Boolean(right.scriptRelated)) || left.format.localeCompare(right.format) || left.labels.join('\u0000').localeCompare(right.labels.join('\u0000')))
    .slice(0, ARTIFACT_SHAPE_LIMITS.files)
}

/** @param {readonly string[]} left @param {readonly string[]} right */
function jaccard(left, right) {
  const a = new Set(left)
  const b = new Set(right)
  let both = 0
  for (const label of a) if (b.has(label)) both += 1
  const either = a.size + b.size - both
  return either === 0 ? 1 : both / either
}

/**
 * Require a one-to-one structural match for each primary file. With an ambiguous inventory, files with same-run
 * script lineage may be unmatched on either side. At least one independently identified primary file must match.
 * @param {unknown} left @param {unknown} right @returns {boolean}
 */
export function artifactShapesMatch(left, right) {
  const a = cleanArtifactShapes(left)
  const b = cleanArtifactShapes(right)
  if (!a.length || !b.length || [...a, ...b].every(shape => shape.scriptRelated)) return false
  /** @param {ArtifactShape} file @param {ArtifactShape} candidate */
  const agrees = (file, candidate) => file.format === candidate.format
    && file.labels.length >= ARTIFACT_SHAPE_MIN_LABELS && candidate.labels.length >= ARTIFACT_SHAPE_MIN_LABELS
    && jaccard(file.labels, candidate.labels) >= ARTIFACT_SHAPE_MATCH_JACCARD
  // There are at most four files on either side. Try alternate pairings when a file has
  // several compatible matches, so optional files cannot displace a required pairing.
  /** @param {number} index @param {Set<number>} used @returns {boolean} */
  const pair = (index, used) => {
    if (index === a.length) return b.every((file, position) => file.scriptRelated || used.has(position))
    const file = a[index]
    if (file.scriptRelated && pair(index + 1, used)) return true
    return b.some((candidate, position) => !used.has(position) && agrees(file, candidate)
      && pair(index + 1, new Set([...used, position])))
  }
  return pair(0, new Set())
}
