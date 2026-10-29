import { FRONTIER_DWELL } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/**
 * What readers do with what 「前沿动态」 serves them, as figures for the operator (ct-track, 2026-10-24): the instrument a
 * ranking is judged with. Read from `interactions` and `list_serves` (frontierInteractions.mjs), `user_state` and `user_prefs`;
 * served as `GET /api/ops/frontier-reading?days=` behind the scrape token and as `open_science_frontier_reading_*` gauges.
 * Nothing here is text for a person who reads the feed.
 *
 * Definitions (said here so a dashboard does not over-read them; n is tiny — 1 to 4 readers a day in October 2026 — so every
 * rate travels with its counts):
 *
 * - **Click-through** = opens ÷ impressions, both distinct per (reader, list, item), both carrying the list they came from; an
 *   impression is a card seen (≥50% for one continuous second), so an item never in view is no trial. By the item's genre at
 *   the time, by slot (`none` for a chronological list), by surface and by display position (0, 1, 2, 3, 4, 5–9, 10–19, 20+).
 *   An open in under a second can have no impression: such a group's rate can exceed one, and that is shown, not hidden.
 * - **A view** is one opening of a reading page (its `view_id`): its dwell is the sum of the visible, engaged time the page
 *   reported; it is **satisfied** at `FRONTIER_DWELL.satisfiedMs` or when the end of the body came into view. Dwell buckets:
 *   under 10 s, 10–30 s, 30 s–2 min, 2–5 min, 5 min and more.
 * - **Return**: a reader is active on a day (the feed's time zone) when any event of theirs, or an item opened, falls on it.
 *   `d1` and `d7` are the share of a day's active readers active again exactly one and seven days later ("return on"), and
 *   `within7` on any of the seven days after ("on or after"); `null` while that day has not come.
 * - **Onboarding**: readers shown the card, and answers finished and skipped, by day.
 * - **Flagged sources** (c2-hide): the hides readers gave a reason for — 「内容质量不高」 (`low-quality`) and 「像广告或软文」
 *   (`promotional`) — counted per source over the last `FLAGGED_DAYS` days whatever the window asked for, with how many readers
 *   said it. A reader's word is a hint to the operator about a source, not a ruling: no ranking reads it, and it is never on a
 *   reader's page.
 *
 * A part that cannot be read is `{ value: null, reason }`, never 0 (frontierUsage's discipline). The scrape reuses one
 * snapshot for a minute; the route computes its own.
 *
 * Which model capability would make it deletable: none. These are rows read and counted.
 *
 * @module frontierReadingMetrics
 */

export const FRONTIER_READING_DEFAULT_DAYS = 14;
/** The tables are kept 180 days (frontierInteractions.mjs); D7 needs seven days past the window's last. */
export const FRONTIER_READING_MAX_DAYS = 170;
const SCRAPE_MS = 60_000;
/** The window the gauges' click-through and dwell are read over. */
const GAUGE_DAYS = 7;
export const FRONTIER_POSITION_BUCKETS = Object.freeze(["0", "1", "2", "3", "4", "5-9", "10-19", "20+"]);
export const FRONTIER_DWELL_BUCKETS = Object.freeze(["lt10s", "10-30s", "30s-2m", "2-5m", "ge5m"]);
/** The days the flagged-source counts look back, whatever window the day figures were asked for. */
export const FRONTIER_FLAGGED_DAYS = 30;
/** The sources listed at most: the ones readers flagged most. */
const FLAGGED_SOURCES_LIMIT = 50;
const POSITION_SQL = `CASE WHEN position IS NULL THEN 'none' WHEN position <= 4 THEN position::text WHEN position <= 9 THEN '5-9'
  WHEN position <= 19 THEN '10-19' ELSE '20+' END`;

/** @param {string} reason */
const absent = (reason) => ({ value: null, reason });
/** @param {unknown} error */
const reasonOf = (error) => (typeof (/** @type {any} */ (error))?.code === "string" ? /** @type {any} */ (error).code : (/** @type {any} */ (error))?.name ?? "error");
/** @param {number} part @param {number} whole */
const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);

/**
 * @param {{ database: any, config?: Record<string, any>, now?: () => Date }} options
 */
export function createFrontierReadingMetrics({ database, config = {}, now = () => new Date() }) {
  const timeZone = String(config.frontierTimeZone || "Asia/Shanghai");
  /** @type {{ at: number, value: any } | null} */
  let cached = null;
  const counters = { snapshots: 0, cacheHits: 0, partFailures: 0 };

  /** @template T @param {() => Promise<T>} read @returns {Promise<T | { value: null, reason: string }>} */
  async function part(read) {
    try { return await read(); } catch (error) { counters.partFailures += 1; return absent(reasonOf(error)); }
  }

  /** The window's first instant, in every query's parameters ($1 the time zone, $2 the days, $3 now): midnight of the feed's day, `days - 1` days before today. */
  const SINCE = `((($3::timestamptz AT TIME ZONE $1)::date - ($2::int - 1))::timestamp AT TIME ZONE $1)`;

  /** Click-through by genre, slot, surface and position bucket over the window. @param {number} days @param {string} at */
  async function clickThrough(days, at) {
    const rows = (await database.query(`WITH shown AS (
        SELECT DISTINCT ON (user_id, list_id, coalesce(item_id::text, event_public_id), type) type, coalesce(genre, 'none') AS genre,
          coalesce(slot, 'none') AS slot, surface, ${POSITION_SQL} AS bucket
        FROM evimed_frontier.interactions
        WHERE type IN ('impression', 'open') AND list_id IS NOT NULL AND client_at >= ${SINCE}
        ORDER BY user_id, list_id, coalesce(item_id::text, event_public_id), type, client_at)
      SELECT CASE WHEN GROUPING(genre) = 0 THEN 'genre' WHEN GROUPING(slot) = 0 THEN 'slot' WHEN GROUPING(surface) = 0 THEN 'surface' ELSE 'position' END AS dimension,
        coalesce(CASE WHEN GROUPING(genre) = 0 THEN genre WHEN GROUPING(slot) = 0 THEN slot WHEN GROUPING(surface) = 0 THEN surface ELSE bucket END, 'none') AS key,
        count(*) FILTER (WHERE type = 'impression')::integer AS impressions, count(*) FILTER (WHERE type = 'open')::integer AS opens
      FROM shown GROUP BY GROUPING SETS ((genre), (slot), (surface), (bucket))`, [timeZone, days, at])).rows ?? [];
    /** @type {Record<string, Array<{ key: string, impressions: number, opens: number, ctr: number | null }>>} */
    const out = { genre: [], slot: [], surface: [], position: [] };
    for (const row of rows) {
      const list = out[String(row.dimension)];
      if (!list) continue;
      list.push({ key: String(row.key), impressions: Number(row.impressions), opens: Number(row.opens), ctr: rate(Number(row.opens), Number(row.impressions)) });
    }
    for (const list of Object.values(out)) list.sort((left, right) => right.impressions - left.impressions || left.key.localeCompare(right.key));
    out.position.sort((left, right) => FRONTIER_POSITION_BUCKETS.indexOf(left.key) - FRONTIER_POSITION_BUCKETS.indexOf(right.key));
    return out;
  }

  /** Reading views over the window, by day: count, satisfied, end reached, median dwell and the buckets. @param {number} days @param {string} at */
  async function views(days, at) {
    const rows = (await database.query(`WITH v AS (
        SELECT view_id, min(client_at) AS at, coalesce(sum(value) FILTER (WHERE type = 'dwell'), 0) AS dwell, bool_or(type = 'reach-end') AS reached
        FROM evimed_frontier.interactions WHERE view_id IS NOT NULL AND client_at >= ${SINCE} GROUP BY view_id)
      SELECT to_char((at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day, count(*)::integer AS views,
        count(*) FILTER (WHERE dwell >= $4 OR reached)::integer AS satisfied, count(*) FILTER (WHERE reached)::integer AS reached,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY dwell) AS median,
        count(*) FILTER (WHERE dwell < 10000)::integer AS lt10s, count(*) FILTER (WHERE dwell >= 10000 AND dwell < 30000)::integer AS b10_30,
        count(*) FILTER (WHERE dwell >= 30000 AND dwell < 120000)::integer AS b30_120, count(*) FILTER (WHERE dwell >= 120000 AND dwell < 300000)::integer AS b120_300,
        count(*) FILTER (WHERE dwell >= 300000)::integer AS ge5m
      FROM v GROUP BY 1`, [timeZone, days, at, FRONTIER_DWELL.satisfiedMs])).rows ?? [];
    return new Map(rows.map((/** @type {any} */ row) => [String(row.day), {
      views: Number(row.views), satisfied: Number(row.satisfied), reachedEnd: Number(row.reached), medianDwellMs: row.median == null ? null : Math.round(Number(row.median)),
      buckets: { lt10s: Number(row.lt10s), "10-30s": Number(row.b10_30), "30s-2m": Number(row.b30_120), "2-5m": Number(row.b120_300), ge5m: Number(row.ge5m) },
    }]));
  }

  /** Readers, impressions and opens by day. @param {number} days @param {string} at */
  async function activity(days, at) {
    const rows = (await database.query(`SELECT to_char((client_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day, count(DISTINCT user_id)::integer AS readers,
        count(*) FILTER (WHERE type = 'impression')::integer AS impressions, count(*) FILTER (WHERE type = 'open')::integer AS opens,
        count(*) FILTER (WHERE type = 'open' AND list_id IS NOT NULL)::integer AS list_opens
      FROM evimed_frontier.interactions WHERE client_at >= ${SINCE} GROUP BY 1`, [timeZone, days, at])).rows ?? [];
    return new Map(rows.map((/** @type {any} */ row) => [String(row.day), { readers: Number(row.readers), impressions: Number(row.impressions), opens: Number(row.opens),
      listOpens: Number(row.list_opens) }]));
  }

  /** Return on the next day, the seventh and within seven, by day. @param {number} days @param {string} at */
  async function returns(days, at) {
    const rows = (await database.query(`WITH active AS (
        SELECT DISTINCT user_id, (client_at AT TIME ZONE $1)::date AS day FROM evimed_frontier.interactions WHERE client_at >= ${SINCE}
        UNION SELECT DISTINCT user_id, (read_at AT TIME ZONE $1)::date FROM evimed_frontier.user_state WHERE read_at >= ${SINCE})
      SELECT to_char(a.day, 'YYYY-MM-DD') AS day, count(*)::integer AS base,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM active b WHERE b.user_id = a.user_id AND b.day = a.day + 1))::integer AS d1,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM active b WHERE b.user_id = a.user_id AND b.day = a.day + 7))::integer AS d7,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM active b WHERE b.user_id = a.user_id AND b.day > a.day AND b.day <= a.day + 7))::integer AS within7,
        (($3::timestamptz AT TIME ZONE $1)::date - a.day)::integer AS age
      FROM active a GROUP BY a.day`, [timeZone, days, at])).rows ?? [];
    return new Map(rows.map((/** @type {any} */ row) => {
      const base = Number(row.base);
      const age = Number(row.age);
      const figure = (/** @type {number} */ returned, /** @type {number} */ after) => (age >= after ? { returned, rate: rate(returned, base) } : null);
      return [String(row.day), { base, d1: figure(Number(row.d1), 1), d7: figure(Number(row.d7), 7), within7: figure(Number(row.within7), 7) }];
    }));
  }

  /** Onboarding by day: readers shown the card, answers finished, answers skipped. @param {number} days @param {string} at */
  async function onboarding(days, at) {
    const rows = (await database.query(`SELECT day, sum(shown)::integer AS shown, sum(done)::integer AS done, sum(skipped)::integer AS skipped FROM (
        SELECT to_char((client_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day, count(DISTINCT user_id) AS shown, 0 AS done, 0 AS skipped
          FROM evimed_frontier.interactions WHERE type = 'onboarding-shown' AND client_at >= ${SINCE} GROUP BY 1
        UNION ALL SELECT to_char((onboarded_at AT TIME ZONE $1)::date, 'YYYY-MM-DD'), 0, count(*), 0
          FROM evimed_frontier.user_prefs WHERE onboarded_at >= ${SINCE} GROUP BY 1
        UNION ALL SELECT to_char((onboarding_skipped_at AT TIME ZONE $1)::date, 'YYYY-MM-DD'), 0, 0, count(*)
          FROM evimed_frontier.user_prefs WHERE onboarding_skipped_at >= ${SINCE} GROUP BY 1) AS parts GROUP BY day`, [timeZone, days, at])).rows ?? [];
    return new Map(rows.map((/** @type {any} */ row) => [String(row.day), { shown: Number(row.shown), done: Number(row.done), skipped: Number(row.skipped) }]));
  }

  /**
   * The sources readers flagged — hidden with a reason of low quality or promotion — over the last `FRONTIER_FLAGGED_DAYS` days,
   * most flagged first. @param {string} at
   */
  async function flaggedSources(at) {
    const rows = (await database.query(`SELECT s.id, s.name,
        count(*) FILTER (WHERE us.hidden_reason = 'low-quality')::integer AS low_quality,
        count(*) FILTER (WHERE us.hidden_reason = 'promotional')::integer AS promotional,
        count(DISTINCT us.user_id)::integer AS readers
      FROM evimed_frontier.user_state us JOIN evimed_frontier.items i ON i.id = us.item_id JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE us.hidden_at >= ($1::timestamptz - make_interval(days => $2::int)) AND us.hidden_reason IN ('low-quality', 'promotional')
      GROUP BY s.id, s.name ORDER BY count(*) DESC, s.id LIMIT ${FLAGGED_SOURCES_LIMIT}`, [at, FRONTIER_FLAGGED_DAYS])).rows ?? [];
    return { days: FRONTIER_FLAGGED_DAYS, sources: rows.map((/** @type {any} */ row) => ({ source: String(row.id), name: String(row.name),
      lowQuality: Number(row.low_quality), promotional: Number(row.promotional), readers: Number(row.readers) })) };
  }

  /** The window's days, newest first, as the feed's calendar has them. @param {number} days @param {string} at */
  async function calendar(days, at) {
    const rows = (await database.query(`SELECT to_char(d::date, 'YYYY-MM-DD') AS day FROM generate_series(
        (($3::timestamptz AT TIME ZONE $1)::date - ($2::int - 1))::timestamp, ($3::timestamptz AT TIME ZONE $1)::date::timestamp, interval '1 day') AS d
      ORDER BY 1 DESC`, [timeZone, days, at])).rows ?? [];
    return rows.map((/** @type {any} */ row) => String(row.day));
  }

  /**
   * The operator's reading figures for the last `days` days (today first) and the window's click-through and dwell.
   * @param {{ days?: number }} [options]
   */
  async function snapshot({ days = FRONTIER_READING_DEFAULT_DAYS } = {}) {
    if (!Number.isSafeInteger(days) || days < 1 || days > FRONTIER_READING_MAX_DAYS) {
      throw new HttpError(400, "reading_report_days_invalid", `days must be a whole number from 1 to ${FRONTIER_READING_MAX_DAYS}.`);
    }
    counters.snapshots += 1;
    const at = now().toISOString();
    const [dayList, acts, viewed, returned, onboarded, ctr, flagged] = await Promise.all([
      part(() => calendar(days, at)), part(() => activity(days, at)), part(() => views(days, at)), part(() => returns(days, at)),
      part(() => onboarding(days, at)), part(() => clickThrough(days, at)), part(() => flaggedSources(at)),
    ]);
    const map = (/** @type {any} */ value) => (value instanceof Map ? value : null);
    const totals = { views: 0, satisfied: 0, reachedEnd: 0, buckets: Object.fromEntries(FRONTIER_DWELL_BUCKETS.map((bucket) => [bucket, 0])) };
    for (const row of map(viewed)?.values() ?? []) {
      totals.views += row.views; totals.satisfied += row.satisfied; totals.reachedEnd += row.reachedEnd;
      for (const bucket of FRONTIER_DWELL_BUCKETS) totals.buckets[bucket] += row.buckets[bucket];
    }
    return {
      generatedAt: at,
      timeZone,
      definitions: { impression: "≥50% in view for ≥1 continuous second", satisfiedDwellMs: FRONTIER_DWELL.satisfiedMs, return: "active again exactly N days later; within7 = any of the next 7" },
      days: Array.isArray(dayList) ? dayList.map((day) => ({
        day,
        activity: map(acts) ? map(acts).get(day) ?? { readers: 0, impressions: 0, opens: 0, listOpens: 0 } : null,
        views: map(viewed) ? map(viewed).get(day) ?? { views: 0, satisfied: 0, reachedEnd: 0, medianDwellMs: null, buckets: Object.fromEntries(FRONTIER_DWELL_BUCKETS.map((bucket) => [bucket, 0])) } : null,
        return: map(returned) ? map(returned).get(day) ?? { base: 0, d1: null, d7: null, within7: null } : null,
        onboarding: map(onboarded) ? map(onboarded).get(day) ?? { shown: 0, done: 0, skipped: 0 } : null,
      })) : dayList,
      clickThrough: ctr,
      flaggedSources: flagged,
      dwell: map(viewed) ? { ...totals, satisfiedShare: rate(totals.satisfied, totals.views), reachEndShare: rate(totals.reachedEnd, totals.views) } : absent(/** @type {any} */ (viewed).reason),
      partsMissing: Object.entries({ calendar: dayList, activity: acts, views: viewed, return: returned, onboarding: onboarded, clickThrough: ctr, flaggedSources: flagged })
        .filter(([, value]) => value && typeof value === "object" && "value" in value && value.value === null).map(([name, value]) => ({ name, reason: /** @type {any} */ (value).reason })),
    };
  }

  /** The snapshot the scrape reuses for a minute: the last seven days. */
  async function cachedSnapshot() {
    if (cached && now().getTime() - cached.at < SCRAPE_MS) { counters.cacheHits += 1; return cached.value; }
    let value = null;
    try { value = await snapshot({ days: GAUGE_DAYS }); } catch { counters.partFailures += 1; }
    cached = { at: now().getTime(), value };
    return value;
  }

  /**
   * The Prometheus families: today's and yesterday's activity, views and onboarding; the last seven days' click-through by slot,
   * surface, genre and position; return for the newest day each can be told for. A figure that cannot be read has no series.
   */
  async function metricFamilies() {
    const view = await cachedSnapshot();
    /** @type {{ name: string, help: string, type: "gauge", series: { value: number, labels?: Record<string, string> }[] }[]} */
    const families = [{ name: "open_science_frontier_reading_snapshot", help: "Whether the frontier reading figures could be read (1 = the day figures were).",
      type: "gauge", series: [{ value: view && Array.isArray(view.days) ? 1 : 0 }] }];
    if (!view || !Array.isArray(view.days)) return families;
    /** @param {string} name @param {string} help @param {{ value: number, labels?: Record<string, string> }[]} series */
    const gauge = (name, help, series) => { if (series.length) families.push({ name, help, type: "gauge", series }); };
    const windows = view.days.slice(0, 2).map((/** @type {any} */ row, /** @type {number} */ index) => ({ row, window: index === 0 ? "today" : "yesterday" }));
    gauge("open_science_frontier_reading_activity", "Readers with an event, impressions (seen cards) and opens that day, in the feed's time zone.",
      windows.flatMap(({ row, window }) => (row.activity ? ["readers", "impressions", "opens"].map((kind) => ({ labels: { kind, window }, value: row.activity[kind] })) : [])));
    gauge("open_science_frontier_reading_views", "Reading-page views that day: all, satisfied (≥30 s engaged or the end reached), the end reached.",
      windows.flatMap(({ row, window }) => (row.views ? [["all", row.views.views], ["satisfied", row.views.satisfied], ["reached_end", row.views.reachedEnd]]
        .map(([kind, value]) => ({ labels: { kind: String(kind), window }, value: Number(value) })) : [])));
    gauge("open_science_frontier_reading_onboarding", "与我相关 onboarding that day: readers shown the card, answers finished, answers skipped.",
      windows.flatMap(({ row, window }) => (row.onboarding ? ["shown", "done", "skipped"].map((kind) => ({ labels: { kind, window }, value: row.onboarding[kind] })) : [])));
    if (view.clickThrough && !("value" in view.clickThrough)) {
      for (const dimension of /** @type {const} */ (["slot", "surface", "genre", "position"])) {
        const rows = view.clickThrough[dimension] ?? [];
        gauge(`open_science_frontier_reading_impressions_7d_by_${dimension}`, `Seen cards over the last 7 days by ${dimension}, distinct per reader, list and item.`,
          rows.map((/** @type {any} */ row) => ({ labels: { [dimension]: row.key }, value: row.impressions })));
        gauge(`open_science_frontier_reading_opens_7d_by_${dimension}`, `Opens from a list over the last 7 days by ${dimension}, distinct per reader, list and item.`,
          rows.map((/** @type {any} */ row) => ({ labels: { [dimension]: row.key }, value: row.opens })));
      }
    }
    if (view.dwell && !("value" in view.dwell)) {
      gauge("open_science_frontier_reading_dwell_7d", "Reading-page views over the last 7 days by engaged dwell bucket.",
        FRONTIER_DWELL_BUCKETS.map((bucket) => ({ labels: { bucket }, value: view.dwell.buckets[bucket] })));
    }
    const newest = (/** @type {"d1" | "d7" | "within7"} */ key) => view.days.find((/** @type {any} */ row) => row.return?.[key]);
    for (const key of /** @type {const} */ (["d1", "d7", "within7"])) {
      const row = newest(key);
      if (row) gauge(`open_science_frontier_reading_return_${key}`, `Of the readers active on the newest day that can be told, how many came back (${key}); base is that day's readers.`,
        [{ labels: { kind: "base" }, value: row.return.base }, { labels: { kind: "returned" }, value: row.return[key].returned }]);
    }
    return families;
  }

  return { snapshot, metricFamilies, stats: () => ({ ...counters }), timeZone };
}
