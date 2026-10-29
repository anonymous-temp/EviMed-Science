/**
 * The read side of the topic zones of 「证据专区」 (owner, 2026-10-29; plan `docs/superpowers/plans/2026-10-29-evidence-zone-topics.md`
 * §4.3, §4.4, §6.6): the directory, a zone's detail, the modules of its overview, its 「动态」 list and its cards. Every answer is the
 * shape `apps/web/src/lib/evidenceTopicClient.ts` parses.
 *
 * Hidden knowledge:
 *
 * - **A topic zone is a zone with `lifecycle <> 'none'`.** The product zones of 循证 GEO and a reader's container of research-result
 *   cards keep `none` and are the old `EvidenceZoneService`'s: `detail` answers `null` for them so the route falls back to the old
 *   answer, and the other reads answer 404 `evidence_not_found`. Visibility is the old service's rule: a zone is seen when it is
 *   published or the reader's own, and a reader's unpublished zone is nobody else's — in every view, in a detail, in `related`
 *   and in `summaries`. A zone is addressed by its id or its slug in every read (`resolveId`).
 * - **Code composes the page; the model wrote one block of it.** Which modules an overview has, in which order, how many rows and
 *   how far back is `evidenceZoneModuleOrder` and `EVIDENCE_ZONE_MODULE_RULES` from the domain; a module below its minimum is left
 *   out, and `latest` is the one that always stays. The only model-written text is 「最新进展」, stored by the membership module
 *   (`zones.overview`) and served as it is.
 * - **Rows come from `zone_items`** (`state` in/pinned only; `pending`, `out` and `excluded` never reach a reader). The modules but
 *   `latest` use the model's `core` rows (a pinned row counts as core); the 「动态」 list and `latest` use core and related.
 *   An item's role is read again from its genre (`frontierItemGenre` → `evidenceZoneRole`) for the modules, and from the stored
 *   `zone_items.role` — the same function, written when the row was matched — for the list's filters, which SQL has to apply.
 * - **One row per event.** The 「动态」 list, its counts and `latest` fold items of one event into the event's best item in the zone
 *   (selected first, then the higher score), so a number on a tab is the length of the list under it and a directory count is the
 *   same unit (`coalesce(event_id, -id)`). The feed's own all-items view does not fold; a zone's page does.
 * - **A reader's hidden items are not counted or listed** (`user_state.hidden_at`), in SQL, so a page is as full as the zone has.
 * - **Windows are by `visible_at`**, the day by the feed's zone (`config.frontierTimeZone`, Asia/Shanghai); the list is ordered and
 *   paged by `(timeline_at, id)` as the feed is. A cursor belongs to its filters and is refused (409 `evidence_cursor_invalid`) for
 *   any others.
 * - **A failing optional part costs that part.** The cards port, the side panel's topics and congresses never fail an overview.
 *
 * Which model capability would make it deletable: none — it is composition and counting.
 *
 * @module evidenceZoneReads
 */

import { createHash } from "node:crypto";
import {
  EVIDENCE_PLATFORM_PRODUCER_NAME,
  EVIDENCE_ZONE_CONGRESS_WINDOW,
  EVIDENCE_ZONE_MODULE_RULES,
  EVIDENCE_ZONE_ROLES,
  FRONTIER_APPROVAL_KIND_LABELS_ZH,
  FRONTIER_CONGRESSES,
  FRONTIER_SPECIALTIES,
  FRONTIER_SPECIALTY_LABELS_ZH,
  evidenceZoneBand,
  evidenceZoneIsKeyUpdate,
  evidenceZoneModuleOrder,
  evidenceZoneRole,
  frontierCongressSummary,
  frontierDayIn,
  frontierItemGenre,
  frontierShiftDay,
} from "@evimed/domain";
import { frontierSelectThreshold } from "./frontierPipeline.mjs";
import { frontierTrackFactsView } from "./frontierTrackFacts.mjs";
import { tsqueryLiteral } from "./kbChunker.mjs";
import { HttpError } from "./security.mjs";

const DAY_MS = 86_400_000;
const PAGE = 30;
const DIRECTORY_MAX = 500;
const RELATED_MAX = 6;
const RELATED_CANDIDATES = 60;
/** The rows an overview reads at most: the newest of the zone, 365 days back (the approved drugs' window). */
const OVERVIEW_ROWS_MAX = 3000;
const OVERVIEW_ROWS_DAYS = 365;
const ENTITY_TOP = 5;
const ENTITY_DAYS = 30;
const WEEKS = 12;
const REF_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const WINDOWS = Object.freeze({ "7d": 7, "30d": 30, "90d": 90, all: null });
const VIEWS = Object.freeze(["recommended", "mine", "community"]);
const OTHER_SPECIALTY = Object.freeze({ key: "other", label: "其他" });
const OTHER_GROUP = "其他";
const KEY_ROLES = Object.freeze(["guideline", "approval", "safety"]);

const error = (/** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message) => new HttpError(status, `evidence_${code}`, message);
const missing = () => error(404, "not_found", "No such visible evidence content.");
/** @param {unknown} value */
const iso = (value) => (value == null ? null : new Date(/** @type {any} */ (value)).toISOString());
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value */
const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const count = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
/** @param {unknown} value */
const foldKey = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();
/** @param {number | null} days @returns {"7d" | "30d" | "90d" | "all"} */
const windowKey = (days) => (days === null ? "all" : days <= 7 ? "7d" : days <= 30 ? "30d" : days <= 90 ? "90d" : "all");

/** The reader's own hidden items, as an SQL predicate on an item alias (`i` unless told). @param {string} param @param {string} [alias] */
const notHidden = (param, alias = "i") => `NOT EXISTS (SELECT 1 FROM evimed_frontier.user_state us WHERE us.user_id = ${param} AND us.item_id = ${alias}.id AND us.hidden_at IS NOT NULL)`;
/** An item the reader may see: published, from a source that is on. */
const ITEM_FROM = `evimed_frontier.zone_items zi
  JOIN evimed_frontier.items i ON i.id = zi.item_id AND i.state = 'published'
  JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled`;
/** How many archivals deep a successor is followed (a zone merged into one that was merged in its turn). */
const SUCCESSOR_HOPS = 4;
/** The instant an item is dated by on the page (`timelineAt`): its publication time, `visible_at` when it has none. */
const PUBLISHED_AT = "coalesce(i.timeline_at, i.visible_at)";
/** The unit a count is made in: one per event. */
const EVENT_KEY = "coalesce(i.event_id, -i.id)";
const KEYWORDS_SQL = (/** @type {string} */ alias) => `(CASE WHEN jsonb_typeof(${alias}.definition->'keywords') = 'array' THEN ${alias}.definition->'keywords' ELSE '[]'::jsonb END)`;
const ZONE_COLUMNS = `z.id, z.slug, z.title, z.zone_type, z.specialties, z.group_label, z.scope_zh, z.kind, z.state, z.user_id, z.revision, z.lifecycle,
  z.definition, z.stats, z.overview, z.overview_at, z.updated_at, u.name AS creator,
  EXISTS (SELECT 1 FROM evimed_frontier.evidence_zone_follows f WHERE f.zone_id = z.id AND f.user_id = $1) AS following,
  (SELECT count(*)::integer FROM evimed_frontier.evidence_zone_follows f WHERE f.zone_id = z.id) AS followers`;
const ZONE_FROM = `evimed_frontier.evidence_zones z JOIN evimed_control.users u ON u.id = z.user_id`;

/**
 * `zones` and `membership` are in the composition's contract (the writes and the item→zones hook use them); the reads need
 * neither, and take them only so one options object serves both.
 * @typedef {{
 *   database: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> },
 *   service: { hydrate: (user: { id: string }, ids: { publicIds?: string[], rowIds?: string[] }) => Promise<Map<string, any>> },
 *   zones?: unknown,
 *   membership?: unknown,
 *   cards: { provider: string, list: (zone: any, options: { limit: number }) => Promise<any[]> } | null,
 *   config: Record<string, any>,
 *   now?: () => Date,
 * }} EvidenceZoneReadsOptions
 */

/** @param {EvidenceZoneReadsOptions} options */
export function createEvidenceZoneReads({ database, service, cards = null, config, now = () => new Date() }) {
  const timeZone = String(config?.frontierTimeZone || "Asia/Shanghai");
  const userZonesMax = Number(config?.evidenceUserZonesMax) > 0 ? Number(config.evidenceUserZonesMax) : 30;
  const operators = new Set(list(config?.operatorUsers).map(String));
  const threshold = frontierSelectThreshold(config);
  /** @param {{ id: string }} user */
  const isOperator = (user) => operators.has(String(user?.id ?? ""));

  /** A read in which `$1` is the reader and `params` are `$2…`; the statement must name `$1` (PostgreSQL refuses a parameter nothing uses). @param {{ id: string }} user @param {string} sql @param {unknown[]} [params] */
  const query = async (user, sql, params = []) => (await database.query(sql, [user.id, ...params])).rows;
  /** A read that needs no reader. @param {string} sql @param {unknown[]} [params] */
  const plain = async (sql, params = []) => (await database.query(sql, params)).rows;

  // ───────────────────────── zones ─────────────────────────

  /**
   * A topic zone the reader may see, by id or slug, or null. `topic: false` also finds the old kinds of zone.
   * @param {{ id: string }} user @param {unknown} ref @param {{ topic?: boolean }} [options]
   */
  async function zoneRow(user, ref, { topic = true } = {}) {
    if (typeof ref !== "string" || !REF_PATTERN.test(ref)) return null;
    const rows = await query(user, `SELECT ${ZONE_COLUMNS} FROM ${ZONE_FROM}
      WHERE (z.id = $2 OR z.slug = $2) AND (z.state = 'published' OR z.user_id = $1) ${topic ? "AND z.lifecycle <> 'none'" : ""}
      ORDER BY (z.id = $2) DESC LIMIT 1`, [ref]);
    return rows[0] ?? null;
  }

  /**
   * A zone as a list line shows it. `owned` is the reader's own user zone (what the page offers to edit or delete); `revision` is what a
   * follow or an edit sends back; `followers` is the number of readers following it.
   * @param {any} row @param {{ id: string }} user
   */
  function summary(row, user) {
    const stats = record(row.stats);
    const definition = record(row.definition);
    const latest = record(stats.keyLatest ?? stats.latest);
    const specialties = list(row.specialties).filter((key) => Object.hasOwn(FRONTIER_SPECIALTY_LABELS_ZH, key))
      .map((key) => ({ key: String(key), label: FRONTIER_SPECIALTY_LABELS_ZH[key] }));
    return {
      id: String(row.id),
      slug: row.slug ?? null,
      revision: count(row.revision),
      owned: row.kind === "user" && row.user_id === user.id,
      title: String(row.title),
      type: row.zone_type ?? null,
      keywords: list(definition.keywords).map((keyword) => String(record(keyword).label ?? "")).filter(Boolean),
      scope: String(row.scope_zh ?? ""),
      specialties,
      group: String(row.group_label ?? ""),
      kind: row.kind === "official" ? "official" : "user",
      published: row.state === "published",
      // A platform zone is signed by the platform, whichever account holds the row; a reader's zone by its maker's name.
      creator: row.kind === "official" ? EVIDENCE_PLATFORM_PRODUCER_NAME : (row.creator ?? null),
      following: row.following === true,
      followers: count(row.followers),
      counts: { week: count(stats.week), month: count(stats.month), all: count(stats.all) },
      perWeek: typeof stats.perWeek === "number" && Number.isFinite(stats.perWeek) ? stats.perWeek : null,
      cards: count(stats.cards),
      latest: latest.itemId ? { itemId: String(latest.itemId), title: String(latest.title ?? ""), at: latest.at ? String(latest.at) : null } : null,
      lifecycle: row.lifecycle === "quiet" || row.lifecycle === "archived" ? row.lifecycle : "active",
      updatedAt: iso(row.updated_at),
    };
  }

  /** Activity first, then followers, then the name: the order every list of zones is given. @param {any} left @param {any} right */
  const byActivity = (left, right) => (left.lifecycle === "quiet" ? 1 : 0) - (right.lifecycle === "quiet" ? 1 : 0)
    || right.counts.week - left.counts.week || right.followers - left.followers || left.title.localeCompare(right.title, "zh");

  // ───────────────────────── directory ─────────────────────────

  /**
   * The zones of a view, grouped (recommended: specialty → group → zones) or flat (mine, community).
   * @param {{ id: string }} user @param {URLSearchParams} params
   */
  async function directory(user, params) {
    const view = params.get("view") || "recommended";
    if (!VIEWS.includes(view)) throw error(400, "query_invalid", "Invalid evidence query.");
    const q = (params.get("q") ?? "").trim();
    const specialty = params.get("specialty") || "";
    if (q.length > 200 || (specialty && !Object.hasOwn(FRONTIER_SPECIALTY_LABELS_ZH, specialty))) throw error(400, "query_invalid", "Invalid evidence query.");
    /** @type {unknown[]} */
    const values = [];
    const param = (/** @type {unknown} */ value) => { values.push(value); return `$${values.length + 1}`; };
    const where = ["z.lifecycle <> 'none'"];
    if (view === "recommended") where.push("z.kind = 'official'", "z.lifecycle IN ('active', 'quiet')", "(z.state = 'published' OR z.user_id = $1)");
    else if (view === "mine") {
      where.push("(z.user_id = $1 OR (z.state = 'published' AND EXISTS (SELECT 1 FROM evimed_frontier.evidence_zone_follows f WHERE f.zone_id = z.id AND f.user_id = $1)))");
    } else where.push("z.kind = 'user'", "z.state = 'published'", "z.user_id <> $1", "z.lifecycle = 'active'");
    if (specialty) where.push(`${param(specialty)} = ANY(z.specialties)`);
    if (q) {
      where.push(`strpos(lower(concat_ws(' ', z.title, z.group_label,
        (SELECT string_agg(k->>'label', ' ') FROM jsonb_array_elements(${KEYWORDS_SQL("z")}) k))), lower(${param(q)})) > 0`);
    }
    const rows = await query(user, `SELECT ${ZONE_COLUMNS} FROM ${ZONE_FROM} WHERE ${where.join(" AND ")} ORDER BY z.updated_at DESC, z.id LIMIT ${DIRECTORY_MAX}`, values);
    const zones = rows.map((row) => ({ zone: summary(row, user), own: row.user_id === user.id }));
    const owned = (await query(user, `SELECT count(*)::integer AS n FROM evimed_frontier.evidence_zones z WHERE z.user_id = $1 AND z.kind = 'user' AND z.lifecycle <> 'none'`))[0]?.n ?? 0;
    const base = {
      view,
      total: zones.length,
      canCreate: config?.evidenceZoneTopicsEnabled !== false,
      userZones: { count: Number(owned), max: userZonesMax },
    };
    if (view === "recommended") return { ...base, groups: groupedBySpecialty(zones.map((entry) => entry.zone)), zones: [] };
    // Mine: the reader's own, the newest edit first, then the ones followed by activity. Community: the most followed first.
    const ordered = view === "mine"
      ? [...zones.filter((entry) => entry.own).map((entry) => entry.zone), ...zones.filter((entry) => !entry.own).map((entry) => entry.zone).sort(byActivity)]
      : zones.map((entry) => entry.zone).sort((left, right) => right.followers - left.followers || byActivity(left, right));
    return { ...base, groups: [], zones: ordered };
  }

  /**
   * Specialty → group → zones, each level ordered by what happened this week (a level of only quiet zones last); a zone with no
   * specialty is filed under 其他, a zone with no group under 其他 too.
   * @param {any[]} zones
   */
  function groupedBySpecialty(zones) {
    const order = new Map(FRONTIER_SPECIALTIES.map((key, index) => [key, index]));
    /** @type {Map<string, { specialty: { key: string, label: string }, sections: Map<string, any[]> }>} */
    const specialties = new Map();
    for (const zone of zones) {
      const specialty = zone.specialties[0] ?? OTHER_SPECIALTY;
      const entry = specialties.get(specialty.key) ?? { specialty, sections: new Map() };
      specialties.set(specialty.key, entry);
      const label = zone.group || OTHER_GROUP;
      entry.sections.set(label, [...(entry.sections.get(label) ?? []), zone]);
    }
    /** @param {any[]} members */
    const weight = (members) => ({ quiet: members.every((zone) => zone.lifecycle === "quiet") ? 1 : 0,
      week: members.reduce((sum, zone) => sum + zone.counts.week, 0), followers: members.reduce((sum, zone) => sum + zone.followers, 0) });
    /** @param {ReturnType<typeof weight>} left @param {ReturnType<typeof weight>} right */
    const heavier = (left, right) => left.quiet - right.quiet || right.week - left.week || right.followers - left.followers;
    return [...specialties.values()].map((entry) => {
      const sections = [...entry.sections.entries()].map(([label, members]) => ({ label, zones: members.sort(byActivity), weight: weight(members) }))
        .sort((left, right) => heavier(left.weight, right.weight) || (left.label === OTHER_GROUP ? 1 : 0) - (right.label === OTHER_GROUP ? 1 : 0) || left.label.localeCompare(right.label, "zh"));
      return { specialty: entry.specialty, sections, weight: weight(sections.flatMap((section) => section.zones)) };
    }).sort((left, right) => (left.specialty.key === "other" ? 1 : 0) - (right.specialty.key === "other" ? 1 : 0) || heavier(left.weight, right.weight)
      || (order.get(left.specialty.key) ?? 99) - (order.get(right.specialty.key) ?? 99))
      .map(({ specialty, sections }) => ({ specialty, sections: sections.map(({ label, zones: members }) => ({ label, zones: members })) }));
  }

  // ───────────────────────── detail ─────────────────────────

  /**
   * Up to six zones that share a keyword, a keyword's tag or the group with this one, platform zones and published readers' zones
   * (and the reader's own), the closest first.
   * @param {{ id: string }} user @param {any} row
   */
  async function relatedZones(user, row) {
    const keywords = list(record(row.definition).keywords).map(record);
    const labels = [...new Set(keywords.map((keyword) => foldKey(keyword.label)).filter(Boolean))];
    const tagIds = [...new Set(keywords.flatMap((keyword) => list(keyword.tagIds)).map(String))];
    const group = String(row.group_label ?? "");
    if (!labels.length && !tagIds.length && !group) return [];
    const rows = await query(user, `SELECT ${ZONE_COLUMNS} FROM ${ZONE_FROM}
      WHERE z.id <> $2 AND z.lifecycle IN ('active', 'quiet') AND (z.state = 'published' OR z.user_id = $1) AND (
        ($3 <> '' AND z.group_label = $3)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(${KEYWORDS_SQL("z")}) k WHERE lower(k->>'label') = ANY($4::text[]))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(${KEYWORDS_SQL("z")}) k
                     CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(k->'tagIds') = 'array' THEN k->'tagIds' ELSE '[]'::jsonb END) t
                    WHERE t.value = ANY($5::text[])))
      LIMIT ${RELATED_CANDIDATES}`, [row.id, group, labels, tagIds]);
    return rows.map((other) => {
      const theirs = list(record(other.definition).keywords).map(record);
      const sharedLabels = theirs.filter((keyword) => labels.includes(foldKey(keyword.label))).length;
      const sharedTags = new Set(theirs.flatMap((keyword) => list(keyword.tagIds)).map(String).filter((id) => tagIds.includes(id))).size;
      return { zone: summary(other, user), closeness: sharedLabels * 4 + sharedTags * 2 + (group && other.group_label === group ? 1 : 0) };
    }).sort((left, right) => right.closeness - left.closeness || byActivity(left.zone, right.zone)).slice(0, RELATED_MAX).map((entry) => entry.zone);
  }

  /** The definition as its owner edits it: the keywords' words, never the ids they resolved to. @param {unknown} value */
  function servedDefinition(value) {
    const definition = record(value);
    if (!definition.type) return null;
    return {
      version: count(definition.version),
      type: definition.type,
      keywords: list(definition.keywords).map(record).map((keyword) => ({ label: String(keyword.label ?? ""), terms: list(keyword.terms).map(String) })),
      perspective: definition.perspective ?? null,
      scope: String(definition.scope ?? ""),
      include: String(definition.include ?? ""),
      exclude: String(definition.exclude ?? ""),
      excludeTerms: list(definition.excludeTerms).map(String),
      specialties: list(definition.specialties).map(String),
      group: String(definition.group ?? ""),
    };
  }

  /**
   * The zones that took over from an archived one: the pieces of a split and the survivor of a merge, as the planner recorded them. A
   * successor that was archived in its turn is replaced by its own (a few hops), and one the reader may not see is left out. Empty for a
   * zone that is not archived, or was archived by nothing that names a successor.
   * @param {{ id: string }} user @param {any} row
   * @returns {Promise<Array<{ id: string, slug: string | null, title: string }>>}
   */
  async function successorsOf(user, row) {
    if (row.lifecycle !== "archived") return [];
    /** @type {Map<string, { id: string, slug: string | null, title: string }>} */
    const found = new Map();
    const seen = new Set([String(row.id)]);
    let pending = [String(row.id)];
    for (let hop = 0; hop < SUCCESSOR_HOPS && pending.length; hop += 1) {
      const changes = await plain(`SELECT DISTINCT ON (zone_id) zone_id, detail FROM evimed_frontier.zone_changes
        WHERE zone_id = ANY($1::text[]) AND kind IN ('merged', 'split') ORDER BY zone_id, id DESC`, [pending]);
      const named = [...new Set(changes.flatMap((change) => [].concat(record(change.detail).into ?? []).map(String)))].filter((id) => !seen.has(id));
      if (!named.length) break;
      named.forEach((id) => seen.add(id));
      const targets = await query(user, `SELECT z.id, z.slug, z.title, z.lifecycle FROM evimed_frontier.evidence_zones z
        WHERE z.id = ANY($2::text[]) AND z.lifecycle <> 'none' AND (z.state = 'published' OR z.user_id = $1)`, [named]);
      pending = [];
      for (const target of named) {
        const zone = targets.find((entry) => entry.id === target);
        if (!zone) continue;
        if (zone.lifecycle === "archived") pending.push(zone.id);
        else found.set(zone.id, { id: String(zone.id), slug: zone.slug ?? null, title: String(zone.title) });
      }
    }
    return [...found.values()];
  }

  /**
   * When the zone's newest item (collected and not excluded) came out, as the page dates it, or null for a zone with none: what a quiet
   * zone's head says it was last updated at.
   * @param {string} zoneId @returns {Promise<string | null>}
   */
  async function lastItemAtOf(zoneId) {
    const rows = await plain(`SELECT max(${PUBLISHED_AT}) AS at FROM ${ITEM_FROM} WHERE zi.zone_id = $1 AND zi.state IN ('in', 'pinned')`, [zoneId]);
    return iso(rows[0]?.at ?? null);
  }

  /**
   * A zone as the page's head needs it: `{ zone, feedback }` for a topic zone, `null` for any other (the route answers those with the
   * old service). The definition is the owner's (and an operator's) alone. `successors` are the zones that took over from an archived
   * zone and `lastItemAt` the date of its newest item; both are always there.
   * @param {{ id: string }} user @param {string} ref
   */
  async function detail(user, ref) {
    const row = await zoneRow(user, ref);
    if (!row) return null;
    const owner = row.user_id === user.id;
    const base = summary(row, user);
    const [successors, lastItemAt] = await Promise.all([successorsOf(user, row), lastItemAtOf(row.id)]);
    const feedback = owner
      ? await plain(`SELECT f.id, f.text, f.created_at AS "createdAt", u.name AS author FROM evimed_frontier.evidence_zone_feedback f
          JOIN evimed_control.users u ON u.id = f.user_id WHERE f.zone_id = $1 ORDER BY f.created_at DESC, f.id`, [row.id])
      : [];
    return {
      zone: {
        ...base,
        definition: (owner && row.kind === "user") || isOperator(user) ? servedDefinition(row.definition) : null,
        canEdit: owner && row.kind === "user",
        canDelete: owner && row.kind === "user",
        band: evidenceZoneBand(base.perWeek),
        overviewAt: iso(row.overview_at),
        successors,
        lastItemAt,
        related: await relatedZones(user, row),
      },
      feedback,
    };
  }

  // ───────────────────────── overview ─────────────────────────

  /**
   * The newest rows of a zone, 365 days back, with the columns the modules classify by; the reader's hidden items left out.
   * @param {{ id: string }} user @param {string} zoneId @param {Date} at
   */
  async function overviewRows(user, zoneId, at) {
    const since = new Date(at.getTime() - OVERVIEW_ROWS_DAYS * DAY_MS).toISOString();
    const rows = await query(user, `SELECT i.id, i.public_id, coalesce(nullif(i.title_zh, ''), i.title_raw) AS title, i.genre, i.platform, i.channel, i.source_type,
        i.evidence_type, i.flags, i.safety_alert, i.lane, i.practice_changing, i.selected, i.score_total, i.registry_ids, i.published_at, i.visible_at,
        i.timeline_at, i.event_id, i.entities, i.track_facts, zi.state AS zone_state, zi.relevance
      FROM ${ITEM_FROM}
      WHERE zi.zone_id = $2 AND zi.state IN ('in', 'pinned') AND i.visible_at >= $3::timestamptz AND ${notHidden("$1")}
      ORDER BY i.timeline_at DESC, i.id DESC LIMIT ${OVERVIEW_ROWS_MAX}`, [zoneId, since]);
    return rows.map((row) => {
      const genre = frontierItemGenre(row);
      return {
        ...row,
        rowId: String(row.id),
        genre,
        role: evidenceZoneRole({ genre, safetyAlert: row.safety_alert === true }),
        core: row.zone_state === "pinned" || row.relevance === "core",
        visibleMs: new Date(row.visible_at).getTime(),
        timelineMs: new Date(row.timeline_at).getTime(),
        flagList: list(row.flags).map(String),
      };
    });
  }

  /**
   * 「最新进展」 with its references resolved to the items' titles and sources, or null when none was written.
   * @param {any} row
   */
  async function progressModule(row) {
    const written = record(row.overview);
    const text = typeof written.text === "string" ? written.text.trim() : "";
    if (!text) return null;
    const marks = list(written.refs).map(record).filter((mark) => typeof mark.itemId === "string" && mark.itemId);
    const found = marks.length ? new Map((await plain(`SELECT i.public_id, coalesce(nullif(i.title_zh, ''), i.title_raw) AS title, s.name AS source_name
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
      WHERE i.public_id = ANY($1::text[]) AND i.state = 'published'`, [marks.map((mark) => mark.itemId)])).map((item) => [item.public_id, item])) : new Map();
    const refs = marks.flatMap((mark) => {
      const item = found.get(mark.itemId);
      return item ? [{ n: count(mark.n), itemId: String(mark.itemId), title: String(item.title ?? ""), sourceName: String(item.source_name ?? "") }] : [];
    });
    return { key: "progress", progress: { text, refs, at: iso(row.overview_at) ?? "" } };
  }

  /**
   * The drugs the zone's items name over the last year, each with its latest approval (from the approval items' extracted record),
   * its best research item and the last 30 days' count; the ones with an approval first.
   * @param {Array<Record<string, any>>} rows core rows @param {number} nowMs
   */
  function approvedDrugs(rows, nowMs) {
    const rule = EVIDENCE_ZONE_MODULE_RULES["approved-drugs"];
    /** @type {Map<string, any>} */
    const drugs = new Map();
    for (const row of rows) {
      if (nowMs - row.visibleMs > (rule.windowDays ?? 365) * DAY_MS) continue;
      const names = list(record(row.entities).drugs).filter((name) => typeof name === "string" && name.trim());
      if (!names.length) continue;
      const facts = row.genre === "approval" ? frontierTrackFactsView(row.track_facts, "approval") : null;
      const approval = facts && facts.approval !== "other" && facts.approval !== "withdrawal"
        ? { agency: facts.agency?.label ?? "", date: facts.date ?? frontierDayIn(row.published_at ?? row.visible_at, timeZone), kind: FRONTIER_APPROVAL_KIND_LABELS_ZH[/** @type {keyof typeof FRONTIER_APPROVAL_KIND_LABELS_ZH} */ (facts.approval)], itemId: String(row.public_id) }
        : null;
      for (const name of names) {
        const key = foldKey(name);
        if (!key) continue;
        const entry = drugs.get(key) ?? { label: String(name).trim(), key, events30: new Set(), events: new Set(), approval: null, study: null };
        drugs.set(key, entry);
        const event = String(row.event_id ?? `-${row.rowId}`);
        entry.events.add(event);
        if (nowMs - row.visibleMs <= 30 * DAY_MS) entry.events30.add(event);
        if (approval && (!entry.approval || String(approval.date) > String(entry.approval.date))) entry.approval = approval;
        if (row.role === "research" && (!entry.study || Number(row.score_total ?? -1) > entry.study.score)) {
          entry.study = { itemId: String(row.public_id), title: String(row.title ?? ""), score: Number(row.score_total ?? -1) };
        }
      }
    }
    if (drugs.size < rule.minItems) return null;
    const ranked = [...drugs.values()].sort((left, right) => (right.approval ? 1 : 0) - (left.approval ? 1 : 0)
      || String(right.approval?.date ?? "").localeCompare(String(left.approval?.date ?? "")) || right.events30.size - left.events30.size
      || right.events.size - left.events.size || left.label.localeCompare(right.label, "zh")).slice(0, rule.limit);
    return {
      key: "approved-drugs",
      rows: ranked.map((entry) => ({ label: entry.label, key: entry.key, approval: entry.approval,
        study: entry.study ? { itemId: entry.study.itemId, title: entry.study.title } : null, count30: entry.events30.size })),
    };
  }

  /**
   * The events of the last seven days that two or more institutions report, with the zone's best item of each.
   * @param {{ id: string }} user @param {string} zoneId @param {Date} at
   */
  async function multiSource(user, zoneId, at) {
    const rule = EVIDENCE_ZONE_MODULE_RULES["multi-source"];
    const since = new Date(at.getTime() - (rule.windowDays ?? 7) * DAY_MS).toISOString();
    const rows = await query(user, `SELECT e.id, e.public_id, coalesce(e.digest_title_zh, e.title_zh) AS title, e.last_at,
        count(DISTINCT m.owner_entity) FILTER (WHERE NOT m.platform_produced)::integer AS reports, bool_or(ei.role = 'primary') AS has_primary,
        (SELECT y.public_id FROM evimed_frontier.zone_items zy JOIN evimed_frontier.items y ON y.id = zy.item_id AND y.state = 'published'
          JOIN evimed_frontier.sources ys ON ys.id = y.primary_source_id AND ys.enabled
          WHERE zy.zone_id = $2 AND zy.state IN ('in', 'pinned') AND y.event_id = e.id AND ${notHidden("$1", "y")}
          ORDER BY y.selected DESC, y.score_total DESC NULLS LAST, y.timeline_at DESC, y.id DESC LIMIT 1) AS item_id
      FROM evimed_frontier.events e
      JOIN evimed_frontier.event_items ei ON ei.event_id = e.id
      JOIN evimed_frontier.items j ON j.id = ei.item_id AND j.state = 'published'
      JOIN evimed_frontier.sources m ON m.id = j.primary_source_id AND m.enabled
      WHERE e.merged_into IS NULL AND e.id IN (
        SELECT i.event_id FROM ${ITEM_FROM}
         WHERE zi.zone_id = $2 AND zi.state IN ('in', 'pinned') AND (zi.relevance = 'core' OR zi.state = 'pinned') AND i.event_id IS NOT NULL
           AND i.visible_at >= $3::timestamptz AND ${notHidden("$1")})
      GROUP BY e.id
      HAVING count(DISTINCT m.owner_entity) FILTER (WHERE NOT m.platform_produced) >= 2
      ORDER BY reports DESC, e.last_at DESC, e.id DESC LIMIT ${rule.limit}`, [zoneId, since]);
    const events = rows.filter((row) => row.item_id).map((row) => ({ eventId: String(row.public_id), title: String(row.title ?? ""), reports: Number(row.reports),
      hasPrimary: row.has_primary === true, lastAt: iso(row.last_at), itemId: row.item_id ? String(row.item_id) : null }));
    return events.length >= rule.minItems ? { key: "multi-source", events } : null;
  }

  /**
   * The congresses of the zone's specialties that are on today (a window from before they open to after they close), and the
   * conference items the zone has from those days.
   * @param {Array<Record<string, any>>} rows core rows @param {string[]} specialties @param {Date} at
   */
  function congressRows(rows, specialties, at) {
    const today = frontierDayIn(at, timeZone);
    const windows = FRONTIER_CONGRESSES.filter((congress) => congress.specialty && specialties.includes(congress.specialty))
      .map((congress) => ({ from: frontierShiftDay(congress.start, -EVIDENCE_ZONE_CONGRESS_WINDOW.beforeDays), to: frontierShiftDay(congress.end, EVIDENCE_ZONE_CONGRESS_WINDOW.afterDays) }))
      .filter((window) => today >= window.from && today <= window.to);
    if (!windows.length) return [];
    return rows.filter((row) => row.role === "conference").filter((row) => {
      const day = frontierDayIn(row.published_at ?? row.visible_at, timeZone);
      return windows.some((window) => day >= window.from && day <= window.to);
    });
  }

  /**
   * The counts the side panel draws: the most named drugs, diseases and institutions of the last 30 days and the twelve weeks.
   * @param {Array<Record<string, any>>} rows core rows @param {number} nowMs
   */
  function entityCounts(rows, nowMs) {
    /** @type {Record<"drugs" | "diseases" | "orgs", Map<string, { label: string, events: Set<string> }>>} */
    const kinds = { drugs: new Map(), diseases: new Map(), orgs: new Map() };
    for (const row of rows) {
      if (nowMs - row.visibleMs > ENTITY_DAYS * DAY_MS) continue;
      const entities = record(row.entities);
      for (const [kind, found] of Object.entries(kinds)) {
        for (const name of list(entities[kind]).filter((value) => typeof value === "string" && value.trim())) {
          const key = foldKey(name);
          const entry = found.get(key) ?? { label: String(name).trim(), events: new Set() };
          found.set(key, entry);
          entry.events.add(String(row.event_id ?? `-${row.rowId}`));
        }
      }
    }
    /** @param {Map<string, { label: string, events: Set<string> }>} found @param {boolean} follow */
    const top = (found, follow) => [...found.entries()].map(([key, entry]) => ({ label: entry.label, key: follow ? key : null, count: entry.events.size }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh")).slice(0, ENTITY_TOP);
    return { drugs: top(kinds.drugs, true), diseases: top(kinds.diseases, false), orgs: top(kinds.orgs, false) };
  }

  /**
   * The last twelve weeks of the zone (Monday weeks in the feed's zone), oldest first, with the week's events. An item is in the week of
   * its publication time — the instant the list shows it at and the page's week filter cuts it by (`timelineAt`, `visible_at` when an item
   * has none) — so a bar and the list it opens agree: an item the zone collected today of a paper published last month is last month's.
   * @param {{ id: string }} user @param {string} zoneId @param {Date} at
   */
  async function weekly(user, zoneId, at) {
    const today = frontierDayIn(at, timeZone);
    const sinceDay = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
    const monday = frontierShiftDay(today, -((new Date(sinceDay).getUTCDay() + 6) % 7));
    const first = frontierShiftDay(monday, -7 * (WEEKS - 1));
    const found = new Map((await query(user, `SELECT to_char(date_trunc('week', ${PUBLISHED_AT} AT TIME ZONE $3), 'YYYY-MM-DD') AS week, count(DISTINCT ${EVENT_KEY})::integer AS n
      FROM ${ITEM_FROM}
      WHERE zi.zone_id = $2 AND zi.state IN ('in', 'pinned') AND (${PUBLISHED_AT} AT TIME ZONE $3)::date >= $4::date AND ${notHidden("$1")}
      GROUP BY 1`, [zoneId, timeZone, first])).map((row) => [row.week, Number(row.n)]));
    return Array.from({ length: WEEKS }, (_, index) => {
      const weekStart = frontierShiftDay(first, 7 * index);
      return { weekStart, count: found.get(weekStart) ?? 0 };
    });
  }

  /**
   * Hot-event topics that are about the zone's entities, and the congresses of its specialties on now or within 30 days.
   * @param {any} row @param {Date} at
   */
  async function sideLists(row, at) {
    const entityKeys = [...new Set(list(record(row.definition).keywords).flatMap((keyword) => list(record(keyword).entityKeys)).map(String))];
    const topics = entityKeys.length
      ? (await plain(`SELECT public_id, title_zh FROM evimed_frontier.topics WHERE status = 'active' AND entity_keys && $1::text[] ORDER BY accepted_at DESC LIMIT 3`, [entityKeys]))
        .map((topic) => ({ id: String(topic.public_id), title: String(topic.title_zh) }))
      : [];
    const today = frontierDayIn(at, timeZone);
    const horizon = frontierShiftDay(today, 30);
    const specialties = list(row.specialties).map(String);
    const congresses = FRONTIER_CONGRESSES.filter((congress) => congress.specialty && specialties.includes(congress.specialty) && congress.end >= today && congress.start <= horizon)
      .sort((left, right) => left.start.localeCompare(right.start)).slice(0, 5)
      .map((congress) => { const brief = frontierCongressSummary(congress, today); return { id: brief.id, name: brief.name, start: brief.start, end: brief.end }; });
    return { topics, congresses };
  }

  /**
   * The overview of a topic zone: its modules in its type's order, each only when it has enough to show, and the side panel.
   * @param {{ id: string }} user @param {string} ref
   */
  async function overview(user, ref) {
    const row = await zoneRow(user, ref);
    if (!row) throw missing();
    const at = now();
    const nowMs = at.getTime();
    const specialties = list(row.specialties).map(String);
    const [rows, progress, multi, cardList, weeks, side, related] = await Promise.all([
      overviewRows(user, row.id, at),
      progressModule(row),
      multiSource(user, row.id, at),
      cards ? cards.list({ id: row.id, slug: row.slug ?? null, title: row.title, definition: row.definition }, { limit: EVIDENCE_ZONE_MODULE_RULES.cards.limit }).catch(() => []) : [],
      weekly(user, row.id, at),
      sideLists(row, at).catch(() => ({ topics: [], congresses: [] })),
      relatedZones(user, row),
    ]);
    const core = rows.filter((entry) => entry.core);
    /** @param {number | null} days @param {(entry: any) => boolean} [accept] */
    const within = (days, accept = () => true) => core.filter((entry) => (days === null || nowMs - entry.visibleMs <= days * DAY_MS) && accept(entry));
    const rule = EVIDENCE_ZONE_MODULE_RULES;
    /**
     * A module that lists items: the first rows of its candidates, and where the 「动态」 tab continues the same list.
     * @param {EvidenceZoneItemModule} key @param {Array<any>} candidates @param {string | null} role
     */
    const itemsModule = (key, candidates, role) => ({ key, rowIds: candidates.slice(0, rule[key].limit).map((entry) => entry.rowId),
      more: { role, window: key === "congress" ? "30d" : key === "latest" ? "all" : windowKey(rule[key].windowDays) } });
    /** @param {string} role */
    const ofRole = (role) => (/** @type {any} */ entry) => entry.role === role;
    const strong = (/** @type {any} */ entry) => (entry.evidence_type === "rct" || entry.evidence_type === "systematic-review" ? 1 : 0);
    // The newest of the zone's items, a row per event, whatever their age (a quiet zone's last news may be older than the rows read).
    const newest = (await listing(user, row.id, {}, { limit: rule.latest.limit })).slice(0, rule.latest.limit).map((entry) => String(entry.id));
    const composed = {
      progress,
      cards: cardList.length ? { key: "cards", cards: cardList, total: cardList.length } : null,
      "key-updates": itemsModule("key-updates", within(rule["key-updates"].windowDays, (entry) => evidenceZoneIsKeyUpdate({ genre: entry.genre,
        practiceChanging: entry.practice_changing === true, safetyAlert: entry.safety_alert === true, flags: entry.flagList })), null),
      "approved-drugs": approvedDrugs(core, nowMs),
      guidelines: itemsModule("guidelines", within(rule.guidelines.windowDays, ofRole("guideline")), "guideline"),
      "key-studies": itemsModule("key-studies", within(rule["key-studies"].windowDays, ofRole("research")).sort((left, right) => strong(right) - strong(left)
        || Number(right.score_total ?? -1) - Number(left.score_total ?? -1) || right.timelineMs - left.timelineMs), "research"),
      safety: itemsModule("safety", within(rule.safety.windowDays, ofRole("safety")), "safety"),
      trials: itemsModule("trials", within(rule.trials.windowDays, (entry) => entry.genre === "trial" || list(entry.registry_ids).length > 0), "research"),
      policy: itemsModule("policy", within(rule.policy.windowDays, ofRole("policy")), "policy"),
      industry: itemsModule("industry", within(rule.industry.windowDays, ofRole("industry")), "industry"),
      congress: itemsModule("congress", congressRows(core, specialties, at), "conference"),
      "multi-source": multi,
      latest: { ...itemsModule("latest", [], null), rowIds: newest },
    };
    // One hydration for every row the page shows: the cards the feed itself serves, with this reader's marks.
    const wanted = [...new Set(Object.values(composed).flatMap((module) => (module && "rowIds" in module ? module.rowIds : [])))];
    const hydrated = wanted.length ? await service.hydrate(user, { rowIds: wanted }) : new Map();
    const modules = [];
    for (const key of evidenceZoneModuleOrder(row.zone_type)) {
      const module = /** @type {any} */ (composed)[key];
      if (!module) continue;
      if (!("rowIds" in module)) { modules.push(module); continue; }
      const shown = module.rowIds.map((/** @type {string} */ id) => hydrated.get(id)).filter(Boolean);
      if (shown.length >= rule[/** @type {EvidenceZoneItemModule} */ (key)].minItems) modules.push({ key, items: shown, more: module.more });
    }
    return {
      zoneId: String(row.id),
      type: row.zone_type ?? null,
      modules,
      side: {
        related,
        entities: entityCounts(core, nowMs),
        weekly: weeks,
        topics: side.topics,
        congresses: side.congresses,
      },
    };
  }

  // ───────────────────────── items ─────────────────────────

  /** @param {Record<string, unknown>} value */
  const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

  /**
   * The filters of the 「动态」 list as one SQL condition and its values (`$3…`; `$1` is the reader, `$2` the zone). `base` is the
   * window, 精选 and the search words; `listed` adds the role — the tab counts are `base`, the list and its total are `listed`.
   * @param {{ days?: number | null, picked?: boolean, q?: string, role?: string | null }} filters @param {Date} at
   */
  function listFilters({ days = null, picked = false, q = "", role = null }, at) {
    /** @type {unknown[]} */
    const values = [];
    const param = (/** @type {unknown} */ value) => { values.push(value); return `$${values.length + 2}`; };
    const where = ["zi.zone_id = $2", "zi.state IN ('in', 'pinned')", notHidden("$1")];
    if (days !== null) where.push(`i.visible_at >= ${param(new Date(at.getTime() - days * DAY_MS).toISOString())}::timestamptz`);
    // 精选 is the editors' pick, a key update (the roles that are one by kind, a practice change, a retraction or a correction) or a
    // score at the selection line.
    if (picked) {
      where.push(`(i.selected OR i.practice_changing OR i.safety_alert OR zi.role IN (${KEY_ROLES.map((key) => `'${key}'`).join(", ")})
        OR i.flags && ARRAY['retracted', 'corrected']::text[] OR i.score_total >= ${param(threshold)})`);
    }
    if (q) {
      const tsquery = tsqueryLiteral(q);
      where.push(tsquery ? `i.lexemes @@ ${param(tsquery)}::tsquery` : `strpos(lower(i.title_raw || ' ' || coalesce(i.title_zh, '')), lower(${param(q)})) > 0`);
    }
    const base = { where: where.join(" AND "), values: [...values] };
    if (role) where.push(`zi.role = ${param(role)}`);
    return { base, listed: { where: where.join(" AND "), values }, param };
  }

  /**
   * One page of a zone's items, a row per event (the zone's best item of it: the selected one, then the higher score), newest first
   * by `(timeline_at, id)`; at most `limit + 1` rows, so a caller sees whether there is more.
   * @param {{ id: string }} user @param {string} zoneId
   * @param {{ days?: number | null, picked?: boolean, q?: string, role?: string | null, position?: { t: string, id: string } | null }} filters
   * @param {{ limit: number, at?: Date }} paging
   */
  async function listing(user, zoneId, { position = null, ...filters }, { limit, at = now() }) {
    const { listed } = listFilters(filters, at);
    const values = [...listed.values];
    let after = "";
    if (position) {
      values.push(position.t, position.id);
      after = `WHERE (r.timeline_at, r.id) < ($${values.length + 1}::timestamptz, $${values.length + 2}::bigint)`;
    }
    return query(user, `SELECT r.id, r.timeline_at FROM (
        SELECT DISTINCT ON (${EVENT_KEY}) i.id, i.timeline_at FROM ${ITEM_FROM} WHERE ${listed.where}
         ORDER BY ${EVENT_KEY}, i.selected DESC, i.score_total DESC NULLS LAST, i.timeline_at DESC, i.id DESC) r
      ${after} ORDER BY r.timeline_at DESC, r.id DESC LIMIT ${limit + 1}`, [zoneId, ...values]);
  }

  /**
   * The 「动态」 list: a page of the zone's items, one per event, newest first, with the tab counts of the window.
   * @param {{ id: string }} user @param {string} ref @param {URLSearchParams} params
   */
  async function items(user, ref, params) {
    const row = await zoneRow(user, ref);
    if (!row) throw missing();
    const role = params.get("role") || null;
    const windowName = params.get("window") || "all";
    const q = (params.get("q") ?? "").trim().replace(/\s+/g, " ");
    const picked = params.get("picked");
    if ((role && !EVIDENCE_ZONE_ROLES.includes(/** @type {any} */ (role))) || !Object.hasOwn(WINDOWS, windowName) || q.length > 200
      || (picked != null && !["1", "0", ""].includes(picked))) throw error(400, "query_invalid", "Invalid evidence query.");
    const filters = { days: WINDOWS[/** @type {keyof typeof WINDOWS} */ (windowName)], picked: picked === "1", q, role };
    const fingerprint = createHash("sha256").update(JSON.stringify([row.id, role, filters.picked, windowName, q])).digest("hex").slice(0, 16);
    let position = null;
    const rawCursor = params.get("cursor");
    if (rawCursor) {
      try {
        const cursor = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
        if (cursor.f !== fingerprint || typeof cursor.t !== "string" || !Number.isFinite(Date.parse(cursor.t)) || !/^\d{1,19}$/.test(String(cursor.id))) throw new Error("cursor");
        position = { t: cursor.t, id: String(cursor.id) };
      } catch {
        throw error(409, "cursor_invalid", "Content changed; restart from the first page.");
      }
    }
    const at = now();
    const { base, listed } = listFilters(filters, at);
    const [page, counts, total] = await Promise.all([
      listing(user, row.id, { ...filters, position }, { limit: PAGE, at }),
      query(user, `SELECT zi.role, count(DISTINCT ${EVENT_KEY})::integer AS n FROM ${ITEM_FROM} WHERE ${base.where} GROUP BY zi.role`, [row.id, ...base.values]),
      query(user, `SELECT count(DISTINCT ${EVENT_KEY})::integer AS n FROM ${ITEM_FROM} WHERE ${listed.where}`, [row.id, ...listed.values]),
    ]);
    const shown = page.slice(0, PAGE);
    const hydrated = shown.length ? await service.hydrate(user, { rowIds: shown.map((entry) => String(entry.id)) }) : new Map();
    const last = shown.at(-1);
    return {
      items: shown.map((entry) => hydrated.get(String(entry.id))).filter(Boolean),
      roleCounts: Object.fromEntries(counts.filter((entry) => Number(entry.n) > 0).map((entry) => [entry.role, Number(entry.n)])),
      nextCursor: page.length > PAGE && last ? encodeCursor({ f: fingerprint, t: iso(last.timeline_at), id: String(last.id) }) : null,
      total: Number(total[0]?.n ?? 0),
    };
  }

  // ───────────────────────── cards ─────────────────────────

  /** @param {{ id: string }} user @param {string} ref */
  async function cardsOf(user, ref) {
    const row = await zoneRow(user, ref);
    if (!row) throw missing();
    const found = cards ? await cards.list({ id: row.id, slug: row.slug ?? null, title: row.title, definition: row.definition }, { limit: 50 }).catch(() => []) : [];
    return { cards: found, provider: cards?.provider ?? "none" };
  }

  // ───────────────────────── addresses ─────────────────────────

  /**
   * The id of the zone an id or slug names, when the reader may see it; anything else comes back as it was asked, so the service
   * that answers the route says 404 in its own words.
   * @param {{ id: string }} user @param {string} ref
   */
  async function resolveId(user, ref) {
    if (typeof ref !== "string" || !REF_PATTERN.test(ref)) return ref;
    const rows = await query(user, `SELECT z.id FROM evimed_frontier.evidence_zones z WHERE (z.id = $2 OR z.slug = $2) AND (z.state = 'published' OR z.user_id = $1)
      ORDER BY (z.id = $2) DESC LIMIT 1`, [ref]);
    return rows[0]?.id ?? ref;
  }

  /**
   * A topic zone the account may read, by id or slug, as `{ id, slug, title }` — what the runtime's search names a zone by.
   * @param {{ id: string }} user @param {unknown} ref
   */
  async function resolveZone(user, ref) {
    const row = await zoneRow(user, ref);
    return row ? { id: String(row.id), slug: row.slug ?? null, title: String(row.title) } : null;
  }

  /**
   * The summaries of the topic zones among these ids that the reader may see, in the order asked (a draft's 「相近的专区」).
   * @param {{ id: string }} user @param {string[]} ids
   */
  async function summaries(user, ids) {
    const wanted = [...new Set(list(ids).filter((id) => typeof id === "string" && REF_PATTERN.test(id)))].slice(0, 50);
    if (!wanted.length) return [];
    const rows = await query(user, `SELECT ${ZONE_COLUMNS} FROM ${ZONE_FROM}
      WHERE z.id = ANY($2::text[]) AND z.lifecycle <> 'none' AND (z.state = 'published' OR z.user_id = $1)`, [wanted]);
    const found = new Map(rows.map((row) => [String(row.id), summary(row, user)]));
    return wanted.flatMap((id) => (found.has(id) ? [found.get(id)] : []));
  }

  return { directory, detail, overview, items, cards: cardsOf, summaries, resolveId, resolveZone };
}

/** @typedef {"key-updates" | "guidelines" | "key-studies" | "safety" | "trials" | "policy" | "industry" | "congress" | "latest"} EvidenceZoneItemModule */
