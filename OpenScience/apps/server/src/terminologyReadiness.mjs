/**
 * Whether the terminology file `term_normalize` reads is loaded, as a readiness fact (`checks.terminology`, 2026-11-04).
 *
 * Hidden knowledge:
 *
 * - **It is a fact and never a failure.** Without the file `term_normalize` keeps its built-in table and says so in its answer; a deployment that has not
 *   shipped it serves every other workflow, so this check is `ok` whatever it finds and reports `loaded: false` with a reason (the adapter's own word, or
 *   `file_missing`). Readiness degrades only the feature that needs it, and this feature degrades itself.
 * - **Docker runtimes reach the file through the evidence adapter**, which mounts it from the data volume (`EVIMED_TERMINOLOGY_SEARCH_URL`); the adapter's
 *   `/health` is what says whether it holds the file. A host runtime reads the file by path (`OPEN_SCIENCE_TERMINOLOGY_DB`), so there the file is looked at.
 * - **The adapter is asked at most once a minute.** Readiness is read by monitors and by the deploy gate; one answer is shared between them.
 *
 * `scripts/ops/install-terminology.mjs` puts the file into the volume and `--status` asks the same question from the operator's side.
 *
 * @module terminologyReadiness
 */

import { lstat } from "node:fs/promises";

/** The largest file the readers take (the same bound `runtimeManager.mjs` holds). */
const MAX_BYTES = 1024 * 1024 * 1024;
const CACHE_MS = 60_000;

/** @type {Map<string, { at: number, fact: Record<string, unknown> }>} */
const cache = new Map();

/**
 * @param {{ evimedAdapterUrls?: Record<string, string>, terminologyDb?: string }} config
 * @param {{ fetcher?: typeof fetch, now?: () => number }} [deps]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readinessTerminology(config, { fetcher = fetch, now = Date.now } = {}) {
  const adapter = String(config.evimedAdapterUrls?.terminologyLookup ?? "").trim();
  const file = String(config.terminologyDb ?? "").trim();
  if (!adapter && !file) return { required: false, configured: false, loaded: false };
  if (adapter) {
    let origin;
    try { origin = new URL(adapter).origin; } catch { return { required: false, configured: true, via: "adapter", loaded: false, reason: "adapter_url_invalid" }; }
    const held = cache.get(origin);
    if (held && now() - held.at < CACHE_MS) return held.fact;
    const fact = await askAdapter(origin, fetcher);
    cache.set(origin, { at: now(), fact });
    return fact;
  }
  try {
    const info = await lstat(file);
    const loaded = info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= MAX_BYTES;
    return { required: false, configured: true, via: "file", loaded, ...(loaded ? { bytes: info.size } : { reason: "file_not_usable" }) };
  } catch {
    return { required: false, configured: true, via: "file", loaded: false, reason: "file_missing" };
  }
}

/** @param {string} origin @param {typeof fetch} fetcher */
async function askAdapter(origin, fetcher) {
  try {
    const response = await fetcher(new URL("/health", origin), { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return { required: false, configured: true, via: "adapter", loaded: false, reason: `adapter_status_${response.status}` };
    const fact = /** @type {any} */ ((/** @type {any} */ (await response.json()))?.terminology ?? {});
    return fact.available === true
      ? { required: false, configured: true, via: "adapter", loaded: true, release: fact.release ?? null, entities: Number(fact.entities ?? 0) }
      : { required: false, configured: true, via: "adapter", loaded: false, reason: String(fact.reason ?? "terminology_unavailable") };
  } catch {
    return { required: false, configured: true, via: "adapter", loaded: false, reason: "adapter_unreachable" };
  }
}

/** Forget what the adapter said (tests). */
export function resetTerminologyReadiness() {
  cache.clear();
}
