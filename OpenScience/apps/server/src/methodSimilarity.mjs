/**
 * What a learned method is close to — by the meaning of its text, with the shared words as the fallback.
 *
 * Hidden knowledge: SkillPyramid retrieves related skills by name, description and embedding similarity, both to
 * shortlist the groups its analyser reads (SCREEN) and to find what a new skill relates to (incremental update). Ours
 * had shared words only (`candidatePairs`, two tokens in common), so two methods that say one thing in different words
 * were never grouped and two that share ordinary vocabulary were. The distiller's "related methods" were the eight most
 * recently written ones, and the mount takes the newest sixteen; none of the three asked which methods are about the
 * task. This module is the one place that answers it, so the consolidation pass, the distillation brief and the mount
 * share a single reading of "close" and a single cost.
 *
 * The embedder is the control plane's own (`KbEmbedder`, the knowledge base's DashScope pin): the caller hands in
 * `embed(texts) -> number[][]` and nothing here holds a key or a URL. Method text is the same data class as memory
 * (owner decision 2026-10-23, item 6): the name, the description, the situation it is for, and the line the researcher
 * reads for it — never a body, a transcript or a quotation.
 *
 * Vectors are kept per `methodId@contentDigest`, in memory and bounded, and not in the method's `learning` payload:
 * a 1,024-float vector is about ten kilobytes of JSON, every counter write rewrites the whole payload, and the library
 * listing reads it all, so storing vectors there would multiply the cost of the loop's most frequent write by ten for a
 * value that a restart recomputes in one batch of at most a hundred texts. The entry also holds a hash of the text that
 * was embedded, because the researcher's line and scope sit outside the digest: the same digest with new words is a miss.
 *
 * When embedding is unavailable (no embedder composed, or a call failed) every answer degrades to the lexical shortlist
 * and says so: the arrays this module returns carry a non-enumerable `mode`, `"embedding"` or `"lexical"`, so a caller
 * can put it in a job result without a comparison against a plain array breaking. `pairs` also carries `topScore`, the
 * highest cosine between any two methods whether or not it reached the floor, so a provisional floor can be read
 * against a real library. A failed call is not retried for
 * `retryAfterMs`, so an embedder that is down costs one request, not one per method per pass.
 *
 * @module methodSimilarity
 */

import { createHash } from "node:crypto";

import { METHOD_SIMILARITY_PAIR_FLOOR, METHOD_SIMILARITY_TOP_K } from "@evimed/domain";

/** How many texts one call embeds at most, and how long a method's text may be: bounds on a request, not opinions. */
const MAX_TEXTS_PER_CALL = 200;
const MAX_TEXT_CHARS = 1200;

/** @param {string} text @returns {Set<string>} Latin words longer than three letters, and overlapping Han bigrams. */
export function methodTokens(text) {
  const lowered = String(text ?? "").toLowerCase();
  const result = new Set(lowered.split(/[^a-z0-9]+/).filter((word) => word.length > 3));
  for (const span of lowered.match(/\p{Script=Han}+/gu) ?? []) {
    const characters = [...span];
    for (let index = 0; index + 1 < characters.length; index++) result.add(characters[index] + characters[index + 1]);
  }
  return result;
}

/**
 * Candidate pairs worth showing SCREEN, by shared vocabulary: deterministic and free.
 *
 * It is not the screen — the model does that — it is the bound on how much the model is asked to look at, because
 * handing an LLM a hundred methods and asking for groups costs a hundred methods of context and returns groups it
 * invented to fill the answer. It is also what the consolidation falls back to when no embedding is available.
 * @param {readonly any[]} methods
 * @returns {{a: string, b: string, overlap: number}[]}
 */
export function candidatePairs(methods) {
  const indexed = methods.map((method) => ({
    id: method.id,
    tokens: methodTokens(`${method.payload?.frontmatter?.name ?? ""} ${method.payload?.frontmatter?.description ?? ""}`),
  }));
  /** @type {{a: string, b: string, overlap: number}[]} */
  const pairs = [];
  for (let left = 0; left < indexed.length; left += 1) {
    for (let right = left + 1; right < indexed.length; right += 1) {
      let overlap = 0;
      for (const token of indexed[left].tokens) if (indexed[right].tokens.has(token)) overlap += 1;
      if (overlap >= 2) pairs.push({ a: indexed[left].id, b: indexed[right].id, overlap });
    }
  }
  return pairs.sort((one, two) => two.overlap - one.overlap || one.a.localeCompare(two.a));
}

/**
 * The text a method is embedded as: what it is called, what it does, when it applies, and the line the researcher reads
 * for it. A machine name is kebab-case, so its hyphens are spaces for the embedder.
 * @param {any} method a method document (`{id, payload}`)
 * @returns {string}
 */
export function methodText(method) {
  const payload = method?.payload ?? method ?? {};
  const frontmatter = payload.frontmatter ?? {};
  const parts = [
    String(frontmatter.name ?? "").replace(/[-_]+/g, " "),
    frontmatter.description,
    frontmatter.whenToUse,
    frontmatter.metadata?.applies_when,
    payload.display?.title,
    payload.display?.summary,
  ].map((part) => String(part ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  return parts.join("\n").slice(0, MAX_TEXT_CHARS);
}

/** @param {string} text @returns {string} */
const textHash = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

/** @param {any} method @returns {string} `methodId@contentDigest`, the vector cache's key. */
const cacheKey = (method) => `${method?.id ?? ""}@${method?.payload?.contentDigest ?? method?.digest ?? ""}`;

/**
 * A unit vector, or a refusal: a vector that is not finite numbers is the embedder's fault, and the caller degrades.
 * @param {unknown} vector @param {number} [dimension]
 * @returns {Float32Array}
 */
function unit(vector, dimension = 0) {
  if (!Array.isArray(vector) || vector.length === 0 || (dimension && vector.length !== dimension)) throw new TypeError("method_similarity_vector_invalid");
  const out = new Float32Array(vector.length);
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = Number(vector[index]);
    if (!Number.isFinite(value)) throw new TypeError("method_similarity_vector_invalid");
    out[index] = value;
    norm += value * value;
  }
  if (norm === 0) throw new TypeError("method_similarity_vector_invalid");
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < out.length; index += 1) out[index] *= scale;
  return out;
}

/** @param {Float32Array} left @param {Float32Array} right @returns {number} cosine of two unit vectors */
function dot(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index];
  return total;
}

/**
 * @template T
 * @param {T[]} list @param {"embedding" | "lexical"} mode
 * @param {number | null} [topScore] the highest cosine seen between two methods, floor or not (embedding mode)
 * @returns {T[] & {mode: "embedding" | "lexical", topScore?: number | null}}
 */
function withMode(list, mode, topScore = null) {
  Object.defineProperty(list, "mode", { value: mode, enumerable: false });
  if (topScore !== null) Object.defineProperty(list, "topScore", { value: topScore, enumerable: false });
  return /** @type {any} */ (list);
}

/** @param {any} left @param {any} right @returns {number} */
const byId = (left, right) => String(left?.id ?? "").localeCompare(String(right?.id ?? ""));

/**
 * @param {{embed?: ((texts: string[]) => Promise<number[][]>) | null, logger?: {warn?: (message: string) => void} | null,
 *   cacheLimit?: number, retryAfterMs?: number, now?: () => number}} [options]
 *   `embed`: the control plane's embedder as a function of texts; absent means lexical only.
 */
export function createMethodSimilarity({ embed = null, logger = null, cacheLimit = 2000, retryAfterMs = 30_000, now = () => Date.now() } = {}) {
  /** @type {Map<string, {hash: string, vector: Float32Array}>} */
  const cache = new Map();
  const counters = { embeddedTexts: 0, cacheHits: 0, fallbacks: 0, failures: 0 };
  let retryAt = 0;

  const available = () => typeof embed === "function" && now() >= retryAt;

  /** @param {unknown} error */
  const failed = (error) => {
    counters.failures += 1;
    counters.fallbacks += 1;
    retryAt = now() + Math.max(0, retryAfterMs);
    try { logger?.warn?.(`method similarity: embedding unavailable, using shared words (${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)})`); } catch { /* a log never decides */ }
  };

  /**
   * The unit vectors of these methods, and of extra texts, in one call for what is not cached.
   * @param {readonly any[]} methods @param {readonly string[]} [extra] texts embedded beside them (a query)
   * @returns {Promise<{methods: Float32Array[], extra: Float32Array[]}>}
   */
  async function vectors(methods, extra = []) {
    const wanted = methods.map((method) => {
      const text = methodText(method);
      return { key: cacheKey(method), text, hash: textHash(text) };
    });
    /** @type {typeof wanted} */
    const missing = [];
    /** @type {Map<string, Float32Array>} what this call uses, so a small cache cannot evict it mid-call */
    const local = new Map();
    for (const entry of wanted) {
      const hit = cache.get(entry.key);
      if (hit && hit.hash === entry.hash) {
        cache.delete(entry.key);
        cache.set(entry.key, hit);
        local.set(entry.key, hit.vector);
        counters.cacheHits += 1;
      } else if (!missing.some((other) => other.key === entry.key)) {
        missing.push(entry);
      }
    }
    const texts = [...extra, ...missing.map((entry) => entry.text)];
    if (texts.length > MAX_TEXTS_PER_CALL) throw new RangeError("method_similarity_too_many_texts");
    /** @type {Float32Array[]} */
    let fresh = [];
    if (texts.length) {
      const answer = await /** @type {Function} */ (embed)(texts);
      if (!Array.isArray(answer) || answer.length !== texts.length) throw new TypeError("method_similarity_embedding_invalid");
      const dimension = Array.isArray(answer[0]) ? answer[0].length : 0;
      fresh = answer.map((vector) => unit(vector, dimension));
      counters.embeddedTexts += texts.length;
      missing.forEach((entry, index) => {
        const vector = fresh[extra.length + index];
        local.set(entry.key, vector);
        cache.delete(entry.key);
        cache.set(entry.key, { hash: entry.hash, vector });
      });
      while (cache.size > cacheLimit) cache.delete(/** @type {string} */ (cache.keys().next().value));
    }
    return {
      methods: wanted.map((entry) => /** @type {Float32Array} */ (local.get(entry.key))),
      extra: fresh.slice(0, extra.length),
    };
  }

  /**
   * The methods nearest a text, best first: the nearest eight of a library to a request, or to a lesson.
   * `minScore` is a cosine floor for the embedding answer; the lexical answer keeps `candidatePairs`' floor of two shared
   * words (one, for a query too short to share two) and ignores it, because the two scores are not on one scale.
   * @param {string} queryText
   * @param {readonly any[]} methods method documents
   * @param {{limit?: number, minScore?: number}} [options]
   * @returns {Promise<{method: any, score: number}[] & {mode: "embedding" | "lexical"}>}
   */
  async function nearest(queryText, methods, { limit = 8, minScore } = {}) {
    const query = String(queryText ?? "").slice(0, MAX_TEXT_CHARS);
    const list = [...(methods ?? [])];
    if (!list.length || !query.trim()) return withMode([], available() ? "embedding" : "lexical");
    if (available()) {
      try {
        const { methods: methodVectors, extra: [queryVector] } = await vectors(list, [query]);
        const scored = list.map((method, index) => ({ method, score: dot(queryVector, methodVectors[index]) }))
          .filter((entry) => minScore === undefined || entry.score >= minScore)
          .sort((one, two) => two.score - one.score || byId(one.method, two.method))
          .slice(0, Math.max(0, limit));
        return withMode(scored, "embedding");
      } catch (error) {
        failed(error);
      }
    } else if (typeof embed === "function") {
      counters.fallbacks += 1;
    }
    return withMode(lexicalNearest(query, list, limit), "lexical");
  }

  /**
   * The pairs of a library that are close enough to be read together: each method's nearest `topK` neighbours at or above
   * `floor`, every unordered pair once, best first. In lexical mode the pairs are `candidatePairs`' (their `score` is the
   * count of shared words, not a cosine), with the same per-method bound. Each pair also carries `overlap`, the same number
   * under the name the consolidation's grouping already reads.
   * @param {readonly any[]} methods method documents
   * @param {{topK?: number, floor?: number}} [options]
   * @returns {Promise<{a: string, b: string, score: number, overlap: number}[] & {mode: "embedding" | "lexical", topScore?: number | null}>}
   */
  async function pairs(methods, { topK = METHOD_SIMILARITY_TOP_K, floor = METHOD_SIMILARITY_PAIR_FLOOR } = {}) {
    const list = [...(methods ?? [])];
    if (list.length < 2) return withMode([], available() ? "embedding" : "lexical");
    if (available()) {
      try {
        const { methods: methodVectors } = await vectors(list);
        /** @type {Map<string, {a: string, b: string, score: number, overlap: number}>} */
        const found = new Map();
        let top = -1;
        for (let left = 0; left < list.length; left += 1) {
          const neighbours = [];
          for (let right = 0; right < list.length; right += 1) {
            if (right === left) continue;
            const score = dot(methodVectors[left], methodVectors[right]);
            if (score > top) top = score;
            if (score >= floor) neighbours.push({ right, score });
          }
          neighbours.sort((one, two) => two.score - one.score || byId(list[one.right], list[two.right]));
          for (const { right, score } of neighbours.slice(0, Math.max(0, topK))) {
            const [first, second] = left < right ? [left, right] : [right, left];
            const key = `${first}\u0000${second}`;
            if (!found.has(key)) found.set(key, { a: list[first].id, b: list[second].id, score, overlap: score });
          }
        }
        return withMode([...found.values()].sort((one, two) => two.score - one.score || one.a.localeCompare(two.a) || one.b.localeCompare(two.b)), "embedding", Math.round(top * 1e4) / 1e4);
      } catch (error) {
        failed(error);
      }
    } else if (typeof embed === "function") {
      counters.fallbacks += 1;
    }
    return withMode(lexicalPairs(list, topK), "lexical");
  }

  return {
    methodText,
    nearest,
    pairs,
    available,
    /** What the module has done so far, for an operator's counter: texts embedded, cache hits, failures, fallbacks. */
    stats: () => ({ ...counters, cached: cache.size }),
  };
}

/** @param {string} query @param {readonly any[]} methods @param {number} limit */
function lexicalNearest(query, methods, limit) {
  const wanted = methodTokens(query);
  const floor = wanted.size < 4 ? 1 : 2;
  return methods.map((method) => {
    const tokens = methodTokens(methodText(method));
    let shared = 0;
    for (const token of wanted) if (tokens.has(token)) shared += 1;
    return { method, shared, score: shared / Math.sqrt(Math.max(1, wanted.size) * Math.max(1, tokens.size)) };
  }).filter((entry) => entry.shared >= floor)
    .sort((one, two) => two.score - one.score || byId(one.method, two.method))
    .slice(0, Math.max(0, limit))
    .map(({ method, score }) => ({ method, score }));
}

/** @param {readonly any[]} methods @param {number} topK */
function lexicalPairs(methods, topK) {
  const shortlisted = candidatePairs(methods);
  /** @type {Map<string, number>} */
  const taken = new Map();
  const kept = shortlisted.filter((pair) => {
    if ((taken.get(pair.a) ?? 0) >= topK || (taken.get(pair.b) ?? 0) >= topK) return false;
    taken.set(pair.a, (taken.get(pair.a) ?? 0) + 1);
    taken.set(pair.b, (taken.get(pair.b) ?? 0) + 1);
    return true;
  });
  return kept.map((pair) => ({ a: pair.a, b: pair.b, score: pair.overlap, overlap: pair.overlap }));
}
