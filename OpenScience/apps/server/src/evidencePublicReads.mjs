// How often the public evidence pages are read (flywheel F08, 2026-10-06): the one input "nobody reads it" and the topic selector's
// attention signal had none of.
//
// Hidden knowledge:
//
// - **A count and nothing else.** One row per zone page or card page and day, one UPSERT per read; no address, no user agent, no
//   cookie and no referrer is kept, so the table can say how many times a page was read and never who read it.
// - **A day is the platform's own** (Asia/Shanghai), the same day the frontier's daily and the monthly figures use.
// - **A request that says it is a program is not a reader.** A user agent that names a bot, crawler or spider (or carries none at
//   all) is not counted. The list is closed and is a format check on a header, not a reading of anything a person wrote; a scraper
//   that lies is counted as a reader, which is why the figure is "reads of the page" and not "people".
// - **A failure to count never fails the page** (a counter is not worth a reader's page): the failure is counted and reported.

import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

/** The substrings (lower case) that mark a user agent as a program. */
export const EVIDENCE_PUBLIC_BOT_MARKERS = Object.freeze([
  "bot", "crawl", "spider", "slurp", "facebookexternalhit", "bingpreview", "headless", "python-requests", "curl/", "wget/", "go-http-client",
]);

/** Whether a user agent is a program rather than a browser. @param {unknown} userAgent */
export function evidencePublicIsBot(userAgent) {
  const agent = typeof userAgent === "string" ? userAgent.trim().toLowerCase() : "";
  return !agent || EVIDENCE_PUBLIC_BOT_MARKERS.some((marker) => agent.includes(marker));
}

/** The day of an instant in the platform's time zone, `YYYY-MM-DD`. @param {Date} instant */
export function evidencePublicDay(instant) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/**
 * Count one read of a zone page (`cardId` omitted) or a card page.
 * @param {any} database @param {{ zoneId: string, cardId?: string | null, day: string }} read
 */
export async function recordPageRead(database, { zoneId, cardId = null, day }) {
  await migrateEvidenceZones(database);
  await database.query(
    `INSERT INTO evimed_frontier.evidence_page_reads(zone_id, card_id, day, reads) VALUES($1, $2, $3::date, 1)
     ON CONFLICT (zone_id, card_id, day) DO UPDATE SET reads = evidence_page_reads.reads + 1`,
    [zoneId, cardId ?? "", day],
  );
}

/**
 * Reads since a day, per zone page and card page — the selector's attention input. Give `zoneIds` or `cardIds` (or both) to narrow it.
 * `since` is a day (`YYYY-MM-DD`) or a `Date`; a zone's own page is the row whose `cardId` is null.
 * @param {any} database @param {{ zoneIds?: string[], cardIds?: string[], since: string | Date }} query
 * @returns {Promise<{ zoneId: string, cardId: string | null, reads: number }[]>}
 */
export async function pageReads(database, { zoneIds, cardIds, since }) {
  const day = since instanceof Date ? evidencePublicDay(since) : String(since);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError("`since` is a day written YYYY-MM-DD, or a Date.");
  await migrateEvidenceZones(database);
  const rows = (await database.query(
    `SELECT zone_id, card_id, sum(reads)::integer AS reads FROM evimed_frontier.evidence_page_reads
     WHERE day >= $1::date AND ($2::text[] IS NULL OR zone_id = ANY($2::text[])) AND ($3::text[] IS NULL OR card_id = ANY($3::text[]))
     GROUP BY zone_id, card_id ORDER BY zone_id, card_id`,
    [day, zoneIds ?? null, cardIds ?? null],
  )).rows;
  return rows.map((/** @type {any} */ row) => ({ zoneId: String(row.zone_id), cardId: row.card_id === "" ? null : String(row.card_id), reads: Number(row.reads) }));
}
