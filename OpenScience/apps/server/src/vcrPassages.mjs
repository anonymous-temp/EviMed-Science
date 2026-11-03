/**
 * The parts of a long patient record that bear on one criterion (M4).
 *
 * A record past a couple of reading windows is more than a run reads in order, and the part of it a criterion asks about is a small part.
 * Instead of window after window, the run can ask for the passages of the record that carry the words of the criterion — its own wording,
 * the names of the variables it tests, and the terminology the deployment's disease pack holds for those variables (labels, Chinese labels,
 * synonyms) — and gets each with the characters it stands at, so it can read around one or write a fact with its quotation.
 *
 * **This is a retrieval hint and never a verdict.** It is lexical: it finds sentences that share words with the criterion and scores them by
 * how rare the shared words are in this very record. It reads no negation, no timing, no meaning, and so it cannot say a record is silent: a
 * passage that is not found leaves the fact unknown — never negated — and the record can still be read in windows. A fact is still written
 * with a quotation the platform checks against the document at write and again at evaluation; nothing here changes that check.
 * It runs inside the deployment, over the text the plane already served to this run, and sends nothing anywhere: what the run receives is
 * the passages, and each is recorded as a window served (`recordDocumentWindow`).
 *
 * Positions are UTF-16 offsets into the record's own text — the unit every other read of a document uses — and `text.slice(start, end)`
 * is the passage.
 *
 * @module vcrPassages
 */

import { createHash } from "node:crypto";

import { VCR_CODE_VOCABULARIES } from "./vcrMatching.mjs";

/** The most passages one request returns, the characters they come to, and the longest sentence-unit before it is cut. */
export const PASSAGES_MAX = 6;
export const PASSAGES_CHARS_MAX = 6_000;
const UNIT_CHARS_MAX = 600;
/** Neighbouring units added to a passage for context while it stays under this many characters. */
const CONTEXT_CHARS_MAX = 800;
/** Query tokens kept: a criterion with more than this many words is cut to the rarest in the record. */
const QUERY_TOKENS_MAX = 160;

/** @param {unknown} value */
const text = (value) => String(value ?? "").trim();

/**
 * The tokens of a text for a lexical match: Latin and digit words (lowercased, two characters or more, a decimal point kept inside a
 * number) and, for Chinese, each character pair of a run of Han characters. A Han character on its own between other characters (近, 者,
 * 分) is a particle or a measure and would match every sentence, so it is not a token. A reading of the characters' script, not of their
 * language.
 * @param {string} value @returns {Set<string>}
 */
export function passageTokens(value) {
  const out = new Set();
  const folded = String(value ?? "").normalize("NFKC").toLowerCase();
  for (const word of folded.match(/[a-z0-9]+(?:[.%/-][a-z0-9]+)*/g) ?? []) if (word.length >= 2) out.add(word);
  for (const run of folded.match(/\p{Script=Han}+/gu) ?? []) {
    const characters = [...run];
    for (let at = 0; at + 1 < characters.length; at += 1) out.add(characters[at] + characters[at + 1]);
  }
  return out;
}

/** @typedef {ReturnType<typeof passageTerms>} PassageTerms What a criterion is searched for with, from `passageTerms`. */

/** The variables a requirement tree names. @param {any} node @param {Set<string>} [into] @returns {Set<string>} */
function variablesOf(node, into = new Set()) {
  if (!node || typeof node !== "object") return into;
  if (typeof node.variable === "string" && node.variable) into.add(node.variable);
  for (const child of [...(Array.isArray(node.operands) ? node.operands : []), ...(node.operand ? [node.operand] : [])]) variablesOf(child, into);
  return into;
}

/**
 * What to look for to find the passages of a criterion: the words of its own wording, the words of its variables' names, and the terminology
 * the disease pack holds for them (`clinicalTerminologyContext`: a term's label, Chinese label and synonyms; a mapping's Chinese label) and
 * the words the matching vocabulary holds for a coded variable (sex). The variable's and the terminology's words weigh double: they are
 * what the record's own words are likely to be, where the criterion's wording is the registry's or the protocol's.
 * @param {{ sourceText?: unknown, requirement?: any, applicability?: any } | null} criterion
 * @param {{ terms?: any[], mappings?: any[] } | null} [terminology] @param {string | null} [query] words the run itself asked for
 * @returns {{ weights: Map<string, number>, variables: string[], fromTerminology: number }}
 */
export function passageTerms(criterion, terminology = null, query = null) {
  /** @type {Map<string, number>} */
  const weights = new Map();
  const add = (/** @type {string} */ value, /** @type {number} */ weight) => { for (const token of passageTokens(value)) weights.set(token, Math.max(weights.get(token) ?? 0, weight)); };
  const variables = [...variablesOf(criterion?.requirement), ...variablesOf(criterion?.applicability)];
  const unique = [...new Set(variables)];
  add(text(criterion?.sourceText), 1);
  add(text(query), 2);
  let fromTerminology = 0;
  for (const variable of unique) {
    add(variable.replace(/_+/g, " "), 2);
    const vocabulary = variable === "sex" || variable === "gender" ? VCR_CODE_VOCABULARIES.sex : null;
    for (const words of vocabulary ? Object.values(vocabulary) : []) for (const word of words) add(word, 2);
    for (const term of terminology?.terms ?? []) {
      if (term?.concept !== variable) continue;
      for (const word of [term.label, term.labelZh, ...(Array.isArray(term.synonyms) ? term.synonyms : [])]) { add(text(word), 2); fromTerminology += 1; }
    }
    for (const mapping of terminology?.mappings ?? []) {
      if (mapping?.concept !== variable) continue;
      for (const word of [mapping.label, mapping.labelZh]) { add(text(word), 2); fromTerminology += 1; }
    }
  }
  return { weights, variables: unique, fromTerminology };
}

/**
 * The record cut into sentence-sized units with the characters each stands at: at a line break and after a sentence's end (Chinese and
 * Latin full stops, question and exclamation marks, semicolons), and a unit longer than `UNIT_CHARS_MAX` is cut there.
 * @param {string} source @returns {Array<{ start: number, end: number }>}
 */
export function passageUnits(source) {
  /** @type {Array<{ start: number, end: number }>} */
  const units = [];
  const boundary = /[\n\r]+|[。！？；;!?]+|\.(?=\s)/gu;
  let from = 0;
  const push = (/** @type {number} */ start, /** @type {number} */ end) => {
    let at = start;
    while (end - at > UNIT_CHARS_MAX) { units.push({ start: at, end: at + UNIT_CHARS_MAX }); at += UNIT_CHARS_MAX; }
    if (end > at && source.slice(at, end).trim()) units.push({ start: at, end });
  };
  for (const match of source.matchAll(boundary)) {
    const end = (match.index ?? 0) + match[0].length;
    push(from, end);
    from = end;
  }
  push(from, source.length);
  return units;
}

/**
 * The passages of a record that carry the words of a criterion, best first by where they stand: the units whose shared words are the rarest
 * in this record, each with its neighbours for context, overlapping ones merged, at most `PASSAGES_MAX` and `PASSAGES_CHARS_MAX` characters
 * in all. A record none of whose units shares a word with the criterion has no passages — which says the words were not found, not that the
 * record says nothing.
 * @param {string} source the record's text
 * @param {{ weights: Map<string, number> }} terms from `passageTerms`
 * @returns {{ passages: Array<{ start: number, end: number, text: string, score: number, matched: string[] }>, units: number, queryTokens: number }}
 */
export function locatePassages(source, terms) {
  const units = passageUnits(source);
  if (!units.length || !terms.weights.size) return { passages: [], units: units.length, queryTokens: terms.weights.size };
  const unitTokens = units.map((unit) => passageTokens(source.slice(unit.start, unit.end)));
  /** @type {Map<string, number>} */
  const documentFrequency = new Map();
  for (const tokens of unitTokens) for (const token of tokens) if (terms.weights.has(token)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  // How rare a word is in this record: a word in every sentence says nothing about which one.
  const rarity = (/** @type {string} */ token) => Math.log(1 + units.length / (1 + (documentFrequency.get(token) ?? 0)));
  const weigh = (/** @type {string} */ token) => (terms.weights.get(token) ?? 0) * rarity(token);
  const kept = new Set([...terms.weights.keys()].filter((token) => documentFrequency.has(token))
    .sort((a, b) => weigh(b) - weigh(a) || (a < b ? -1 : 1)).slice(0, QUERY_TOKENS_MAX));
  const scored = units.map((unit, at) => {
    const matched = [...unitTokens[at]].filter((token) => kept.has(token));
    return { at, score: matched.reduce((sum, token) => sum + weigh(token), 0), matched };
  }).filter((entry) => entry.matched.length > 0);
  const best = scored.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, PASSAGES_MAX);

  // Each chosen unit with the unit before and after it while the passage stays short; passages that touch are one.
  const spans = best.map((entry) => {
    let first = entry.at;
    let last = entry.at;
    if (first > 0 && units[last].end - units[first - 1].start <= CONTEXT_CHARS_MAX) first -= 1;
    if (last + 1 < units.length && units[last + 1].end - units[first].start <= CONTEXT_CHARS_MAX) last += 1;
    return { first, last, score: entry.score, matched: entry.matched };
  }).sort((a, b) => a.first - b.first);
  /** @type {typeof spans} */
  const merged = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.first <= previous.last + 1) {
      previous.last = Math.max(previous.last, span.last);
      previous.score = Math.max(previous.score, span.score);
      previous.matched = [...new Set([...previous.matched, ...span.matched])];
    } else merged.push({ ...span });
  }
  /** @type {Array<{ start: number, end: number, text: string, score: number, matched: string[] }>} */
  const passages = [];
  let chars = 0;
  for (const span of merged) {
    const start = units[span.first].start;
    const end = units[span.last].end;
    if (passages.length && chars + (end - start) > PASSAGES_CHARS_MAX) continue;
    chars += end - start;
    passages.push({ start, end, text: source.slice(start, end), score: Math.round(span.score * 100) / 100, matched: span.matched.slice(0, 8) });
  }
  return { passages, units: units.length, queryTokens: kept.size };
}

/**
 * What a passage read is recorded as, in the shape a window read has (`clinicalDocumentWindow`): the characters served and their hash, so the
 * record of what a cloud run was shown covers a passage as it covers a window.
 * @param {{ start: number, end: number, text: string }} passage @param {number} chars the record's length
 */
export function passageWindow(passage, chars) {
  return { windowHash: createHash("sha256").update(passage.text).digest("hex"), coverage: { served: [passage.start, passage.end], extraction: "unknown", before: passage.start, after: chars - passage.end } };
}
