/**
 * Which component ranks the capsule's facts, and whether it can be reached.
 *
 * The capsule index (`memoryIndexing.mjs`) holds a derived copy of approved capsule facts in OpenViking, and every hit is re-read from
 * PostgreSQL before it is used. A provider answers exactly one question — which facts are relevant to this query, in what order —
 * and is the only thing this module decides: `builtin` ranks by term overlap inside the capsule service, `openviking` delegates
 * the ranking to the context engine's hierarchical retrieval.
 *
 * An account's own memory is the engine's, read through `nativeMemoryStore.mjs` and the memory gateway; the only index left here is
 * the capsule's.
 */

/** `builtin` ranks by term overlap inside the capsule service. `openviking` delegates ranking to the OpenViking context database's
 *  hierarchical retrieval. */
export const MEMORY_INDEX_PROVIDERS = Object.freeze(["builtin", "openviking"]);

/** Which provider a configuration selects, with an unknown name read as the builtin one.
 *
 *  Exported because two components have to agree on the answer and are built apart: the index that reads it, and the worker that
 *  writes into it. A writer that enqueued on a `builtin` deployment would queue work no worker claims; one that did not enqueue on
 *  an `openviking` one would leave the index empty, which is the same defect seen from the other side. */
export function selectedMemoryIndexProvider(config) {
  return memoryIndexSelection(config).provider;
}

/** Which provider a configuration selects, and why — the why is what readiness
 *  reports, because every memory evaluation so far recorded `builtin` from a
 *  deployment whose files said `openviking` (2026-09-18 review, E §10.5), and a
 *  bare provider name could not say whether that was a choice or an accident.
 *
 *  - `named`: `OPEN_SCIENCE_MEMORY_INDEX_PROVIDER` names a provider; it wins,
 *    including `builtin` on a deployment whose index is configured.
 *  - `index-configured`: unset, and an OpenViking URL and its key are both
 *    present, so the index this deployment configured is the one used.
 *  - `default`: unset and no index configured — the term matcher.
 *  - `unknown-name`: a name this build does not know, read as the term matcher.
 *
 *  @param {any} config
 *  @returns {{ provider: string, source: 'named' | 'index-configured' | 'default' | 'unknown-name', indexConfigured: boolean }} */
export function memoryIndexSelection(config) {
  const requested = String(config?.memoryIndexProvider ?? "").trim();
  const indexConfigured = Boolean(String(config?.openVikingUrl ?? "").trim())
    && Boolean(config?.openVikingApiKey) && !config?.openVikingApiKeyError;
  if (MEMORY_INDEX_PROVIDERS.includes(requested)) return { provider: requested, source: "named", indexConfigured };
  if (requested) return { provider: "builtin", source: "unknown-name", indexConfigured };
  return indexConfigured
    ? { provider: "openviking", source: "index-configured", indexConfigured }
    : { provider: "builtin", source: "default", indexConfigured };
}

export class MemoryIndexProvider {
  /**
   * @param {any} config
   * @param {{ openViking?: any, rerank?: any }} dependencies
   */
  constructor(config, { openViking = null, rerank = null } = {}) {
    this.selection = memoryIndexSelection(config);
    this.provider = this.selection.provider;
    this.openViking = openViking;
    this.rerank = rerank;
    // The relevance floor a capsule recall asks the index for (`OPEN_SCIENCE_MEMORY_SEARCH_MIN_SCORE`).
    const floor = Number(config?.memorySearchMinScore ?? 0.75);
    this.searchMinScore = Number.isFinite(floor) ? Math.max(0, Math.min(1, floor)) : 0.75;
  }

  /** True when the selected provider can actually be asked. */
  get active() {
    return this.provider === "openviking" && Boolean(this.openViking?.configured);
  }

  async status() {
    if (this.provider === "builtin") return { provider: "builtin", configured: true, connected: true, code: null };
    if (!this.openViking) return { provider: this.provider, configured: false, connected: false, code: "memory_index_client_missing" };
    return { provider: this.provider, ...(await this.openViking.status()) };
  }
}
