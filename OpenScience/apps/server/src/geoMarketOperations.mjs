import { HttpError } from "./security.mjs";
import { mapLedger, mapOrder, mapTopup } from "./geoMarketStore.mjs";

const invalid = () => new HttpError(400, "geo_payload_invalid", "Invalid marketplace list or month filter.");
const PROBLEMS = "(state = 'problem' OR (state IN ('rejected','cancelled') AND vendor_order_nid IS NOT NULL))";
const timestamp = (/** @type {string} */ column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** @param {Record<string, any>} input @param {string} scope */
function pageOptions(input, scope) {
  const raw = String(input.limit ?? "50");
  if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > 200) throw invalid();
  const limit = Number(raw);
  if (!input.cursor) return { limit, at: null, id: null, scope };
  if (typeof input.cursor !== "string" || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw invalid();
  let cursor;
  try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); } catch { throw invalid(); }
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)
    || Object.keys(cursor).sort().join() !== "at,id,scope,v" || cursor.v !== 1 || cursor.scope !== scope
    || typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 200 || [...cursor.id].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || typeof cursor.at !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.at)
    || !Number.isFinite(Date.parse(cursor.at)) || new Date(cursor.at).toISOString().slice(0, 19) !== cursor.at.slice(0, 19)) throw invalid();
  return { limit, at: cursor.at, id: cursor.id, scope };
}

/** @param {any[]} rows @param {ReturnType<typeof pageOptions>} options @param {(row: any) => any} map */
function page(rows, options, map) {
  const selected = rows.slice(0, options.limit);
  const last = selected.at(-1);
  const nextCursor = rows.length > options.limit && last
    ? Buffer.from(JSON.stringify({ v: 1, scope: options.scope, at: last._cursor_at, id: last.id })).toString("base64url") : null;
  return { items: selected.map(map), nextCursor };
}

/** Read-only projections of the existing order and monetary ledgers.
 * No vendor call or monetary mutation is part of these reads. Each query uses
 * one database snapshot; pagination never narrows a statement's totals.
 */
export class GeoMarketOperations {
  /** @param {{ database: { query: (sql: string, values?: any[]) => Promise<any> }, ready: () => Promise<void>, timeZone?: string, now?: () => Date }} options */
  constructor({ database, ready, timeZone = "Asia/Shanghai", now = () => new Date() }) {
    new Intl.DateTimeFormat("en", { timeZone }).format(now());
    this.database = database;
    this.ready = ready;
    this.timeZone = timeZone;
    this.now = now;
  }

  periodDefaults() {
    const parts = new Intl.DateTimeFormat("en", { timeZone: this.timeZone, year: "numeric", month: "2-digit" }).formatToParts(this.now());
    return { timeZone: this.timeZone, currentMonth: `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}` };
  }

  async counts() {
    await this.ready();
    const result = await this.database.query(`SELECT
      (SELECT count(*)::int FROM evimed_geo.orders WHERE state = 'unknown') AS "unknownOrders",
      (SELECT count(*)::int FROM evimed_geo.orders WHERE ${PROBLEMS}) AS "problemOrders",
      (SELECT count(*)::int FROM evimed_geo.topups WHERE status = 'requested') AS "requestedTopups"`);
    return result.rows[0];
  }

  /** @param {Record<string, any>} [input] */
  async orders(input = {}) {
    const view = input.view ?? "unknown";
    if (!["unknown", "problems"].includes(view)) throw invalid();
    const options = pageOptions(input, `orders:${view}`);
    const predicate = view === "unknown" ? "state = 'unknown'" : PROBLEMS;
    return this.#list(`SELECT o.*, o.created_at AS sort_at,
      p.product->>'brandName' AS project_label, a.title AS article_title, m.name AS media_name, m.domain AS media_domain,
      (SELECT e.detail->>'reason' FROM evimed_geo.order_events e WHERE e.order_id = o.id AND e.to_state = o.state AND e.from_state IS DISTINCT FROM e.to_state
        ORDER BY e.at DESC, e.id DESC LIMIT 1) AS state_reason,
      (SELECT max(e.at) FROM evimed_geo.order_events e WHERE e.order_id = o.id AND e.detail->>'phase' = 'send_started') AS sent_at,
      (SELECT min(e.at) FROM evimed_geo.order_events e WHERE e.order_id = o.id AND e.detail->>'phase' = 'refund_seen') AS refund_seen_at
      FROM (SELECT * FROM evimed_geo.orders WHERE ${predicate}) o
      LEFT JOIN evimed_geo.projects p ON p.id = o.geo_project_id
      LEFT JOIN evimed_geo.articles a ON a.id = o.article_id
      LEFT JOIN evimed_geo.media m ON m.media_type = o.media_type AND m.resource_id = o.resource_id`, options,
    (row) => ({ ...mapOrder(row), projectLabel: row.project_label ?? null, articleTitle: row.article_title ?? null,
      mediaName: row.media_name ?? null, mediaDomain: row.media_domain ?? null,
      canResolve: row.state === "unknown", canMarkLost: ["problem", "rejected", "cancelled"].includes(row.state) && Boolean(row.vendor_order_nid) }));
  }

  /** @param {Record<string, any>} [input] */
  async topups(input = {}) {
    const status = input.status ?? "requested";
    if (!["requested", "all"].includes(status)) throw invalid();
    const options = pageOptions(input, `topups:${status}`);
    return this.#list(`SELECT *, requested_at AS sort_at FROM evimed_geo.topups ${status === "requested" ? "WHERE status = 'requested'" : ""}`, options, mapTopup);
  }

  /** @param {string} source @param {ReturnType<typeof pageOptions>} options @param {(row: any) => any} map */
  async #list(source, options, map) {
    await this.ready();
    const result = await this.database.query(`WITH eligible AS (${source}), limited AS (
      SELECT *, ${timestamp("sort_at")} AS _cursor_at FROM eligible
      WHERE ($1::timestamptz IS NULL OR (sort_at,id) < ($1::timestamptz,$2::text))
      ORDER BY sort_at DESC,id DESC LIMIT $3)
      SELECT (SELECT count(*)::int FROM eligible) AS total,
      coalesce((SELECT jsonb_agg(limited ORDER BY sort_at DESC,id DESC) FROM limited), '[]'::jsonb) AS items`,
    [options.at, options.id, options.limit + 1]);
    return { total: result.rows[0].total, ...page(result.rows[0].items, options, map) };
  }

  /** @param {Record<string, any>} [input] */
  async settlement(input = {}) {
    const month = input.month ?? this.periodDefaults().currentMonth;
    if (typeof month !== "string" || !/^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(month)) throw invalid();
    const options = pageOptions(input, `settlement:${this.timeZone}:${month}`);
    await this.ready();
    const sum = (/** @type {string} */ kind) => `coalesce(sum(amount_cny) FILTER (WHERE kind = '${kind}'),0)`;
    const result = await this.database.query(`WITH bounds AS (
        SELECT $1::date::timestamp AT TIME ZONE $2 AS start_at,
          ($1::date + interval '1 month') AT TIME ZONE $2 AS end_at),
      eligible AS (SELECT l.* FROM evimed_geo.ledger l, bounds b WHERE l.created_at >= b.start_at AND l.created_at < b.end_at),
      limited AS (SELECT *, ${timestamp("created_at")} AS _cursor_at FROM eligible
        WHERE ($3::timestamptz IS NULL OR (created_at,id) < ($3::timestamptz,$4::text))
        ORDER BY created_at DESC,id DESC LIMIT $5),
      summary AS (SELECT ${sum("settle")} AS "settledCny", ${sum("refund")} AS "refundedCny",
        ${sum("settle")} - ${sum("refund")} AS "netSettledCny",
        ${sum("reserve")} AS "reservedDuringPeriodCny", ${sum("release")} AS "releasedDuringPeriodCny",
        ${sum("topup_request")} AS "topupRequestedCny", ${sum("topup_confirmed")} AS "topupConfirmedCny",
        ${sum("adjustment")} AS "adjustmentCny", count(*) FILTER (WHERE kind = 'budget_set')::int AS "budgetChangeCount",
        count(*)::int AS "entryCount" FROM eligible),
      reconciliations AS (SELECT day::text, balance, diff, status, created_at AS "observedAt", details->>'clearedAt' AS "clearedAt"
        FROM evimed_geo.reconciliations WHERE day >= $1::date AND day < ($1::date + interval '1 month'))
      SELECT b.start_at, b.end_at, row_to_json(s) AS summary,
        coalesce((SELECT jsonb_agg(limited ORDER BY created_at DESC,id DESC) FROM limited),'[]'::jsonb) AS entries,
        coalesce((SELECT jsonb_agg(reconciliations ORDER BY day DESC) FROM reconciliations),'[]'::jsonb) AS reconciliations
      FROM bounds b, summary s`, [month + "-01", this.timeZone, options.at, options.id, options.limit + 1]);
    const row = result.rows[0];
    const detail = page(row.entries, options, mapLedger);
    return { period: { month, timeZone: this.timeZone, startAt: new Date(row.start_at).toISOString(),
      endAt: new Date(row.end_at).toISOString(), generatedAt: this.now().toISOString() },
    summary: row.summary, entries: detail.items, nextCursor: detail.nextCursor, reconciliations: row.reconciliations };
  }
}
