/**
 * What an independent review may say, and what code does with what it says.
 *
 * Hidden knowledge: the reviewer is a model, so nothing it answers is taken on
 * its word. Three rules, each from a measurement:
 *
 * - **A finding carries the text it rests on, copied, and a finding whose text
 *   is not in the package or in the sources the reviewer was shown is
 *   dropped** (principle 5: the model judges, code checks the checkable part,
 *   and what fails the check is dropped, not softened). A judgment-based
 *   verifier swings from 3% to 18% flagged on identical text (arXiv
 *   2607.20527); a finding that cannot be located is the kind that swings.
 *   Measured on the wire on 2026-09-23: with thinking off the reviewer
 *   paraphrased its evidence ("Source states 0.9 percentage points…") instead
 *   of copying it — so the rule is enforced here, not trusted to the prompt.
 * - **Only a decidable kind may be `required`.** The reviewer's own kinds —
 *   contradiction, weak support, overclaim, a missing item — are judgments,
 *   and a judgment is advice however it is phrased (the 2026-09-17 ruling;
 *   Qwen3-Max on PRISMA 2020 items: sensitivity 95.1%, specificity 49.3%).
 *   Severity is assigned here from the kind; the model is never asked for it.
 * - **A finding is answered.** Suggestions a writer is free to ignore are
 *   adopted a third of the time and the pass rate falls (arXiv 2607.15388);
 *   the writer that must say "fixed" or "declined, because…" to each one is
 *   the coupling that makes a reviewer worth its cost. The answers are
 *   counted per kind, and a kind declined more often than it is fixed is a
 *   kind to demote.
 *
 * @module @evimed/domain/reviewFindings
 */

import { quoteIsPresent } from './clinicalEvidence.mjs'

/**
 * Kinds code decides. The checks behind them are deterministic and
 * full-coverage (reference resolution, numeric traceability, statistics
 * consistency, numbering); the reviewer model never raises one.
 */
export const REVIEW_DECIDABLE_KINDS = Object.freeze(/** @type {const} */ ([
  'reference_unresolvable',
  'reference_mismatch',
  'number_untraced',
  'stat_inconsistent',
]))

/** Kinds the reviewer model raises. Every one is a judgment. */
export const REVIEW_JUDGMENT_KINDS = Object.freeze(/** @type {const} */ ([
  'contradiction',
  'weak_support',
  'overclaim',
  'missing_item',
  'interpretation',
  'wording',
  'structure',
  'safety',
]))

/** @typedef {typeof REVIEW_DECIDABLE_KINDS[number] | typeof REVIEW_JUDGMENT_KINDS[number]} ReviewFindingKind */

/** Every kind, the closed vocabulary a stored finding is checked against. */
export const REVIEW_FINDING_KINDS = Object.freeze([...REVIEW_DECIDABLE_KINDS, ...REVIEW_JUDGMENT_KINDS])

/** What a reader and the run see for each kind. */
export const REVIEW_FINDING_KIND_LABELS_ZH = Object.freeze(/** @type {Record<ReviewFindingKind, string>} */ ({
  reference_unresolvable: '引用解析不到',
  reference_mismatch: '引用与文献不符',
  number_untraced: '数字溯源不到',
  stat_inconsistent: '统计量自相矛盾',
  contradiction: '与来源矛盾',
  weak_support: '证据支持偏弱',
  overclaim: '结论写过头',
  missing_item: '清单条目缺失',
  interpretation: '解读有误',
  wording: '措辞',
  structure: '结构',
  safety: '用药安全',
}))

/**
 * Kinds whose finding the writer must answer — fixed, or declined with a
 * reason. The rest (wording, structure) may be taken or left in silence.
 * Not a withholding list: nothing here stops a delivery (2026-09-17).
 */
export const REVIEW_ANSWER_REQUIRED_KINDS = Object.freeze(/** @type {readonly ReviewFindingKind[]} */ ([
  ...REVIEW_DECIDABLE_KINDS,
  'contradiction',
  'overclaim',
  'safety',
]))

/** How a writer answers a finding. */
export const REVIEW_RESPONSES = Object.freeze(/** @type {const} */ (['fixed', 'declined']))

/** A reason to decline is a sentence, not an essay. */
export const REVIEW_RESPONSE_REASON_MAX = 300

/** Findings one review may keep. A reviewer with more to say has one package to rewrite, not forty findings to answer. */
export const REVIEW_FINDINGS_MAX = 30

/** Characters of evidence a finding may carry. */
const EVIDENCE_MAX = 600

/** Characters of a location, a fix. */
const LOCATION_MAX = 200
const FIX_MAX = 400

/**
 * The editor's answer, as the strict JSON schema the provider enforces.
 * Every field is required because strict mode requires it; a field that does
 * not apply is the empty string.
 */
export const REVIEW_EDITOR_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'checklist', 'acceptance'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['location', 'kind', 'evidence', 'fix'],
        properties: {
          location: { type: 'string', description: 'Where: a claim id (CLM-012), a reference number ([7]), a section heading, or a checklist item id.' },
          kind: { type: 'string', enum: [...REVIEW_JUDGMENT_KINDS] },
          evidence: { type: 'string', description: 'The words the finding rests on, copied character for character from the submission or from a source excerpt it was given. Not a paraphrase. A straight double quote inside it is escaped.' },
          fix: { type: 'string', description: 'One concrete edit, a sentence long. Not a rewritten paragraph. Quote words with 「」, never with straight double quotes.' },
        },
      },
    },
    checklist: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'status', 'evidence'],
        properties: {
          item: { type: 'string', description: 'The checklist item id as given.' },
          status: { type: 'string', enum: ['present', 'absent', 'not_applicable'] },
          evidence: { type: 'string', description: 'For present: the words that report it, copied. Otherwise empty.' },
        },
      },
    },
    acceptance: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'met', 'evidence'],
        properties: {
          item: { type: 'string', description: 'The acceptance item number as given (A1, A2…).' },
          met: { type: 'boolean' },
          evidence: { type: 'string', description: 'For met: the words that meet it, copied. Otherwise empty.' },
        },
      },
    },
  },
})

/**
 * @typedef {object} ReviewFinding
 * @property {string} id              stable within one review: `F01`…
 * @property {ReviewFindingKind} kind
 * @property {'required'|'advisory'} severity
 * @property {'code'|'editor'} origin
 * @property {string} location
 * @property {string} evidence
 * @property {string} fix
 * @property {string} message         one line a researcher and the run both read
 */

/** @param {unknown} value @param {number} max */
function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** @param {unknown} kind @returns {kind is ReviewFindingKind} */
export function isReviewFindingKind(kind) {
  return typeof kind === 'string' && REVIEW_FINDING_KINDS.includes(/** @type {ReviewFindingKind} */ (kind))
}

/**
 * The severity a kind carries. `required` is reachable only for a decidable
 * kind whose check has been promoted (`promoted`), and none is promoted until
 * its false-positive rate has been read off real submissions (principle 4).
 * @param {ReviewFindingKind} kind @param {readonly string[]} [promoted]
 * @returns {'required'|'advisory'}
 */
export function reviewSeverity(kind, promoted = []) {
  return REVIEW_DECIDABLE_KINDS.includes(/** @type {any} */ (kind)) && promoted.includes(kind) ? 'required' : 'advisory'
}

/** A short label before a copied piece: 报告原文：, 来源摘录：, 报告写：, Source: … */
const EVIDENCE_LABEL = /^[^\s:：「」“”"『』]{1,12}\s*[:：]\s*/u
/** Quotation marks around a copied piece, and the full stop a writer puts after them. */
const EVIDENCE_WRAPPER = /^[「“"『]|[」”"』][。．.，,；;]?$/gu

/**
 * Whether an evidence excerpt is in any of the texts the reviewer was given.
 *
 * A contradiction is naturally shown as two excerpts, the report's words and
 * its source's, and the reviewer sets them out as such: one per line, or
 * joined by a semicolon, labelled (报告原文：…；来源摘录：…), in quotation
 * marks (measured 2026-09-23: two samples in three wrote their planted
 * findings that way and lost them all). Such evidence is located piece by
 * piece, labels and quotation marks taken off — trimming a verbatim excerpt
 * leaves it verbatim — and every piece must be found; one that is not drops
 * the whole finding.
 * @param {string} evidence @param {readonly string[]} haystacks
 */
export function evidenceLocated(evidence, haystacks) {
  const excerpt = String(evidence ?? '').trim()
  if (excerpt.length < 4) return false
  /** @param {string} piece */
  const found = (piece) => piece.length >= 4 && haystacks.some((haystack) => quoteIsPresent(haystack, piece))
  if (found(excerpt)) return true
  const pieces = excerpt.split(/\n+|[；;]/u)
    .map((piece) => piece.trim().replace(EVIDENCE_LABEL, '').trim().replace(EVIDENCE_WRAPPER, '').trim())
    .filter(Boolean)
  return pieces.length > 0 && pieces.every(found)
}

/** Bounded, line breaks kept: what `evidenceLocated` reads. @param {unknown} value @param {number} max */
function lines(value, max) {
  return String(value ?? '').trim().slice(0, max)
}

/**
 * The editor's raw answer, checked: kinds from the closed list, evidence found
 * in the package or the source excerpts it was shown, fields bounded, severity
 * assigned from the kind. What fails is counted by reason, never kept.
 *
 * @param {unknown} raw  the parsed `REVIEW_EDITOR_OUTPUT_SCHEMA` answer
 * @param {{ haystacks: readonly string[], promoted?: readonly string[], idPrefix?: string, max?: number }} input
 * @returns {{ findings: ReviewFinding[], dropped: { kind: string, reason: 'kind'|'evidence'|'duplicate'|'limit' }[] }}
 */
export function acceptEditorFindings(raw, { haystacks, promoted = [], idPrefix = 'F', max = REVIEW_FINDINGS_MAX }) {
  const list = Array.isArray(/** @type {any} */ (raw)?.findings) ? /** @type {any} */ (raw).findings : []
  /** @type {ReviewFinding[]} */
  const findings = []
  /** @type {{ kind: string, reason: 'kind'|'evidence'|'duplicate'|'limit' }[]} */
  const dropped = []
  const seen = new Set()
  for (const entry of list) {
    const kind = String(entry?.kind ?? '')
    if (!REVIEW_JUDGMENT_KINDS.includes(/** @type {any} */ (kind))) {
      dropped.push({ kind, reason: 'kind' })
      continue
    }
    const evidence = text(entry?.evidence, EVIDENCE_MAX)
    if (!evidenceLocated(lines(entry?.evidence, EVIDENCE_MAX), haystacks)) {
      dropped.push({ kind, reason: 'evidence' })
      continue
    }
    const location = text(entry?.location, LOCATION_MAX)
    const key = `${kind}\u0000${location}\u0000${evidence.toLowerCase()}`
    if (seen.has(key)) {
      dropped.push({ kind, reason: 'duplicate' })
      continue
    }
    seen.add(key)
    if (findings.length >= max) {
      dropped.push({ kind, reason: 'limit' })
      continue
    }
    const typed = /** @type {ReviewFindingKind} */ (kind)
    const fix = text(entry?.fix, FIX_MAX)
    findings.push({
      id: `${idPrefix}${String(findings.length + 1).padStart(2, '0')}`,
      kind: typed,
      severity: reviewSeverity(typed, promoted),
      origin: 'editor',
      location,
      evidence,
      fix,
      message: findingMessage({ kind: typed, location, evidence, fix }),
    })
  }
  return { findings, dropped }
}

/**
 * The checklist and acceptance answers, checked the same way: a `present` or
 * `met` whose evidence is not in the package is not believed, and becomes
 * "not shown" rather than "absent" — the reviewer failed to locate it, which
 * is not the same as the package lacking it.
 *
 * @param {unknown} raw
 * @param {{ haystacks: readonly string[], checklistItems: readonly { id: string }[], acceptanceItems: readonly string[] }} input
 * @returns {{ checklist: { item: string, status: 'present'|'absent'|'not_applicable'|'unlocated' }[], acceptance: { item: string, met: boolean | null }[] }}
 */
export function acceptEditorChecks(raw, { haystacks, checklistItems, acceptanceItems }) {
  const known = new Set(checklistItems.map((item) => String(item.id)))
  /** @type {{ item: string, status: 'present'|'absent'|'not_applicable'|'unlocated' }[]} */
  const checklist = []
  const answered = new Set()
  for (const entry of Array.isArray(/** @type {any} */ (raw)?.checklist) ? /** @type {any} */ (raw).checklist : []) {
    const item = String(entry?.item ?? '')
    if (!known.has(item) || answered.has(item)) continue
    answered.add(item)
    const status = String(entry?.status ?? '')
    if (status === 'present') {
      checklist.push({ item, status: evidenceLocated(lines(entry?.evidence, EVIDENCE_MAX), haystacks) ? 'present' : 'unlocated' })
    } else if (status === 'absent' || status === 'not_applicable') {
      checklist.push({ item, status })
    }
  }
  /** @type {{ item: string, met: boolean | null }[]} */
  const acceptance = []
  const labels = acceptanceItems.map((_, index) => `A${index + 1}`)
  const done = new Set()
  for (const entry of Array.isArray(/** @type {any} */ (raw)?.acceptance) ? /** @type {any} */ (raw).acceptance : []) {
    const item = String(entry?.item ?? '')
    if (!labels.includes(item) || done.has(item)) continue
    done.add(item)
    if (entry?.met === true) {
      acceptance.push({ item, met: evidenceLocated(lines(entry?.evidence, EVIDENCE_MAX), haystacks) ? true : null })
    } else if (entry?.met === false) {
      acceptance.push({ item, met: false })
    }
  }
  return { checklist, acceptance }
}

/**
 * One finding as the line the run and the reader both see: what kind, where,
 * the words it rests on, and the edit.
 * @param {{ kind: ReviewFindingKind, location: string, evidence: string, fix: string }} finding
 * @returns {string}
 */
export function findingMessage({ kind, location, evidence, fix }) {
  const label = REVIEW_FINDING_KIND_LABELS_ZH[kind] ?? kind
  const where = location ? `（${location}）` : ''
  const quoted = evidence ? `「${evidence.length > 160 ? `${evidence.slice(0, 157)}…` : evidence}」` : ''
  return `${label}${where}${quoted ? `：${quoted}` : ''}${fix ? `。建议：${fix}` : ''}`
}

/**
 * The writer's answers to a review, checked: every id one of the review's
 * findings, every response in the vocabulary, a reason for every decline.
 * @param {unknown} raw
 * @param {readonly { id: string }[]} findings
 * @returns {{ answers: { id: string, response: 'fixed'|'declined', reason: string }[], refused: { id: string, reason: 'unknown'|'response'|'reason' }[] }}
 */
export function acceptReviewResponses(raw, findings) {
  const ids = new Set(findings.map((finding) => String(finding.id)))
  /** @type {{ id: string, response: 'fixed'|'declined', reason: string }[]} */
  const answers = []
  /** @type {{ id: string, reason: 'unknown'|'response'|'reason' }[]} */
  const refused = []
  const answered = new Set()
  for (const entry of Array.isArray(raw) ? raw : []) {
    const id = String(entry?.id ?? '').trim()
    if (!ids.has(id) || answered.has(id)) {
      refused.push({ id, reason: 'unknown' })
      continue
    }
    const response = String(entry?.response ?? '')
    if (!REVIEW_RESPONSES.includes(/** @type {any} */ (response))) {
      refused.push({ id, reason: 'response' })
      continue
    }
    const reason = text(entry?.reason, REVIEW_RESPONSE_REASON_MAX)
    if (response === 'declined' && reason.length < 4) {
      refused.push({ id, reason: 'reason' })
      continue
    }
    answered.add(id)
    answers.push({ id, response: /** @type {'fixed'|'declined'} */ (response), reason })
  }
  return { answers, refused }
}

/**
 * The findings that still owe an answer.
 * @param {readonly ReviewFinding[]} findings
 * @param {readonly { id: string }[]} answers
 * @returns {ReviewFinding[]}
 */
export function unansweredFindings(findings, answers) {
  const answered = new Set(answers.map((answer) => String(answer.id)))
  return findings.filter((finding) => REVIEW_ANSWER_REQUIRED_KINDS.includes(finding.kind) && !answered.has(finding.id))
}
