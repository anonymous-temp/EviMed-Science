/**
 * Whether the results an engine report states are the engine's results.
 *
 * Hidden knowledge: in an engine-backed package the numbers are rendered by a
 * computation and then typed into prose by a model, and the second step is
 * where they go wrong. The report and its `*-run.json` receipt are both the
 * model's writing; the engine's own output lands beside the workspace, under
 * the job's directory, where the gate never looked (contractRegistry.mjs, "What
 * is NOT checked here"). Numeric traceability in the literature is the check
 * that reaches near-zero error — ScientistOne 98.1%, VeriGraph 87.6% — and it
 * is the data-side twin of the verbatim quote match: the number in the prose
 * must be a number in the output, at the precision the prose claims.
 *
 * Re-running the engine is not the check. Engines are not in the runtime
 * image, and end to end they are not deterministic (live PubMed and openFDA,
 * a model in the loop); the one package whose script is both — dataset
 * scoping's `data-profile.py` — is already recomputed by its run-side
 * preflight and traced by `dataset-number-provenance`. So this reads what the
 * engine wrote and checks the prose against it.
 *
 * Which numbers: the ones stated as results — a number with a statistical
 * label or unit (`conclusoryQuantities`, the gate's own extractor) — in
 * sentences that do not cite the literature. A background sentence quoting a
 * published odds ratio with its `[3]` is the literature's number, not the
 * engine's, and counting it would be the false positive that taught
 * `claim-numeric-support` to be ignored (102 notices in 4 runs,
 * 2026-09-17…22). Confidence levels and significance thresholds are removed
 * first: 「95% CI」 and 「P < 0.05」 are conventions, not results.
 *
 * The sentence, not the physical line, is what a citation covers. Markdown
 * wraps a paragraph over lines that render as one, and a report that wraps at
 * 110 columns puts a sentence's `[3]` on the line after its odds ratio. Read
 * line by line, the 2026-09-27 topic report's literature figures — each in a
 * sentence ending with its `[n]` — came back as 32 「数字溯源不到」 findings
 * the run could only decline, twice. A line is still read whole, and still
 * exempt when it carries a marker itself; what is new is only that a line
 * whose every sentence carries one is exempt too.
 *
 * Advice until the ledger says otherwise (principle 4).
 *
 * @module @evimed/domain/numericTraceability
 */

import { conclusoryQuantities } from './clinicalEvidence.mjs'

/** A value within this relative distance is a near miss, the shape a stale or rounded-wrong number leaves. */
const NEAR_RELATIVE = 0.05

/** Numbers one output set may hold before the rest are ignored; a bound, not an expectation. */
const OUTPUT_NUMBER_LIMIT = 200_000

/** Numbers named in one finding. */
const NAMED_PER_FINDING = 8

/**
 * Every number an output file holds. JSON: every number and every numeric
 * string, at any depth. CSV: every cell that is a number once its quotes and
 * digit-grouping commas are gone (the drug-safety engine writes counts as
 * `"20,328,575"`).
 * @param {readonly { path: string, text: string }[]} files
 * @returns {number[]}
 */
export function outputNumbers(files) {
  /** @type {Set<number>} */
  const numbers = new Set()
  for (const file of files) {
    const path = String(file?.path ?? '').toLowerCase()
    const text = String(file?.text ?? '')
    if (numbers.size >= OUTPUT_NUMBER_LIMIT) break
    if (path.endsWith('.json')) {
      try {
        collectJsonNumbers(JSON.parse(text), numbers, 0)
      } catch {
        // An output that is not JSON contributes nothing; the receipt checks say so.
      }
    } else if (path.endsWith('.csv') || path.endsWith('.tsv')) {
      collectCsvNumbers(text, path.endsWith('.tsv') ? '\t' : ',', numbers)
    }
  }
  return [...numbers]
}

/** @param {unknown} value @param {Set<number>} into @param {number} depth */
function collectJsonNumbers(value, into, depth) {
  if (depth > 16 || into.size >= OUTPUT_NUMBER_LIMIT) return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) into.add(value)
    return
  }
  if (typeof value === 'string') {
    const parsed = numericCell(value)
    if (parsed !== null) into.add(parsed)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonNumbers(item, into, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectJsonNumbers(item, into, depth + 1)
  }
}

/** @param {string} text @param {string} separator @param {Set<number>} into */
function collectCsvNumbers(text, separator, into) {
  for (const line of text.split(/\r?\n/)) {
    if (into.size >= OUTPUT_NUMBER_LIMIT) return
    for (const cell of splitDelimited(line, separator)) {
      const parsed = numericCell(cell)
      if (parsed !== null) into.add(parsed)
    }
  }
}

/** One delimited line into its cells, honouring double quotes.
 * @param {string} line @param {string} separator @returns {string[]} */
function splitDelimited(line, separator) {
  /** @type {string[]} */
  const cells = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === separator && !quoted) {
      cells.push(current)
      current = ''
    } else {
      current += character
    }
  }
  cells.push(current)
  return cells
}

/** A cell's number, or null. Grouping commas, a trailing percent and scientific notation are read.
 * @param {string} value @returns {number | null} */
function numericCell(value) {
  const trimmed = String(value).trim().replace(/^"|"$/g, '')
  if (!trimmed || trimmed.length > 40) return null
  const plain = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(trimmed) ? trimmed.replace(/,/g, '') : trimmed
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?%?$/i.test(plain)) return null
  const parsed = Number(plain.replace(/%$/, ''))
  return Number.isFinite(parsed) ? parsed : null
}

/** Decimal places a written number claims. @param {string} literal */
function precisionOf(literal) {
  const dot = literal.indexOf('.')
  return dot === -1 ? 0 : literal.length - dot - 1
}

/** @param {number} candidate @param {number} written @param {number} places */
function roundsTo(candidate, written, places) {
  const factor = 10 ** places
  return Math.round(candidate * factor) / factor === Math.round(written * factor) / factor
}

/**
 * One stated number against the outputs: verified if some output value rounds
 * to it at the precision it is written with (a percentage is also tried as a
 * fraction, and a fraction as a percentage), mismatched if some value is
 * within 5%, else unsupported.
 * @param {string} literal @param {readonly number[]} outputs
 * @returns {'verified'|'mismatched'|'unsupported'}
 */
export function traceNumber(literal, outputs) {
  const written = Math.abs(Number(literal))
  if (!Number.isFinite(written)) return 'unsupported'
  const places = precisionOf(literal)
  // The prose number as written, as a fraction of it (23.4% vs 0.234) and as
  // a percentage of it (0.95 vs 95), each at the precision it then carries.
  const forms = [[written, places], [written / 100, places + 2], [written * 100, Math.max(0, places - 2)]]
  let near = false
  for (const raw of outputs) {
    // The extractor keeps magnitudes, not signs — a negative estimate is
    // stated as 「−0.12」 and read as 0.12 — so outputs are compared the same way.
    const candidate = Math.abs(raw)
    for (const [form, formPlaces] of forms) {
      if (roundsTo(candidate, form, formPlaces)) return 'verified'
      const scale = Math.max(form, candidate)
      if (scale > 0 && Math.abs(candidate - form) / scale <= NEAR_RELATIVE) near = true
    }
  }
  return near ? 'mismatched' : 'unsupported'
}

const FENCE = /^\s*(?:```|~~~)/
const HEADING = /^\s*#/
/** A numbered citation in prose: the literature's number, not the engine's. */
const CITATION_MARKER = /\[\d{1,3}(?:\s*[-–,，]\s*\d{1,3})*\]/
/** The same marker opening a stretch of text: a citation written after the full stop belongs to the sentence before it. */
const LEADING_CITATION = /^\s*\[\d{1,3}(?:\s*[-–,，]\s*\d{1,3})*\]/
/** Where a sentence ends: a CJK terminator, or an ASCII one followed by space or the end of the paragraph. */
const SENTENCE_END = /[。！？]|[.!?](?=\s|$)/g
/** A line that begins a block of its own — a list item, a table row, a quotation — instead of continuing the paragraph above it. */
const BLOCK_START = /^\s*(?:[-*+]\s|\d{1,3}[.)]\s|\||>)/
/** The reference list starts at its heading; nothing after it is a result. */
const REFERENCE_HEADING = /^\s*#{1,6}\s*(?:参考文献|参考来源|References?|Bibliography)\s*$/i
/** Conventions, not results: the confidence level and the significance threshold. */
const CONVENTIONS = [
  /95\s*%\s*(?=(?:CI|CrI|置信区间|可信区间|的置信区间))/gi,
  /[pP]\s*(?:值)?\s*[<＜≤]\s*0?\.0[15]\b/g,
  /[pP]\s*(?:值)?\s*[<＜]\s*5\s*[x×]\s*10\s*[-−⁻]\s*[8⁸]/g,
  /\b5\s*[eE]\s*-\s*8\b/g,
]

/**
 * @typedef {object} NumericFinding
 * @property {'numeric-traceability'} check
 * @property {'number_untraced'} kind
 * @property {number} line
 * @property {string} location   `第 n 行`
 * @property {string} evidence   the report line, bounded (it is in the report verbatim)
 * @property {'mismatched'|'unsupported'} verdict
 * @property {string[]} numbers
 * @property {string} message
 */

/**
 * The report's stated results, each traced to the engine's output.
 *
 * @param {{ reportText: string, outputs: readonly number[], outputLabel?: string }} input
 *   `outputLabel` names the job whose files were read, for the message
 * @returns {{ findings: NumericFinding[], metrics: { stated: number, verified: number, mismatched: number, unsupported: number, outputNumbers: number } }}
 */
export function numericTraceFindings({ reportText, outputs, outputLabel = '引擎输出' }) {
  const metrics = { stated: 0, verified: 0, mismatched: 0, unsupported: 0, outputNumbers: outputs.length }
  /** @type {NumericFinding[]} */
  const findings = []
  if (!outputs.length) return { findings, metrics }
  let fenced = false
  const lines = String(reportText ?? '').split('\n')
  const cited = citedLines(lines)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (REFERENCE_HEADING.test(line)) break
    if (HEADING.test(line) || cited.has(index)) continue
    let scannable = line
    for (const pattern of CONVENTIONS) scannable = scannable.replace(pattern, ' ')
    /** @type {string[]} */
    const mismatched = []
    /** @type {string[]} */
    const unsupported = []
    for (const token of conclusoryQuantities(scannable)) {
      for (const literal of token.split('-').filter(Boolean)) {
        metrics.stated += 1
        const verdict = traceNumber(literal, outputs)
        if (verdict === 'verified') metrics.verified += 1
        else if (verdict === 'mismatched') { metrics.mismatched += 1; if (!mismatched.includes(literal)) mismatched.push(literal) }
        else { metrics.unsupported += 1; if (!unsupported.includes(literal)) unsupported.push(literal) }
      }
    }
    if (!mismatched.length && !unsupported.length) continue
    const evidence = line.trim().length > 300 ? `${line.trim().slice(0, 297)}…` : line.trim()
    const verdict = mismatched.length ? 'mismatched' : 'unsupported'
    const named = [...mismatched, ...unsupported]
    findings.push({
      check: 'numeric-traceability',
      kind: 'number_untraced',
      line: index + 1,
      location: `第 ${index + 1} 行`,
      evidence,
      verdict,
      numbers: named,
      message: mismatched.length
        ? `第 ${index + 1} 行写的 ${mismatched.slice(0, NAMED_PER_FINDING).join('、')} 在${outputLabel}里只有相近而不相同的值——多半是抄错或舍入错了。按输出改正，或在文中说明差异从哪来。`
        : `第 ${index + 1} 行写的 ${unsupported.slice(0, NAMED_PER_FINDING).join('、')}${unsupported.length > NAMED_PER_FINDING ? ` 等 ${unsupported.length} 个数` : ''}在${outputLabel}里找不到。结果数字应当来自这次计算；若它来自文献，给它标上引用。`,
    })
  }
  return { findings, metrics }
}

/**
 * The lines a citation covers: every line that carries a marker, and every
 * line each of whose sentences carries one. Sentences are read across the
 * paragraph's wrapped lines; a paragraph ends at a blank line, a heading, a
 * fence, or a line that opens a block of its own (a list item, a table row).
 * @param {readonly string[]} lines @returns {Set<number>}
 */
function citedLines(lines) {
  /** @type {Set<number>} */
  const cited = new Set()
  /** @type {number[]} */
  let block = []
  const flush = () => {
    markParagraph(lines, block, cited)
    block = []
  }
  let fenced = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (FENCE.test(line)) {
      flush()
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (!line.trim() || HEADING.test(line)) {
      flush()
      continue
    }
    if (BLOCK_START.test(line)) flush()
    block.push(index)
    // A table row is a paragraph of one: the next row is never its continuation.
    if (/^\s*\|/.test(line)) flush()
  }
  flush()
  return cited
}

/**
 * @param {readonly string[]} lines @param {readonly number[]} block the paragraph's line indexes
 * @param {Set<number>} cited
 */
function markParagraph(lines, block, cited) {
  if (!block.length) return
  // The paragraph as it renders: its lines joined by one space, with each
  // line's span in the joined text kept so a sentence can be mapped back.
  let text = ''
  /** @type {[number, number, number][]} */
  const spans = []
  for (const index of block) {
    if (text) text += ' '
    const start = text.length
    text += lines[index]
    spans.push([index, start, text.length])
  }
  /** @type {[number, number][]} */
  const sentences = []
  let start = 0
  SENTENCE_END.lastIndex = 0
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length
    sentences.push([start, end])
    start = end
  }
  if (text.slice(start).trim()) sentences.push([start, text.length])
  const sentenceCited = sentences.map(([from, to]) => CITATION_MARKER.test(text.slice(from, to)))
  for (let index = 1; index < sentences.length; index += 1) {
    if (LEADING_CITATION.test(text.slice(sentences[index][0], sentences[index][1]))) sentenceCited[index - 1] = true
  }
  for (const [index, from, to] of spans) {
    if (CITATION_MARKER.test(lines[index])) {
      cited.add(index)
      continue
    }
    const touching = sentences.flatMap(([sentenceFrom, sentenceTo], position) => (sentenceFrom < to && sentenceTo > from ? [position] : []))
    if (touching.length && touching.every((position) => sentenceCited[position])) cited.add(index)
  }
}
