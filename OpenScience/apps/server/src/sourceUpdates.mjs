/**
 * Retraction and correction notices for the sources a report cites, beside
 * each source in the 「依据」 popover (plan §3.9).
 *
 * Read from Crossref's record of each cited work (`updated-by`, which carries
 * the Retraction Watch database since 2023; see the domain's
 * `sourceUpdates.mjs`). The request is the one Crossref lookup a cited DOI
 * would get anyway, batched — `works?filter=doi:A,doi:B&select=DOI,updated-by`
 * answers twenty works in one call — and it is made when the report's
 * claims are verified for a reader rather than when the run cited them, so a
 * retraction published after the run still reaches the reader.
 *
 * Informational in every direction (principle 13): a lookup that fails,
 * times out or is switched off carries an explicit unavailable status and leaves
 * the quotation verification exactly as it was. A DOI Crossref does not know (DataCite,
 * CNKI) is remembered as unknown so it is not asked again for a while.
 *
 * @module sourceUpdates
 */

import { doiOf, sourceUpdatesFromCrossref } from "@evimed/domain";
import { claimEvidenceSources } from "@evimed/domain/clinical-evidence";

const CROSSREF_WORKS = "https://api.crossref.org/works";
/** Works per request; Crossref's filter list stays well under URL limits. */
const BATCH = 20;
/** DOIs one verification looks up; the gate reads at most 48 sources too. */
const MAX_DOIS = 48;
/** A retraction is rare news: half a day is fresh enough and spares Crossref. */
const TTL_MS = 12 * 60 * 60 * 1000;
/** DOIs remembered at once; the oldest answer is forgotten first. */
const MAX_ENTRIES = 5_000;
/** The answer's size ceiling; twenty works' notices are a few kilobytes. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** @typedef {{ kind: string, noticeDoi: string | null, date: string | null, source: string | null }} SourceUpdate */

/**
 * How long one batch may take by default. It was 3 s, and over the week to
 * 2026-09-26 a quarter of the lookups (60 of 241) timed out from Beijing
 * (audit I1-11): the badge is missing exactly when it would say most. Six
 * seconds, and the polite pool below, which Crossref serves from its own
 * machines rather than the shared anonymous ones. The reader's popover shows
 * the verdict either way; only the badges wait.
 */
export const SOURCE_UPDATES_DEFAULT_TIMEOUT_MS = 6_000;

/** @typedef {{ state: "no_update" | "changed" | "unknown" | "unavailable", checkedAt: string | null, reason?: string, updates: SourceUpdate[] }} SourceUpdateStatus */

/** Race both headers and streamed body consumption against the same deadline. */
async function withinDeadline(operation, signal) {
  signal.throwIfAborted();
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([operation(), aborted]); }
  finally { signal.removeEventListener("abort", listener); }
}

async function boundedResponse(response, signal) {
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await withinDeadline(() => reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
      chunks.push(Buffer.from(chunk.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { void reader.cancel().catch(() => {}); }
}

/**
 * `timeoutMs` covers the complete lookup, including all batches, attempts and bodies.
 * Retries are optional read-only GET retries; failed checks are never cached clean.
 * @param {{ fetchImpl?: typeof fetch, userAgent: string, timeoutMs?: number, now?: () => number, mailto?: string | null, maxAttempts?: number }} options
 */
export function createSourceUpdateLookup({ fetchImpl = fetch, userAgent, timeoutMs = SOURCE_UPDATES_DEFAULT_TIMEOUT_MS, now = Date.now, mailto = null, maxAttempts = 1 }) {
  const contact = typeof mailto === "string" && /^[^@\s,&=?#]+@[^@\s,&=?#]+\.[^@\s,&=?#]+$/.test(mailto.trim()) ? mailto.trim() : null;
  /** @type {Map<string, { at: number, status: SourceUpdateStatus }>} */
  const cache = new Map();
  const counts = { checked: 0, cached: 0, unknown: 0, failed: 0 };
  const attempts = Math.min(2, Math.max(1, Math.floor(maxAttempts)));

  /** @param {string} doi @param {SourceUpdateStatus} status */
  const remember = (doi, status) => {
    cache.delete(doi);
    cache.set(doi, { at: now(), status });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  };

  /** @param {readonly string[]} dois @param {{ signal?: AbortSignal }} [options] */
  async function lookupStatuses(dois, { signal: callerSignal } = {}) {
    /** @type {Map<string, SourceUpdateStatus>} */
    const found = new Map();
    const wanted = [];
    const seen = new Set();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Source update deadline exceeded", "TimeoutError")), timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    try {
      for (const raw of dois) {
        const doi = doiOf(raw);
        if (!doi || seen.has(doi)) continue;
        seen.add(doi);
        if (doi.includes(",") || seen.size > MAX_DOIS) {
          found.set(doi, { state: "unknown", checkedAt: null, reason: doi.includes(",") ? "unsupported_identifier" : "lookup_limit", updates: [] });
          continue;
        }
        const hit = cache.get(doi);
        if (hit && now() - hit.at < TTL_MS) {
          counts.cached += 1;
          found.set(doi, structuredClone(hit.status));
        } else wanted.push(doi);
      }
      for (let start = 0; start < wanted.length; start += BATCH) {
        const batch = wanted.slice(start, start + BATCH);
        const url = new URL(CROSSREF_WORKS);
        url.searchParams.set("filter", batch.map(doi => `doi:${doi}`).join(","));
        url.searchParams.set("select", "DOI,updated-by");
        url.searchParams.set("rows", String(batch.length));
        if (contact) url.searchParams.set("mailto", contact);
        let items;
        let reason = "lookup_failed";
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          let response;
          try {
            response = await withinDeadline(() => fetchImpl(url, {
              headers: { accept: "application/json", "user-agent": userAgent }, redirect: "error", signal,
            }), signal);
            if (!response.ok) {
              reason = `http_${response.status}`;
              void response.body?.cancel().catch(() => {});
              if (![429, 502, 503, 504].includes(response.status) || attempt + 1 >= attempts) break;
              const retryAfter = response.headers.get("retry-after");
              const delay = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000
                : retryAfter && Number.isFinite(Date.parse(retryAfter)) ? Math.max(0, Date.parse(retryAfter) - Date.now()) : 0;
              if (delay) await withinDeadline(() => new Promise(resolve => {
                const wait = setTimeout(resolve, delay);
                signal.addEventListener("abort", () => clearTimeout(wait), { once: true });
              }), signal);
              continue;
            }
            const listed = (await boundedResponse(response, signal))?.message?.items;
            if (!Array.isArray(listed)) throw new Error("invalid_response");
            items = listed;
            break;
          } catch (error) {
            reason = callerSignal?.aborted ? "canceled" : signal.aborted ? "timeout"
              : ["invalid_response", "response_too_large"].includes(error?.message) ? error.message : "lookup_failed";
            break;
          }
        }
        const checkedAt = new Date(now()).toISOString();
        if (!items) {
          counts.failed += batch.length;
          for (const doi of batch) found.set(doi, { state: "unavailable", checkedAt, reason, updates: [] });
          continue;
        }
        const answered = new Set();
        for (const item of items) {
          const doi = doiOf(item?.DOI);
          if (!doi || !batch.includes(doi) || answered.has(doi)) continue;
          const updates = sourceUpdatesFromCrossref(item);
          const status = { state: /** @type {"changed" | "no_update"} */ (updates.length ? "changed" : "no_update"), checkedAt, updates };
          remember(doi, status); found.set(doi, structuredClone(status)); answered.add(doi); counts.checked += 1;
        }
        for (const doi of batch) {
          if (answered.has(doi)) continue;
          const status = { state: /** @type {const} */ ("unknown"), checkedAt, reason: "not_in_crossref", updates: [] };
          remember(doi, status); found.set(doi, structuredClone(status)); counts.unknown += 1;
        }
      }
      return found;
    } finally { clearTimeout(timer); }
  }

  /**
   * Compatibility projection: only Crossref-answered DOIs appear as map entries.
   * `statuses` additionally records every lookup outcome for readers and impact handling.
   * @param {readonly string[]} dois @param {{ signal?: AbortSignal }} [options]
   */
  async function lookup(dois, options = {}) {
    const statuses = await lookupStatuses(dois, options);
    /** @type {Map<string, SourceUpdate[]> & { statuses?: Map<string, SourceUpdateStatus> }} */
    const found = new Map();
    for (const [doi, status] of statuses) if (["changed", "no_update"].includes(status.state)) found.set(doi, status.updates);
    Object.defineProperty(found, "statuses", { value: statuses });
    return found;
  }
  return { lookup, lookupStatuses, stats: () => ({ ...counts, cachedDois: cache.size }) };
}

/** The DOI line our own capture header carries (`open_access_full_text`). */
function doiFromCapture(text) {
  const match = /^- DOI: (\S+)$/m.exec(String(text ?? "").slice(0, 4096));
  return match ? doiOf(match[1]) : null;
}

/**
 * Put each checked source's notices beside it in a `claim_verification`
 * verdict: `source.doi` and `source.updates` (empty when Crossref knows the
 * work and it has none), plus `source.updateStatus` on every source. A missing
 * DOI, mismatched capture, unknown work or failed check is explicitly distinguished
 * without changing the claim quotation verdict.
 *
 * @param {{ claims: Array<{ claimId: string, claimType: string, sources: Array<Record<string, any>> }> }} verdict
 * @param {{ matrix: any, sourceArtifacts: Record<string, string>, lookup: ReturnType<typeof createSourceUpdateLookup>["lookup"], signal?: AbortSignal }} input
 */
export async function attachSourceUpdates(verdict, { matrix, sourceArtifacts, lookup, signal }) {
  const cited = new Map((Array.isArray(matrix?.claims) ? matrix.claims : []).map((/** @type {any} */ claim) => [String(claim?.claimId), claim]));
  /** @type {Array<[Record<string, any>, string]>} */
  const pending = [];
  for (const claim of verdict.claims) {
    const record = cited.get(claim.claimId);
    const origins = claimEvidenceSources({ ...record, claimType: claim.claimType });
    claim.sources.forEach((source, index) => {
      const origin = origins[index];
      const declaredDoi = doiOf(origin?.identifier) ?? doiOf(origin?.sourceUrl);
      const capturedDoi = doiFromCapture(source.artifactPath ? sourceArtifacts[source.artifactPath] : null);
      const doi = declaredDoi ?? capturedDoi;
      if (declaredDoi && capturedDoi && declaredDoi !== capturedDoi) {
        source.updateStatus = { state: "unknown", checkedAt: null, reason: "identifier_mismatch", updates: [] };
        return;
      }
      source.updateStatus = { state: "unknown", checkedAt: null, reason: "not_identified", updates: [] };
      if (doi) {
        source.doi = doi;
        pending.push([source, doi]);
      }
    });
  }
  if (!pending.length) return;
  let found;
  try {
    found = await lookup([...new Set(pending.map(([, doi]) => doi))], { signal });
  } catch {
    for (const [source] of pending) source.updateStatus = { state: "unavailable", checkedAt: new Date().toISOString(), reason: signal?.aborted ? "canceled" : "lookup_failed", updates: [] };
    return;
  }
  for (const [source, doi] of pending) {
    source.updateStatus = found.statuses?.get(doi) ?? {
      state: found.has(doi) ? found.get(doi).length ? "changed" : "no_update" : "unknown",
      checkedAt: null, updates: found.get(doi) ?? [], ...(found.has(doi) ? {} : { reason: "not_in_crossref" }),
    };
    if (!found.has(doi)) continue;
    source.doi = doi;
    source.updates = found.get(doi);
  }
}

/**
 * The lookup's counters for the operator's metrics endpoint.
 * @param {ReturnType<ReturnType<typeof createSourceUpdateLookup>["stats"]> | null | undefined} stats
 */
export function sourceUpdateMetricFamilies(stats) {
  if (!stats) return [];
  return [{
    name: "open_science_source_updates_total",
    help: "Cited DOIs looked up for retraction and correction notices, by outcome (answered by Crossref, served from cache, unknown to Crossref, lookup failed).",
    type: /** @type {const} */ ("counter"),
    series: [
      { value: stats.checked, labels: { outcome: "checked" } },
      { value: stats.cached, labels: { outcome: "cached" } },
      { value: stats.unknown, labels: { outcome: "unknown" } },
      { value: stats.failed, labels: { outcome: "failed" } },
    ],
  }];
}

/** A disabled checker is unavailable, never an implicit clean source. */
export function attachUnavailableSourceUpdates(verdict, reason = "disabled") {
  for (const claim of verdict.claims ?? []) for (const source of claim.sources ?? []) {
    source.updateStatus = { state: "unavailable", checkedAt: null, reason, updates: [] };
  }
}
