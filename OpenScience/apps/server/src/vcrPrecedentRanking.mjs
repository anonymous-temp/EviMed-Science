/**
 * Which of the registry trials found for a question are most like it: BM25 over the trial's words, the knowledge base's embedder over their
 * meaning, and the two put together by a weight that depends on the language of the question (algorithm round E5, 2026-11-03).
 *
 * The score used to be a weighted word overlap of the condition and the intervention, plus phase, plus design, plus whether the record has
 * results. Word overlap misses a synonym and a drug of the same class under another name, and 「has results」 is a fact about the record's
 * data, not about how like the question it is. This module scores the words with BM25 (the standard ranking function; written here, it is forty
 * lines) and the meaning with the embedder the knowledge base already uses, and fuses them. Whether it ranks better than the overlap it
 * replaces was not known when it was written; `evals/vcr-precedent-retrieval` measures it on labels that are structural, not expert, and
 * says so.
 *
 * Hidden knowledge:
 *
 * - **A channel speaks only about what it can read.** BM25 compares words, so a question written in Chinese cannot be matched against English
 *   registry records by it, and putting it into the sum at the same weight as the embedder pulled the whole ranking down in the one benchmark
 *   that measured it (Chinese questions over an English corpus: nDCG@10 0.620 for the embedder alone, 0.330 with BM25 added at equal weight).
 *   The lexical channel therefore takes its query from the Latin words of the question only; a question with no Latin word gives it the
 *   weight 0 and the embedder ranks alone. A question with English words gives the lexical channel 0.4 and the embedder 0.6, a weight chosen
 *   before the evaluation was run and not tuned on its labels. The embedder sees the whole question in whatever language it was written.
 * - **No embedder is a named fallback, not a failure.** Without a configured embedder, or when it does not answer, the order is the lexical
 *   one and the answer says so (`ranking.mode: "lexical"` and the reason). Nothing here is ever a reason to return fewer trials.
 * - **IDF is the candidate list's own.** The registry has already filtered to trials about the question, so a word every candidate holds (the
 *   condition) weighs almost nothing and a word few hold (the drug) weighs most. That is what is wanted of a re-ranking of a list; it would
 *   be the wrong statistic for ranking a registry. The Lucene form of IDF is used so a word held by all is small, never negative.
 * - **Phase and design are a small term of their own** (an eighth of the score each, as before), and 「has results」 is no term at all: it is
 *   shown beside a candidate, and breaks a tie between candidates that score the same.
 * - **Both channels are read on the list's own range.** BM25 is divided by the best candidate's, the cosines are stretched from the worst
 *   candidate's to the best's (embedding cosines of a list of trials sit in a narrow band well above 0, and the raw band would drown the
 *   lexical term whatever its weight). The score is therefore relative to the list it ranks, which is all it is for.
 * - **Vectors are kept in memory, per text and model** (bounded), so a repeated search embeds only the candidates it has not seen. A text is a
 *   registry record's title, conditions and interventions: public registry words, no patient data.
 * - **The score orders candidates and decides nothing else** (plan §6.4): pooling never reads it.
 *
 * @module vcrPrecedentRanking
 */

import { createHash } from "node:crypto";

/** The weights, stated once. `lexical` and `embedding` split the text term; the text, phase and design terms sum to 1. */
export const PRECEDENT_FUSION = Object.freeze({
  lexical: 0.4, embedding: 0.6,
  text: 0.75, phase: 0.125, design: 0.125,
});
/** BM25's two constants, at the values the original paper and Lucene both use. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** What is embedded of a record and of a question, at most (characters). */
const DOC_CHARS = 500;
const QUERY_CHARS = 400;
/** How many vectors are kept. */
const CACHE_MAX = 4000;

/** @type {Map<string, Float32Array>} */
const vectors = new Map();

/**
 * Latin words and digit groups of a text, lowercased; and, when asked, overlapping pairs of Han characters (a script's reading, not a
 * language's: the same pairs the knowledge base's passage match uses).
 * @param {unknown} value @param {{ han?: boolean }} [options]
 * @returns {string[]}
 */
export function precedentTokens(value, { han = true } = {}) {
  const folded = String(value ?? "").normalize("NFKC").toLowerCase();
  const tokens = folded.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g)?.filter((word) => word.length >= 2 || /\d/.test(word)) ?? [];
  if (han) {
    for (const run of folded.match(/\p{Script=Han}+/gu) ?? []) {
      const characters = [...run];
      if (characters.length === 1) tokens.push(characters[0]);
      for (let at = 0; at + 1 < characters.length; at += 1) tokens.push(characters[at] + characters[at + 1]);
    }
  }
  return tokens;
}

/** @param {unknown} value @returns {string[]} */
const listOf = (value) => (Array.isArray(value) ? value : value == null || value === "" ? [] : [value]).map((entry) => String(entry?.name ?? entry ?? "").trim()).filter(Boolean);

/**
 * The words a registry trial is described by: its title, its conditions and its interventions.
 * @param {any} candidate @returns {string}
 */
export function precedentText(candidate) {
  return [candidate?.title, ...listOf(candidate?.conditions), ...listOf(candidate?.interventions)].filter(Boolean).join(" ; ").slice(0, DOC_CHARS);
}

/**
 * What the question is, as the caller states it: the condition and the intervention (as one or several), and a free query when there is one.
 * @param {any} target @returns {string}
 */
export function precedentQueryText(target) {
  return [...listOf(target?.conditions), target?.condition, ...listOf(target?.interventions), target?.intervention, target?.query]
    .map((part) => String(part ?? "").trim()).filter(Boolean).join(" ; ").slice(0, QUERY_CHARS);
}

/**
 * BM25 of each document for a query, with the Lucene form of IDF over these documents (never negative).
 * @param {readonly string[]} queryTokens @param {readonly (readonly string[])[]} documents tokens of each document
 * @returns {number[]}
 */
export function bm25(queryTokens, documents) {
  const count = documents.length;
  if (!count) return [];
  const length = documents.map((tokens) => tokens.length);
  const average = length.reduce((sum, each) => sum + each, 0) / count || 1;
  const frequencies = documents.map((tokens) => {
    /** @type {Map<string, number>} */ const map = new Map();
    for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
    return map;
  });
  const held = new Map();
  for (const term of new Set(queryTokens)) held.set(term, frequencies.reduce((sum, map) => sum + (map.has(term) ? 1 : 0), 0));
  return documents.map((_, at) => {
    let score = 0;
    for (const term of new Set(queryTokens)) {
      const tf = frequencies[at].get(term) ?? 0;
      if (!tf) continue;
      const idf = Math.log(1 + (count - held.get(term) + 0.5) / (held.get(term) + 0.5));
      score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * length[at] / average));
    }
    return score;
  });
}

/** @param {Float32Array | number[]} a @param {Float32Array | number[]} b */
function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let at = 0; at < a.length; at += 1) { dot += a[at] * b[at]; na += a[at] * a[at]; nb += b[at] * b[at]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** @param {string} key */
function remember(key, vector) {
  if (vectors.size >= CACHE_MAX) vectors.delete(vectors.keys().next().value);
  vectors.set(key, Float32Array.from(vector));
}

/**
 * The vectors of some texts through the embedder, from memory where they are kept. A text is embedded the way a record is (both sides of the
 * comparison are descriptions of a trial, not a question and a passage).
 * @param {{ modelKey?: string, embedDocuments: (texts: string[]) => Promise<number[][]> }} embedder @param {readonly string[]} texts
 * @returns {Promise<Float32Array[]>}
 */
async function embedTexts(embedder, texts) {
  const key = (/** @type {string} */ text) => `${embedder.modelKey ?? ""}|${createHash("sha256").update(text).digest("hex").slice(0, 24)}`;
  const missing = [...new Set(texts.filter((text) => !vectors.has(key(text))))];
  if (missing.length) {
    const fresh = await embedder.embedDocuments(missing);
    if (!Array.isArray(fresh) || fresh.length !== missing.length) throw new TypeError("precedent_embedding_shape");
    missing.forEach((text, at) => remember(key(text), fresh[at]));
  }
  return texts.map((text) => /** @type {Float32Array} */ (vectors.get(key(text))));
}

/**
 * Put the candidates in order of how much they are like the question. Each keeps what it came with and gets a new `similarity`: the score,
 * its parts (the old word overlaps, phase and design are still there, now with `bm25` and `embedding`), and nothing about whether it has
 * results; that stays a field of the candidate and breaks a tie. `ranking` says how it was done, and why not by meaning when it was not.
 *
 * @param {{ candidates: any[], target: any, embedder?: { configured?: boolean, modelKey?: string, embedDocuments: (texts: string[]) => Promise<number[][]> } | null }} input
 *   `candidates` already carry `similarity.parts.phase` and `.design` (from `precedentSimilarity`)
 * @returns {Promise<{ candidates: any[], ranking: { mode: "hybrid" | "embedding" | "lexical", lexicalWeight: number, embeddingWeight: number, model: string | null, fallback: string | null, note: string } }>}
 */
export async function rankPrecedentCandidates({ candidates, target, embedder = null }) {
  const queryText = precedentQueryText(target);
  const queryLatin = precedentTokens(queryText, { han: false });
  const documents = candidates.map((candidate) => precedentText(candidate));
  const useEmbedder = Boolean(embedder && embedder.configured !== false && queryText && candidates.length);
  /** @type {number[] | null} */
  let meaning = null;
  /** @type {string | null} */
  let fallback = embedder && embedder.configured !== false ? null : "embedder_unconfigured";
  if (useEmbedder && embedder) {
    try {
      const [question, ...own] = await embedTexts(embedder, [queryText, ...documents]);
      meaning = own.map((vector) => cosine(question, vector));
    } catch {
      fallback = "embedder_failed";
      meaning = null;
    }
  }
  // The lexical channel's query is the question's Latin words, unless it is all there is (no embedder): then its Han pairs stand in.
  const lexicalQuery = precedentTokens(queryText, { han: meaning === null });
  const lexicalRaw = lexicalQuery.length ? bm25(lexicalQuery, documents.map((text) => precedentTokens(text, { han: meaning === null }))) : documents.map(() => 0);
  const top = Math.max(0, ...lexicalRaw);
  const lexical = lexicalRaw.map((each) => (top > 0 ? each / top : 0));
  const lexicalWeight = meaning === null ? 1 : queryLatin.length ? PRECEDENT_FUSION.lexical : 0;
  const embeddingWeight = meaning === null ? 0 : lexicalWeight === 0 ? 1 : PRECEDENT_FUSION.embedding;
  // Cosines of one list sit in a narrow band well above 0; the fusion reads them stretched to the list's own range, as BM25 is by its top.
  const low = meaning === null ? 0 : Math.min(...meaning);
  const high = meaning === null ? 0 : Math.max(...meaning);
  const stretched = (/** @type {number} */ at) => (meaning !== null && high > low ? (meaning[at] - low) / (high - low) : 0);
  const mode = meaning === null ? "lexical" : lexicalWeight === 0 ? "embedding" : "hybrid";
  const ranked = candidates.map((candidate, at) => {
    const parts = candidate.similarity?.parts ?? {};
    const phase = Number.isFinite(parts.phase) ? parts.phase : 0.5;
    const design = Number.isFinite(parts.design) ? parts.design : 0.5;
    const text = lexicalWeight * lexical[at] + embeddingWeight * stretched(at);
    const score = PRECEDENT_FUSION.text * text + PRECEDENT_FUSION.phase * phase + PRECEDENT_FUSION.design * design;
    return {
      ...candidate,
      similarity: {
        score: Math.round(score * 1000) / 1000,
        parts: { ...parts, bm25: Math.round(lexical[at] * 1000) / 1000, ...(meaning === null ? {} : { embedding: Math.round(meaning[at] * 1000) / 1000 }) },
      },
    };
  });
  // Equal scores are ordered by what the record has to read (results first), then by its number: the order never depends on the registry's.
  ranked.sort((a, b) => b.similarity.score - a.similarity.score || Number(Boolean(b.hasResults)) - Number(Boolean(a.hasResults))
    || String(a.registryId ?? "").localeCompare(String(b.registryId ?? "")));
  const note = mode === "hybrid" ? "按词面相关度和语义相似度合并排序；有没有结果数据不计入相似度，只在并列时排在前面。"
    : mode === "embedding" ? "问题里没有英文词，词面相关度对英文登记记录说不了话，只按语义相似度排序。"
      : fallback === "embedder_failed" ? "语义相似度的服务这次没有答复，只按词面相关度排序；结果的顺序可能漏掉换了说法的同类试验。"
        : "语义相似度的服务没有接入，只按词面相关度排序；结果的顺序可能漏掉换了说法的同类试验。";
  return { candidates: ranked, ranking: { mode, lexicalWeight, embeddingWeight: meaning === null ? 0 : embeddingWeight, model: meaning === null ? null : String(embedder?.modelKey ?? ""), fallback, note } };
}
