/**
 * What two scholarly indexes add about the papers a week's self-research shortlisted, when the deployment has a key for them.
 *
 * A paper's own text and comment say how it was published only when its authors wrote it down. Semantic Scholar and OpenAlex know where
 * a paper appeared and how often it has been cited, and the second of those is the only part of the ranking that needs time: a paper
 * has no citations in its first weeks (citations count from ninety days on). Both are asked for the shortlist only (at
 * most thirty papers in one batch and a handful of single lookups a week), and each is asked only when the deployment has its key:
 * Semantic Scholar answers keyless callers with 429 (15 of 17 calls in the brief's measurement) and OpenAlex's free key is what the
 * brief advises. A deployment without a key skips the provider, the week's report says so, and nothing else changes. The owner is never
 * asked for a key. An OpenReview account would be a third provider; none is written because no account exists to record its wire from.
 *
 * Each provider fails on its own: a refusal or an outage ends that provider for the week, counted by its reason, and the other still
 * answers. A key never appears in a message, a record or a counter; a failure is reported by its closed code only.
 *
 * @module evolutionScholarEnrichment
 */

/** The cap on any one answer; the shortlist is small, so an answer past this is not what was asked. */
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const S2_BATCH = 'https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,venue,publicationVenue,publicationDate,citationCount,influentialCitationCount,externalIds,openAccessPdf';
const OPENALEX_WORK = 'https://api.openalex.org/works/';
const OPENALEX_FIELDS = 'id,doi,cited_by_count,publication_date,type,locations';
/** HTTP statuses that end a provider for the week rather than one lookup: the key is refused or the allowance is spent. */
const ENDS_PROVIDER = new Set([401, 403, 429]);

/** A repository is where a preprint is kept, never where it was published. @param {unknown} venue */
const publishedVenue = venue => {
  const text = typeof venue === 'string' ? venue.trim() : '';
  return text && !/^arxiv\b/i.test(text) ? text : null;
};

/**
 * The fields of one Semantic Scholar record the ranking reads.
 * @param {any} record
 * @returns {{ venue: string|null, citations: number|null, publicationDate: string|null, doi: string|null, openAccessPdf: string|null }|null}
 */
export function semanticScholarFields(record) {
  if (!record || typeof record !== 'object') return null;
  const citations = Number.isSafeInteger(record.citationCount) && record.citationCount >= 0 ? record.citationCount : null;
  const pdf = typeof record.openAccessPdf?.url === 'string' && record.openAccessPdf.url.startsWith('https://') ? record.openAccessPdf.url : null;
  return { venue: publishedVenue(record.venue) ?? publishedVenue(record.publicationVenue?.name), citations,
    publicationDate: typeof record.publicationDate === 'string' ? record.publicationDate : null,
    doi: typeof record.externalIds?.DOI === 'string' ? record.externalIds.DOI.toLowerCase() : null, openAccessPdf: pdf };
}

/**
 * The fields of one OpenAlex work the ranking reads: where a published version of the work appeared (a journal or a conference among
 * its locations) and how often it has been cited.
 * @param {any} work
 * @returns {{ venue: string|null, citations: number|null, publicationDate: string|null, doi: string|null, openAccessPdf: null }|null}
 */
export function openAlexFields(work) {
  if (!work || typeof work !== 'object') return null;
  const place = (Array.isArray(work.locations) ? work.locations : []).find((/** @type {any} */ location) => ['journal', 'conference'].includes(location?.source?.type));
  return { venue: publishedVenue(place?.source?.display_name),
    citations: Number.isSafeInteger(work.cited_by_count) && work.cited_by_count >= 0 ? work.cited_by_count : null,
    publicationDate: typeof work.publication_date === 'string' ? work.publication_date : null,
    doi: typeof work.doi === 'string' ? work.doi.replace(/^https?:\/\/doi\.org\//i, '').toLowerCase() : null, openAccessPdf: null };
}

/** @param {Response} response */
async function boundedJson(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'answer_too_large' });
  return JSON.parse(text);
}

/**
 * @param {{ semanticScholarKey?: string, openAlexKey?: string, fetchImpl?: typeof fetch, pause?: (ms: number) => Promise<void> }} dependencies
 */
export function createEvolutionScholarEnrichment({ semanticScholarKey = '', openAlexKey = '', fetchImpl = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  /** @param {string} url @param {RequestInit} init */
  async function request(url, init) {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response;
  }

  /** @typedef {{ status: 'ok'|'failed', reason?: string, found: number, byKey: Map<string, any> }} ProviderAnswer */

  /** @param {{ key: string, arxivId: string|null, doi: string|null }[]} papers @returns {Promise<ProviderAnswer>} */
  async function semanticScholar(papers) {
    const asked = papers.map(paper => ({ key: paper.key, id: paper.arxivId ? `ARXIV:${paper.arxivId}` : paper.doi ? `DOI:${paper.doi}` : null })).filter(item => item.id);
    if (!asked.length) return { status: 'ok', found: 0, byKey: new Map() };
    try {
      const response = await request(S2_BATCH, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': semanticScholarKey },
        body: JSON.stringify({ ids: asked.map(item => item.id) }) });
      if (!response.ok) return { status: 'failed', reason: `http_${response.status}`, found: 0, byKey: new Map() };
      const records = await boundedJson(response);
      if (!Array.isArray(records)) return { status: 'failed', reason: 'unexpected_shape', found: 0, byKey: new Map() };
      /** @type {Map<string, any>} */
      const byKey = new Map();
      asked.forEach((item, index) => { const fields = semanticScholarFields(records[index]); if (fields) byKey.set(item.key, fields); });
      return { status: 'ok', found: byKey.size, byKey };
    } catch (error) {
      return { status: 'failed', reason: typeof (/** @type {any} */ (error))?.code === 'string' ? /** @type {any} */ (error).code : 'unreachable', found: 0, byKey: new Map() };
    }
  }

  /** @param {{ key: string, arxivId: string|null, doi: string|null }[]} papers @returns {Promise<ProviderAnswer>} */
  async function openAlex(papers) {
    /** @type {Map<string, any>} */
    const byKey = new Map();
    let failedLookups = 0;
    for (const paper of papers) {
      const doi = paper.arxivId ? `10.48550/arxiv.${paper.arxivId}` : paper.doi;
      if (!doi) continue;
      try {
        // The key travels in the header OpenAlex reads it from, so that it is never part of an address (an invalid one is answered 401 either way).
        const response = await request(`${OPENALEX_WORK}doi:${doi}?select=${OPENALEX_FIELDS}`, { headers: { accept: 'application/json', authorization: `Bearer ${openAlexKey}` } });
        if (ENDS_PROVIDER.has(response.status)) return { status: 'failed', reason: `http_${response.status}`, found: byKey.size, byKey };
        if (response.status === 404) continue;
        if (!response.ok) { failedLookups += 1; continue; }
        const fields = openAlexFields(await boundedJson(response));
        if (fields) byKey.set(paper.key, fields);
      } catch { failedLookups += 1; }
      await pause(150);
    }
    return failedLookups && !byKey.size ? { status: 'failed', reason: 'lookups_failed', found: 0, byKey } : { status: 'ok', found: byKey.size, byKey };
  }

  return {
    /** Which providers have a key, by name. */
    available() { return { semanticScholar: Boolean(semanticScholarKey), openAlex: Boolean(openAlexKey) }; },
    /**
     * Ask each provider that has a key about the shortlisted papers, and merge what they say: the first venue found (Semantic Scholar
     * first), the larger citation count (the two indexes lag differently, so the larger is the better lower bound).
     * @param {{ key: string, arxivId: string|null, doi: string|null }[]} papers
     * @returns {Promise<{ providers: Record<string, { status: 'ok'|'skipped'|'failed', reason?: string, found: number }>, byKey: Map<string, { venue: string|null, citations: number|null, publicationDate: string|null, doi: string|null, openAccessPdf: string|null, from: string[] }> }>}
     */
    async enrich(papers) {
      /** @type {Record<string, { status: 'ok'|'skipped'|'failed', reason?: string, found: number }>} */
      const providers = {};
      const answers = [];
      for (const [name, key, ask] of /** @type {const} */ ([['semanticScholar', semanticScholarKey, semanticScholar], ['openAlex', openAlexKey, openAlex]])) {
        if (!key) { providers[name] = { status: 'skipped', reason: 'no_key', found: 0 }; continue; }
        if (!papers.length) { providers[name] = { status: 'ok', found: 0 }; continue; }
        const answer = await ask(papers);
        providers[name] = { status: answer.status, ...(answer.reason ? { reason: answer.reason } : {}), found: answer.found };
        answers.push([name, answer.byKey]);
      }
      /** @type {Map<string, any>} */
      const byKey = new Map();
      for (const [name, found] of answers) {
        for (const [key, fields] of found) {
          const merged = byKey.get(key) ?? { venue: null, citations: null, publicationDate: null, doi: null, openAccessPdf: null, from: [] };
          merged.venue ??= fields.venue; merged.publicationDate ??= fields.publicationDate; merged.doi ??= fields.doi; merged.openAccessPdf ??= fields.openAccessPdf;
          if (fields.citations != null) merged.citations = Math.max(merged.citations ?? 0, fields.citations);
          merged.from.push(name);
          byKey.set(key, merged);
        }
      }
      return { providers, byKey };
    },
  };
}
