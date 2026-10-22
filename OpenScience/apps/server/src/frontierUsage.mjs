/**
 * What readers do with 「前沿动态」, and what feeds it, as figures for the operator (fr-ops, 2026-10-22).
 *
 * Per day, in the feed's own time zone (`OPEN_SCIENCE_FRONTIER_TIMEZONE`): distinct readers, item reads, event reads, stars and follows,
 * the daily notice's deliveries and opens (in the inbox and on Feishu), the sources by state, the discovery counts and the paid providers
 * the knowledge plugin reports, and the frontier model's spend. Served as `GET /api/ops/frontier-usage` behind the scrape token and as
 * `open_science_frontier_usage_*`, `_discovery_*` and `_provider_*` families beside the existing `open_science_frontier_*` ones. Nothing here
 * is text for a person who reads the feed: the page of a reader shows none of it.
 *
 * Hidden knowledge:
 *
 * - **Counted from what the tables already hold; nothing is written.** The audit of 2026-10-22 counted readers the same way. The cost is the
 *   precision of three of the figures, said here so a dashboard does not over-read them: a reader's `read_at` on an item is the *last* time
 *   they opened it (reading it again later moves it to the later day), a star taken back is not counted, and a follow taken back is not
 *   counted. A reader is "active" on a day when any of these happened that day: an item opened, starred, a follow made, an event page
 *   opened, the feed shown to them (`exposures`, kept 90 days), the daily notice opened. Operators' and test accounts are readers too.
 * - **Opens of a notice are the inbox's `read_at`.** A Feishu card is a push: tapping it lands in the app, which marks the item read, so
 *   `feishu_opened` is an inbox item that was sent on Feishu and has been read, not a click measured on Feishu. Deliveries are the inbox
 *   rows (in-app always) and `channels_sent.feishu` (the push reached the channel).
 * - **A part that cannot be read is `null` with its reason, never 0.** A deployment without the inbox schema, or a plugin that does not yet
 *   report `providers` or `discovery` (contract 1.4.0), differs from one that reports none; each part is read on its own, so one failing
 *   table costs the figures that depend on it and nothing else (principle 19).
 * - **Plugin blocks arrive as the ingest keeps them.** `providers` and `discovery` are read from `pluginHealthDetail` of the ingest's status
 *   in either the contract's snake_case or camelCase, tolerant of a single row or a list; a value that is not a number is dropped, a
 *   provider's name is reduced to a label-safe word, and at most twelve providers are kept.
 * - **The scrape reads a snapshot kept for a minute.** A scraper asks every fifteen seconds and the day figures are several table scans; the
 *   route computes its own, fresh.
 * - **No new lever.** It rides the frontier module's switch: composed with the module, absent without it.
 *
 * Which model capability would make it deletable: none. These are rows read and counted.
 *
 * @module frontierUsage
 */
import { HttpError } from "./security.mjs";

export const FRONTIER_USAGE_DEFAULT_DAYS = 14;
/** `exposures` is kept 90 days (frontierWorker.cleanup); a longer window would be silently short for the readers it counts. */
export const FRONTIER_USAGE_MAX_DAYS = 90;
/** How long the Prometheus families reuse one snapshot. */
export const FRONTIER_USAGE_SCRAPE_MS = 60_000;
/** The notice families the frontier sends, by the prefix of their source id (`frontier-daily:<day>`, …). */
export const FRONTIER_NOTICE_KINDS = Object.freeze(["daily", "weekly", "safety", "zone"]);
const NOTICE_OUTCOMES = Object.freeze(["delivered", "opened", "feishu_delivered", "feishu_opened"]);
const DISCOVERY_STAGES = Object.freeze(["candidates", "validated", "trial", "admitted", "retired", "failed"]);
const MAX_PROVIDERS = 12;

/** @param {string} reason @returns {{ value: null, reason: string }} */
const absent = (reason) => ({ value: null, reason });
/** @param {unknown} value @returns {number | null} */
const count = (value) => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
};
/** @param {unknown} error */
const reasonOf = (error) => (typeof (/** @type {any} */ (error))?.code === "string" ? /** @type {any} */ (error).code : (/** @type {any} */ (error))?.name ?? "error");

/**
 * An amount the plugin reports: `{ amount, currency }` or a bare number, with a currency word of letters only.
 * @param {unknown} value @returns {{ amount: number, currency: string } | null}
 */
function money(value) {
  if (value && typeof value === "object") {
    const amount = count(/** @type {any} */ (value).amount);
    const currency = String(/** @type {any} */ (value).currency ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
    return amount === null ? null : { amount, currency: currency || "UNKNOWN" };
  }
  const amount = count(value);
  return amount === null ? null : { amount, currency: "UNKNOWN" };
}

/**
 * The paid providers a plugin health block reports (contract 1.4.0 `providers`), as the operator reads them.
 * @param {any} detail the ingest's `pluginHealthDetail`
 * @returns {{ name: string, calls24h: number | null, spend24h: { amount: number, currency: string } | null, remaining: { amount: number, currency: string } | null, lastError: string | null }[] | null}
 */
export function usageProviders(detail) {
  const raw = detail?.providers;
  if (raw === undefined || raw === null) return null;
  const rows = Array.isArray(raw) ? raw : typeof raw === "object" ? Object.entries(raw).map(([name, row]) => ({ name, .../** @type {any} */ (row) })) : [];
  return rows.slice(0, MAX_PROVIDERS).flatMap((/** @type {any} */ row) => {
    const name = String(row?.name ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
    if (!name) return [];
    const error = row.last_error ?? row.lastError;
    return [{
      name, calls24h: count(row.calls_24h ?? row.calls24h), spend24h: money(row.spend_24h ?? row.spend24h), remaining: money(row.remaining),
      lastError: error ? String(typeof error === "object" ? (/** @type {any} */ (error).code ?? (/** @type {any} */ (error).message ?? "error")) : error).slice(0, 80) : null,
    }];
  });
}

/**
 * The discovery counts a plugin health block reports (contract 1.4.0 `discovery`): one row per day, today first.
 * @param {any} detail the ingest's `pluginHealthDetail`
 * @returns {{ today: Record<string, number | string | null> | null, days: Record<string, number | string | null>[] } | null}
 */
export function usageDiscovery(detail) {
  const raw = detail?.discovery;
  if (raw === undefined || raw === null || typeof raw !== "object") return null;
  const history = Array.isArray(raw.days) ? raw.days : Array.isArray(raw.history) ? raw.history : Array.isArray(raw.last_14_days) ? raw.last_14_days : null;
  // A list of rows, an object holding today's row and the history, or one row on its own.
  const listed = Array.isArray(raw) ? raw : raw.today || history ? [raw.today, ...(history ?? [])] : [raw];
  /** @type {Record<string, number | string | null>[]} */
  const days = [];
  for (const row of listed) {
    if (!row || typeof row !== "object") continue;
    const entry = /** @type {Record<string, number | string | null>} */ ({ day: /^\d{4}-\d{2}-\d{2}$/.test(String(row.day ?? "")) ? String(row.day) : null });
    for (const stage of DISCOVERY_STAGES) entry[stage] = count(row[stage]);
    entry.net = entry.admitted !== null && entry.retired !== null ? Number(entry.admitted) - Number(entry.retired) : null;
    if (!days.some((seen) => seen.day === entry.day)) days.push(entry);
  }
  days.sort((left, right) => String(right.day ?? "").localeCompare(String(left.day ?? "")));
  return days.length ? { today: days[0], days } : null;
}

/**
 * @param {{
 *   database: any,
 *   config?: Record<string, any>,
 *   plugin?: (() => any) | null,
 *   now?: () => Date,
 * }} options
 *   `plugin` returns the ingest's status (its `pluginHealthDetail` holds the plugin's own blocks); absent, those parts are `null`.
 */
export function createFrontierUsage({ database, config = {}, plugin = null, now = () => new Date() }) {
  const timeZone = String(config.frontierTimeZone || "Asia/Shanghai");
  /** @type {{ at: number, value: any } | null} */
  let cached = null;
  const counters = { snapshots: 0, cacheHits: 0, partFailures: 0 };

  /**
   * One part of the snapshot, alone: a failure becomes `{ value: null, reason }` and a count, and the others are unaffected.
   * @template T @param {() => Promise<T>} read @returns {Promise<T | { value: null, reason: string }>}
   */
  async function part(read) {
    try { return await read(); } catch (error) { counters.partFailures += 1; return absent(reasonOf(error)); }
  }

  /** Which optional tables exist: a deployment without one reads `null` for what depends on it. */
  async function present() {
    const row = (await database.query(`SELECT to_regclass('evimed_frontier.event_reads') IS NOT NULL AS event_reads,
      to_regclass('evimed_frontier.exposures') IS NOT NULL AS exposures, to_regclass('evimed_inbox.notifications') IS NOT NULL AS inbox,
      to_regclass('evimed_usage.model_requests') IS NOT NULL AS usage`)).rows[0] ?? {};
    return { eventReads: row.event_reads === true, exposures: row.exposures === true, inbox: row.inbox === true, usage: row.usage === true };
  }

  /**
   * The window's days, newest first, with every figure 0 where nothing happened (a day with no reader is a fact, not a missing day).
   * @param {number} days @param {string} at the instant "now", ISO
   */
  async function dayFigures(days, at) {
    const tables = await present();
    const since = `(SELECT ((($3::timestamptz AT TIME ZONE $1)::date - ($2::int - 1))::timestamp AT TIME ZONE $1) FROM (SELECT 1) AS one)`;
    const activity = [
      `SELECT (read_at AT TIME ZONE $1)::date AS day, user_id, 'item_read' AS kind FROM evimed_frontier.user_state WHERE read_at >= ${since}`,
      `SELECT (starred_at AT TIME ZONE $1)::date, user_id, 'star' FROM evimed_frontier.user_state WHERE starred_at >= ${since}`,
      `SELECT (created_at AT TIME ZONE $1)::date, user_id, 'follow' FROM evimed_frontier.user_follows WHERE created_at >= ${since}`,
      ...(tables.eventReads ? [`SELECT (read_at AT TIME ZONE $1)::date, user_id, 'event_read' FROM evimed_frontier.event_reads WHERE read_at >= ${since}`] : []),
      ...(tables.exposures ? [`SELECT (exposed_at AT TIME ZONE $1)::date, user_id, 'feed' FROM evimed_frontier.exposures WHERE exposed_at >= ${since}`] : []),
      ...(tables.inbox ? [`SELECT (read_at AT TIME ZONE $1)::date, user_id, 'notice' FROM evimed_inbox.notifications WHERE source->>'id' LIKE 'frontier-daily:%' AND read_at >= ${since}`] : []),
    ].join("\nUNION ALL\n");
    const rows = (await database.query(`WITH activity AS (${activity}),
      series AS (SELECT d::date AS day FROM generate_series((($3::timestamptz AT TIME ZONE $1)::date - ($2::int - 1))::timestamp, ($3::timestamptz AT TIME ZONE $1)::date::timestamp, interval '1 day') AS d)
      SELECT to_char(series.day, 'YYYY-MM-DD') AS day,
        count(DISTINCT activity.user_id)::integer AS readers,
        count(*) FILTER (WHERE activity.kind = 'item_read')::integer AS item_reads,
        count(*) FILTER (WHERE activity.kind = 'event_read')::integer AS event_reads,
        count(*) FILTER (WHERE activity.kind = 'star')::integer AS stars,
        count(*) FILTER (WHERE activity.kind = 'follow')::integer AS follows
      FROM series LEFT JOIN activity ON activity.day = series.day GROUP BY series.day ORDER BY series.day DESC`, [timeZone, days, at])).rows;
    return { tables, rows: rows.map((/** @type {any} */ row) => ({
      day: String(row.day), readers: Number(row.readers), itemReads: Number(row.item_reads), eventReads: Number(row.event_reads), stars: Number(row.stars), follows: Number(row.follows),
    })) };
  }

  /**
   * The frontier's notices by day, kind and outcome. A family or outcome with no row on a day is simply absent from that day.
   * @param {number} days @param {string} at
   * @returns {Promise<Record<string, Record<string, Record<string, number>>>>} day → kind → outcome → n
   */
  async function noticeFigures(days, at) {
    const since = `(SELECT ((($3::timestamptz AT TIME ZONE $1)::date - ($2::int - 1))::timestamp AT TIME ZONE $1) FROM (SELECT 1) AS one)`;
    const frontier = `source->>'id' LIKE 'frontier-%'`;
    const rows = (await database.query(`WITH events AS (
        SELECT (created_at AT TIME ZONE $1)::date AS day, split_part(source->>'id', ':', 1) AS family, 'delivered' AS outcome FROM evimed_inbox.notifications
          WHERE ${frontier} AND created_at >= ${since}
        UNION ALL SELECT (read_at AT TIME ZONE $1)::date, split_part(source->>'id', ':', 1), 'opened' FROM evimed_inbox.notifications
          WHERE ${frontier} AND read_at >= ${since}
        UNION ALL SELECT ((channels_sent->>'feishu')::timestamptz AT TIME ZONE $1)::date, split_part(source->>'id', ':', 1), 'feishu_delivered' FROM evimed_inbox.notifications
          WHERE ${frontier} AND channels_sent ? 'feishu' AND (channels_sent->>'feishu')::timestamptz >= ${since}
        UNION ALL SELECT (read_at AT TIME ZONE $1)::date, split_part(source->>'id', ':', 1), 'feishu_opened' FROM evimed_inbox.notifications
          WHERE ${frontier} AND channels_sent ? 'feishu' AND read_at >= ${since})
      SELECT to_char(day, 'YYYY-MM-DD') AS day, family, outcome, count(*)::integer AS n FROM events GROUP BY day, family, outcome`, [timeZone, days, at])).rows;
    /** @type {Record<string, Record<string, Record<string, number>>>} */
    const byDay = {};
    for (const row of rows) {
      const kind = String(row.family).replace(/^frontier-/, "");
      if (!FRONTIER_NOTICE_KINDS.includes(kind)) continue;
      ((byDay[row.day] ??= {})[kind] ??= {})[row.outcome] = Number(row.n);
    }
    return byDay;
  }

  /** The frontier model's spend by day (purpose `frontier`, settled), from the usage ledger. @param {number} days @param {string} at */
  async function modelSpend(days, at) {
    const since = `(SELECT ((($3::timestamptz AT TIME ZONE $1)::date - ($2::int - 1))::timestamp AT TIME ZONE $1) FROM (SELECT 1) AS one)`;
    const rows = (await database.query(`SELECT to_char((created_at AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day, count(*)::integer AS requests,
        coalesce(sum(actual_cost) FILTER (WHERE status = 'settled'), 0) AS cost
      FROM evimed_usage.model_requests WHERE purpose = 'frontier' AND created_at >= ${since} GROUP BY 1`, [timeZone, days, at])).rows;
    return new Map(rows.map((/** @type {any} */ row) => [String(row.day), { requests: Number(row.requests), costCny: Math.round(Number(row.cost) * 10_000) / 10_000 }]));
  }

  /** The mirrored sources by state. @param {string} at */
  async function sourceStates(at) {
    const row = (await database.query(`SELECT
        count(*) FILTER (WHERE retired_at IS NULL AND enabled)::integer AS enabled,
        count(*) FILTER (WHERE retired_at IS NULL AND NOT enabled)::integer AS disabled,
        count(*) FILTER (WHERE retired_at IS NOT NULL)::integer AS retired,
        count(*) FILTER (WHERE retired_at IS NULL AND enabled AND (last_new_entry_at IS NULL OR last_new_entry_at < $1::timestamptz - interval '7 days'))::integer AS silent_7d,
        count(*) FILTER (WHERE retired_at IS NULL AND enabled AND last_ok_at IS NULL)::integer AS never_read
      FROM evimed_frontier.sources`, [at])).rows[0];
    const health = (await database.query(`SELECT plugin_health AS health, count(*)::integer AS n FROM evimed_frontier.sources
      WHERE retired_at IS NULL AND enabled GROUP BY plugin_health ORDER BY plugin_health`)).rows;
    const types = (await database.query(`SELECT source_type AS type, count(*)::integer AS n FROM evimed_frontier.sources
      WHERE retired_at IS NULL AND enabled GROUP BY source_type ORDER BY source_type`)).rows;
    return {
      enabled: Number(row.enabled), disabled: Number(row.disabled), retired: Number(row.retired), silent7d: Number(row.silent_7d), neverRead: Number(row.never_read),
      byHealth: Object.fromEntries(health.map((/** @type {any} */ item) => [String(item.health), Number(item.n)])),
      byType: Object.fromEntries(types.map((/** @type {any} */ item) => [String(item.type), Number(item.n)])),
    };
  }

  /**
   * The operator's figures for the last `days` days, today first. Computed fresh.
   * @param {{ days?: number }} [options]
   */
  async function snapshot({ days = FRONTIER_USAGE_DEFAULT_DAYS } = {}) {
    if (!Number.isSafeInteger(days) || days < 1 || days > FRONTIER_USAGE_MAX_DAYS) {
      throw new HttpError(400, "usage_report_days_invalid", `days must be a whole number from 1 to ${FRONTIER_USAGE_MAX_DAYS}.`);
    }
    counters.snapshots += 1;
    const at = now().toISOString();
    const activity = await part(() => dayFigures(days, at));
    const optional = "tables" in activity ? activity.tables : null;
    const notices = optional?.inbox ? await part(() => noticeFigures(days, at)) : absent("inbox_unavailable");
    const spend = optional?.usage ? await part(() => modelSpend(days, at)) : absent("usage_ledger_unavailable");
    const status = plugin ? (() => { try { return plugin(); } catch { return null; } })() : null;
    const detail = status?.pluginHealthDetail ?? null;
    const providers = usageProviders(detail);
    const discovery = usageDiscovery(detail);
    const budgetCny = Number(config.frontierDailyBudgetCny ?? 0);
    const rows = "rows" in activity ? activity.rows : null;
    return {
      generatedAt: at,
      timeZone,
      days: rows === null ? absent(/** @type {any} */ (activity).reason) : rows.map((row) => ({
        ...row,
        notices: "value" in notices ? null : Object.fromEntries(FRONTIER_NOTICE_KINDS.map((kind) => [kind, Object.fromEntries(NOTICE_OUTCOMES.map((outcome) => [outcome, notices[row.day]?.[kind]?.[outcome] ?? 0]))])),
        model: "value" in spend ? null : { requests: spend.get(row.day)?.requests ?? 0, costCny: spend.get(row.day)?.costCny ?? 0, budgetCny },
      })),
      noticesReason: "value" in notices ? notices.reason : null,
      modelReason: "value" in spend ? spend.reason : null,
      sources: await part(() => sourceStates(at)),
      discovery: discovery ?? absent(detail ? "plugin_does_not_report_discovery" : "plugin_health_unavailable"),
      providers: providers ?? absent(detail ? "plugin_does_not_report_providers" : "plugin_health_unavailable"),
    };
  }

  /** The snapshot the scrape reuses for a minute; a snapshot that cannot be taken is null. */
  async function cachedSnapshot() {
    if (cached && now().getTime() - cached.at < FRONTIER_USAGE_SCRAPE_MS) { counters.cacheHits += 1; return cached.value; }
    let value = null;
    try { value = await snapshot({ days: 2 }); } catch { counters.partFailures += 1; }
    cached = { at: now().getTime(), value };
    return value;
  }

  /**
   * The Prometheus families, in the shape `addMetric` takes. Today and yesterday are gauges, because Prometheus draws the days itself; the
   * route has the table of days. A figure that could not be read has no series, so a dashboard shows a gap, not a zero.
   */
  async function metricFamilies() {
    const view = await cachedSnapshot();
    /** @type {{ name: string, help: string, type: "gauge" | "counter", series: { value: number, labels?: Record<string, string> }[] }[]} */
    const families = [{ name: "open_science_frontier_usage_snapshot", help: "Whether the frontier usage figures could be read (1 = the per-day reader figures were).", type: "gauge",
      series: [{ value: view && Array.isArray(view.days) ? 1 : 0 }] }];
    if (!view) return families;
    /** @param {string} name @param {string} help @param {{ value: number, labels?: Record<string, string> }[]} series */
    const gauge = (name, help, series) => { if (series.length) families.push({ name, help, type: "gauge", series }); };
    const days = Array.isArray(view.days) ? view.days.slice(0, 2) : [];
    const windows = days.map((row, index) => ({ row, window: index === 0 ? "today" : "yesterday" }));
    for (const [field, name, help] of /** @type {const} */ ([
      ["readers", "readers", "Distinct accounts that read, starred, followed or opened the feed that day (the feed's time zone)."],
      ["itemReads", "item_reads", "Items whose last open by a reader fell on that day."],
      ["eventReads", "event_reads", "Event pages whose last open by a reader fell on that day."],
      ["stars", "stars", "Items starred that day and still starred."],
      ["follows", "follows", "Follows made that day and still held."],
    ])) gauge(`open_science_frontier_usage_${name}`, help, windows.map(({ row, window }) => ({ labels: { window }, value: row[field] })));
    gauge("open_science_frontier_usage_notices", "The frontier's inbox notices by family and outcome that day (opens are the inbox item read; a Feishu open is an item sent there and read).",
      windows.flatMap(({ row, window }) => (row.notices ? FRONTIER_NOTICE_KINDS.flatMap((kind) => NOTICE_OUTCOMES.map((outcome) => ({ labels: { kind, outcome, window }, value: row.notices[kind][outcome] }))) : [])));
    gauge("open_science_frontier_usage_model_requests", "Frontier model requests that day (purpose frontier).",
      windows.flatMap(({ row, window }) => (row.model ? [{ labels: { window }, value: row.model.requests }] : [])));
    gauge("open_science_frontier_usage_model_spend_cny", "Frontier model spend that day, settled (CNY), by provider.",
      windows.flatMap(({ row, window }) => (row.model ? [{ labels: { provider: "deepseek", window }, value: row.model.costCny }] : [])));
    if (view.sources && !("value" in view.sources)) {
      const sources = view.sources;
      gauge("open_science_frontier_usage_sources", "Mirrored sources by state: enabled, disabled, retired, enabled but silent for 7 days, enabled and never read.", [
        { labels: { state: "enabled" }, value: sources.enabled }, { labels: { state: "disabled" }, value: sources.disabled }, { labels: { state: "retired" }, value: sources.retired },
        { labels: { state: "silent_7d" }, value: sources.silent7d }, { labels: { state: "never_read" }, value: sources.neverRead },
      ]);
      gauge("open_science_frontier_usage_sources_by_type", "Enabled mirrored sources by source type.", Object.entries(sources.byType).map(([type, value]) => ({ labels: { type }, value: Number(value) })));
    }
    if (view.discovery && !("value" in view.discovery) && view.discovery.today) {
      const today = view.discovery.today;
      gauge("open_science_frontier_discovery_today", "Source discovery for the plugin's current day, by stage; net is admitted minus retired.",
        [...DISCOVERY_STAGES, "net"].filter((stage) => today[stage] !== null && today[stage] !== undefined).map((stage) => ({ labels: { stage }, value: Number(today[stage]) })));
    }
    if (Array.isArray(view.providers)) {
      gauge("open_science_frontier_provider_calls_24h", "Paid provider calls in the last 24 hours, as the plugin counts them.",
        view.providers.flatMap((row) => (row.calls24h === null ? [] : [{ labels: { provider: row.name }, value: row.calls24h }])));
      gauge("open_science_frontier_provider_spend_24h", "Paid provider spend in the last 24 hours, as the plugin counts it, in the provider's own currency.",
        view.providers.flatMap((row) => (row.spend24h ? [{ labels: { provider: row.name, currency: row.spend24h.currency }, value: row.spend24h.amount }] : [])));
      gauge("open_science_frontier_provider_remaining", "Balance a paid provider reports having left, in its own currency.",
        view.providers.flatMap((row) => (row.remaining ? [{ labels: { provider: row.name, currency: row.remaining.currency }, value: row.remaining.amount }] : [])));
      gauge("open_science_frontier_provider_error", "A paid provider whose last call failed (1 while the plugin reports a last error).",
        view.providers.map((row) => ({ labels: { provider: row.name }, value: row.lastError ? 1 : 0 })));
    }
    return families;
  }

  return { snapshot, metricFamilies, stats: () => ({ ...counters }), timeZone };
}
