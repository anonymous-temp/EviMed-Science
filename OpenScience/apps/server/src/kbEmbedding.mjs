import { HttpError } from "./security.mjs";

/**
 * Embeddings for the knowledge-base index, through DashScope's native endpoint.
 *
 * Hidden knowledge (help.aliyun.com/zh/model-studio/text-embedding-synchronous-api,
 * read 2026-09-19): the model encodes a question and a passage differently
 * when told which is which — `parameters.text_type` `query` or `document`, and
 * an English `instruct` that applies to queries only. The OpenAI-compatible
 * endpoint the memory index uses accepts neither, which is why a query there is
 * encoded as a document; this index is built right from the start (plan §3.4
 * #4). Same model and width as the memory index's pin, so one key and one price
 * cover both. At most 20 texts per request for this model family; ten keeps a
 * request well inside its token budget with ~1000-token chunks.
 *
 * The key never leaves this module: an upstream error is reported by status,
 * never by echoing the response body, which is where a rejected key comes back.
 */

const NATIVE_PATH = "/api/v1/services/embeddings/text-embedding/text-embedding";
const BATCH = 10;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** What a question is, for the embedder (English, as the documentation asks). */
export const KB_QUERY_INSTRUCT = "Given a question from a clinical pharmacist or medical researcher, retrieve the passages of their own documents that answer it";

export class KbEmbedder {
  /**
   * @param {{ apiKey?: string, model?: string, dimension?: number, apiBase?: string, timeoutMs?: number }} options
   * @param {{ fetchImpl?: typeof fetch }} [dependencies]
   */
  constructor({ apiKey = "", model = "", dimension = 1024, apiBase = "", timeoutMs = 30_000 } = {}, { fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = String(apiKey ?? "");
    this.model = String(model ?? "");
    this.dimension = Number(dimension);
    this.endpoint = apiBase ? `${String(apiBase).replace(/\/+$/, "")}${NATIVE_PATH}` : "";
    this.timeoutMs = Math.max(1_000, Math.min(300_000, Number(timeoutMs) || 30_000));
    this.fetchImpl = fetchImpl;
    /** Observable counters (principle 15): what embedding has cost so far. */
    this.counters = { requests: 0, texts: 0, tokens: 0, failures: 0 };
  }

  get configured() {
    return Boolean(this.apiKey && this.model && this.endpoint && Number.isSafeInteger(this.dimension) && this.dimension > 0);
  }

  /** The label stored with each document's vectors: a change of model or width
   *  is a re-embedding, found by comparing this string. */
  get modelKey() { return `${this.model}@${this.dimension}`; }

  /** @param {string[]} texts @returns {Promise<number[][]>} */
  async embedDocuments(texts) {
    const vectors = [];
    for (let at = 0; at < texts.length; at += BATCH) vectors.push(...await this.#embed(texts.slice(at, at + BATCH), "document"));
    return vectors;
  }

  /** @param {string} text @returns {Promise<number[]>} */
  async embedQuery(text) {
    const [vector] = await this.#embed([text], "query", KB_QUERY_INSTRUCT);
    return vector;
  }

  /** @param {string[]} texts @param {"query"|"document"} textType @param {string} [instruct] */
  async #embed(texts, textType, instruct = "") {
    if (!this.configured) throw new HttpError(503, "kb_embedding_unconfigured", "Knowledge-base embeddings are not configured.");
    if (!texts.length) return [];
    this.counters.requests += 1;
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model: this.model, input: { texts },
          parameters: { dimension: this.dimension, text_type: textType, ...(instruct ? { instruct } : {}) } }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.counters.failures += 1;
      throw new HttpError(503, error?.name === "TimeoutError" ? "kb_embedding_timeout" : "kb_embedding_unavailable", "The embedding service did not answer.");
    }
    if (!response.ok) {
      this.counters.failures += 1;
      await response.body?.cancel().catch(() => {});
      throw new HttpError(response.status === 401 || response.status === 403 ? 502 : 503,
        response.status === 401 || response.status === 403 ? "kb_embedding_auth_failed" : "kb_embedding_upstream_error",
        `The embedding service answered HTTP ${response.status}.`);
    }
    let parsed;
    try {
      const body = await response.text();
      if (body.length > MAX_RESPONSE_BYTES) throw new Error("oversized");
      parsed = JSON.parse(body);
    } catch {
      this.counters.failures += 1;
      throw new HttpError(502, "kb_embedding_response_invalid", "The embedding service returned an unusable answer.");
    }
    const rows = Array.isArray(parsed?.output?.embeddings) ? parsed.output.embeddings : [];
    /** @type {number[][]} */
    const vectors = new Array(texts.length);
    for (const row of rows) {
      const index = row?.text_index;
      const vector = row?.embedding;
      if (!Number.isInteger(index) || index < 0 || index >= texts.length || !Array.isArray(vector) || vector.length !== this.dimension
        || !vector.every(Number.isFinite)) {
        this.counters.failures += 1;
        throw new HttpError(502, "kb_embedding_response_invalid", "The embedding service returned vectors of the wrong shape.");
      }
      vectors[index] = vector;
    }
    if (vectors.some((vector) => !vector)) {
      this.counters.failures += 1;
      throw new HttpError(502, "kb_embedding_response_invalid", "The embedding service left texts without vectors.");
    }
    this.counters.texts += texts.length;
    this.counters.tokens += Number(parsed?.usage?.total_tokens ?? parsed?.usage?.input_tokens ?? 0) || 0;
    return vectors;
  }
}
