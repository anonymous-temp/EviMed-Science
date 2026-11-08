/** Passage context, chunking and a small BM25 index over one patient's records. Everything here is deterministic and format-based:
 * no medical vocabulary, no model. The host adapter builds one index per patient revision and uses it for the initial evidence
 * window's per-criterion retrieval and for the `match_evidence` search over the whole record. */

export const CHUNK_CHARACTERS = 4_000;
/** A chunk shorter than this is not cut at a section change. */
const SECTION_BREAK_MIN = 1_500;
const HEADING_MAX = 60;
const RRF_K = 60;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// ---------------------------------------------------------------------------------------------------------------------------
// Passage context
// ---------------------------------------------------------------------------------------------------------------------------

const pad = (/** @type {string|number} */ value) => String(value).padStart(2, '0');
/** @returns {string|null} ISO date when the parts form a real calendar date. */
function isoDate(/** @type {number} */ year, /** @type {number} */ month, /** @type {number} */ day) {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${year}-${pad(month)}-${pad(day)}` : null;
}
const DATE_PATTERNS = [
  { pattern: /(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/u, parts: (/** @type {string[]} */ m) => [+m[1], +m[2], +m[3]] },
  { pattern: /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/u, parts: (/** @type {string[]} */ m) => [+m[3], +m[1], +m[2]] },
  { pattern: /(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/u, parts: (/** @type {string[]} */ m) => [+m[3], +m[2], +m[1]] },
  // Chinese records write 2023年4月7日 (2026-11-08 check of the Chinese path).
  { pattern: /(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/u, parts: (/** @type {string[]} */ m) => [+m[1], +m[2], +m[3]] },
];
/** The first date in the first lines of a record, by format only; null when none (never guessed).
 * @param {string} text */
export function recordDateOf(text) {
  const head = String(text ?? '').split(/\r\n|[\r\n\u2028\u2029]/u).slice(0, 5).join('\n');
  let best = null;
  for (const { pattern, parts } of DATE_PATTERNS) {
    const match = pattern.exec(head);
    if (!match) continue;
    const [year, month, day] = parts(match);
    const iso = isoDate(year, month, day);
    if (iso && (!best || match.index < best.index)) best = { index: match.index, iso };
  }
  return best?.iso ?? null;
}

/** A heading is a short line that ends with ':' or is all upper-case letters, digits, spaces and punctuation.
 * @param {string} line @returns {string|null} the heading without its trailing colon */
export function headingOf(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed || trimmed.length > HEADING_MAX) return null;
  const colon = /[:：]$/u.test(trimmed);
  const upper = /\p{Lu}/u.test(trimmed) && trimmed === trimmed.toUpperCase() && !/\p{Ll}/u.test(trimmed);
  if (!colon && !upper) return null;
  const name = trimmed.replace(/[:：]+$/u, '').trim().slice(0, HEADING_MAX);
  return name || null;
}

/** Context of every sentence of one record: its 1-based record index, the record's date and the nearest preceding heading
 * (a heading line is its own section). Sentences carry `start`/`end` into `record.text`.
 * @param {{text:string,sentences:Array<{text:string,start:number,end:number}>}} record @param {number} recordIndex 1-based
 * @returns {Array<{recordIndex:number,recordDate:string|null,section:string|null}>} */
export function sentenceContexts(record, recordIndex) {
  const recordDate = recordDateOf(record.text);
  let section = null;
  return record.sentences.map(sentence => {
    const before = sentence.start === 0 || /[\r\n\u2028\u2029]/u.test(record.text[sentence.start - 1]);
    const after = sentence.end >= record.text.length || /[\r\n\u2028\u2029]/u.test(record.text[sentence.end]);
    if (before && after) section = headingOf(sentence.text) ?? section;
    return { recordIndex, recordDate, section };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------------------------------------

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const TOKEN = new RegExp(`[${CJK}]+|(?:(?![${CJK}])[\\p{L}\\p{N}])+`, 'gu');
const CJK_RUN = new RegExp(`^[${CJK}]+$`, 'u');

/** A light English stemmer: plurals, -ing, -ed, a trailing e. Words of three letters or fewer and numbers are left alone.
 * @param {string} word */
export function stem(word) {
  if (word.length <= 3 || !/^\p{L}+$/u.test(word)) return word;
  let w = word;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (/(?:x|z|ch|sh)es$/u.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(?:ss|us|is)$/u.test(w)) w = w.slice(0, -1);
  const strip = (/** @type {string} */ suffix) => {
    const base = w.slice(0, -suffix.length);
    if (base.length < 3 || !/[aeiouy]/u.test(base)) return false;
    w = /([^aeiouylsz])\1$/u.test(base) ? base.slice(0, -1) : base;
    return true;
  };
  if (w.endsWith('ing') && w.length > 5) strip('ing');
  else if (w.endsWith('ed') && w.length > 4) strip('ed');
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Lower-case word tokens; CJK runs become character bigrams (a single character stays one token).
 * @param {string} text @returns {string[]} */
export function tokenize(text) {
  const tokens = [];
  for (const [piece] of String(text ?? '').toLowerCase().matchAll(TOKEN)) {
    if (CJK_RUN.test(piece)) {
      const chars = [...piece];
      if (chars.length === 1) tokens.push(chars[0]);
      else for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
    } else tokens.push(stem(piece));
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------------------------
// BM25
// ---------------------------------------------------------------------------------------------------------------------------

/** @param {string[][]} documents token lists */
function buildBm25(documents) {
  const frequencies = documents.map(tokens => { const tf = new Map(); for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1); return tf; });
  const df = new Map();
  for (const tf of frequencies) for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  const lengths = documents.map(tokens => tokens.length);
  const average = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  return { frequencies, df, lengths, average, size: documents.length };
}
/** Scores per document for one query; only positive scores, in stored order.
 * @param {ReturnType<typeof buildBm25>} bm25 @param {string[]} queryTokens @returns {Array<{position:number,score:number}>} */
function scoreBm25(bm25, queryTokens) {
  const terms = [...new Set(queryTokens)].filter(token => bm25.df.has(token));
  const out = [];
  if (!terms.length) return out;
  for (let position = 0; position < bm25.size; position++) {
    const tf = bm25.frequencies[position];
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term);
      if (!f) continue;
      const n = bm25.df.get(term);
      const idf = Math.log(1 + (bm25.size - n + 0.5) / (n + 0.5));
      score += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (bm25.lengths[position] / (bm25.average || 1))));
    }
    if (score > 0) out.push({ position, score });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Chunks and the index
// ---------------------------------------------------------------------------------------------------------------------------

/** @typedef {{evidenceId:string,text:string,recordIndex?:number,recordDate?:string|null,section?:string|null}} IndexedPassage */
/** @typedef {{chunkId:string,recordIndex:number|null,recordDate:string|null,section:string|null,evidenceIds:string[],text:string}} Chunk */

/** Consecutive sentences of one record grouped into chunks of about `size` characters; never across records, and cut at a
 * section change once the chunk holds a reasonable amount.
 * @param {IndexedPassage[]} passages stored order @returns {Chunk[]} */
export function chunkPassages(passages, size = CHUNK_CHARACTERS) {
  /** @type {Chunk[]} */ const chunks = [];
  /** @type {IndexedPassage[]} */ let current = [];
  let length = 0;
  const flush = () => {
    if (!current.length) return;
    const first = current[0];
    chunks.push({ chunkId: `c:${first.evidenceId.slice(2)}`, recordIndex: first.recordIndex ?? null, recordDate: first.recordDate ?? null, section: first.section ?? null,
      evidenceIds: current.map(item => item.evidenceId), text: current.map(item => item.text).join('\n') });
    current = []; length = 0;
  };
  for (const passage of passages) {
    const last = current[current.length - 1];
    if (last && ((last.recordIndex ?? null) !== (passage.recordIndex ?? null)
      || length + passage.text.length + 1 > size
      || (length >= SECTION_BREAK_MIN && (last.section ?? null) !== (passage.section ?? null)))) flush();
    current.push(passage);
    length += passage.text.length + 1;
  }
  flush();
  return chunks;
}

/** @param {IndexedPassage[]} passages stored order
 * @returns {{passages:IndexedPassage[],chunks:Chunk[],sentenceIndex:ReturnType<typeof buildBm25>,chunkIndex:ReturnType<typeof buildBm25>,chunkVectors?:Map<string,number[]>}} */
export function buildRecordIndex(passages) {
  const chunks = chunkPassages(passages);
  return { passages, chunks, sentenceIndex: buildBm25(passages.map(item => tokenize(item.text))), chunkIndex: buildBm25(chunks.map(item => tokenize(item.text))) };
}

/** Reciprocal-rank fusion of ranked lists of keys; ties keep the order of first appearance.
 * @param {Array<Array<number>>} rankings positions, best first @returns {Array<number>} */
export function fuseRankings(rankings) {
  const scores = new Map();
  for (const ranking of rankings) ranking.forEach((position, rank) => scores.set(position, (scores.get(position) ?? 0) + 1 / (RRF_K + rank + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([position]) => position);
}

/** BM25 per query, fused by reciprocal rank; only items with a positive score in some list, ties in stored order.
 * `extraRankings` are further ranked lists of positions (the dense channel) fused alongside.
 * @param {ReturnType<typeof buildRecordIndex>} index @param {string[]} queries
 * @param {{limit?:number,unit?:'sentence'|'chunk',extraRankings?:number[][]}} [options]
 * @returns {Array<IndexedPassage|Chunk>} */
export function searchRecordIndex(index, queries, { limit = 20, unit = 'sentence', extraRankings = [] } = {}) {
  const bm25 = unit === 'chunk' ? index.chunkIndex : index.sentenceIndex;
  const items = unit === 'chunk' ? index.chunks : index.passages;
  const rankings = queries.map(query => scoreBm25(bm25, tokenize(query)).sort((a, b) => b.score - a.score || a.position - b.position).map(item => item.position)).filter(list => list.length);
  const fused = fuseRankings([...rankings, ...extraRankings.filter(list => list.length)]);
  return fused.slice(0, Math.max(0, limit)).map(position => items[position]);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Optional dense channel (off by default)
// ---------------------------------------------------------------------------------------------------------------------------

const cosine = (/** @type {number[]} */ a, /** @type {number[]} */ b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};
/** A ranked list of chunk positions by cosine similarity to the queries (best query score per chunk). Chunk vectors are cached
 * on the index, so they are computed once per patient revision. TODO: the server does not wire an embedder into the adapter yet
 * (`evidenceEmbed`), so this channel stays off in production.
 * @param {ReturnType<typeof buildRecordIndex>} index @param {string[]} queries @param {(texts:string[])=>Promise<number[][]>} embed */
export async function denseChunkRanking(index, queries, embed) {
  if (!index.chunkVectors) {
    const vectors = await embed(index.chunks.map(chunk => chunk.text));
    index.chunkVectors = new Map(index.chunks.map((chunk, position) => [chunk.chunkId, vectors[position]]));
  }
  const queryVectors = await embed(queries);
  const scored = index.chunks.map((chunk, position) => ({ position, score: Math.max(...queryVectors.map(vector => cosine(vector, /** @type {number[]} */ (index.chunkVectors?.get(chunk.chunkId))))) }));
  return scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.position - b.position).map(item => item.position);
}

/** A bounded least-recently-used cache. */
export class LruCache {
  /** @param {number} capacity */
  constructor(capacity = 32) { this.capacity = capacity; /** @type {Map<string, any>} */ this.map = new Map(); }
  /** @param {string} key */
  get(key) { if (!this.map.has(key)) return undefined; const value = this.map.get(key); this.map.delete(key); this.map.set(key, value); return value; }
  /** @param {string} key @param {any} value */
  set(key, value) { this.map.delete(key); this.map.set(key, value); while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value); return value; }
}

// ---------------------------------------------------------------------------------------------------------------------------
// The initial window and per-criterion retrieval
// ---------------------------------------------------------------------------------------------------------------------------

export const WINDOW_CHARACTERS = 60_000;
export const RETRIEVED_CHARACTERS = 20_000;
export const CHUNKS_PER_CRITERION = 3;

/** The evidence ids an execution starts with: the newest passages while they fit `windowCharacters`, then, round-robin over the
 * criteria, the best BM25 chunks of the older records (their passages outside the window), up to `retrievedCharacters`.
 * @param {ReturnType<typeof buildRecordIndex>} index @param {string[]} criteria criterion texts, in order
 * @param {{windowCharacters?:number,retrievedCharacters?:number,chunksPerCriterion?:number}} [options]
 * @returns {{window:Set<string>,retrieved:Set<string>}} */
export function initialEvidenceIds(index, criteria, { windowCharacters = WINDOW_CHARACTERS, retrievedCharacters = RETRIEVED_CHARACTERS, chunksPerCriterion = CHUNKS_PER_CRITERION } = {}) {
  const window = new Set(), retrieved = new Set();
  let characters = 0;
  for (const passage of [...index.passages].reverse()) {
    if (characters + passage.text.length > windowCharacters) break;
    characters += passage.text.length; window.add(passage.evidenceId);
  }
  if (window.size === index.passages.length) return { window, retrieved };
  const byId = new Map(index.passages.map(item => [item.evidenceId, item]));
  const lists = criteria.map(text => /** @type {Chunk[]} */ (searchRecordIndex(index, [text], { limit: index.chunks.length, unit: 'chunk' }))
    .filter(chunk => chunk.evidenceIds.some(id => !window.has(id))).slice(0, chunksPerCriterion));
  let used = 0;
  for (let rank = 0; rank < chunksPerCriterion; rank++) {
    for (const list of lists) {
      const chunk = list[rank];
      if (!chunk) continue;
      const fresh = chunk.evidenceIds.filter(id => !window.has(id) && !retrieved.has(id));
      const size = fresh.reduce((sum, id) => sum + (byId.get(id)?.text.length ?? 0), 0);
      if (used + size > retrievedCharacters) continue;
      for (const id of fresh) retrieved.add(id);
      used += size;
    }
  }
  return { window, retrieved };
}
