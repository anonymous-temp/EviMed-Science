/**
 * Definition cards: for each clause of a trial's eligibility text, a short note of what would count and what would not (build; measured later).
 *
 * A criterion such as 「adequate organ function」 or 「prior platinum-based therapy」 is read by the model that judges the patient, which brings its own
 * idea of the terms. A definition card writes that idea down once per trial, before any patient is read — from the model's knowledge and, where
 * one was retrieved for the clause, a guideline passage — and the clause-level calls of every patient read the same card as background. It is
 * context for a reading, never a fact about a patient and never a verdict; the patient's note decides.
 *
 * Hidden knowledge:
 *
 * - **One call per trial, cached by the trial's text.** The card depends on the clauses and on nothing about a patient, so it is written once
 *   (`VCR_DEFINITION_PROMPT_VERSION` and the target's hash key it) and every pair that reads the trial gets the same words.
 * - **A card with no clause in it is no card.** A clause the model wrote nothing for is simply read without one; a number the model invented
 *   (a clause the trial does not have) is dropped and counted, as the clause-level answers are.
 * - **Default off.** With no definitions, `criteriaMessages` is byte-identical to what it was.
 *
 * @module vcrClauseDefinitions
 */

/** The prompt version of the card; a different version is a different set of words, so it is part of the ledger key of a judgment that read it. */
export const VCR_DEFINITION_PROMPT_VERSION = 'defs-1'

/** Where a card's words came from: the model's own knowledge, or a guideline passage retrieved for the clause. */
export const VCR_DEFINITION_SOURCES = Object.freeze(['knowledge', 'passage'])

const FIELD_MAX = 400
const PASSAGE_MAX = 800

/** @param {unknown} value @param {number} [max] */
const clip = (value, max = FIELD_MAX) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max)

const SYSTEM = [
  "You are a clinical research assistant helping to read the eligibility criteria of a clinical trial before any patient is considered.",
  'For each numbered criterion that uses a term whose meaning is not plain, write a short definition card: what would count as meeting the criterion in clinical practice (the usual thresholds, staging or grading systems, typical documentation), and what would not.',
  "Use your own medical knowledge. Where a guideline passage is supplied for a criterion, prefer it and say so. Do not make up thresholds you are not sure of: say what is usually meant and that it varies.",
  'Do not decide anything about any patient. Skip a criterion that is plain and needs no card.',
  'Write each card in the language of the criterion; keep drug, gene and trial names as written. Each field is one or two sentences.',
  'Output only a JSON dict exactly formatted as: dict{str(criterion_number): dict{"counts": str, "does_not_count": str, "source": "knowledge" or "passage"}}.',
].join('\n')

/**
 * The call that writes a trial's definition cards.
 * @param {{ title?: string, summary?: string, conditions?: readonly string[], interventions?: readonly string[],
 *   clauses: ReadonlyArray<{ number: number, text: string, lead?: string }>, passages?: Record<string, { source?: string, text: string } | null | undefined> }} input
 * `passages` is keyed by clause number: a guideline passage retrieved for that clause, if there is one.
 * @returns {Array<{ role: 'system' | 'user', content: string }>}
 */
export function definitionMessages({ title = '', summary = '', conditions = [], interventions = [], clauses, passages = {} }) {
  const words = (/** @type {{ text: string, lead?: string }} */ clause) => `${clause.lead ? `${clause.lead} ` : ''}${clause.text}`.replace(/\s*[\r\n]+\s*/gu, ' ')
  const user = [
    'Here is the clinical trial:',
    `Title: ${clip(title, 400)}`,
    ...(conditions.length ? [`Target diseases: ${conditions.join(', ')}`] : []),
    ...(interventions.length ? [`Interventions: ${interventions.join(', ')}`] : []),
    `Summary: ${clip(summary, 1_200)}`,
    '',
    'Criteria:',
    ...clauses.map((clause) => `${clause.number}. ${words(clause)}`),
    ...clauses.flatMap((clause) => {
      const passage = passages[String(clause.number)]
      return passage?.text ? [`Guideline passage for criterion ${clause.number}${passage.source ? ` (${clip(passage.source, 120)})` : ''}: ${clip(passage.text, PASSAGE_MAX)}`] : []
    }),
    '',
    'Plain JSON output:',
  ].join('\n')
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }]
}

/**
 * The cards in a model's answer: those for clauses the trial has, with both fields as short text. Anything else is dropped and counted.
 * @param {unknown} raw @param {ReadonlyArray<{ number: number }>} clauses
 * @returns {{ definitions: Array<{ number: number, counts: string, doesNotCount: string, source: 'knowledge' | 'passage' }>, dropped: number }}
 */
export function parseDefinitionsAnswer(raw, clauses) {
  let body = raw
  if (typeof body === 'string') {
    const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/u.exec(body)
    const text = (fenced ? fenced[1] : body).trim()
    const brace = text.indexOf('{')
    const last = text.lastIndexOf('}')
    try { body = JSON.parse(brace >= 0 && last > brace ? text.slice(brace, last + 1) : text) } catch { body = null }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { definitions: [], dropped: 0 }
  const known = new Set(clauses.map((clause) => clause.number))
  /** @type {Array<{ number: number, counts: string, doesNotCount: string, source: 'knowledge' | 'passage' }>} */
  const definitions = []
  let dropped = 0
  for (const [key, value] of Object.entries(/** @type {Record<string, any>} */ (body))) {
    const number = Number(key)
    const counts = clip(value?.counts)
    const doesNotCount = clip(value?.does_not_count ?? value?.doesNotCount)
    if (!Number.isInteger(number) || !known.has(number) || !value || typeof value !== 'object' || (!counts && !doesNotCount)) { dropped += 1; continue }
    definitions.push({ number, counts, doesNotCount, source: value.source === 'passage' ? 'passage' : 'knowledge' })
  }
  definitions.sort((a, b) => a.number - b.number)
  return { definitions, dropped }
}

/**
 * The lines a clause-level call carries for some cards: background for the clauses listed, labelled as not being about the patient.
 * @param {ReadonlyArray<{ number: number, counts: string, doesNotCount: string }>} definitions @param {ReadonlySet<number>} listed the numbers of the clauses this call carries
 * @returns {string[]} no lines when no card is for a clause of this call
 */
export function definitionLines(definitions, listed) {
  const own = definitions.filter((card) => listed.has(card.number) && (card.counts || card.doesNotCount))
  if (!own.length) return []
  return [
    '',
    'Background notes on some of the criteria above, from general medical knowledge. They say what a term usually means, not what is true of this patient; the patient note decides:',
    ...own.map((card) => `${card.number}. ${[card.counts ? `Counts: ${card.counts}` : '', card.doesNotCount ? `Does not count: ${card.doesNotCount}` : ''].filter(Boolean).join(' ')}`),
  ]
}
