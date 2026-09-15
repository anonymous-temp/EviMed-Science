/**
 * The `dataset-scoping-package` contract's number-provenance findings.
 *
 * Hidden knowledge: a dataset-scoping run is the one capability that starts
 * from data the researcher already holds, and `scripts/profile_dataset.py`
 * writes a deterministic snapshot of that data to `data-profile.json` before a
 * word of the package is written. So this is the one kind where "every number
 * in the prose came from somewhere" is decidable rather than aspirational —
 * the somewhere exists, on disk, in the same package.
 *
 * Borrowed from `dsh-data-quality`'s `verifyCitations` (2026-09-15 ecosystem
 * ruling: take the contract, do not install the plugin). Its shape is a
 * four-value verdict per number, and the four values are the point:
 *
 *   verified     — a snapshot number matches, at the precision the prose wrote
 *   mismatched   — a snapshot number is *near* it and does not match, which is
 *                  what a stale number or a transcription slip looks like
 *   unsupported  — nothing in the snapshot is anywhere near it
 *   unverifiable — the snapshot could not be read, so no number has a verdict
 *
 * Collapsing `mismatched` into `unsupported` is the thing worth not doing. They
 * ask for opposite repairs: an unsupported number needs a source, a mismatched
 * one needs correcting, and a run told only "not found" re-derives which it is.
 *
 * ## Severity
 *
 * Every finding here is `advisory`, and `advisory()` is the only constructor in
 * the file so that stays true by construction. Principle 4: the blocking budget
 * is six system-wide and spent, and a check that has never seen a real
 * distribution may not become the seventh. This ships as a notice; what it is
 * for right now is producing the distribution that a later decision could be
 * argued from. Principle 10c — "numbers are rendered artifacts, not typed
 * prose" — is the thing it is measuring the distance to.
 *
 * ## What it deliberately does not read
 *
 * Fenced code blocks (a command line is not a claim), ISO dates, bare years,
 * and the leading `N.` of an ordered-list item. Each of those is a numeral that
 * is not a quantity, and reporting them would bury the ones that are.
 */

/**
 * @typedef {{ code: string, message: string, severity: 'advisory', path?: string, check: string }} DatasetIssue
 */

/** Numbers the prose can carry that are not quantities drawn from the data. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g
const FENCED_BLOCK = /```[\s\S]*?```/g
const ORDERED_LIST_MARKER = /^[ \t]*\d{1,3}[.)](?=\s)/gm
const NUMBER = /-?\d+(?:\.\d+)?/g

/** How near a snapshot number has to be to call a prose number mismatched
 * rather than unsupported. Five percent: close enough that the two are
 * plausibly the same quantity, far enough that rounding cannot explain it. */
const NEAR_RELATIVE = 0.05

/** How many numbers of one verdict to name in one finding. A verdict is a
 * return value the run repairs from, and forty numerals in one message is not
 * one. */
const NAMED_PER_FINDING = 8

/** Findings are advisory by construction. See the severity note above.
 * @param {string} code @param {string} message
 * @param {{ path?: string, check: string }} extra
 * @returns {DatasetIssue}
 */
function advisory(code, message, extra) {
  return {
    code,
    message,
    severity: 'advisory',
    ...(extra.path ? { path: extra.path } : {}),
    check: extra.check,
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** @param {any} input @param {string} path @returns {string} */
function fileText(input, path) {
  const files = input?.files
  if (files instanceof Map) return String(files.get(path) ?? '')
  if (isRecord(files)) return String(files[path] ?? '')
  return ''
}

/**
 * @param {any} input @param {string} path
 * @returns {{ state: 'absent'|'unparseable'|'parsed', value: any }}
 */
function parsedJson(input, path) {
  const raw = fileText(input, path)
  if (!raw.trim()) return { state: 'absent', value: null }
  try {
    return { state: 'parsed', value: JSON.parse(raw) }
  } catch {
    return { state: 'unparseable', value: null }
  }
}

/**
 * Every number anywhere in the snapshot, however deeply nested, including the
 * ones written as strings — a profiler that emits `"missing": "12"` is
 * describing the same fact as one that emits `12`, and a provenance check that
 * only accepted the second would report a correct number as unsupported.
 * @param {unknown} value @param {Set<number>} into @param {number} depth
 */
function collectNumbers(value, into, depth = 0) {
  if (depth > 12 || into.size > 20000) return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) into.add(value)
    return
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const parsed = Number(trimmed)
      if (Number.isFinite(parsed)) into.add(parsed)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, into, depth + 1)
    return
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectNumbers(item, into, depth + 1)
  }
}

/** The prose, with the numerals that are not quantities removed first.
 * @param {string} text @returns {string} */
function scannableProse(text) {
  return text
    .replace(FENCED_BLOCK, ' ')
    .replace(ISO_DATE, ' ')
    .replace(ORDERED_LIST_MARKER, ' ')
}

/** Decimal places a written number claims. `23.40` claims two, and matching it
 * against `23.4` at one place would accept a snapshot value of 23.44.
 * @param {string} literal @returns {number} */
function precisionOf(literal) {
  const dot = literal.indexOf('.')
  return dot === -1 ? 0 : literal.length - dot - 1
}

/** Whether `candidate` rounds to `written` at the precision `written` claims.
 * @param {number} candidate @param {number} written @param {number} places @returns {boolean} */
function roundsTo(candidate, written, places) {
  const factor = 10 ** places
  return Math.round(candidate * factor) / factor === Math.round(written * factor) / factor
}

/**
 * One prose number against the snapshot.
 * @param {string} literal @param {boolean} percent @param {readonly number[]} snapshot
 * @returns {'verified'|'mismatched'|'unsupported'}
 */
function verdictFor(literal, percent, snapshot) {
  const written = Number(literal)
  if (!Number.isFinite(written)) return 'unsupported'
  const places = precisionOf(literal)
  // A report says 23.4%; a profiler writes 0.234. They are the same fact, and
  // only one of them is wrong to call unsupported.
  const forms = percent ? [written, written / 100] : [written]
  let near = false
  for (const candidate of snapshot) {
    for (const form of forms) {
      if (roundsTo(candidate, form, places)) return 'verified'
      const scale = Math.max(Math.abs(form), Math.abs(candidate))
      if (scale > 0 && Math.abs(candidate - form) / scale <= NEAR_RELATIVE) near = true
    }
  }
  return near ? 'mismatched' : 'unsupported'
}

/**
 * Whether the numbers in a dataset-scoping package's prose can be traced to the
 * profile snapshot it shipped beside them.
 *
 * @param {{ files: Map<string, string> | Record<string, string> }} input
 * @param {readonly string[]} proseFiles
 * @returns {{ issues: DatasetIssue[], metrics: Record<string, unknown> }}
 */
export function datasetScopingFindings(input, proseFiles) {
  const parsed = parsedJson(input, 'data-profile.json')

  if (parsed.state === 'unparseable') {
    return {
      issues: [advisory(
        'dataset_profile_unparseable',
        'data-profile.json is not valid JSON, so no number in this package could be traced to the data. Fix the syntax first — every number in the prose is unverifiable until the snapshot reads.',
        { path: 'data-profile.json', check: 'dataset-profile-parse' },
      )],
      metrics: { datasetNumberProvenance: 'unverifiable', datasetNumbersVerified: 0, datasetNumbersMismatched: 0, datasetNumbersUnsupported: 0 },
    }
  }
  if (parsed.state === 'absent') {
    // `requiredOutputsExist` is what blocks on a missing snapshot. Saying it
    // again here would report one absent file as two problems.
    return {
      issues: [],
      metrics: { datasetNumberProvenance: 'unverifiable', datasetNumbersVerified: 0, datasetNumbersMismatched: 0, datasetNumbersUnsupported: 0 },
    }
  }

  /** @type {Set<number>} */
  const snapshotSet = new Set()
  collectNumbers(parsed.value, snapshotSet)
  const snapshot = [...snapshotSet]

  /** @type {DatasetIssue[]} */
  const issues = []
  let verified = 0
  let mismatched = 0
  let unsupported = 0

  for (const path of proseFiles) {
    const text = scannableProse(fileText(input, path))
    if (!text.trim()) continue
    /** @type {string[]} */
    const unsupportedHere = []
    /** @type {string[]} */
    const mismatchedHere = []
    for (const match of text.matchAll(NUMBER)) {
      const literal = match[0]
      // A digit inside a word is part of the word: HbA1c, COVID-19, ICD-10,
      // T2DM. The first version of this check read the 1 out of HbA1c and told
      // a correct package that it had an unsupported number.
      const before = match.index > 0 ? text[match.index - 1] : ''
      if (/[A-Za-z0-9_]/.test(before)) continue
      // A bare four-digit integer in the range a year lives in is a year far
      // more often than it is a measurement, and a package that mentions 2021
      // twice would otherwise carry two findings that teach nobody anything.
      const value = Number(literal)
      if (!literal.includes('.') && Number.isInteger(value) && value >= 1900 && value <= 2100) continue
      const after = text.slice(match.index + literal.length, match.index + literal.length + 1)
      const verdict = verdictFor(literal, after === '%', snapshot)
      if (verdict === 'verified') verified += 1
      else if (verdict === 'mismatched') { mismatched += 1; if (!mismatchedHere.includes(literal)) mismatchedHere.push(literal) }
      else { unsupported += 1; if (!unsupportedHere.includes(literal)) unsupportedHere.push(literal) }
    }
    if (mismatchedHere.length) {
      issues.push(advisory(
        'dataset_number_mismatched',
        `${path} states ${mismatchedHere.slice(0, NAMED_PER_FINDING).join(', ')}, and data-profile.json holds a close but different value for each. Correct the number against the snapshot, or say in the text what the difference is (a subset, a later cut, a derived figure) — a near miss is the shape a stale number leaves.`,
        { path, check: 'dataset-number-provenance' },
      ))
    }
    if (unsupportedHere.length) {
      issues.push(advisory(
        'dataset_number_unsupported',
        `${path} states ${unsupportedHere.slice(0, NAMED_PER_FINDING).join(', ')}${unsupportedHere.length > NAMED_PER_FINDING ? ` and ${unsupportedHere.length - NAMED_PER_FINDING} more` : ''}, and nothing in data-profile.json is near them. Either profile the quantity so the snapshot carries it, or attribute the number in the text to the source it came from.`,
        { path, check: 'dataset-number-provenance' },
      ))
    }
  }

  return {
    issues,
    metrics: {
      datasetNumberProvenance: mismatched ? 'mismatched' : unsupported ? 'unsupported' : 'verified',
      datasetNumbersVerified: verified,
      datasetNumbersMismatched: mismatched,
      datasetNumbersUnsupported: unsupported,
      datasetProfileNumbers: snapshot.length,
    },
  }
}
