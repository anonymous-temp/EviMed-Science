/**
 * What the knowledge-source plugin's AI-discovery rows are, as the platform tells them apart.
 *
 * 循证进化's weekly self-research reads sources that are not medicine: arXiv phrase queries over the core AI categories, Hugging Face
 * Daily Papers, the releases of agent frameworks, model releases, lab blogs and the proceedings of the venues that stamp them
 * (`项目代码/knowledge-plugin/registry/extra-sources.json`, the source set decided on 2026-10-10). The medical feed drops what they bring and the
 * self-research reads it, and both have to agree on which entries those are. The plugin's contract has no field that says so and the
 * closed `facts` whitelist has no room for one, so the id is the marker: every row that exists only for self-research has an id that
 * starts with `ai-discovery-`, and a source the platform itself asks the plugin to read (`evolutionSourceRequests.mjs`) is given one.
 * A test holds this file and the plugin's registry to the same list.
 *
 * Two more things are read off the source and nowhere else, because the source is what the plugin guarantees about an entry: which kind of
 * thing the entry is (a paper, a release, a model, a lab post, a proceedings volume) and what reading it through that source says about
 * it (a paper listed on Daily Papers has twenty upvotes). Everything that needs a reading of language, such as whether a paper's comment
 * says it was accepted, is the model's.
 *
 * @module evolutionDiscoverySources
 */
import { createHash } from 'node:crypto';

/** Every row that exists only for self-research has an id that starts with this. */
export const AI_DISCOVERY_PREFIX = 'ai-discovery-';
/** The single arXiv query the channel began with. Its row is gone from the registry; the entries it stored keep their meaning. */
export const LEGACY_DISCOVERY_SOURCE_ID = 'arxiv-agent-self-improvement';
/** Lab feeds the medical feed also reads (it screens them for medicine); self-research reads them for the labs' own research. */
export const AI_LAB_FEED_SOURCE_IDS = Object.freeze(['openai-news', 'anthropic-news', 'google-deepmind-blog', 'google-research-blog', 'microsoft-research-blog', 'ai2-blog']);

/** @typedef {'paper'|'release'|'model'|'lab'|'venue-volume'} DiscoveryKind */

/** The medical feed drops these entries. @param {unknown} sourceId */
export function isDiscoveryOnlySource(sourceId) {
  const id = String(sourceId ?? '');
  return id.startsWith(AI_DISCOVERY_PREFIX) || id === LEGACY_DISCOVERY_SOURCE_ID;
}

/** Self-research reads these: the discovery-only rows and the lab feeds shared with the medical feed. @param {unknown} sourceId */
export function isSelfResearchSource(sourceId) {
  return isDiscoveryOnlySource(sourceId) || AI_LAB_FEED_SOURCE_IDS.includes(String(sourceId ?? ''));
}

/**
 * What an entry from this source is, and what its being there says.
 * `attention`: the source only lists papers the community upvoted (Daily Papers keeps those with twenty or more).
 * `venueRow`: the source only lists papers whose own comment says accepted at a venue (the arXiv `co:accepted` row).
 * @param {unknown} sourceId
 * @returns {{ kind: DiscoveryKind, attention: boolean, venueRow: boolean }}
 */
export function discoverySourceTraits(sourceId) {
  const id = String(sourceId ?? '');
  if (id === 'ai-discovery-hf-daily-papers') return { kind: 'paper', attention: true, venueRow: false };
  if (id === 'ai-discovery-arxiv-venue-accepted') return { kind: 'paper', attention: false, venueRow: true };
  if (id === LEGACY_DISCOVERY_SOURCE_ID || id.startsWith('ai-discovery-arxiv-')) return { kind: 'paper', attention: false, venueRow: false };
  if (id.startsWith('ai-discovery-gh-')) return { kind: 'release', attention: false, venueRow: false };
  if (id.startsWith('ai-discovery-hf-models-')) return { kind: 'model', attention: false, venueRow: false };
  if (id === 'ai-discovery-pmlr-volumes' || id === 'ai-discovery-acl-anthology-ingest') return { kind: 'venue-volume', attention: false, venueRow: false };
  return { kind: 'lab', attention: false, venueRow: false };
}

const ARXIV_ID = '(\\d{4}\\.\\d{4,5}|[a-z\\-]+(?:\\.[A-Z]{2})?/\\d{7})';
const ARXIV_IN_URL = new RegExp(`arxiv\\.org/(?:abs|pdf|html)/${ARXIV_ID}(?:v\\d+)?`, 'i');
const ARXIV_IN_DOI = new RegExp(`^10\\.48550/arxiv\\.${ARXIV_ID}(?:v\\d+)?$`, 'i');
const OPENREVIEW_IN_URL = /openreview\.net\/(?:forum|pdf)\?id=([A-Za-z0-9_-]{6,})/;
const GITHUB_REPOSITORY = /https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+/;

/** The arXiv identifier an entry carries, without its version: from its DOI (arXiv's DataCite one) or its address.
 * @param {{ doi?: string|null, sourceUrl?: string|null }} entry */
export function arxivIdOf(entry) {
  const doi = String(entry.doi ?? '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '').replace(/^doi:/, '');
  const fromDoi = ARXIV_IN_DOI.exec(doi);
  if (fromDoi) return fromDoi[1].toLowerCase();
  const fromUrl = ARXIV_IN_URL.exec(String(entry.sourceUrl ?? ''));
  return fromUrl ? fromUrl[1].toLowerCase() : null;
}

/** @param {string} text */
const normalizedTitle = text => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** @param {string} text */
const shortHash = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * One paper reaches the platform through however many rows list it, so entries are merged on one key: the arXiv identifier without its
 * version, then the DOI, then the OpenReview note, then a hash of the normalised title. A release, a model or a post is its own address.
 * Expect misses (a preprint and its published version carry different DOIs): a miss costs a second screen, never a wrong merge.
 * @param {{ doi?: string|null, sourceUrl?: string|null, title?: string|null }} entry @param {DiscoveryKind} kind
 */
export function dedupeKey(entry, kind = 'paper') {
  if (kind !== 'paper') return `url:${shortHash(String(entry.sourceUrl ?? entry.title ?? ''))}`;
  const arxiv = arxivIdOf(entry);
  if (arxiv) return `arxiv:${arxiv}`;
  const doi = String(entry.doi ?? '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '').replace(/^doi:/, '');
  if (/^10\.\d{4,9}\/\S+$/.test(doi)) return `doi:${doi}`;
  const note = OPENREVIEW_IN_URL.exec(String(entry.sourceUrl ?? ''));
  if (note) return `openreview:${note[1]}`;
  return `title:${shortHash(normalizedTitle(entry.title ?? ''))}`;
}

/** A GitHub repository the text links, which is a format and not a reading. @param {string} text */
export function codeLinkOf(text) {
  const found = GITHUB_REPOSITORY.exec(String(text ?? ''));
  return found ? found[0].replace(/[.,;:)]+$/, '') : null;
}
