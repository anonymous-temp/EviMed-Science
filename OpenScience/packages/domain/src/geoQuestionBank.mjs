/**
 * The platform's own medication-question bank (evidence-flywheel plan §5.6, F22, 2026-10-06): about sixty common medication questions
 * by drug class, none about a brand, measured once a month on the consumer AI assistants, with what that finds — the per-class accuracy
 * and how often an answer cites an EviMed page — computed here from the judged answers.
 *
 * Hidden knowledge:
 *
 * - **The questions are data, the numbers are code.** The bank is `geo/question-bank.json` (ids, a class each, the question as a person
 *   asks it) and nothing in it says what the right answer is: a question about a drug class has no single claim to be held to. The
 *   judge holds an answer to the verified claims of the platform's published cards (`geoJudge.mjs`), so a statement no card speaks to
 *   is `unverifiable` and is left out of the denominator — a class with nothing decided has no rate, never a zero.
 * - **Accuracy is the specified information's.** A class's rate is correct over correct plus wrong among the statements about
 *   indication, dosage, contraindication and adverse reaction (`geoSpecifiedInfoAccuracy`), summed over the class's answers; the other
 *   topics are counted apart. An answer that is a refusal, a failure or unjudged is neither right nor wrong and is counted as
 *   what it is.
 * - **A page of ours is matched by its host.** The share of answers citing an EviMed page is the answers with a citation whose host is
 *   the deployment's public host, over the answers that cited anything at all, so an assistant that cites nothing does not dilute it.
 *   The match is by host and not by string: a page of another site that mentions ours is not ours.
 * - **Nothing is ranked.** The summary has no order of assistants or classes beyond the bank's own: the plan declines a leaderboard.
 *
 * @module @evimed/domain/geoQuestionBank
 */

import bank from './geo/question-bank.json' with { type: 'json' }
import { GEO_SPECIFIED_TOPICS } from './geoVocabulary.mjs'

/** @param {readonly string[]} list */
const frozen = (list) => Object.freeze([...list])

/** The bank's own version: a change to the questions is a new set of the bank's project and a new comparison base. */
export const GEO_QUESTION_BANK_VERSION = bank.version
export const GEO_QUESTION_BANK_CLASSES = frozen(bank.classes.map((entry) => entry.key))
export const GEO_QUESTION_BANK_CLASS_LABELS_ZH = Object.freeze(Object.fromEntries(bank.classes.map((entry) => [entry.key, entry.label])))
/** The questions, in the bank's order. */
export const GEO_QUESTION_BANK = Object.freeze(bank.questions.map((entry) => Object.freeze({ id: entry.id, class: entry.class, text: entry.text })))

/** The class of a bank question by its text, or null. @param {unknown} text */
export function geoQuestionBankClassOf(text) {
  const wanted = typeof text === 'string' ? text.trim() : ''
  return GEO_QUESTION_BANK.find((question) => question.text === wanted)?.class ?? null
}

/**
 * The month a moment falls in, in a time zone, as `YYYY-MM`: the unit the bank is measured and published by.
 * @param {Date} date @param {string} [timeZone]
 */
export function geoQuestionBankMonth(date, timeZone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}`
}

/** @param {unknown} url @returns {string | null} */
function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase() } catch { return null }
}

/**
 * What a month of the bank found, per class and overall.
 *
 * @param {{ answers: readonly { class: string | null, engine?: string | null, status?: string | null, judged?: boolean,
 *   statements?: readonly { topic?: string, verdict?: string }[], citations?: readonly { url?: string }[] }[],
 *   publicHost?: string | null }} input
 *   `answers` are the month's answers of the bank's project, one row each; `publicHost` the host of the deployment's public address.
 */
export function summarizeQuestionBank({ answers, publicHost = null }) {
  const host = typeof publicHost === 'string' && publicHost.trim() ? publicHost.trim().toLowerCase() : null
  const blank = () => ({ answers: 0, judged: 0, refusals: 0, unjudged: 0, correct: 0, wrong: 0, decided: 0, otherDecided: 0, cited: 0, citedEviMed: 0 })
  /** @type {Record<string, ReturnType<typeof blank>>} */
  const perClass = Object.fromEntries(GEO_QUESTION_BANK_CLASSES.map((key) => [key, blank()]))
  const overall = blank()
  /** @type {Record<string, ReturnType<typeof blank>>} */
  const perEngine = {}
  const add = (/** @type {ReturnType<typeof blank>} */ into, /** @type {any} */ answer) => {
    into.answers += 1
    if (answer.status === 'refusal') into.refusals += 1
    if (answer.judged === false) { into.unjudged += 1 } else into.judged += 1
    for (const statement of answer.statements ?? []) {
      if (statement.verdict !== 'correct' && statement.verdict !== 'wrong') continue
      if (!GEO_SPECIFIED_TOPICS.includes(/** @type {any} */ (statement.topic))) { into.otherDecided += 1; continue }
      into.decided += 1
      if (statement.verdict === 'correct') into.correct += 1
      else into.wrong += 1
    }
    const urls = (answer.citations ?? []).map((/** @type {any} */ citation) => citation?.url).filter(Boolean)
    if (urls.length) {
      into.cited += 1
      if (host && urls.some((/** @type {string} */ url) => hostOf(url) === host)) into.citedEviMed += 1
    }
  }
  for (const answer of answers) {
    const key = answer.class && Object.hasOwn(perClass, answer.class) ? answer.class : null
    if (!key) continue
    add(perClass[key], answer)
    add(overall, answer)
    if (answer.engine) add(perEngine[answer.engine] ??= blank(), answer)
  }
  /** @param {ReturnType<typeof blank>} entry */
  const view = (entry) => ({
    ...entry,
    // Never zero for "nothing decided": a rate needs something right or wrong to stand on.
    rate: entry.decided ? entry.correct / entry.decided : null,
    eviMedCitedShare: entry.cited ? entry.citedEviMed / entry.cited : null,
  })
  return {
    bankVersion: GEO_QUESTION_BANK_VERSION,
    publicHost: host,
    classes: GEO_QUESTION_BANK_CLASSES.map((key) => ({ class: key, label: /** @type {Record<string, string>} */ (GEO_QUESTION_BANK_CLASS_LABELS_ZH)[key], ...view(perClass[key]) })),
    overall: view(overall),
    engines: Object.fromEntries(Object.entries(perEngine).sort(([left], [right]) => left.localeCompare(right)).map(([engine, entry]) => [engine, view(entry)])),
  }
}
