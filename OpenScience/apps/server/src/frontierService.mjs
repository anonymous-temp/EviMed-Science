import { FRONTIER_FOLLOW_KINDS, FRONTIER_GENRE_LABELS_ZH, FRONTIER_HIDE_REASONS, frontierEventEvidenceCounts } from '@evimed/domain';
import { FRONTIER_SOURCE_STREAM_COLUMNS, frontierSourceStreamColumns } from "./frontierSourceColumns.mjs";
import * as frontierEventReading from './frontierEventReading.mjs';
import { frontierEventChanges } from './frontierEventReading.mjs';
import { FRONTIER_EDITOR_VERSION, frontierEditorDiagnostics, frontierParagraphs, isChineseProse } from "./frontierEditor.mjs";
import { FRONTIER_MEDIA_ID, fetchFrontierMedia, frontierMediaList } from "./frontierMedia.mjs";
import { createModuleEvolutionPolicies } from "./moduleEvolutionPolicies.mjs";
import { frontierWeeklyMarkdown } from "./frontierWeekly.mjs";
import { frontierMonthlyMarkdown } from "./frontierMonthly.mjs";
import { createHash } from "node:crypto";
import {
  FRONTIER_ACCESSES, FRONTIER_AGENCY_REGIONS, FRONTIER_APPROVAL_KIND_LABELS_ZH, FRONTIER_EGRESSES, FRONTIER_EVIDENCE_TYPE_LABELS_ZH, FRONTIER_HEALTH_LABELS_ZH, FRONTIER_HOT_WINDOW_HOURS,
  FRONTIER_ITEM_FLAG_LABELS_ZH, FRONTIER_LANES, FRONTIER_LANE_LABELS_ZH, FRONTIER_LAUNCH_TIERS, FRONTIER_SOURCE_TYPE_LABELS_ZH,
  FRONTIER_SPECIALTIES, FRONTIER_SPECIALTY_LABELS_ZH, FRONTIER_SPECIALTY_RETIRED, FRONTIER_SCORE_TIERS, frontierIsStreamSource, frontierScoreLevel, frontierScoreTier, frontierSourceDisplayName, frontierSpecialtyKey,
} from "@evimed/domain";
import { frontierDailyMarkdown, frontierReadingMinutes } from "./frontierDaily.mjs";
import { FRONTIER_HOT_PERIODS } from "./frontierEvents.mjs";
import { FRONTIER_FALLBACKS } from "./frontierIngest.mjs";
import { FRONTIER_META_KEYS, bumpFrontierVersion, metaNumber, migrateFrontier } from "./frontierPersistence.mjs";
import { frontierItemGenre, frontierReaderText, frontierReaderWorthy, frontierSelectThreshold } from "./frontierPipeline.mjs";
import { servedAsk } from "./frontierAsk.mjs";
import { frontierBriefView } from "./frontierBrief.mjs";
import { FRONTIER_PROJECT_ID } from "./internalProjects.mjs";
import { trigramTerms, tsqueryLiteral } from "./kbChunker.mjs";
import { readKnowledgePluginToken } from "./knowledgePluginClient.mjs";
import { HttpError } from "./security.mjs";
import { FrontierSubscriptions, frontierFollowPredicate, frontierTagPredicate } from "./frontierSubscriptions.mjs";
import { FRONTIER_FOLLOW_QUERY_MAX, followQueryView, typedFollowKey, typedFollowLabel, typedFollowQuery } from "./frontierFollowQuery.mjs";
import { FRONTIER_ITEM_TAG_LIMIT, FrontierTagStore } from "./frontierTags.mjs";
import { frontierTopicSummary } from "./frontierTopics.mjs";
import { FrontierTrack } from "./frontierTrack.mjs";

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
 * - A card carries the AI score, `score` (0–100), the tier it is drawn in,
 *   `scoreBand` (`high` from 76, `medium` from 60, `low` below — owner
 *   2026-10-23, after AIHOT's pill, the lines moved with the score on 2026-10-25), and its four parts, `scoreParts` (out of
 *   `FRONTIER_SCORE_MAXIMA`: a lone number told a reader nothing); a safety
 *   alert carries none of them — it is selected whatever it scored. `levels`
 *   stay as the parts' bands for older clients.
 * - A card's tags are the tag tree's (frontierTags.mjs): active tags, resolved
 *   through merges, read in the same query as the card (`tag_refs`).
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
/** What a reader may follow: the six kinds picked from an item and `query`, something they typed (c3-watch; the domain's list). */
const FOLLOW_KINDS = /** @type {readonly string[]} */ (FRONTIER_FOLLOW_KINDS);

/** An item's channel (contract 1.4.0), the plugin's vocabulary. */
export const FRONTIER_CHANNELS = Object.freeze(["journal", "preprint", "news", "regulator", "registry", "guideline", "blog", "x", "wechat", "social"]);
/**
 * The list's channel filter (contract B `channel=`), and which channels each takes. The server owns this mapping: `official` is a
 * regulator's item or an organisation's own post, whatever its channel; `all` is no filter.
 */
export const FRONTIER_CHANNEL_FILTERS = Object.freeze({
  literature: Object.freeze(["journal", "preprint", "registry", "guideline"]),
  news: Object.freeze(["news", "blog"]),
  social: Object.freeze(["x", "wechat", "social"]),
  official: Object.freeze(["regulator"]),
});

/**
 * An item's channel: the plugin's own (contract 1.4.0), or — for the items before it, which carry none — the one their source
 * type is: a journal's, a preprint server's, a regulator's; a trial registry's record (`reg:`) or an evidence body's guideline; a
 * company's newsroom and a medium are news. `frontierChannelSql` is the same rule in SQL (the tests hold them equal).
 * @param {{ channel?: string | null, source_type?: string | null, identity_key?: string | null }} row @returns {string | null}
 */
export function frontierItemChannel(row) {
  if (FRONTIER_CHANNELS.includes(String(row?.channel ?? ""))) return /** @type {string} */ (row.channel);
  switch (row?.source_type) {
    case "journal": case "preprint": case "regulator": return row.source_type;
    case "evidence-body": return /^reg:/.test(String(row.identity_key ?? "")) ? "registry" : "guideline";
    case "company": case "media": return "news";
    default: return null;
  }
}

/** `frontierItemChannel` over `evimed_frontier.items i`. */
export const frontierChannelSql = `(CASE WHEN i.channel IN (${FRONTIER_CHANNELS.map((channel) => `'${channel}'`).join(", ")}) THEN i.channel
  ELSE CASE i.source_type WHEN 'journal' THEN 'journal' WHEN 'preprint' THEN 'preprint' WHEN 'regulator' THEN 'regulator'
    WHEN 'evidence-body' THEN CASE WHEN i.identity_key LIKE 'reg:%' THEN 'registry' ELSE 'guideline' END
    WHEN 'company' THEN 'news' WHEN 'media' THEN 'news' END END)`;

/** The predicate of a channel filter. @param {keyof typeof FRONTIER_CHANNEL_FILTERS} filter */
function channelPredicate(filter) {
  const channels = `(${FRONTIER_CHANNEL_FILTERS[filter].map((channel) => `'${channel}'`).join(", ")})`;
  return filter === "official" ? `(${frontierChannelSql} IN ${channels} OR i.author->>'role' = 'organisation')` : `${frontierChannelSql} IN ${channels}`;
}

/**
 * A post's or an article's author (contract 1.4.0), or null.
 * @param {unknown} value @returns {{ name: string, handle: string | null, url: string | null, role: "organisation" | "person" | null } | null}
 */
export function frontierAuthor(value) {
  const author = value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : null;
  const name = typeof author?.name === "string" ? author.name.trim().slice(0, 200) : "";
  if (!name) return null;
  const handle = typeof author?.handle === "string" && author.handle.trim() ? author.handle.trim().slice(0, 100) : null;
  const url = typeof author?.url === "string" && /^https?:\/\//.test(author.url) ? author.url.slice(0, 2048) : null;
  const role = author?.role === "organisation" || author?.role === "person" ? author.role : null;
  return { name, handle, url, role };
}

/**
 * The 「可能改变实践」 label of an item: `{ reason }` once the mix admitted it (`practice_changing`) and a reason is held; otherwise null.
 * A proposal that was not admitted is never served.
 * @param {{ practice_changing?: unknown, practice_zh?: unknown }} row @returns {{ reason: string } | null}
 */
export function frontierPracticeLabel(row) {
  const reason = typeof row?.practice_zh === "string" ? row.practice_zh.replace(/\s+/g, " ").trim() : "";
  // A label of 精选 only: an item a later rule took out of it (a safety alert of its event, one pick an event, a merge) shows none.
  return row?.practice_changing === true && row?.selected === true && reason ? { reason } : null;
}

/** The tiers the 「AI 评分」 pill is drawn in (`@evimed/domain` `FRONTIER_SCORE_TIERS`: 76 / 60 on the score of 2026-10-25, from 85 / 70). */
export { FRONTIER_SCORE_TIERS };

/**
 * The tier an AI score reads in: `high` from 76, `medium` from 60, `low` below; null without a score.
 * @param {unknown} score @returns {"high" | "medium" | "low" | null}
 */
export function frontierScoreBand(score) {
  return frontierScoreTier(score);
}

/** A score part as a number, or null. @param {unknown} value */
const scorePart = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

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
  // One or more of the thirty, any of them (2026-10-23); a retired key reads as its successor, or as no filter.
  const specialtyValues = (params.get("specialty") || "").split(",").map((key) => key.trim()).filter(Boolean);
  if (specialtyValues.length > FRONTIER_SPECIALTIES.length) throw invalid("specialty");
  /** @type {string[]} */
  const specialties = [];
  for (const value of specialtyValues) {
    const key = Object.hasOwn(vocabulary.specialties, value) ? value : Object.hasOwn(FRONTIER_SPECIALTY_RETIRED, value) ? frontierSpecialtyKey(value) : undefined;
    if (key === undefined) throw invalid("specialty");
    if (key && !specialties.includes(key)) specialties.push(key);
  }
  specialties.sort();
  const specialty = specialties.length ? specialties.join(",") : null;
  // A tag of the tree, by its address (frontierTags.mjs); whether the tree has it is the service's to say.
  const tag = params.get("tag") || null;
  if (tag && !/^[a-z0-9][a-z0-9-]{1,79}$/.test(tag)) throw invalid("tag");
  const evidence = params.get("evidence") || null;
  if (evidence && !Object.hasOwn(vocabulary.evidenceTypes, evidence)) throw invalid("evidence");
  const unreadValue = params.get("unread");
  if (unreadValue != null && !["1", "0", ""].includes(unreadValue)) throw invalid("unread");
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
  const follow = params.get("follow") || null;
  if (follow && follow !== "all" && !/^\d{1,18}$/.test(follow)) throw invalid("follow");
  // 文献 / 新闻 / 社交 / 官方 (contract B); `all` is no filter.
  const channelValue = params.get("channel") || "all";
  if (channelValue !== "all" && !Object.hasOwn(FRONTIER_CHANNEL_FILTERS, channelValue)) throw invalid("channel");
  const channel = channelValue === "all" ? null : /** @type {keyof typeof FRONTIER_CHANNEL_FILTERS} */ (channelValue);
  return { view, by, lane, specialty, specialties, tag, evidence, unread: unreadValue === "1", window, follow, q: rawQuery || null, starred: starredValue === "1",
    safety: safetyValue === "1", cursor, limit, sort, channel };
}

/** @typedef {ReturnType<typeof normalizeItemsQuery> & { readerKey?: string,
 * subscriptions?: Awaited<ReturnType<FrontierSubscriptions["read"]>> }} ItemsQuery */

/** The filters a cursor was minted under, as a short fingerprint. @param {ItemsQuery} query */
const filterPrint = (query) => shortHash(JSON.stringify([query.lane, query.specialty, query.window, query.starred, query.q, query.safety,
  query.q ? query.sort : "relevance", query.follow, query.readerKey ?? null, ...(query.channel ? [query.channel] : []),
  ...(query.tag || query.evidence || query.unread ? [query.tag, query.evidence, query.unread] : [])]));

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
const ITEM_COLUMNS = `i.id, i.public_id, i.title_raw, i.title_zh, i.summary_zh, i.reason_zh, i.practice_changing, i.practice_zh, i.tags, i.lang, i.lane, i.source_type, i.identity_key,
  i.channel, i.platform, i.author, i.media,
  i.evidence_type, i.evidence_basis, i.specialties, i.entities, i.flags, i.doi, i.pmid, i.registry_ids, i.canonical_url,
  i.published_at, i.date_precision, i.timeline_at, i.visible_at, i.selected, i.selected_rule, i.safety_alert, i.verification, i.editor_diagnostics,
  i.score_authority, i.score_impact, i.score_novelty, i.score_relevance, i.score_total, i.primary_source_id,
  s.name AS source_name, s.owner_entity AS source_owner, ${FRONTIER_SOURCE_STREAM_COLUMNS}, s.homepage AS source_homepage, s.platform_produced AS source_platform_produced,
  t.open_access, t.enrichment->>'oa_pdf_url' AS oa_pdf_url, t.enrichment - '{${CARD_HIDDEN_ENRICHMENT.join(",")}}'::text[] AS card_enrichment,
  CASE WHEN e.report_count > 1 THEN e.public_id END AS event_public_id, e.title_zh AS event_title,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('sourceId', r.source_id, 'sourceName', r.name, 'ownerEntity', r.owner_entity, 'url', r.url)
      ORDER BY r.rank), '[]'::jsonb)
     FROM (SELECT d.source_id, d.name, d.owner_entity, d.url, row_number() OVER (ORDER BY d.published_at DESC NULLS LAST, d.source_id) AS rank
             FROM (SELECT DISTINCT ON (ms.owner_entity) im.source_id, ms.name, ms.owner_entity, im.url, im.published_at
                     FROM evimed_frontier.item_mentions im JOIN evimed_frontier.sources ms ON ms.id = im.source_id
                    WHERE im.item_id = i.id AND ms.owner_entity <> s.owner_entity AND ms.enabled AND NOT ms.platform_produced
                    ORDER BY ms.owner_entity, im.published_at DESC NULLS LAST, im.source_id) d
            ORDER BY d.published_at DESC NULLS LAST, d.source_id LIMIT 5) r) AS mentions,
  (SELECT count(DISTINCT ms.owner_entity)::integer FROM evimed_frontier.item_mentions im JOIN evimed_frontier.sources ms ON ms.id = im.source_id
    WHERE im.item_id = i.id AND ms.owner_entity <> s.owner_entity AND ms.enabled AND NOT ms.platform_produced) AS mention_count,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('slug', x.slug, 'name', x.name) ORDER BY x.rank), '[]'::jsonb)
     FROM (SELECT DISTINCT ON (r.id) r.slug, r.name, it.rank FROM evimed_frontier.item_tags it
             JOIN evimed_frontier.tags tg ON tg.id = it.tag_id JOIN evimed_frontier.tags r ON r.id = coalesce(tg.merged_into, tg.id)
            WHERE it.item_id = i.id AND r.state = 'active' ORDER BY r.id, it.rank) x) AS tag_refs,
  i.genre`;

const ITEM_FROM = `evimed_frontier.items i
  JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
  LEFT JOIN evimed_frontier.item_texts t ON t.item_id = i.id
  LEFT JOIN evimed_frontier.events e ON e.id = i.event_id`;

/** What a search leg ranks over: the filters need the item and its source, nothing else. */
const LEG_FROM = `evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id`;

/**
 * The policy a list of the items route was cut by, as its serve records it (`list_serves.policy`): the surface with the view
 * and the axis, a search with its order. A list the ranking orders (与我相关) records the ranking's own version instead.
 * @param {string} surface @param {{ view?: string, by?: string, sort?: string }} query
 */
export function frontierListPolicy(surface, query) {
  if (surface === "search") return `search:${query.sort ?? "relevance"}`;
  if (surface === "safety") return "safety:time";
  return `${surface}:${query.view ?? "selected"}:${query.by ?? "timeline"}`;
}

export class FrontierService {
  /**
   * @param {{ database: any, config: Record<string, any>, vocabulary: FrontierVocabulary, policies?: any, ingest?: any, embedder?: any,
   *   budget?: (() => Promise<{ spentCny: number, budgetCny: number, state: string }>) | null, now?: () => Date,
   *   dimension?: number, cacheTtlMs?: number, events?: any, daily?: any, weekly?: any, monthly?: any, profiles?: any, actions?: any,
   *   tags?: import("./frontierTags.mjs").FrontierTagStore | null, tagUpkeep?: import("./frontierTagUpkeep.mjs").FrontierTagUpkeep | null,
   *   interactions?: import("./frontierInteractions.mjs").FrontierInteractions | null,
   *   topics?: import("./frontierTopics.mjs").FrontierTopics | null, watch?: import("./frontierFollowMatches.mjs").FrontierFollowWatch | null }} options
   *   The second wave's readers, each optional (a route without its module
   *   answers 404 `not_found`, which the page reads as 「还在准备」):
   *   `events` a `FrontierEvents` (hot list, event pages), `daily` a
   *   `FrontierDaily` (issues), `profiles` a `FrontierProfiles` (与你相关),
   *   `actions` a `FrontierActions` (存入知识库, 中文摘要), `interactions` a `FrontierInteractions` (what each list served,
   *   under a `listId`, and the reader's events); without it lists carry no `listId` and the events route answers 404.
   */
  constructor({ database, config, vocabulary, policies = createModuleEvolutionPolicies(), ingest = null, embedder = null, budget = null, now = () => new Date(),
    dimension = 1024, cacheTtlMs = CACHE_TTL_MS, events = null, daily = null, weekly = null, monthly = null, profiles = null, actions = null,
    tags = null, tagUpkeep = null, interactions = null, topics = null, watch = null }) {
    if (!database || !config || !vocabulary) throw new TypeError("The frontier service needs the product database, the config and the vocabulary.");
    this.policies = policies;
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
    this.weekly = weekly;
    this.monthly = monthly;
    this.profiles = profiles;
    this.subscriptions = new FrontierSubscriptions({ database });
    this.actions = actions;
    /** The tag tree (frontierTags.mjs) a filter, a follow and the 专科 panel read; and its upkeep, for the operators' view. */
    this.tags = tags ?? new FrontierTagStore({ database, now });
    this.tagUpkeep = tagUpkeep;
    this.interactions = interactions;
    /** The hot-event topics (`FrontierTopics`, c2-leads 2026-10-25): 热榜's 「热点话题」, the topic page and `frontier_search`; null serves none. */
    this.topics = topics;
    /** 追踪 (c3-track 2026-10-25, `frontierTrack.mjs`): the approval and guideline records and the congress hubs, read. */
    this.trackReader = new FrontierTrack({ database, now, timeZone: String(config.frontierTimeZone || "Asia/Shanghai") });
    /** Typed follows (`FrontierFollowWatch`, c3-watch): their reading, matches and counts; null stores a typed follow by its words and counts none. */
    this.watch = watch;
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

  /** The editorial selection a list was cut under: the module's evolved policy, or the editor's version and threshold. */
  async #editorialRevision() {
    try {
      const policy = await this.policies.resolve("frontier", {});
      return policy.revisionId.startsWith("default:") ? `${FRONTIER_EDITOR_VERSION}:threshold:${frontierSelectThreshold(this.config)}` : policy.revisionId;
    } catch {
      return null;
    }
  }

  /**
   * Record what a list served (`frontierInteractions.mjs`) and return its `listId`, or null where the record is not kept here —
   * the list is answered either way.
   * @param {{ id: string }} user @param {string} surface @param {string} policy
   * @param {Array<{ item?: string, event?: string, slot?: string | null, score?: number | null, propensity?: number | null }>} entries
   */
  async #serve(user, surface, policy, entries) {
    if (!this.interactions) return null;
    return this.interactions.serve(user.id, { surface, policy, editorial: await this.#editorialRevision(), entries });
  }

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
      // The 推荐理由 is the reader's, for selected and near-line items only (frontierEditor.mjs: why it was retired, and came back).
      reason: frontierReaderWorthy(row, this.selectThreshold) ? row.reason_zh ?? null : null,
      // 「可能改变实践」 (c3-select, contract §P): the label and its one-line reason, only once the day's mix admitted it; content, not provenance.
      practice: frontierPracticeLabel(row),
      // What the item is as a reader names it (ct-write 2026-10-24): the stored genre, else code's from the item's fields — never null.
      genre: frontierItemGenre(row),
      genreLabel: FRONTIER_GENRE_LABELS_ZH[frontierItemGenre(row)],
      // Contract B's card fields: where the item comes from and its first picture.
      channel: frontierItemChannel(row),
      platform: typeof row.platform === "string" && row.platform ? row.platform : null,
      author: frontierAuthor(row.author),
      thumb: frontierMediaList(row.media)[0] ?? null,
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
      // `platformProduced`: the source's content is EviMed's own (contract 1.3.0) — the label 「EviMed 出品」, and the reason such
      // an item is never counted as another institution's report of anything.
      source: { id: row.primary_source_id, name: frontierSourceDisplayName({ id: row.primary_source_id, name: row.source_name, ownerEntity: row.source_owner, access: row.source_access, journal: row.item_journal }),
        homepage: row.source_homepage ?? null, platformProduced: row.source_platform_produced === true,
        // A stream (a PubMed or OpenAlex query) is named by the item's journal, but a follow or a mute acts on the whole stream: such a
        // source is not offered to follow or mute by that name (c3-select's journal names).
        followable: !frontierIsStreamSource({ id: row.primary_source_id, access: row.source_access }) },
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
      editorDiagnostics: frontierEditorDiagnostics(row.editor_diagnostics),
      // The editorial total and its band; a safety alert is not scored for a reader.
      score: row.safety_alert === true || row.score_total == null ? null : Number(row.score_total),
      scoreBand: row.safety_alert === true ? null : frontierScoreBand(row.score_total),
      // The four parts behind the total (owner, 2026-10-23: a lone number told the reader nothing): shown beside it, out of
      // FRONTIER_SCORE_MAXIMA.
      scoreParts: row.safety_alert === true || row.score_total == null ? null
        : { authority: scorePart(row.score_authority) ?? 0, impact: scorePart(row.score_impact) ?? 0, novelty: scorePart(row.score_novelty) ?? 0,
          relevance: scorePart(row.score_relevance) ?? 0 },
      // The tree's tags (frontierTags.mjs): active, resolved through merges, in the item's order.
      tags: (Array.isArray(row.tag_refs) ? row.tag_refs : []).slice(0, FRONTIER_ITEM_TAG_LIMIT)
        .map((/** @type {any} */ tag) => ({ slug: String(tag.slug), name: String(tag.name) })),
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
    const subscribed = query.subscriptions;
    if (query.follow === "all") {
      const positive = (subscribed?.follows ?? []).filter((follow) => !follow.muted);
      where.push(positive.length ? `(${positive.map((follow) => `(${frontierFollowPredicate(follow, param)})`).join(" OR ")})` : "FALSE");
    }
    if (subscribed?.selected && !(subscribed.selected.kind === "topic" && search)) {
      where.push(`(${frontierFollowPredicate(subscribed.selected, param)})`);
    }
    for (const muted of subscribed?.muted ?? []) where.push(`NOT (${frontierFollowPredicate(muted, param)})`);
    // Searching the selected view searches everything and marks the selected.
    if (query.view === "selected" && !search) where.push("i.selected");
    if (query.lane) where.push(`i.lane = ${param(query.lane)}`);
    if (query.specialties?.length) where.push(`i.specialties && ${param(query.specialties)}::text[]`);
    if (query.tag) where.push(frontierTagPredicate(param(query.tag)));
    if (query.evidence) where.push(`i.evidence_type = ${param(query.evidence)}`);
    if (query.unread) {
      where.push(`NOT EXISTS (SELECT 1 FROM evimed_frontier.user_state us WHERE us.user_id = ${param(userId)} AND us.item_id = i.id AND us.read_at IS NOT NULL)`);
    }
    if (query.safety) where.push("i.safety_alert");
    if (query.channel) where.push(channelPredicate(query.channel));
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
    const key = query.starred || query.unread || query.readerKey ? null : JSON.stringify(["time", query.by, query.lane, query.specialty, query.window, query.q, query.safety, clock, query.readerKey ?? null, query.channel, query.tag, query.evidence]);
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
    const query = /** @type {ItemsQuery} */ (normalizeItemsQuery(params, this.vocabulary));
    this.counters.lists += 1;
    if (query.tag) {
      // The address of a tag folded into another lists as that one; one the tree does not show is not a filter anybody can mean.
      const found = this.tags ? await this.tags.filter(query.tag) : null;
      if (!found) throw failure(404, "frontier_tag_not_found", "This tag does not exist.");
      query.tag = found.tag.slug;
    }
    const versions = await this.#transaction((client) => this.#versions(client, user.id));
    query.subscriptions = await this.subscriptions.read(user.id, query.follow);
    if (query.follow || query.subscriptions.muted.length) query.readerKey = `${user.id}:${versions.state}`;
    if (query.subscriptions.selected?.kind === "topic") {
      query.q = [query.subscriptions.selected.key, query.q].filter(Boolean).join(" ");
    }
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
    const cacheKey = query.starred || query.unread || query.readerKey ? null : JSON.stringify([search ? "search" : "list", query.view, query.by, query.lane, query.specialty,
      query.window, query.q, query.safety, query.cursor, query.limit, clock, search ? query.sort : null, query.readerKey ?? null, query.channel, query.tag, query.evidence]);
    let page = cacheKey ? this.#cached(cacheKey, versions.content) : null;
    if (!page) {
      if (search) {
        // The fused ranking is kept for the next pages of the same search: a
        // second page must not embed the question and run three legs again.
        const rankingKey = query.starred || query.unread || query.readerKey ? null : JSON.stringify(["ranking", query.by, query.lane, query.specialty, query.window, query.q, query.safety, clock, query.readerKey ?? null, query.channel, query.tag, query.evidence]);
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
          // The words matched no item, so these are the vector leg's nearest neighbours: the reader is told once.
          related: ranking.lexical.length === 0 && ordered.ids.length > 0,
          next: more ? encodeCursor({ by: query.by, view: query.view, v: versions.content, f: filterPrint(query), o: offset + query.limit }) : null,
        };
      } else {
        const listed = await this.#transaction((client) => this.#listPage(client, query, user.id, position));
        page = {
          items: listed.items, mode: "list", related: false,
          next: listed.next ? encodeCursor({ by: query.by, view: query.view, v: versions.content, f: filterPrint(query), t: listed.next.t, id: listed.next.id }) : null,
        };
      }
      if (cacheKey) this.#remember(cacheKey, versions.content, page);
    }
    const marks = await this.#transaction((client) => this.#overlay(client, user.id, page.items.map((entry) => entry.rowId)));
    const items = page.items
      .map((entry) => ({ ...entry.item, state: marks.get(entry.rowId) ?? { starred: false, hidden: false, read: false } }))
      .filter((item) => query.starred || !item.state.hidden);
    // What was served, under a list id an impression or an open names back (contract C): 精选 is the editor's pick, a safety rail
    // the must-see, a chronological list, a search and the follows have no slot.
    const surface = search ? "search" : query.follow ? "follows" : query.safety ? "safety" : "feed";
    const slot = query.safety ? "must-see" : surface === "feed" && query.view === "selected" ? "editorial" : null;
    const served = items.map((item) => ({ ...item, slot }));
    const listId = await this.#serve(user, surface, frontierListPolicy(surface, query),
      served.map((item) => ({ item: item.id, slot, score: item.score })));
    return { status: 200, etag, body: { items: served, nextCursor: page.next, version: String(versions.content), mode: page.mode, related: page.related, listId } };
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
      // `same_event_item_id` is fr-events' verdict column (cc/briefs/fr-contract.md); read through to_jsonb so this reader answers
      // whether or not the column exists yet.
      const row = (await client.query(`SELECT ${ITEM_COLUMNS}, i.quoted, i.metrics, t.abstract_raw, t.abstract_zh, t.publication_types, t.mesh, t.journal,
          t.authors_short, t.enrichment, t.body_text, t.body_excerpt, t.body_zh, t.body_zh_kind, t.body_zh_source, t.body_complete, t.quoted_zh, t.reader_tidy,
          i.lead_zh, i.insight_zh, i.insight_refs, i.brief, i.ask_zh,
          (to_jsonb(i)->>'same_event_item_id') AS same_event_item_id
        FROM ${ITEM_FROM} WHERE i.public_id=$1 AND i.state = 'published' AND s.enabled`, [publicId])).rows[0];
      if (!row) throw failure(404, "frontier_item_not_found", "No such item.");
      const marks = await this.#overlay(client, user.id, [String(row.id)]);
      const enrichment = row.enrichment && typeof row.enrichment === "object" ? row.enrichment : {};
      const card = this.#item(row);
      return {
        status: /** @type {const} */ (200), etag,
        body: {
          item: {
            ...card,
            ...(await this.#reader(client, row)),
            // The questions a reader may put to the assistant about this item (frontierAsk.mjs); the reader's detail only, never a list card.
            ask: servedAsk(row.ask_zh),
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
   * The 「AI 要点」 as served (`frontierBriefView`: the genre's table decides keys and labels), or null. A commentary that the event
   * layer placed with a primary report says which: `about` is that report — the earliest published `primary` member of its event —
   * opening as its own article (contract B; read from the event, never matched here).
   * @param {any} client @param {Record<string, any>} row
   */
  async #brief(client, row) {
    const brief = frontierBriefView(row.brief);
    if (!brief || brief.genre !== "commentary") return brief;
    const about = (await client.query(`SELECT o.public_id, coalesce(o.title_zh, o.title_raw) AS title
      FROM evimed_frontier.event_items me
      JOIN evimed_frontier.events e ON e.id = me.event_id AND e.merged_into IS NULL
      JOIN evimed_frontier.event_items oe ON oe.event_id = me.event_id AND oe.item_id <> me.item_id AND oe.role = 'primary'
      JOIN evimed_frontier.items o ON o.id = oe.item_id AND o.state = 'published'
      WHERE me.item_id = $1 ORDER BY o.timeline_at, o.id LIMIT 1`, [row.id])).rows[0];
    return about ? { ...brief, about: { publicId: String(about.public_id), title: String(about.title) } } : brief;
  }

  /**
   * The 「AI 解读」 (frontierInsight.mjs): its text and the reports it cites, each still published; null when there is none. A
   * cited report that is no longer published drops out of `refs`, and the reader shows its mark as plain text.
   * @param {any} client @param {Record<string, any>} row
   */
  async #insight(client, row) {
    const text = typeof row.insight_zh === "string" && row.insight_zh.trim() ? row.insight_zh : null;
    if (!text) return null;
    const cited = Array.isArray(row.insight_refs) ? row.insight_refs.filter((ref) => Number.isSafeInteger(ref?.n) && /^\d{1,19}$/.test(String(ref?.item_id ?? ""))) : [];
    const found = cited.length ? (await client.query(`SELECT i.id, i.public_id, coalesce(i.title_zh, i.title_raw) AS title, i.timeline_at,
        i.primary_source_id, s.name AS source_name, s.owner_entity AS source_owner, ${FRONTIER_SOURCE_STREAM_COLUMNS}
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.id = ANY($1::bigint[]) AND i.state = 'published'`, [cited.map((ref) => String(ref.item_id))])).rows : [];
    const byId = new Map(found.map((/** @type {any} */ item) => [String(item.id), item]));
    const refs = cited.flatMap((ref) => {
      const item = byId.get(String(ref.item_id));
      return item ? [{ n: ref.n, publicId: String(item.public_id), title: String(item.title),
        source: frontierSourceDisplayName({ id: item.primary_source_id, name: item.source_name, ownerEntity: item.source_owner, access: item.source_access, journal: item.item_journal }),
        at: new Date(item.timeline_at).toISOString() }] : [];
    });
    return { text, refs };
  }

  /**
   * What the reader adds to a card (contract B, 2026-10-22): the 导读, the full text and its Chinese, the post's pictures, the post
   * it quotes and its counts, the topics and tags, the item it stands beside in its event, and the event's follow-ups. Every
   * field is what was stored; one the server cannot fill is null (or empty), and the reader omits its block.
   * @param {any} client @param {Record<string, any>} row
   */
  async #reader(client, row) {
    const post = row.platform === "x";
    const translated = row.body_zh_kind === "translation" && typeof row.body_zh === "string" && row.body_zh.trim() ? row.body_zh : null;
    // The 原文 a translation was made from, or the best text there is (frontierReaderText), as the paragraphs the translation has.
    const text = (translated ? frontierReaderText(row, row.body_zh_source ?? null) : null) ?? frontierReaderText(row);
    const original = text ? (post ? text.text.trim() : frontierParagraphs(text.text).join("\n\n")) : null;
    const chinese = Boolean(original) && !translated && (row.body_zh_kind === "original-zh" || isChineseProse(String(original).slice(0, 3_000)));
    const quoted = row.quoted && typeof row.quoted === "object" && typeof row.quoted.text === "string" && row.quoted.text.trim() ? row.quoted : null;
    /** @param {unknown} value */
    const count = (value) => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null);
    const metrics = row.metrics && typeof row.metrics === "object"
      ? { likes: count(row.metrics.likes), reposts: count(row.metrics.reposts), replies: count(row.metrics.replies), views: count(row.metrics.views) } : null;
    const sameEventId = /^\d{1,19}$/.test(String(row.same_event_item_id ?? "")) ? String(row.same_event_item_id) : null;
    const same = sameEventId ? (await client.query(`SELECT public_id, coalesce(title_zh, title_raw) AS title FROM evimed_frontier.items
      WHERE id = $1 AND state = 'published' AND id <> $2`, [sameEventId, row.id])).rows[0] ?? null : null;
    return {
      // The reader's 导读 paragraph (frontierLead.mjs), else the card's summary.
      lead: row.lead_zh ?? row.summary_zh ?? null,
      // The genre's typed 「AI 要点」 (frontierBrief.mjs), with — for a reading of another report — the report it reads.
      brief: await this.#brief(client, row),
      insight: await this.#insight(client, row),
      body: {
        zh: translated ?? (chinese ? original : null),
        original,
        zhKind: translated ? "translation" : chinese ? "original-zh" : null,
        complete: translated ? row.body_complete === true : chinese,
        source: text?.source ?? null,
      },
      media: frontierMediaList(row.media),
      quoted: quoted ? {
        author: { name: typeof quoted.author?.name === "string" ? quoted.author.name.slice(0, 200) : "",
          handle: typeof quoted.author?.handle === "string" && quoted.author.handle ? quoted.author.handle.slice(0, 100) : null },
        text: String(quoted.text).slice(0, 4_000),
        translation: typeof row.quoted_zh === "string" && row.quoted_zh.trim() ? row.quoted_zh : null,
        url: typeof quoted.url === "string" && /^https?:\/\//.test(quoted.url) ? quoted.url.slice(0, 2048) : null,
      } : null,
      metrics: metrics && Object.values(metrics).some((value) => value !== null) ? metrics : null,
      sameEvent: same ? { itemId: same.public_id, title: same.title } : null,
      followups: await this.#followups(client, row.id),
    };
  }

  /**
   * An item's 事件后续 (contract B `followups`): fr-events' `frontierItemFollowups` when it is there (cc/briefs/fr-contract.md);
   * until then the other published members of its event, newest first, at most eight — `same-event` rows only, never a made-up
   * `follows`. Null when the item stands alone.
   * @param {any} client @param {string | number} rowId
   * @returns {Promise<{ eventId: string, rows: Array<{ itemId: string, title: string, sourceName: string, at: string, relation: "same-event" | "follows" }>, more: boolean } | null>}
   */
  async #followups(client, rowId) {
    const external = /** @type {any} */ (frontierEventReading).frontierItemFollowups;
    if (typeof external === "function") return (await external(client, rowId, { limit: 8 })) ?? null;
    const rows = (await client.query(`SELECT e.public_id AS event_id, o.public_id, coalesce(o.title_zh, o.title_raw) AS title, s.id AS source_id,
        s.name AS source_name, s.owner_entity, ${frontierSourceStreamColumns("o")}, o.timeline_at
      FROM evimed_frontier.event_items me
      JOIN evimed_frontier.events e ON e.id = me.event_id AND e.merged_into IS NULL
      JOIN evimed_frontier.event_items oe ON oe.event_id = me.event_id AND oe.item_id <> me.item_id
      JOIN evimed_frontier.items o ON o.id = oe.item_id AND o.state = 'published'
      JOIN evimed_frontier.sources s ON s.id = o.primary_source_id AND s.enabled
      WHERE me.item_id = $1
      ORDER BY o.timeline_at DESC, o.id DESC LIMIT 9`, [rowId])).rows;
    if (!rows.length) return null;
    return {
      eventId: rows[0].event_id,
      rows: rows.slice(0, 8).map((/** @type {any} */ other) => ({ itemId: other.public_id, title: other.title,
        sourceName: frontierSourceDisplayName({ id: other.source_id, name: other.source_name, ownerEntity: other.owner_entity, access: other.source_access, journal: other.item_journal }),
        at: /** @type {string} */ (iso(other.timeline_at)), relation: /** @type {const} */ ("same-event") })),
      more: rows.length > 8,
    };
  }

  /**
   * One image of a published item, from the plugin (contract B `GET /api/frontier/media/:id`, `frontierMedia.mjs`), or a 304 for
   * a browser that already holds it — the id is the bytes' hash, so its tag never changes.
   * @param {{ id: string }} _user @param {string} id @param {unknown} ifNoneMatch
   * @returns {Promise<{ status: 200, etag: string, bytes: Buffer, contentType: string } | { status: 304, etag: string }>}
   */
  async media(_user, id, ifNoneMatch = null) {
    if (!FRONTIER_MEDIA_ID.test(String(id ?? ""))) throw failure(404, "frontier_media_not_found", "No such image.");
    const known = await this.#transaction(async (client) => (await client.query(`SELECT 1 FROM evimed_frontier.items i
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.state = 'published' AND s.enabled AND i.media @> $1::jsonb LIMIT 1`, [JSON.stringify([{ id }])])).rowCount > 0);
    if (!known) throw failure(404, "frontier_media_not_found", "No such image.");
    const etag = `"${id}"`;
    if (etagMatches(ifNoneMatch, etag)) return { status: 304, etag };
    const { bytes, contentType } = await fetchFrontierMedia(this.ingest?.plugin, id);
    return { status: 200, etag, bytes, contentType };
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
        weekly: Boolean(this.weekly),
        monthly: Boolean(this.monthly),
        // The evidence zones' own switches (flywheel F08, F14): whether a zone has a public page to link to, and whether a card's
        // history and a reader's challenge are offered. A button is never shown for a route that would answer 404.
        evidencePublicPages: this.config.evidencePublicWebEnabled === true,
        // Where those pages are served, said only with them: a link to a page needs the base the deployment serves it under.
        ...(this.config.evidencePublicWebEnabled === true ? { evidencePublicBasePath: this.config.evidencePublicBasePath } : {}),
        evidenceUpkeep: this.config.evidenceUpkeepEnabled === true,
        // Hot-event topics (c2-leads 2026-10-25): 热榜's 「热点话题」 and the topic pages.
        topics: Boolean(this.topics),
        // 追踪 (c3-track 2026-10-25): approvals, guideline updates and congresses.
        track: true,
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
   * Star, unstar, hide, unhide or mark read one item for one reader. A hide may say why (`options.reason`, one of
   * `FRONTIER_HIDE_REASONS`): the reason is kept with the hide (`user_state.hidden_reason`), a later hide of an item that is
   * still hidden replaces it when it carries one and leaves it when it does not, and an unhide clears it — a reason belongs to
   * the hide that stands.
   * @param {{ id: string }} user @param {string} publicId @param {"star" | "unstar" | "hide" | "unhide" | "read"} action
   * @param {{ reason?: string | null }} [options]
   */
  async setItemState(user, publicId, action, options = {}) {
    const columns = { star: ["starred_at", true], unstar: ["starred_at", false], hide: ["hidden_at", true], unhide: ["hidden_at", false], read: ["read_at", true] };
    if (!Object.hasOwn(columns, action)) throw failure(404, "not_found", "Frontier route not found.");
    if (!PUBLIC_ID.test(String(publicId ?? ""))) throw failure(404, "frontier_item_not_found", "No such item.");
    const reason = options?.reason ?? null;
    if (reason !== null && (action !== "hide" || !FRONTIER_HIDE_REASONS.includes(/** @type {any} */ (reason)))) {
      throw failure(400, "frontier_payload_invalid", "The hide reason is not one the feed knows.");
    }
    const [column, set] = columns[action];
    // The first time counts: a second star keeps when it was starred. A hide keeps its first time too, and takes the reason it was given.
    const insertColumns = action === "hide" ? "user_id, item_id, hidden_at, hidden_reason" : `user_id, item_id, ${column}`;
    const insertValues = action === "hide" ? "$1, $2, clock_timestamp(), $3" : `$1, $2, ${set ? "clock_timestamp()" : "NULL"}`;
    const update = action === "hide"
      ? `hidden_at = coalesce(us.hidden_at, clock_timestamp()),
          hidden_reason = CASE WHEN us.hidden_at IS NULL THEN EXCLUDED.hidden_reason ELSE coalesce(EXCLUDED.hidden_reason, us.hidden_reason) END`
      : action === "unhide" ? "hidden_at = NULL, hidden_reason = NULL"
        : `${column} = ${set ? `coalesce(us.${column}, clock_timestamp())` : "NULL"}`;
    const state = await this.#transaction(async (client) => {
      const item = (await client.query(`SELECT id FROM evimed_frontier.items WHERE public_id=$1 AND state IN ('published','withdrawn')`, [publicId])).rows[0];
      if (!item) throw failure(404, "frontier_item_not_found", "No such item.");
      const row = (await client.query(`INSERT INTO evimed_frontier.user_state AS us (${insertColumns}) VALUES (${insertValues})
        ON CONFLICT (user_id, item_id) DO UPDATE SET ${update}
        RETURNING starred_at IS NOT NULL AS starred, hidden_at IS NOT NULL AS hidden, read_at IS NOT NULL AS read`,
      action === "hide" ? [user.id, item.id, reason] : [user.id, item.id])).rows[0];
      await this.#bumpState(client, user.id);
      return row;
    });
    this.counters.writes += 1;
    // What the reader just did is what 与我相关 is read from: after the
    // commit, and never failing the action (frontierProfiles.mjs).
    await this.profiles?.noteItemAction?.(user.id, action);
    return { state: { starred: state.starred, hidden: state.hidden, read: state.read } };
  }

  /**
   * A follow as the page reads it. `fresh` is how many published items arrived since the reader last opened it (c3-watch): absent
   * when it could not be counted, and then no number is shown. A typed follow also says how its words were read.
   * @param {Record<string, any>} row @param {number} [fresh]
   */
  #follow(row, fresh) {
    return {
      id: String(row.id), kind: row.kind, key: row.key, label: row.label, muted: row.muted === true, createdAt: iso(row.created_at),
      ...(row.kind === "query" ? { query: followQueryView(row.query) } : {}),
      ...(row.seen_at ? { seenAt: iso(row.seen_at) } : {}),
      ...(fresh === undefined ? {} : { newItems: fresh }),
    };
  }

  /** @param {{ id: string }} user */
  async listFollows(user) {
    const rows = await this.#transaction(async (client) => (await client.query(`SELECT id, kind, key, label, muted, created_at, query, seen_at
      FROM evimed_frontier.user_follows WHERE user_id=$1 ORDER BY created_at DESC, id DESC`, [user.id])).rows);
    const counts = await this.#newCounts(user.id, rows);
    return { follows: rows.map((/** @type {any} */ row) => this.#follow(row, counts.get(String(row.id)))) };
  }

  /**
   * How many items each follow has had since it was last opened (`FrontierFollowWatch#newCounts`). A count that cannot be read is
   * no count — the list of follows is still the list.
   * @param {string} userId @param {Array<Record<string, any>>} rows
   * @returns {Promise<Map<string, number>>}
   */
  async #newCounts(userId, rows) {
    if (!this.watch || !rows.length) return new Map();
    try {
      const { follows } = await this.subscriptions.read(userId);
      const since = new Map(rows.map((row) => [String(row.id), new Date(row.seen_at ?? row.created_at)]));
      return await this.watch.newCounts(userId, follows, since);
    } catch {
      return new Map();
    }
  }

  /**
   * The typed follows of a reader that have items since they last opened them: `{ id, label, newItems }`, the busiest first. A
   * count that cannot be read leaves the list empty — the page is still the page.
   * @param {string} userId
   */
  async #queryFollowsWithNews(userId) {
    if (!this.watch) return [];
    try {
      const rows = await this.#transaction(async (client) => (await client.query(`SELECT id, kind, key, label, muted, created_at, seen_at
        FROM evimed_frontier.user_follows WHERE user_id=$1 AND kind='query' AND NOT muted ORDER BY created_at DESC, id DESC`, [userId])).rows);
      if (!rows.length) return [];
      const counts = await this.#newCounts(userId, rows);
      return rows.map((/** @type {any} */ row) => ({ id: String(row.id), label: String(row.label), newItems: counts.get(String(row.id)) ?? 0 }))
        .filter((entry) => entry.newItems > 0).sort((left, right) => right.newItems - left.newItems);
    } catch {
      return [];
    }
  }

  /**
   * The reader opened a follow's feed: what arrived before now is no longer new (c3-watch).
   * @param {{ id: string }} user @param {string} followId
   */
  async markFollowSeen(user, followId) {
    if (!/^\d{1,18}$/.test(String(followId ?? ""))) throw failure(404, "frontier_follow_not_found", "No such follow.");
    await this.ready();
    const row = (await this.database.query(`UPDATE evimed_frontier.user_follows SET seen_at = $3::timestamptz WHERE user_id=$1 AND id=$2
      RETURNING id, kind, key, label, muted, created_at, query, seen_at`, [user.id, followId, this.now().toISOString()])).rows[0];
    if (!row) throw failure(404, "frontier_follow_not_found", "No such follow.");
    this.counters.writes += 1;
    return { follow: this.#follow(row, 0) };
  }

  /**
   * The tree's tags for the 「专科」 panel (`?specialty=a,b`: those specialties' active tags by items of thirty days) or for the search
   * box (`?q=`: active tags a spelling of which contains the words).
   * @param {URLSearchParams} params
   */
  async tagList(params) {
    const invalid = () => failure(400, "frontier_query_invalid", "The tag query is invalid.");
    const limitValue = params.get("limit");
    const limit = limitValue == null || limitValue === "" ? 24 : Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) throw invalid();
    await this.ready();
    const q = (params.get("q") ?? "").trim();
    if (q) {
      if (q.length > 40) throw invalid();
      return { tags: await this.tags.suggest(q, Math.min(limit, 20)) };
    }
    const specialties = (params.get("specialty") ?? "").split(",").map((key) => key.trim()).filter(Boolean)
      .map((key) => (Object.hasOwn(this.vocabulary.specialties, key) ? key : frontierSpecialtyKey(key)));
    if (specialties.some((key) => !key)) throw invalid();
    return { tags: await this.tags.hot(/** @type {string[]} */ (specialties), limit) };
  }

  /** One tag, as its address names it; a folded address answers as the tag that stands for it. @param {string} slug */
  async tagDetail(slug) {
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(String(slug))) throw failure(404, "frontier_tag_not_found", "This tag does not exist.");
    await this.ready();
    const found = await this.tags.detail(slug);
    if (!found) throw failure(404, "frontier_tag_not_found", "This tag does not exist.");
    const { tag, mergedFrom } = found;
    return { tag: { ...tag, specialties: tag.specialties.filter((key) => Object.hasOwn(this.vocabulary.specialties, key)).map((key) => ({ key, label: this.vocabulary.specialties[key] })) },
      ...(mergedFrom ? { mergedFrom } : {}) };
  }

  /** The operators' view of the tree (`FrontierTagUpkeep#overview`). */
  async tagOverview() {
    if (!this.tagUpkeep) throw failure(404, "frontier_tags_unavailable", "The tag tree's upkeep is not running here.");
    await this.ready();
    return this.tagUpkeep.overview();
  }

  /** Take back one change of the tree. @param {string} id */
  async undoTagChange(id) {
    if (!this.tagUpkeep) throw failure(404, "frontier_tags_unavailable", "The tag tree's upkeep is not running here.");
    if (!/^\d{1,18}$/.test(String(id))) throw failure(404, "frontier_tag_change_not_found", "No such change.");
    await this.ready();
    if (!(await this.tagUpkeep.undo(id))) throw failure(409, "frontier_tag_change_not_undoable", "This change can no longer be taken back.");
    return { ok: true };
  }

  /**
   * Follow (or mute) a topic, specialty, drug, source or event. Upserts by
   * (kind, key): following again changes the label or the mute, never adds a row.
   * @param {{ id: string }} user @param {{ kind?: unknown, key?: unknown, label?: unknown, muted?: unknown }} body
   */
  async createFollow(user, body) {
    const kind = String(body.kind ?? "");
    if (!FOLLOW_KINDS.includes(kind)) throw failure(400, "frontier_follow_invalid", "The follow kind is invalid.");
    if (kind === "query") return this.#createQueryFollow(user, body);
    if (body.muted != null && typeof body.muted !== "boolean") throw failure(400, "frontier_follow_invalid", "muted must be a boolean.");
    let key;
    if (kind === "specialty") {
      key = typeof body.key === "string" && Object.hasOwn(this.vocabulary.specialties, body.key) ? body.key : null;
    } else if (kind === "tag") {
      // A tag of the tree, kept by the address that stands for it now.
      const found = typeof body.key === "string" && /^[a-z0-9][a-z0-9-]{1,79}$/.test(body.key) ? (await this.ready(), await this.tags.filter(body.key)) : null;
      key = found?.tag.slug ?? null;
    } else if (kind === "event") {
      key = typeof body.key === "string" && PUBLIC_ID.test(body.key) ? body.key : null;
    } else if (kind === "source") {
      key = typeof body.key === "string" && body.key.length <= 120 ? body.key : null;
    } else {
      // Topics and drugs are the reader's words: compared case-folded.
      key = followText(body.key, 120)?.toLowerCase() ?? null;
    }
    if (!key) throw failure(400, "frontier_follow_invalid", "The follow key is invalid.");
    if (kind === "drug") { await this.ready(); key = await this.subscriptions.drugKey(key); }
    const label = body.label == null ? (kind === "specialty" ? this.vocabulary.specialties[key] : key) : followText(body.label, 120);
    if (!label) throw failure(400, "frontier_follow_invalid", "The follow label is invalid.");
    const row = await this.#transaction(async (client) => {
      if (kind === "source" && !(await client.query("SELECT 1 FROM evimed_frontier.sources WHERE id=$1", [key])).rowCount) {
        throw failure(400, "frontier_follow_invalid", "No such source.");
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`frontier-follows:${user.id}`]);
      if (kind === "drug") {
        const legacy = (await client.query("SELECT id,key FROM evimed_frontier.user_follows WHERE user_id=$1 AND kind='drug' ORDER BY id", [user.id])).rows;
        const equivalent = [];
        for (const old of legacy) if (await this.subscriptions.drugKey(old.key) === key) equivalent.push(old);
        if (equivalent.length) {
          const keep = equivalent.find((old) => old.key === key) ?? equivalent[0];
          await client.query("DELETE FROM evimed_frontier.user_follows WHERE user_id=$1 AND id=ANY($2::bigint[])", [user.id, equivalent.filter((old) => old.id !== keep.id).map((old) => old.id)]);
          await client.query("UPDATE evimed_frontier.user_follows SET key=$3 WHERE user_id=$1 AND id=$2", [user.id, keep.id, key]);
        }
      }
      const existing = await client.query(`SELECT 1 FROM evimed_frontier.user_follows WHERE user_id=$1 AND kind=$2 AND key=$3`, [user.id, kind, key]);
      if (!existing.rowCount) {
        const count = Number((await client.query("SELECT count(*)::integer AS n FROM evimed_frontier.user_follows WHERE user_id=$1", [user.id])).rows[0].n);
        if (count >= MAX_FOLLOWS) throw failure(409, "frontier_follow_limit", `At most ${MAX_FOLLOWS} follows per account.`);
      }
      const saved = (await client.query(`INSERT INTO evimed_frontier.user_follows AS f (user_id, kind, key, label, muted) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (user_id, kind, key) DO UPDATE SET label = EXCLUDED.label, muted = EXCLUDED.muted
        RETURNING id, kind, key, label, muted, created_at`, [user.id, kind, key, label, body.muted === true])).rows[0];
      await this.#bumpState(client, user.id);
      await client.query("UPDATE evimed_frontier.user_profiles SET for_you_at=NULL WHERE user_id=$1", [user.id]);
      return saved;
    });
    this.counters.writes += 1;
    return { follow: this.#follow(row) };
  }

  /**
   * Follow something the reader typed (c3-watch): its words read once into a query (`FrontierFollowWatch#parse` — a model call that
   * can fail without refusing anyone: the words themselves are the fallback), stored with the follow, and the last seven days
   * matched at once. The same words again are the same follow.
   * @param {{ id: string }} user @param {{ key?: unknown, label?: unknown, muted?: unknown }} body
   */
  async #createQueryFollow(user, body) {
    if (body.muted != null && body.muted !== false) throw failure(400, "frontier_follow_invalid", "A typed follow cannot be muted.");
    const label = typedFollowLabel(body.label ?? body.key);
    if (!label) throw failure(400, "frontier_follow_invalid", "The words to follow are empty or too long.");
    const key = typedFollowKey(label);
    await this.ready();
    const columns = "id, kind, key, label, muted, created_at, query, seen_at";
    const held = (await this.database.query(`SELECT ${columns} FROM evimed_frontier.user_follows WHERE user_id=$1 AND kind='query' AND key=$2`, [user.id, key])).rows[0];
    if (held) return { follow: this.#follow(held, 0) };
    const typed = Number((await this.database.query("SELECT count(*)::integer AS n FROM evimed_frontier.user_follows WHERE user_id=$1 AND kind='query'", [user.id])).rows[0].n);
    if (typed >= FRONTIER_FOLLOW_QUERY_MAX) throw failure(409, "frontier_follow_limit", `At most ${FRONTIER_FOLLOW_QUERY_MAX} typed follows per account.`);
    // Read outside the transaction: a model call must not hold a connection. It does not throw.
    const parsed = this.watch ? await this.watch.parse(user.id, label) : { query: typedFollowQuery(label, null) };
    const row = await this.#transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`frontier-follows:${user.id}`]);
      const count = Number((await client.query("SELECT count(*)::integer AS n FROM evimed_frontier.user_follows WHERE user_id=$1", [user.id])).rows[0].n);
      if (count >= MAX_FOLLOWS) throw failure(409, "frontier_follow_limit", `At most ${MAX_FOLLOWS} follows per account.`);
      // The typed cap again under the lock: two requests read the count above at once (c3 review). A follow of the same words is one.
      const again = (await client.query(`SELECT count(*) FILTER (WHERE kind='query')::integer AS n, bool_or(kind='query' AND key=$2) AS held
        FROM evimed_frontier.user_follows WHERE user_id=$1`, [user.id, key])).rows[0];
      if (!again.held && Number(again.n) >= FRONTIER_FOLLOW_QUERY_MAX) throw failure(409, "frontier_follow_limit", `At most ${FRONTIER_FOLLOW_QUERY_MAX} typed follows per account.`);
      const saved = (await client.query(`INSERT INTO evimed_frontier.user_follows AS f (user_id, kind, key, label, muted, query, created_at) VALUES ($1,'query',$2,$3,false,$4::jsonb,$5::timestamptz)
        ON CONFLICT (user_id, kind, key) DO UPDATE SET label = EXCLUDED.label RETURNING ${columns}`, [user.id, key, label, JSON.stringify(parsed.query), this.now().toISOString()])).rows[0];
      await this.#bumpState(client, user.id);
      await client.query("UPDATE evimed_frontier.user_profiles SET for_you_at=NULL WHERE user_id=$1", [user.id]);
      return saved;
    });
    // The seven days, after the commit: a failure leaves the follow without its scan and the sweep does it.
    await this.watch?.backfill({ id: row.id, userId: user.id, query: parsed.query });
    this.counters.writes += 1;
    return { follow: this.#follow(row, 0) };
  }

  /** @param {{ id: string }} user @param {string} followId */
  async deleteFollow(user, followId) {
    if (!/^\d{1,18}$/.test(String(followId ?? ""))) throw failure(404, "frontier_follow_not_found", "No such follow.");
    await this.#transaction(async (client) => {
      const removed = await client.query("DELETE FROM evimed_frontier.user_follows WHERE user_id=$1 AND id=$2", [user.id, followId]);
      if (!removed.rowCount) throw failure(404, "frontier_follow_not_found", "No such follow.");
      await this.#bumpState(client, user.id);
      await client.query("UPDATE evimed_frontier.user_profiles SET for_you_at=NULL WHERE user_id=$1", [user.id]);
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
    const result = await this.profiles.forYou(user, (/** @type {{ id: string }} */ reader, /** @type {string[]} */ publicIds) => this.hydrate(reader, { publicIds }));
    if (result.state === "off" || !result.items.length) return result;
    // The ranking's own policy version, each entry's slot and score, and the exploration entry's propensity (frontierProfiles.mjs).
    const listId = await this.#serve(user, "for-you", result.policy ?? "for-you", result.items.map((/** @type {any} */ entry) => ({ item: entry.item.id,
      slot: entry.slot ?? null, score: entry.score ?? null, propensity: entry.propensity ?? null })));
    return { ...result, listId };
  }

  /** 与我相关's onboarding answer (frontierProfiles.mjs `prefs`). @param {{ id: string }} user */
  async prefs(user) {
    if (!this.profiles) throw failure(404, "not_found", "Frontier route not found.");
    return this.profiles.prefs(user.id);
  }

  /** Save it: `{ role?, specialties?, interests?, done?, skipped? }`. @param {{ id: string }} user @param {Record<string, unknown>} body */
  async savePrefs(user, body) {
    if (!this.profiles) throw failure(404, "not_found", "Frontier route not found.");
    return this.profiles.savePrefs(user.id, body);
  }

  /**
   * The hot list (plan §4.4, plan 2026-09-23 §6.2), or 404 `not_found` without
   * the event layer. `window=current` (the default) is the latest snapshot's
   * list — each event with its heat, rank change, badge and 24-hour trend —
   * taken at `takenAt` over the 72 hours from `since`; `week` and `month` are
   * that window's ranking, computed now (`takenAt`) from `since`. Shared by
   * every reader, and kept a minute at most — never past a new list or new
   * content, since the versions are in the key.
   * The answer carries the reader's `listId` (what was served, by event, in order) when `user` is given; the shared copy never does.
   * @param {URLSearchParams} [params] @param {{ id: string } | null} [user]
   */
  async hot(params = new URLSearchParams(), user = null) {
    if (!this.events) throw failure(404, "not_found", "Frontier route not found.");
    const window = params.get("window") || "current";
    if (!FRONTIER_HOT_WINDOWS.includes(window)) throw failure(400, "frontier_query_invalid", "The window parameter is invalid.");
    const meta = await this.#transaction(async (client) => Object.fromEntries((await client.query(`SELECT key, value FROM evimed_frontier.meta
      WHERE key = ANY($1::text[])`, [[FRONTIER_META_KEYS.contentVersion, FRONTIER_META_KEYS.hotVersion]])).rows
      .map((/** @type {any} */ row) => [row.key, metaNumber(row.value)])));
    const content = meta[FRONTIER_META_KEYS.contentVersion] ?? 0;
    const key = JSON.stringify(["hot", window, meta[FRONTIER_META_KEYS.hotVersion] ?? 0]);
    const cached = this.#cached(key, content);
    if (cached) return this.#hotServed(user, window, cached);
    let value;
    if (window === "current") {
      const { takenAt, events } = await this.events.hotList();
      value = { window, takenAt, since: takenAt ? new Date(Date.parse(takenAt) - FRONTIER_HOT_WINDOW_HOURS * 3_600_000).toISOString() : null, events };
    } else {
      const period = await this.events.hotPeriod(window);
      value = { window, takenAt: period.at, since: period.since, events: period.events };
    }
    this.#remember(key, content, value);
    return this.#hotServed(user, window, value);
  }

  /** A hot ranking as one reader was served it: a copy with its `listId`, the shared value untouched. @param {{ id: string } | null} user @param {string} window @param {any} value */
  async #hotServed(user, window, value) {
    if (!user || !this.interactions || !Array.isArray(value?.events) || !value.events.length) return value;
    const listId = await this.#serve(user, "hot", `hot:${window}`, value.events.map((/** @type {any} */ event) => ({ event: String(event.id), slot: null,
      score: Number.isFinite(Number(event.heat)) ? Number(event.heat) : null })));
    return { ...value, listId };
  }

  /**
   * One event page, or where a merged event went (`{ redirect }`, answered
   * 308 by the route), or a 404. `?order=desc|asc` puts the reports and the
   * developments in time order (fr-events 2026-10-22).
   * @param {{ id: string }} user @param {string} publicId @param {URLSearchParams} [params]
   */
  async event(user, publicId, params = new URLSearchParams()) {
    if (!this.events) throw failure(404, "not_found", "Frontier route not found.");
    const order = params.get("order") || null;
    if (order !== null && order !== "asc" && order !== "desc") throw failure(400, "frontier_query_invalid", "The order parameter is invalid.");
    const read = await this.events.read(publicId, { order });
    if (!read) throw failure(404, "frontier_event_not_found", "No such event.");
    if ("redirect" in read) return { redirect: read.redirect };
    const items = await this.hydrate(user, { rowIds: read.members.map((member) => member.rowId) });
    const event = read.event;
    const baseline = (await this.database.query('SELECT report_marks FROM evimed_frontier.event_reads WHERE user_id = $1 AND event_id = $2', [user.id, publicId])).rows?.[0]?.report_marks ?? null;
    const reading = frontierEventChanges(read.members, baseline);
    const ask = await this.#eventAsk(read.members);
    return {
      event: {
        id: event.public_id,
        counts: frontierEventEvidenceCounts(read.members), readingMark: reading.mark, changes: reading.changes,
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
        // The other events of its story, each by its representative report (`follows` links): `position` says whether it came
        // before this event or after.
        developments: read.developments ?? [],
        // The questions of the event's first-hand item (c3-ask), with that item: the event page offers them under 「就此提问」.
        ask,
      },
    };
  }

  /**
   * The questions a reader may ask about an event: those of its first first-hand report that has any (members come in the event's
   * own order), with that item's public id and title, or null when no first-hand report is published with questions. A primary item
   * is what the event is about; the questions of a commentary on it would be about the commentary.
   * @param {Array<{ rowId: string | number, role: string }>} members
   * @returns {Promise<{ itemId: string, title: string, questions: string[] } | null>}
   */
  async #eventAsk(members) {
    const primary = members.filter((member) => member.role === "primary").map((member) => String(member.rowId));
    if (!primary.length) return null;
    const rows = (await this.database.query(`SELECT id, public_id, coalesce(title_zh, title_raw) AS title, ask_zh FROM evimed_frontier.items
      WHERE id = ANY($1::bigint[]) AND state = 'published' AND ask_zh IS NOT NULL`, [primary])).rows;
    const byId = new Map(rows.map((/** @type {any} */ row) => [String(row.id), row]));
    for (const id of primary) {
      const row = byId.get(id);
      const questions = row ? servedAsk(row.ask_zh) : [];
      if (row && questions.length) return { itemId: String(row.public_id), title: String(row.title), questions };
    }
    return null;
  }

  // ───────────────────────── c2-leads 2026-10-25: hot-event topics (contract §T) ─────────────────────────

  /**
   * The topics a reader is shown: `?status=active` (the default) or `recent` (closed ones too, newest first), `?limit` 1–30.
   * Each is `frontierTopicSummary` with its overview's references and the evidence programme's card.
   * @param {{ id: string }} _user @param {URLSearchParams} [params]
   */
  async topicList(_user, params = new URLSearchParams()) {
    if (!this.topics) throw failure(404, "not_found", "Frontier route not found.");
    const status = params.get("status") || "active";
    if (status !== "active" && status !== "recent") throw failure(400, "frontier_query_invalid", "The status parameter is invalid.");
    const raw = params.get("limit");
    const limit = raw == null || raw === "" ? 10 : Number(raw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw failure(400, "frontier_query_invalid", "The limit parameter is invalid.");
    const rows = await this.topics.list({ status, limit });
    return { topics: await Promise.all(rows.map((/** @type {any} */ row) => this.#topicSummary(row))) };
  }

  /**
   * One topic page: the topic and its items by role, each the feed's own card (the reader's marks overlaid, a withdrawn or
   * disabled-source item left out), or 404 `frontier_topic_not_found`.
   * @param {{ id: string }} user @param {string} publicId
   */
  async topic(user, publicId) {
    if (!this.topics) throw failure(404, "not_found", "Frontier route not found.");
    const read = await this.topics.read(publicId);
    if (!read) throw failure(404, "frontier_topic_not_found", "No such topic.");
    const items = await this.hydrate(user, { rowIds: read.items.map((/** @type {any} */ entry) => entry.rowId) });
    return {
      topic: await this.#topicSummary(read.topic),
      items: read.items.flatMap((/** @type {any} */ entry) => (items.has(entry.rowId) ? [{ role: entry.role, item: items.get(entry.rowId) }] : [])),
    };
  }

  /**
   * The topics a `frontier_search` query names, as the gateway passes them on (kind `topic`, an index like the cards): the
   * question, the field, the peg, the overview and the items to read, never the subject names.
   * @param {{ id: string }} _user @param {{ q: string, limit?: number }} request
   */
  async searchTopics(_user, { q, limit = 3 }) {
    if (!this.topics) return { topics: [] };
    const rows = await this.topics.search({ q, limit: Math.max(1, Math.min(5, Number(limit) || 3)) });
    const topics = [];
    for (const row of rows) {
      const summary = await this.#topicSummary(row);
      const items = (await this.database.query(`SELECT x.role, coalesce(nullif(i.title_zh, ''), i.title_raw) AS title, i.canonical_url AS url, s.name AS source_name
        FROM evimed_frontier.topic_items x JOIN evimed_frontier.items i ON i.id = x.item_id AND i.state = 'published'
          JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
        WHERE x.topic_id = $1 ORDER BY CASE x.role WHEN 'evidence' THEN 0 WHEN 'report' THEN 1 ELSE 2 END, i.score_total DESC NULLS LAST LIMIT 8`, [row.id])).rows;
      topics.push({ kind: "topic", ...summary, items: items.map((/** @type {any} */ item) => ({ role: item.role, title: item.title, source: item.source_name,
        url: /^https?:\/\//i.test(String(item.url ?? "")) ? item.url : null })) });
    }
    return { topics };
  }

  /** A topic row as the reader is served it: its overview's references resolved to the items, its card when settled. @param {any} row */
  async #topicSummary(row) {
    const marks = Array.isArray(row.overview_refs) ? row.overview_refs : [];
    /** @type {Array<{ n: number, itemId: string, title: string, sourceName: string }> | null} */
    let refs = null;
    if (row.overview_zh && marks.length) {
      const ids = marks.map((/** @type {any} */ mark) => String(mark.itemId)).filter((id) => PUBLIC_ID.test(id));
      const found = new Map((await this.database.query(`SELECT i.public_id, coalesce(nullif(i.title_zh, ''), i.title_raw) AS title, s.name AS source_name
        FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
        WHERE i.public_id = ANY($1::text[]) AND i.state = 'published'`, [ids])).rows.map((/** @type {any} */ item) => [item.public_id, item]));
      refs = marks.flatMap((/** @type {any} */ mark) => {
        const item = found.get(String(mark.itemId));
        return item ? [{ n: Number(mark.n), itemId: String(mark.itemId), title: String(item.title ?? ""), sourceName: String(item.source_name ?? "") }] : [];
      });
    }
    /** @type {{ id: string, title: string, href: string } | null} */
    let card = null;
    if (row.programme_card_id) {
      const present = (await this.database.query("SELECT to_regclass('evimed_frontier.evidence_cards') IS NOT NULL AS ok")).rows[0]?.ok === true;
      const found = present ? (await this.database.query(`SELECT id, zone_id, title FROM evimed_frontier.evidence_cards WHERE id = $1 AND state = 'published'`,
        [String(row.programme_card_id)])).rows[0] : null;
      if (found) card = { id: found.id, title: found.title, href: `/app/frontier/zones/${encodeURIComponent(found.zone_id)}/evidence/${encodeURIComponent(found.id)}` };
    }
    return frontierTopicSummary(row, { refs, card });
  }

  // ───────────────────────── c3-track 2026-10-25: 追踪 (contract §T) ─────────────────────────

  /**
   * The cards of a page of tracked rows, each the feed's own (the reader's marks overlaid), and the rows a reader hid or whose
   * item left (withdrawn, hidden source) left out.
   * @param {{ id: string }} user @param {Array<{ rowId: string }>} rows
   */
  async #trackCards(user, rows) {
    const items = await this.hydrate(user, { rowIds: rows.map((row) => row.rowId) });
    return items;
  }

  /**
   * 审批 (`GET /api/frontier/track/approvals?from&agency&kind&cursor`): the approvals of the last 90 days (or from `from`), each
   * with the card and the fields of its record, the agencies they come from with their counts (a filter's options) and the year's
   * count by agency. `listId` names what was served (surface `track`).
   * @param {{ id: string }} user @param {URLSearchParams} params
   */
  async trackApprovals(user, params) {
    const from = params.get("from");
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw failure(400, "frontier_query_invalid", "The from parameter is invalid.");
    const agency = params.get("agency");
    if (agency && !/^[a-z-]{2,20}$/.test(agency)) throw failure(400, "frontier_query_invalid", "The agency parameter is invalid.");
    const kind = params.get("kind");
    if (kind && !Object.hasOwn(FRONTIER_APPROVAL_KIND_LABELS_ZH, kind)) throw failure(400, "frontier_query_invalid", "The kind parameter is invalid.");
    const cursor = params.get("cursor");
    if (cursor && cursor.length > 200) throw failure(400, "frontier_cursor_invalid", "The cursor is invalid.");
    const read = await this.trackReader.approvals({ from, agency, kind, cursor });
    const cards = await this.#trackCards(user, read.rows);
    const rows = read.rows.flatMap((row) => {
      const item = cards.get(row.rowId);
      if (!item || item.state?.hidden) return [];
      return [{ item, at: row.at, approval: row.facts.approval, approvalLabel: FRONTIER_APPROVAL_KIND_LABELS_ZH[/** @type {keyof typeof FRONTIER_APPROVAL_KIND_LABELS_ZH} */ (row.facts.approval)],
        agency: row.facts.agency, drug: row.facts.drug.text, indication: row.facts.indication?.text ?? null, date: row.facts.date ?? null }];
    });
    const listId = await this.#serve(user, "track", `track:approvals:${agency || "all"}`, rows.map((row) => ({ item: row.item.id, slot: null, score: row.item.score })));
    return { items: rows, nextCursor: read.next, from: read.from,
      agencies: read.agencies.map((entry) => ({ ...entry, regionLabel: FRONTIER_AGENCY_REGIONS.find((region) => region.key === entry.region)?.label ?? "其他" })),
      ytd: read.ytd, listId };
  }

  /**
   * 指南 (`GET /api/frontier/track/guidelines?specialty&cursor`): the guideline records newest first, each with the card and up to
   * five key recommendations with their grade, and the specialties they carry.
   * @param {{ id: string }} user @param {URLSearchParams} params
   */
  async trackGuidelines(user, params) {
    const specialty = params.get("specialty");
    if (specialty && !Object.hasOwn(this.vocabulary.specialties, specialty)) throw failure(400, "frontier_query_invalid", "The specialty parameter is invalid.");
    const cursor = params.get("cursor");
    if (cursor && cursor.length > 200) throw failure(400, "frontier_cursor_invalid", "The cursor is invalid.");
    const read = await this.trackReader.guidelines({ specialty, cursor });
    const cards = await this.#trackCards(user, read.rows);
    const rows = read.rows.flatMap((row) => {
      const item = cards.get(row.rowId);
      if (!item || item.state?.hidden) return [];
      return [{ item, at: row.at, body: row.facts.body?.text ?? null, scope: row.facts.scope?.text ?? null,
        recommendations: row.facts.recommendations.map((/** @type {any} */ entry) => ({ text: entry.text, grade: entry.grade })) }];
    });
    const listId = await this.#serve(user, "track", `track:guidelines:${specialty || "all"}`, rows.map((row) => ({ item: row.item.id, slot: null, score: row.item.score })));
    return { items: rows, nextCursor: read.next, listId,
      specialties: read.specialties.filter((entry) => Object.hasOwn(this.vocabulary.specialties, entry.key)).map((entry) => ({ key: entry.key, label: this.vocabulary.specialties[entry.key], count: entry.count })) };
  }

  /**
   * 会议 (`GET /api/frontier/track/congresses`): the congresses on now, coming in the next 60 days and ended within the last 30,
   * each with its dates, city, specialty, status and the count of its items.
   */
  async trackCongresses() {
    const congresses = await this.trackReader.congresses();
    return { congresses: congresses.map((congress) => ({ ...congress,
      specialtyLabel: congress.specialty && Object.hasOwn(this.vocabulary.specialties, congress.specialty) ? this.vocabulary.specialties[congress.specialty] : null })) };
  }

  /**
   * One congress's hub (`GET /api/frontier/track/congresses/:id`): its days, newest first, each with its recap (its references
   * resolved to items) and its items as the feed's cards, the selected ones first, a conference result with its design caveat.
   * `listId` names what was served (surface `congress`). 404 `frontier_congress_not_found` for an id the calendar does not have.
   * @param {{ id: string }} user @param {string} id
   */
  async trackCongress(user, id) {
    if (!/^[a-z0-9-]{3,80}$/.test(String(id ?? ""))) throw failure(404, "frontier_congress_not_found", "No such congress.");
    const read = await this.trackReader.congress(id);
    if (!read) throw failure(404, "frontier_congress_not_found", "No such congress.");
    const cards = await this.#trackCards(user, read.days.flatMap((day) => day.items));
    const refIds = [...new Set(read.days.flatMap((day) => (day.recap?.refs ?? []).map((/** @type {any} */ ref) => String(ref.itemId))).filter((refId) => PUBLIC_ID.test(refId)))];
    const titles = new Map(refIds.length ? (await this.database.query(`SELECT i.public_id, coalesce(nullif(i.title_zh, ''), i.title_raw) AS title, s.name AS source_name
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
      WHERE i.public_id = ANY($1::text[]) AND i.state = 'published'`, [refIds])).rows.map((/** @type {any} */ row) => [row.public_id, row]) : []);
    const days = read.days.map((day) => ({
      day: day.day,
      recap: day.recap ? { text: day.recap.text, at: day.recap.at,
        refs: day.recap.refs.flatMap((/** @type {any} */ ref) => {
          const found = titles.get(String(ref.itemId));
          return found ? [{ n: Number(ref.n), itemId: String(ref.itemId), title: String(found.title ?? ""), sourceName: String(found.source_name ?? "") }] : [];
        }) } : null,
      items: day.items.flatMap((entry) => {
        const item = cards.get(entry.rowId);
        return item && !item.state?.hidden ? [{ item, caveat: entry.caveat }] : [];
      }),
    }));
    const served = days.flatMap((day) => day.items.map((entry) => ({ item: entry.item.id, slot: null, score: entry.item.score })));
    const listId = await this.#serve(user, "congress", `congress:${read.congress.id}`, served);
    return { congress: { ...read.congress,
      specialtyLabel: read.congress.specialty && Object.hasOwn(this.vocabulary.specialties, read.congress.specialty) ? this.vocabulary.specialties[read.congress.specialty] : null },
    itemCount: days.reduce((sum, day) => sum + day.items.length, 0), days, listId };
  }

  /** Persist only the exact visible versions acknowledged by the reader; newer reports remain unseen.
   * @param {{id: string}} user @param {string} eventId @param {any} mark
   */
  async markEventRead(user, eventId, mark) {
    if (!mark || typeof mark !== 'object' || Array.isArray(mark) || Object.keys(mark).length > 256) throw failure(400, 'frontier_payload_invalid', 'Invalid reading mark.');
    const read = await this.events?.read(eventId);
    if (!read || 'redirect' in read) throw failure(404, 'frontier_event_not_found', 'No such event.');
    const current = frontierEventChanges(read.members, null).mark;
    const accepted = Object.fromEntries(Object.entries(mark).filter(([id, hash]) => current[id] && current[id] === hash));
    await this.database.query(`INSERT INTO evimed_frontier.event_reads (user_id, event_id, report_marks) VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (user_id, event_id) DO UPDATE SET report_marks = EXCLUDED.report_marks, read_at = clock_timestamp()`, [user.id, eventId, JSON.stringify(accepted)]);
    return { read: true };
  }

  /** The daily archive, newest first. @param {URLSearchParams} params */
  async dailies(params) {
    if (!this.daily) throw failure(404, "not_found", "Frontier route not found.");
    const value = params.get("limit");
    const limit = value == null || value === "" ? 30 : Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) throw failure(400, "frontier_query_invalid", "The limit parameter is invalid.");
    // The schedule rides with the archive so the page can say when the next issue comes, in whose clock, without a copy of the setting.
    const day = params.get("day");
    if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))
      || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)) throw failure(400, "frontier_query_invalid", "Invalid daily date.");
    return { dailies: await this.daily.list(limit), schedule: { time: this.daily.dailyTime, timeZone: this.daily.timeZone },
      publication: this.daily.publicationStatus ? await this.daily.publicationStatus(day) : null };
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
  async dailyIssue(user, day) { return this.issue(user, day); }

  /** @param {URLSearchParams} params */
  async weeklies(params) {
    if (!this.weekly) throw failure(404, "not_found", "Frontier route not found.");
    const limit = Number(params.get("limit") || 30);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) throw failure(400, "frontier_query_invalid", "Invalid issue limit.");
    return { weeklies: await this.weekly.list(limit) };
  }
  /** @param {{id:string}} user @param {string} week */
  async weeklyIssue(user, week) { return this.issue(user, week, true); }

  /** The monthly archive, newest first (2026-10-22). @param {URLSearchParams} params */
  async monthlies(params) {
    if (!this.monthly) throw failure(404, "not_found", "Frontier route not found.");
    const limit = Number(params.get("limit") || 24);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) throw failure(400, "frontier_query_invalid", "Invalid issue limit.");
    return { monthlies: await this.monthly.list(limit) };
  }

  /**
   * One month's issue (frontierMonthly.mjs): its overview and section introductions as written, its items read now — a
   * withdrawn or hidden one leaves — and the Markdown rendered again from what the page shows.
   * @param {{ id: string }} user @param {string} month
   */
  async monthlyIssue(user, month) {
    if (!this.monthly) throw failure(404, "not_found", "Frontier route not found.");
    const issue = await this.monthly.read(month);
    if (!issue) throw failure(404, "frontier_monthly_not_found", "No issue for that month.");
    const sections = issue.sections.map((/** @type {any} */ section) => ({ lane: String(section?.lane ?? ""), intro: typeof section?.intro === "string" ? section.intro : null,
      ids: Array.isArray(section?.itemIds) ? section.itemIds.map(String) : [] }));
    const items = await this.hydrate(user, { publicIds: [...new Set(sections.flatMap((section) => section.ids))] });
    const muted = await this.subscriptions.mutedPublicIds(user.id, [...items.keys()]);
    for (const [id, item] of items) if (muted.has(id) || item.state.hidden) items.delete(id);
    const shown = sections.map((section) => ({ lane: section.lane, laneLabel: this.vocabulary.lanes[section.lane] ?? section.lane, intro: section.intro,
      items: section.ids.flatMap((id) => (items.has(id) ? [items.get(id)] : [])) })).filter((section) => section.items.length);
    const leadItem = issue.lead?.itemId ? items.get(String(issue.lead.itemId)) ?? null : null;
    const markdown = frontierMonthlyMarkdown({ month: issue.month, overview: issue.overview, sections: shown.map((section) => ({ lane: section.lane,
      intro: section.intro, rows: section.items.map((/** @type {any} */ item) => ({ title_zh: item.titleZh, title_raw: item.titleRaw, summary_zh: item.summary,
        source_name: item.source.name, canonical_url: item.url })) })) });
    const all = shown.flatMap((section) => section.items);
    const leadServed = leadItem ? { ...leadItem, slot: "editorial" } : null;
    const sectionsServed = shown.map((section) => ({ ...section, items: section.items.map((/** @type {any} */ item) => ({ ...item, slot: "editorial" })) }));
    const listId = await this.#serve(user, "monthly", "monthly", [leadServed, ...sectionsServed.flatMap((section) => section.items)].filter(Boolean)
      .map((/** @type {any} */ item) => ({ item: item.id, slot: "editorial", score: item.score })));
    return {
      monthly: {
        listId,
        month: issue.month, label: issue.label, windowStart: issue.windowStart, windowEnd: issue.windowEnd, generatedAt: issue.generatedAt,
        overview: issue.overview, lead: leadServed ? { item: leadServed } : null, sections: sectionsServed, markdown,
        itemCount: new Set(all.map((item) => item.id)).size,
        readingMinutes: frontierReadingMinutes([issue.overview, ...shown.map((section) => section.intro), ...all.flatMap((item) => [item.title, item.summary])]),
        previousMonth: issue.previousMonth, nextMonth: issue.nextMonth,
      },
    };
  }

  /** @param {{id:string}} user @param {string} day @param {boolean} weekly */
  async issue(user, day, weekly = false) {
    const producer = weekly ? this.weekly : this.daily;
    if (!producer) throw failure(404, "not_found", "Frontier route not found.");
    const issue = await producer.read(day);
    if (!issue) throw failure(404, weekly ? "frontier_weekly_not_found" : "frontier_daily_not_found", "No issue for that date.");
    const sections = issue.sections.map((/** @type {any} */ section) => ({ lane: String(section?.lane ?? ""), ids: Array.isArray(section?.itemIds) ? section.itemIds.map(String) : [] }));
    const ids = [issue.lead?.itemId, ...issue.safety, ...sections.flatMap((section) => section.ids)].filter((id) => typeof id === "string");
    const items = await this.hydrate(user, { publicIds: [...new Set(ids)] });
    if (weekly) {
      const muted = await this.subscriptions.mutedPublicIds(user.id, [...items.keys()]);
      for (const [id, item] of items) if (muted.has(id) || item.state.hidden || !["passed", "repaired"].includes(item.verification)) items.delete(id);
    }
    const leadItem = issue.lead?.itemId ? items.get(String(issue.lead.itemId)) : null;
    const leadText = weekly ? leadItem?.summary ?? null : typeof issue.lead?.text === "string" ? issue.lead.text : null;
    const shownSections = sections.map((section) => ({ lane: section.lane, laneLabel: this.vocabulary.lanes[section.lane] ?? section.lane,
      items: section.ids.flatMap((id) => (items.has(id) ? [items.get(id)] : [])) })).filter((section) => section.items.length);
    const safety = issue.safety.flatMap((/** @type {unknown} */ id) => (items.has(String(id)) ? [items.get(String(id))] : []));
    const shown = [leadItem, ...safety, ...shownSections.flatMap((section) => section.items)].filter(Boolean);
    const line = (/** @type {any} */ item) => ({ id: item.id, title_zh: item.titleZh, title_raw: item.titleRaw, summary_zh: item.summary,
      source_name: item.source.name, canonical_url: item.url });
    const markdownInput = {
      day: issue.day, window: { start: new Date(issue.windowStart), end: new Date(issue.windowEnd) },
      timeZone: producer.timeZone || this.config.frontierTimeZone || "Asia/Shanghai",
      lead: leadItem ? line(leadItem) : null, leadText, safety: safety.map(line),
      sections: shownSections.map((section) => ({ lane: section.lane, rows: section.items.map(line) })), aiMinute: issue.aiMinute,
    };
    const markdown = weekly ? frontierWeeklyMarkdown({ ...markdownInput, weekStart: issue.weekStart }) : frontierDailyMarkdown(markdownInput);
    // As served, in the order the issue shows them: the lead, the safety alerts (must-see), then the sections (the editor's).
    const leadServed = leadItem ? { ...leadItem, slot: "editorial" } : null;
    const safetyServed = safety.map((/** @type {any} */ item) => ({ ...item, slot: "must-see" }));
    const sectionsServed = shownSections.map((section) => ({ ...section, items: section.items.map((/** @type {any} */ item) => ({ ...item, slot: "editorial" })) }));
    const listId = await this.#serve(user, weekly ? "weekly" : "daily", weekly ? "weekly" : "daily",
      [leadServed, ...safetyServed, ...sectionsServed.flatMap((section) => section.items)].filter(Boolean)
        .map((/** @type {any} */ item) => ({ item: item.id, slot: item.slot, score: item.score })));
    return {
      [weekly ? "weekly" : "daily"]: {
        ...(weekly ? { weekStart: issue.weekStart, weekEnd: issue.weekEnd, previousWeek: issue.previousDay, nextWeek: issue.nextDay } : {}),
        day: issue.day, windowStart: issue.windowStart, windowEnd: issue.windowEnd, generatedAt: issue.generatedAt, listId,
        lead: leadServed ? {
          item: leadServed, text: leadText,
          event: issue.lead.eventId ? { id: String(issue.lead.eventId), title: String(issue.lead.eventTitle ?? leadItem.title) } : null,
        } : null,
        sections: sectionsServed,
        safety: safetyServed,
        // The one part of an issue that is the reader's own (flywheel F10): the cards of the zones they follow that
        // were published or changed in this issue's window. Read now, never part of the issue's text or Markdown.
        followedZones: typeof producer.followedZones === "function" ? await producer.followedZones(user.id, issue).catch(() => []) : [],
        // Likewise theirs alone (c3-watch): the things they typed to follow that have news, each a link to its feed.
        followedQueries: weekly ? [] : await this.#queryFollowsWithNews(user.id),
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
    // Contract 1.4.0: today's (UTC) use against each host's daily cap. A spent cap is the plugin's own refusal until 00:00 UTC, which
    // counts against no source's health, so these two are where it shows (review 2026-10-10, D-10); `FrontierHostBudgetNearCap`
    // reads their ratio. A plugin that does not report the table has no series.
    if (pluginHealth.hostBudget) {
      const hosts = Object.entries(pluginHealth.hostBudget);
      add("plugin_host_budget_used", "Requests the plugin has made today (UTC) to each host that has a daily cap, as it counts them.", "gauge",
        hosts.map(([host, row]) => ({ labels: { host }, value: Number(row.used) })));
      add("plugin_host_budget_cap", "Each host's daily request cap in the plugin.", "gauge",
        hosts.map(([host, row]) => ({ labels: { host }, value: Number(row.cap) })));
    }
    // Reserved: the plugin has no model client (a drifted list page is recovered by its vetted selector fallbacks, not by a proposal), so
    // this is always 0 and nothing alerts on it (review 2026-10-10, D-12). The gauge stays so a dashboard that draws it does not break;
    // a plugin that does not report it has no series.
    if (Number.isFinite(pluginHealth.modelCalls24h)) {
      add("plugin_model_calls_24h", "Model calls the knowledge plugin made in the last 24 hours: reserved, always 0 until the plugin has a model client.", "gauge",
        [{ value: Number(pluginHealth.modelCalls24h) }]);
    }
  }
  add("cursor_gaps_total", "Times the cursor fell behind what the plugin still holds.", "counter", [{ value: plugin.gaps.count }]);
  add("cursor_gap_entries_total", "Entries skipped because the plugin had purged them before they were pulled.", "counter", [{ value: plugin.gaps.entries }]);
  add("cursor_rewinds_total", "Times the cursor was found ahead of the plugin's latest seq (its database was restored) and was rewound to the start of its stream.", "counter",
    [{ value: plugin.rewinds?.count ?? 0 }]);
  add("ingest_entries_total", "Entries received from the plugin by what became of them.", "counter", [
    { labels: { outcome: "inserted" }, value: plugin.counters.inserted },
    { labels: { outcome: "duplicate" }, value: plugin.counters.duplicates },
    { labels: { outcome: "dropped" }, value: plugin.counters.dropped },
    { labels: { outcome: "invalid" }, value: plugin.counters.invalid },
  ]);
  add("page_shrinks_total", "Times a stream page was over the client's response cap and was asked for again with half the page limit.", "counter",
    [{ value: plugin.counters.pageShrinks ?? 0 }]);
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
  // ct-mix 2026-10-24: the lead triggers' searches by trigger, what the plugin answered for the pages handed over, failures by code.
  const leads = worker.leads;
  if (leads?.counters) {
    add("lead_searches_total", "Lead-trigger web searches made, by trigger.", "counter",
      Object.entries(leads.counters.searches ?? {}).map(([trigger, value]) => ({ labels: { trigger }, value: Number(value) })));
    add("lead_pages_total", "Pages lead searches found that the feed did not have, by what the plugin answered (unsent: it did not answer).", "counter",
      Object.entries(leads.counters.plugin ?? {}).map(([outcome, value]) => ({ labels: { outcome }, value: Number(value) })));
    add("lead_failures_total", "Lead searches and hand-overs that failed, by code.", "counter",
      Object.entries(leads.counters.failures ?? {}).map(([code, value]) => ({ labels: { code }, value: Number(value) })));
    add("lead_held_total", "Lead search results not handed over, by why (stale, refused-host, social-network, own-site, not-chinese).", "counter",
      Object.entries(leads.counters.held ?? {}).map(([reason, value]) => ({ labels: { reason }, value: Number(value) })));
  }
  // c3-track 2026-10-25: 追踪 — records written by kind, fields dropped by reason, congress recaps by outcome.
  const track = worker.track;
  if (track?.counters) {
    add("track_total", "What the tracker step did since this process started: items asked, records written by kind, calls that failed.", "counter",
      ["asked", "approvals", "guidelines", "none", "failed"].map((kind) => ({ labels: { kind }, value: Number(track.counters[kind] ?? 0) })));
    add("track_dropped_total", "Tracker fields refused by the quotation and number checks, by field and reason.", "counter",
      Object.entries(track.counters.droppedFields ?? {}).map(([name, value]) => ({ labels: { field: name.split(":")[0], reason: name.split(":")[1] ?? "" }, value: Number(value) })));
    add("track_recaps_total", "Congress daily recaps by outcome (asked, written, empty, dropped, failed).", "counter",
      ["recapsAsked", "recapsWritten", "recapsEmpty", "recapsDropped", "recapsFailed"].map((kind) => ({ labels: { outcome: kind.slice(6).toLowerCase() }, value: Number(track.counters[kind] ?? 0) })));
  }
  // c2-leads 2026-10-25: the hot-event topics — rounds and candidates, accepted by field, refused by reason, items joined, overviews.
  const topics = worker.topics;
  if (topics?.counters) {
    add("topics_total", "What the outside-event trigger did since this process started.", "counter",
      ["rounds", "candidates", "groups", "surges", "resighted", "writeDropped", "quotaFull", "closed", "snapshots"]
        .map((kind) => ({ labels: { kind }, value: Number(topics.counters[kind] ?? 0) })));
    add("topics_accepted_total", "Hot-event topics made, by field.", "counter",
      Object.entries(topics.counters.accepted ?? {}).map(([domain, value]) => ({ labels: { domain }, value: Number(value) })));
    add("topics_refused_total", "Hot-event groups not made a topic, by reason (not_medical, private_health, low_confidence).", "counter",
      Object.entries(topics.counters.refused ?? {}).map(([reason, value]) => ({ labels: { reason }, value: Number(value) })));
    add("topics_joined_total", "Items joined to a topic, by how (lead, corpus).", "counter",
      Object.entries(topics.counters.joined ?? {}).map(([via, value]) => ({ labels: { via }, value: Number(value) })));
    add("topics_overviews_total", "Topic overviews by outcome (written, empty, dropped, failed).", "counter",
      Object.entries(topics.counters.overviews ?? {}).map(([outcome, value]) => ({ labels: { outcome }, value: Number(value) })));
  }
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
    // Why, for the two Chinese texts: the closed kinds of `FRONTIER_PROSE_ISSUE_KINDS`.
    // `first_pass` is every first answer that failed a check; `final` is the answer
    // an item was left title-only on — the alert on title-only is about that one.
    /** @param {Record<string, Record<string, number>> | undefined} table */
    const issueRows = (table) => Object.entries(table ?? {}).flatMap(([field, kinds]) =>
      Object.entries(kinds).map(([kind, value]) => ({ labels: { field, kind }, value: Number(value) })));
    add("edit_first_pass_issues_total", "First answers that failed a check on the title or the summary, by field and kind (empty, length, link, language, number; an answer counts once per kind).", "counter",
      issueRows(editor.counters.firstPassIssues));
    add("edit_final_issues_total", "Answers an item was left title-only on, by the field and kind the title or the summary failed (an answer counts once per kind).", "counter",
      issueRows(editor.counters.finalIssues));
    add("edit_summary_trimmed_total", "Edits published repaired with the whole sentences of a summary that fit its limit, because the length was the only fault left.", "counter",
      [{ value: Number(editor.counters.summaryTrimmed ?? 0) }]);
    // The reader's parts (2026-10-22): a 推荐理由 dropped by its own checks (by kind) or left empty by the answer, the full-text
    // translation's calls and paragraphs, and edits a served policy older than the answer's keys would have written.
    add("edit_reason_total", "Published edits whose 推荐理由 was dropped by its checks (by kind) or that the answer left empty.", "counter", [
      ...Object.entries(editor.counters.reasonDropped ?? {}).map(([kind, value]) => ({ labels: { outcome: `dropped-${kind}` }, value: Number(value) })),
      { labels: { outcome: "empty" }, value: Number(editor.counters.reasonEmpty ?? 0) },
    ]);
    add("translate_total", "The reader's full-text translation: calls, calls that could not be made, paragraphs verified and paragraphs left in the original.", "counter", [
      { labels: { kind: "call" }, value: Number(editor.counters.translateCalls ?? 0) },
      { labels: { kind: "call-failure" }, value: Number(editor.counters.translateFailures ?? 0) },
      { labels: { kind: "paragraph" }, value: Number(editor.counters.translatedParagraphs ?? 0) },
      { labels: { kind: "paragraph-refused" }, value: Number(editor.counters.translateRejectedParagraphs ?? 0) },
    ]);
    add("edit_outdated_policy_total", "Edits written with the shipped instructions because the served policy did not ask for every answer key.", "counter",
      [{ value: Number(editor.counters.outdatedPolicies ?? 0) }]);
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
    for (const name of ["weekly", "monthly", "notifications"]) {
      const component = composer[name];
      add(`${name}_available`, "Whether frontier background delivery is composed and available.", "gauge", [{ value: component?.available ? 1 : 0 }]);
      add(`${name}_total`, "Frontier background outcomes since this process started.", "counter",
        Object.entries(component?.counters ?? {}).map(([outcome, value]) => ({ labels: { outcome }, value: Number(value) })));
    }
    // 07:45 without an issue (plan §10.5.8): the alert reads this gauge.
    add("daily_missing", "Whether today's daily issue is missing past its alert time (1 = missing).", "gauge", [{ value: daily.missing ? 1 : 0 }]);
    add("daily_last_generated_timestamp_seconds", "When the latest daily issue was written (0 = none in this process's view).", "gauge",
      [{ value: seconds(daily.lastGeneratedAt ?? null) }]);
    add("daily_total", "Daily issues by outcome since this process started.", "counter", [
      { labels: { outcome: "issued" }, value: Number(daily.counters?.issues ?? 0) },
      { labels: { outcome: "empty" }, value: Number(daily.counters?.empty ?? 0) },
      { labels: { outcome: "failed" }, value: Number(daily.counters?.failures ?? 0) },
      { labels: { outcome: "rearmed" }, value: Number(daily.counters?.rearmed ?? 0) },
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
        "deferred", "hotRuns", "hotChanges", "digestsWritten", "digestsDropped",
        // fr-events 2026-10-22: the grouping calls, their second looks, the relations they found, the links and the gate.
        "groupCalls", "secondLooks", "secondLooksAgreed", "sameOccurrence", "sameStory", "followsLinks", "sameEventUnselected", "lexicalRecalls",
        "regrouped",
        // c3-cluster 2026-10-25: the re-clustering sweep.
        "reclusterRuns", "reclusterAnchors", "reclusterPairs", "reclusterSame", "reclusterRelated", "reclusterDifferent", "reclusterUnjudged",
        "reclusterSecondLooks", "reclusterSecondAgreed", "reclusterMerged", "reclusterLinks", "reclusterPicksUnselected", "reclusterVetoed",
        "reclusterStale", "reclusterStopped", "reclusterFailures"].map((kind) => ({ labels: { kind }, value: Number(events[kind] ?? 0) })));
    const profiles = composer.profiles ?? null;
    add("personalization_state", "「与你相关」 as /status reports it (1 = current).", "gauge",
      ["available", "unavailable", "off"].map((state) => ({ labels: { state }, value: (profiles?.state ?? "off") === state ? 1 : 0 })));
    if (profiles) {
      add("profiles_total", "Profile refreshes, rankings, reasons dropped because their memory was gone, profiles marked due by a change, and candidates dropped as near a hidden item.", "counter",
        ["refreshed", "empty", "paused", "failures", "ranked", "embedded", "embedFailures", "reasonsDropped", "staleMarks", "staleMarkFailures",
          "visitFailures", "questionFailures", "hiddenDropped", "demotionFailures", "demotedRanks"]
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
