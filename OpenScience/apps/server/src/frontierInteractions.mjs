import { randomUUID } from "node:crypto";
import { FRONTIER_INTERACTION_BATCH, FRONTIER_LIST_SURFACES, FRONTIER_SLOTS, frontierInteraction, frontierItemGenre } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/**
 * What readers of 「前沿动态」 did, and what each of them was served (ct-track, 2026-10-24).
 *
 * Two append-only tables: `list_serves`, one row per list answer a reader was given — its server-made `list_id`, the
 * surface, the ranking policy that made it, and each entry in served order with its slot, score and (for the one
 * exploration entry) the probability it was drawn with; and `interactions`, one row per event the reader's page reported
 * (`@evimed/domain` `frontierInteractions.mjs`: impressions that mean seen, opens with the list, slot and position they came
 * from, dwell and read depth that survive tab switches and closes, the actions). An impression or an open joins the list it
 * was shown in by `list_id`; a reading page's events join their open by `view_id`. That is what lets a ranking be evaluated
 * later — click-through by slot and position, inverse-propensity estimates over the exploration entry — without a guess.
 *
 * Hidden knowledge:
 *
 * - **The route is sendBeacon-friendly.** A page that is closing can only send one fire-and-forget request, without
 *   headers: the body may be `text/plain` JSON and may carry the CSRF token as `csrf`, which the dispatch moves into the
 *   header the one CSRF check reads (`server.mjs`) — so there is still exactly one CSRF implementation. The page sends
 *   with `fetch(…, { keepalive: true })` and the header where it can, and falls back to the beacon.
 * - **Idempotent on the client's event id.** A batch retried after a lost answer, or re-sent from the tab's queue after a
 *   reload, inserts nothing twice: `UNIQUE (user_id, client_id)`, `ON CONFLICT DO NOTHING`, and the answer counts the
 *   duplicates.
 * - **Kept honest, never trusted.** Each event passes the domain validator; what fails is dropped and counted by reason.
 *   An item id that names no item is dropped; a list id that is not one of this reader's serves is kept as no list (the
 *   event still happened, it just joins nothing). The genre is the item's at the time (`frontierItemGenre`), written on the
 *   row, so a later re-genre does not rewrite yesterday's click-through by genre.
 * - **Bounded.** At most 50 events and 64 KiB a request (the beacon's own limit) and `frontierEventsPerMinute` events a
 *   reader a minute (`OPEN_SCIENCE_FRONTIER_EVENTS_PER_MINUTE`, a resource limit, not an opinion: one reader scrolling a long
 *   feed reports well under a hundred); past it the request is a 429 and the page keeps its queue for later.
 * - **Recording never fails reading.** A list whose serve cannot be written is answered without a `listId` (counted); an
 *   event the table refuses is a 5xx the page retries. Nothing here is text a reader sees.
 * - **Kept 180 days** (`FRONTIER_INTERACTION_RETENTION_DAYS`): two seasons of reading is what a ranking is judged on; the
 *   worker's hourly retention pass removes older rows of both tables in bounded batches.
 * - **Nothing personal beyond the account.** No URL, no query text, no IP or device string: the account (the session's), a
 *   tab's random session id, the layout class (`narrow` / `wide`), closed words, public ids and numbers.
 *
 * The genre reading rule (contract A): `items.genre` where written, else `@evimed/domain` `frontierGenreFallback` — written
 * once, here, and imported by the ranking.
 *
 * Which model capability would make it deletable: none — these are records of what happened.
 *
 * @module frontierInteractions
 */

/** How long both tables keep a row. */
export const FRONTIER_INTERACTION_RETENTION_DAYS = 180;
/** The events route, which the dispatch reads before its CSRF check (the beacon's token travels in the body). */
export const FRONTIER_EVENTS_PATH = "/api/frontier/events";
/** Events one reader may report a minute (`OPEN_SCIENCE_FRONTIER_EVENTS_PER_MINUTE`). */
export const FRONTIER_EVENTS_PER_MINUTE_DEFAULT = 300;
/** The most entries one serve records: a feed page is at most 50, an issue a few dozen. */
const MAX_SERVE_ENTRIES = 200;
/** The server's own outcomes beside the domain's drop reasons. */
const SERVER_OUTCOMES = Object.freeze(["accepted", "duplicate", "unknown-item", "foreign-list", "rate-limited"]);

/** The two tables, appended to the frontier schema (`frontierPersistence.mjs`). Closed words are checked in code, as the schema's are. */
export const FRONTIER_INTERACTIONS_SQL = `
-- ct-track 2026-10-24: what each reader was served, and what they did with it (frontierInteractions.mjs).
CREATE TABLE IF NOT EXISTS evimed_frontier.list_serves (
  list_id   uuid PRIMARY KEY,
  user_id   text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  surface   text NOT NULL,
  policy    text NOT NULL CHECK (char_length(policy) BETWEEN 1 AND 200),
  editorial text CHECK (char_length(editorial) <= 200),
  entries   jsonb NOT NULL,
  served_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS frontier_list_serves_user_idx ON evimed_frontier.list_serves (user_id, served_at DESC);
CREATE INDEX IF NOT EXISTS frontier_list_serves_time_idx ON evimed_frontier.list_serves (served_at);
CREATE TABLE IF NOT EXISTS evimed_frontier.interactions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  client_id       text NOT NULL CHECK (char_length(client_id) BETWEEN 8 AND 64),
  type            text NOT NULL,
  surface         text NOT NULL,
  item_id         bigint REFERENCES evimed_frontier.items(id) ON DELETE CASCADE,
  event_public_id text CHECK (char_length(event_public_id) <= 64),
  genre           text,
  list_id         uuid,
  slot            text,
  position        smallint,
  value           integer,
  detail          text CHECK (char_length(detail) <= 40),
  session_id      text NOT NULL CHECK (char_length(session_id) BETWEEN 8 AND 64),
  view_id         text CHECK (char_length(view_id) <= 64),
  device          text,
  client_at       timestamptz(3) NOT NULL,
  received_at     timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS frontier_interactions_user_idx ON evimed_frontier.interactions (user_id, client_at DESC);
CREATE INDEX IF NOT EXISTS frontier_interactions_item_idx ON evimed_frontier.interactions (item_id, client_at DESC) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS frontier_interactions_list_idx ON evimed_frontier.interactions (list_id) WHERE list_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS frontier_interactions_view_idx ON evimed_frontier.interactions (view_id) WHERE view_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS frontier_interactions_time_idx ON evimed_frontier.interactions (client_at);
`;

/** The item's genre: `@evimed/domain` `frontierItemGenre`, the one reading rule (re-exported for this module's importers). */
export { frontierItemGenre };

/** The columns `frontierItemGenre` reads, for a query that selects them. */
export const FRONTIER_GENRE_COLUMNS = "i.genre, i.platform, i.channel, i.source_type, i.evidence_type, i.flags, i.safety_alert, i.lane";

/**
 * One entry of a serve as recorded: an item or an event, its slot, its score and — for the exploration entry — the
 * probability it was drawn with. Anything else is left off.
 * @param {{ item?: unknown, event?: unknown, slot?: unknown, score?: unknown, propensity?: unknown }} entry
 */
export function frontierServeEntry(entry) {
  const slot = typeof entry?.slot === "string" && /** @type {readonly string[]} */ (FRONTIER_SLOTS).includes(entry.slot) ? entry.slot : null;
  const number = (/** @type {unknown} */ value, /** @type {number} */ digits) => (typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 10 ** digits) / 10 ** digits : null);
  const propensity = number(entry?.propensity, 6);
  return {
    ...(typeof entry?.item === "string" ? { item: entry.item } : { event: String(entry?.event ?? "") }),
    slot,
    score: number(entry?.score, 4),
    propensity: propensity !== null && propensity > 0 && propensity <= 1 ? propensity : null,
  };
}

export class FrontierInteractions {
  /**
   * @param {{ database: any, config?: Record<string, any>, now?: () => Date }} options
   *   `config.frontierEventsPerMinute` the per-reader limit (the default when absent).
   */
  constructor({ database, config = {}, now = () => new Date() }) {
    if (!database) throw new TypeError("The frontier interactions need the product database.");
    this.database = database;
    this.now = now;
    const limit = Number(config.frontierEventsPerMinute);
    this.perMinute = Number.isSafeInteger(limit) && limit > 0 ? limit : FRONTIER_EVENTS_PER_MINUTE_DEFAULT;
    /** @type {Map<string, { count: number, resetAt: number }>} reader → this minute's events */
    this.windows = new Map();
    /** Observable counters (principle 15): events by outcome — accepted, duplicate, each drop reason — and the serves. */
    this.counters = { batches: 0, serves: 0, serveFailures: 0, /** @type {Record<string, number>} */ events: {} };
    /** @type {string | null} */
    this.lastError = null;
  }

  /** @param {string} outcome @param {number} [count] */
  #count(outcome, count = 1) {
    if (count > 0) this.counters.events[outcome] = (this.counters.events[outcome] ?? 0) + count;
  }

  /**
   * Charge `count` events to the reader's minute; past the limit nothing of the batch is kept and the page is told when to
   * try again.
   * @param {string} userId @param {number} count
   */
  #admit(userId, count) {
    const at = this.now().getTime();
    const current = this.windows.get(userId);
    const window = !current || current.resetAt <= at ? { count: 0, resetAt: at + 60_000 } : current;
    if (window.count + count > this.perMinute) {
      this.#count("rate-limited", count);
      throw new HttpError(429, "frontier_events_rate_limited", "Too many frontier events.", { retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - at) / 1000)) });
    }
    window.count += count;
    this.windows.set(userId, window);
    if (this.windows.size > 10_000) for (const [key, value] of this.windows) if (value.resetAt <= at) this.windows.delete(key);
  }

  /**
   * Record a batch the reader's page sent (`POST /api/frontier/events`).
   * @param {{ id: string }} user @param {any} body `{ events: [...] }` (a `csrf` field was consumed by the dispatch)
   * @returns {Promise<{ accepted: number, duplicates: number, dropped: Record<string, number> }>}
   */
  async record(user, body) {
    const events = body?.events;
    if (!Array.isArray(events) || events.length < 1 || events.length > FRONTIER_INTERACTION_BATCH.maxEvents) {
      throw new HttpError(400, "frontier_events_invalid", `A batch holds 1 to ${FRONTIER_INTERACTION_BATCH.maxEvents} events.`);
    }
    this.counters.batches += 1;
    const now = this.now().getTime();
    /** @type {Record<string, number>} */
    const dropped = {};
    const drop = (/** @type {string} */ reason) => { dropped[reason] = (dropped[reason] ?? 0) + 1; this.#count(reason); };
    /** @type {import("@evimed/domain").FrontierInteraction[]} */
    const valid = [];
    const seen = new Set();
    for (const raw of events) {
      const result = frontierInteraction(raw, { now });
      if (result.ok === false) { drop(result.reason); continue; }
      // The same id twice in one batch is one event.
      if (seen.has(result.event.id)) { drop("duplicate"); continue; }
      seen.add(result.event.id);
      valid.push(result.event);
    }
    if (!valid.length) return { accepted: 0, duplicates: dropped.duplicate ?? 0, dropped };
    this.#admit(user.id, valid.length);
    const itemIds = [...new Set(valid.flatMap((event) => (event.item ? [event.item] : [])))];
    const items = itemIds.length ? new Map(((await this.database.query(`SELECT i.id, i.public_id, ${FRONTIER_GENRE_COLUMNS}
      FROM evimed_frontier.items i WHERE i.public_id = ANY($1::text[])`, [itemIds])).rows ?? []).map((/** @type {any} */ row) => [row.public_id, row])) : new Map();
    const listIds = [...new Set(valid.flatMap((event) => (event.list ? [event.list] : [])))];
    const lists = listIds.length ? new Set(((await this.database.query(`SELECT list_id::text AS list_id FROM evimed_frontier.list_serves
      WHERE user_id = $1 AND list_id = ANY($2::uuid[])`, [user.id, listIds])).rows ?? []).map((/** @type {any} */ row) => String(row.list_id))) : new Set();
    const rows = [];
    for (const event of valid) {
      const item = event.item ? items.get(event.item) : null;
      if (event.item && !item) { drop("unknown-item"); continue; }
      const list = event.list && lists.has(event.list) ? event.list : null;
      if (event.list && !list) this.#count("foreign-list");
      rows.push({ client_id: event.id, type: event.type, surface: event.surface, item_id: item ? String(item.id) : null, event_public_id: event.event,
        genre: item ? frontierItemGenre(item) : null, list_id: list, slot: list ? event.slot : null, position: event.position, value: event.value,
        detail: event.detail, session_id: event.session, view_id: event.view, device: event.device, at: event.at });
    }
    if (!rows.length) return { accepted: 0, duplicates: dropped.duplicate ?? 0, dropped };
    const inserted = (await this.database.query(`INSERT INTO evimed_frontier.interactions (user_id, client_id, type, surface, item_id, event_public_id,
        genre, list_id, slot, position, value, detail, session_id, view_id, device, client_at)
      SELECT $1, r.client_id, r.type, r.surface, r.item_id, r.event_public_id, r.genre, r.list_id, r.slot, r.position, r.value, r.detail, r.session_id,
        r.view_id, r.device, to_timestamp(r.at / 1000.0)
      FROM jsonb_to_recordset($2::jsonb) AS r(client_id text, type text, surface text, item_id bigint, event_public_id text, genre text, list_id uuid,
        slot text, position smallint, value integer, detail text, session_id text, view_id text, device text, at bigint)
      ON CONFLICT (user_id, client_id) DO NOTHING RETURNING id`, [user.id, JSON.stringify(rows)])).rowCount ?? 0;
    const duplicates = rows.length - inserted;
    this.#count("accepted", inserted);
    this.#count("duplicate", duplicates);
    return { accepted: inserted, duplicates: duplicates + (dropped.duplicate ?? 0), dropped: Object.fromEntries(Object.entries(dropped).filter(([reason]) => reason !== "duplicate")) };
  }

  /**
   * Record one list answer and return its id, or `null` when it could not be written (the list is answered anyway).
   * @param {string} userId
   * @param {{ surface: string, policy: string, editorial?: string | null, entries: Array<{ item?: string, event?: string, slot?: string | null, score?: number | null, propensity?: number | null }> }} serve
   * @returns {Promise<string | null>}
   */
  async serve(userId, { surface, policy, editorial = null, entries }) {
    if (!(/** @type {readonly string[]} */ (FRONTIER_LIST_SURFACES)).includes(surface)) throw new TypeError(`Unknown list surface: ${surface}`);
    const listId = randomUUID();
    try {
      await this.database.query(`INSERT INTO evimed_frontier.list_serves (list_id, user_id, surface, policy, editorial, entries)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [listId, userId, surface, String(policy).slice(0, 200), editorial == null ? null : String(editorial).slice(0, 200),
        JSON.stringify((Array.isArray(entries) ? entries : []).slice(0, MAX_SERVE_ENTRIES).map(frontierServeEntry))]);
      this.counters.serves += 1;
      return listId;
    } catch (error) {
      this.counters.serveFailures += 1;
      this.lastError = typeof (/** @type {any} */ (error))?.code === "string" ? /** @type {any} */ (error).code : "frontier_serve_failed";
      return null;
    }
  }

  status() {
    return { perMinute: this.perMinute, lastError: this.lastError, counters: { ...this.counters, events: { ...this.counters.events } } };
  }

  /** The Prometheus families of the route and the serves, in the shape `addMetric` takes. */
  metricFamilies() {
    const outcomes = [...new Set([...SERVER_OUTCOMES, ...Object.keys(this.counters.events)])].sort();
    return [
      { name: "open_science_frontier_events_total", help: "Reader events the frontier received, by outcome: accepted, duplicate, rate-limited, unknown-item, foreign-list, or the drop reason.",
        type: /** @type {const} */ ("counter"), series: outcomes.map((outcome) => ({ labels: { outcome }, value: this.counters.events[outcome] ?? 0 })) },
      { name: "open_science_frontier_event_batches_total", help: "Event batches the frontier received.", type: /** @type {const} */ ("counter"),
        series: [{ value: this.counters.batches }] },
      { name: "open_science_frontier_list_serves_total", help: "List answers recorded with a list id, and the ones that could not be (answered without one).",
        type: /** @type {const} */ ("counter"), series: [{ labels: { outcome: "recorded" }, value: this.counters.serves }, { labels: { outcome: "failed" }, value: this.counters.serveFailures }] },
    ];
  }
}
