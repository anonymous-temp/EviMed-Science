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
 * times out or is switched off leaves the source card without a badge and the
 * verification exactly as it was. A DOI Crossref does not know (DataCite,
 * CNKI) is remembered as unknown so it is not asked again for a while.
 *
 * @module sourceUpdates
 */

import { doiOf, sourceUpdatesFromCrossref } from "@evimed/domain";

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
 * @param {{ fetchImpl?: typeof fetch, userAgent: string, timeoutMs?: number, now?: () => number }} options
 */
export function createSourceUpdateLookup({ fetchImpl = fetch, userAgent, timeoutMs = 3_000, now = Date.now }) {
  /** @type {Map<string, { at: number, updates: SourceUpdate[] | null }>} */
  const cache = new Map();
  const counts = { checked: 0, cached: 0, unknown: 0, failed: 0 };

  /** @param {string} doi @param {SourceUpdate[] | null} updates */
  const remember = (doi, updates) => {
    cache.delete(doi);
    cache.set(doi, { at: now(), updates });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  };

  /**
   * @param {readonly string[]} dois @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<Map<string, SourceUpdate[]>>} only the DOIs Crossref answered for
   */
  async function lookup(dois, { signal } = {}) {
    /** @type {Map<string, SourceUpdate[]>} */
    const found = new Map();
    /** @type {string[]} */
    const wanted = [];
    for (const raw of dois.slice(0, MAX_DOIS)) {
      const doi = doiOf(raw);
      // A comma separates Crossref filters; the rare DOI that contains one is
      // not asked, rather than asked wrongly.
      if (!doi || doi.includes(",") || wanted.includes(doi)) continue;
      const hit = cache.get(doi);
      if (hit && now() - hit.at < TTL_MS) {
        counts.cached += 1;
        if (hit.updates) found.set(doi, hit.updates);
        continue;
      }
      wanted.push(doi);
    }
    for (let start = 0; start < wanted.length; start += BATCH) {
      const batch = wanted.slice(start, start + BATCH);
      const url = new URL(CROSSREF_WORKS);
      url.searchParams.set("filter", batch.map((doi) => `doi:${doi}`).join(","));
      url.searchParams.set("select", "DOI,updated-by");
      url.searchParams.set("rows", String(batch.length));
      let items;
      try {
        const response = await fetchImpl(url, {
          headers: { accept: "application/json", "user-agent": userAgent },
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`crossref ${response.status}`);
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES) throw new Error("crossref answer too large");
        const listed = JSON.parse(text)?.message?.items;
        items = Array.isArray(listed) ? listed : [];
      } catch {
        counts.failed += batch.length;
        continue;
      }
      const answered = new Set();
      for (const item of items) {
        const doi = doiOf(item?.DOI);
        if (!doi || !batch.includes(doi)) continue;
        const updates = sourceUpdatesFromCrossref(item);
        remember(doi, updates);
        found.set(doi, updates);
        answered.add(doi);
        counts.checked += 1;
      }
      for (const doi of batch) {
        if (answered.has(doi)) continue;
        remember(doi, null);
        counts.unknown += 1;
      }
    }
    return found;
  }

  return { lookup, stats: () => ({ ...counts, cachedDois: cache.size }) };
}

/** The DOI line our own capture header carries (`open_access_full_text`). */
function doiFromCapture(text) {
  const match = /^- DOI: (\S+)$/m.exec(String(text ?? "").slice(0, 4096));
  return match ? doiOf(match[1]) : null;
}

/**
 * Put each checked source's notices beside it in a `claim_verification`
 * verdict: `source.doi` and `source.updates` (empty when Crossref knows the
 * work and it has none). A source without a DOI, or one Crossref could not
 * answer for, is left as it was.
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
    claim.sources.forEach((source, index) => {
      const origin = claim.claimType === "synthesized" ? record?.supportingSources?.[index] : record;
      const doi = doiOf(origin?.identifier) ?? doiOf(origin?.sourceUrl)
        ?? doiFromCapture(source.artifactPath ? sourceArtifacts[source.artifactPath] : null);
      if (doi) pending.push([source, doi]);
    });
  }
  if (!pending.length) return;
  let found;
  try {
    found = await lookup([...new Set(pending.map(([, doi]) => doi))], { signal });
  } catch {
    return;
  }
  for (const [source, doi] of pending) {
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
