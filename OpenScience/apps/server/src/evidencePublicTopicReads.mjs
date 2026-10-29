// What the public pages may read of the platform's topic zones (plan 2026-10-29 §4.7, §6.9): the zone's definition and 「最新进展」, its
// key updates, the last thirty days' items as a title, a 导读 and a link to the original — never a body — and the lists the index and the
// sitemap are made from.
//
// Hidden knowledge:
//
// - **Which zones are public is one predicate.** A topic zone is public when it is the platform's (`kind = 'official'`), has a topic
//   definition (`lifecycle <> 'none'`), is published and is opened to the internet (`visibility = 'internet'`). A reader's zone is never
//   public, however it is published (the owner, 2026-10-29: 「我的专区即使公开，也只在平台内可见」): `kind = 'user'` fails here whatever its
//   visibility says, so a row written wrongly still reads as "no such zone", with the same answer a missing id gets.
// - **The zone page does not decide whether it may be indexed; this module hands the counts the rule needs.** `topicIndexable` is the
//   one function — fewer than five items in thirty days and no 最新进展 is `noindex` — and the page, the sitemap and the index all ask
//   it of the same `month`, so a page and its sitemap entry cannot disagree. That count is the page's own: the distinct events the page
//   lists in the window (core and pinned items, `listedMonth` below), never the membership module's `stats.month`, which also counts the
//   related items the public list leaves out — a page that said 「共 40 条」 over six listed titles, and was indexable on the 40, was the
//   defect of 2026-10-29.
// - **`dateModified` is the zone's, not the day's.** The later of the last 最新进展 write and the last key update, else the day the
//   zone was made: an ordinary item arriving moves neither, because a date that moves with every item is a date a search engine learns
//   to ignore. The sitemap's `lastmod` is the same value (`topicModified`).
// - **An item is a title, a one-line 导读 and its original.** The 导读 is shown only when the pipeline's verification passed it
//   (`passed` or `repaired`); a title-only item is a title and a link. The original is the item's canonical address, never ours.
// - **Core and pinned only.** The public list holds what the judge model called central to the zone (and what an operator pinned);
//   the related items stay in the app's full list.
//
// Which model capability would make it deletable: none — it is a projection of rows the platform already holds.

import { FRONTIER_ITEM_FLAG_LABELS_ZH, FRONTIER_SPECIALTY_LABELS_ZH, evidenceZoneIsKeyUpdate, frontierItemGenre, frontierSourceDisplayName } from "@evimed/domain";
import { FRONTIER_SOURCE_STREAM_COLUMNS } from "./frontierSourceColumns.mjs";

/** A zone id as the platform makes it, and a slug as the planner writes one. */
export const EVIDENCE_PUBLIC_TOPIC_ID = /^ez_[A-Za-z0-9]{8,64}$/;
export const EVIDENCE_PUBLIC_TOPIC_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** What a zone page lists: the days it looks back, the items it shows, the key updates it names, and what its feed carries. */
export const EVIDENCE_PUBLIC_TOPIC_LIMITS = Object.freeze({ days: 30, items: 50, keyUpdates: 6, feedItems: 50, indexFloor: 5 });

/** The SQL every public topic read carries. Aliased `z`. */
const PUBLIC_TOPIC = "z.kind = 'official' AND z.lifecycle <> 'none' AND z.state = 'published' AND z.visibility = 'internet' AND z.definition IS NOT NULL";

/** The items a public list holds: what the judge model called central to the zone, and what an operator pinned. Aliased `zi`. */
const LISTED = "(zi.state = 'pinned' OR (zi.state = 'in' AND zi.relevance = 'core'))";

/** @param {unknown} value @returns {string | null} */
const iso = (value) => (value ? new Date(/** @type {any} */ (value)).toISOString() : null);
/** @param {unknown} value */
const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value */
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * Whether a topic zone's page may be indexed: it holds at least five items of the last thirty days or it has a 最新进展 to read. A zone
 * that is quiet or archived keeps its page and its address under the same rule.
 * @param {{ month: number, hasProgress: boolean }} zone
 */
export function topicIndexable({ month, hasProgress }) {
  return hasProgress || month >= EVIDENCE_PUBLIC_TOPIC_LIMITS.indexFloor;
}

/**
 * When a topic zone's page last changed: the later of its 最新进展 and its latest key update, else the day it was made.
 * @param {{ progressAt: string | null, keyUpdateAt: string | null, createdAt: string | null }} zone @returns {string | null}
 */
export function topicModified({ progressAt, keyUpdateAt, createdAt }) {
  const times = [progressAt, keyUpdateAt].filter((value) => value && Number.isFinite(Date.parse(/** @type {string} */ (value)))).map((value) => /** @type {string} */ (value));
  return times.length ? times.reduce((left, right) => (Date.parse(right) > Date.parse(left) ? right : left)) : createdAt;
}

/** One zone row as the public pages hold it. @param {any} row */
function topicZone(row) {
  const definition = record(row.definition);
  const stats = record(row.stats);
  const overview = record(row.overview);
  const progressText = text(overview.text);
  const progressAt = progressText ? iso(row.overview_at) : null;
  const keyUpdateAt = iso(record(stats.keyLatest).at);
  const specialty = String(list(row.specialties)[0] ?? "");
  return {
    id: String(row.id), slug: row.slug ? String(row.slug) : null, title: String(row.title), type: String(row.zone_type ?? ""), scope: String(row.scope_zh || row.description || ""),
    lifecycle: String(row.lifecycle), group: String(row.group_label ?? ""),
    specialty: specialty && Object.hasOwn(FRONTIER_SPECIALTY_LABELS_ZH, specialty) ? { key: specialty, label: FRONTIER_SPECIALTY_LABELS_ZH[specialty] } : null,
    keywords: list(definition.keywords).map(record).filter((keyword) => text(keyword.label))
      .map((keyword) => ({ label: String(keyword.label), tagIds: list(keyword.tagIds).filter((id) => Number.isSafeInteger(id)).map(Number) })),
    month: Number.isFinite(Number(row.listed_month)) ? Number(row.listed_month) : 0,
    week: Number.isFinite(Number(stats.week)) ? Number(stats.week) : 0,
    progress: progressText ? { text: progressText, refs: list(overview.refs).map(record).filter((ref) => Number.isSafeInteger(ref.n) && text(ref.itemId))
      .map((ref) => ({ n: Number(ref.n), itemId: String(ref.itemId) })), at: progressAt } : null,
    keyUpdateAt, createdAt: iso(row.created_at),
    modified: topicModified({ progressAt, keyUpdateAt, createdAt: iso(row.created_at) }),
  };
}

/** @typedef {ReturnType<typeof topicZone>} PublicTopicZone */

/**
 * @param {{ database: any, now?: () => Date }} options
 */
export function createEvidencePublicTopicReads({ database, now = () => new Date() }) {
  const counters = { zones: 0, itemReads: 0, misses: 0 };

  /** The columns a zone's page needs of the zone row. */
  const ZONE_COLUMNS = `z.id, z.slug, z.title, z.zone_type, z.specialties, z.group_label, z.scope_zh, z.description, z.lifecycle, z.definition, z.stats, z.overview,
    z.overview_at, z.created_at`;

  /**
   * The page's own count of the window: the distinct events its list holds, core and pinned items of the last thirty days (the
   * conditions of `items`). The indexing rule and the page's 「共 N 条」 read this, not the stats, which count related items too.
   * @param {string} since a SQL parameter placeholder holding the window's start
   */
  const listedMonth = (since) => `(SELECT count(DISTINCT coalesce(i.event_id, -i.id)) FROM evimed_frontier.zone_items zi
      JOIN evimed_frontier.items i ON i.id = zi.item_id AND i.state = 'published'
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
      WHERE zi.zone_id = z.id AND ${LISTED} AND i.visible_at >= ${since}::timestamptz)::integer AS listed_month`;
  const windowStart = () => new Date(now().getTime() - EVIDENCE_PUBLIC_TOPIC_LIMITS.days * 86_400_000).toISOString();

  /**
   * One public topic zone by id or slug, or null: the answer for a missing zone, a reader's zone, a draft and a zone that is not open to
   * the internet is the same.
   * @param {string} ref @returns {Promise<PublicTopicZone | null>}
   */
  async function zone(ref) {
    if (typeof ref !== "string" || !(EVIDENCE_PUBLIC_TOPIC_ID.test(ref) || EVIDENCE_PUBLIC_TOPIC_SLUG.test(ref))) return null;
    const row = (await database.query(`SELECT ${ZONE_COLUMNS}, ${listedMonth("$2")} FROM evimed_frontier.evidence_zones z WHERE (z.id = $1 OR z.slug = $1) AND ${PUBLIC_TOPIC} LIMIT 1`, [ref, windowStart()])).rows?.[0];
    if (!row) { counters.misses += 1; return null; }
    counters.zones += 1;
    return topicZone(row);
  }

  /**
   * The items of a zone in the last `days` days, newest first, one per event (the selected or higher scored of it), as the page shows
   * them: a title, a 导读 when it was verified, where it came from and its original. Core and pinned items only.
   * @param {string} zoneId @param {{ days?: number, limit?: number }} [options]
   */
  async function items(zoneId, { days = EVIDENCE_PUBLIC_TOPIC_LIMITS.days, limit = EVIDENCE_PUBLIC_TOPIC_LIMITS.items } = {}) {
    counters.itemReads += 1;
    const since = new Date(now().getTime() - days * 86_400_000).toISOString();
    const rows = (await database.query(`SELECT * FROM (
        SELECT DISTINCT ON (coalesce(i.event_id, -i.id)) i.id, i.public_id, i.title_raw, i.title_zh, i.summary_zh, i.verification, i.canonical_url, i.visible_at, i.published_at,
          i.flags, i.genre, i.platform, i.channel, i.source_type, i.evidence_type, i.safety_alert, i.lane, i.practice_changing, zi.role,
          s.id AS source_id, s.name AS source_name, s.owner_entity AS source_owner, ${FRONTIER_SOURCE_STREAM_COLUMNS}
        FROM evimed_frontier.zone_items zi
        JOIN evimed_frontier.items i ON i.id = zi.item_id AND i.state = 'published'
        JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
        WHERE zi.zone_id = $1 AND ${LISTED} AND i.visible_at >= $2::timestamptz
        ORDER BY coalesce(i.event_id, -i.id), i.selected DESC, i.score_total DESC NULLS LAST, i.visible_at DESC, i.id DESC) one
      ORDER BY visible_at DESC, id DESC LIMIT $3`, [zoneId, since, limit])).rows ?? [];
    return rows.map((/** @type {any} */ row) => {
      const genre = frontierItemGenre(row);
      const flags = list(row.flags).map(String);
      const checked = ["passed", "repaired"].includes(String(row.verification));
      return {
        id: String(row.public_id), title: String(text(row.title_zh) ?? row.title_raw ?? ""), guide: checked ? text(row.summary_zh) : null,
        source: frontierSourceDisplayName({ id: row.source_id, name: row.source_name, ownerEntity: row.source_owner, access: row.source_access, journal: row.item_journal }),
        url: String(row.canonical_url ?? ""), at: iso(row.published_at ?? row.visible_at), visibleAt: iso(row.visible_at), role: String(row.role),
        key: evidenceZoneIsKeyUpdate({ genre, practiceChanging: row.practice_changing === true, safetyAlert: row.safety_alert === true, flags }),
        labels: flags.filter((flag) => flag === "retracted" || flag === "corrected").map((flag) => /** @type {any} */ (FRONTIER_ITEM_FLAG_LABELS_ZH)[flag]),
      };
    });
  }

  /**
   * The items 最新进展 cites, by public id, with the title and the original each stands for (the paragraph's `[n]`).
   * @param {string[]} publicIds
   * @returns {Promise<Map<string, { title: string, source: string, url: string }>>}
   */
  async function cited(publicIds) {
    const ids = [...new Set(publicIds.map(String))].slice(0, 60);
    if (!ids.length) return new Map();
    const rows = (await database.query(`SELECT i.public_id, i.title_raw, i.title_zh, i.canonical_url, s.id AS source_id, s.name AS source_name, s.owner_entity AS source_owner,
        ${FRONTIER_SOURCE_STREAM_COLUMNS}
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
      WHERE i.public_id = ANY($1::text[]) AND i.state = 'published'`, [ids])).rows ?? [];
    return new Map(rows.map((/** @type {any} */ row) => [String(row.public_id), {
      title: String(text(row.title_zh) ?? row.title_raw ?? ""), url: String(row.canonical_url ?? ""),
      source: frontierSourceDisplayName({ id: row.source_id, name: row.source_name, ownerEntity: row.source_owner, access: row.source_access, journal: row.item_journal }),
    }]));
  }

  /**
   * What a keyword's tag says of it for the page's machine-readable part: the tag's kind, its English name and the MeSH id it carries.
   * The first tag of a keyword that is still in use stands for it.
   * @param {PublicTopicZone} zoneRow @returns {Promise<Map<string, { kind: string | null, nameEn: string | null, meshUi: string | null }>>}
   */
  async function keywordTags(zoneRow) {
    const ids = [...new Set(zoneRow.keywords.flatMap((keyword) => keyword.tagIds.slice(0, 3)))];
    if (!ids.length) return new Map();
    const tags = new Map(((await database.query(`SELECT id, kind, name_en, mesh_ui FROM evimed_frontier.tags WHERE id = ANY($1::bigint[]) AND state = 'active'`, [ids])).rows ?? [])
      .map((/** @type {any} */ row) => [Number(row.id), { kind: row.kind ?? null, nameEn: text(row.name_en), meshUi: text(row.mesh_ui) }]));
    return new Map(zoneRow.keywords.flatMap((keyword) => {
      const tag = keyword.tagIds.map((id) => tags.get(id)).find(Boolean);
      return tag ? [[keyword.label, tag]] : [];
    }));
  }

  /**
   * The index: every public topic zone that is active or quiet, grouped by its first specialty and its group, the heaviest week first and a
   * level of only quiet zones last (the in-app directory's order).
   */
  async function index() {
    const rows = (await database.query(`SELECT ${ZONE_COLUMNS} FROM evimed_frontier.evidence_zones z WHERE ${PUBLIC_TOPIC} AND z.lifecycle IN ('active', 'quiet')
      ORDER BY z.updated_at DESC, z.id LIMIT 500`)).rows ?? [];
    const zones = rows.map(topicZone);
    /** @type {Map<string, { specialty: { key: string, label: string }, groups: Map<string, PublicTopicZone[]> }>} */
    const specialties = new Map();
    for (const entry of zones) {
      const specialty = entry.specialty ?? { key: "other", label: "其他" };
      const held = specialties.get(specialty.key) ?? { specialty, groups: new Map() };
      specialties.set(specialty.key, held);
      const group = entry.group || "";
      held.groups.set(group, [...(held.groups.get(group) ?? []), entry]);
    }
    /** @param {PublicTopicZone[]} members */
    const weight = (members) => ({ quiet: members.every((member) => member.lifecycle === "quiet") ? 1 : 0, week: members.reduce((sum, member) => sum + member.week, 0) });
    /** @param {{ quiet: number, week: number }} left @param {{ quiet: number, week: number }} right */
    const heavier = (left, right) => left.quiet - right.quiet || right.week - left.week;
    return [...specialties.values()].map((entry) => ({
      specialty: entry.specialty,
      groups: [...entry.groups.entries()].map(([label, members]) => ({ label, zones: [...members].sort((left, right) => (left.lifecycle === "quiet" ? 1 : 0) - (right.lifecycle === "quiet" ? 1 : 0)
        || right.week - left.week || left.title.localeCompare(right.title, "zh")), weight: weight(members) }))
        .sort((left, right) => heavier(left.weight, right.weight) || (left.label === "" ? 1 : 0) - (right.label === "" ? 1 : 0) || left.label.localeCompare(right.label, "zh"))
        .map(({ label, zones: members }) => ({ label, zones: members })),
      weight: weight([...entry.groups.values()].flat()),
    })).sort((left, right) => (left.specialty.key === "other" ? 1 : 0) - (right.specialty.key === "other" ? 1 : 0) || heavier(left.weight, right.weight)
      || left.specialty.label.localeCompare(right.specialty.label, "zh")).map(({ specialty, groups }) => ({ specialty, groups }));
  }

  /** Every public topic zone a sitemap may list, with what the indexing rule needs (the sitemap asks `topicIndexable` of each). */
  async function sitemapEntries() {
    const rows = (await database.query(`SELECT ${ZONE_COLUMNS}, ${listedMonth("$1")} FROM evimed_frontier.evidence_zones z WHERE ${PUBLIC_TOPIC} ORDER BY z.updated_at DESC, z.id LIMIT 1000`, [windowStart()])).rows ?? [];
    return rows.map(topicZone).map((entry) => ({ id: entry.id, month: entry.month, hasProgress: Boolean(entry.progress), lastmod: entry.modified }));
  }

  return { zone, items, cited, keywordTags, index, sitemapEntries, stats: () => ({ ...counters }) };
}
