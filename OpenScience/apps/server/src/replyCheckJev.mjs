/**
 * The first pass of the reply check (L1) on TypeSafe's Jev (plan 2026-09-22
 * §6 and §13 item 1; the owner's decision of 2026-09-24, 「jev上生产」).
 *
 * Hidden knowledge: what Jev may decide, and why that is so little.
 *
 * Jev answers a typed question over a text state in about a second, at $0.042
 * per million input tokens. On 101 claim–quote pairs from real packages and
 * planted defects (wrong sentence, changed number, negation) it was right on
 * 99, and both misses were below a confidence of 0.8 (2026-09-21,
 * `.evimed-local/probes/2026-09-21-jev/claimcheck.json`). Asked in this
 * module's own form — some fifty sentences to a request, each wrong-sentence
 * pair beside the passage that truly supports it — it was right on 100, and
 * at the 0.8 gate it settled 37 of the 40 true supports and nothing else; the
 * one false `supports` sat at 0.73 (2026-09-24,
 * `.evimed-local/probes/2026-09-24-jev-l1/`). So it goes first, and settles
 * only what it is sure of and what it is safe for it to settle:
 *
 * - a sentence it says its cited sources support, at or above the pinned
 *   confidence gate (`typesafe.review.supportConfidence`), that names no
 *   medicine: recorded `supported`, `by: "jev"`, with no evidence text. Jev
 *   quotes nothing, and a ✓ asks nothing of the reader;
 * - everything else goes on to the reviewer model, with only those sentences:
 *   every sentence Jev is unsure of, every one it thinks unsupported (a ⚠ must
 *   quote the words it rests on, which only the reviewer gives and code then
 *   finds in the source), and every sentence naming a medicine — the safety
 *   verdict needs verbatim evidence, and Jev lost the pharmacist's cautions
 *   outright (62/73 against the term matcher's 73/73);
 * - Jev switched off, refused, failed or over its per-request ceiling: the
 *   reviewer judges every sentence, which is what L1 did before Jev.
 *
 * A Jev verdict never authorizes anything. It does not treat the state as
 * hostile (a passage telling the checker how to answer moved it, 2026-09-22),
 * so all it can do here is spare the reviewer a sentence whose support is
 * plain. Code re-reads the checkable part of its answer — the confidence is a
 * function of the probabilities it returns, and the choice their maximum — and
 * an answer that disagrees with itself decides nothing (principle 5).
 *
 * One request per reply. TypeSafe's own notes say accuracy falls as the state
 * fills with material a question does not need, so each sentence travels with
 * its own sources under its own key, and its question names that key by path
 * — the way the documentation points a question at a nested value.
 *
 * @module replyCheckJev
 */

import { acceptReplyVerdicts } from "@evimed/domain";

/**
 * The question's options, in the form the probes measured best: a three-way
 * choice whose criteria name every number (the `relation` question of the
 * 2026-09-21 claim check, 99/101). Only the nouns moved: "the quoted passage"
 * and "the claim" became a sentence's passages and the sentence.
 */
export const JEV_RELATION_CRITERIA = Object.freeze({
  supports: "The passages state the sentence or directly imply that it is true, including every number in the sentence",
  contradicts: "The passages state the opposite of the sentence, or give a different number, direction or recommendation than the sentence",
  says_nothing: "The passages do not address what the sentence asserts, either way",
});

/** @param {string} id the item's key, `S<index>` */
function relationQuestion(id) {
  return {
    type: "choice",
    instructions: `How do the passages in \`items.${id}.sources\` relate to the sentence \`items.${id}.sentence\`? The sentence may be in Chinese and the passages in English; judge meaning, not wording.`,
    criteria: JEV_RELATION_CRITERIA,
  };
}

/**
 * The Jev request for a reply's cited sentences: one item per sentence Jev
 * may settle — the sentence as written, and the readable text of each source
 * it cites — and one question per item.
 *
 * Not asked: a sentence naming a medicine (the reviewer's, always), and one
 * none of whose sources could be read (code calls it unresolvable).
 *
 * @param {{ sentences: readonly { index: number, sentence: string, numbers: number[], medicines: string[] }[], readable: ReadonlyMap<number, string> }} input
 * @returns {{ state: { items: Record<string, { sentence: string, sources: Record<string, string> }> }, questions: Record<string, ReturnType<typeof relationQuestion>>, asked: number[], medicine: number[] }}
 */
export function jevReplyRequest({ sentences, readable }) {
  /** @type {Record<string, { sentence: string, sources: Record<string, string> }>} */
  const items = {};
  /** @type {Record<string, ReturnType<typeof relationQuestion>>} */
  const questions = {};
  /** @type {number[]} */
  const asked = [];
  /** @type {number[]} */
  const medicine = [];
  for (const sentence of sentences) {
    /** @type {Record<string, string>} */
    const sources = {};
    for (const number of sentence.numbers) {
      const text = readable.get(number);
      if (typeof text === "string" && text.trim()) sources[`[${number}]`] = text;
    }
    if (!Object.keys(sources).length) continue;
    if (sentence.medicines.length) {
      medicine.push(sentence.index);
      continue;
    }
    const id = `S${sentence.index}`;
    items[id] = { sentence: sentence.sentence, sources };
    questions[id] = relationQuestion(id);
    asked.push(sentence.index);
  }
  return { state: { items }, questions, asked, medicine };
}

/**
 * The confidence a choice answer's own probabilities give it:
 * (k·p_max − 1)/(k − 1) over its k options (docs.typesafe.ai/confidence), and
 * which option is their maximum. Null when the answer is not a choice over
 * exactly the options asked, or its probabilities are not a distribution.
 * @param {any} answer
 * @returns {{ choice: string, confidence: number } | null}
 */
function choiceOfProbabilities(answer) {
  const options = Object.keys(JEV_RELATION_CRITERIA);
  const probabilities = answer?.probabilities;
  if (answer?.type !== "choice" || !probabilities || typeof probabilities !== "object") return null;
  const keys = Object.keys(probabilities);
  if (keys.length !== options.length || !options.every((option) => keys.includes(option))) return null;
  const values = options.map((option) => Number(probabilities[option]));
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  // Two-decimal rounding on the wire: three values can miss 1 by a few hundredths.
  if (Math.abs(total - 1) > 0.05) return null;
  const top = Math.max(...values);
  const leaders = options.filter((_option, index) => values[index] === top);
  if (leaders.length !== 1) return null;
  const k = options.length;
  return { choice: leaders[0], confidence: Math.max(0, Math.min(1, (k * top - 1) / (k - 1))) };
}

/**
 * Which asked sentences Jev settles: those it answered `supports` at or above
 * the gate, where the answer's reported confidence and the one its own
 * probabilities give both clear the gate and its choice is their maximum.
 * @param {Record<string, any> | null | undefined} answers
 * @param {{ asked: readonly number[], threshold: number }} gate
 * @returns {{ decided: Map<number, number>, escalated: number[] }} `decided` maps a sentence index to the confidence it was settled at
 */
export function jevDecisions(answers, { asked, threshold }) {
  /** @type {Map<number, number>} */
  const decided = new Map();
  /** @type {number[]} */
  const escalated = [];
  const gate = Number(threshold);
  for (const index of asked) {
    const answer = answers?.[`S${index}`];
    const derived = choiceOfProbabilities(answer);
    const reported = Number(answer?.confidence);
    const confidence = derived && Number.isFinite(reported) ? Math.min(reported, derived.confidence) : Number.NaN;
    if (gate > 0 && answer?.choice === "supports" && derived?.choice === "supports" && confidence >= gate) decided.set(index, confidence);
    else escalated.push(index);
  }
  return { decided, escalated };
}

/**
 * @typedef {object} JevPassSummary
 * @property {'off'|'none'|'answered'|'failed'|'too_large'} outcome
 *   `none`: nothing Jev may settle (every cited sentence names a medicine or
 *   cites nothing readable), so no request was made
 * @property {string | null} code the failure's code, when it failed
 * @property {number} asked sentences put to Jev
 * @property {number} decided sentences Jev settled
 * @property {number} escalated sentences Jev answered and the reviewer took
 * @property {number} medicine sentences never put to Jev because they name a medicine
 */

/**
 * Judge a reply's cited sentences: Jev first where it may settle one, the
 * reviewer model for the rest. The reviewer's answer is held to the same rule
 * as before (`acceptReplyVerdicts`: evidence found in the source, or the
 * verdict is `uncertain`; a sentence whose sources could not be read is
 * `unresolvable`). A Jev failure is never the check's failure; a reviewer
 * failure is, as it always was, and the check is tried again.
 *
 * @param {{
 *   sentences: readonly any[], references: readonly any[], readable: ReadonlyMap<number, string>,
 *   threshold: number,
 *   jev: null | ((request: { state: any, questions: Record<string, any> }) => Promise<{ answers: Record<string, any>, model: string, cost: number }>),
 *   reviewer: (input: { sentences: readonly any[], references: readonly any[] }) => Promise<{ value: any, model: string, cost: number }>,
 *   onJev?: (summary: JevPassSummary) => void,
 * }} input
 *   `onJev` hears how the first pass ended as soon as it has, before the
 *   reviewer is asked: a Jev call is spent even when the reviewer then fails
 * @returns {Promise<{ verdicts: any[], cost: number, models: string[], jev: JevPassSummary }>}
 */
export async function judgeCitedSentences({ sentences, references, readable, threshold, jev, reviewer, onJev = () => {} }) {
  /** @type {JevPassSummary} */
  const summary = { outcome: "off", code: null, asked: 0, decided: 0, escalated: 0, medicine: 0 };
  let cost = 0;
  /** @type {string[]} */
  const models = [];
  /** @type {Map<number, any>} */
  const settled = new Map();
  if (jev) {
    const request = jevReplyRequest({ sentences, readable });
    summary.medicine = request.medicine.length;
    summary.asked = request.asked.length;
    summary.outcome = request.asked.length ? "answered" : "none";
    if (request.asked.length) {
      try {
        const answer = await jev({ state: request.state, questions: request.questions });
        cost += Number(answer.cost) || 0;
        models.push(answer.model);
        const { decided, escalated } = jevDecisions(answer.answers, { asked: request.asked, threshold });
        for (const [index, confidence] of decided) {
          settled.set(index, { sentence: index, verdict: "supported", reason: "", evidence: "", safety: "none", by: "jev", confidence });
        }
        summary.decided = decided.size;
        summary.escalated = escalated.length;
      } catch (error) {
        summary.code = String(/** @type {any} */ (error)?.code ?? "jev_failed").slice(0, 64);
        summary.outcome = summary.code === "jev_request_too_large" ? "too_large" : "failed";
      }
    }
    onJev({ ...summary });
  }
  const rest = sentences.filter((sentence) => !settled.has(sentence.index));
  /** @type {any[]} */
  let reviewed = [];
  if (rest.length) {
    const restReferences = references.filter((reference) => rest.some((sentence) => sentence.numbers.includes(reference.number)));
    const readableRest = rest.some((sentence) => sentence.numbers.some((/** @type {number} */ number) => {
      const text = readable.get(number);
      return typeof text === "string" && Boolean(text.trim());
    }));
    const answer = readableRest ? await reviewer({ sentences: rest, references: restReferences }) : null;
    if (answer) {
      cost += Number(answer.cost) || 0;
      models.push(answer.model);
    }
    reviewed = acceptReplyVerdicts(answer?.value ?? { verdicts: [] }, { sentences: rest, readable });
  }
  const verdicts = [...settled.values(), ...reviewed].sort((left, right) => left.sentence - right.sentence);
  return { verdicts, cost, models: models.filter(Boolean), jev: summary };
}
