import fs from "node:fs";

/**
 * Reordering a recall's candidates, in the control plane.
 *
 * The index ranks by vector similarity and nothing else: `find` runs the QUICK
 * retriever, which never reranks, and the endpoint that does rerank navigates
 * by directory abstracts that are never generated without a vision model — it
 * answered zero hits on our layout where `find` answered five. So the reranker
 * cannot live behind the index; it runs here, over the candidate texts a recall
 * has already hydrated from the authoritative store.
 *
 * That placement has a second property worth keeping: the text being scored is
 * the record as it exists now, not the copy the index holds, so a stale index
 * cannot influence the final order through an out-of-date abstract.
 *
 * Two things this is not. It is not a filter — it returns an order and drops
 * nothing, because which candidates reach the prompt is the caller's budget to
 * decide. And it is not required: unconfigured, or failing for any reason, it
 * returns the order it was given, so a deployment with no key and a deployment
 * whose rerank endpoint is down both answer with the vector order rather than
 * with an error.
 */

/** DashScope's native rerank path takes a different envelope from the
 *  OpenAI-compatible one, and the endpoint is the only thing that says which.
 *  This is the marker the OpenViking rerank client tests for, kept identical so
 *  that a single configured endpoint means the same thing on both sides. */
const NATIVE_PATH_MARKER = "/api/v1/services/rerank";

/** @param {string} file */
function readKeyFile(file) {
  try {
    const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.size > 8 * 1024 + 2) return { value: "", error: "memory_rerank_key_invalid" };
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return { value: "", error: "memory_rerank_key_permissions" };
      const value = fs.readFileSync(handle, "utf8").replace(/\r?\n$/, "");
      if (!value || value.includes("\u0000")) return { value: "", error: "memory_rerank_key_invalid" };
      return { value, error: null };
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return { value: "", error: "memory_rerank_key_unavailable" };
  }
}

export class MemoryRerank {
  /**
   * @param {{apiKey?:string,apiKeyFile?:string,model?:string,apiBase?:string,timeoutMs?:number,
   *   maxDocuments?:number,maxCharsPerDocument?:number,instruct?:string}} options
   * @param {{fetchImpl?:any,report?:(code:string)=>void}} [dependencies]
   */
  constructor({
    apiKey = "",
    apiKeyFile = "",
    model = "",
    apiBase = "",
    timeoutMs = 3_000,
    maxDocuments = 32,
    maxCharsPerDocument = 2_000,
    instruct = "",
  } = {}, { fetchImpl = globalThis.fetch, report = defaultReport } = {}) {
    const key = apiKeyFile ? readKeyFile(apiKeyFile) : { value: String(apiKey ?? ""), error: null };
    this.apiKey = key.value;
    this.keyError = key.error;
    this.model = String(model ?? "");
    this.apiBase = String(apiBase ?? "");
    this.timeoutMs = Math.max(100, Math.min(30_000, Number(timeoutMs) || 3_000));
    this.maxDocuments = Math.max(2, Math.min(100, Number(maxDocuments) || 32));
    this.maxCharsPerDocument = Math.max(100, Math.min(20_000, Number(maxCharsPerDocument) || 2_000));
    // qwen3-rerank's task instruction (English, per its documentation). Unset,
    // the model ranks for its default of web-search question answering.
    this.instruct = String(instruct ?? "").trim();
    this.fetchImpl = fetchImpl;
    this.report = report;
    this.lastError = this.keyError;
    this.reportedError = null;
  }

  /** True when there is somewhere to ask and something to ask it with. */
  get configured() {
    return Boolean(this.apiKey && this.model && this.apiBase && !this.keyError);
  }

  status() {
    return { configured: this.configured, code: this.lastError };
  }

  /**
   * The order these candidates should be delivered in.
   *
   * Returns indices into `documents`, always a complete permutation of them, so
   * a caller applies it without deciding what to do about a missing entry.
   *
   * @param {string} query
   * @param {string[]} documents
   * @returns {Promise<number[]>}
   */
  async order(query, documents) {
    const texts = Array.isArray(documents) ? documents : [];
    const identity = texts.map((_, index) => index);
    if (!this.configured || texts.length < 2) return identity;
    // Only the head is scored, and the tail keeps the order it arrived in.
    // Bounding the request is what makes its cost and latency a property of the
    // configuration rather than of how much the researcher happens to remember.
    const head = texts.slice(0, this.maxDocuments)
      .map((text) => String(text ?? "").slice(0, this.maxCharsPerDocument));
    const tail = identity.slice(head.length);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.apiBase, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(this.#body(String(query ?? "").slice(0, this.maxCharsPerDocument), head)),
        signal: controller.signal,
      });
    } catch (error) {
      return this.#failOpen(identity, error?.name === "AbortError" ? "memory_rerank_timeout" : "memory_rerank_unavailable");
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      return this.#failOpen(identity, response.status === 401 || response.status === 403
        ? "memory_rerank_auth_failed"
        : "memory_rerank_upstream_error");
    }
    let parsed = null;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      return this.#failOpen(identity, "memory_rerank_response_invalid");
    }
    const ordered = rankedIndices(parsed, head.length);
    if (!ordered) return this.#failOpen(identity, "memory_rerank_response_invalid");
    this.lastError = null;
    this.reportedError = null;
    return [...ordered, ...tail];
  }

  /** @param {string} query @param {string[]} documents */
  #body(query, documents) {
    const instruct = this.instruct ? { instruct: this.instruct } : {};
    return this.apiBase.includes(NATIVE_PATH_MARKER)
      ? { model: this.model, input: { query, documents }, parameters: { return_documents: false, ...instruct } }
      : { model: this.model, query, documents, top_n: documents.length, ...instruct };
  }

  /** Keep the order that arrived, and say once why it was not improved.
   *  @param {number[]} identity @param {string} code */
  #failOpen(identity, code) {
    this.lastError = code;
    // One line per outage, not per recall: a reranker that cannot be reached
    // is asked again on every question a researcher types, and a log that
    // repeats it thousands of times hides the outage it is reporting.
    if (this.reportedError !== code) {
      this.reportedError = code;
      this.report(code);
    }
    return identity;
  }
}

/** The scored order, or null when the answer does not cover the candidates.
 *
 * A short, padded or duplicated result is a shape surprise, not a partial
 * success: reordering only part of a list by scores that were computed for a
 * different list is how a reranker makes a recall worse than no reranker.
 *
 * @param {any} parsed @param {number} count @returns {number[]|null}
 */
function rankedIndices(parsed, count) {
  const results = Array.isArray(parsed?.output?.results)
    ? parsed.output.results
    : Array.isArray(parsed?.results) ? parsed.results : null;
  if (!Array.isArray(results) || results.length !== count) return null;
  const seen = new Set();
  const scored = [];
  for (const item of results) {
    const index = item?.index;
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) return null;
    seen.add(index);
    const score = Number(item?.relevance_score ?? item?.relevance_scores ?? 0);
    scored.push({ index, score: Number.isFinite(score) ? score : 0 });
  }
  // Equal scores keep the vector order the candidates arrived in, whatever
  // order the endpoint happened to list them in.
  return scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.index);
}

/** @param {string} code */
function defaultReport(code) {
  process.stderr.write(`memory rerank unavailable: ${code}\n`);
}
