/**
 * A protocol's schedule of activities (SoA) in 「虚拟临床研究」: the visits a protocol plans, the window around each and what is done at
 * each (2026-10-10; the table existed as DDL only until then — review gap G10). This module is its store operations; what it is to a
 * reader and to the runtime is the pure `vcrScheduleView.mjs`.
 *
 * Hidden knowledge:
 *
 * - **The schedule belongs to a protocol version and follows the protocol.** Rows hang off `protocol_versions`, a criteria edit writes
 *   a new version, and the new version starts with a copy of the schedule before it (`carryScheduleForward`, in the same transaction
 *   as the version): an eligibility amendment does not lose the visits. A schedule write changes the *current* version's rows in
 *   place — it is not a new protocol version, because no assessment of a patient depends on it — and is audited.
 * - **A write is by visit.** An item is one visit and replaces that visit (matched by its name, ignoring case and spacing) with the
 *   activities it lists; a visit it does not mention is left alone, so a run correcting one visit cannot wipe the others, and
 *   `remove: true` takes a visit out. New visits take the next place in the schedule; the page and the package show visits by day.
 * - **Rows are flat, the shape is not.** The table keeps one row per activity at a visit (what the DDL was written as); the visit's
 *   day, window and note repeat on its rows and `visitsFromRows` reads them back as visits.
 * - **A virtual patient's visit times are read off it, by code** (`resolveVisitsRef`): the scenario keeps the numbers it was written
 *   with, so a schedule changed later does not move a patient set already written.
 *
 * @module vcrSchedule
 */

import { VCR_SOA_LIMITS } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { vcrId } from "./vcrStoreBase.mjs";
import { visitKey, visitsFromRows } from "./vcrScheduleView.mjs";

export { visitsFromRows };

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * A new protocol version starts with the schedule of the version before it. Called inside the transaction that writes the version, so a
 * version never exists without the schedule its predecessor had. Answers how many rows it copied.
 * @param {any} client @param {{ studyId: string, userId: string, protocolVersionId: string }} input
 */
export async function carryScheduleForward(client, { studyId, userId, protocolVersionId }) {
  const previous = (await client.query(
    `SELECT id FROM ${VCR_SCHEMA}.protocol_versions WHERE study_id = $1 AND id <> $2 ORDER BY version DESC LIMIT 1`,
    [studyId, protocolVersionId])).rows[0];
  if (!previous) return 0;
  const rows = (await client.query(
    `SELECT * FROM ${VCR_SCHEMA}.soa_items WHERE protocol_version_id = $1 ORDER BY ordinal, position, id`, [previous.id])).rows;
  for (const row of rows) {
    await client.query(
      `INSERT INTO ${VCR_SCHEMA}.soa_items (id, protocol_version_id, user_id, visit, day, window_days, procedure, burden, ordinal, position, visit_note, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)`,
      [vcrId("soa"), protocolVersionId, userId, row.visit, row.day, row.window_days, row.procedure, JSON.stringify(row.burden ?? {}),
        row.ordinal, row.position, row.visit_note, row.note]);
  }
  return rows.length;
}

/**
 * Write visits into the schedule of one protocol version of a study (see the module note: by visit, replacing, `remove` takes one out).
 * One transaction under a lock on the version, so two runs writing at once see each other's visits. A visit that would take the
 * schedule past the limit is refused with the number it may hold.
 * @param {any} store a `VcrStoreBase`
 * @param {{ studyId: string, userId: string, protocolVersionId: string, actor?: string,
 *   visits: ReadonlyArray<{ visit: string, day?: number | null, windowDays?: number | null, note?: string, procedures?: ReadonlyArray<{ name: string, note?: string }>, remove?: boolean }> }} input
 * @returns {Promise<Array<{ visit: string, id: string | null, activities: number, replaced: boolean, removed: boolean }>>}
 */
export async function saveScheduleVisits(store, { studyId, userId, protocolVersionId, actor = "", visits }) {
  return store.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vcr-soa:${protocolVersionId}`]);
    const owned = await client.query(
      `SELECT 1 FROM ${VCR_SCHEMA}.protocol_versions WHERE id = $1 AND study_id = $2`, [protocolVersionId, studyId]);
    if (!owned.rowCount) throw new HttpError(404, "vcr_write_refused", "这个方案版本不属于本研究。");
    /** The visits the version has: matched by key (name, ignoring case and spacing), each with its place and the spellings stored. @type {Map<string, { ordinal: number, spelled: Set<string> }>} */
    const held = new Map();
    let last = 0;
    for (const row of (await client.query(
      `SELECT visit, min(ordinal) AS ordinal FROM ${VCR_SCHEMA}.soa_items WHERE protocol_version_id = $1 GROUP BY visit`, [protocolVersionId])).rows) {
      const key = visitKey(row.visit);
      const entry = held.get(key) ?? { ordinal: Number(row.ordinal), spelled: new Set() };
      entry.ordinal = Math.min(entry.ordinal, Number(row.ordinal));
      entry.spelled.add(String(row.visit));
      held.set(key, entry);
      last = Math.max(last, Number(row.ordinal));
    }
    /** @type {Array<{ visit: string, id: string | null, activities: number, replaced: boolean, removed: boolean }>} */
    const done = [];
    let entries = 0;
    for (const item of visits) {
      const key = visitKey(item.visit);
      const existing = held.get(key);
      // The rows the visit has now are replaced by the ones it is written with, or by none.
      if (existing) {
        await client.query(`DELETE FROM ${VCR_SCHEMA}.soa_items WHERE protocol_version_id = $1 AND visit = ANY($2::text[])`,
          [protocolVersionId, [...existing.spelled]]);
      }
      if (item.remove === true) {
        held.delete(key);
        done.push({ visit: item.visit, id: null, activities: 0, replaced: false, removed: Boolean(existing) });
        continue;
      }
      if (!existing && held.size >= VCR_SOA_LIMITS.visits) {
        throw new HttpError(409, "vcr_write_refused", `方案的一个版本最多写 ${VCR_SOA_LIMITS.visits} 次访视；先用 remove 去掉不要的，再写新的。`);
      }
      const ordinal = existing ? existing.ordinal : ++last;
      held.set(key, { ordinal, spelled: new Set([item.visit]) });
      let id = null;
      for (const [position, activity] of list(item.procedures).entries()) {
        const rowId = vcrId("soa");
        id ??= rowId;
        await client.query(
          `INSERT INTO ${VCR_SCHEMA}.soa_items (id, protocol_version_id, user_id, visit, day, window_days, procedure, ordinal, position, visit_note, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [rowId, protocolVersionId, userId, item.visit, item.day ?? null, item.windowDays ?? null, activity.name, ordinal, position,
            String(item.note ?? ""), String(activity.note ?? "")]);
        entries += 1;
      }
      done.push({ visit: item.visit, id, activities: list(item.procedures).length, replaced: Boolean(existing), removed: false });
    }
    await store.audit({ client, studyId, userId, actor, action: "vcr.soa.save", object: protocolVersionId,
      detail: { visits: visits.length, removed: done.filter((entry) => entry.removed).length, entries } });
    return done;
  });
}
