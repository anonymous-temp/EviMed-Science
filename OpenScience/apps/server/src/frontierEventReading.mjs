import { createHash } from 'node:crypto';
import { frontierSourceDisplayName } from '@evimed/domain';

// Reader state is still exportable when the feed is disabled. Both migration
// entry points share the feed's lock and this one definition of the table.
export const FRONTIER_EVENT_READING_SQL = `
CREATE SCHEMA IF NOT EXISTS evimed_frontier;
CREATE TABLE IF NOT EXISTS evimed_frontier.event_reads (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  report_marks jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, event_id)
);
`;
const migrations = new WeakMap();

/** @param {any} database */
export async function migrateFrontierEventReading(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-frontier-v1'))");
    await client.query(FRONTIER_EVENT_READING_SQL);
  });
  migrations.set(database, attempt);
  try { await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}

/** Fingerprint reader-visible facts, excluding popularity and bookkeeping. @param {any} report */
export function frontierReportFingerprint(report) {
  return createHash('sha256').update(JSON.stringify([report.role, report.title, report.summary, report.studyIds])).digest('hex');
}

/** @param {any[]} reports @param {Record<string,string> | null} baseline */
export function frontierEventChanges(reports, baseline) {
  const mark = Object.fromEntries(reports.slice(0, 256).map(report => [report.id, frontierReportFingerprint(report)]));
  return { mark, changes: baseline ? reports.filter(report => baseline[report.id] !== mark[report.id]).map(report => ({
    id: report.id, kind: baseline[report.id] ? 'updated' : 'added', title: report.title, summary: report.summary,
  })) : [] };
}

// ───────────────────────── follow-ups and the story (fr-events, 2026-10-22) ─────────────────────────
//
// An event is one occurrence; its story is the occurrences that follow from one another. The grouping call writes a
// `follows` link (older → newer) for a direct development instead of a merge, and always to the story's root — the event the
// candidate itself follows, else the candidate — so a story grows as a star around its root and never by chaining (AIHOT
// `storyForDevelopment`). The story of an event is therefore within two hops: the events it follows, the events that follow
// it, and the other followers of its roots.

/** Follow-up rows an item page shows at most (AIHOT `publication/followups.ts`: SHOWN = 8). */
export const FRONTIER_FOLLOWUPS_SHOWN = 8;
const OFFICIAL_SOURCE_TYPES = Object.freeze(['regulator']);

/**
 * A report's claim to speak for its event (AIHOT `representative.ts`, read for medicine): a regulator's own notice, then the
 * party's own text (the paper, the guideline), then any report.
 * @param {{ role?: string | null, source_type?: string | null }} row
 */
export function frontierRepresentativePriority(row) {
  if (row?.role === 'primary' && OFFICIAL_SOURCE_TYPES.includes(String(row?.source_type ?? ''))) return 0;
  if (row?.role === 'primary') return 1;
  return 2;
}

/**
 * The report that stands for a set of reports: the strongest claim to speak for the event, then a selected one, then the
 * higher score, then the earliest, then the lower id (AIHOT `pickRepresentative`). Null for no rows.
 * @template {{ id: string | number, role?: string | null, source_type?: string | null, selected?: boolean | null,
 *              score_total?: number | string | null, timeline_at: Date | string }} T
 * @param {T[]} rows @returns {T | null}
 */
export function frontierRepresentative(rows) {
  return [...rows].sort((left, right) => frontierRepresentativePriority(left) - frontierRepresentativePriority(right)
    || Number(right.selected === true) - Number(left.selected === true)
    || Number(right.score_total ?? 0) - Number(left.score_total ?? 0)
    || new Date(left.timeline_at).getTime() - new Date(right.timeline_at).getTime()
    || Number(left.id) - Number(right.id))[0] ?? null;
}

/**
 * The other events of an event's story (see above), live ones only: those it follows, those that follow it, and the other
 * followers of what it follows. Ids as strings, without the event itself.
 * @param {{ query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }} client @param {string | number} eventId
 * @returns {Promise<string[]>}
 */
export async function frontierStoryEventIds(client, eventId) {
  const rows = (await client.query(`WITH roots AS (
        SELECT from_event_id AS id FROM evimed_frontier.event_links WHERE to_event_id = $1 AND relation = 'follows'),
      story AS (
        SELECT id FROM roots
        UNION SELECT to_event_id FROM evimed_frontier.event_links WHERE from_event_id = $1 AND relation = 'follows'
        UNION SELECT l.to_event_id FROM evimed_frontier.event_links l JOIN roots r ON r.id = l.from_event_id WHERE l.relation = 'follows')
    SELECT e.id FROM story JOIN evimed_frontier.events e ON e.id = story.id
    WHERE e.id <> $1 AND e.merged_into IS NULL AND e.report_count > 0 ORDER BY e.id`, [eventId])).rows ?? [];
  return rows.map((row) => String(row.id));
}

/** What a follow-up row reads of a report. */
const REPORT_COLUMNS = `ei.event_id, ei.role, i.id, i.public_id, i.title_zh, i.title_raw, i.timeline_at, i.selected, i.score_total,
  i.source_type, s.id AS source_id, s.name AS source_name, s.owner_entity`;

/**
 * The visible reports of these events, by event.
 * @param {{ query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }} client @param {string[]} eventIds
 * @returns {Promise<Map<string, any[]>>}
 */
export async function frontierEventReports(client, eventIds) {
  /** @type {Map<string, any[]>} */
  const byEvent = new Map(eventIds.map((id) => [String(id), []]));
  if (!eventIds.length) return byEvent;
  const rows = (await client.query(`SELECT ${REPORT_COLUMNS}, e.public_id AS event_public_id, e.first_at AS event_first_at
    FROM evimed_frontier.event_items ei
    JOIN evimed_frontier.items i ON i.id = ei.item_id
    JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
    JOIN evimed_frontier.events e ON e.id = ei.event_id
    WHERE ei.event_id = ANY($1::bigint[]) AND i.state = 'published' AND s.enabled`, [eventIds])).rows ?? [];
  for (const row of rows) byEvent.get(String(row.event_id))?.push(row);
  return byEvent;
}

/** One report as a follow-up row. @param {any} row @param {"same-event" | "follows"} relation */
function followupRow(row, relation) {
  return {
    itemId: String(row.public_id), title: String(row.title_zh || row.title_raw),
    sourceName: frontierSourceDisplayName({ id: row.source_id, name: row.source_name, ownerEntity: row.owner_entity }),
    at: new Date(row.timeline_at).toISOString(), relation,
  };
}

/**
 * 「事件后续」 for one item (contract B `followups`): the other reports of its event — one per institution, its newest — and
 * each other event of its story by its representative report, newest first, at most `limit`, the item itself never among
 * them; `more` when there were others. Null when the item is not published, has no event, or there is nothing to show.
 * @param {{ query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }} client a pg client or pool
 * @param {string | number} itemRowId `items.id`
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ eventId: string, rows: Array<{ itemId: string, title: string, sourceName: string, at: string,
 *   relation: "same-event" | "follows" }>, more: boolean } | null>}
 */
export async function frontierItemFollowups(client, itemRowId, { limit = FRONTIER_FOLLOWUPS_SHOWN } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError('The follow-up limit is invalid.');
  const item = (await client.query(`SELECT i.id, coalesce(e.merged_into, e.id) AS event_id FROM evimed_frontier.items i
    JOIN evimed_frontier.events e ON e.id = i.event_id WHERE i.id = $1 AND i.state = 'published'`, [itemRowId])).rows?.[0];
  if (!item?.event_id) return null;
  const eventId = String(item.event_id);
  const event = (await client.query(`SELECT public_id FROM evimed_frontier.events WHERE id = $1 AND merged_into IS NULL`, [eventId])).rows?.[0];
  if (!event) return null;
  const story = await frontierStoryEventIds(client, eventId);
  const reports = await frontierEventReports(client, [eventId, ...story]);
  /** @type {Map<string, any>} institution → its newest other report of this event */
  const newest = new Map();
  for (const row of reports.get(eventId) ?? []) {
    if (String(row.id) === String(item.id)) continue;
    const key = String(row.owner_entity || row.source_id);
    const seen = newest.get(key);
    if (!seen || new Date(row.timeline_at).getTime() > new Date(seen.timeline_at).getTime()
      || (new Date(row.timeline_at).getTime() === new Date(seen.timeline_at).getTime() && Number(row.id) > Number(seen.id))) newest.set(key, row);
  }
  const rows = [...[...newest.values()].map((row) => ({ row, relation: /** @type {const} */ ('same-event') })),
    ...story.flatMap((id) => {
      const representative = frontierRepresentative(reports.get(id) ?? []);
      return representative && String(representative.id) !== String(item.id) ? [{ row: representative, relation: /** @type {const} */ ('follows') }] : [];
    })]
    .sort((left, right) => new Date(right.row.timeline_at).getTime() - new Date(left.row.timeline_at).getTime() || Number(right.row.id) - Number(left.row.id));
  if (!rows.length) return null;
  return { eventId: String(event.public_id), rows: rows.slice(0, limit).map(({ row, relation }) => followupRow(row, relation)), more: rows.length > limit };
}
