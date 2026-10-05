/**
 * The public change log of the evidence zones (evidence-flywheel plan 2026-10-05 §8, F14): every correction, update,
 * withdrawal and retirement of a card, with its date, what changed, and what made it change.
 *
 * Hidden knowledge:
 *
 * - **Append-only, in the database and in the module.** This module has no update or delete, and the table refuses both
 *   (`evidenceZonePersistence.mjs`: a trigger raises on UPDATE, DELETE and TRUNCATE). Both, because a log that only the
 *   module's good behaviour protects is a log whoever writes SQL can rewrite.
 * - **The sentence is made by code.** `summary` is `evidenceChangeSummaryZh(category, trigger, facts)` — never a model's
 *   and never the card's own prose — so what a reader is told about a card's history cannot be the thing that was wrong.
 * - **Entries carry references, not copies.** The source changes (identifier, kind, when first seen), the frontier items,
 *   the challenge and the claim an entry rests on are named in `refs`, so the monthly figures are computed from the tables
 *   alone (a correction's latency is `occurred_at` minus the earliest `firstSeenAt`, or the challenge's creation).
 * - **It reads whatever it is given a visible zone for.** Who may read a zone is the caller's check (the route, or the public
 *   page for an internet-visible zone); the log holds no private data — card and zone ids, identifiers, code-made sentences.
 *
 * @module evidenceChangeLog
 */
import {
  EVIDENCE_CHANGE_CATEGORIES, EVIDENCE_CHANGE_CATEGORY_LABELS_ZH, EVIDENCE_CHANGE_TRIGGERS, EVIDENCE_CHANGE_TRIGGER_LABELS_ZH,
  evidenceChangeSummaryZh,
} from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

/** Entries one page of the log carries. */
export const EVIDENCE_CHANGE_LOG_MAX_PAGE = 100;
/** What one entry's references hold, so a card with many changed sources cannot make a row of unbounded size. */
const REF_LIMITS = Object.freeze({ sourceChanges: 20, frontierItemIds: 20 });

/** @param {unknown} value @param {number} max */
const text = (value, max) => (typeof value === "string" && value ? value.slice(0, max) : null);

/**
 * The references an entry rests on, bounded and with only the fields the readers use.
 * @param {any} refs
 */
export function changeLogRefs(refs) {
  const out = /** @type {Record<string, any>} */ ({});
  if (Array.isArray(refs?.sourceChanges)) {
    out.sourceChanges = refs.sourceChanges.slice(0, REF_LIMITS.sourceChanges).map((/** @type {any} */ change) => ({
      identifier: text(change?.identifier, 300), kind: text(change?.kind, 40), noticeIdentifier: text(change?.noticeIdentifier, 300),
      firstSeenAt: typeof change?.firstSeenAt === "string" && Number.isFinite(Date.parse(change.firstSeenAt)) ? new Date(change.firstSeenAt).toISOString() : null,
    }));
  }
  if (Array.isArray(refs?.frontierItemIds)) out.frontierItemIds = refs.frontierItemIds.slice(0, REF_LIMITS.frontierItemIds).map(String);
  for (const key of ["challengeId", "claimId", "outcome"]) if (typeof refs?.[key] === "string" && refs[key]) out[key] = refs[key].slice(0, 120);
  return out;
}

/** @param {any} row */
function entryOf(row) {
  return {
    id: String(row.id), zoneId: row.zone_id, cardId: row.card_id, cardTitle: row.card_title ?? null,
    revisionBefore: row.revision_before, revisionAfter: row.revision_after,
    category: row.category, categoryLabel: /** @type {any} */ (EVIDENCE_CHANGE_CATEGORY_LABELS_ZH)[row.category] ?? row.category,
    trigger: row.trigger, triggerLabel: /** @type {any} */ (EVIDENCE_CHANGE_TRIGGER_LABELS_ZH)[row.trigger] ?? row.trigger,
    summary: row.summary_zh, refs: row.refs ?? {}, occurredAt: new Date(row.occurred_at).toISOString(),
  };
}

/**
 * @param {{ database: any }} options
 */
export function createEvidenceChangeLog({ database }) {
  const counters = {
    appended: /** @type {Record<string, number>} */ (Object.fromEntries(EVIDENCE_CHANGE_CATEGORIES.map((category) => [category, 0]))),
    rejected: 0, reads: 0,
  };

  /**
   * Append one entry. `client` is the caller's transaction, so an entry and the change it describes commit together.
   * @param {{ zoneId: string, cardId: string, category: string, trigger: string, facts?: Record<string, any>,
   *   revisionBefore?: number | null, revisionAfter?: number | null, refs?: Record<string, any> }} entry
   * @param {{ client?: any }} [options]
   */
  async function append(entry, { client = database } = {}) {
    if (!EVIDENCE_CHANGE_CATEGORIES.includes(entry?.category) || !EVIDENCE_CHANGE_TRIGGERS.includes(entry?.trigger)
      || typeof entry?.zoneId !== "string" || !entry.zoneId || typeof entry?.cardId !== "string" || !entry.cardId) {
      counters.rejected += 1;
      throw new TypeError("A change-log entry names a known category, trigger, zone and card.");
    }
    const facts = { ...entry.facts, revisionBefore: entry.revisionBefore ?? undefined, revisionAfter: entry.revisionAfter ?? undefined };
    const summary = evidenceChangeSummaryZh({ category: entry.category, trigger: entry.trigger, facts });
    await migrateEvidenceZones(database);
    const inserted = await client.query(
      `INSERT INTO evimed_frontier.evidence_change_log(zone_id,card_id,revision_before,revision_after,category,trigger,summary_zh,refs)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
      [entry.zoneId, entry.cardId, entry.revisionBefore ?? null, entry.revisionAfter ?? null, entry.category, entry.trigger, summary, JSON.stringify(changeLogRefs(entry.refs ?? {}))],
    );
    counters.appended[entry.category] += 1;
    return entryOf(inserted.rows[0]);
  }

  /**
   * The log of a zone (or one of its cards), newest first. `before` is the id of the last entry of the previous page.
   * @param {{ zoneId?: string | null, cardId?: string | null, limit?: number, before?: string | number | null }} query
   * @returns {Promise<{ items: ReturnType<typeof entryOf>[], nextBefore: string | null }>}
   */
  async function list({ zoneId = null, cardId = null, limit = 50, before = null } = {}) {
    const size = Number(limit);
    const cursor = before == null || before === "" ? null : Number(before);
    if (!zoneId && !cardId) throw new HttpError(400, "evidence_invalid", "A change log is read for a zone or a card.");
    if (!Number.isSafeInteger(size) || size < 1 || size > EVIDENCE_CHANGE_LOG_MAX_PAGE || (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)))
      throw new HttpError(400, "evidence_query_invalid", "Invalid change-log query.");
    await migrateEvidenceZones(database);
    counters.reads += 1;
    const rows = (await database.query(
      `SELECT l.*,c.title AS card_title FROM evimed_frontier.evidence_change_log l LEFT JOIN evimed_frontier.evidence_cards c ON c.id=l.card_id
       WHERE ($1::text IS NULL OR l.zone_id=$1) AND ($2::text IS NULL OR l.card_id=$2) AND ($3::bigint IS NULL OR l.id<$3)
       ORDER BY l.id DESC LIMIT $4`,
      [zoneId, cardId, cursor, size + 1],
    )).rows;
    const page = rows.slice(0, size).map(entryOf);
    return { items: page, nextBefore: rows.length > size ? page.at(-1)?.id ?? null : null };
  }

  return { append, list, stats: () => ({ appended: { ...counters.appended }, rejected: counters.rejected, reads: counters.reads }) };
}

/**
 * The change log's counters for the operator's metrics endpoint.
 * @param {ReturnType<ReturnType<typeof createEvidenceChangeLog>["stats"]> | null | undefined} stats
 */
export function evidenceChangeLogMetricFamilies(stats) {
  if (!stats) return [];
  return [{
    name: "open_science_evidence_change_log_entries_total", type: /** @type {const} */ ("counter"),
    help: "Entries this process appended to the public evidence change log, by category.",
    series: EVIDENCE_CHANGE_CATEGORIES.map((category) => ({ value: stats.appended[category] ?? 0, labels: { category } })),
  }];
}
