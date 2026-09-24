import { createHash } from "node:crypto";
import {
  FRONTIER_ACCESSES, FRONTIER_EGRESSES, FRONTIER_EVIDENCE_TYPE_LABELS_ZH, FRONTIER_HEALTH_LABELS_ZH, FRONTIER_HOT_WINDOW_HOURS,
  FRONTIER_ITEM_FLAG_LABELS_ZH, FRONTIER_LANES, FRONTIER_LANE_LABELS_ZH, FRONTIER_LAUNCH_TIERS, FRONTIER_SOURCE_TYPE_LABELS_ZH,
  FRONTIER_SPECIALTY_LABELS_ZH, frontierScoreLevel, frontierSourceDisplayName,
} from "@evimed/domain";
import { frontierDailyMarkdown, frontierReadingMinutes } from "./frontierDaily.mjs";
import { FRONTIER_HOT_PERIODS } from "./frontierEvents.mjs";
import { FRONTIER_FALLBACKS } from "./frontierIngest.mjs";
import { FRONTIER_META_KEYS, bumpFrontierVersion, metaNumber, migrateFrontier } from "./frontierPersistence.mjs";
import { FRONTIER_LANE_FLOOR_SCORE, frontierSelectThreshold } from "./frontierPipeline.mjs";
import { FRONTIER_PROJECT_ID } from "./internalProjects.mjs";
import { trigramTerms, tsqueryLiteral } from "./kbChunker.mjs";
import { readKnowledgePluginToken } from "./knowledgePluginClient.mjs";
import { HttpError } from "./security.mjs";

/**
 * What a reader of 「前沿动态」 is served (plan §7.3, §10.5).
 *
 * Hidden knowledge — the read path's four nevers (§10.5.1): no model call, no
 * cross-border request, no read of an original site, no per-user recomputation
 * of content. Everything served here was written into `evimed_frontier` by the
 * worker before anyone asked; this module only selects, decorates and overlays
 * a reader's own state. So the page's speed and availability are independent
 * of every upstream, and content costs nothing per reader.
 *
 * - Caching (§10.5.2). The platform's other routes answer `no-store`; this
 *   one has its own small convention. Every list and item answer carries
 *   `ETag: W/"<content>.<userState>.<query>"` with `Cache-Control: private,
 *   no-cache`: the content version moves with every change a reader can see
 *   (the worker bumps it in the transaction that makes the change), the state
 *   version moves with every star, hide, read or follow of that reader —
 *   without it, 「只看收藏」 would answer 304 with a list missing the item just
 *   starred. Both unchanged, the answer is a 304 and the list is never read.
 *   Public pages are also cached in-process for 60 s, keyed by everything
 *   that shapes them and dropped the moment the content version moves; a
 *   reader's own state is laid over them by one indexed query per page.
 * - Cursors are keyset positions, never offsets into a shifting list: an
 *   opaque base64url of `{by, view, v, f, t, id}` — the axis, the view, the
 *   content version and a fingerprint of the filters it was minted under. A
 *   cursor whose axis, view, filters or content version no longer match is a
 *   `400 invalid_cursor`, and the client starts again from page one (§7.3):
 *   pagination is not a snapshot, and pretending it is would silently skip or
 *   repeat items.
 * - Hidden items leave a page after the public page is built, so a page may
 *   be shorter than `limit` while `nextCursor` still says there is more.
 * - Search runs the knowledge base's three legs over published items: the
 *   platform tokenizer's lexemes, trigram similarity on titles where pg_trgm
 *   exists, and cosine similarity over item vectors where pgvector and the
 *   embedder exist — fifty candidates each, fused by reciprocal rank (k = 60,
 *   as `kbIndex.mjs`). `mode` says which ran. Searching 精选 searches 全部 and
 *   marks what was selected (§4.2).
 * - A card carries the editorial total, `score` (0–100), and the band it reads
 *   in, `scoreBand` (plan 2026-09-23 §6.2 编辑评分: `high` at or above the
 *   selection line, `medium` from 60, `low` below); a safety alert carries
 *   neither — it is selected whatever it scored. The four dimensions stay
 *   internal: `levels` are their display bands, never their numbers, banded by
 *   the domain's `frontierScoreLevel` (two thirds of a dimension's maximum or
 *   above is `high`, one third or above `medium`, below that `low`).
 * - A source reaches a reader by its institution's name, never the feed it is
 *   read through (`frontierSourceDisplayName`, plan 2026-09-23 §6.5 #5): the
 *   card, 「另有 N 家报道」, the event page, the daily and its Markdown. 「另有
 *   N 家」 counts institutions — another feed of the card's own institution is
 *   not another report — and names the first five.
 * - Search sorts by relevance, or by time (`sort=time`): the items that carry
 *   the words — the keyword and trigram legs' results — newest first. The
 *   vector leg ranks by meaning and matches everything a little, so in time
 *   order it would put the newest loosely related item first; it stands in
 *   only when the words matched nothing.
 * - Every query runs with a five-second statement timeout of its own: the
 *   control plane sets none, and a list that cannot answer in five seconds is
 *   better refused than held (§10.4.6).
 * - The budget shown is the pipeline's own reading (`FrontierPipeline.budget`):
 *   today's settled and still-reserved `frontier` spend of the module's
 *   internal project, in the configured time zone's day — read, never
 *   re-decided here.
 * - A card names its event only when the event holds more than one report
 *   (`frontierEvents.mjs` gives every item an event, most of them alone): the
 *   link says 「同一事件的全部报道」, and over one report that is not true.
 * - `safety=1` lists official safety alerts from every lane — the page's
 *   安全警示 rail. An alert is selected whatever its score, but its lane is
 *   the screening model's pick among its source's lanes, so a lane filter
 *   would miss some.
 * - Reading the page marks the reader seen (`user_prefs.last_seen_at`, at
 *   most every ten minutes): the daily is pushed to, and profiles are built
 *   for, readers seen in the last 14 days (plan §10.5.3, §10.5.5).
 * - The second wave's readers (hot list, events, dailies, 与你相关, the two
 *   actions) live in their own modules and are handed in; `/status` says
 *   which exist (`capabilities`) and whether personalization is `available`,
 *   `unavailable` or `off`, so the page never offers what would answer 404.
 *
 * @module frontierService
 */

/** The rank-fusion constant, as knowledge-base search and memory recall use. */
export const FRONTIER_RRF_K = 60;
const LEG_LIMIT = 50;
const STATEMENT_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;
const STATUS_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 500;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const MAX_QUERY_CHARS = 200;
const MAX_CURSOR_CHARS = 1_000;
const MAX_FOLLOWS = 200;
/** How often one reader's `last_seen_at` is written, at most (it counts in days). */
const SEEN_INTERVAL_MS = 10 * 60_000;
const PUBLIC_ID = /^[a-z0-9]{12,32}$/;
/** Windows a list may be cut to, on its own axis. */
export const FRONTIER_WINDOWS = Object.freeze({ "24h": 24 * 3_600_000, "3d": 3 * 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 });
const VIEWS = Object.freeze(["selected", "all"]);
const AXES = Object.freeze(["timeline", "published"]);
/** How a search is ordered; a list is always newest first. */
const SORTS = Object.freeze(["relevance", "time"]);
/** The hot rankings a reader may ask for (`GET /hot?window=`). */
export const FRONTIER_HOT_WINDOWS = Object.freeze(["current", ...Object.keys(FRONTIER_HOT_PERIODS)]);
const FOLLOW_KINDS = Object.freeze(["topic", "specialty", "drug", "source", "event"]);

/**
 * The band an editorial score reads in (plan 2026-09-23 §6.2): `high` at or
 * above the selection line, `medium` from the lane floor (60) up to it, `low`
 * below; null without a score.
 * @param {unknown} score @param {number} threshold @returns {"high" | "medium" | "low" | null}
 */
export function frontierScoreBand(score, threshold) {
  if (score == null || score === "" || !Number.isFinite(Number(score))) return null;
  const value = Number(score);
  return value >= threshold ? "high" : value >= FRONTIER_LANE_FLOOR_SCORE ? "medium" : "low";
}

/**
 * Whether this account sees the module at all: on, and either open to every
 * account or this one an operator or on the preview list. The dry-run week
 * (plan §10.5.10) runs with `operators`.
 * @param {Record<string, any>} config @param {{ id?: string } | null | undefined} user
 */
export function frontierAudienceAllows(config, user) {
  if (!config?.frontierEnabled) return false;
  if (config.frontierAudience === "all") return true;
  const id = String(user?.id ?? "");
  return Boolean(id) && ((config.operatorUsers ?? []).includes(id) || (config.frontierPreviewUsers ?? []).includes(id));
}

/** @param {unknown} value @returns {Record<string, string>} */
function labelMap(value) {
  if (Array.isArray(value)) return Object.fromEntries(value.map((key) => [String(key), String(key)]));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, label]) => [key, String(label)]));
  return {};
}

/**
 * The frontier vocabulary in the shape the module reads: key → Chinese label
 * for lanes (with `mixed`), source types, evidence types, specialties, item
 * flags and health states, and the key lists of read methods, egresses and
 * launch tiers.
 * @typedef {{ lanes: Record<string, string>, sourceTypes: Record<string, string>, evidenceTypes: Record<string, string>,
 *   specialties: Record<string, string>, flags: Record<string, string>, health: Record<string, string>,
 *   access: string[], egress: string[], launchTiers: string[] }} FrontierVocabulary
 */

/**
 * Normalize a vocabulary given as maps or lists into `FrontierVocabulary`.
 * @param {Record<string, any>} source
 * @returns {FrontierVocabulary}
 */
export function frontierVocabularyView(source) {
  const view = {
    lanes: labelMap(source?.lanes),
    sourceTypes: labelMap(source?.sourceTypes),
    evidenceTypes: labelMap(source?.evidenceTypes),
    specialties: labelMap(source?.specialties),
    flags: labelMap(source?.flags),
    health: labelMap(source?.health),
    access: Object.keys(labelMap(source?.access)),
    egress: Object.keys(labelMap(source?.egress)),
    launchTiers: Object.keys(labelMap(source?.launchTiers)),
  };
  for (const [name, fallback] of [["lanes", FRONTIER_FALLBACKS.lane], ["sourceTypes", FRONTIER_FALLBACKS.source_type], ["health", FRONTIER_FALLBACKS.health]]) {
    if (!Object.hasOwn(view[name], fallback)) throw new TypeError(`The frontier vocabulary's ${name} lack the fallback ${fallback}.`);
  }
  if (!Object.keys(view.evidenceTypes).length || !Object.keys(view.specialties).length) {
    throw new TypeError("The frontier vocabulary is missing evidence types or specialties.");
  }
  return view;
}

/** The vocabulary as `@evimed/domain` defines it — what a deployment runs with. */
export function frontierDomainVocabulary() {
  return frontierVocabularyView({
    lanes: FRONTIER_LANE_LABELS_ZH,
    sourceTypes: FRONTIER_SOURCE_TYPE_LABELS_ZH,
    evidenceTypes: FRONTIER_EVIDENCE_TYPE_LABELS_ZH,
    specialties: FRONTIER_SPECIALTY_LABELS_ZH,
    flags: FRONTIER_ITEM_FLAG_LABELS_ZH,
    health: FRONTIER_HEALTH_LABELS_ZH,
    access: FRONTIER_ACCESSES,
    egress: FRONTIER_EGRESSES,
    launchTiers: FRONTIER_LAUNCH_TIERS,
  });
}

/** @param {unknown} value */
const iso = (value) => (value == null ? null : new Date(/** @type {any} */ (value)).toISOString());

/** @param {string} value */
const shortHash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** @param {unknown} value @returns {string[]} */
function stringList(value, max = 10) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).slice(0, max).map((item) => item.slice(0, 200)) : [];
}

/** @param {number} status @param {string} code @param {string} message */
const failure = (status, code, message) => new HttpError(status, code, message);

/**
 * The start of the calendar day `now` falls in, in `timeZone`, as an instant,
 * and that day's date. Exact for zones without daylight saving (Asia/Shanghai);
 * across a DST switch the offset of `now` is used.
 * @param {Date} now @param {string} timeZone
 */
export function zonedDay(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offset = wall - Math.floor(now.getTime() / 1000) * 1000;
  const midnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return { start: new Date(midnight - offset), day: `${parts.year}-${parts.month}-${parts.day}` };
}

/**
 * Whether an `If-None-Match` header names this entity tag (weak comparison,
 * RFC 9110 §13.1.2: the `W/` prefix does not take part).
 * @param {unknown} header @param {string} etag
 */
export function etagMatches(header, etag) {
  const value = Array.isArray(header) ? header.join(",") : String(header ?? "");
  if (!value.trim()) return false;
  const opaque = (/** @type {string} */ tag) => tag.trim().replace(/^W\//, "");
  return value.split(",").some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
}

/**
 * A list request's parameters, checked and normalized. Unknown parameters are
 * ignored; a known one with a value outside its vocabulary is a 400, never a
 * silent default the reader did not ask for.
 * @param {URLSearchParams} params @param {FrontierVocabulary} vocabulary
 */
export function normalizeItemsQuery(params, vocabulary) {
  const invalid = (/** @type {string} */ name) => failure(400, "frontier_query_invalid", `The ${name} parameter is invalid.`);
  const view = params.get("view") || "selected";
  if (!VIEWS.includes(view)) throw invalid("view");
  const by = params.get("by") || "timeline";
  if (!AXES.includes(by)) throw invalid("by");
  const lane = params.get("lane") || null;
  // A reader's lanes are the eight: `mixed` is a source's, never an item's.
  if (lane && (!FRONTIER_LANES.includes(/** @type {any} */ (lane)) || !Object.hasOwn(vocabulary.lanes, lane))) throw invalid("lane");
  const specialty = params.get("specialty") || null;
  if (specialty && !Object.hasOwn(vocabulary.specialties, specialty)) throw invalid("specialty");
  const window = params.get("window") || null;
  if (window && !Object.hasOwn(FRONTIER_WINDOWS, window)) throw invalid("window");
  const rawQuery = (params.get("q") ?? "").trim().replace(/\s+/g, " ");
  if (rawQuery.length > MAX_QUERY_CHARS) throw invalid("q");
  const starredValue = params.get("starred");
  if (starredValue != null && !["1", "0", ""].includes(starredValue)) throw invalid("starred");
  // 安全警示 from every lane: an official safety notice is selected whatever
  // its score, but its lane is the model's pick among the source's lanes.
  const safetyValue = params.get("safety");
  if (safetyValue != null && !["1", "0", ""].includes(safetyValue)) throw invalid("safety");
  const cursor = params.get("cursor") || null;
  if (cursor && cursor.length > MAX_CURSOR_CHARS) throw failure(400, "invalid_cursor", "The cursor is invalid; start again from the first page.");
  const limitValue = params.get("limit");
  const limit = limitValue == null || limitValue === "" ? DEFAULT_LIMIT : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw invalid("limit");
  // A list is newest first whatever it is asked; `sort` orders a search.
  const sort = params.get("sort") || "relevance";
  if (!SORTS.includes(sort)) throw invalid("sort");
  return { view, by, lane, specialty, window, q: rawQuery || null, starred: starredValue === "1", safety: safetyValue === "1", cursor, limit, sort };
}

/** @typedef {ReturnType<typeof normalizeItemsQuery>} ItemsQuery */

/** The filters a cursor was minted under, as a short fingerprint. @param {ItemsQuery} query */
const filterPrint = (query) => shortHash(JSON.stringify([query.lane, query.specialty, query.window, query.starred, query.q, query.safety,
  query.q ? query.sort : "relevance"]));

/** @param {Record<string, unknown>} value */
const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A cursor back into its position, or a 400 that sends the client to page one.
 * @param {string} cursor @param {ItemsQuery} query @param {number} version @param {boolean} search
 */
function decodeCursor(cursor, query, version, search) {
  const refused = () => failure(400, "invalid_cursor", "The list changed or the cursor does not belong to it; start again from the first page.");
  let value;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch { throw refused(); }
  if (!value || typeof value !== "object" || value.by !== query.by || value.view !== query.view || value.v !== version
    || value.f !== filterPrint(query)) throw refused();
  if (search) {
    if (!Number.isSafeInteger(value.o) || value.o < 1 || value.o > 10_000) throw refused();
    return { offset: value.o };
  }
  if (typeof value.t !== "string" || !Number.isFinite(Date.parse(value.t)) || typeof value.id !== "string" || !/^\d{1,19}$/.test(value.id)) throw refused();
  return { t: value.t, id: value.id };
}

/** Collapse a follow key or label to one clean line. @param {unknown} value @param {number} max */
function followText(value, max) {
  if (typeof value !== "string") return null;
  const cleaned = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > max || [...cleaned].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null;
  return cleaned;
}

/** The columns every item answer is built from. */
/**
 * Enrichment keys a card does not list as facts: long texts and lists (the
 * MeSH terms, the label excerpt), what another part of the card already says
 * (PubMed's types become the evidence type; open access is the 免费全文 link;
 * a preprint's other version is a flag), and nothing else — every other key,
 * including one a later plugin adds, is a fact on the card (plan §14.6).
 */
const CARD_HIDDEN_ENRICHMENT = Object.freeze(["mesh", "publication_types", "drug_label_excerpt", "oa_pdf_url", "open_access",
  "preprint_of_doi", "published_version_doi"]);
/** At most this many facts on one card. */
const CARD_FACTS_MAX = 12;

/**
 * The card's facts from a snapshot's enrichment, bounded again (the snapshot
 * may predate a bound): strings, finite numbers, booleans, lists of strings,
 * flat objects of those.
 * @param {unknown} raw @returns {Record<string, unknown>}
 */
export function frontierCardFacts(raw) {
  /** @type {Record<string, unknown>} */
  const facts = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return facts;
  /** @param {unknown} value @returns {unknown} */
  const scalar = (value) => (typeof value === "string" ? (value.trim() ? value.trim().slice(0, 300) : undefined)
    : (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" ? value : undefined);
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (Object.keys(facts).length >= CARD_FACTS_MAX) break;
    if (CARD_HIDDEN_ENRICHMENT.includes(key) || !/^[a-z][a-z0-9_]{1,39}$/.test(key)) continue;
    let kept;
    if (Array.isArray(value)) {
      const list = value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim().slice(0, 120)).slice(0, 20);
      kept = list.length ? list : undefined;
    } else if (value && typeof value === "object") {
      const flat = Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, scalar(entry)])
        .filter(([name, entry]) => entry !== undefined && /^[a-z][a-z0-9_]{1,39}$/.test(String(name))).slice(0, 10));
      kept = Object.keys(flat).length ? flat : undefined;
    } else {
      kept = scalar(value);
    }
    if (kept !== undefined) facts[key] = kept;
  }
  return facts;
}

// 「另有 N 家报道」 is by institution (plan 2026-09-23 §6.2): one row per other
// owner entity — its latest mention — and never the card's own institution
// under another feed. `mention_count` is how many there are; `mentions` names
// the five latest.
const ITEM_COLUMNS = `i.id, i.public_id, i.title_raw, i.title_zh, i.summary_zh, i.reason_zh, i.lang, i.lane, i.source_type,
  i.evidence_type, i.evidence_basis, i.specialties, i.entities, i.flags, i.doi, i.pmid, i.registry_ids, i.canonical_url,
  i.published_at, i.date_precision, i.timeline_at, i.visible_at, i.selected, i.selected_rule, i.safety_alert, i.verification,
  i.score_authority, i.score_impact, i.score_novelty, i.score_relevance, i.score_total, i.primary_source_id,
  s.name AS source_name, s.owner_entity AS source_owner, s.homepage AS source_homepage,
  t.open_access, t.enrichment->>'oa_pdf_url' AS oa_pdf_url, t.enrichment - '{${CARD_HIDDEN_ENRICHMENT.join(",")}}'::text[] AS card_enrichment,
  CASE WHEN e.report_count > 1 THEN e.public_id END AS event_public_id, e.title_zh AS event_title,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('sourceId', r.source_id, 'sourceName', r.name, 'ownerEntity', r.owner_entity, 'url', r.url)
      ORDER BY r.rank), '[]'::jsonb)
     FROM (SELECT d.source_id, d.name, d.owner_entity, d.url, row_number() OVER (ORDER BY d.published_at DESC NULLS LAST, d.source_id) AS rank
             FROM (SELECT DISTINCT ON (ms.owner_entity) im.source_id, ms.name, ms.owner_entity, im.url, im.published_at
                     FROM evimed_frontier.item_mentions im JOIN evimed_frontier.sources ms ON ms.id = im.source_id
                    WHERE im.item_id = i.id AND ms.owner_entity <> s.owner_entity AND ms.enabled
                    ORDER BY ms.owner_entity, im.published_at DESC NULLS LAST, im.source_id) d
            ORDER BY d.published_at DESC NULLS LAST, d.source_id LIMIT 5) r) AS mentions,
  (SELECT count(DISTINCT ms.owner_entity)::integer FROM evimed_frontier.item_mentions im JOIN evimed_frontier.sources ms ON ms.id = im.source_id
    WHERE im.item_id = i.id AND ms.owner_entity <> s.owner_entity AND ms.enabled) AS mention_count`;

const ITEM_FROM = `evimed_frontier.items i
  JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
  LEFT JOIN evimed_frontier.item_texts t ON t.item_id = i.id
  LEFT JOIN evimed_frontier.events e ON e.id = i.event_id`;

/** What a search leg ranks over: the filters need the item and its source, nothing else. */
const LEG_FROM = `evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id`;

export class FrontierService {
  /**
   * @param {{ database: any, config: Record<string, any>, vocabulary: FrontierVocabulary, ingest?: any, embedder?: any,
   *   budget?: (() => Promise<{ spentCny: number, budgetCny: number, state: string }>) | null, now?: () => Date,
   *   dimension?: number, cacheTtlMs?: number, events?: any, daily?: any, profiles?: any, actions?: any }} options
   *   The second wave's readers, each optional (a route without its module
   *   answers 404 `not_found`, which the page reads as 「还在准备」):
   *   `events` a `FrontierEvents` (hot list, event pages), `daily` a
   *   `FrontierDaily` (issues), `profiles` a `FrontierProfiles` (与你相关),
   *   `actions` a `FrontierActions` (存入知识库, 中文摘要).
   */
  constructor({ database, config, vocabulary, ingest = null, embedder = null, budget = null, now = () => new Date(),
    dimension = 1024, cacheTtlMs = CACHE_TTL_MS, events = null, daily = null, profiles = null, actions = null }) {
    if (!database || !config || !vocabulary) throw new TypeError("The frontier service needs the product database, the config and the vocabulary.");
    this.database = database;
    this.config = config;
    this.vocabulary = vocabulary;
    this.ingest = ingest;
    this.embedder = embedder;
    this.budgetReader = budget;
    this.now = now;
    this.dimension = dimension;
    this.cacheTtlMs = cacheTtlMs;
    this.events = events;
    this.daily = daily;
    this.profiles = profiles;
    this.actions = actions;
    /** The selection line a card's score band is read against (the pipeline's own). */
    this.selectThreshold = frontierSelectThreshold(config);
    /** @type {Map<string, { version: number, at: number, value: any }>} */
    this.cache = new Map();
    /** @type {{ at: number, value: any } | null} */
    this.statusCache = null;
    /** @type {Map<string, { at: number, value: any }>} */
    this.sourcesCache = new Map();
    this.counters = { lists: 0, notModified: 0, cacheHits: 0, searches: 0, searchFailures: 0, invalidCursors: 0, writes: 0, budgetFailures: 0,
      seenMarks: 0, seenFailures: 0 };
    /** @type {{ at: number, value: any } | null} */
    this.metricsCache = null;
    /** @type {Map<string, number>} reader → when `last_seen_at` was last written by this process */
    this.seen = new Map();
  }

  async ready() { return migrateFrontier(this.database, { dimension: this.dimension }); }

  /** Whether this account sees the module. @param {{ id?: string }} user */
  allows(user) { return frontierAudienceAllows(this.config, user); }

  /** Whether this account may use the operator routes. @param {{ id?: string }} user */
  isOperator(user) { return (this.config.operatorUsers ?? []).includes(String(user?.id ?? "")); }

  /**
   * Run `operation` in a transaction with the module's own statement timeout.
   * @template T @param {(client: any) => Promise<T>} operation @returns {Promise<T>}
   */
  async #transaction(operation) {
    await this.ready();
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      return operation(client);
    });
  }

  /** @param {any} client @param {string} userId */
  async #versions(client, userId) {
    const result = await client.query(`SELECT (SELECT value FROM evimed_frontier.meta WHERE key=$1) AS content,
      (SELECT state_version FROM evimed_frontier.user_prefs WHERE user_id=$2) AS state`, [FRONTIER_META_KEYS.contentVersion, userId]);
    return { content: metaNumber(result.rows[0]?.content), state: Number(result.rows[0]?.state ?? 0) };
  }

  /** @param {string} key @param {number} version */
  #cached(key, version) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.version !== version || this.now().getTime() - entry.at > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    this.counters.cacheHits += 1;
    return entry.value;
  }

  /** @param {string} key @param {number} version @param {any} value */
  #remember(key, version, value) {
    this.cache.delete(key);
    this.cache.set(key, { version, at: this.now().getTime(), value });
    while (this.cache.size > CACHE_MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value);
  }

  /**
   * One item row as a reader sees it, without the reader's own state.
   * @param {Record<string, any>} row
   */
  #item(row) {
    const labels = this.vocabulary;
    const entities = row.entities && typeof row.entities === "object" ? row.entities : {};
    const openAccess = row.open_access || row.oa_pdf_url
      ? { status: row.open_access ?? "unknown", pdfUrl: typeof row.oa_pdf_url === "string" && /^https?:\/\//.test(row.oa_pdf_url) ? row.oa_pdf_url : null }
      : null;
    return {
      id: row.public_id,
      title: row.title_zh || row.title_raw,
      titleRaw: row.title_raw,
      titleZh: row.title_zh ?? null,
      summary: row.summary_zh ?? null,
      reason: row.reason_zh ?? null,
      lang: row.lang,
      lane: row.lane,
      laneLabel: labels.lanes[row.lane] ?? row.lane,
      sourceType: row.source_type,
      sourceTypeLabel: labels.sourceTypes[row.source_type] ?? labels.sourceTypes[FRONTIER_FALLBACKS.source_type],
      evidenceType: row.evidence_type ?? null,
      evidenceTypeLabel: row.evidence_type ? labels.evidenceTypes[row.evidence_type] ?? null : null,
      evidenceBasis: row.evidence_basis ?? null,
      specialties: (row.specialties ?? []).filter((key) => Object.hasOwn(labels.specialties, key))
        .map((key) => ({ key, label: labels.specialties[key] })),
      flags: (row.flags ?? []).filter((key) => Object.hasOwn(labels.flags, key)).map((key) => ({ key, label: labels.flags[key] })),
      entities: { drugs: stringList(entities.drugs), trials: stringList(entities.trials), orgs: stringList(entities.orgs), diseases: stringList(entities.diseases) },
      source: { id: row.primary_source_id, name: frontierSourceDisplayName({ id: row.primary_source_id, name: row.source_name, ownerEntity: row.source_owner }),
        homepage: row.source_homepage ?? null },
      url: row.canonical_url,
      doi: row.doi ?? null,
      pmid: row.pmid ?? null,
      registryIds: row.registry_ids ?? [],
      publishedAt: iso(row.published_at),
      datePrecision: row.date_precision,
      timelineAt: iso(row.timeline_at),
      visibleAt: iso(row.visible_at),
      selected: row.selected === true,
      selectedRule: row.selected ? row.selected_rule ?? null : null,
      safetyAlert: row.safety_alert === true,
      verification: row.verification,
      // The editorial total and its band; a safety alert is not scored for a reader.
      score: row.safety_alert === true || row.score_total == null ? null : Number(row.score_total),
      scoreBand: row.safety_alert === true ? null : frontierScoreBand(row.score_total, this.selectThreshold),
      levels: {
        authority: frontierScoreLevel("authority", row.score_authority),
        impact: frontierScoreLevel("impact", row.score_impact),
        novelty: frontierScoreLevel("novelty", row.score_novelty),
        relevance: frontierScoreLevel("relevance", row.score_relevance),
      },
      openAccess,
      facts: frontierCardFacts(row.card_enrichment),
      alsoReportedBy: (Array.isArray(row.mentions) ? row.mentions.slice(0, 5) : []).map((/** @type {any} */ mention) => ({
        sourceId: mention.sourceId,
        sourceName: frontierSourceDisplayName({ id: mention.sourceId, name: mention.sourceName, ownerEntity: mention.ownerEntity }),
        url: mention.url,
      })),
      alsoReportedCount: Number(row.mention_count ?? 0),
      event: row.event_public_id ? { id: row.event_public_id, title: row.event_title } : null,
    };
  }

  /**
   * The WHERE clause every list and search leg shares.
   * @param {ItemsQuery} query @param {{ userId: string, search: boolean }} scope @param {any[]} values
   */
  #filters(query, { userId, search }, values) {
    const param = (/** @type {unknown} */ value) => { values.push(value); return `$${values.length}`; };
    const axis = query.by === "published" ? "i.published_at" : "i.timeline_at";
    const where = ["i.state = 'published'", "s.enabled"];
    if (query.by === "published") where.push("i.published_at IS NOT NULL");
    // Searching the selected view searches everything and marks the selected.
    if (query.view === "selected" && !search) where.push("i.selected");
    if (query.lane) where.push(`i.lane = ${param(query.lane)}`);
    if (query.specialty) where.push(`i.specialties @> ARRAY[${param(query.specialty)}]::text[]`);
    if (query.safety) where.push("i.safety_alert");
    if (query.window) where.push(`${axis} >= ${param(new Date(this.now().getTime() - FRONTIER_WINDOWS[query.window]).toISOString())}::timestamptz`);
    if (query.starred) {
      where.push(`EXISTS (SELECT 1 FROM evimed_frontier.user_state us WHERE us.user_id = ${param(userId)} AND us.item_id = i.id AND us.starred_at IS NOT NULL)`);
    }
    return { where, axis, param };
  }

  /**
   * One page of a list: rows by the axis, newest first, from the cursor.
   * @param {any} client @param {ItemsQuery} query @param {string} userId @param {{ t: string, id: string } | null} position
   */
  async #listPage(client, query, userId, position) {
    /** @type {any[]} */
    const values = [];
    const { where, axis, param } = this.#filters(query, { userId, search: false }, values);
    if (position) where.push(`(${axis}, i.id) < (${param(position.t)}::timestamptz, ${param(position.id)}::bigint)`);
    const rows = (await client.query(`SELECT ${ITEM_COLUMNS}, ${axis} AS position_at FROM ${ITEM_FROM}
      WHERE ${where.join(" AND ")} ORDER BY ${axis} DESC, i.id DESC LIMIT ${param(query.limit + 1)}`, values)).rows;
    const more = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({ rowId: String(row.id), item: this.#item(row) })),
      next: more && last ? { t: iso(last.position_at), id: String(last.id) } : null,
    };
  }

  /**
   * The fused ranking of a search, best first (at most three legs of fifty).
   * @param {ItemsQuery} query @param {string} userId
   * @returns {Promise<{ ids: string[], lexical: string[], mode: "keyword" | "hybrid", legs: Record<string, number>, vectorSkipped?: string }>}
   */
  async #searchRanking(query, userId) {
    const capabilities = await this.ready();
    const q = String(query.q);
    /** @type {Record<string, string[]>} */
    const legs = {};
    const tsquery = tsqueryLiteral(q);
    const words = trigramTerms(q);
    await this.#transaction(async (client) => {
      if (tsquery) {
        /** @type {any[]} */
        const values = [];
        const { where, param } = this.#filters(query, { userId, search: true }, values);
        const term = param(tsquery);
        legs.keyword = (await client.query(`SELECT i.id FROM ${LEG_FROM} WHERE ${where.join(" AND ")} AND i.lexemes @@ ${term}::tsquery
          ORDER BY ts_rank(i.lexemes, ${term}::tsquery, 1) DESC, i.timeline_at DESC, i.id DESC LIMIT ${LEG_LIMIT}`, values))
          .rows.map((/** @type {any} */ row) => String(row.id));
      }
      if (capabilities.trigram && words.length) {
        /** @type {any[]} */
        const values = [];
        const { where, param } = this.#filters(query, { userId, search: true }, values);
        const terms = param(words);
        legs.trigram = (await client.query(`SELECT i.id, max(word_similarity(w.term, i.title_raw || ' ' || coalesce(i.title_zh, ''))) AS score
          FROM ${LEG_FROM} JOIN unnest(${terms}::text[]) AS w(term) ON w.term <% (i.title_raw || ' ' || coalesce(i.title_zh, ''))
          WHERE ${where.join(" AND ")} GROUP BY i.id ORDER BY score DESC, i.id DESC LIMIT ${LEG_LIMIT}`, values))
          .rows.map((/** @type {any} */ row) => String(row.id));
      }
    });
    /** @type {string | undefined} */
    let vectorSkipped;
    if (capabilities.vector && this.embedder?.configured) {
      try {
        const vector = await this.embedder.embedQuery(q);
        if (!Array.isArray(vector) || vector.length !== this.dimension || !vector.every(Number.isFinite)) {
          throw failure(502, "frontier_embedding_invalid", "The query embedding has the wrong shape.");
        }
        const type = capabilities.halfvec ? "halfvec" : "vector";
        legs.vector = await this.#transaction(async (client) => {
          if (capabilities.iterativeScan) await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
          /** @type {any[]} */
          const values = [];
          const { where, param } = this.#filters(query, { userId, search: true }, values);
          const model = param(this.embedder.modelKey);
          const target = param(`[${vector.join(",")}]`);
          return (await client.query(`SELECT i.id FROM ${LEG_FROM} JOIN evimed_frontier.item_vectors v ON v.item_id = i.id
            WHERE ${where.join(" AND ")} AND v.model_key = ${model}
            ORDER BY v.embedding <=> ${target}::${type} LIMIT ${LEG_LIMIT}`, values)).rows.map((/** @type {any} */ row) => String(row.id));
        });
      } catch (error) {
        // Keyword search still answers; the result says the vector leg did not run.
        vectorSkipped = typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "frontier_embedding_failed";
      }
    }
    /** @type {Map<string, { score: number, first: number }>} */
    const fused = new Map();
    for (const [name, ranked] of Object.entries(legs)) {
      ranked.forEach((id, index) => {
        const entry = fused.get(id) ?? { score: 0, first: Number.MAX_SAFE_INTEGER };
        entry.score += 1 / (FRONTIER_RRF_K + index + 1);
        if (name === "keyword") entry.first = Math.min(entry.first, index);
        fused.set(id, entry);
      });
    }
    const ids = [...fused.entries()]
      .sort((left, right) => right[1].score - left[1].score || left[1].first - right[1].first || Number(right[0]) - Number(left[0]))
      .map(([id]) => id);
    // What the words matched, in the fused order: what a search by time lists.
    const worded = new Set([...(legs.keyword ?? []), ...(legs.trigram ?? [])]);
    return {
      ids, mode: legs.vector ? "hybrid" : "keyword", lexical: ids.filter((id) => worded.has(id)),
      legs: Object.fromEntries(Object.entries(legs).map(([name, ranked]) => [name, ranked.length])),
      ...(vectorSkipped ? { vectorSkipped } : {}),
    };
  }

  /**
   * A search's matches newest first (`sort=time`): the items the words matched
   * — the keyword and trigram legs — on the list's own axis, or the fused
   * ranking when the words matched nothing (see the module note). Kept for
   * the next pages, as the ranking is.
   * @param {{ ids: string[], lexical: string[], mode: "keyword" | "hybrid" }} ranking @param {ItemsQuery} query
   * @param {number} version @param {number} clock
   * @returns {Promise<{ ids: string[], mode: "keyword" | "hybrid" }>}
   */
  async #byTime(ranking, query, version, clock) {
    const key = query.starred ? null : JSON.stringify(["time", query.by, query.lane, query.specialty, query.window, query.q, query.safety, clock]);
    const cached = key ? this.#cached(key, version) : null;
    if (cached) return cached;
    const candidates = ranking.lexical.length ? ranking.lexical : ranking.ids;
    const axis = query.by === "published" ? "i.published_at" : "i.timeline_at";
    const ids = candidates.length ? await this.#transaction(async (client) => (await client.query(`SELECT i.id FROM evimed_frontier.items i
      WHERE i.id = ANY($1::bigint[]) ORDER BY ${axis} DESC NULLS LAST, i.id DESC`, [candidates])).rows.map((/** @type {any} */ row) => String(row.id))) : [];
    const value = { ids, mode: /** @type {"keyword" | "hybrid"} */ (ranking.lexical.length ? "keyword" : ranking.mode) };
    if (key) this.#remember(key, version, value);
    return value;
  }

  /**
   * Rows for these ids, in this order.
   * @param {any} client @param {string[]} ids
   */
  async #rowsById(client, ids) {
    if (!ids.length) return [];
    const rows = (await client.query(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
      WHERE i.id = ANY($1::bigint[]) AND i.state = 'published' AND s.enabled`, [ids])).rows;
    const byId = new Map(rows.map((/** @type {any} */ row) => [String(row.id), row]));
    return ids.map((id) => byId.get(id)).filter(Boolean).map((row) => ({ rowId: String(row.id), item: this.#item(row) }));
  }

  /**
   * The reader's own star, hide and read marks for a page, in one query.
   * @param {any} client @param {string} userId @param {string[]} rowIds
   */
  async #overlay(client, userId, rowIds) {
    if (!rowIds.length) return new Map();
    const rows = (await client.query(`SELECT item_id, starred_at IS NOT NULL AS starred, hidden_at IS NOT NULL AS hidden,
      read_at IS NOT NULL AS read FROM evimed_frontier.user_state WHERE user_id=$1 AND item_id = ANY($2::bigint[])`, [userId, rowIds])).rows;
    return new Map(rows.map((/** @type {any} */ row) => [String(row.item_id), { starred: row.starred, hidden: row.hidden, read: row.read }]));
  }

  /**
   * A list or search page for one reader, or a 304.
   * @param {{ id: string }} user @param {URLSearchParams} params @param {unknown} ifNoneMatch
   * @returns {Promise<{ status: 200 | 304, etag: string, body?: any }>}
   */
  async listItems(user, params, ifNoneMatch = null) {
    const query = normalizeItemsQuery(params, this.vocabulary);
    this.counters.lists += 1;
    const versions = await this.#transaction((client) => this.#versions(client, user.id));
    // A window cuts by the clock as well as by content: the tag moves with the
    // minute the page was cut in, which is also the public cache's lifetime.
    const clock = query.window ? Math.floor(this.now().getTime() / 60_000) : 0;
    // The account is in the digest: two people on one browser must never be
    // handed each other's marks out of its cache by a matching tag.
    const etag = `W/"${versions.content}.${versions.state}.${shortHash(JSON.stringify([user.id, query, clock]))}"`;
    if (etagMatches(ifNoneMatch, etag)) {
      this.counters.notModified += 1;
      return { status: 304, etag };
    }
    const search = Boolean(query.q);
    let position = null;
    let offset = 0;
    if (query.cursor) {
      try {
        const decoded = decodeCursor(query.cursor, query, versions.content, search);
        if ("offset" in decoded) offset = decoded.offset;
        else position = decoded;
      } catch (error) {
        this.counters.invalidCursors += 1;
        throw error;
      }
    }
    // Public content is shared by every reader; "only my stars" is not.
    const cacheKey = query.starred ? null : JSON.stringify([search ? "search" : "list", query.view, query.by, query.lane, query.specialty,
      query.window, query.q, query.safety, query.cursor, query.limit, clock, search ? query.sort : null]);
    let page = cacheKey ? this.#cached(cacheKey, versions.content) : null;
    if (!page) {
      if (search) {
        // The fused ranking is kept for the next pages of the same search: a
        // second page must not embed the question and run three legs again.
        const rankingKey = query.starred ? null : JSON.stringify(["ranking", query.by, query.lane, query.specialty, query.window, query.q, query.safety, clock]);
        let ranking = rankingKey ? this.#cached(rankingKey, versions.content) : null;
        if (!ranking) {
          this.counters.searches += 1;
          try { ranking = await this.#searchRanking(query, user.id); }
          catch (error) { this.counters.searchFailures += 1; throw error; }
          if (rankingKey) this.#remember(rankingKey, versions.content, ranking);
        }
        const ordered = query.sort === "time" ? await this.#byTime(ranking, query, versions.content, clock) : ranking;
        const slice = ordered.ids.slice(offset, offset + query.limit);
        const items = await this.#transaction((client) => this.#rowsById(client, slice));
        const more = offset + query.limit < ordered.ids.length;
        page = {
          items, mode: ordered.mode,
          next: more ? encodeCursor({ by: query.by, view: query.view, v: versions.content, f: filterPrint(query), o: offset + query.limit }) : null,
        };
      } else {
        const listed = await this.#transaction((client) => this.#listPage(client, query, user.id, position));
        page = {
          items: listed.items, mode: "list",
          next: listed.next ? encodeCursor({ by: query.by, view: query.view, v: versions.content, f: filterPrint(query), t: listed.next.t, id: listed.next.id }) : null,
        };
      }
      if (cacheKey) this.#remember(cacheKey, versions.content, page);
    }
    const marks = await this.#transaction((client) => this.#overlay(client, user.id, page.items.map((entry) => entry.rowId)));
    const items = page.items
      .map((entry) => ({ ...entry.item, state: marks.get(entry.rowId) ?? { starred: false, hidden: false, read: false } }))
      .filter((item) => query.starred || !item.state.hidden);
    return { status: 200, etag, body: { items, nextCursor: page.next, version: String(versions.content), mode: page.mode } };
  }

  /**
   * One published item with its abstract and enrichment, or a 404.
   * @param {{ id: string }} user @param {string} publicId @param {unknown} ifNoneMatch
   */
  async getItem(user, publicId, ifNoneMatch = null) {
    if (!PUBLIC_ID.test(String(publicId ?? ""))) throw failure(404, "frontier_item_not_found", "No such item.");
    return this.#transaction(async (client) => {
      const versions = await this.#versions(client, user.id);
      const etag = `W/"${versions.content}.${versions.state}.${shortHash(`item:${user.id}:${publicId}`)}"`;
      if (etagMatches(ifNoneMatch, etag)) {
        this.counters.notModified += 1;
        return { status: /** @type {const} */ (304), etag };
      }
      const row = (await client.query(`SELECT ${ITEM_COLUMNS}, t.abstract_raw, t.abstract_zh, t.publication_types, t.mesh, t.journal,
          t.authors_short, t.enrichment
        FROM ${ITEM_FROM} WHERE i.public_id=$1 AND i.state = 'published' AND s.enabled`, [publicId])).rows[0];
      if (!row) throw failure(404, "frontier_item_not_found", "No such item.");
      const marks = await this.#overlay(client, user.id, [String(row.id)]);
      const enrichment = row.enrichment && typeof row.enrichment === "object" ? row.enrichment : {};
      return {
        status: /** @type {const} */ (200), etag,
        body: {
          item: {
            ...this.#item(row),
            state: marks.get(String(row.id)) ?? { starred: false, hidden: false, read: false },
            abstract: row.abstract_raw ?? null,
            abstractZh: row.abstract_zh ?? null,
            enrichment: {
              publicationTypes: row.publication_types ?? [],
              mesh: row.mesh ?? [],
              journal: row.journal ?? null,
              authorsShort: row.authors_short ?? null,
              impactFactor: typeof enrichment.impact_factor === "number" ? enrichment.impact_factor : null,
              coreJournalTags: stringList(enrichment.core_journal_tags, 20),
              trialFacts: enrichment.trial_facts && typeof enrichment.trial_facts === "object" ? enrichment.trial_facts : null,
              preprintOfDoi: typeof enrichment.preprint_of_doi === "string" ? enrichment.preprint_of_doi : null,
              publishedVersionDoi: typeof enrichment.published_version_doi === "string" ? enrichment.published_version_doi : null,
            },
          },
        },
      };
    });
  }

  /**
   * The sources' health, as the status route and the sources page count it.
   * `new` is a source the plugin has just connected — not a problem state —
   * and is counted with the healthy ones; a health word the vocabulary does
   * not know is counted as degraded.
   * @param {any} client
   */
  async #sourceCounts(client) {
    const rows = (await client.query(`SELECT plugin_health AS health, enabled, count(*)::integer AS n
      FROM evimed_frontier.sources WHERE retired_at IS NULL GROUP BY plugin_health, enabled`)).rows;
    const counts = { total: 0, enabled: 0, healthy: 0, degraded: 0, unreadable: 0, drifted: 0, planned: 0 };
    for (const row of rows) {
      const health = Object.hasOwn(this.vocabulary.health, row.health) ? row.health : FRONTIER_FALLBACKS.health;
      counts.total += row.n;
      if (health === "disabled") { counts.planned += row.n; continue; }
      if (row.enabled) counts.enabled += row.n;
      if (health === "healthy" || health === "new") counts.healthy += row.n;
      else if (health === "unreadable") counts.unreadable += row.n;
      else if (health === "drifted") counts.drifted += row.n;
      else counts.degraded += row.n;
    }
    return counts;
  }

  /**
   * Today's `frontier` spend against the day's budget, as the pipeline reads
   * it — the one implementation of that sum, and the one the pipeline gates
   * on (`FrontierPipeline.budget`). A reader that fails, or none at all, is
   * `unavailable` with no number: never a guessed `ok`, and never the reason
   * the page header fails to load.
   */
  async budget() {
    const budgetCny = Number(this.config.frontierDailyBudgetCny) || 0;
    if (!this.budgetReader) return { spentCny: null, budgetCny, state: "unavailable" };
    try {
      const read = await this.budgetReader();
      return { spentCny: Number(read.spentCny), budgetCny: Number(read.budgetCny), state: String(read.state) };
    } catch {
      this.counters.budgetFailures += 1;
      return { spentCny: null, budgetCny, state: "unavailable" };
    }
  }

  /**
   * The module's state for the page header and the 「有 N 条新的」 banner.
   * Shared by every reader and cached for ten seconds.
   */
  async status() {
    const now = this.now().getTime();
    if (this.statusCache && now - this.statusCache.at < STATUS_TTL_MS) return this.statusCache.value;
    const { start } = zonedDay(this.now(), this.config.frontierTimeZone || "Asia/Shanghai");
    const read = await this.#transaction(async (client) => {
      const meta = Object.fromEntries((await client.query(`SELECT key, value FROM evimed_frontier.meta WHERE key = ANY($1::text[])`,
        [[FRONTIER_META_KEYS.contentVersion, FRONTIER_META_KEYS.hotVersion, FRONTIER_META_KEYS.dailyVersion, FRONTIER_META_KEYS.pluginCursor]]))
        .rows.map((/** @type {any} */ row) => [row.key, row.value]));
      const today = (await client.query(`SELECT count(*)::integer AS today, count(*) FILTER (WHERE i.selected)::integer AS selected
        FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
        WHERE i.state = 'published' AND s.enabled AND i.visible_at >= $1::timestamptz`, [start.toISOString()])).rows[0];
      const last = (await client.query(`SELECT max(visible_at) AS at FROM evimed_frontier.items WHERE state = 'published'`)).rows[0];
      const daily = (await client.query(`SELECT max(day)::text AS day FROM evimed_frontier.dailies`)).rows[0];
      return { meta, today, last, daily, sources: await this.#sourceCounts(client) };
    });
    const plugin = this.ingest?.status?.() ?? null;
    const cursor = metaNumber(read.meta[FRONTIER_META_KEYS.pluginCursor]);
    const latestSeq = plugin?.latestSeq ?? null;
    // 「与你相关」: `off` where this deployment cannot personalize at all,
    // `unavailable` while the memory store is failing (profiles.state()).
    const personalization = this.profiles?.state?.() ?? "off";
    const actions = this.actions?.capabilities?.() ?? { saveToLibrary: false, abstractZh: false };
    const value = {
      enabled: true,
      audience: this.config.frontierAudience,
      plugin: {
        state: plugin?.state ?? "unconfigured",
        contract: plugin?.contract ?? null,
        version: plugin?.version ?? null,
        // The last time the stream was read successfully: what 「最近更新于」 means.
        lastPullAt: plugin?.lastPullOkAt ?? null,
        cursor,
        latestSeq,
        lag: latestSeq != null ? Math.max(0, latestSeq - cursor) : null,
      },
      lastPublishedAt: iso(read.last?.at),
      lastDailyDay: read.daily?.day ?? null,
      sources: read.sources,
      counts: { today: read.today?.today ?? 0, selectedToday: read.today?.selected ?? 0 },
      budget: await this.budget(),
      personalization,
      // What the page may offer beyond the lists; an absent module is false,
      // so a button is never shown for a route that would answer 404.
      capabilities: {
        saveToLibrary: Boolean(actions.saveToLibrary),
        abstractZh: Boolean(actions.abstractZh),
        forYou: personalization !== "off",
        hot: Boolean(this.events),
        daily: Boolean(this.daily),
      },
      versions: {
        content: String(metaNumber(read.meta[FRONTIER_META_KEYS.contentVersion])),
        hot: String(metaNumber(read.meta[FRONTIER_META_KEYS.hotVersion])),
        daily: String(metaNumber(read.meta[FRONTIER_META_KEYS.dailyVersion])),
      },
    };
    this.statusCache = { at: now, value };
    return value;
  }

  /**
   * The status with its entity tag: the page polls it every two minutes for
   * the 「有 N 条新的」 banner, and an unchanged status is a 304.
   * @param {unknown} ifNoneMatch
   * @returns {Promise<{ status: 200 | 304, etag: string, body?: any }>}
   */
  async statusAnswer(ifNoneMatch = null) {
    const value = await this.status();
    const etag = `W/"status.${shortHash(JSON.stringify(value))}"`;
    if (etagMatches(ifNoneMatch, etag)) {
      this.counters.notModified += 1;
      return { status: 304, etag };
    }
    return { status: 200, etag, body: value };
  }

  /**
   * The public sources page: the mirror, never the plugin. Readers see the
   * sources that are on and not retired; operators see every row.
   * @param {{ id: string }} user
   */
  async sources(user) {
    const operator = this.isOperator(user);
    const key = operator ? "operator" : "reader";
    const cached = this.sourcesCache.get(key);
    if (cached && this.now().getTime() - cached.at < this.cacheTtlMs) return cached.value;
    const value = await this.#transaction(async (client) => {
      const rows = (await client.query(`SELECT id, name, owner_entity, homepage, lane, source_type, access, egress, launch_tier, plugin_health,
          last_ok_at, last_new_entry_at, entries_7d, selected_30d, enabled, retired_at, mirrored_at
        FROM evimed_frontier.sources ${operator ? "" : "WHERE enabled AND retired_at IS NULL"} ORDER BY lane, name, id`)).rows;
      const manifest = (await client.query(`SELECT value FROM evimed_frontier.meta WHERE key=$1`, [FRONTIER_META_KEYS.pluginManifest])).rows[0]?.value;
      const mirrored = (await client.query(`SELECT max(mirrored_at) AS at FROM evimed_frontier.sources`)).rows[0]?.at;
      return {
        mirroredAt: iso(mirrored),
        plugin: {
          version: manifest?.manifest?.plugin?.version ?? null,
          contract: manifest?.manifest?.contract?.version ?? null,
          fields: manifest?.manifest?.fields ?? { entry: [], facts: [], enrichment: [] },
        },
        counts: await this.#sourceCounts(client),
        sources: rows.map((/** @type {any} */ row) => this.#source(row)),
      };
    });
    this.sourcesCache.set(key, { at: this.now().getTime(), value });
    return value;
  }

  /**
   * One row of the sources list: the registry's name (the feed — what the list
   * is a list of), the institution a reader knows it by, and how many of its
   * items were selected in the last thirty days (「近 30 天精选」, recounted
   * hourly by the worker).
   * @param {Record<string, any>} row
   */
  #source(row) {
    const health = Object.hasOwn(this.vocabulary.health, row.plugin_health) ? row.plugin_health : FRONTIER_FALLBACKS.health;
    return {
      id: row.id,
      name: row.name,
      displayName: frontierSourceDisplayName({ id: row.id, name: row.name, ownerEntity: row.owner_entity }),
      homepage: row.homepage ?? null,
      lane: row.lane,
      laneLabel: this.vocabulary.lanes[row.lane] ?? row.lane,
      sourceType: row.source_type,
      sourceTypeLabel: this.vocabulary.sourceTypes[row.source_type] ?? row.source_type,
      access: row.access,
      egress: row.egress,
      launchTier: row.launch_tier,
      health,
      healthLabel: this.vocabulary.health[health],
      lastOkAt: iso(row.last_ok_at),
      lastNewEntryAt: iso(row.last_new_entry_at),
      entries7d: Number(row.entries_7d ?? 0),
      selected30d: Number(row.selected_30d ?? 0),
      enabled: row.enabled === true,
      retired: row.retired_at != null,
    };
  }

  /** Bump the reader's state version inside the caller's transaction. @param {any} client @param {string} userId */
  async #bumpState(client, userId) {
    await client.query(`INSERT INTO evimed_frontier.user_prefs(user_id, state_version) VALUES ($1, 1)
      ON CONFLICT (user_id) DO UPDATE SET state_version = evimed_frontier.user_prefs.state_version + 1`, [userId]);
  }

  /**
   * Star, unstar, hide, unhide or mark read one item for one reader.
   * @param {{ id: string }} user @param {string} publicId @param {"star" | "unstar" | "hide" | "unhide" | "read"} action
   */
  async setItemState(user, publicId, action) {
    const columns = { star: ["starred_at", true], unstar: ["starred_at", false], hide: ["hidden_at", true], unhide: ["hidden_at", false], read: ["read_at", true] };
    if (!Object.hasOwn(columns, action)) throw failure(404, "not_found", "Frontier route not found.");
    if (!PUBLIC_ID.test(String(publicId ?? ""))) throw failure(404, "frontier_item_not_found", "No such item.");
    const [column, set] = columns[action];
    const state = await this.#transaction(async (client) => {
      const item = (await client.query(`SELECT id FROM evimed_frontier.items WHERE public_id=$1 AND state IN ('published','withdrawn')`, [publicId])).rows[0];
      if (!item) throw failure(404, "frontier_item_not_found", "No such item.");
      // The first time counts: a second star keeps when it was starred.
      const row = (await client.query(`INSERT INTO evimed_frontier.user_state AS us (user_id, item_id, ${column})
          VALUES ($1, $2, ${set ? "clock_timestamp()" : "NULL"})
        ON CONFLICT (user_id, item_id) DO UPDATE SET ${column} = ${set ? `coalesce(us.${column}, clock_timestamp())` : "NULL"}
        RETURNING starred_at IS NOT NULL AS starred, hidden_at IS NOT NULL AS hidden, read_at IS NOT NULL AS read`, [user.id, item.id])).rows[0];
      await this.#bumpState(client, user.id);
      return row;
    });
    this.counters.writes += 1;
    // What the reader just did is what 与我相关 is read from: after the
    // commit, and never failing the action (frontierProfiles.mjs).
    await this.profiles?.noteItemAction?.(user.id, action);
    return { state: { starred: state.starred, hidden: state.hidden, read: state.read } };
  }

  /** @param {Record<string, any>} row */
  #follow(row) {
    return { id: String(row.id), kind: row.kind, key: row.key, label: row.label, muted: row.muted === true, createdAt: iso(row.created_at) };
  }

  /** @param {{ id: string }} user */
  async listFollows(user) {
    const rows = await this.#transaction(async (client) => (await client.query(`SELECT id, kind, key, label, muted, created_at
      FROM evimed_frontier.user_follows WHERE user_id=$1 ORDER BY created_at DESC, id DESC`, [user.id])).rows);
    return { follows: rows.map((/** @type {any} */ row) => this.#follow(row)) };
  }

  /**
   * Follow (or mute) a topic, specialty, drug, source or event. Upserts by
   * (kind, key): following again changes the label or the mute, never adds a row.
   * @param {{ id: string }} user @param {{ kind?: unknown, key?: unknown, label?: unknown, muted?: unknown }} body
   */
  async createFollow(user, body) {
    const kind = String(body.kind ?? "");
    if (!FOLLOW_KINDS.includes(kind)) throw failure(400, "frontier_follow_invalid", "The follow kind is invalid.");
    if (body.muted != null && typeof body.muted !== "boolean") throw failure(400, "frontier_follow_invalid", "muted must be a boolean.");
    let key;
    if (kind === "specialty") {
      key = typeof body.key === "string" && Object.hasOwn(this.vocabulary.specialties, body.key) ? body.key : null;
    } else if (kind === "event") {
      key = typeof body.key === "string" && PUBLIC_ID.test(body.key) ? body.key : null;
    } else if (kind === "source") {
      key = typeof body.key === "string" && body.key.length <= 120 ? body.key : null;
    } else {
      // Topics and drugs are the reader's words: compared case-folded.
      key = followText(body.key, 120)?.toLowerCase() ?? null;
    }
    if (!key) throw failure(400, "frontier_follow_invalid", "The follow key is invalid.");
    const label = body.label == null ? (kind === "specialty" ? this.vocabulary.specialties[key] : key) : followText(body.label, 120);
    if (!label) throw failure(400, "frontier_follow_invalid", "The follow label is invalid.");
    const row = await this.#transaction(async (client) => {
      if (kind === "source" && !(await client.query("SELECT 1 FROM evimed_frontier.sources WHERE id=$1", [key])).rowCount) {
        throw failure(400, "frontier_follow_invalid", "No such source.");
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`frontier-follows:${user.id}`]);
      const existing = await client.query(`SELECT 1 FROM evimed_frontier.user_follows WHERE user_id=$1 AND kind=$2 AND key=$3`, [user.id, kind, key]);
      if (!existing.rowCount) {
        const count = Number((await client.query("SELECT count(*)::integer AS n FROM evimed_frontier.user_follows WHERE user_id=$1", [user.id])).rows[0].n);
        if (count >= MAX_FOLLOWS) throw failure(409, "frontier_follow_limit", `At most ${MAX_FOLLOWS} follows per account.`);
      }
      const saved = (await client.query(`INSERT INTO evimed_frontier.user_follows AS f (user_id, kind, key, label, muted) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (user_id, kind, key) DO UPDATE SET label = EXCLUDED.label, muted = EXCLUDED.muted
        RETURNING id, kind, key, label, muted, created_at`, [user.id, kind, key, label, body.muted === true])).rows[0];
      await this.#bumpState(client, user.id);
      return saved;
    });
    this.counters.writes += 1;
    return { follow: this.#follow(row) };
  }

  /** @param {{ id: string }} user @param {string} followId */
  async deleteFollow(user, followId) {
    if (!/^\d{1,18}$/.test(String(followId ?? ""))) throw failure(404, "frontier_follow_not_found", "No such follow.");
    await this.#transaction(async (client) => {
      const removed = await client.query("DELETE FROM evimed_frontier.user_follows WHERE user_id=$1 AND id=$2", [user.id, followId]);
      if (!removed.rowCount) throw failure(404, "frontier_follow_not_found", "No such follow.");
      await this.#bumpState(client, user.id);
    });
    this.counters.writes += 1;
    return { deleted: true };
  }

  // ───────────────────────── wave two: the reader's side ─────────────────────────

  /**
   * Record that this reader opened the page (`user_prefs.last_seen_at`): the
   * daily is pushed to readers seen in the last 14 days, and profiles are
   * computed for them. Written at most every ten minutes per reader by this
   * process, never bumps the reader's state version (no list changes), and
   * never fails the read that asked: a failure is counted.
   * @param {{ id: string }} user
   */
  async markSeen(user) {
    const at = this.now().getTime();
    const last = this.seen.get(user.id);
    if (last != null && at - last < SEEN_INTERVAL_MS) return;
    this.seen.set(user.id, at);
    if (this.seen.size > 10_000) this.seen.clear();
    try {
      await this.#transaction((client) => client.query(`INSERT INTO evimed_frontier.user_prefs (user_id, last_seen_at) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET last_seen_at = GREATEST(coalesce(evimed_frontier.user_prefs.last_seen_at, EXCLUDED.last_seen_at),
          EXCLUDED.last_seen_at)`, [user.id, new Date(at)]));
      this.counters.seenMarks += 1;
    } catch {
      this.seen.delete(user.id);
      this.counters.seenFailures += 1;
    }
  }

  /**
   * Published items of enabled sources, by public id or row id, each as a
   * reader sees it with their own marks; what is missing (withdrawn, hidden
   * source) is simply absent from the map.
   * @param {{ id: string }} user @param {{ publicIds?: string[], rowIds?: string[] }} ids
   * @returns {Promise<Map<string, any>>} keyed as asked
   */
  async hydrate(user, { publicIds = [], rowIds = [] }) {
    const wanted = publicIds.length ? publicIds.filter((id) => PUBLIC_ID.test(String(id))) : rowIds.filter((id) => /^\d{1,19}$/.test(String(id)));
    if (!wanted.length) return new Map();
    return this.#transaction(async (client) => {
      const rows = (await client.query(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
        WHERE ${publicIds.length ? "i.public_id = ANY($1::text[])" : "i.id = ANY($1::bigint[])"} AND i.state = 'published' AND s.enabled`,
      [wanted])).rows;
      const marks = await this.#overlay(client, user.id, rows.map((/** @type {any} */ row) => String(row.id)));
      return new Map(rows.map((/** @type {any} */ row) => [publicIds.length ? row.public_id : String(row.id), {
        ...this.#item(row), state: marks.get(String(row.id)) ?? { starred: false, hidden: false, read: false },
      }]));
    });
  }

  /** @param {string[]} keys */
  #labelledSpecialties(keys) {
    return keys.filter((key) => Object.hasOwn(this.vocabulary.specialties, key)).map((key) => ({ key, label: this.vocabulary.specialties[key] }));
  }

  /**
   * 「与你相关」 for one reader (plan §4.6): `off` without the module.
   * @param {{ id: string }} user
   */
  async forYou(user) {
    if (!this.profiles) return { state: "off", basis: null, items: [] };
    return this.profiles.forYou(user, (/** @type {{ id: string }} */ reader, /** @type {string[]} */ publicIds) => this.hydrate(reader, { publicIds }));
  }

  /**
   * The hot list (plan §4.4, plan 2026-09-23 §6.2), or 404 `not_found` without
   * the event layer. `window=current` (the default) is the latest snapshot's
   * list — each event with its heat, rank change, badge and 24-hour trend —
   * taken at `takenAt` over the 72 hours from `since`; `week` and `month` are
   * that window's ranking, computed now (`takenAt`) from `since`. Shared by
   * every reader, and kept a minute at most — never past a new list or new
   * content, since the versions are in the key.
   * @param {URLSearchParams} [params]
   */
  async hot(params = new URLSearchParams()) {
    if (!this.events) throw failure(404, "not_found", "Frontier route not found.");
    const window = params.get("window") || "current";
    if (!FRONTIER_HOT_WINDOWS.includes(window)) throw failure(400, "frontier_query_invalid", "The window parameter is invalid.");
    const meta = await this.#transaction(async (client) => Object.fromEntries((await client.query(`SELECT key, value FROM evimed_frontier.meta
      WHERE key = ANY($1::text[])`, [[FRONTIER_META_KEYS.contentVersion, FRONTIER_META_KEYS.hotVersion]])).rows
      .map((/** @type {any} */ row) => [row.key, metaNumber(row.value)])));
    const content = meta[FRONTIER_META_KEYS.contentVersion] ?? 0;
    const key = JSON.stringify(["hot", window, meta[FRONTIER_META_KEYS.hotVersion] ?? 0]);
    const cached = this.#cached(key, content);
    if (cached) return cached;
    let value;
    if (window === "current") {
      const { takenAt, events } = await this.events.hotList();
      value = { window, takenAt, since: takenAt ? new Date(Date.parse(takenAt) - FRONTIER_HOT_WINDOW_HOURS * 3_600_000).toISOString() : null, events };
    } else {
      const period = await this.events.hotPeriod(window);
      value = { window, takenAt: period.at, since: period.since, events: period.events };
    }
    this.#remember(key, content, value);
    return value;
  }

  /**
   * One event page, or where a merged event went (`{ redirect }`, answered
   * 308 by the route), or a 404.
   * @param {{ id: string }} user @param {string} publicId
   */
  async event(user, publicId) {
    if (!this.events) throw failure(404, "not_found", "Frontier route not found.");
    const read = await this.events.read(publicId);
    if (!read) throw failure(404, "frontier_event_not_found", "No such event.");
    if ("redirect" in read) return { redirect: read.redirect };
    const items = await this.hydrate(user, { rowIds: read.members.map((member) => member.rowId) });
    const event = read.event;
    return {
      event: {
        id: event.public_id,
        title: event.title_zh,
        digest: event.digest_zh ?? null,
        latest: event.latest_zh ? { text: event.latest_zh, at: iso(event.last_at) } : null,
        status: event.status,
        lane: event.lane,
        laneLabel: this.vocabulary.lanes[event.lane] ?? event.lane,
        specialties: this.#labelledSpecialties(read.specialties),
        sourceCount72h: Number(event.source_count_72h ?? 0),
        reportCount: Number(event.report_count ?? 0),
        firstAt: iso(event.first_at),
        lastAt: iso(event.last_at),
        // The side column (plan 2026-09-23 §6.2): the heat now (×10, rounded),
        // the first-hand material, the institutions of the last 72 hours by
        // kind, and the hourly trend — null, 「暂无走势」, under six hours old.
        heat: read.heat,
        hasPrimary: read.primary != null,
        primary: read.primary,
        institutions72h: {
          total: read.institutions.total,
          byType: read.institutions.byType.map(({ type, count }) => ({ type, count,
            label: this.vocabulary.sourceTypes[type] ?? this.vocabulary.sourceTypes[FRONTIER_FALLBACKS.source_type] })),
        },
        trend: read.trend,
        items: read.members.flatMap((member) => (items.has(member.rowId) ? [{ ...items.get(member.rowId), role: member.role }] : [])),
        related: read.related,
      },
    };
  }

  /** The daily archive, newest first. @param {URLSearchParams} params */
  async dailies(params) {
    if (!this.daily) throw failure(404, "not_found", "Frontier route not found.");
    const value = params.get("limit");
    const limit = value == null || value === "" ? 30 : Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) throw failure(400, "frontier_query_invalid", "The limit parameter is invalid.");
    return { dailies: await this.daily.list(limit) };
  }

  /**
   * One day's issue: its frozen structure with its items read now (a
   * withdrawn item leaves, a retraction flag shows), and what its header and
   * footer need (plan 2026-09-23 §6.2 「9月23日 周三 · 52 条 · 约 9 分钟」,
   * 「前一日 / 后一日」): the number of items it shows now, the minutes they take
   * to read, and the issues on either side (a quiet day has none, so they are
   * the nearest issues, not the calendar's neighbours).
   *
   * The Markdown a reader copies is rendered from the same live items, so it
   * says what the page says — the institution's name, no withdrawn item — and
   * not what was frozen at 07:30 (`dailies.markdown` keeps that, for the
   * record). The lead's text and the AI minute are the issue's own.
   * @param {{ id: string }} user @param {string} day
   */
  async dailyIssue(user, day) {
    if (!this.daily) throw failure(404, "not_found", "Frontier route not found.");
    const issue = await this.daily.read(day);
    if (!issue) throw failure(404, "frontier_daily_not_found", "No issue for that day.");
    const sections = issue.sections.map((/** @type {any} */ section) => ({ lane: String(section?.lane ?? ""), ids: Array.isArray(section?.itemIds) ? section.itemIds.map(String) : [] }));
    const ids = [issue.lead?.itemId, ...issue.safety, ...sections.flatMap((section) => section.ids)].filter((id) => typeof id === "string");
    const items = await this.hydrate(user, { publicIds: [...new Set(ids)] });
    const leadItem = issue.lead?.itemId ? items.get(String(issue.lead.itemId)) : null;
    const leadText = typeof issue.lead?.text === "string" ? issue.lead.text : null;
    const shownSections = sections.map((section) => ({ lane: section.lane, laneLabel: this.vocabulary.lanes[section.lane] ?? section.lane,
      items: section.ids.flatMap((id) => (items.has(id) ? [items.get(id)] : [])) })).filter((section) => section.items.length);
    const safety = issue.safety.flatMap((/** @type {unknown} */ id) => (items.has(String(id)) ? [items.get(String(id))] : []));
    const shown = [leadItem, ...safety, ...shownSections.flatMap((section) => section.items)].filter(Boolean);
    const line = (/** @type {any} */ item) => ({ id: item.id, title_zh: item.titleZh, title_raw: item.titleRaw, summary_zh: item.summary,
      source_name: item.source.name, canonical_url: item.url });
    const markdown = frontierDailyMarkdown({
      day: issue.day, window: { start: new Date(issue.windowStart), end: new Date(issue.windowEnd) },
      timeZone: this.daily.timeZone || this.config.frontierTimeZone || "Asia/Shanghai",
      lead: leadItem ? line(leadItem) : null, leadText, safety: safety.map(line),
      sections: shownSections.map((section) => ({ lane: section.lane, rows: section.items.map(line) })), aiMinute: issue.aiMinute,
    });
    return {
      daily: {
        day: issue.day, windowStart: issue.windowStart, windowEnd: issue.windowEnd, generatedAt: issue.generatedAt,
        lead: leadItem ? {
          item: leadItem, text: leadText,
          event: issue.lead.eventId ? { id: String(issue.lead.eventId), title: String(issue.lead.eventTitle ?? leadItem.title) } : null,
        } : null,
        sections: shownSections,
        safety,
        aiMinute: issue.aiMinute, markdown,
        itemCount: new Set(shown.map((item) => item.id)).size,
        readingMinutes: frontierReadingMinutes([leadText, issue.aiMinute, ...shown.flatMap((item) => [item.title, item.summary])]),
        previousDay: issue.previousDay ?? null,
        nextDay: issue.nextDay ?? null,
      },
    };
  }

  /**
   * 「存入知识库」 (plan §4.7), or 404 `not_found` where this deployment has no
   * knowledge base to write into.
   * @param {{ id: string }} user @param {string} publicId @param {{ projectId?: unknown }} body
   */
  async saveToLibrary(user, publicId, body) {
    if (!this.actions?.capabilities?.().saveToLibrary) throw failure(404, "not_found", "Frontier route not found.");
    return this.actions.saveToLibrary(user, publicId, body);
  }

  /** 「中文摘要」 (plan §10.3.6). @param {{ id: string }} user @param {string} publicId */
  async abstractZh(user, publicId) {
    if (!this.actions) throw failure(404, "not_found", "Frontier route not found.");
    const answer = await this.actions.abstractZh(user, publicId);
    // The item's own answer now carries the abstract; its cached pages must not.
    if (answer.abstractZh) this.cache.clear();
    return answer;
  }

  /** Every cached answer, dropped: an operator's change is seen on the next request. */
  #invalidate() {
    this.cache.clear();
    this.sourcesCache.clear();
    this.statusCache = null;
  }

  /**
   * An operator's change to one item: withdraw it (with a reason, kept; never
   * a delete), pin it into 精选, or take an operator pin away.
   * @param {string} publicId @param {"withdraw" | "pin" | "unpin"} action @param {{ reason?: string | null }} input
   */
  async operateItem(publicId, action, { reason = null } = {}) {
    if (!["withdraw", "pin", "unpin"].includes(action)) throw failure(404, "not_found", "Frontier route not found.");
    if (!PUBLIC_ID.test(String(publicId ?? ""))) throw failure(404, "frontier_item_not_found", "No such item.");
    const note = reason == null ? null : followText(reason, 500);
    if (reason != null && !note) throw failure(400, "frontier_operation_invalid", "The reason must be one line of at most 500 characters.");
    if (action === "withdraw" && !note) throw failure(400, "frontier_operation_invalid", "A withdrawal needs its reason.");
    const item = await this.#transaction(async (client) => {
      const row = (await client.query(`SELECT id, state, selected, selected_rule FROM evimed_frontier.items WHERE public_id=$1 FOR UPDATE`, [publicId])).rows[0];
      if (!row || !["published", "withdrawn"].includes(row.state)) throw failure(404, "frontier_item_not_found", "No such item.");
      if (action === "withdraw") {
        if (row.state !== "withdrawn") {
          await client.query(`UPDATE evimed_frontier.items SET state='withdrawn', withdrawn_at=clock_timestamp(), withdrawn_reason=$2,
            updated_at=clock_timestamp() WHERE id=$1`, [row.id, note]);
          await client.query(`INSERT INTO evimed_frontier.item_changes(item_id, op, reason) VALUES ($1, 'remove', 'withdrawn')`, [row.id]);
          await bumpFrontierVersion(client);
        }
      } else if (row.state !== "published") {
        throw failure(409, "frontier_item_withdrawn", "A withdrawn item cannot be pinned.");
      } else if (action === "pin") {
        if (!(row.selected && row.selected_rule === "operator-pin")) {
          await client.query(`UPDATE evimed_frontier.items SET selected=true, selected_rule='operator-pin', selected_at=clock_timestamp(),
            updated_at=clock_timestamp() WHERE id=$1`, [row.id]);
          await client.query(`INSERT INTO evimed_frontier.item_changes(item_id, op, reason) VALUES ($1, 'upsert', 'selected')`, [row.id]);
          await bumpFrontierVersion(client);
        }
      } else {
        if (row.selected_rule !== "operator-pin") throw failure(409, "frontier_item_not_pinned", "Only an operator pin can be taken away here.");
        await client.query(`UPDATE evimed_frontier.items SET selected=false, selected_rule=NULL, selected_at=NULL,
          updated_at=clock_timestamp() WHERE id=$1`, [row.id]);
        await client.query(`INSERT INTO evimed_frontier.item_changes(item_id, op, reason) VALUES ($1, 'upsert', 'selected')`, [row.id]);
        await bumpFrontierVersion(client);
      }
      return (await client.query(`SELECT public_id, state, selected, selected_rule, withdrawn_at, withdrawn_reason
        FROM evimed_frontier.items WHERE id=$1`, [row.id])).rows[0];
    });
    this.#invalidate();
    return {
      item: { id: item.public_id, state: item.state, selected: item.selected, selectedRule: item.selected_rule ?? null,
        withdrawnAt: iso(item.withdrawn_at), withdrawnReason: item.withdrawn_reason ?? null },
    };
  }

  /**
   * The platform's display switch for one source (§10.5.9 「立刻停掉一个信源」):
   * off, its items leave every list at once. Stopping the collection itself is
   * the plugin team's, in the plugin.
   * @param {string} sourceId @param {unknown} enabled
   */
  async setSourceEnabled(sourceId, enabled) {
    if (typeof enabled !== "boolean") throw failure(400, "frontier_operation_invalid", "enabled must be a boolean.");
    const id = String(sourceId ?? "");
    if (!id || id.length > 120) throw failure(404, "frontier_source_not_found", "No such source.");
    const row = await this.#transaction(async (client) => {
      const updated = (await client.query(`UPDATE evimed_frontier.sources SET enabled=$2 WHERE id=$1
        RETURNING id, name, owner_entity, homepage, lane, source_type, access, egress, launch_tier, plugin_health, last_ok_at, last_new_entry_at,
          entries_7d, selected_30d, enabled, retired_at`, [id, enabled])).rows[0];
      if (!updated) throw failure(404, "frontier_source_not_found", "No such source.");
      await bumpFrontierVersion(client);
      return updated;
    });
    this.#invalidate();
    return { source: this.#source(row) };
  }

  /**
   * Gauges for `/api/ops/metrics`: entries by state and today's items by
   * verification outcome, read from the tables (one grouped query each).
   */
  async metricsSnapshot() {
    // Scraped every fifteen seconds; the counts move by the minute at most.
    if (this.metricsCache && this.now().getTime() - this.metricsCache.at < CACHE_TTL_MS) return this.metricsCache.value;
    const { start } = zonedDay(this.now(), this.config.frontierTimeZone || "Asia/Shanghai");
    const value = await this.#transaction(async (client) => {
      const entries = (await client.query(`SELECT state, count(*)::integer AS n FROM evimed_frontier.entries GROUP BY state`)).rows;
      const items = (await client.query(`SELECT verification, count(*)::integer AS n, count(*) FILTER (WHERE selected)::integer AS selected
        FROM evimed_frontier.items WHERE state='published' AND visible_at >= $1::timestamptz GROUP BY verification`, [start.toISOString()])).rows;
      const lastPublished = (await client.query(`SELECT max(visible_at) AS at FROM evimed_frontier.items WHERE state='published'`)).rows[0]?.at;
      const tiers = (await client.query(`SELECT launch_tier AS tier, plugin_health AS health, count(*)::integer AS n
        FROM evimed_frontier.sources WHERE retired_at IS NULL AND enabled GROUP BY launch_tier, plugin_health`)).rows;
      // The oldest work each stage has been owed (plan §10.5.8, "最老一条超过 6 小时"):
      // an entry due and not taken (a hold that has not come due is waiting,
      // not owed), an item screened and not yet published, a published item
      // whose edit is owed.
      const oldest = (await client.query(`SELECT
          (SELECT min(greatest(received_at, coalesce(hold_until, received_at))) FROM evimed_frontier.entries
            WHERE state IN ('received', 'held') AND (hold_until IS NULL OR hold_until <= now())) AS entries,
          (SELECT min(updated_at) FROM evimed_frontier.items WHERE state IN ('screened', 'scored')
            AND EXISTS (SELECT 1 FROM evimed_frontier.item_texts t WHERE t.item_id = items.id)) AS items,
          (SELECT min(visible_at) FROM evimed_frontier.items WHERE state = 'published' AND editor_version IS NULL
            AND timeline_at > now() - interval '7 days') AS edits`)).rows[0] ?? {};
      return {
        entriesByState: Object.fromEntries(entries.map((/** @type {any} */ row) => [row.state, row.n])),
        publishedToday: items.reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + row.n, 0),
        selectedToday: items.reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + row.selected, 0),
        verificationToday: Object.fromEntries(items.map((/** @type {any} */ row) => [row.verification, row.n])),
        lastPublishedAt: iso(lastPublished),
        sources: await this.#sourceCounts(client),
        sourcesByTier: tiers.map((/** @type {any} */ row) => ({ tier: String(row.tier ?? "unknown"), health: String(row.health ?? "unknown"), n: row.n })),
        oldestOwed: { entries: iso(oldest.entries), items: iso(oldest.items), edits: iso(oldest.edits) },
      };
    });
    this.metricsCache = { at: this.now().getTime(), value };
    return value;
  }
}

/** A readiness failure as `readinessCheck` in `server.mjs` reads one. @param {string} code @param {Record<string, any> | null} [details] */
function readinessFailure(code, details = null) {
  /** @type {Error & Record<string, any>} */
  const error = new Error(code);
  error.code = code;
  if (details) error.details = details;
  return error;
}

/**
 * The `frontier` readiness check (plan §10.5.8). Red only for the module's own
 * invariants: the schema migrated, the worker composed, the operator account
 * and its internal project there, the plugin token readable when a plugin is
 * configured. What lies outside the platform is a warning on a green check —
 * a plugin that cannot be reached or speaks a contract this build does not
 * consume must never stop a release (the platform ships on green readiness,
 * and FDA being down is not a reason not to ship). Off, the check is green
 * and says so. Reads only what the process already knows about the plugin:
 * readiness is probed every thirty seconds and must not wait on it.
 * @param {{ config: Record<string, any>, frontier: any, database: any }} input
 */
export async function frontierReadiness({ config, frontier, database }) {
  if (!config.frontierEnabled) return { required: false, enabled: false };
  if (!frontier || !database) throw readinessFailure("frontier_unavailable", { reason: database ? "not_composed" : "no_product_database" });
  let capabilities;
  try {
    capabilities = await frontier.service.ready();
  } catch (error) {
    throw readinessFailure("frontier_migration_failed", { reason: typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "migration_error" });
  }
  if (!frontier.worker) throw readinessFailure("frontier_worker_missing");
  const operator = String((config.operatorUsers ?? [])[0] ?? "");
  if (!operator) throw readinessFailure("frontier_operator_unconfigured");
  const found = await database.query(`SELECT (SELECT count(*) FROM evimed_control.users WHERE id=$1)::integer AS users,
    (SELECT count(*) FROM evimed_control.projects WHERE user_id=$1 AND id=$2)::integer AS projects`, [operator, FRONTIER_PROJECT_ID]);
  if (!found.rows[0]?.users) throw readinessFailure("frontier_operator_unavailable");
  if (!found.rows[0]?.projects) throw readinessFailure("frontier_project_missing");
  if (config.knowledgePluginUrl) {
    const token = await readKnowledgePluginToken(config.knowledgePluginTokenFile);
    if (token.error) throw readinessFailure("frontier_plugin_token_unreadable", { reason: token.error });
  }
  const plugin = frontier.ingest.status();
  const worker = frontier.worker.status();
  const warning = { unreachable: "frontier_plugin_unreachable", incompatible: "frontier_plugin_incompatible", unconfigured: "frontier_plugin_unconfigured" }[plugin.state] ?? null;
  return {
    required: true, enabled: true, audience: config.frontierAudience,
    capabilities: { vector: capabilities.vector, halfvec: capabilities.halfvec, iterativeScan: capabilities.iterativeScan, trigram: capabilities.trigram },
    plugin: { state: plugin.state, contract: plugin.contract, version: plugin.version, lastPullAt: plugin.lastPullOkAt, lag: plugin.lag, lastError: plugin.lastError },
    worker: { armed: worker.armed, lastError: worker.lastError },
    ...(warning ? { warning } : {}),
  };
}

/**
 * Everything the metrics endpoint shows about the module, read once per
 * scrape: the tables' counts (cached a minute by the service), the budget, and
 * the in-process state of the plugin client, the ingest, the worker and — in
 * the second wave — the composer's loops and the reader actions, and the
 * editor's first-pass counters.
 * @param {{ service: FrontierService, ingest: any, worker: any, client: any, composer?: any, actions?: any, editor?: any }} frontier
 */
export async function frontierMetricsSnapshot({ service, ingest, worker, client, composer = null, actions = null, editor = null }) {
  let tables = null;
  try { tables = await service.metricsSnapshot(); } catch { tables = null; }
  return { tables, budget: await service.budget(), plugin: ingest.status(), worker: worker.status(), client: client.status(), service: { ...service.counters },
    composer: composer?.status?.() ?? null, actions: actions?.status?.() ?? null, editor: editor?.status?.() ?? null };
}

/** @param {string | null | undefined} at */
const seconds = (at) => (at ? Date.parse(at) / 1000 : 0);

/**
 * The `open_science_frontier_*` families (plan §10.5.8), in the shape
 * `addMetric` in `server.mjs` takes. With the module off there is one line:
 * `open_science_frontier_enabled 0`.
 * @param {boolean} enabled @param {Awaited<ReturnType<typeof frontierMetricsSnapshot>> | null} snapshot
 * @returns {{ name: string, help: string, type: "gauge" | "counter", series: { value: number, labels?: Record<string, string> }[] }[]}
 */
export function frontierMetricFamilies(enabled, snapshot) {
  /** @type {{ name: string, help: string, type: "gauge" | "counter", series: { value: number, labels?: Record<string, string> }[] }[]} */
  const families = [{ name: "open_science_frontier_enabled", help: "Whether the frontier feed module is composed in this process.", type: "gauge",
    series: [{ value: enabled && snapshot ? 1 : 0 }] }];
  if (!enabled || !snapshot) return families;
  const { plugin, worker, tables, budget, client, service } = snapshot;
  /** @param {string} name @param {string} help @param {"gauge" | "counter"} type @param {{ value: number, labels?: Record<string, string> }[]} series */
  const add = (name, help, type, series) => families.push({ name: `open_science_frontier_${name}`, help, type, series });
  add("plugin_state", "The knowledge plugin's state as the ingest last saw it (1 = current).", "gauge",
    ["ok", "degraded", "unreachable", "incompatible", "unconfigured"].map((state) => ({ labels: { state }, value: plugin.state === state ? 1 : 0 })));
  add("plugin_compatible", "Whether the plugin's contract is one this build consumes (0 when incompatible or not yet read).", "gauge",
    [{ labels: { contract: String(plugin.contract ?? "unknown") }, value: plugin.compatibility === "compatible" ? 1 : 0 }]);
  add("pulls_total", "Stream pulls by outcome.", "counter", [
    { labels: { outcome: "ok" }, value: plugin.counters.pulls - plugin.counters.pullFailures },
    { labels: { outcome: "failed" }, value: plugin.counters.pullFailures },
  ]);
  add("pull_last_error", "The code the last failed pull named (1 while it stands).", "gauge",
    plugin.lastError ? [{ labels: { code: plugin.lastError }, value: 1 }] : []);
  add("plugin_cursor", "The last plugin seq the platform stored.", "gauge", [{ value: plugin.cursor ?? 0 }]);
  add("plugin_latest_seq", "The latest seq the plugin reported.", "gauge", [{ value: plugin.latestSeq ?? 0 }]);
  add("plugin_lag_entries", "Entries the plugin holds that the platform has not pulled yet.", "gauge", [{ value: plugin.lag ?? 0 }]);
  add("last_pull_ok_timestamp_seconds", "When the stream was last read successfully (0 = never in this process).", "gauge", [{ value: seconds(plugin.lastPullOkAt) }]);
  add("mirror_timestamp_seconds", "When the registry was last mirrored (0 = never in this process).", "gauge", [{ value: seconds(plugin.lastMirrorAt) }]);
  // What the plugin's own /v1/health said at the last pull (plan §10.5.8):
  // each exit's state, its backlog, its last fetch that read something, and
  // the host that answered 429 most often in the last hour.
  const pluginHealth = plugin.pluginHealthDetail;
  if (pluginHealth) {
    add("plugin_egress_state", "Each plugin exit's state as the plugin reports it (1 = current).", "gauge",
      Object.entries(pluginHealth.egress ?? {}).flatMap(([egress, current]) => ["ok", "degraded", "down", "unconfigured"]
        .map((state) => ({ labels: { egress, state }, value: current === state ? 1 : 0 }))));
    add("plugin_last_ok_fetch_timestamp_seconds", "The plugin's last fetch that read something (0 = none reported).", "gauge",
      [{ value: seconds(pluginHealth.lastOkFetchAt) }]);
    add("plugin_last_new_entry_timestamp_seconds", "When a source last brought the plugin a new entry (0 = none reported).", "gauge",
      [{ value: seconds(pluginHealth.lastNewEntryAt) }]);
    add("plugin_backlog", "The plugin's own backlog: sources due for a poll, texts pending.", "gauge", [
      { labels: { kind: "due_sources" }, value: Number(pluginHealth.backlog?.due_sources ?? 0) },
      { labels: { kind: "pending_texts" }, value: Number(pluginHealth.backlog?.pending_texts ?? 0) },
    ]);
    add("plugin_backlog_oldest_due_seconds", "How long the plugin's most overdue source has been due.", "gauge",
      [{ value: Number(pluginHealth.backlog?.oldest_due_s ?? 0) }]);
    add("plugin_rate_limited_1h", "429 answers from the plugin's worst host in the last hour.", "gauge",
      [{ labels: { host: String(pluginHealth.rateLimited?.host ?? "none") }, value: Number(pluginHealth.rateLimited?.max ?? 0) }]);
  }
  add("cursor_gaps_total", "Times the cursor fell behind what the plugin still holds.", "counter", [{ value: plugin.gaps.count }]);
  add("cursor_gap_entries_total", "Entries skipped because the plugin had purged them before they were pulled.", "counter", [{ value: plugin.gaps.entries }]);
  add("ingest_entries_total", "Entries received from the plugin by what became of them.", "counter", [
    { labels: { outcome: "inserted" }, value: plugin.counters.inserted },
    { labels: { outcome: "duplicate" }, value: plugin.counters.duplicates },
    { labels: { outcome: "dropped" }, value: plugin.counters.dropped },
    { labels: { outcome: "invalid" }, value: plugin.counters.invalid },
  ]);
  add("placeholder_sources_total", "Entries whose source the registry did not list, kept under a placeholder.", "counter", [{ value: plugin.counters.placeholders }]);
  add("unknown_vocabulary_total", "Plugin values this build does not know, by vocabulary (fallback applied, never refused).", "counter",
    Object.entries(plugin.unknownVocabulary).map(([vocabulary, value]) => ({ labels: { vocabulary }, value: Number(value) })));
  add("plugin_client_requests_total", "Requests the plugin client made, and how many it retried.", "counter", [
    { labels: { kind: "requests" }, value: client.counters.requests },
    { labels: { kind: "retries" }, value: client.counters.retries },
    { labels: { kind: "failures" }, value: client.counters.failures },
  ]);
  add("tables_readable", "Whether the module's tables answered the metrics read.", "gauge", [{ value: tables ? 1 : 0 }]);
  if (tables) {
    add("entries", "Entries by processing state.", "gauge",
      ["received", "held", "merged", "screened-out", "promoted", "dropped", "backfill", "failed"].map((state) => ({ labels: { state }, value: Number(tables.entriesByState[state] ?? 0) })));
    add("items_published_today", "Items published today (the configured time zone's day).", "gauge", [{ value: tables.publishedToday }]);
    add("items_selected_today", "Of those, selected.", "gauge", [{ value: tables.selectedToday }]);
    add("verification_today", "Today's published items by what the number check concluded.", "gauge",
      ["pending", "passed", "repaired", "title-only"].map((outcome) => ({ labels: { outcome }, value: Number(tables.verificationToday[outcome] ?? 0) })));
    add("last_published_timestamp_seconds", "When the last item was published.", "gauge", [{ value: seconds(tables.lastPublishedAt) }]);
    add("sources", "Mirrored sources by what the reader sees (planned = loaded, not yet read).", "gauge",
      Object.entries(tables.sources).map(([health, value]) => ({ labels: { health }, value: Number(value) })));
    add("sources_by_tier", "Enabled mirrored sources by launch tier and the plugin's health word.", "gauge",
      (tables.sourcesByTier ?? []).map((/** @type {any} */ row) => ({ labels: { tier: row.tier, health: row.health }, value: Number(row.n) })));
    add("oldest_owed_timestamp_seconds", "When the oldest work each stage owes became due (0 = none owed).", "gauge",
      Object.entries(tables.oldestOwed ?? {}).map(([stage, at]) => ({ labels: { stage }, value: seconds(/** @type {string | null} */ (at)) })));
  }
  add("budget_spent_cny", "Today's frontier model spend (settled and still reserved).", "gauge", [{ value: Number(budget.spentCny ?? 0) }]);
  add("budget_limit_cny", "The day's frontier budget.", "gauge", [{ value: Number(budget.budgetCny ?? 0) }]);
  add("budget_state", "The budget's state (1 = current).", "gauge",
    ["ok", "throttled", "exhausted", "unavailable"].map((state) => ({ labels: { state }, value: budget.state === state ? 1 : 0 })));
  add("pipeline_total", "What the pipeline's batches did since this process started.", "counter",
    Object.entries(worker.pipeline).map(([outcome, value]) => ({ labels: { outcome }, value: Number(value) })));
  add("worker_loop_failures_total", "Worker loop runs that ended in an error, by loop.", "counter",
    Object.entries(worker.loops).map(([loop, state]) => ({ labels: { loop }, value: Number(/** @type {any} */ (state).failures) })));
  add("worker_loop_stalled", "Worker loops still running past the lease (1 = stalled).", "gauge",
    Object.entries(worker.loops).map(([loop, state]) => ({ labels: { loop }, value: /** @type {any} */ (state).stalled ? 1 : 0 })));
  add("http_answers_total", "Reader answers by kind: pages served, 304s, cache hits, invalid cursors, searches.", "counter", [
    { labels: { kind: "list" }, value: service.lists },
    { labels: { kind: "not_modified" }, value: service.notModified },
    { labels: { kind: "cache_hit" }, value: service.cacheHits },
    { labels: { kind: "invalid_cursor" }, value: service.invalidCursors },
    { labels: { kind: "search" }, value: service.searches },
    { labels: { kind: "search_failure" }, value: service.searchFailures },
  ]);
  const editor = snapshot.editor;
  if (editor?.counters) {
    // The number check's first-pass rate (plan §6.8, target ≥ 90 %): edits,
    // rewrites, and which field a first answer failed on.
    add("edit_calls_total", "Edit calls made, and first answers sent back for a rewrite.", "counter", [
      { labels: { kind: "call" }, value: Number(editor.counters.editCalls ?? 0) },
      { labels: { kind: "rewrite" }, value: Number(editor.counters.rewrites ?? 0) },
    ]);
    add("edit_first_pass_failures_total", "First answers that failed a check, by the field that failed.", "counter",
      Object.entries(editor.counters.firstPassFailures ?? {}).map(([field, value]) => ({ labels: { field }, value: Number(value) })));
    add("edit_number_check_total", "First edit answers by whether every number was found in the source (plan §10.5.8's first-pass rate).", "counter", [
      { labels: { outcome: "first-pass" }, value: Number(editor.counters.numberCheck?.first ?? 0) - Number(editor.counters.numberCheck?.firstFailed ?? 0) },
      { labels: { outcome: "first-fail" }, value: Number(editor.counters.numberCheck?.firstFailed ?? 0) },
    ]);
  }
  add("seen_marks_total", "Readers' last-seen marks written, and marks that failed (the push audience reads them).", "counter", [
    { labels: { outcome: "written" }, value: Number(service.seenMarks ?? 0) },
    { labels: { outcome: "failed" }, value: Number(service.seenFailures ?? 0) },
  ]);
  const composer = snapshot.composer;
  if (composer) {
    const daily = composer.daily ?? {};
    // 07:45 without an issue (plan §10.5.8): the alert reads this gauge.
    add("daily_missing", "Whether today's daily issue is missing past its alert time (1 = missing).", "gauge", [{ value: daily.missing ? 1 : 0 }]);
    add("daily_last_generated_timestamp_seconds", "When the latest daily issue was written (0 = none in this process's view).", "gauge",
      [{ value: seconds(daily.lastGeneratedAt ?? null) }]);
    add("daily_total", "Daily issues by outcome since this process started.", "counter", [
      { labels: { outcome: "issued" }, value: Number(daily.counters?.issues ?? 0) },
      { labels: { outcome: "empty" }, value: Number(daily.counters?.empty ?? 0) },
      { labels: { outcome: "failed" }, value: Number(daily.counters?.failures ?? 0) },
      { labels: { outcome: "ai_minute" }, value: Number(daily.counters?.aiMinutes ?? 0) },
      { labels: { outcome: "ai_minute_dropped" }, value: Number(daily.counters?.aiMinuteDropped ?? 0) },
    ]);
    add("push_total", "Daily pushes to readers' inboxes, and pushes that failed.", "counter", [
      { labels: { outcome: "pushed" }, value: Number(daily.counters?.pushed ?? 0) },
      { labels: { outcome: "failed" }, value: Number(daily.counters?.pushFailures ?? 0) },
    ]);
    const events = composer.events?.counters ?? {};
    add("events_total", "What clustering, the hot list and the digests did since this process started.", "counter",
      ["clustered", "created", "joined", "merged", "relatedLinks", "identifierLinks", "adjudicated", "adjudicationSkipped", "adjudicationFailures",
        "hotRuns", "hotChanges", "digestsWritten", "digestsDropped"].map((kind) => ({ labels: { kind }, value: Number(events[kind] ?? 0) })));
    const profiles = composer.profiles ?? null;
    add("personalization_state", "「与你相关」 as /status reports it (1 = current).", "gauge",
      ["available", "unavailable", "off"].map((state) => ({ labels: { state }, value: (profiles?.state ?? "off") === state ? 1 : 0 })));
    if (profiles) {
      add("profiles_total", "Profile refreshes, rankings, reasons dropped because their memory was gone, profiles marked due by a change, and candidates dropped as near a hidden item.", "counter",
        ["refreshed", "empty", "paused", "failures", "ranked", "embedded", "embedFailures", "reasonsDropped", "staleMarks", "staleMarkFailures",
          "visitFailures", "questionFailures", "hiddenDropped"]
          .map((kind) => ({ labels: { kind }, value: Number(profiles.counters?.[kind] ?? 0) })));
    }
    add("composer_loop_failures_total", "Composer loop runs that ended in an error, by loop.", "counter",
      Object.entries(composer.loops ?? {}).map(([loop, state]) => ({ labels: { loop }, value: Number(/** @type {any} */ (state).failures ?? 0) })));
  }
  const actions = snapshot.actions;
  if (actions) {
    add("actions_total", "Reader actions: saves to a knowledge base by kind, and Chinese abstracts by outcome.", "counter",
      ["savedPdf", "savedRecord", "pdfFailures", "abstractsWritten", "abstractsCached", "abstractsRefused", "abstractsDropped", "abstractsLimited"]
        .map((kind) => ({ labels: { kind }, value: Number(actions.counters?.[kind] ?? 0) })));
  }
  return families;
}
