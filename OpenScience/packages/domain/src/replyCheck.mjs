/**
 * The check a cited conversation reply gets after it is shown (L1).
 *
 * Hidden knowledge: what is checkable in a chat answer is its citations, and
 * only sentence by sentence. The answer persona writes `[n]` in prose and a
 * numbered list with links at the end (open-domain-answer SKILL.md), so the
 * decidable half is here — which sentence cites which entry, and which
 * identifiers that entry carries — and the judgment half ("does this source
 * support this sentence") is the reviewer model's, over the source's own
 * abstract the control plane fetched, never over what the reply says the
 * source says.
 *
 * Nothing here holds or changes a reply (principle 13). The verdicts become a
 * row under the answer — ✓ n · ⚠ m — that a reader may open; a reply naming a
 * medicine whose safety item comes back contradicted is the one case that also
 * reaches the researcher's inbox (and the chat it came from).
 *
 * The same rule as every review finding: a verdict that says "unsupported"
 * must quote the words of the abstract it rests on, and code checks the quote.
 * A verdict whose quote is not in the abstract becomes `uncertain`.
 *
 * @module @evimed/domain/replyCheck
 */

import { citationSpans, quoteIsPresent, referenceListBounds } from './clinicalEvidence.mjs'
import { referenceEntries } from './referenceResolution.mjs'
import { mentionedMedicines } from './safetyRules.mjs'

/** Sentences one reply may send to the reviewer. */
export const REPLY_CHECK_SENTENCE_LIMIT = 40

/** How one cited sentence stands against its sources. */
export const REPLY_CHECK_VERDICTS = Object.freeze(/** @type {const} */ ([
  'supported',
  'partial',
  'unsupported',
  'unresolvable',
  'uncertain',
]))

/** @typedef {typeof REPLY_CHECK_VERDICTS[number]} ReplyCheckVerdict */

export const REPLY_CHECK_VERDICT_LABELS_ZH = Object.freeze(/** @type {Record<ReplyCheckVerdict, string>} */ ({
  supported: '来源支持',
  partial: '来源部分支持',
  unsupported: '来源不支持',
  unresolvable: '来源打不开',
  uncertain: '无法判断',
}))

/** The verdicts a reader is shown as ⚠. */
export const REPLY_CHECK_WARNING_VERDICTS = Object.freeze(/** @type {readonly ReplyCheckVerdict[]} */ (['unsupported', 'unresolvable']))

/**
 * @typedef {object} CitedSentence
 * @property {number} index        0-based order in the reply
 * @property {string} sentence     as written, markers included
 * @property {number[]} numbers    the reference numbers it cites
 * @property {string[]} medicines  medicines it names (pharmacist check)
 */

/**
 * @typedef {object} ReplyReference
 * @property {number} number
 * @property {string} text
 * @property {string[]} dois
 * @property {string[]} pmids
 * @property {string[]} urls
 */

const SENTENCE_END = /(?<=[。！？!?；;])|(?<=\.)(?=\s)|\n+/u
const URL = /https?:\/\/[^\s)>\]，。]+/g

/**
 * The reply's cited sentences and the entries they cite.
 * @param {string} replyText
 * @returns {{ sentences: CitedSentence[], references: ReplyReference[], truncated: number }}
 */
export function replyCitedSentences(replyText) {
  const text = String(replyText ?? '')
  const bounds = referenceListBounds(text)
  const prose = bounds ? text.slice(0, bounds.headingStart) : text
  const references = referenceEntries(text).map((entry) => ({
    number: entry.number,
    text: entry.text,
    dois: entry.dois,
    pmids: entry.pmids,
    urls: [...new Set(entry.text.match(URL) ?? [])].map((url) => url.replace(/[.,;]+$/, '')),
  }))
  const listed = new Set(references.map((reference) => reference.number))
  /** @type {CitedSentence[]} */
  const sentences = []
  let truncated = 0
  let offset = 0
  const spans = citationSpans(prose)
  for (const part of prose.split(SENTENCE_END)) {
    const sentence = String(part ?? '')
    const start = prose.indexOf(sentence, offset)
    const end = start + sentence.length
    offset = end
    if (!sentence.trim() || start < 0) continue
    const numbers = [...new Set(spans.filter((span) => span.start >= start && span.start < end).flatMap((span) => span.numbers))]
      .filter((number) => listed.has(number))
    if (!numbers.length) continue
    if (sentences.length >= REPLY_CHECK_SENTENCE_LIMIT) {
      truncated += 1
      continue
    }
    sentences.push({ index: sentences.length, sentence: sentence.trim(), numbers, medicines: mentionedMedicines(sentence) })
  }
  return { sentences, references, truncated }
}

/** The reviewer's answer for a reply, as the strict JSON schema the provider enforces. */
export const REPLY_CHECK_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sentence', 'verdict', 'reason', 'evidence', 'safety'],
        properties: {
          sentence: { type: 'integer', description: 'The sentence number as given (S0, S1… → 0, 1…).' },
          verdict: { type: 'string', enum: ['supported', 'partial', 'unsupported', 'uncertain'] },
          reason: { type: 'string', description: 'One short sentence in the reply\'s language. Quote words with 「」, never with straight double quotes.' },
          evidence: { type: 'string', description: 'For supported, partial or unsupported: the words of the source excerpt the verdict rests on, copied exactly. Otherwise empty.' },
          safety: { type: 'string', enum: ['none', 'consistent', 'contradicted'], description: 'For a sentence marked as naming a medicine: whether what it says about dose, contraindication, interaction or monitoring contradicts the source. Otherwise none.' },
        },
      },
    },
  },
})

/**
 * @typedef {object} ReplyVerdict
 * @property {number} sentence
 * @property {ReplyCheckVerdict} verdict
 * @property {string} reason
 * @property {string} evidence
 * @property {'none'|'consistent'|'contradicted'} safety
 */

/**
 * The reviewer's verdicts, checked. A sentence whose every cited source could
 * not be read is `unresolvable` whatever the model said; a verdict whose
 * evidence is not in the source excerpts becomes `uncertain`; a sentence the
 * model skipped is `uncertain`. A safety verdict survives only with located
 * evidence, because it is the one that reaches a person's inbox.
 *
 * @param {unknown} raw
 * @param {{ sentences: readonly CitedSentence[], readable: ReadonlyMap<number, string> }} input
 *   `readable` maps a reference number to the source text the reviewer was shown
 * @returns {ReplyVerdict[]}
 */
export function acceptReplyVerdicts(raw, { sentences, readable }) {
  /** @type {Map<number, any>} */
  const answers = new Map()
  for (const entry of Array.isArray(/** @type {any} */ (raw)?.verdicts) ? /** @type {any} */ (raw).verdicts : []) {
    const index = Number(entry?.sentence)
    if (Number.isInteger(index) && !answers.has(index)) answers.set(index, entry)
  }
  return sentences.map((cited) => {
    const sources = cited.numbers.map((number) => readable.get(number)).filter((value) => typeof value === 'string' && value.trim())
    if (!sources.length) {
      return { sentence: cited.index, verdict: 'unresolvable', reason: '引用的来源打不开或查无此条。', evidence: '', safety: 'none' }
    }
    const answer = answers.get(cited.index)
    const verdict = String(answer?.verdict ?? '')
    const reason = String(answer?.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    const evidence = String(answer?.evidence ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
    const located = evidence.length >= 4 && sources.some((source) => quoteIsPresent(source, evidence))
    /** @type {'none'|'consistent'|'contradicted'} */
    const safety = cited.medicines.length && ['consistent', 'contradicted'].includes(String(answer?.safety))
      ? (answer.safety === 'contradicted' && !located ? 'none' : /** @type {'consistent'|'contradicted'} */ (answer.safety))
      : 'none'
    if (!['supported', 'partial', 'unsupported'].includes(verdict) || !located) {
      return { sentence: cited.index, verdict: 'uncertain', reason: reason || '审查者没有给出可核对的依据。', evidence: '', safety }
    }
    return { sentence: cited.index, verdict: /** @type {ReplyCheckVerdict} */ (verdict), reason, evidence, safety }
  })
}

/** @param {readonly ReplyVerdict[]} verdicts */
export function replyCheckCounts(verdicts) {
  /** @type {Record<ReplyCheckVerdict, number>} */
  const counts = { supported: 0, partial: 0, unsupported: 0, unresolvable: 0, uncertain: 0 }
  for (const verdict of verdicts) counts[verdict.verdict] += 1
  return { ...counts, contradictedSafety: verdicts.filter((verdict) => verdict.safety === 'contradicted').length }
}
