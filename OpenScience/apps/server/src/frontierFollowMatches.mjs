/**
 * Typed follows at work (c3-watch, 2026-10-25): a reader's words read into a query (`frontierFollowQuery.mjs`), the published items
 * that match it, how many are new, and what the day's notice may say about them.
 *
 * Hidden knowledge:
 *
 * - **Three legs, cheapest first, and the dearest only when the cheap ones have nothing to hold.** An item matches a concept by an
 *   entity key it carries (the glossary's, language-independent), or by the words of one of the concept's names in its search vector
 *   (title, 导读, entities, tags — not the body). A query of several concepts needs them together (`followMatchPredicate`). Only a
 *   query with no key at all — a question in the reader's words, a subject the glossary has never heard of — also takes the items
 *   whose embedding is near the typed words (cosine at or above `OPEN_SCIENCE_FRONTIER_FOLLOW_MIN_COSINE`); a keyed query is not
 *   widened by it, because the keys are the precision.
 * - **A match is made once and kept.** `follow_matches (follow_id, item_id)` is written by `INSERT … ON CONFLICT DO NOTHING`, so a
 *   scan can be repeated, overlapped and run by two processes at once. A follow's `matched_through` is how far the items have been
 *   looked at; a scan starts ten minutes before it (an item's keys and words can land a little after it is published). A new follow
 *   is scanned back seven days at once, so it is never empty when there is something to show.
 * - **New is the item's own publication time against the follow's `seen_at` (its `created_at` until it is first opened).** It does
 *   not depend on when a scan found the item. Every kind of follow is counted the same way, through the same predicate its feed is
 *   listed by, so the number is what the feed will show.
 * - **A notice claims what it tells, then tells it.** `claimNotice` marks the matches a daily notice will name (`notified_at`) in
 *   one statement and `releaseNotice` gives them back if the notice could not be made: an item is named at most once, and a notice
 *   that failed does not use it up. Only matches published since the reader last opened that follow, and within three days, are
 *   named.
 *
 * @module frontierFollowMatches
 */

import { followNamesTsquery, parseFollowQuery } from "./frontierFollowQuery.mjs";
import { migrateFrontier } from "./frontierPersistence.mjs";
import { decodeVector, encodeVector } from "./frontierProfiles.mjs";
import { frontierFollowPredicate } from "./frontierSubscriptions.mjs";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** How far back a new typed follow is scanned. */
export const FRONTIER_FOLLOW_BACKFILL_MS = 7 * DAY;
/** A scan starts this long before the follow's `matched_through`. */
export const FRONTIER_FOLLOW_OVERLAP_MS = 10 * MINUTE;
/** A follow whose scan is older than this is due. */
export const FRONTIER_FOLLOW_SWEEP_DUE_MS = MINUTE;
/** Typed follows scanned in one sweep. */
export const FRONTIER_FOLLOW_SWEEP_BATCH = 40;
/** The most matches one scan of one follow writes: a query that matches everything is a bad reading, not a feed. */
export const FRONTIER_FOLLOW_SCAN_LIMIT = 300;
/** The model reads at most this many new typed follows an account makes in an hour; later ones are stored with their words. */
export const FRONTIER_FOLLOW_PARSE_PER_HOUR = 20;
/** The count shown for a follow stops here (「99+」). */
export const FRONTIER_FOLLOW_COUNT_CAP = 99;
/** A notice names matches published in the last three days. */
export const FRONTIER_FOLLOW_NOTICE_WINDOW_MS = 3 * DAY;
/** The follow lines one notice carries; the rest are one 「另有 N 个关注」 line. */
export const FRONTIER_FOLLOW_NOTICE_LINES = 3;
/**
 * The starting cosine for the embedding leg. Not measured on the production embedder (the box that built it holds no embedding
 * key); it sits above the 与我相关 floor (`FRONTIER_FOR_YOU_MIN_COSINE`, 0.4) because a watch is read for what is new and a wrong
 * hit costs a repeat reader, a missed one costs nothing the lexical legs did not already catch. Calibrate with
 * `scripts/ops/frontier-follow-cosines.mjs` against the live index before moving it.
 */
export const FRONTIER_FOLLOW_MIN_COSINE_DEFAULT = 0.55;

/** @param {unknown} error */
function codeOf(error) {
  const value = /** @type {any} */ (error);
  return typeof value?.code === "string" && /^[a-z0-9_]{2,80}$/.test(value.code) ? value.code : "frontier_follow_failed";
}

/**
 * The SQL that holds for an item (`i`) a query matches by its keys and words, or null when the query has nothing to look up. One
 * concept: it. Two: both. Three or more: the first and one of the others.
 * @param {any} query @param {(value: unknown) => string} param
 * @returns {string | null}
 */
export function followMatchPredicate(query, param) {
  /** @type {string[]} */
  const parts = [];
  for (const concept of Array.isArray(query?.concepts) ? query.concepts : []) {
    /** @type {string[]} */
    const legs = [];
    const keys = (Array.isArray(concept?.keys) ? concept.keys : []).filter((/** @type {unknown} */ key) => typeof key === "string");
    const entity = keys.filter((/** @type {string} */ key) => !/^(reg|doi|pmid):/.test(key));
    if (entity.length) legs.push(`i.entity_keys && ${param(entity)}::text[]`);
    const registry = keys.filter((/** @type {string} */ key) => key.startsWith("reg:")).map((/** @type {string} */ key) => key.slice(4).toUpperCase());
    if (registry.length) legs.push(`i.registry_ids && ${param(registry)}::text[]`);
    const dois = keys.filter((/** @type {string} */ key) => key.startsWith("doi:")).map((/** @type {string} */ key) => key.slice(4).toLowerCase());
    if (dois.length) legs.push(`lower(i.doi) = ANY(${param(dois)}::text[])`);
    const pmids = keys.filter((/** @type {string} */ key) => key.startsWith("pmid:")).map((/** @type {string} */ key) => key.slice(5));
    if (pmids.length) legs.push(`i.pmid = ANY(${param(pmids)}::text[])`);
    const tsquery = followNamesTsquery([...(concept?.terms_zh ?? []), ...(concept?.terms_en ?? [])]);
    if (tsquery) legs.push(`i.lexemes @@ ${param(tsquery)}::tsquery`);
    if (legs.length) parts.push(`(${legs.join(" OR ")})`);
  }
  if (!parts.length) return null;
  return parts.length <= 2 ? parts.join(" AND ") : `${parts[0]} AND (${parts.slice(1).join(" OR ")})`;
}

/** Whether a query has no key to hold it, the one case the embedding leg is added. @param {any} query */
export function followQueryIsThin(query) {
  return (Array.isArray(query?.concepts) ? query.concepts : []).every((/** @type {any} */ concept) => !(concept?.keys?.length));
}

/** The line of a daily notice about one follow. @param {string} label @param {number} count */
export function followNoticeLine(label, count) {
  return `你关注的“${label}”有 ${count} 条新动态`;
}

/**
 * The lines a notice carries for the follows with news: one per follow, the busiest first, at most `FRONTIER_FOLLOW_NOTICE_LINES`, and
 * one line for the rest.
 * @param {Array<{ label: string, count: number }>} news
 */
export function followNoticeLines(news) {
  const ordered = [...news].filter((entry) => entry.count > 0).sort((left, right) => right.count - left.count);
  const lines = ordered.slice(0, FRONTIER_FOLLOW_NOTICE_LINES).map((entry) => followNoticeLine(entry.label, entry.count));
  if (ordered.length > FRONTIER_FOLLOW_NOTICE_LINES) lines.push(`另有 ${ordered.length - FRONTIER_FOLLOW_NOTICE_LINES} 个关注有新动态`);
  return lines;
}

export class FrontierFollowWatch {
  /**
   * @param {{ database: any, editor?: any, embedder?: any, glossary?: { current: () => Promise<any> } | null, budget?: (() => Promise<{ state: string }>) | null,
   *   config?: Record<string, any>, now?: () => Date, dimension?: number }} options
   *   `editor` a `FrontierEditor` (`available`, `callJson`); `glossary` the shared glossary store; `budget` the module's.
   */
  constructor({ database, editor = null, embedder = null, glossary = null, budget = null, config = {}, now = () => new Date(), dimension }) {
    this.database = database;
    this.editor = editor;
    this.embedder = embedder;
    this.glossary = glossary;
    this.budget = budget;
    this.config = config;
    this.now = now;
    this.dimension = Number(dimension) || Number(config.kbEmbeddingDimension) || Number(embedder?.dimension) || 1024;
    const cosine = Number(config.frontierFollowMinCosine);
    this.minCosine = Number.isFinite(cosine) && cosine >= 0.3 && cosine <= 0.95 ? cosine : FRONTIER_FOLLOW_MIN_COSINE_DEFAULT;
    /** Parses by the model an account made lately. @type {Map<string, number[]>} */
    this.parses = new Map();
    this.counters = { parsed: 0, parsedByModel: 0, parseFallbacks: 0, parseRateLimited: 0, scans: 0, matched: 0, vectorMatched: 0, failures: 0,
      claimed: 0, released: 0, embedFailures: 0 };
    /** @type {string | null} */
    this.lastError = null;
  }

  async ready() { return migrateFrontier(this.database, { dimension: this.dimension }); }

  /** @param {string} userId */
  #withinRate(userId) {
    const now = this.now().getTime();
    const recent = (this.parses.get(userId) ?? []).filter((at) => now - at < 60 * MINUTE);
    this.parses.set(userId, recent);
    if (recent.length >= FRONTIER_FOLLOW_PARSE_PER_HOUR) return false;
    recent.push(now);
    return true;
  }

  async #budgetAllows() {
    if (!this.budget) return true;
    try { return (await this.budget()).state !== "exhausted"; } catch { return false; }
  }

  /**
   * Read what a reader typed: its query, with the typed words' embedding where the query is thin and an embedder runs. Never throws.
   * @param {string} userId @param {string} label
   */
  async parse(userId, label) {
    this.counters.parsed += 1;
    const glossary = await this.glossary?.current?.().catch(() => null) ?? null;
    let callJson = null;
    if (this.editor?.available && await this.#budgetAllows()) {
      if (this.#withinRate(userId)) callJson = (/** @type {any} */ messages, /** @type {any} */ limits) => this.editor.callJson(messages, limits);
      else this.counters.parseRateLimited += 1;
    }
    const { query, model, error } = await parseFollowQuery({ label, glossary, callJson });
    if (model) this.counters.parsedByModel += 1;
    else this.counters.parseFallbacks += 1;
    if (error) this.lastError = error;
    let stored = /** @type {Record<string, any>} */ (query);
    if (followQueryIsThin(query) && this.embedder?.configured) {
      try {
        const names = query.concepts.flatMap((/** @type {any} */ concept) => [...concept.terms_zh, ...concept.terms_en]).slice(0, 6);
        const vector = await this.embedder.embedQuery([label, ...names].join(" ").slice(0, 300));
        if (Array.isArray(vector) && vector.length === this.dimension && vector.every(Number.isFinite)) {
          stored = { ...query, vector: encodeVector(vector), vector_model: String(this.embedder.modelKey) };
        }
      } catch (failure) {
        this.counters.embedFailures += 1;
        this.lastError = codeOf(failure);
      }
    }
    return { query: stored, model, error };
  }

  /**
   * Match the published items that became visible in [since, until) with one typed follow and keep the matches that are new.
   * @param {{ id: string | number, userId: string, query: any }} follow @param {{ since: Date, until: Date }} window
   * @returns {Promise<{ matched: number }>}
   */
  async scan(follow, { since, until }) {
    const capabilities = await this.ready();
    const values = /** @type {any[]} */ ([follow.id, since.toISOString(), until.toISOString()]);
    const param = (/** @type {unknown} */ value) => { values.push(value); return `$${values.length}`; };
    const predicate = followMatchPredicate(follow.query, param);
    let matched = 0;
    if (predicate) {
      const limit = param(FRONTIER_FOLLOW_SCAN_LIMIT);
      const result = await this.database.query(`INSERT INTO evimed_frontier.follow_matches (follow_id, item_id, score)
        SELECT $1::bigint, i.id, 1.0 FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
        WHERE i.state = 'published' AND s.enabled AND i.visible_at >= $2::timestamptz AND i.visible_at < $3::timestamptz AND (${predicate})
        ORDER BY i.visible_at DESC LIMIT ${limit}
        ON CONFLICT (follow_id, item_id) DO NOTHING`, values);
      matched += result.rowCount ?? 0;
    }
    const vector = typeof follow.query?.vector === "string" ? decodeVector(follow.query.vector, this.dimension) : null;
    if (vector && capabilities.vector && this.embedder?.configured && follow.query.vector_model === String(this.embedder.modelKey) && followQueryIsThin(follow.query)) {
      const type = capabilities.halfvec ? "halfvec" : "vector";
      const result = await this.database.query(`INSERT INTO evimed_frontier.follow_matches (follow_id, item_id, score)
        SELECT $1::bigint, i.id, 1 - (v.embedding <=> $4::${type}) FROM evimed_frontier.item_vectors v
        JOIN evimed_frontier.items i ON i.id = v.item_id JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
        WHERE v.model_key = $5 AND i.state = 'published' AND s.enabled AND i.visible_at >= $2::timestamptz AND i.visible_at < $3::timestamptz
          AND 1 - (v.embedding <=> $4::${type}) >= $6
        ORDER BY 1 - (v.embedding <=> $4::${type}) DESC LIMIT ${FRONTIER_FOLLOW_SCAN_LIMIT}
        ON CONFLICT (follow_id, item_id) DO NOTHING`,
      [follow.id, since.toISOString(), until.toISOString(), `[${vector.join(",")}]`, String(this.embedder.modelKey), this.minCosine]);
      this.counters.vectorMatched += result.rowCount ?? 0;
      matched += result.rowCount ?? 0;
    }
    this.counters.scans += 1;
    this.counters.matched += matched;
    // The reader's lists answer 304 to the version they were read at: new matches are a change to what this reader sees.
    if (matched > 0) {
      await this.database.query(`INSERT INTO evimed_frontier.user_prefs (user_id, state_version) VALUES ($1, 1)
        ON CONFLICT (user_id) DO UPDATE SET state_version = evimed_frontier.user_prefs.state_version + 1`, [follow.userId]);
    }
    return { matched };
  }

  /**
   * A new follow's backfill: seven days of items, then the follow is looked at up to now. A failure leaves `matched_through` empty
   * and the sweep does it again; the follow stands.
   * @param {{ id: string | number, userId: string, query: any }} follow
   */
  async backfill(follow) {
    const until = this.now();
    try {
      await this.scan(follow, { since: new Date(until.getTime() - FRONTIER_FOLLOW_BACKFILL_MS), until });
      await this.database.query("UPDATE evimed_frontier.user_follows SET matched_through = $2::timestamptz WHERE id = $1", [follow.id, until.toISOString()]);
    } catch (error) {
      this.counters.failures += 1;
      this.lastError = codeOf(error);
    }
  }

  /**
   * The composer's loop: every typed follow whose scan is behind is scanned from a little before where it got to, up to now. Each
   * follow fails alone.
   * @returns {Promise<{ followed: number, matched: number, failed: number }>}
   */
  async sweep() {
    await this.ready();
    const now = this.now();
    const due = (await this.database.query(`SELECT id, user_id, query, matched_through FROM evimed_frontier.user_follows
      WHERE kind = 'query' AND NOT muted AND query IS NOT NULL AND (matched_through IS NULL OR matched_through < $1::timestamptz)
      ORDER BY coalesce(matched_through, 'epoch'::timestamptz), id LIMIT $2`,
    [new Date(now.getTime() - FRONTIER_FOLLOW_SWEEP_DUE_MS).toISOString(), FRONTIER_FOLLOW_SWEEP_BATCH])).rows ?? [];
    let matched = 0;
    let failed = 0;
    for (const follow of due) {
      const through = follow.matched_through ? new Date(follow.matched_through) : null;
      const since = through ? new Date(through.getTime() - FRONTIER_FOLLOW_OVERLAP_MS) : new Date(now.getTime() - FRONTIER_FOLLOW_BACKFILL_MS);
      try {
        matched += (await this.scan({ id: follow.id, userId: follow.user_id, query: follow.query }, { since, until: now })).matched;
        await this.database.query("UPDATE evimed_frontier.user_follows SET matched_through = $2::timestamptz WHERE id = $1", [follow.id, now.toISOString()]);
      } catch (error) {
        failed += 1;
        this.counters.failures += 1;
        this.lastError = codeOf(error);
      }
    }
    return { followed: due.length, matched, failed };
  }

  /**
   * How many published items each follow of a reader has had since they last opened it (its `seen_at`, else its `created_at`),
   * counted through the predicate the follow's feed is listed by, stopping at `FRONTIER_FOLLOW_COUNT_CAP`. A muted follow has none.
   * @param {string} userId
   * @param {Array<{ id: string, kind: string, key: string, label: string, muted: boolean, createdAt: string }>} follows the reader's, as `FrontierSubscriptions#read` gives them
   * @param {Map<string, Date>} since each follow's `seen_at` or `created_at`
   * @returns {Promise<Map<string, number>>}
   */
  async newCounts(userId, follows, since) {
    const muted = follows.filter((follow) => follow.muted);
    const counted = follows.filter((follow) => !follow.muted && since.has(follow.id)).slice(0, 60);
    const entries = await Promise.all(counted.map(async (follow) => {
      const values = /** @type {any[]} */ ([userId, since.get(follow.id)?.toISOString()]);
      const param = (/** @type {unknown} */ value) => { values.push(value); return `$${values.length}`; };
      const own = frontierFollowPredicate(follow, param);
      const mutes = muted.filter((entry) => entry.id !== follow.id).map((entry) => `NOT (${frontierFollowPredicate(entry, param)})`);
      const result = await this.database.query(`SELECT count(*)::integer AS n FROM (
        SELECT 1 FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
        WHERE i.state = 'published' AND s.enabled AND i.visible_at > $2::timestamptz AND (${own})
          AND NOT EXISTS (SELECT 1 FROM evimed_frontier.user_state us WHERE us.user_id = $1 AND us.item_id = i.id AND us.hidden_at IS NOT NULL)
          ${mutes.map((clause) => `AND ${clause}`).join(" ")}
        LIMIT ${FRONTIER_FOLLOW_COUNT_CAP}) c`, values);
      return /** @type {const} */ ([follow.id, Number(result.rows?.[0]?.n ?? 0)]);
    }));
    return new Map(entries);
  }

  /**
   * Take the matches a notice for this reader will name: each typed follow's matches that were published since the reader last
   * opened it, in the last three days, not named before and not hidden by the reader, marked as named in the same statement.
   * @param {string} userId
   * @returns {Promise<{ news: Array<{ followId: string, label: string, count: number }>, claimed: string[] }>}
   */
  async claimNotice(userId) {
    await this.ready();
    const now = this.now();
    const rows = (await this.database.query(`WITH taken AS (
        UPDATE evimed_frontier.follow_matches m SET notified_at = $2::timestamptz
        FROM evimed_frontier.user_follows f, evimed_frontier.items i, evimed_frontier.sources s
        WHERE f.id = m.follow_id AND f.user_id = $1 AND f.kind = 'query' AND NOT f.muted AND m.notified_at IS NULL
          AND i.id = m.item_id AND i.state = 'published' AND s.id = i.primary_source_id AND s.enabled
          AND i.visible_at > coalesce(f.seen_at, f.created_at) AND i.visible_at > $3::timestamptz
          AND NOT EXISTS (SELECT 1 FROM evimed_frontier.user_state us WHERE us.user_id = f.user_id AND us.item_id = i.id AND us.hidden_at IS NOT NULL)
        RETURNING m.follow_id, m.item_id)
      SELECT t.follow_id::text AS follow_id, f.label, count(*)::integer AS n, array_agg(t.item_id::text) AS items
      FROM taken t JOIN evimed_frontier.user_follows f ON f.id = t.follow_id GROUP BY t.follow_id, f.label ORDER BY n DESC, t.follow_id`,
    [userId, now.toISOString(), new Date(now.getTime() - FRONTIER_FOLLOW_NOTICE_WINDOW_MS).toISOString()])).rows ?? [];
    const claimed = rows.flatMap((/** @type {any} */ row) => (row.items ?? []).map((/** @type {string} */ item) => `${row.follow_id}:${item}`));
    this.counters.claimed += claimed.length;
    return { news: rows.map((/** @type {any} */ row) => ({ followId: String(row.follow_id), label: String(row.label), count: Number(row.n) })), claimed };
  }

  /** A notice that could not be made gives its matches back. @param {string[]} claimed `<follow>:<item>` pairs from `claimNotice` */
  async releaseNotice(claimed) {
    if (!claimed.length) return;
    const pairs = claimed.map((entry) => entry.split(":"));
    await this.database.query(`UPDATE evimed_frontier.follow_matches m SET notified_at = NULL FROM unnest($1::bigint[], $2::bigint[]) AS p(follow_id, item_id)
      WHERE m.follow_id = p.follow_id AND m.item_id = p.item_id`, [pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])]);
    this.counters.released += claimed.length;
  }

  status() {
    return { counters: { ...this.counters }, minCosine: this.minCosine, lastError: this.lastError };
  }
}
