/**
 * Asking the registries for the trials that might take one patient, deeper than one page and for more than one phrase.
 *
 * The run writes up to 32 phrases ranked by priority (the condition first). Each registry is asked for each of them, a page at a time,
 * the earlier phrases first, and the answers come back per registry and per phrase with what every page did. Nothing here reads a trial,
 * merges or ranks: that is `vcrCandidateSearch.mjs`.
 *
 * Hidden knowledge:
 *
 * - **The clock bounds the depth.** A search that asks three registries for 32 phrases is a hundred requests, and the registries limit a
 *   caller's rate (the client spaces its requests, `paceMs`). The deployment sets a deadline for the whole retrieval; a phrase not yet
 *   started when it passes is `not_reached` and said so, a phrase whose later pages were not read keeps the pages it has.
 * - **One registry's failure is its own.** The three registries run side by side; a page that fails costs the rest of its phrase and
 *   nothing else, and a thrown error is an unavailable page, never an exception.
 * - **Depth per phrase is the share a fused list of `retrieveMax` needs**, twice over so the filters and the duplicates leave enough: 200
 *   for a few phrases, down to 20 for 32.
 *
 * @module vcrCandidateRetrieve
 */

/** Ask each registry at most this many pages of one phrase, whatever the depth: a runaway page token is not followed. */
const PAGES_MAX = 8;

/**
 * How many results of one phrase to read from one registry, for a search of `queries` phrases that keeps `retrieveMax` trials.
 * @param {number} queries @param {number} retrieveMax
 */
export function retrievalDepth(queries, retrieveMax) {
  return Math.max(20, Math.min(200, Math.ceil((2 * retrieveMax) / Math.max(1, queries))));
}

/**
 * @typedef {{ query: string, kind: string, status: "ok" | "unavailable" | "not_reached", reason: string | null, total: number | null,
 *   pages: number, items: any[], retrievedAt: string | null, truncated: string | null }} QueryResult
 * @typedef {(query: { kind: string, text: string }, page: { pageToken: string | null, limit: number }) => Promise<any>} RegistryAsk
 */

/**
 * @param {{ queries: Array<{ kind: string, text: string }>, asks: Record<string, RegistryAsk>, registries: readonly string[],
 *   retrieveMax: number, pageSizes: Record<string, number>, deadlineAt: number, concurrency?: number, now?: () => number, signal?: AbortSignal }} input
 * `pageSizes` is the most results one request of a registry returns (ChiCTR's evidence API has no second page: its size is its depth too).
 * @returns {Promise<{ results: Record<string, QueryResult[]>, depth: number, requests: number, reachedAll: boolean }>}
 */
export async function retrieveCandidates({ queries, asks, registries, retrieveMax, pageSizes, deadlineAt, concurrency = 3, now = Date.now, signal }) {
  const depth = retrievalDepth(queries.length, retrieveMax);
  let requests = 0;
  /** @type {Record<string, QueryResult[]>} */
  const results = {};

  /** @param {string} registry @param {number} at */
  async function runQuery(registry, at) {
    const query = queries[at];
    /** @type {QueryResult} */
    const out = { query: query.text, kind: query.kind, status: "not_reached", reason: "search_deadline", total: null, pages: 0, items: [], retrievedAt: null, truncated: null };
    results[registry][at] = out;
    const size = Math.max(1, Math.min(pageSizes[registry] ?? 100, depth));
    /** @type {string | null} */
    let pageToken = null;
    for (let page = 0; page < PAGES_MAX; page += 1) {
      if (signal?.aborted || now() >= deadlineAt) {
        if (out.pages) out.truncated = signal?.aborted ? "aborted" : "search_deadline";
        return;
      }
      requests += 1;
      /** @type {any} */
      let answer;
      try { answer = await asks[registry](query, { pageToken, limit: size }); }
      catch (error) { answer = { status: "registry_unavailable", reason: String(/** @type {any} */ (error)?.code ?? "request_failed"), items: [] }; }
      if (answer?.status !== "ok") {
        // A page that fails after others succeeded costs the rest of the phrase only.
        if (out.pages) { out.truncated = String(answer?.reason ?? "request_failed"); return; }
        out.status = "unavailable";
        out.reason = String(answer?.reason ?? answer?.status ?? "registry_unavailable");
        return;
      }
      const items = Array.isArray(answer.items) ? answer.items : [];
      out.status = "ok";
      out.reason = null;
      out.pages += 1;
      out.total = Number.isFinite(Number(answer.total)) ? Number(answer.total) : out.total;
      if (answer.retrievedAt && (!out.retrievedAt || answer.retrievedAt > out.retrievedAt)) out.retrievedAt = String(answer.retrievedAt);
      out.items.push(...items);
      // The registry has no more, or enough has been read, or this page was empty: stop.
      if (!answer.nextPageToken || !items.length || out.items.length >= depth || (out.total !== null && out.items.length >= out.total)) return;
      pageToken = String(answer.nextPageToken);
    }
    out.truncated = "pages_limit";
  }

  await Promise.all(registries.map(async (registry) => {
    results[registry] = queries.map((query) => ({ query: query.text, kind: query.kind, status: /** @type {const} */ ("not_reached"), reason: "search_deadline",
      total: null, pages: 0, items: [], retrievedAt: null, truncated: null }));
    let next = 0;
    // Phrases are taken in the run's order of priority, a few at a time: the registry client spaces the requests themselves.
    await Promise.all(Array.from({ length: Math.min(concurrency, queries.length) }, async () => {
      while (next < queries.length) await runQuery(registry, next++);
    }));
  }));
  const reachedAll = registries.every((registry) => results[registry].every((entry) => entry.status !== "not_reached"));
  return { results, depth, requests, reachedAll };
}
