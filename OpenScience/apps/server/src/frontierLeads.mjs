/**
 * Lead triggers (「前沿动态」, ct-mix 2026-10-24): the control plane decides when the feed goes looking for material, asks
 * the platform's web-search gateway, and hands the pages it found to the knowledge plugin.
 *
 * The plugin reads registered sources and grows them by discovery (its candidate lines: outbound links, MEDLINE journals,
 * directories, the origins of hot entries, quoted accounts, the source-request manifest, publishers' feeds, re-checks);
 * nothing made the feed look for a story it had heard of and did not have, or for the kind of item 精选 is short of. This
 * module is that trigger, and only that: what to search for and when (`@evimed/domain` `frontierLeadWatch.mjs` holds the
 * data and the pure decisions), the search through the gateway, and the addresses posted to the plugin
 * (`POST /v1/leads`, contract 1.6.0). The plugin reads each page under its own rules — robots, pacing, its readers; a
 * WeChat link's text bought within the shared Dajiala cap — emits ordinary entries on its stream, and names each page's
 * site or account a discovery candidate (line `lead`). The plugin still never calls the platform and makes no model call;
 * this module makes no model call either.
 *
 * Hidden knowledge:
 *
 * - **The triggers** (`FRONTIER_LEAD_TRIGGERS`): the standing watches once a day from `FRONTIER_LEAD_WATCH_HOUR` in the
 *   feed's zone — this week's most-selected tags, each specialty's most frequent entity, a congress in its window (the
 *   calendar in the domain), the Chinese regulatory and industry watch; and the follow-ups through the day — a genre group
 *   under its floor yesterday, an event that entered the hot list, a selected item with no Chinese report in its event, a
 *   selected news or industry item with no primary source in its event. A missing primary source named by an identifier
 *   (a DOI, a PMID, a trial number) is an address handed over as it is, never a search.
 * - **The budget.** A day's searches are capped (`OPEN_SCIENCE_FRONTIER_LEADS_DAILY_QUERIES`, 120), split by trigger
 *   (`FRONTIER_LEAD_SHARES`: the watches half, the follow-ups half, so neither starves the other), at most
 *   `LEADS_PER_TICK` a tick. Each paid engine's call is booked under purpose `frontier` to the feed's internal project and
 *   held to the module's daily budget (the gateway's `createWebSearch`, `gatewaySpend.mjs`); no search is made while the
 *   day's budget is not `ok` (throttled or spent: leads are never urgent).
 * - **Dedupe.** A query is made once a day per trigger (`leads` is unique on day, trigger and the query's key); a result
 *   already in the feed (its canonical address, or its `url:` key) or already handed over (`lead_urls`) is not handed over
 *   again; the plugin is idempotent on the address besides.
 * - **Nothing here is shown to a reader.** The tables and the counters (`status()`, the metrics) are for operators.
 * - **A failure degrades.** A search that fails records its code and the next query goes on; a plugin that does not answer
 *   leaves the results recorded and unsent (`outcome: unsent`), and they are not retried — tomorrow's watch searches again.
 *
 * @module frontierLeads
 */

import { createHash } from "node:crypto";
import {
  FRONTIER_LEAD_GENRE_QUERIES,
  FRONTIER_LEAD_REGULATORY_WATCH,
  FRONTIER_LEAD_RESULTS_PER_QUERY,
  FRONTIER_MIX_COUNTED_RULES,
  FRONTIER_MIX_DAY,
  FRONTIER_MIX_GROUPS,
  FRONTIER_SPECIALTIES,
  frontierActiveCongresses,
  frontierIdentifierLeads,
  frontierLeadPlaces,
  frontierLeadQueryKey,
  frontierLeadSkipHost,
  frontierMixGenre,
  frontierMixGroup,
} from "@evimed/domain";
import { isChineseTitle } from "./frontierEditor.mjs";
import { frontierDayWindow } from "./frontierPipeline.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The default cap of a day's searches (`OPEN_SCIENCE_FRONTIER_LEADS_DAILY_QUERIES`; config.mjs holds the same number). */
export const FRONTIER_LEADS_DAILY_QUERIES_DEFAULT = 120;
/** Searches one tick makes at most: the worker ticks the module every `FRONTIER_LEADS_CHECK_MS`, so a day's cap spreads out. */
export const LEADS_PER_TICK = 12;
/** How often the worker asks the module whether a search is due. */
export const FRONTIER_LEADS_CHECK_MS = 15 * MINUTE;
/** The hour (feed's zone) from which the day's standing watches and the genre-gap search run: after a working morning's notices. */
export const FRONTIER_LEAD_WATCH_HOUR = 9;
/** How far back the follow-ups look for selected items, and how long the tables keep a lead. */
const FOLLOW_UP_WINDOW_MS = 2 * DAY;
const RETENTION_MS = 90 * DAY;
/** Addresses one post to the plugin carries at most (the contract's bound). */
export const LEADS_PER_POST = 50;
/** A Chinese query from a title: at most this many characters (an engine's query is short; DeepSeek's is 128). */
const TITLE_QUERY_CHARS = 40;
const ENGLISH_QUERY_CHARS = 110;

export const FRONTIER_LEADS_SQL = `
CREATE SCHEMA IF NOT EXISTS evimed_frontier;
-- ct-mix 2026-10-24: lead triggers. One row per search the feed made (kind 'search') or per primary source it handed over
-- by its address (kind 'address'): why (trigger, subject), what (query or url), when, what came of it (status, results,
-- what the plugin answered) and its reference cost. Operators read it; no reader does.
CREATE TABLE IF NOT EXISTS evimed_frontier.leads (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day         date NOT NULL,
  trigger     text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('search', 'address')),
  query       text,
  query_key   text NOT NULL,
  url         text,
  subject     jsonb NOT NULL DEFAULT '{}'::jsonb,
  made_at     timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  status      text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'searched', 'sent', 'empty', 'failed')),
  status_code text,
  results     jsonb NOT NULL DEFAULT '[]'::jsonb,
  sent        integer NOT NULL DEFAULT 0,
  accepted    integer NOT NULL DEFAULT 0,
  cost_cny    numeric(10, 4) NOT NULL DEFAULT 0,
  UNIQUE (day, trigger, query_key)
);
CREATE INDEX IF NOT EXISTS frontier_leads_made_idx ON evimed_frontier.leads (made_at);
-- Every address handed to the plugin, once: what the plugin answered (accepted, duplicate, refused, capped) or unsent.
CREATE TABLE IF NOT EXISTS evimed_frontier.lead_urls (
  url_sha256 text PRIMARY KEY,
  url        text NOT NULL,
  lead_id    bigint REFERENCES evimed_frontier.leads(id) ON DELETE SET NULL,
  trigger    text NOT NULL,
  sent_at    timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  outcome    text NOT NULL CHECK (outcome IN ('accepted', 'duplicate', 'refused', 'capped', 'unsent'))
);
CREATE INDEX IF NOT EXISTS frontier_lead_urls_sent_idx ON evimed_frontier.lead_urls (sent_at);
`;

const migrations = new WeakMap();

/** The two tables, under the feed's migration lock. @param {any} database */
export async function migrateFrontierLeads(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-frontier-v1'))");
    await client.query(FRONTIER_LEADS_SQL);
  });
  migrations.set(database, attempt);
  try { await attempt; } catch (error) { migrations.delete(database); throw error; }
  return attempt;
}

/** @param {string} value */
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
/** An address as the feed's keys name it (`entryKeys`: `url:<sha256>`). @param {string} url */
const urlKey = (url) => `url:${sha256(url)}`;

/** A public http(s) address without its fragment, or null. @param {unknown} value */
export function frontierLeadUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let parsed;
  try { parsed = new URL(value.trim()); } catch { return null; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname.includes(".")) return null;
  parsed.hash = "";
  return parsed.toString();
}

/** A title cut to a query's length at a character boundary. @param {unknown} text @param {number} limit */
function clip(text, limit) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return [...value].slice(0, limit).join("").trim();
}

/**
 * @typedef {{ trigger: string, kind: "search", query: string, language: string | null, timeRange: "day" | "week",
 *   subject: Record<string, unknown>, excludeHost?: string | null, chineseOnly?: boolean } | { trigger: string, kind: "address", url: string,
 *   subject: Record<string, unknown> }} FrontierLeadPlan
 *   `chineseOnly`: hand over only results whose title is written in Chinese (a `zh-report` looks for a Chinese report; the
 *   engines answer a Chinese query with English pages too — the trial searches of 2026-10-24).
 */

export class FrontierLeads {
  /**
   * @param {{ database: any, plugin: any, webSearch?: { search: (body: Record<string, unknown>, context: { caller: any }) => Promise<any> } | null,
   *   owner: () => ({ userId: string, projectId: string } | null), budget?: (() => Promise<{ state: string, budgetCny?: number }>) | null,
   *   config?: Record<string, any>, now?: () => Date }} dependencies
   *   `plugin` offers `submitLeads(leads)` (`KnowledgePluginClient`); `webSearch` is the gateway's search (`createWebSearch`);
   *   `owner` the feed's internal project the searches are booked to; `budget` the pipeline's day budget.
   */
  constructor({ database, plugin, webSearch = null, owner, budget = null, config = {}, now = () => new Date() }) {
    if (!database) throw new TypeError("The frontier leads need the product database.");
    this.database = database;
    this.plugin = plugin;
    this.webSearch = webSearch && typeof webSearch.search === "function" ? webSearch : null;
    this.owner = typeof owner === "function" ? owner : () => null;
    this.budget = typeof budget === "function" ? budget : null;
    this.config = config ?? {};
    this.now = now;
    this.timeZone = String(this.config.frontierTimeZone || this.config.frontierTimezone || "Asia/Shanghai");
    this.enabled = this.config.frontierLeadsEnabled !== false;
    const cap = Number(this.config.frontierLeadsDailyQueries);
    this.dailyQueries = this.config.frontierLeadsDailyQueries != null && this.config.frontierLeadsDailyQueries !== "" && Number.isInteger(cap) && cap >= 0
      ? cap : FRONTIER_LEADS_DAILY_QUERIES_DEFAULT;
    this.budgetCny = Number(this.config.frontierDailyBudgetCny) > 0 ? Number(this.config.frontierDailyBudgetCny) : 0;
    /** Observable counters (principle 15): searches by trigger, what they found, what the plugin answered, failures by code. */
    this.counters = {
      ticks: 0, searches: /** @type {Record<string, number>} */ ({}), addresses: 0, results: 0, newUrls: 0, sent: 0,
      plugin: /** @type {Record<string, number>} */ ({ accepted: 0, duplicate: 0, refused: 0, capped: 0, unsent: 0 }),
      failures: /** @type {Record<string, number>} */ ({}), skipped: /** @type {Record<string, number>} */ ({}),
    };
    /** @type {{ at: string, searched: number, sent: number, skipped?: string } | null} */
    this.lastTick = null;
    /** The feed's day the retention last ran on. @type {string | null} */
    this.retainedDay = null;
  }

  /** Whether the module can search at all: switched on, a search and a plugin to hand to. */
  get configured() {
    return this.enabled && Boolean(this.webSearch) && typeof this.plugin?.submitLeads === "function" && this.plugin?.configured !== false;
  }

  /**
   * One tick (the worker's `leads` loop): the retention once a day, then the leads due now, at most `LEADS_PER_TICK`
   * searches, each searched, filtered and handed over. Returns what it did.
   * @returns {Promise<{ searched: number, addresses: number, sent: number, skipped?: string }>}
   */
  async tick() {
    const now = this.now();
    this.counters.ticks += 1;
    /** @param {string} reason */
    const skip = (reason) => {
      this.counters.skipped[reason] = (this.counters.skipped[reason] ?? 0) + 1;
      this.lastTick = { at: now.toISOString(), searched: 0, sent: 0, skipped: reason };
      return { searched: 0, addresses: 0, sent: 0, skipped: reason };
    };
    if (!this.configured) return skip(!this.enabled ? "disabled" : "unconfigured");
    const owner = this.owner();
    if (!owner?.userId || !owner?.projectId) return skip("no_owner");
    await migrateFrontierLeads(this.database);
    const { day } = frontierDayWindow(now, this.timeZone);
    if (this.retainedDay !== day) {
      await this.database.query("DELETE FROM evimed_frontier.lead_urls WHERE sent_at < $1", [new Date(now.getTime() - RETENTION_MS)]);
      await this.database.query("DELETE FROM evimed_frontier.leads WHERE made_at < $1", [new Date(now.getTime() - RETENTION_MS)]);
      this.retainedDay = day;
    }
    const plans = await this.plan(now);
    const budget = this.budget ? await this.budget().catch(() => ({ state: "unavailable" })) : { state: "ok" };
    const caller = { userId: owner.userId, projectId: owner.projectId, runId: null, purpose: "frontier", moduleLimit: this.budgetCny };
    let searched = 0;
    let addresses = 0;
    let sent = 0;
    for (const plan of plans) {
      if (plan.kind === "address") {
        const lead = await this.#claim(day, plan, plan.url);
        if (!lead) continue;
        addresses += 1;
        this.counters.addresses += 1;
        sent += await this.#handOver(lead, plan.trigger, [{ url: plan.url, title: null, snippet: null, publishedDate: null }], null);
        continue;
      }
      if (searched >= LEADS_PER_TICK) break;
      if (budget.state !== "ok") { skip(`budget_${budget.state}`); break; }
      const lead = await this.#claim(day, plan, plan.query);
      if (!lead) continue;
      searched += 1;
      this.counters.searches[plan.trigger] = (this.counters.searches[plan.trigger] ?? 0) + 1;
      let answer;
      try {
        answer = await /** @type {any} */ (this.webSearch).search({ query: plan.query, limit: 10, timeRange: plan.timeRange,
          ...(plan.language ? { language: plan.language } : {}) }, { caller });
      } catch (error) {
        const code = typeof (/** @type {any} */ (error))?.code === "string" ? /** @type {any} */ (error).code : "frontier_lead_search_failed";
        this.counters.failures[code] = (this.counters.failures[code] ?? 0) + 1;
        await this.database.query("UPDATE evimed_frontier.leads SET status = 'failed', status_code = $2 WHERE id = $1", [lead.id, code.slice(0, 80)]);
        continue;
      }
      const rows = Array.isArray(answer?.data?.results) ? answer.data.results : [];
      this.counters.results += rows.length;
      const engines = Array.isArray(answer?.data?.engines) ? answer.data.engines : [];
      await this.database.query("UPDATE evimed_frontier.leads SET status = 'searched', cost_cny = $2 WHERE id = $1", [lead.id, frontierLeadCost(engines)]);
      sent += await this.#handOver(lead, plan.trigger, plan.chineseOnly ? rows.filter((row) => isChineseTitle(row?.title)) : rows, plan.excludeHost ?? null);
    }
    this.lastTick = { at: now.toISOString(), searched, sent };
    return { searched, addresses, sent };
  }

  /**
   * What is due now, in the order it is searched: the address leads first (they cost no search), then each trigger's
   * queries within what is left of its share of the day's cap. A query already made today under its trigger is left out.
   * @param {Date} [now] @returns {Promise<FrontierLeadPlan[]>}
   */
  async plan(now = this.now()) {
    await migrateFrontierLeads(this.database);
    const window = frontierDayWindow(now, this.timeZone);
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: this.timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
    const watching = hour >= FRONTIER_LEAD_WATCH_HOUR;
    const made = (await this.database.query(`SELECT trigger, kind, query_key FROM evimed_frontier.leads WHERE day = $1`, [window.day])).rows;
    const done = new Set(made.map((row) => `${row.trigger}\u0000${row.query_key}`));
    /** @type {Record<string, number>} */
    const used = {};
    for (const row of made) if (row.kind === "search") used[row.trigger] = (used[row.trigger] ?? 0) + 1;
    const places = frontierLeadPlaces(this.dailyQueries);
    /** @type {FrontierLeadPlan[]} */
    const plans = [];
    const room = (/** @type {string} */ trigger) => (places[trigger] ?? 0) - (used[trigger] ?? 0) - plans.filter((plan) => plan.trigger === trigger && plan.kind === "search").length;
    /** @param {FrontierLeadPlan} plan */
    const add = (plan) => {
      const key = plan.kind === "search" ? frontierLeadQueryKey(plan.query) : plan.url;
      if (!key || done.has(`${plan.trigger}\u0000${key}`)) return;
      if (plan.kind === "search" && room(plan.trigger) < 1) return;
      done.add(`${plan.trigger}\u0000${key}`);
      plans.push(plan);
    };
    const since = new Date(now.getTime() - FOLLOW_UP_WINDOW_MS);
    // Primary sources first: an identifier is an address, the rest a search for the item's own words.
    for (const lead of await this.#primarySources(since)) add(lead);
    for (const lead of await this.#hotEvents()) add(lead);
    for (const lead of await this.#chineseReports(since)) add(lead);
    if (watching) {
      for (const entry of FRONTIER_LEAD_REGULATORY_WATCH) add({ trigger: "regulatory-watch", kind: "search", query: entry.query, language: "zh-CN", timeRange: "day", subject: { why: entry.why } });
      for (const congress of frontierActiveCongresses(window.day)) {
        for (const query of [congress.keywords_zh[0], congress.keywords_en[0]].filter(Boolean)) {
          add({ trigger: "congress", kind: "search", query, language: /[一-鿿]/u.test(query) ? "zh-CN" : "en", timeRange: "day", subject: { congress: congress.id } });
        }
      }
      for (const lead of await this.#hotTags(now)) add(lead);
      for (const lead of await this.#specialties(now)) add(lead);
      for (const lead of await this.#genreGaps(now)) add(lead);
    }
    return plans;
  }

  /** Insert the lead's row, or nothing when another tick (or control plane) made it today. @param {string} day @param {FrontierLeadPlan} plan @param {string} key */
  async #claim(day, plan, key) {
    const row = (await this.database.query(`INSERT INTO evimed_frontier.leads (day, trigger, kind, query, query_key, url, subject, made_at, status)
      VALUES ($1::date, $2, $3, $4, $5, $6, $7::jsonb, $8, 'planned') ON CONFLICT (day, trigger, query_key) DO NOTHING RETURNING id`,
    [day, plan.trigger, plan.kind, plan.kind === "search" ? plan.query : null, plan.kind === "search" ? frontierLeadQueryKey(key) : key,
      plan.kind === "address" ? plan.url : null, JSON.stringify(plan.subject ?? {}), this.now()])).rows[0];
    return row ? { id: String(row.id) } : null;
  }

  /**
   * The results the feed does not have, handed to the plugin: at most `FRONTIER_LEAD_RESULTS_PER_QUERY`, none from
   * `excludeHost` (the report's own site), none the feed already has or already handed over. Records what the plugin
   * answered for each, and the lead's outcome. Returns how many were accepted.
   * @param {{ id: string }} lead @param {string} trigger @param {any[]} rows @param {string | null} excludeHost
   */
  async #handOver(lead, trigger, rows, excludeHost) {
    /** @type {Array<{ url: string, title: string | null, snippet: string | null, publishedDate: string | null }>} */
    const fresh = [];
    const seen = new Set();
    for (const row of rows) {
      const url = frontierLeadUrl(row?.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const host = new URL(url).hostname;
      if ((excludeHost && host.replace(/^www\./, "") === excludeHost) || frontierLeadSkipHost(host)) continue;
      fresh.push({ url, title: typeof row.title === "string" ? row.title.slice(0, 300) : null,
        snippet: typeof row.snippet === "string" ? row.snippet.slice(0, 700) : null,
        publishedDate: typeof row.publishedDate === "string" ? row.publishedDate : null });
    }
    const urls = fresh.map((entry) => entry.url);
    const known = new Set();
    if (urls.length) {
      for (const row of (await this.database.query(`SELECT canonical_url AS url FROM evimed_frontier.items WHERE md5(canonical_url) = ANY($1::text[])
          UNION SELECT u.url FROM evimed_frontier.lead_urls u WHERE u.url_sha256 = ANY($2::text[])`,
      [urls.map((url) => createHash("md5").update(url).digest("hex")), urls.map(sha256)])).rows) known.add(row.url);
      for (const row of (await this.database.query("SELECT key FROM evimed_frontier.item_keys WHERE key = ANY($1::text[])", [urls.map(urlKey)])).rows) {
        const match = urls.find((url) => urlKey(url) === row.key);
        if (match) known.add(match);
      }
    }
    const handed = fresh.filter((entry) => !known.has(entry.url)).slice(0, FRONTIER_LEAD_RESULTS_PER_QUERY);
    this.counters.newUrls += handed.length;
    /** @type {Map<string, string>} */
    const outcomes = new Map(handed.map((entry) => [entry.url, "unsent"]));
    let failure = null;
    if (handed.length) {
      try {
        const answer = await this.plugin.submitLeads(handed.map((entry) => ({ url: entry.url, trigger,
          ...(entry.title ? { title: entry.title } : {}), ...(entry.snippet ? { snippet: entry.snippet } : {}),
          ...(entry.publishedDate && Number.isFinite(Date.parse(entry.publishedDate)) ? { published_hint: new Date(entry.publishedDate).toISOString() } : {}) })));
        for (const result of Array.isArray(answer?.results) ? answer.results : []) {
          if (outcomes.has(result?.url) && ["accepted", "duplicate", "refused", "capped"].includes(result?.status)) outcomes.set(result.url, result.status);
        }
        this.counters.sent += handed.length;
      } catch (error) {
        failure = typeof (/** @type {any} */ (error))?.code === "string" ? /** @type {any} */ (error).code : "frontier_lead_plugin_failed";
        this.counters.failures[failure] = (this.counters.failures[failure] ?? 0) + 1;
      }
    }
    for (const [url, outcome] of outcomes) {
      this.counters.plugin[outcome] = (this.counters.plugin[outcome] ?? 0) + 1;
      await this.database.query(`INSERT INTO evimed_frontier.lead_urls (url_sha256, url, lead_id, trigger, outcome) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (url_sha256) DO NOTHING`, [sha256(url), url, lead.id, trigger, outcome]);
    }
    const accepted = [...outcomes.values()].filter((outcome) => outcome === "accepted").length;
    const results = fresh.map((entry) => ({ url: entry.url, title: entry.title, publishedDate: entry.publishedDate,
      known: known.has(entry.url), outcome: outcomes.get(entry.url) ?? null }));
    await this.database.query(`UPDATE evimed_frontier.leads SET status = $2, status_code = $3, results = $4::jsonb, sent = $5, accepted = $6 WHERE id = $1`,
      [lead.id, failure ? "failed" : handed.length ? "sent" : "empty", failure, JSON.stringify(results), failure ? 0 : handed.length, accepted]);
    return accepted;
  }

  /**
   * `primary-source`: selected news and industry items of the window whose event holds no primary report. An identifier
   * the feed does not have is handed over as its address; without one, the item's own title is searched (the report's own
   * site left out of the results), a newsroom's release for an industry item.
   * @param {Date} since @returns {Promise<FrontierLeadPlan[]>}
   */
  async #primarySources(since) {
    const rows = (await this.database.query(`SELECT i.id, i.public_id, i.title_raw, i.canonical_url, i.doi, i.pmid, i.registry_ids, i.genre, i.platform,
        i.channel, i.source_type, i.evidence_type, i.flags, i.safety_alert, i.lane, left(coalesce(t.body_text, t.abstract_raw, t.body_excerpt, ''), 20000) AS text
      FROM evimed_frontier.items i LEFT JOIN evimed_frontier.item_texts t ON t.item_id = i.id
      WHERE i.state = 'published' AND i.selected AND i.timeline_at >= $1
        AND NOT EXISTS (SELECT 1 FROM evimed_frontier.event_items mine JOIN evimed_frontier.event_items other
          ON other.event_id = mine.event_id AND other.role = 'primary' WHERE mine.item_id = i.id)
      ORDER BY i.score_total DESC NULLS LAST, i.id LIMIT 60`, [since])).rows;
    /** @type {FrontierLeadPlan[]} */
    const plans = [];
    for (const row of rows) {
      const genre = frontierMixGenre(row);
      if (genre !== "news" && genre !== "industry") continue;
      const identifiers = frontierIdentifierLeads({ doi: row.doi, pmid: row.pmid, registryIds: row.registry_ids, text: row.text });
      const keys = identifiers.map((lead) => (lead.kind === "doi" ? `doi:${lead.id}` : lead.kind === "pmid" ? `pmid:${lead.id}` : `reg:${lead.id}`));
      // The feed has it when another item is known by it (an item's own cluster key is the identifier it names, not a source).
      const have = new Set(keys.length ? (await this.database.query("SELECT key FROM evimed_frontier.item_keys WHERE key = ANY($1::text[]) AND item_id <> $2",
        [keys, row.id])).rows.map((r) => r.key) : []);
      const missing = identifiers.filter((_, index) => !have.has(keys[index]));
      if (missing.length) {
        for (const lead of missing) plans.push({ trigger: "primary-source", kind: "address", url: lead.url, subject: { item: row.public_id, [lead.kind]: lead.id } });
        continue;
      }
      if (identifiers.length) continue;
      const title = clip(row.title_raw, ENGLISH_QUERY_CHARS);
      if (!title) continue;
      const host = (() => { try { return new URL(row.canonical_url).hostname.replace(/^www\./, ""); } catch { return null; } })();
      plans.push({ trigger: "primary-source", kind: "search", query: genre === "industry" && !isChineseTitle(title) ? `${title} press release` : title,
        language: isChineseTitle(title) ? "zh-CN" : "en", timeRange: "week", subject: { item: row.public_id }, excludeHost: host });
    }
    return plans;
  }

  /** `event-hot`: the events that entered the hot list at its last snapshot, searched by their Chinese title. @returns {Promise<FrontierLeadPlan[]>} */
  async #hotEvents() {
    const snapshot = (await this.database.query("SELECT ranking FROM evimed_frontier.hot_snapshots ORDER BY taken_at DESC LIMIT 1")).rows[0];
    const entered = (Array.isArray(snapshot?.ranking) ? snapshot.ranking : []).filter((entry) => entry && entry.delta == null && entry.eventId).map((entry) => String(entry.eventId));
    if (!entered.length) return [];
    const events = (await this.database.query(`SELECT public_id, title_zh FROM evimed_frontier.events WHERE public_id = ANY($1::text[]) AND merged_into IS NULL`, [entered])).rows;
    return events.map((event) => clip(event.title_zh, TITLE_QUERY_CHARS)).map((query, index) => ({ trigger: "event-hot", kind: /** @type {const} */ ("search"),
      query, language: "zh-CN", timeRange: /** @type {const} */ ("day"), subject: { event: events[index].public_id } })).filter((plan) => plan.query);
  }

  /**
   * `zh-report`: selected items of the window that are not Chinese and whose event holds no Chinese report, the best first,
   * searched by the editor's Chinese title (a dictionary's rendering of the names, not a machine translation of the query).
   * @param {Date} since @returns {Promise<FrontierLeadPlan[]>}
   */
  async #chineseReports(since) {
    const rows = (await this.database.query(`SELECT i.public_id, i.title_zh, i.lang FROM evimed_frontier.items i
      WHERE i.state = 'published' AND i.selected AND NOT i.safety_alert AND i.timeline_at >= $1 AND i.lang NOT LIKE 'zh%'
        AND coalesce(i.title_zh, '') <> ''
        AND NOT EXISTS (SELECT 1 FROM evimed_frontier.event_items mine JOIN evimed_frontier.event_items other ON other.event_id = mine.event_id
          JOIN evimed_frontier.items o ON o.id = other.item_id AND o.state = 'published' AND o.lang LIKE 'zh%' WHERE mine.item_id = i.id)
      ORDER BY i.score_total DESC NULLS LAST, i.id LIMIT 80`, [since])).rows;
    return rows.map((row) => ({ trigger: "zh-report", kind: /** @type {const} */ ("search"), query: clip(row.title_zh, TITLE_QUERY_CHARS),
      language: "zh-CN", timeRange: /** @type {const} */ ("day"), subject: { item: row.public_id }, chineseOnly: true })).filter((plan) => plan.query);
  }

  /** `hot-tag`: the tags of this week's 精选, the most frequent first. @param {Date} now @returns {Promise<FrontierLeadPlan[]>} */
  async #hotTags(now) {
    const rows = (await this.database.query(`SELECT tag, count(*)::integer AS n FROM evimed_frontier.items i, unnest(i.tags) AS tag
      WHERE i.state = 'published' AND i.selected AND i.timeline_at >= $1 GROUP BY tag ORDER BY n DESC, tag LIMIT 40`,
    [new Date(now.getTime() - 7 * DAY)])).rows;
    return rows.map((row) => ({ trigger: "hot-tag", kind: /** @type {const} */ ("search"), query: `${clip(row.tag, TITLE_QUERY_CHARS)} 最新进展`,
      language: "zh-CN", timeRange: /** @type {const} */ ("day"), subject: { tag: row.tag, selected7d: row.n } }));
  }

  /**
   * `specialty`: each specialty's most frequent drug, disease or trial among this week's published items of it.
   * @param {Date} now @returns {Promise<FrontierLeadPlan[]>}
   */
  async #specialties(now) {
    const rows = (await this.database.query(`SELECT specialty, entity, n FROM (
        SELECT specialty, entity, count(*)::integer AS n, row_number() OVER (PARTITION BY specialty ORDER BY count(*) DESC, entity) AS rank
        FROM evimed_frontier.items i, unnest(i.specialties) AS specialty,
          LATERAL (SELECT jsonb_array_elements_text(coalesce(i.entities->'drugs', '[]'::jsonb) || coalesce(i.entities->'diseases', '[]'::jsonb)
            || coalesce(i.entities->'trials', '[]'::jsonb)) AS entity) AS e
        WHERE i.state = 'published' AND i.timeline_at >= $1 AND jsonb_typeof(i.entities) = 'object'
        GROUP BY specialty, entity) ranked
      WHERE rank = 1 AND specialty = ANY($2::text[]) ORDER BY n DESC, specialty`, [new Date(now.getTime() - 7 * DAY), [...FRONTIER_SPECIALTIES]])).rows;
    return rows.map((row) => ({ trigger: "specialty", kind: /** @type {const} */ ("search"), query: `${clip(row.entity, TITLE_QUERY_CHARS)} 最新`,
      language: "zh-CN", timeRange: /** @type {const} */ ("day"), subject: { specialty: row.specialty, entity: row.entity } }));
  }

  /**
   * `genre-gap`: the genre groups under their floor yesterday (their share of yesterday's counted selections, against the
   * day's size held at its minimum), each searching its own queries.
   * @param {Date} now @returns {Promise<FrontierLeadPlan[]>}
   */
  async #genreGaps(now) {
    const today = frontierDayWindow(now, this.timeZone);
    const yesterday = frontierDayWindow(new Date(today.start.getTime() - HOUR), this.timeZone);
    const rows = (await this.database.query(`SELECT i.genre, i.platform, i.channel, i.source_type, i.evidence_type, i.flags, i.safety_alert, i.lane
      FROM evimed_frontier.items i WHERE i.state = 'published' AND i.selected AND NOT i.safety_alert AND i.selected_rule = ANY($3::text[])
        AND i.timeline_at >= $1 AND i.timeline_at < $2`, [yesterday.start, yesterday.end, [...FRONTIER_MIX_COUNTED_RULES]])).rows;
    /** @type {Record<string, number>} */
    const counts = {};
    for (const row of rows) {
      const group = frontierMixGroup(frontierMixGenre(row));
      if (group) counts[group] = (counts[group] ?? 0) + 1;
    }
    const size = Math.max(FRONTIER_MIX_DAY.min, rows.length);
    /** @type {FrontierLeadPlan[]} */
    const plans = [];
    for (const [group, queries] of Object.entries(FRONTIER_LEAD_GENRE_QUERIES)) {
      const floor = Math.floor(/** @type {any} */ (FRONTIER_MIX_GROUPS)[group].min * size);
      if ((counts[group] ?? 0) >= floor) continue;
      for (const query of queries) {
        plans.push({ trigger: "genre-gap", kind: "search", query, language: /[一-鿿]/u.test(query) ? "zh-CN" : "en", timeRange: "day",
          subject: { group, yesterday: counts[group] ?? 0, floor } });
      }
    }
    return plans;
  }

  status() {
    return { configured: this.configured, dailyQueries: this.dailyQueries, counters: structuredClone(this.counters), lastTick: this.lastTick };
  }
}

/**
 * A search's reference cost from the engines that answered it: DeepSeek's per-request price, Bailian's reservation bound;
 * SearXNG is the platform's own. The ledger holds what was actually charged.
 * @param {readonly string[]} engines
 */
export function frontierLeadCost(engines) {
  let cost = 0;
  if (engines.includes("deepseek")) cost += 0.005;
  if (engines.includes("bailian")) cost += 0.0128;
  return Math.round(cost * 10_000) / 10_000;
}
