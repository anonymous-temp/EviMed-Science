import { randomBytes } from "node:crypto";
import { GEO_ORDER_ARTICLE_LIVE_STATES, migrateGeo } from "./geoPersistence.mjs";
import { HttpError } from "./security.mjs";

export { GEO_ORDER_ARTICLE_LIVE_STATES };

/** The partial unique index that holds an article to one live order (geoPersistence.mjs). */
export const ARTICLE_LIVE_INDEX = "geo_orders_live_article_key";

/** Amounts closer than a cent are equal. */
export const EPSILON_CNY = 0.01;

const round2 = (/** @type {number} */ value) => Math.round(value * 100) / 100;

/** The refusal a second live order for one article gets, from this store and its double alike. */
export function articleLiveError() {
  return new HttpError(409, "geo_order_article_live", "The article already has a live order.");
}

/**
 * A project's money from its ledger sums (per order and kind). Per order, the
 * reserve still held is what was reserved less what was released and settled
 * — settled only up to the reserve: an order written off above its reserve
 * (the vendor charged more) counts in full as spent and holds nothing, never
 * a negative reserve that would hide the excess. So
 * `available = budget − reserved − settled + refunded`.
 * @param {{ budget?: { totalCny?: unknown, dailyCny?: unknown } | null } | null | undefined} project
 * @param {Array<{ orderId: string | null, kind: string, amountCny: number }>} sums
 */
export function projectMoney(project, sums) {
  /** @type {Map<string, { reserve: number, release: number, settle: number }>} */
  const byOrder = new Map();
  let settled = 0;
  let refunded = 0;
  for (const row of sums) {
    if (row.kind === "settle") settled += row.amountCny;
    if (row.kind === "refund") refunded += row.amountCny;
    if (row.kind !== "reserve" && row.kind !== "release" && row.kind !== "settle") continue;
    const key = row.orderId ?? "";
    const entry = byOrder.get(key) ?? { reserve: 0, release: 0, settle: 0 };
    entry[/** @type {"reserve" | "release" | "settle"} */ (row.kind)] += row.amountCny;
    byOrder.set(key, entry);
  }
  let reserved = 0;
  for (const entry of byOrder.values()) reserved += entry.reserve - entry.release - Math.min(entry.settle, entry.reserve);
  const budget = project?.budget?.totalCny == null ? null : Number(project.budget.totalCny);
  return {
    budgetCny: budget,
    dailyCny: project?.budget?.dailyCny == null ? null : Number(project.budget.dailyCny),
    reservedCny: round2(reserved),
    settledCny: round2(settled),
    refundedCny: round2(refunded),
    spentCny: round2(settled - refunded),
    availableCny: budget == null ? null : round2(budget - reserved - settled + refunded),
  };
}

/**
 * The day's new commitments from ledger sums since the day began: per order,
 * what was reserved today less what came back today — a reserve released the
 * same day (a refused send, a settlement's remainder) is not the day's spend,
 * and a release of an older reserve does not make room for new ones.
 * @param {Array<{ orderId: string | null, kind: string, amountCny: number }>} sumsSinceDayStart
 */
export function dailyReserved(sumsSinceDayStart) {
  /** @type {Map<string, number>} */
  const net = new Map();
  for (const row of sumsSinceDayStart) {
    if (!row.orderId || (row.kind !== "reserve" && row.kind !== "release")) continue;
    net.set(row.orderId, (net.get(row.orderId) ?? 0) + (row.kind === "reserve" ? row.amountCny : -row.amountCny));
  }
  let total = 0;
  for (const value of net.values()) total += Math.max(0, value);
  return round2(total);
}

/** @param {any} client @param {string} geoProjectId @param {string | null} since */
async function ledgerSumsWith(client, geoProjectId, since) {
  const result = await client.query(`SELECT order_id, kind, sum(amount_cny) AS amount, count(*)::int AS n FROM evimed_geo.ledger
    WHERE geo_project_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2) GROUP BY order_id, kind`, [String(geoProjectId), since]);
  return result.rows.map((/** @type {any} */ row) => ({ orderId: row.order_id ?? null, kind: String(row.kind), amountCny: round2(Number(row.amount)), count: row.n }));
}

/**
 * SQL for the market side of 「循证 GEO」 (build spec §2): the media catalogue,
 * outcomes, orders and their events, the ledger, top-ups and reconciliations,
 * plus the few reads and forward-only writes the market needs on the content
 * side (projects, articles, groups, sources, targets). The DDL is package A's
 * (`geoPersistence.mjs`); this module codes against it.
 *
 * Hidden knowledge:
 *
 * - An order changes state only by compare-and-set (`transitionOrder`): the
 *   UPDATE names the states it may leave, and the event row and the ledger rows
 *   that go with the move are written in the same transaction. A tick and a
 *   route racing on one order cannot both move it; the loser gets `null`.
 * - Every event is kept. Annotations — a send started, a check, an appeal, a
 *   citation — are events whose `from_state` equals `to_state`, so the order's
 *   history is one table and the derived times (`sentAt`, `publishedAt`, …)
 *   are read from it rather than stored twice.
 * - Timestamps are written from the caller's clock (`at`), never from the
 *   database's `now()`: the windows the market enforces (24 h, 10 d, 72 h,
 *   30 days per domain, the day's reserves) are computed from the same clock
 *   the tests drive.
 * - The bounds below are exported and enforced by this store and by its test
 *   double alike (`test/helpers/geoMarketStoreDouble.mjs`): a double that
 *   accepted a limit the database refuses once hid a production 400.
 *
 * @module geoMarketStore
 */

/** Bounds every implementation of this store enforces identically. */
export const GEO_MARKET_STORE_LIMITS = Object.freeze({
  /** Rows one list call may return. */
  listMax: 500,
  /** Media rows one upsert may carry. */
  mediaBatchMax: 500,
  /** Media keys one lookup may name. */
  mediaKeysMax: 1_000,
  /** Candidate media one read may return. */
  candidatesMax: 5_000,
  /** Orders one insert may create. */
  ordersBatchMax: 100,
  /** Ledger rows one transition may write. */
  ledgerRowsMax: 4,
  /** Rows one flow read may return per kind. */
  flowsMax: 10_000,
  /** Serialized size of one event's detail. */
  detailBytesMax: 64 * 1024,
  /** Checks kept on an order. */
  checksMax: 20,
  /** Price changes kept on a media row. */
  priceHistoryMax: 50,
  /** Deepest offset a paged order list may ask for. */
  offsetMax: 100_000,
  /** Largest amount one ledger row may carry (numeric(12,2)). */
  amountMax: 9_999_999_999.99,
});

export const ORDER_STATES = Object.freeze(["planned", "reserved", "submitted", "accepted", "published", "verified", "settled",
  "unknown", "rejected", "cancelled", "refunded", "problem", "lost"]);
export const LEDGER_KINDS = Object.freeze(["budget_set", "reserve", "release", "settle", "refund", "topup_request", "topup_confirmed", "adjustment"]);
export const TOPUP_STATUSES = Object.freeze(["requested", "confirmed", "cancelled"]);
export const ARTICLE_STATUSES = Object.freeze(["draft", "publishable", "placed", "published", "withdrawn"]);
export const MEDIA_TYPES = Object.freeze(["website", "wemedia"]);

let idSequence = 0;

/**
 * An id that sorts in creation order within a process (time, then a counter,
 * then randomness), so rows written in the same millisecond — an order's
 * reserve, its send and its answer — read back in the order they happened.
 * @param {string} prefix
 */
export function orderedId(prefix) {
  idSequence = (idSequence + 1) % 1_679_616;
  return `${prefix}${Date.now().toString(36).padStart(9, "0")}${idSequence.toString(36).padStart(4, "0")}${randomBytes(6).toString("hex")}`;
}

/** Order columns a transition may set, and their SQL names. */
const ORDER_PATCH_COLUMNS = Object.freeze({
  vendorOrderNid: "vendor_order_nid",
  reserveCny: "reserve_cny",
  priceCny: "price_cny",
  settledCny: "settled_cny",
  bodySha256: "body_sha256",
  publishedUrl: "published_url",
  checks: "checks",
  appeal: "appeal",
});
const JSON_ORDER_COLUMNS = new Set(["checks", "appeal"]);

/** @param {string} message */
function storeError(message) {
  return new HttpError(400, "geo_market_store_invalid", message);
}

/** A list limit within bounds. @param {unknown} limit @param {number} max */
export function assertLimit(limit, max) {
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > max) {
    throw storeError(`The list limit must be a whole number from 1 to ${max}.`);
  }
  return Number(limit);
}

/** A list offset within bounds. @param {unknown} offset */
export function assertOffset(offset) {
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > GEO_MARKET_STORE_LIMITS.offsetMax) {
    throw storeError(`The list offset must be a whole number from 0 to ${GEO_MARKET_STORE_LIMITS.offsetMax}.`);
  }
  return Number(offset);
}

/** An amount a ledger row can hold, rounded to the cent. @param {unknown} value */
export function assertAmount(value) {
  const number = Number(value);
  if (typeof value !== "number" || !Number.isFinite(number) || Math.abs(number) > GEO_MARKET_STORE_LIMITS.amountMax) {
    throw storeError("The amount is not a finite number within the ledger's range.");
  }
  return Math.round(number * 100) / 100;
}

/** An event detail within its size bound. @param {unknown} detail */
export function assertDetail(detail) {
  const value = detail ?? {};
  if (typeof value !== "object" || Array.isArray(value)) throw storeError("An event detail is an object.");
  if (Buffer.byteLength(JSON.stringify(value)) > GEO_MARKET_STORE_LIMITS.detailBytesMax) throw storeError("The event detail is too large.");
  return value;
}

/** An ISO timestamp. @param {unknown} value */
export function assertAt(value) {
  const at = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) throw storeError("A timestamp is required.");
  return new Date(at).toISOString();
}

/** @param {unknown} value @param {readonly string[]} vocabulary @param {string} what */
export function assertOneOf(value, vocabulary, what) {
  if (typeof value !== "string" || !vocabulary.includes(value)) throw storeError(`Unknown ${what}.`);
  return value;
}

/** A transition's patch: known keys only, checks bounded. @param {Record<string, any>} patch */
export function assertOrderPatch(patch = {}) {
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(ORDER_PATCH_COLUMNS, key)) throw storeError(`An order transition cannot set ${key}.`);
  }
  if (patch.checks != null && (!Array.isArray(patch.checks) || patch.checks.length > GEO_MARKET_STORE_LIMITS.checksMax)) {
    throw storeError("An order keeps a bounded list of checks.");
  }
  for (const key of ["reserveCny", "priceCny", "settledCny"]) {
    if (patch[key] != null) patch[key] = assertAmount(patch[key]);
  }
  if (patch.appeal != null) assertDetail(patch.appeal);
  return patch;
}

/** A ledger row as the caller describes it, validated. @param {Record<string, any>} row @param {string} at */
export function assertLedgerRow(row, at) {
  return {
    id: row.id ?? orderedId("gl_"),
    userId: row.userId ?? null,
    geoProjectId: row.geoProjectId ?? null,
    orderId: row.orderId ?? null,
    kind: assertOneOf(row.kind, LEDGER_KINDS, "ledger kind"),
    amountCny: assertAmount(row.amountCny),
    note: row.note == null ? null : String(row.note).slice(0, 2_000),
    createdAt: assertAt(row.createdAt ?? at),
  };
}

/** @param {unknown} value */
const iso = (value) => value == null ? null : new Date(/** @type {any} */ (value)).toISOString();
/** @param {unknown} value */
const num = (value) => value == null ? null : Number(value);

/** @param {Record<string, any>} row */
export function mapMedia(row) {
  return {
    resourceId: row.resource_id,
    mediaType: row.media_type,
    name: row.name ?? "",
    domain: row.domain ?? null,
    domainVerified: row.domain_verified ?? null,
    icpOwner: row.icp_owner ?? null,
    fields: row.fields ?? {},
    priceCny: num(row.price_cny),
    publishRate: num(row.publish_rate),
    publishSeconds: row.publish_seconds ?? null,
    remarks: row.remarks ?? "",
    caseLink: row.case_link ?? null,
    flags: row.flags ?? {},
    available: Boolean(row.available),
    blacklisted: Boolean(row.blacklisted),
    blacklistReason: row.blacklist_reason ?? null,
    priceHistory: row.price_history ?? [],
    syncedAt: iso(row.synced_at),
  };
}

/** @param {Record<string, any>} row */
export function mapOrder(row) {
  return {
    id: row.id,
    userId: row.user_id,
    geoProjectId: row.geo_project_id,
    articleId: row.article_id,
    mediaType: row.media_type,
    resourceId: row.resource_id,
    vendorOrderNid: row.vendor_order_nid ?? null,
    state: row.state,
    reserveCny: num(row.reserve_cny),
    priceCny: num(row.price_cny),
    settledCny: num(row.settled_cny),
    bodySha256: row.body_sha256 ?? null,
    publishedUrl: row.published_url ?? null,
    checks: row.checks ?? [],
    appeal: row.appeal ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    sentAt: iso(row.sent_at),
    submittedAt: iso(row.submitted_at),
    acceptedAt: iso(row.accepted_at),
    publishedAt: iso(row.published_at),
    stateAt: iso(row.state_at),
    stateReason: row.state_reason ?? null,
    refundSeenAt: iso(row.refund_seen_at),
  };
}

/** @param {Record<string, any>} row */
export function mapEvent(row) {
  return { id: row.id, orderId: row.order_id, at: iso(row.at), fromState: row.from_state ?? null, toState: row.to_state ?? null, detail: row.detail ?? {} };
}

/** @param {Record<string, any>} row */
export function mapLedger(row) {
  return {
    id: row.id, userId: row.user_id ?? null, geoProjectId: row.geo_project_id ?? null, orderId: row.order_id ?? null,
    kind: row.kind, amountCny: Number(row.amount_cny), note: row.note ?? null, createdAt: iso(row.created_at),
  };
}

/** @param {Record<string, any>} row */
export function mapProject(row) {
  return {
    id: row.id, userId: row.user_id, projectId: row.project_id, product: row.product ?? {}, competitors: row.competitors ?? [],
    engines: row.engines ?? [], tier: row.tier, budget: row.budget ?? null, status: row.status, deletedAt: iso(row.deleted_at),
  };
}

/** @param {Record<string, any>} row */
export function mapArticle(row) {
  return {
    id: row.id, userId: row.user_id, geoProjectId: row.geo_project_id, runId: row.run_id ?? null, deliverableId: row.deliverable_id ?? null,
    path: row.path ?? null, layer: row.layer ?? null, title: row.title ?? "", groupId: row.group_id ?? null, claimIds: row.claim_ids ?? [],
    gate: row.gate ?? null, safety: row.safety ?? null, contentSha256: row.content_sha256 ?? null, protectedSha256: row.protected_sha256 ?? null,
    status: row.status ?? null, isControl: Boolean(row.is_control), createdAt: iso(row.created_at),
  };
}

/** @param {Record<string, any>} row */
export function mapSource(row) {
  return {
    domain: row.domain, name: row.name ?? "", layer: row.layer ?? null, icpMatches: row.icp_matches ?? null, newsIndexed: row.news_indexed ?? null,
    medicalVertical: row.medical_vertical ?? null, impostor: Boolean(row.impostor), blacklistReason: row.blacklist_reason ?? null, cited: row.cited ?? {},
  };
}

/** @param {Record<string, any>} row */
export function mapTopup(row) {
  return {
    id: row.id, amountCny: num(row.amount_cny), status: row.status, balanceBefore: num(row.balance_before), balanceAfter: num(row.balance_after),
    requestedAt: iso(row.requested_at), confirmedAt: iso(row.confirmed_at), note: row.note ?? null,
  };
}

/** @param {Record<string, any>} row */
export function mapReconciliation(row) {
  const day = row.day instanceof Date
    ? `${row.day.getFullYear()}-${String(row.day.getMonth() + 1).padStart(2, "0")}-${String(row.day.getDate()).padStart(2, "0")}`
    : String(row.day);
  return {
    day, ours: num(row.ours), vendor: num(row.vendor), balance: num(row.balance), diff: num(row.diff), status: row.status,
    details: row.details ?? {}, createdAt: iso(row.created_at),
  };
}

const ORDER_SELECT = `SELECT o.*,
  (SELECT max(e.at) FROM evimed_geo.order_events e WHERE e.order_id = o.id AND e.detail->>'phase' = 'send_started') AS sent_at,
  (SELECT min(e.at) FROM evimed_geo.order_events e WHERE e.order_id = o.id AND e.to_state = 'submitted' AND e.from_state IS DISTINCT FROM 'submitted') AS submitted_at,
  (SELECT min(e.at) FROM evimed_geo.order_events e WHERE e.order_id = o.id AND e.to_state = 'accepted' AND e.from_state IS DISTINCT FROM 'accepted') AS accepted_at,
  (SELECT min(e.at) FROM evimed_geo.order_events e WHERE e.order_id = o.id AND e.to_state = 'published' AND e.from_state IS DISTINCT FROM 'published') AS published_at,
  (SELECT max(e.at) FROM evimed_geo.order_events e WHERE e.order_id = o.id AND e.to_state = o.state AND e.from_state IS DISTINCT FROM e.to_state) AS state_at,
  (SELECT e.detail->>'reason' FROM evimed_geo.order_events e WHERE e.order_id = o.id AND e.to_state = o.state AND e.from_state IS DISTINCT FROM e.to_state
    ORDER BY e.at DESC, e.id DESC LIMIT 1) AS state_reason,
  (SELECT min(e.at) FROM evimed_geo.order_events e WHERE e.order_id = o.id AND e.detail->>'phase' = 'refund_seen') AS refund_seen_at
  FROM evimed_geo.orders o`;

const ARTICLE_SELECT = `SELECT a.*, coalesce(g.is_control, false) AS is_control
  FROM evimed_geo.articles a
  LEFT JOIN evimed_geo.question_groups g ON g.id = a.group_id AND g.geo_project_id = a.geo_project_id`;

export class GeoMarketStore {
  /** @param {{ query: (text: string, values?: any[]) => Promise<any>, transaction: (operation: (client: any) => Promise<any>) => Promise<any> }} database */
  constructor(database) {
    this.database = database;
  }

  async ready() {
    await migrateGeo(this.database);
  }

  /** @param {string} text @param {any[]} [values] */
  async #query(text, values = []) {
    await this.ready();
    return this.database.query(text, values);
  }

  /** @param {(client: any) => Promise<any>} operation */
  async #transaction(operation) {
    await this.ready();
    return this.database.transaction(operation);
  }

  // ---------------------------------------------------------------- media

  /** @param {string} mediaType @param {string[]} resourceIds */
  async getMediaRows(mediaType, resourceIds) {
    assertOneOf(mediaType, MEDIA_TYPES, "media type");
    const ids = [...new Set(resourceIds.map(String))];
    if (ids.length > GEO_MARKET_STORE_LIMITS.mediaKeysMax) throw storeError("Too many media keys in one lookup.");
    if (!ids.length) return [];
    const result = await this.#query(`SELECT * FROM evimed_geo.media WHERE media_type = $1 AND resource_id = ANY($2::text[])`, [mediaType, ids]);
    return result.rows.map(mapMedia);
  }

  /**
   * Insert or replace catalogue rows. `flags` merge into the stored flags, so
   * what the platform learned about an outlet (edit incidents, the domain
   * check) survives a resync; every other column is the caller's.
   * @param {Array<ReturnType<typeof mapMedia>>} rows
   */
  async upsertMediaRows(rows) {
    if (rows.length > GEO_MARKET_STORE_LIMITS.mediaBatchMax) throw storeError("Too many media rows in one upsert.");
    if (!rows.length) return 0;
    const payload = rows.map((row) => {
      assertOneOf(row.mediaType, MEDIA_TYPES, "media type");
      if ((row.priceHistory ?? []).length > GEO_MARKET_STORE_LIMITS.priceHistoryMax) throw storeError("A media row keeps a bounded price history.");
      return {
        resource_id: String(row.resourceId), media_type: row.mediaType, name: row.name ?? "", domain: row.domain ?? null,
        domain_verified: row.domainVerified ?? null, icp_owner: row.icpOwner ?? null, fields: row.fields ?? {},
        price_cny: row.priceCny ?? null, publish_rate: row.publishRate ?? null, publish_seconds: row.publishSeconds ?? null,
        remarks: row.remarks ?? "", case_link: row.caseLink ?? null, flags: row.flags ?? {}, available: Boolean(row.available),
        blacklisted: Boolean(row.blacklisted), blacklist_reason: row.blacklistReason ?? null, price_history: row.priceHistory ?? [],
        synced_at: assertAt(row.syncedAt),
      };
    });
    await this.#query(`INSERT INTO evimed_geo.media (resource_id, media_type, name, domain, domain_verified, icp_owner, fields, price_cny,
        publish_rate, publish_seconds, remarks, case_link, flags, available, blacklisted, blacklist_reason, price_history, synced_at)
      SELECT r.resource_id, r.media_type, r.name, r.domain, r.domain_verified, r.icp_owner, r.fields, r.price_cny, r.publish_rate,
        r.publish_seconds, r.remarks, r.case_link, r.flags, r.available, r.blacklisted, r.blacklist_reason, r.price_history, r.synced_at
      FROM jsonb_to_recordset($1::jsonb) AS r(resource_id text, media_type text, name text, domain text, domain_verified boolean,
        icp_owner text, fields jsonb, price_cny numeric, publish_rate numeric, publish_seconds int, remarks text, case_link text,
        flags jsonb, available boolean, blacklisted boolean, blacklist_reason text, price_history jsonb, synced_at timestamptz)
      ON CONFLICT (media_type, resource_id) DO UPDATE SET
        name = EXCLUDED.name, domain = EXCLUDED.domain, domain_verified = EXCLUDED.domain_verified, icp_owner = EXCLUDED.icp_owner,
        fields = EXCLUDED.fields, price_cny = EXCLUDED.price_cny, publish_rate = EXCLUDED.publish_rate,
        publish_seconds = EXCLUDED.publish_seconds, remarks = EXCLUDED.remarks, case_link = EXCLUDED.case_link,
        flags = coalesce(evimed_geo.media.flags, '{}'::jsonb) || coalesce(EXCLUDED.flags, '{}'::jsonb),
        available = EXCLUDED.available, blacklisted = EXCLUDED.blacklisted, blacklist_reason = EXCLUDED.blacklist_reason,
        price_history = EXCLUDED.price_history, synced_at = EXCLUDED.synced_at`, [JSON.stringify(payload)]);
    return rows.length;
  }

  /** Rows of one media type a complete sync did not see are no longer on offer. @param {string} mediaType @param {string} before */
  async markUnseenMediaUnavailable(mediaType, before) {
    assertOneOf(mediaType, MEDIA_TYPES, "media type");
    const result = await this.#query(`UPDATE evimed_geo.media SET available = false
      WHERE media_type = $1 AND (synced_at IS NULL OR synced_at < $2) AND available IS DISTINCT FROM false`, [mediaType, assertAt(before)]);
    return result.rowCount ?? 0;
  }

  /** Media on offer, not blacklisted, priced at most `maxPriceCny`. @param {{ maxPriceCny: number, limit: number }} options */
  async listCandidateMedia({ maxPriceCny, limit }) {
    assertLimit(limit, GEO_MARKET_STORE_LIMITS.candidatesMax);
    const result = await this.#query(`SELECT * FROM evimed_geo.media
      WHERE available AND NOT coalesce(blacklisted, false) AND price_cny IS NOT NULL AND price_cny <= $1
      ORDER BY media_type, resource_id LIMIT $2`, [assertAmount(maxPriceCny), limit]);
    return result.rows.map(mapMedia);
  }

  /**
   * Record a domain check, or any other learned flag, on one outlet.
   * @param {{ mediaType: string, resourceId: string, domainVerified?: boolean | null, flags?: Record<string, any>,
   *   blacklisted?: boolean, blacklistReason?: string | null }} update
   */
  async updateMediaFlags({ mediaType, resourceId, domainVerified, flags = {}, blacklisted, blacklistReason }) {
    assertOneOf(mediaType, MEDIA_TYPES, "media type");
    assertDetail(flags);
    const result = await this.#query(`UPDATE evimed_geo.media SET
        flags = coalesce(flags, '{}'::jsonb) || $3::jsonb,
        domain_verified = CASE WHEN $4::boolean IS NULL AND NOT $5::boolean THEN domain_verified ELSE $4::boolean END,
        blacklisted = coalesce($6::boolean, blacklisted),
        blacklist_reason = CASE WHEN $6::boolean IS NULL THEN blacklist_reason ELSE $7 END
      WHERE media_type = $1 AND resource_id = $2`,
    [mediaType, String(resourceId), JSON.stringify(flags), domainVerified ?? null, domainVerified !== undefined,
      blacklisted ?? null, blacklistReason ?? null]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Add one to a counter in an outlet's flags (`editIncidents`). @param {string} mediaType @param {string} resourceId @param {string} key */
  async incrementMediaFlag(mediaType, resourceId, key) {
    assertOneOf(mediaType, MEDIA_TYPES, "media type");
    if (!/^[a-zA-Z]{1,40}$/.test(key)) throw storeError("A flag counter is named by letters.");
    const result = await this.#query(`UPDATE evimed_geo.media SET
        flags = jsonb_set(coalesce(flags, '{}'::jsonb), ARRAY[$3::text], to_jsonb(coalesce((flags->>$3)::int, 0) + 1))
      WHERE media_type = $1 AND resource_id = $2 RETURNING (flags->>$3)::int AS value`, [mediaType, String(resourceId), key]);
    return result.rows[0]?.value ?? null;
  }

  /** @param {Array<{ mediaType: string, resourceId: string }>} keys */
  async getMediaOutcomes(keys) {
    if (keys.length > GEO_MARKET_STORE_LIMITS.mediaKeysMax) throw storeError("Too many media keys in one lookup.");
    if (!keys.length) return [];
    const result = await this.#query(`SELECT o.* FROM evimed_geo.media_outcomes o
      JOIN jsonb_to_recordset($1::jsonb) AS k(media_type text, resource_id text) ON k.media_type = o.media_type AND k.resource_id = o.resource_id`,
    [JSON.stringify(keys.map((key) => ({ media_type: key.mediaType, resource_id: String(key.resourceId) })))]);
    return result.rows.map((row) => ({ mediaType: row.media_type, resourceId: row.resource_id, engine: row.engine, placed: row.placed ?? 0, cited: row.cited ?? 0 }));
  }

  /** @param {{ mediaType: string, resourceId: string, engine: string, placed?: number, cited?: number, at: string }} change */
  async incrementMediaOutcome({ mediaType, resourceId, engine, placed = 0, cited = 0, at }) {
    assertOneOf(mediaType, MEDIA_TYPES, "media type");
    if (!/^[a-z]{2,20}$/.test(engine)) throw storeError("An engine is named by lower-case letters.");
    if (![placed, cited].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000)) throw storeError("Outcome increments are small whole numbers.");
    await this.#query(`INSERT INTO evimed_geo.media_outcomes (media_type, resource_id, engine, placed, cited, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (media_type, resource_id, engine) DO UPDATE SET
        placed = coalesce(evimed_geo.media_outcomes.placed, 0) + EXCLUDED.placed,
        cited = coalesce(evimed_geo.media_outcomes.cited, 0) + EXCLUDED.cited, updated_at = EXCLUDED.updated_at`,
    [mediaType, String(resourceId), engine, placed, cited, assertAt(at)]);
  }

  // ------------------------------------------------- projects and content

  /** @param {{ geoProjectId: string, userId?: string }} key */
  async getProject({ geoProjectId, userId }) {
    const result = await this.#query(`SELECT * FROM evimed_geo.projects WHERE id = $1 AND ($2::text IS NULL OR user_id = $2) AND deleted_at IS NULL`,
      [String(geoProjectId), userId ?? null]);
    return result.rows[0] ? mapProject(result.rows[0]) : null;
  }

  /**
   * Projects with a distribution budget: active ones (to place orders), or
   * every one not deleted (to reconcile — a paused project still has money out).
   * @param {number} limit @param {{ activeOnly?: boolean }} [options]
   */
  async listBudgetedProjects(limit, { activeOnly = true } = {}) {
    assertLimit(limit, GEO_MARKET_STORE_LIMITS.listMax);
    const result = await this.#query(`SELECT * FROM evimed_geo.projects
      WHERE budget IS NOT NULL AND ($2::boolean IS FALSE OR status = 'active') AND deleted_at IS NULL ORDER BY created_at, id LIMIT $1`,
    [limit, activeOnly]);
    return result.rows.map(mapProject);
  }

  /**
   * Set a project's budget and write the `budget_set` row in one transaction.
   * @param {{ geoProjectId: string, userId: string, budget: Record<string, any>, ledgerRow: Record<string, any>, at: string }} change
   */
  async setProjectBudget({ geoProjectId, userId, budget, ledgerRow, at }) {
    const when = assertAt(at);
    const row = assertLedgerRow({ ...ledgerRow, kind: "budget_set", userId, geoProjectId }, when);
    return this.#transaction(async (client) => {
      const updated = await client.query(`UPDATE evimed_geo.projects SET budget = $3::jsonb, updated_at = $4
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING *`, [String(geoProjectId), String(userId), JSON.stringify(budget), when]);
      if (!updated.rows[0]) return null;
      await insertLedger(client, [row]);
      return mapProject(updated.rows[0]);
    });
  }

  /** Articles that may be placed: publishable, placed or published. @param {string} geoProjectId @param {number} limit */
  async listPlaceableArticles(geoProjectId, limit) {
    assertLimit(limit, GEO_MARKET_STORE_LIMITS.listMax);
    const result = await this.#query(`${ARTICLE_SELECT}
      WHERE a.geo_project_id = $1 AND a.status IN ('publishable', 'placed', 'published') ORDER BY a.created_at, a.id LIMIT $2`,
    [String(geoProjectId), limit]);
    return result.rows.map(mapArticle);
  }

  /** @param {string[]} ids */
  async getArticles(ids) {
    const unique = [...new Set(ids.map(String))];
    if (unique.length > GEO_MARKET_STORE_LIMITS.listMax) throw storeError("Too many articles in one lookup.");
    if (!unique.length) return [];
    const result = await this.#query(`${ARTICLE_SELECT} WHERE a.id = ANY($1::text[])`, [unique]);
    return result.rows.map(mapArticle);
  }

  /** Move an article forward (placed, published); never backward. @param {string} articleId @param {string[]} from @param {string} to @param {string} at */
  async advanceArticleStatus(articleId, from, to, at) {
    assertOneOf(to, ARTICLE_STATUSES, "article status");
    for (const state of from) assertOneOf(state, ARTICLE_STATUSES, "article status");
    const result = await this.#query(`UPDATE evimed_geo.articles SET status = $3, updated_at = $4 WHERE id = $1 AND status = ANY($2::text[])`,
      [String(articleId), from, to, assertAt(at)]);
    return (result.rowCount ?? 0) > 0;
  }

  /** @param {string} geoProjectId @param {string[]} domains */
  async getSources(geoProjectId, domains) {
    const unique = [...new Set(domains.map(String))];
    if (unique.length > GEO_MARKET_STORE_LIMITS.mediaKeysMax) throw storeError("Too many domains in one lookup.");
    if (!unique.length) return [];
    const result = await this.#query(`SELECT * FROM evimed_geo.sources WHERE geo_project_id = $1 AND domain = ANY($2::text[])`,
      [String(geoProjectId), unique]);
    return result.rows.map(mapSource);
  }

  /** The chosen tier's budget in the latest targets version, or null. @param {string} geoProjectId @param {string} tier */
  async suggestedBudget(geoProjectId, tier) {
    const result = await this.#query(`SELECT max(budget_cny) AS budget FROM evimed_geo.targets
      WHERE geo_project_id = $1 AND tier = $2 AND version = (SELECT max(version) FROM evimed_geo.targets WHERE geo_project_id = $1)`,
    [String(geoProjectId), String(tier)]);
    return num(result.rows[0]?.budget);
  }

  // -------------------------------------------------------------- orders

  /**
   * Create orders, each with its first event (→ `planned`), in one transaction.
   * @param {Array<{ id?: string, userId: string, geoProjectId: string, articleId: string, mediaType: string, resourceId: string,
   *   priceCny: number, reserveCny: number, detail?: Record<string, any> }>} orders
   * @param {string} at
   */
  async insertOrders(orders, at) {
    if (orders.length > GEO_MARKET_STORE_LIMITS.ordersBatchMax) throw storeError("Too many orders in one insert.");
    const when = assertAt(at);
    const rows = orders.map((order) => ({
      id: order.id ?? orderedId("go_"),
      userId: String(order.userId),
      geoProjectId: String(order.geoProjectId),
      articleId: String(order.articleId),
      mediaType: assertOneOf(order.mediaType, MEDIA_TYPES, "media type"),
      resourceId: String(order.resourceId),
      priceCny: assertAmount(order.priceCny),
      reserveCny: assertAmount(order.reserveCny),
      detail: assertDetail(order.detail ?? {}),
    }));
    if (!rows.length) return [];
    try {
      return await this.#transaction(async (client) => {
        const created = [];
        for (const row of rows) {
          const inserted = await client.query(`INSERT INTO evimed_geo.orders (id, user_id, geo_project_id, article_id, media_type, resource_id,
              state, reserve_cny, price_cny, checks, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, 'planned', $7, $8, '[]'::jsonb, $9, $9) RETURNING *`,
          [row.id, row.userId, row.geoProjectId, row.articleId, row.mediaType, row.resourceId, row.reserveCny, row.priceCny, when]);
          await insertEvent(client, { orderId: row.id, at: when, fromState: null, toState: "planned", detail: row.detail });
          created.push(mapOrder(inserted.rows[0]));
        }
        return created;
      });
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "23505" && /** @type {any} */ (error)?.constraint === ARTICLE_LIVE_INDEX) throw articleLiveError();
      throw error;
    }
  }

  /**
   * planned → reserved and the send's start, in one transaction: nothing can
   * fail between holding the money and marking the order in flight, and a
   * second writer (a cancel, another placer) finds either a planned order or
   * one already being sent. The budget and the day's cap are checked here,
   * against the ledger as it stands inside the transaction, under the
   * project's row lock — a budget lowered a moment ago is the one that holds.
   * @param {string} orderId
   * @param {{ at: string, dayStart: string, reserveDetail?: Record<string, any>, sendDetail: Record<string, any>, patch?: Record<string, any> }} move
   * @returns {Promise<{ order: ReturnType<typeof mapOrder> } | { refused: "budget_exhausted" | "daily_cap_reached" | "project_missing" } | null>}
   *   null when the order was not planned any more
   */
  async reserveForSend(orderId, { at, dayStart, reserveDetail = {}, sendDetail, patch = {} }) {
    const when = assertAt(at);
    const since = assertAt(dayStart);
    assertDetail(reserveDetail);
    assertDetail(sendDetail);
    assertOrderPatch(patch);
    return this.#transaction(async (client) => {
      const current = await client.query(`SELECT * FROM evimed_geo.orders WHERE id = $1 FOR UPDATE`, [String(orderId)]);
      const row = current.rows[0];
      if (!row || row.state !== "planned") return null;
      const project = await client.query(`SELECT budget FROM evimed_geo.projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [row.geo_project_id]);
      if (!project.rows[0]) return { refused: "project_missing" };
      const reserve = Number(row.reserve_cny);
      const money = projectMoney({ budget: project.rows[0].budget }, await ledgerSumsWith(client, row.geo_project_id, null));
      if (money.availableCny == null || money.availableCny + EPSILON_CNY < reserve) return { refused: "budget_exhausted" };
      if (money.dailyCny != null && dailyReserved(await ledgerSumsWith(client, row.geo_project_id, since)) + reserve > money.dailyCny + EPSILON_CNY) {
        return { refused: "daily_cap_reached" };
      }
      const sets = ["state = 'reserved'", "updated_at = $2"];
      const values = [String(orderId), when];
      for (const [key, value] of Object.entries(patch)) {
        const column = ORDER_PATCH_COLUMNS[/** @type {keyof typeof ORDER_PATCH_COLUMNS} */ (key)];
        values.push(JSON_ORDER_COLUMNS.has(column) ? JSON.stringify(value) : value);
        sets.push(`${column} = $${values.length}${JSON_ORDER_COLUMNS.has(column) ? "::jsonb" : ""}`);
      }
      await client.query(`UPDATE evimed_geo.orders SET ${sets.join(", ")} WHERE id = $1`, values);
      await insertEvent(client, { orderId: String(orderId), at: when, fromState: "planned", toState: "reserved", detail: reserveDetail });
      await insertEvent(client, { orderId: String(orderId), at: when, fromState: "reserved", toState: "reserved", detail: { ...sendDetail, phase: "send_started" } });
      await insertLedger(client, [assertLedgerRow({ kind: "reserve", amountCny: reserve, userId: row.user_id, geoProjectId: row.geo_project_id,
        orderId: String(orderId) }, when)]);
      const updated = await client.query(`${ORDER_SELECT} WHERE o.id = $1`, [String(orderId)]);
      return { order: mapOrder(updated.rows[0]) };
    });
  }

  /**
   * Run `operation` holding the project's market lock, or not at all: a second
   * process (or a second tick) finds the project busy and leaves it for the
   * next tick. A session advisory lock on its own connection, released when
   * the operation ends or the connection dies.
   * @template T @param {string} geoProjectId @param {() => Promise<T>} operation
   * @returns {Promise<{ locked: true, value: T } | { locked: false }>}
   */
  async withProjectLock(geoProjectId, operation) {
    await this.ready();
    const key = `evimed_geo_market:${geoProjectId}`;
    return /** @type {any} */ (this.database).withClient(async (/** @type {any} */ client) => {
      const got = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [key]);
      if (!got.rows[0]?.locked) return { locked: false };
      try {
        return { locked: true, value: await operation() };
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [key]).catch(() => {});
      }
    });
  }

  /**
   * Move an order from one of `from` to `to`, with its event and ledger rows,
   * atomically. `null` when the order was not in one of `from` any more.
   * @param {string} orderId
   * @param {{ from: string[], to: string, at: string, patch?: Record<string, any>, detail?: Record<string, any>,
   *   ledger?: Array<Record<string, any>> }} move
   */
  async transitionOrder(orderId, { from, to, at, patch = {}, detail = {}, ledger = [] }) {
    const when = assertAt(at);
    assertOneOf(to, ORDER_STATES, "order state");
    for (const state of from) assertOneOf(state, ORDER_STATES, "order state");
    assertOrderPatch(patch);
    assertDetail(detail);
    if (ledger.length > GEO_MARKET_STORE_LIMITS.ledgerRowsMax) throw storeError("Too many ledger rows for one transition.");
    const rows = ledger.map((row) => assertLedgerRow({ ...row, orderId }, when));
    try {
      return await this.#transaction((client) => this.#move(client, { orderId, from, to, when, patch, detail, rows }));
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "23505" && /** @type {any} */ (error)?.constraint === ARTICLE_LIVE_INDEX) throw articleLiveError();
      throw error;
    }
  }

  /**
   * The body of `transitionOrder`, inside its transaction.
   * @param {any} client
   * @param {{ orderId: string, from: string[], to: string, when: string, patch: Record<string, any>, detail: Record<string, any>, rows: any[] }} move
   */
  async #move(client, { orderId, from, to, when, patch, detail, rows }) {
    const sets = ["state = $3", "updated_at = $4"];
    const values = [String(orderId), from, to, when];
    for (const [key, value] of Object.entries(patch)) {
      const column = ORDER_PATCH_COLUMNS[/** @type {keyof typeof ORDER_PATCH_COLUMNS} */ (key)];
      values.push(JSON_ORDER_COLUMNS.has(column) ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}${JSON_ORDER_COLUMNS.has(column) ? "::jsonb" : ""}`);
    }
    const current = await client.query(`SELECT state FROM evimed_geo.orders WHERE id = $1 FOR UPDATE`, [String(orderId)]);
    const fromState = current.rows[0]?.state;
    if (!fromState || !from.includes(fromState)) return null;
    await client.query(`UPDATE evimed_geo.orders SET ${sets.join(", ")} WHERE id = $1 AND state = ANY($2::text[])`, values);
    await insertEvent(client, { orderId: String(orderId), at: when, fromState, toState: to, detail });
    await insertLedger(client, rows.map((row) => ({ ...row, userId: row.userId ?? null })));
    const updated = await client.query(`${ORDER_SELECT} WHERE o.id = $1`, [String(orderId)]);
    return mapOrder(updated.rows[0]);
  }

  /**
   * An event that does not move the order (a send started, a check, an
   * appeal, a citation), optionally with an order patch (checks, appeal).
   * `expectState` makes it a compare-and-set: null when the order is not in
   * that state.
   * @param {string} orderId @param {{ at: string, detail: Record<string, any>, patch?: Record<string, any>, expectState?: string }} note
   */
  async annotateOrder(orderId, { at, detail, patch = {}, expectState }) {
    const when = assertAt(at);
    assertDetail(detail);
    assertOrderPatch(patch);
    if (expectState != null) assertOneOf(expectState, ORDER_STATES, "order state");
    for (const key of ["vendorOrderNid", "reserveCny", "settledCny"]) {
      if (Object.hasOwn(patch, key)) throw storeError(`An annotation cannot set ${key}.`);
    }
    return this.#transaction(async (client) => {
      const current = await client.query(`SELECT state FROM evimed_geo.orders WHERE id = $1 FOR UPDATE`, [String(orderId)]);
      const state = current.rows[0]?.state;
      if (!state || (expectState != null && state !== expectState)) return null;
      const sets = ["updated_at = $2"];
      const values = [String(orderId), when];
      for (const [key, value] of Object.entries(patch)) {
        const column = ORDER_PATCH_COLUMNS[/** @type {keyof typeof ORDER_PATCH_COLUMNS} */ (key)];
        values.push(JSON_ORDER_COLUMNS.has(column) ? JSON.stringify(value) : value);
        sets.push(`${column} = $${values.length}${JSON_ORDER_COLUMNS.has(column) ? "::jsonb" : ""}`);
      }
      await client.query(`UPDATE evimed_geo.orders SET ${sets.join(", ")} WHERE id = $1`, values);
      return insertEvent(client, { orderId: String(orderId), at: when, fromState: state, toState: state, detail });
    });
  }

  /** @param {string} orderId */
  async getOrder(orderId) {
    const result = await this.#query(`${ORDER_SELECT} WHERE o.id = $1`, [String(orderId)]);
    return result.rows[0] ? mapOrder(result.rows[0]) : null;
  }

  /**
   * @param {{ geoProjectId?: string, userId?: string, states?: string[], ids?: string[], articleIds?: string[],
   *   hasVendorNid?: boolean, mediaType?: string, resourceId?: string, publishedUrl?: string, createdSince?: string,
   *   updatedSince?: string, limit: number, offset?: number, newestFirst?: boolean }} filter
   */
  async listOrders(filter) {
    const limit = assertLimit(filter.limit, GEO_MARKET_STORE_LIMITS.listMax);
    const offset = assertOffset(filter.offset ?? 0);
    for (const state of filter.states ?? []) assertOneOf(state, ORDER_STATES, "order state");
    const where = [];
    const values = [];
    const add = (/** @type {string} */ clause, /** @type {any} */ value) => { values.push(value); where.push(clause.replace("?", `$${values.length}`)); };
    if (filter.geoProjectId != null) add("o.geo_project_id = ?", String(filter.geoProjectId));
    if (filter.userId != null) add("o.user_id = ?", String(filter.userId));
    if (filter.states) add("o.state = ANY(?::text[])", filter.states);
    if (filter.ids) add("o.id = ANY(?::text[])", filter.ids.map(String));
    if (filter.articleIds) add("o.article_id = ANY(?::text[])", filter.articleIds.map(String));
    if (filter.hasVendorNid === true) where.push("o.vendor_order_nid IS NOT NULL");
    if (filter.hasVendorNid === false) where.push("o.vendor_order_nid IS NULL");
    if (filter.mediaType != null) add("o.media_type = ?", filter.mediaType);
    if (filter.resourceId != null) add("o.resource_id = ?", String(filter.resourceId));
    if (filter.publishedUrl != null) add("o.published_url = ?", String(filter.publishedUrl));
    if (filter.createdSince != null) add("o.created_at >= ?", assertAt(filter.createdSince));
    if (filter.updatedSince != null) add("o.updated_at >= ?", assertAt(filter.updatedSince));
    values.push(limit, offset);
    const direction = filter.newestFirst ? "DESC" : "ASC";
    const result = await this.#query(`${ORDER_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY o.created_at ${direction}, o.id ${direction} LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return result.rows.map(mapOrder);
  }

  /** @param {string} orderId @param {number} limit */
  async listOrderEvents(orderId, limit) {
    assertLimit(limit, GEO_MARKET_STORE_LIMITS.listMax);
    const result = await this.#query(`SELECT * FROM evimed_geo.order_events WHERE order_id = $1 ORDER BY at, id LIMIT $2`, [String(orderId), limit]);
    return result.rows.map(mapEvent);
  }

  // -------------------------------------------------------------- ledger

  /**
   * Ledger sums per order and kind for one project (budget rows included under
   * a null order id), optionally only rows at or after `since`.
   * @param {{ geoProjectId: string, since?: string }} filter
   * @returns {Promise<Array<{ orderId: string | null, kind: string, amountCny: number, count: number }>>}
   */
  async ledgerSums({ geoProjectId, since }) {
    await this.ready();
    return ledgerSumsWith(this.database, geoProjectId, since == null ? null : assertAt(since));
  }

  /** Platform rows (no project): top-up requests and confirmations, adjustments. @param {Array<Record<string, any>>} rows @param {string} at */
  async insertPlatformLedgerRows(rows, at) {
    if (rows.length > GEO_MARKET_STORE_LIMITS.ledgerRowsMax) throw storeError("Too many ledger rows in one write.");
    const checked = rows.map((row) => assertLedgerRow({ ...row, userId: null, geoProjectId: null, orderId: null }, assertAt(at)));
    await this.#transaction((client) => insertLedger(client, checked));
    return checked.length;
  }

  /**
   * Money that moved the vendor balance since `since`: orders the vendor
   * accepted (charged), refunds seen, top-ups confirmed, platform adjustments.
   * @param {string} since
   */
  async platformFlowsSince(since) {
    const at = assertAt(since);
    const max = GEO_MARKET_STORE_LIMITS.flowsMax;
    const [charges, refunds, topups, adjustments] = await Promise.all([
      this.#query(`SELECT o.id, o.price_cny, e.at FROM evimed_geo.order_events e JOIN evimed_geo.orders o ON o.id = e.order_id
        WHERE e.to_state = 'submitted' AND e.from_state IS DISTINCT FROM 'submitted' AND e.at > $1 ORDER BY e.at LIMIT $2`, [at, max]),
      this.#query(`SELECT e.order_id, e.detail, e.at FROM evimed_geo.order_events e
        WHERE e.to_state = 'refunded' AND e.from_state IS DISTINCT FROM 'refunded' AND e.at > $1 ORDER BY e.at LIMIT $2`, [at, max]),
      this.#query(`SELECT id, amount_cny, confirmed_at FROM evimed_geo.topups WHERE status = 'confirmed' AND confirmed_at > $1
        ORDER BY confirmed_at LIMIT $2`, [at, max]),
      this.#query(`SELECT id, amount_cny, created_at FROM evimed_geo.ledger
        WHERE kind = 'adjustment' AND geo_project_id IS NULL AND order_id IS NULL AND created_at > $1 ORDER BY created_at LIMIT $2`, [at, max]),
    ]);
    return {
      charges: charges.rows.map((row) => ({ orderId: row.id, amountCny: Number(row.price_cny ?? 0), at: iso(row.at) })),
      refunds: refunds.rows.map((row) => ({ orderId: row.order_id, amountCny: Number(row.detail?.amountCny ?? 0), at: iso(row.at) })),
      topups: topups.rows.map((row) => ({ id: row.id, amountCny: Number(row.amount_cny ?? 0), at: iso(row.confirmed_at) })),
      adjustments: adjustments.rows.map((row) => ({ id: row.id, amountCny: Number(row.amount_cny), at: iso(row.created_at) })),
    };
  }

  // ------------------------------------------------------------ top-ups

  /** @param {{ id?: string, amountCny: number, balanceBefore: number, at: string, note?: string }} request */
  async insertTopup({ id = orderedId("gt_"), amountCny, balanceBefore, at, note }) {
    const when = assertAt(at);
    const amountValue = assertAmount(amountCny);
    const ledger = assertLedgerRow({ kind: "topup_request", amountCny: amountValue, note: `topup ${id}` }, when);
    return this.#transaction(async (client) => {
      const inserted = await client.query(`INSERT INTO evimed_geo.topups (id, amount_cny, status, balance_before, requested_at, note)
        VALUES ($1, $2, 'requested', $3, $4, $5) RETURNING *`, [id, amountValue, assertAmount(balanceBefore), when, note ?? null]);
      await insertLedger(client, [ledger]);
      return mapTopup(inserted.rows[0]);
    });
  }

  /**
   * Move a top-up out of `from`; confirming writes the `topup_confirmed` row.
   * @param {string} id
   * @param {{ from: string, to: string, at: string, amountCny?: number, balanceAfter?: number, note?: string }} change
   */
  async updateTopup(id, { from, to, at, amountCny, balanceAfter, note }) {
    assertOneOf(from, TOPUP_STATUSES, "top-up status");
    assertOneOf(to, TOPUP_STATUSES, "top-up status");
    const when = assertAt(at);
    return this.#transaction(async (client) => {
      const updated = await client.query(`UPDATE evimed_geo.topups SET status = $3,
          amount_cny = coalesce($4, amount_cny), balance_after = coalesce($5, balance_after),
          confirmed_at = CASE WHEN $3 = 'confirmed' THEN $6::timestamptz ELSE confirmed_at END, note = coalesce($7, note)
        WHERE id = $1 AND status = $2 RETURNING *`,
      [String(id), from, to, amountCny == null ? null : assertAmount(amountCny), balanceAfter == null ? null : assertAmount(balanceAfter),
        when, note == null ? null : String(note).slice(0, 2_000)]);
      const row = updated.rows[0];
      if (!row) return null;
      if (to === "confirmed") {
        await insertLedger(client, [assertLedgerRow({ kind: "topup_confirmed", amountCny: Number(row.amount_cny), note: `topup ${id}` }, when)]);
      }
      return mapTopup(row);
    });
  }

  /** Record what an operator said without moving the top-up. @param {string} id @param {string} note */
  async noteTopup(id, note) {
    const result = await this.#query(`UPDATE evimed_geo.topups SET note = $2 WHERE id = $1 RETURNING *`, [String(id), String(note).slice(0, 2_000)]);
    return result.rows[0] ? mapTopup(result.rows[0]) : null;
  }

  /** @param {{ status?: string, limit: number }} filter */
  async listTopups({ status, limit }) {
    assertLimit(limit, GEO_MARKET_STORE_LIMITS.listMax);
    if (status != null) assertOneOf(status, TOPUP_STATUSES, "top-up status");
    const result = await this.#query(`SELECT * FROM evimed_geo.topups WHERE ($1::text IS NULL OR status = $1)
      ORDER BY requested_at DESC, id LIMIT $2`, [status ?? null, limit]);
    return result.rows.map(mapTopup);
  }

  /** @param {string} id */
  async getTopup(id) {
    const result = await this.#query(`SELECT * FROM evimed_geo.topups WHERE id = $1`, [String(id)]);
    return result.rows[0] ? mapTopup(result.rows[0]) : null;
  }

  // ---------------------------------------------------- reconciliations

  async latestReconciliation() {
    const result = await this.#query(`SELECT * FROM evimed_geo.reconciliations ORDER BY day DESC LIMIT 1`);
    return result.rows[0] ? mapReconciliation(result.rows[0]) : null;
  }

  /** @param {number} limit */
  async listReconciliations(limit) {
    assertLimit(limit, GEO_MARKET_STORE_LIMITS.listMax);
    const result = await this.#query(`SELECT * FROM evimed_geo.reconciliations ORDER BY day DESC LIMIT $1`, [limit]);
    return result.rows.map(mapReconciliation);
  }

  /**
   * One day's reconciliation; a second run the same day replaces the first.
   * @param {{ day: string, ours: number, vendor: number, balance: number, diff: number, status: "ok" | "mismatch",
   *   details: Record<string, any>, at: string }} row
   */
  async upsertReconciliation({ day, ours, vendor, balance, diff, status, details, at }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw storeError("A reconciliation day is YYYY-MM-DD.");
    assertOneOf(status, ["ok", "mismatch"], "reconciliation status");
    assertDetail(details);
    const result = await this.#query(`INSERT INTO evimed_geo.reconciliations (day, ours, vendor, balance, diff, status, details, created_at)
      VALUES ($1::date, $2, $3, $4, $5, $6, $7::jsonb, $8)
      ON CONFLICT (day) DO UPDATE SET ours = EXCLUDED.ours, vendor = EXCLUDED.vendor, balance = EXCLUDED.balance, diff = EXCLUDED.diff,
        status = EXCLUDED.status, details = EXCLUDED.details, created_at = EXCLUDED.created_at RETURNING *`,
    [day, assertAmount(ours), assertAmount(vendor), assertAmount(balance), assertAmount(diff), status, JSON.stringify(details), assertAt(at)]);
    return mapReconciliation(result.rows[0]);
  }

  /** Merge into one day's details (an operator clearing a stop). @param {string} day @param {Record<string, any>} patch */
  async patchReconciliationDetails(day, patch) {
    assertDetail(patch);
    const result = await this.#query(`UPDATE evimed_geo.reconciliations SET details = coalesce(details, '{}'::jsonb) || $2::jsonb
      WHERE day = $1::date RETURNING *`, [String(day), JSON.stringify(patch)]);
    return result.rows[0] ? mapReconciliation(result.rows[0]) : null;
  }
}

/** @param {any} client @param {{ orderId: string, at: string, fromState: string | null, toState: string, detail: Record<string, any> }} event */
async function insertEvent(client, { orderId, at, fromState, toState, detail }) {
  const result = await client.query(`INSERT INTO evimed_geo.order_events (id, order_id, at, from_state, to_state, detail)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`, [orderedId("ge_"), orderId, at, fromState, toState, JSON.stringify(detail ?? {})]);
  return mapEvent(result.rows[0]);
}

/** @param {any} client @param {Array<ReturnType<typeof assertLedgerRow>>} rows */
async function insertLedger(client, rows) {
  for (const row of rows) {
    await client.query(`INSERT INTO evimed_geo.ledger (id, user_id, geo_project_id, order_id, kind, amount_cny, note, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [row.id, row.userId, row.geoProjectId, row.orderId, row.kind, row.amountCny, row.note, row.createdAt]);
  }
}
