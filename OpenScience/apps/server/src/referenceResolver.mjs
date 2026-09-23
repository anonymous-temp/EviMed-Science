/**
 * Asking the registries about a report's references, and fetching what the
 * cited sources actually say.
 *
 * Hidden knowledge: the only way a citation check reaches near-zero error is
 * by asking, one reference at a time, every one (plan §4). The domain's
 * `referenceResolution.mjs` decides what the answers mean; this module gets
 * them, from the control plane, because the domain has no network and a run
 * must not be able to shape the lookup.
 *
 * Three registries, each for what it is authoritative on:
 *
 * - **Crossref** `works/<doi>` — a DOI's registered title (and, for some
 *   publishers, its abstract). A 404 there is not "no such DOI": Chinese
 *   journals, DataCite and mEDRA register elsewhere.
 * - **The DOI handle system** `doi.org/api/handles/<doi>` — whether a DOI
 *   exists at all, whoever registered it. Only its "no such handle" makes a
 *   DOI unresolvable.
 * - **PubMed** `esummary` / `efetch` — a PMID's title, its own DOI, and its
 *   abstract.
 *
 * Every failure to get an answer is `unknown`, which decides nothing: a
 * registry that timed out is not evidence that a reference is fabricated.
 * Answers are cached for a day (a DOI's existence does not change by the
 * hour), and "unknown" is never cached.
 *
 * @module referenceResolver
 */

const CROSSREF_WORKS = "https://api.crossref.org/works/";
const DOI_HANDLES = "https://doi.org/api/handles/";
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
const USER_AGENT = "EviMed-Research/1.2 (reference check)";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** PMIDs one esummary / efetch request carries. */
const PUBMED_BATCH = 150;
/** Crossref and handle lookups in flight at once. */
const DOI_CONCURRENCY = 4;
/** NCBI's pace without a key is three requests a second. */
const NCBI_INTERVAL_MS = 350;
const NCBI_INTERVAL_WITH_KEY_MS = 110;
const CACHE_TTL_MS = 24 * 60 * 60_000;
const CACHE_LIMIT = 20_000;
/** Characters of a source kept for the reviewer. */
export const SOURCE_TEXT_LIMIT = 4_000;

/**
 * One registry's answer about one identifier (the shape `@evimed/domain`'s
 * `referenceResolutionFindings` reads).
 * @typedef {{ status: 'found', title?: string, doi?: string, pmid?: string } | { status: 'not_found' } | { status: 'unknown', reason?: string }} RegistryRecord
 */

/** @param {string} value */
function stripMarkup(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    // Numeric references too: PubMed writes a Lancet decimal point as `&#xb7;`,
    // and on 2026-09-23 a reader was shown `4&#xb7;88%` as a verbatim quote.
    // `&amp;` last, so an escaped reference stays one.
    .replace(/&#x([0-9a-f]{1,6});|&#(\d{1,7});/gi, (entity, hex, decimal) => {
      const point = hex ? Number.parseInt(hex, 16) : Number(decimal);
      return point > 0x1f && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
    })
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, ncbiApiKey?: string, webReader?: any, now?: () => number }} [options]
 */
export function createReferenceResolver({ fetchImpl = globalThis.fetch, timeoutMs = 8_000, ncbiApiKey = "", webReader = null, now = () => Date.now() } = {}) {
  /** @type {Map<string, { at: number, value: any }>} */
  const cache = new Map();
  const counts = { crossref: 0, handles: 0, pubmed: 0, web: 0, cacheHits: 0, failures: 0 };
  let ncbiNext = 0;

  /** @param {string} key */
  const cached = (key) => {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (now() - entry.at > CACHE_TTL_MS) {
      cache.delete(key);
      return undefined;
    }
    counts.cacheHits += 1;
    return entry.value;
  };
  /** @param {string} key @param {any} value */
  const remember = (key, value) => {
    if (value?.status === "unknown") return value;
    cache.set(key, { at: now(), value });
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return value;
  };

  /** @param {string} url @param {{ accept?: string, signal?: AbortSignal }} [init] */
  async function get(url, { accept = "application/json", signal } = {}) {
    const timeout = AbortSignal.timeout(Math.max(1_000, timeoutMs));
    const response = await fetchImpl(url, {
      headers: { accept, "user-agent": USER_AGENT },
      redirect: "follow",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = response.status === 204 ? "" : await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error("oversized");
    return { status: response.status, text };
  }

  /** Waits its turn for NCBI's rate. @param {AbortSignal | undefined} signal */
  async function ncbiTurn(signal) {
    const interval = ncbiApiKey ? NCBI_INTERVAL_WITH_KEY_MS : NCBI_INTERVAL_MS;
    const at = now();
    const wait = Math.max(0, ncbiNext - at);
    ncbiNext = Math.max(at, ncbiNext) + interval;
    if (wait > 0) await new Promise((done, fail) => {
      const timer = setTimeout(done, wait);
      signal?.addEventListener?.("abort", () => { clearTimeout(timer); fail(signal.reason); }, { once: true });
    });
  }

  /** @param {string} path @param {Record<string, string>} params */
  function eutilsUrl(path, params) {
    const query = new URLSearchParams({ ...params, tool: "evimed_research", ...(ncbiApiKey ? { api_key: ncbiApiKey } : {}) });
    return `${EUTILS}${path}?${query}`;
  }

  /** @param {string} doi @param {AbortSignal} [signal] @returns {Promise<RegistryRecord & { abstract?: string }>} */
  async function resolveDoi(doi, signal) {
    const key = `doi:${doi}`;
    const hit = cached(key);
    if (hit) return hit;
    try {
      counts.crossref += 1;
      const crossref = await get(`${CROSSREF_WORKS}${encodeURIComponent(doi)}`, { signal });
      if (crossref.status === 200) {
        const message = JSON.parse(crossref.text)?.message ?? {};
        const title = [...(Array.isArray(message.title) ? message.title : []), ...(Array.isArray(message["original-title"]) ? message["original-title"] : [])]
          .find((value) => typeof value === "string" && value.trim()) ?? "";
        return remember(key, {
          status: "found",
          title: stripMarkup(title).slice(0, 500),
          doi,
          ...(typeof message.abstract === "string" && message.abstract.trim() ? { abstract: stripMarkup(message.abstract).slice(0, SOURCE_TEXT_LIMIT) } : {}),
        });
      }
      if (crossref.status !== 404) {
        counts.failures += 1;
        return { status: "unknown", reason: `crossref_${crossref.status}` };
      }
      // Not Crossref's: ask whether the DOI exists at all.
      counts.handles += 1;
      const handle = await get(`${DOI_HANDLES}${encodeURIComponent(doi)}`, { signal });
      const code = (() => { try { return Number(JSON.parse(handle.text)?.responseCode); } catch { return NaN; } })();
      if (code === 1) return remember(key, { status: "found", doi });
      if (code === 100 || handle.status === 404) return remember(key, { status: "not_found" });
      counts.failures += 1;
      return { status: "unknown", reason: `handle_${handle.status}` };
    } catch (error) {
      counts.failures += 1;
      return { status: "unknown", reason: error?.name === "TimeoutError" ? "timeout" : "unreachable" };
    }
  }

  /** @param {string[]} pmids @param {AbortSignal} [signal] @returns {Promise<Map<string, RegistryRecord>>} */
  async function resolvePmids(pmids, signal) {
    /** @type {Map<string, RegistryRecord>} */
    const out = new Map();
    const pending = [];
    for (const pmid of pmids) {
      const hit = cached(`pmid:${pmid}`);
      if (hit) out.set(pmid, hit);
      else pending.push(pmid);
    }
    for (let start = 0; start < pending.length; start += PUBMED_BATCH) {
      const batch = pending.slice(start, start + PUBMED_BATCH);
      try {
        await ncbiTurn(signal);
        counts.pubmed += 1;
        const response = await get(eutilsUrl("esummary.fcgi", { db: "pubmed", retmode: "json", id: batch.join(",") }), { signal });
        if (response.status !== 200) throw new Error(`esummary ${response.status}`);
        const result = JSON.parse(response.text)?.result ?? {};
        for (const pmid of batch) {
          const record = result[pmid];
          if (!record || record.error) {
            out.set(pmid, remember(`pmid:${pmid}`, { status: "not_found" }));
            continue;
          }
          const doi = (Array.isArray(record.articleids) ? record.articleids : []).find((id) => id?.idtype === "doi")?.value;
          out.set(pmid, remember(`pmid:${pmid}`, {
            status: "found",
            title: stripMarkup(record.title ?? "").slice(0, 500),
            pmid,
            ...(doi ? { doi: String(doi).toLowerCase() } : {}),
          }));
        }
      } catch (error) {
        counts.failures += 1;
        for (const pmid of batch) if (!out.has(pmid)) out.set(pmid, { status: "unknown", reason: error?.name === "TimeoutError" ? "timeout" : "unreachable" });
      }
    }
    return out;
  }

  /**
   * Every DOI and PMID, answered.
   * @param {{ dois: readonly string[], pmids: readonly string[] }} lookups
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ doi: Map<string, RegistryRecord>, pmid: Map<string, RegistryRecord> }>}
   */
  async function resolve({ dois, pmids }, { signal } = {}) {
    /** @type {Map<string, RegistryRecord>} */
    const doi = new Map();
    const queue = [...new Set(dois)];
    const workers = Array.from({ length: Math.min(DOI_CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const next = /** @type {string} */ (queue.shift());
        doi.set(next, await resolveDoi(next, signal));
      }
    });
    const [pmid] = await Promise.all([resolvePmids([...new Set(pmids)], signal), ...workers]);
    return { doi, pmid };
  }

  /**
   * PubMed abstracts, by PMID.
   * @param {readonly string[]} pmids @param {AbortSignal} [signal]
   * @returns {Promise<Map<string, { title: string, abstract: string, doi: string }>>}
   */
  async function abstracts(pmids, signal) {
    /** @type {Map<string, { title: string, abstract: string, doi: string }>} */
    const out = new Map();
    const pending = [];
    for (const pmid of new Set(pmids)) {
      const hit = cached(`abstract:${pmid}`);
      if (hit) out.set(pmid, hit);
      else pending.push(pmid);
    }
    for (let start = 0; start < pending.length; start += PUBMED_BATCH) {
      const batch = pending.slice(start, start + PUBMED_BATCH);
      try {
        await ncbiTurn(signal);
        counts.pubmed += 1;
        const response = await get(eutilsUrl("efetch.fcgi", { db: "pubmed", rettype: "abstract", retmode: "xml", id: batch.join(",") }), { accept: "application/xml", signal });
        if (response.status !== 200) throw new Error(`efetch ${response.status}`);
        for (const article of response.text.split(/<PubmedArticle[\s>]/).slice(1)) {
          const pmid = /<PMID[^>]*>(\d+)<\/PMID>/.exec(article)?.[1];
          if (!pmid) continue;
          const title = stripMarkup(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/.exec(article)?.[1] ?? "");
          const parts = [...article.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map((match) => {
            const label = /Label="([^"]+)"/.exec(match[1])?.[1];
            return `${label ? `${label}: ` : ""}${stripMarkup(match[2])}`;
          });
          const doi = /<ArticleId IdType="doi">([^<]+)<\/ArticleId>/.exec(article)?.[1] ?? "";
          out.set(pmid, remember(`abstract:${pmid}`, { title, abstract: parts.join(" ").slice(0, SOURCE_TEXT_LIMIT), doi: doi.toLowerCase() }));
        }
      } catch {
        counts.failures += 1;
      }
    }
    return out;
  }

  /** The PMID PubMed files a DOI under, or null. @param {string} doi @param {AbortSignal} [signal] */
  async function pmidForDoi(doi, signal) {
    const key = `doi-pmid:${doi}`;
    const hit = cached(key);
    if (hit !== undefined) return hit.pmid ?? null;
    try {
      await ncbiTurn(signal);
      counts.pubmed += 1;
      const response = await get(eutilsUrl("esearch.fcgi", { db: "pubmed", retmode: "json", term: `"${doi}"[doi]` }), { signal });
      if (response.status !== 200) return null;
      const ids = JSON.parse(response.text)?.esearchresult?.idlist ?? [];
      const pmid = ids.length === 1 ? String(ids[0]) : null;
      remember(key, { status: "found", pmid });
      return pmid;
    } catch {
      counts.failures += 1;
      return null;
    }
  }

  /**
   * What each cited reference says, for a reviewer to judge a sentence
   * against: its title and abstract from PubMed (by PMID, or by the PMID
   * PubMed files its DOI under), Crossref's abstract, or — for a page that is
   * neither — the page itself, read the way `web_read` reads (robots
   * honoured). A reference nothing could be read for is absent from the map.
   *
   * @param {readonly { number: number, dois: readonly string[], pmids: readonly string[], urls: readonly string[] }[]} references
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<Map<number, string>>}
   */
  async function sourceTexts(references, { signal } = {}) {
    /** @type {Map<number, string>} */
    const texts = new Map();
    /** @type {Map<number, string>} */
    const pmidOf = new Map();
    for (const reference of references) {
      if (reference.pmids.length) pmidOf.set(reference.number, reference.pmids[0]);
    }
    for (const reference of references) {
      if (pmidOf.has(reference.number) || !reference.dois.length) continue;
      const pmid = await pmidForDoi(reference.dois[0], signal);
      if (pmid) pmidOf.set(reference.number, pmid);
    }
    const fetched = await abstracts([...pmidOf.values()], signal);
    for (const reference of references) {
      const pmid = pmidOf.get(reference.number);
      const record = pmid ? fetched.get(pmid) : null;
      if (record && (record.title || record.abstract)) {
        texts.set(reference.number, `${record.title}\n${record.abstract}`.trim().slice(0, SOURCE_TEXT_LIMIT));
        continue;
      }
      if (reference.dois.length) {
        const doi = await resolveDoi(reference.dois[0], signal);
        if (doi.status === "found" && (doi.title || /** @type {any} */ (doi).abstract)) {
          texts.set(reference.number, `${doi.title ?? ""}\n${/** @type {any} */ (doi).abstract ?? ""}`.trim().slice(0, SOURCE_TEXT_LIMIT));
          continue;
        }
      }
      const url = reference.urls[0];
      if (url && webReader) {
        try {
          counts.web += 1;
          const page = await webReader.read(url, { signal });
          const text = String(page?.text ?? page?.content ?? "").trim();
          if (text) texts.set(reference.number, `${String(page?.title ?? "").trim()}\n${text}`.trim().slice(0, SOURCE_TEXT_LIMIT));
        } catch {
          counts.failures += 1;
        }
      }
    }
    return texts;
  }

  return {
    resolve,
    sourceTexts,
    /** Counters for the operator's metrics endpoint. */
    stats: () => ({ ...counts, cached: cache.size }),
  };
}
