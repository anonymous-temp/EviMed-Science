/**
 * The one tokenizer for a question and for text searched against it: Latin words and CJK runs, plus every CJK bigram of a run of
 * three or more — a two-character Chinese term is a word, and splitting on whitespace alone would find none. The knowledge base's
 * chunker and its index read their terms from here (`kbChunker.mjs`, `kbIndex.mjs`).
 */

/** Query terms: the first 64 of a question's tokens. @param {unknown} value @returns {string[]} */
export function searchTokens(value) {
  const normalized = String(value ?? "").toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9._-]{1,}|[㐀-鿿]{2,}/g) ?? []);
  for (const run of normalized.match(/[㐀-鿿]{3,}/g) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return [...tokens].filter((token) => token.length >= 2).slice(0, 64);
}
