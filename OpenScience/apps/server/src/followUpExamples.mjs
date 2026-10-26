/**
 * Which examples of the follow-up judge's bank a message is shown with.
 *
 * Hidden knowledge: the judge reads one message and says which of six things it says about the work just done, and the calls that
 * matter are close ones (「这次就这样吧」 is not 「以后都这样」). The owner's condition for the sixth verdict, `adopt`, is no regex and no
 * keyword list over open language (2026-10-25): a few examples and an algorithm. The examples are data (`@evimed/domain`
 * `follow-up-examples`); the fixed contrasts are in the judge's instructions; and this module chooses the few that sit nearest the
 * message to ride in its request, by the meaning of the words — the knowledge base's own embedder, the one methods use
 * (`methodSimilarity.mjs`) — with character n-grams as the fallback when the embedder is not configured or does not answer.
 * Choosing which examples to show is retrieval, not a reading of the message, so a lexical measure is allowed to do it; what the
 * message MEANS is still the model's.
 *
 * The bank's vectors are computed once per process, in one call, and kept; a message costs one more call. A call that fails costs
 * nothing but the fallback, and is not retried for `retryAfterMs`, so an embedder that is down is one failed request and not one per
 * follow-up. The message that is embedded has already passed the same check anything the memory path would keep passes (no
 * credential, no identifier shape: `unsafeToKeep` in `learningEvidence.mjs` runs before any model sees it).
 *
 * `select` never throws: no bank is no examples, and the judge still has its fixed contrasts.
 *
 * Deletable with the bank, when a judge needs no examples.
 *
 * @module followUpExamples
 */

import { FOLLOW_UP_EXAMPLES_VERSION, followUpPool, nearestByNgrams } from "@evimed/domain/follow-up-examples";

/** How many examples a request carries beside the fixed contrasts: a prompt's size, not an opinion. */
export const FOLLOW_UP_EXAMPLES_K = 6;

/** @typedef {import("@evimed/domain/follow-up-examples").FollowUpExample} FollowUpExample */

/** @param {unknown} vector @returns {Float32Array} a unit vector; a throw when it is not finite numbers (the embedder's fault, and the caller degrades) */
function unit(vector) {
  if (!Array.isArray(vector) || vector.length === 0) throw new TypeError("follow_up_examples_vector_invalid");
  const out = new Float32Array(vector.length);
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = Number(vector[index]);
    if (!Number.isFinite(value)) throw new TypeError("follow_up_examples_vector_invalid");
    out[index] = value;
    norm += value * value;
  }
  if (norm === 0) throw new TypeError("follow_up_examples_vector_invalid");
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < out.length; index += 1) out[index] *= scale;
  return out;
}

/**
 * @param {{ embed?: ((texts: string[]) => Promise<number[][]>) | null, pool?: readonly FollowUpExample[], k?: number,
 *   retryAfterMs?: number, now?: () => number, logger?: { warn?: (message: string) => void } | null }} [options]
 *   `embed`: the control plane's embedder as a function of texts; absent means character n-grams only.
 */
export function createFollowUpExamples({ embed = null, pool = followUpPool(), k = FOLLOW_UP_EXAMPLES_K, retryAfterMs = 30_000, now = () => Date.now(), logger = null } = {}) {
  /** @type {Promise<Float32Array[]> | null} */
  let bankVectors = null;
  let retryAt = 0;
  const counters = { embedding: 0, ngram: 0, failures: 0 };

  const available = () => typeof embed === "function" && pool.length > 0 && now() >= retryAt;

  /** @param {unknown} error */
  const failed = (error) => {
    counters.failures += 1;
    bankVectors = null;
    retryAt = now() + Math.max(0, retryAfterMs);
    try { logger?.warn?.(`follow-up examples: embedding unavailable, using character n-grams (${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)})`); } catch { /* a log never decides */ }
  };

  /** The pool's vectors, one call, kept. @returns {Promise<Float32Array[]>} */
  async function poolVectors() {
    bankVectors ??= (async () => {
      const answer = await /** @type {Function} */ (embed)(pool.map((example) => example.message));
      if (!Array.isArray(answer) || answer.length !== pool.length) throw new TypeError("follow_up_examples_embedding_invalid");
      return answer.map(unit);
    })();
    return bankVectors;
  }

  /**
   * The examples nearest a message, nearest first, and how they were chosen.
   * @param {string} message
   * @param {{ limit?: number }} [options]
   * @returns {Promise<{ examples: FollowUpExample[], mode: "embedding" | "ngram", version: number }>}
   */
  async function select(message, { limit = k } = {}) {
    const text = String(message ?? "").slice(0, 600);
    if (!text.trim() || !pool.length || limit <= 0) return { examples: [], mode: "ngram", version: FOLLOW_UP_EXAMPLES_VERSION };
    if (available()) {
      try {
        const vectors = await poolVectors();
        const [answer] = await /** @type {Function} */ (embed)([text]);
        const query = unit(answer);
        if (query.length !== vectors[0].length) throw new TypeError("follow_up_examples_embedding_invalid");
        const scored = pool.map((example, index) => {
          let dot = 0;
          for (let at = 0; at < query.length; at += 1) dot += query[at] * vectors[index][at];
          return { example, index, dot };
        }).sort((left, right) => right.dot - left.dot || left.index - right.index).slice(0, limit);
        counters.embedding += 1;
        return { examples: scored.map((entry) => entry.example), mode: "embedding", version: FOLLOW_UP_EXAMPLES_VERSION };
      } catch (error) {
        failed(error);
      }
    }
    counters.ngram += 1;
    return { examples: nearestByNgrams(text, pool, limit), mode: "ngram", version: FOLLOW_UP_EXAMPLES_VERSION };
  }

  return { select, available, stats: () => ({ ...counters }) };
}
