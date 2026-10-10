/**
 * The wish list the knowledge-source plugin pulls, and the writer of it.
 *
 * The plugin collects the sources and the platform never pushes to it. What the platform can do is publish, at
 * `GET /evolution/source-requests.json`, the sources it would like collected; the plugin pulls that list daily, reads each request through
 * the same protected fetch as any other source, and decides what to admit (`knowledge_plugin/source_requests.py`): a reader it implements
 * (an RSS or Atom feed here), the direct exit, a host on its list of scholarly hosts, a lane of `ai`, and a `discovery_only` row. Until
 * 2026-10-10 nothing wrote a request, so the platform could never ask for a source the plugin did not have (review D-E13).
 *
 * A source is asked for when the scout, searching the literature for a tool to build, finds a feed the plugin does not read and says so
 * (`sourceSuggestions` on its research card). What it means by "valuable" is its judgement. What can be decided exactly is decided here
 * before anything is filed: the address is an `https` feed, on a host the plugin admits, that answers as RSS or Atom with entries in it;
 * it is not a request already filed; and there is room for it among the twenty-five the plugin reads. Whatever fails one of those is
 * counted by the reason and not filed. The plugin still decides: a request it declines stays on the list until it lapses.
 *
 * A request leaves the list when the plugin has taken it (the platform's mirror of the plugin's sources lists it; the plugin keeps what it
 * admitted) or when it has not taken it in `lapseDays`, so a request the plugin keeps declining does not hold a place for ever.
 *
 * @module evolutionSourceRequests
 */
import { createHash } from 'node:crypto';
import { AI_DISCOVERY_PREFIX } from './evolutionDiscoverySources.mjs';

/**
 * Public pull-only manifest: the plugin owns admission and never receives a push.
 * It used to carry one request, the arXiv query self-research began with. The plugin's registry now carries the whole set that
 * request grew into (the `ai-discovery-` rows of 2026-10-10), and a request for a row the registry no longer has would admit
 * the old query again beside them, so the list of fixed requests is empty and only the requests the platform files are served.
 */
export const AI_DISCOVERY_SOURCE_REQUESTS = Object.freeze(/** @type {any[]} */ ([]));

/** The hosts the plugin admits a request on (`DISCOVERY_HOSTS` in `source_requests.py`; a test holds the two lists equal). */
export const SOURCE_REQUEST_HOSTS = Object.freeze(['arxiv.org', 'export.arxiv.org', 'openreview.net', 'api.openreview.net', 'proceedings.iclr.cc', 'proceedings.mlr.press',
  'papers.nips.cc', 'papers.neurips.cc', 'neurips.cc', 'aclanthology.org', 'colmweb.org']);
/** The plugin reads at most this many requests, and the manifest serves at most this many. */
export const SOURCE_REQUEST_LIMIT = 25;
/** Suggestions one research card may carry into the writer. */
export const SOURCE_SUGGESTIONS_PER_CARD = 3;
const DAY_MS = 86_400_000;
const FEED_BYTES = 2 * 1024 * 1024;
const FEED_TIMEOUT_MS = 20_000;
const FEED_REDIRECTS = 2;

/** @param {unknown} value @param {number} max */
const clip = (value, max) => (typeof value === 'string' ? value.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * The address of a feed in the one form it is filed under: `https`, no credentials, no fragment, the default port left out, the query in a
 * fixed order. Anything else is not a feed address.
 * @param {unknown} raw @returns {URL|null}
 */
export function normalizeFeedUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  url.hash = '';
  url.port = '';
  url.searchParams.sort();
  return url;
}

/**
 * Whether a document is an RSS or Atom feed with entries in it, which is a format and not a reading.
 * @param {string} text @returns {'rss'|'atom'|null}
 */
export function feedKindOf(text) {
  const head = text.slice(0, 4096).toLowerCase();
  const kind = /<feed[\s>]/.test(head) ? 'atom' : /<rss[\s>]|<rdf:rdf[\s>]/.test(head) ? 'rss' : null;
  return kind && /<(?:item|entry)[\s>]/i.test(text) ? kind : null;
}

/**
 * The registry row a request asks for. Every field the plugin's admission checks is set here, from closed values, and none is the model's.
 * @param {{ name: string, url: URL, access: 'rss'|'atom' }} request
 */
export function requestRow({ name, url, access }) {
  const host = url.hostname;
  const arxiv = host === 'arxiv.org' || host === 'export.arxiv.org';
  return { id: `${AI_DISCOVERY_PREFIX}req-${createHash('sha256').update(url.href).digest('hex').slice(0, 12)}`, name, homepage: `https://${host}/`, lane: 'ai',
    source_type: arxiv || host.endsWith('openreview.net') ? 'preprint' : 'journal', access, egress: 'direct', authority: 2, safety_feed: false, owner_entity: host,
    launch_tier: 'P0', language: 'en', poll_floor_s: 21_600, poll_ceiling_s: 129_600, category: 'ai-discovery',
    config: { url: url.href, max_pages: 1, allowed_hosts: [host], discovery_only: true, ...(arxiv ? { arxiv_comment: true } : {}) } };
}

/**
 * @param {{ service: any, fetchImpl?: typeof fetch, now?: () => Date, sources?: (() => Promise<{ id: string, name?: string }[]>)|null, lapseDays?: number }} dependencies
 */
export function createEvolutionSourceRequests({ service, fetchImpl = fetch, now = () => service.now(), sources = null, lapseDays = 30 }) {
  /** Since process start, by what became of the suggestions; `waiting` is the number on the list at the last look. */
  const counters = { filed: 0, duplicate: 0, invalid: 0, unsupportedHost: 0, notAFeed: 0, unreachable: 0, capReached: 0, admitted: 0, lapsed: 0, waiting: 0 };
  /** @param {keyof typeof counters} outcome @param {any} [extra] */
  const settle = (outcome, extra = {}) => { counters[outcome] += 1; return { outcome, ...extra }; };

  /** The feed's kind, or the reason it is none: fetched like a browser would, a few redirects on the same host, a bounded body. @param {URL} start */
  async function probe(start) {
    let url = start;
    try {
      for (let hop = 0; hop <= FEED_REDIRECTS; hop += 1) {
        const response = await fetchImpl(url.href, { redirect: 'manual', signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
          headers: { accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8', 'user-agent': 'EviMedBot/1.0 (+https://www.evimed.com; checks a feed before asking for it)' } });
        if (response.status >= 300 && response.status < 400) {
          const next = normalizeFeedUrl(new URL(response.headers.get('location') ?? '', url).href);
          if (!next || next.hostname !== url.hostname) return { reason: 'unreachable' };
          url = next;
          continue;
        }
        if (!response.ok) return { reason: 'unreachable' };
        const text = await response.text();
        if (Buffer.byteLength(text) > FEED_BYTES) return { reason: 'notAFeed' };
        const access = feedKindOf(text);
        return access ? { access } : { reason: 'notAFeed' };
      }
    } catch { return { reason: 'unreachable' }; }
    return { reason: 'unreachable' };
  }

  /** @param {any} raw @param {any} origin */
  async function one(raw, origin) {
    const name = clip(raw?.name, 120);
    const url = normalizeFeedUrl(raw?.url);
    if (name.length < 3 || !url) return settle('invalid');
    if (!SOURCE_REQUEST_HOSTS.includes(url.hostname)) return settle('unsupportedHost', { host: url.hostname });
    const recordId = `evolution-source-request-${createHash('sha256').update(url.href).digest('hex').slice(0, 32)}`;
    if (await service.get(recordId)) return settle('duplicate');
    const checked = await probe(url);
    if (!checked.access) return settle(/** @type {'notAFeed'|'unreachable'} */ (checked.reason));
    return service.withLock('source-request-filing', async () => {
      if (await service.get(recordId)) return settle('duplicate');
      const waiting = (await service.list('source-request')).filter((/** @type {any} */ row) => row.payload.status === 'requested').length;
      counters.waiting = waiting;
      if (waiting >= SOURCE_REQUEST_LIMIT) return settle('capReached');
      const source = requestRow({ name, url, access: checked.access });
      await service.save('source-request', recordId, { public: true, status: 'requested', source, why: clip(raw?.why, 400), origin: { kind: String(origin?.kind ?? 'unknown'), ref: clip(origin?.ref, 120) },
        requestedAt: now().toISOString() });
      counters.waiting = waiting + 1;
      return settle('filed', { id: source.id });
    });
  }

  return {
    counters,
    /**
     * File what a research card suggested, at most `SOURCE_SUGGESTIONS_PER_CARD` of it. Never throws: a suggestion that cannot be filed is counted.
     * @param {unknown} suggestions @param {{ kind?: string, ref?: string }} [origin]
     * @returns {Promise<{ outcome: string, id?: string, host?: string }[]>}
     */
    async file(suggestions, origin = {}) {
      /** @type {{ outcome: string, id?: string, host?: string }[]} */
      const outcomes = [];
      for (const raw of (Array.isArray(suggestions) ? suggestions : []).slice(0, SOURCE_SUGGESTIONS_PER_CARD)) {
        try { outcomes.push(await one(raw, origin)); } catch { outcomes.push(settle('unreachable')); }
      }
      return outcomes;
    },
    /** A request the plugin has taken leaves the list as admitted, and one it has not taken in `lapseDays` as lapsed. */
    async reconcile() {
      const live = (await service.list('source-request')).filter((/** @type {any} */ row) => row.payload.status === 'requested');
      counters.waiting = live.length;
      if (!live.length) return { admitted: 0, lapsed: 0 };
      const known = new Set((await (sources?.() ?? Promise.resolve([])).catch(() => [])).map((/** @type {any} */ source) => source.id));
      let admitted = 0;
      let lapsed = 0;
      for (const row of live) {
        const filedAt = Date.parse(row.payload.requestedAt);
        if (known.has(row.payload.source?.id)) { await service.save('source-request', row.id, { ...row.payload, status: 'admitted', admittedAt: now().toISOString() }, row); admitted += 1; counters.admitted += 1; }
        else if (Number.isFinite(filedAt) && now().getTime() - filedAt > lapseDays * DAY_MS) { await service.save('source-request', row.id, { ...row.payload, status: 'lapsed', lapsedAt: now().toISOString() }, row); lapsed += 1; counters.lapsed += 1; }
      }
      counters.waiting = live.length - admitted - lapsed;
      return { admitted, lapsed };
    },
    /** What the scout is told so that it does not ask for what is read already: the plugin's discovery rows by name, and the hosts a request may name. */
    async catalogue() {
      return { sources: (await (sources?.() ?? Promise.resolve([])).catch(() => [])).map((/** @type {any} */ source) => ({ id: source.id, name: source.name })), hosts: [...SOURCE_REQUEST_HOSTS] };
    },
  };
}

/** @param {any} service */
export async function evolutionSourceRequestManifest(service){const requested=service?(await service.list('source-request')).filter(r=>r.payload.public===true&&r.payload.status==='requested').map(r=>r.payload.source):[];return {schemaVersion:1,sources:[...AI_DISCOVERY_SOURCE_REQUESTS,...requested].slice(0,SOURCE_REQUEST_LIMIT)};}
