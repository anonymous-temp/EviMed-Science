/**
 * What changed in the zones a reader owns or follows, told three ways: a line in the daily notice, a section of the 日报 and a
 * section of the 周刊 (plan 2026-10-29 §4.5, §4.6; the owner's decision of that day replaced the card notices and the typed-follow
 * lines these places used to carry).
 *
 * Hidden knowledge:
 *
 * - **A zone is "the reader's" when they own it or follow it.** A reader's own topic zones (`kind = 'user'`, a topic definition) count
 *   as followed without a follow row; every other zone is in `evidence_zone_follows`. A zone is read only while it is `active` or
 *   `quiet` and the reader may see it — their own, or published. A follow of a zone its owner has taken back to a draft tells the
 *   follower nothing, so a private zone never leaks through an old follow row.
 * - **What is told is a key update, never the stream.** The rows of `zone_items` that are `core` (or pinned) in the zone and whose
 *   item is a 重要更新 (`evidenceZoneIsKeyUpdate`, the same rule the zone page uses), one per event, newest first. The rule reads the
 *   item's own columns; nothing here judges words.
 * - **The notice claims what it tells, then tells it.** `claimZoneNotice` writes a row to `zone_notice_claims` for every item it will
 *   name, in one statement that is idempotent (`ON CONFLICT DO NOTHING`), and names only the items whose row it wrote: an item — and
 *   its event, so two sources reporting one thing do not read as two — is named at most once to a reader, whichever zone it is in,
 *   and two processes scanning at once cannot name it twice. `releaseZoneNotice` gives the rows back when the notice could not be
 *   made (as the typed follows' claim did). The window is the last three days, and for a followed zone no earlier than the day the
 *   reader followed it (a zone made today is not "news" for what it collected backwards).
 * - **The pages are read-only.** The 日报 and the 周刊 never claim: they read the same selection over the issue's own window
 *   (`readZoneUpdates` with `claimed: "ignore"`), for the reader who asks, and the issue's text — the same for everyone — holds none
 *   of it.
 * - **The categories of the week are the item's role.** 新证据 / 指南与共识 / 监管批准 / 试验进展 / 政策与支付 / 行业动态 are read
 *   from the stored role of the pair (`zone_items.role`, which is the item's genre) with one exception, a trial's registry entry,
 *   which the role calls research and the week calls 试验进展.
 *
 * Which model capability would make it deletable: none — it is a projection of rows the platform already holds.
 *
 * @module frontierZoneUpdates
 */

import { evidenceZoneIsKeyUpdate, frontierItemGenre } from "@evimed/domain";

const DAY_MS = 24 * 60 * 60_000;

/** What a daily notice tells of zones: the most items of a zone, the most zones, how far back, and how far a read looks. */
export const ZONE_NOTICE = Object.freeze({ perZone: 2, zones: 3, windowMs: 3 * DAY_MS, rows: 400, claimKeepMs: 14 * DAY_MS, titleChars: 60 });
/** What an issue's section shows of zones (read only, so no notice's ceiling): per zone and zones, daily and weekly. */
export const ZONE_ISSUE = Object.freeze({ dailyPerZone: 2, weeklyPerZone: 3, zones: 12, rows: 600 });

/** The week's fixed categories, in the order a zone's items are listed (plan §4.3, Z17). */
export const ZONE_WEEK_CATEGORIES = Object.freeze(/** @type {const} */ ([
  { key: "evidence", label: "新证据" },
  { key: "guideline", label: "指南与共识" },
  { key: "regulatory", label: "监管批准" },
  { key: "trial", label: "试验进展" },
  { key: "policy", label: "政策与支付" },
  { key: "industry", label: "行业动态" },
]));
/** @typedef {typeof ZONE_WEEK_CATEGORIES[number]["key"]} ZoneWeekCategory */

/**
 * Which of the week's categories an item stands in, from the pair's stored role and the item's genre. A conference report or a
 * piece of news that is a key update at all is one about evidence (a practice change, a retraction), so it reads as new evidence.
 * @param {{ role?: string | null, genre?: string | null }} row
 * @returns {ZoneWeekCategory}
 */
export function zoneWeekCategory({ role, genre }) {
  if (genre === "trial") return "trial";
  if (role === "guideline") return "guideline";
  if (role === "approval" || role === "safety") return "regulatory";
  if (role === "policy") return "policy";
  if (role === "industry") return "industry";
  return "evidence";
}
/** @param {ZoneWeekCategory} key */
const categoryOrder = (key) => ZONE_WEEK_CATEGORIES.findIndex((category) => category.key === key);
/** @param {ZoneWeekCategory} key */
export const zoneWeekCategoryLabel = (key) => ZONE_WEEK_CATEGORIES.find((category) => category.key === key)?.label ?? "";

/**
 * @typedef {{ rowId: string, publicId: string, title: string, at: string, category: ZoneWeekCategory, eventKey: string }} ZoneUpdateItem
 * @typedef {{ zoneId: string, slug: string | null, zoneTitle: string, items: ZoneUpdateItem[], latest: number }} ZoneUpdateZone
 */

/** @param {unknown} value */
const iso = (value) => new Date(/** @type {any} */ (value)).toISOString();

/** The SQL that holds for an item (`i`) a reader has hidden. @param {string} user */
const hiddenBy = (user) => `EXISTS (SELECT 1 FROM evimed_frontier.user_state us WHERE us.user_id = ${user} AND us.item_id = i.id AND us.hidden_at IS NOT NULL)`;

/**
 * The key updates in a reader's zones over a window, newest first: every (zone, item) pair the reader's zones hold that is a 重要更新,
 * with the zone's title and slug. Rows only; `shapeZoneUpdates` chooses among them.
 * @param {any} database
 * @param {{ userId: string, from: Date | string, to: Date | string, claimed: "exclude" | "ignore", sinceFollow?: boolean, rows?: number }} options
 *   `claimed: "exclude"` leaves out what the reader was already told (the notice); `sinceFollow` keeps a followed zone's items no
 *   older than the follow (the notice).
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function readZoneUpdates(database, { userId, from, to, claimed, sinceFollow = false, rows = ZONE_ISSUE.rows }) {
  const found = (await database.query(`WITH mine AS (
      SELECT zone_id, min(since) AS since FROM (
        SELECT f.zone_id, f.created_at AS since FROM evimed_frontier.evidence_zone_follows f WHERE f.user_id = $1
        UNION ALL
        SELECT z.id, z.created_at FROM evimed_frontier.evidence_zones z WHERE z.user_id = $1 AND z.kind = 'user' AND z.lifecycle <> 'none'
      ) u GROUP BY zone_id)
    SELECT z.id AS zone_id, z.slug, z.title AS zone_title, zi.role, i.id AS row_id, i.public_id, coalesce(nullif(i.title_zh, ''), i.title_raw) AS title,
      i.visible_at, i.event_id, coalesce(i.event_id, -i.id) AS event_key, i.genre, i.platform, i.channel, i.source_type, i.evidence_type, i.flags,
      i.safety_alert, i.lane, i.practice_changing
    FROM mine
    JOIN evimed_frontier.evidence_zones z ON z.id = mine.zone_id AND z.lifecycle IN ('active', 'quiet') AND (z.user_id = $1 OR z.state = 'published')
    JOIN evimed_frontier.zone_items zi ON zi.zone_id = z.id AND (zi.state = 'pinned' OR (zi.state = 'in' AND zi.relevance = 'core'))
    JOIN evimed_frontier.items i ON i.id = zi.item_id AND i.state = 'published'
    JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
    WHERE i.visible_at >= $2::timestamptz AND i.visible_at < $3::timestamptz
      AND (NOT $5::boolean OR i.visible_at >= mine.since)
      AND NOT ${hiddenBy("$1")}
      AND (i.practice_changing OR i.safety_alert OR i.genre IN ('guideline', 'approval', 'safety') OR i.flags && ARRAY['retracted', 'corrected']::text[]
        OR i.genre IS NULL OR i.genre = '' OR zi.role IN ('guideline', 'approval', 'safety'))
      AND ($6::boolean OR NOT EXISTS (SELECT 1 FROM evimed_frontier.zone_notice_claims c
        WHERE c.user_id = $1 AND (c.item_id = i.id OR c.event_key = coalesce(i.event_id, -i.id))))
    ORDER BY i.visible_at DESC, i.id DESC LIMIT $4`,
  [userId, iso(from), iso(to), Math.max(1, Math.min(2000, Math.trunc(rows))), sinceFollow, claimed === "ignore"])).rows ?? [];
  // The SQL only narrows (a row that could be a key update); the rule itself is the domain's, read on the item's resolved genre.
  return found.filter((/** @type {any} */ row) => evidenceZoneIsKeyUpdate({ genre: frontierItemGenre(row), practiceChanging: row.practice_changing === true,
    safetyAlert: row.safety_alert === true, flags: Array.isArray(row.flags) ? row.flags : [] }));
}

/**
 * Choose among the key updates: one item per event, at most `perZone` of a zone, at most `zones` zones, the zone with the most
 * recent update first (ties: the zone with more, then its title). An item sits in one zone only — the first that chose it — so two
 * zones holding one thing do not name it twice.
 * @param {Array<Record<string, any>>} rows newest first
 * @param {{ perZone: number, zones: number }} limits
 * @returns {{ zones: ZoneUpdateZone[], more: number }} `more` counts the zones that had an update and are not in `zones`
 */
export function shapeZoneUpdates(rows, { perZone, zones: zoneLimit }) {
  /** @type {Map<string, ZoneUpdateZone>} */
  const byZone = new Map();
  const seenEvents = new Set();
  for (const row of rows) {
    const eventKey = String(row.event_key);
    if (seenEvents.has(eventKey)) continue;
    let zone = byZone.get(String(row.zone_id));
    if (!zone) {
      zone = { zoneId: String(row.zone_id), slug: row.slug ? String(row.slug) : null, zoneTitle: String(row.zone_title), items: [], latest: new Date(row.visible_at).getTime() };
      byZone.set(zone.zoneId, zone);
    }
    if (zone.items.length >= perZone) continue;
    seenEvents.add(eventKey);
    zone.items.push({ rowId: String(row.row_id), publicId: String(row.public_id), title: String(row.title), at: iso(row.visible_at), eventKey,
      category: zoneWeekCategory({ role: row.role, genre: frontierItemGenre(row) }) });
  }
  const ordered = [...byZone.values()].filter((zone) => zone.items.length)
    .sort((left, right) => right.latest - left.latest || right.items.length - left.items.length || left.zoneTitle.localeCompare(right.zoneTitle, "zh"));
  return { zones: ordered.slice(0, zoneLimit), more: Math.max(0, ordered.length - zoneLimit) };
}

/**
 * The lines of a daily notice about zones, one per zone — 「你关注的“GLP-1 受体激动剂减重”：…；…」 — and one for the rest.
 * @param {{ zones: ZoneUpdateZone[], more: number }} told
 * @returns {string[]}
 */
export function zoneNoticeLines({ zones, more }) {
  const clip = (/** @type {string} */ title) => { const characters = [...title.replace(/\s+/g, " ").trim()]; return characters.length > ZONE_NOTICE.titleChars ? `${characters.slice(0, ZONE_NOTICE.titleChars).join("")}…` : characters.join(""); };
  const lines = zones.map((zone) => `你关注的“${zone.zoneTitle}”：${zone.items.map((item) => clip(item.title)).join("；")}`);
  if (more > 0) lines.push(`另有 ${more} 个专区有更新`);
  return lines;
}

/**
 * Take the zone updates a reader's daily notice will name, and mark them as named (`zone_notice_claims`), in the last three days and
 * not named before. What the notice tells is the claims this call wrote — an item another process claimed first is not told twice.
 * @param {any} database @param {string} userId @param {Date} now
 * @returns {Promise<{ zones: ZoneUpdateZone[], more: number, claimed: string[] }>} `claimed` are the item row ids to give back to `releaseZoneNotice`
 */
export async function claimZoneNotice(database, userId, now) {
  await database.query("DELETE FROM evimed_frontier.zone_notice_claims WHERE user_id = $1 AND notified_at < $2::timestamptz",
    [userId, new Date(now.getTime() - ZONE_NOTICE.claimKeepMs).toISOString()]);
  const rows = await readZoneUpdates(database, { userId, from: new Date(now.getTime() - ZONE_NOTICE.windowMs), to: now, claimed: "exclude", sinceFollow: true, rows: ZONE_NOTICE.rows });
  const chosen = shapeZoneUpdates(rows, ZONE_NOTICE);
  const items = chosen.zones.flatMap((zone) => zone.items.map((item) => ({ ...item, zoneId: zone.zoneId })));
  if (!items.length) return { zones: [], more: chosen.more, claimed: [] };
  const written = new Set(((await database.query(`INSERT INTO evimed_frontier.zone_notice_claims (user_id, item_id, zone_id, event_key, notified_at)
      SELECT $1, t.item_id, t.zone_id, t.event_key, $5::timestamptz FROM unnest($2::bigint[], $3::text[], $4::bigint[]) AS t(item_id, zone_id, event_key)
      ON CONFLICT DO NOTHING RETURNING item_id::text AS item_id`,
  [userId, items.map((item) => item.rowId), items.map((item) => item.zoneId), items.map((item) => item.eventKey), now.toISOString()])).rows ?? [])
    .map((/** @type {any} */ row) => String(row.item_id)));
  const zones = chosen.zones.map((zone) => ({ ...zone, items: zone.items.filter((item) => written.has(item.rowId)) })).filter((zone) => zone.items.length);
  return { zones, more: chosen.more, claimed: [...written] };
}

/** A notice that could not be made gives its items back. @param {any} database @param {string} userId @param {string[]} claimed item row ids */
export async function releaseZoneNotice(database, userId, claimed) {
  if (!claimed.length) return;
  await database.query("DELETE FROM evimed_frontier.zone_notice_claims WHERE user_id = $1 AND item_id = ANY($2::bigint[])", [userId, claimed]);
}

/**
 * 「你关注的专区」 of an issue for one reader: the key updates in the reader's zones over the issue's window, the item's public id, its
 * week category and the zone's address. Computed for the reader who asks and never written into the issue (the issue is the same for
 * everyone); none for a reader with no zone or a window without a key update.
 * @param {any} database
 * @param {{ userId: string, from: Date | string, to: Date | string, weekly?: boolean }} window
 * @returns {Promise<ZoneUpdateZone[]>}
 */
export async function followedZoneUpdates(database, { userId, from, to, weekly = false }) {
  const rows = await readZoneUpdates(database, { userId, from, to, claimed: "ignore" });
  return shapeZoneUpdates(rows, { perZone: weekly ? ZONE_ISSUE.weeklyPerZone : ZONE_ISSUE.dailyPerZone, zones: ZONE_ISSUE.zones }).zones
    .map((zone) => ({ ...zone, items: weekly ? [...zone.items].sort((left, right) => categoryOrder(left.category) - categoryOrder(right.category)) : zone.items }));
}
