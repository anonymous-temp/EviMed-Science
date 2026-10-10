/**
 * A study's log of regulatory contacts in 「虚拟临床研究」: a meeting, a written advice, a reply from an agency — when, with whom, what
 * kind, what was discussed, what the agency concluded in its own words, and what it left (2026-10-10; the table existed as DDL only
 * until then — review gap G10, plan section 10: the decision record carries 「监管沟通记录」). This module is its store operations;
 * what it is to a reader is the pure `vcrScheduleView.mjs`.
 *
 * Hidden knowledge:
 *
 * - **A contact is a record, not a state.** It is added; a correction is another contact. Nothing is edited or deleted from the page
 *   or by a run, so the log a package prints is the log somebody kept. The same contact written twice (a run retrying after a
 *   timeout) is one contact: an exact repeat answers the row that is already there.
 * - **The words are the researcher's or the run's, and are kept as written.** The platform checks the shape — a real date, an
 *   agency, bounded text, a short list of references — and never reads the prose: what the agency concluded is not for code to judge.
 * - **Attachments are references, not files.** A reference names what the contact left (the minutes, a briefing package) in the
 *   study's workspace or wherever the researcher keeps it; the first is also kept in `source_ref`.
 * - **It is part of the package.** The report model carries the log (`regulatoryContacts`), the package reader prints it beside the
 *   decision record and the exported document ends with it.
 *
 * @module vcrRegulatory
 */

import { VCR_REGULATORY_LIMITS } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { vcrId } from "./vcrStoreBase.mjs";
import { contactFromRow } from "./vcrScheduleView.mjs";

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/** Who wrote a contact down when a run did: the same label the study's other AI-written objects carry. */
export const VCR_REGULATORY_AI_ACTOR = "ai_set";

const SELECT = `SELECT *, to_char(occurred_on, 'YYYY-MM-DD') AS occurred_text FROM ${VCR_SCHEMA}.regulatory_contacts`;

/**
 * Add a contact to a study's log, or answer the identical one that is already in it.
 * @param {any} store a `VcrStoreBase`
 * @param {{ studyId: string, userId: string, actor: string, date: string, agency: string, type?: string, summary?: string,
 *   outcome?: string, attachments?: readonly string[] }} input
 * @returns {Promise<ReturnType<typeof contactFromRow> & { existing: boolean }>}
 */
export async function addRegulatoryContact(store, input) {
  const attachments = list(input.attachments).map(String);
  return store.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vcr-regulatory:${input.studyId}`]);
    const same = (await client.query(
      `${SELECT} WHERE study_id = $1 AND occurred_on = $2::date AND agency = $3 AND meeting = $4 AND summary = $5 AND conclusion = $6
         AND attachments = $7::jsonb ORDER BY created_at LIMIT 1`,
      [input.studyId, input.date, input.agency, input.type ?? "", input.summary ?? "", input.outcome ?? "", JSON.stringify(attachments)])).rows[0];
    if (same) return { ...contactFromRow(same), existing: true };
    const held = Number((await client.query(`SELECT count(*) AS n FROM ${VCR_SCHEMA}.regulatory_contacts WHERE study_id = $1`, [input.studyId])).rows[0]?.n ?? 0);
    if (held >= VCR_REGULATORY_LIMITS.contacts) {
      throw new HttpError(409, "vcr_write_refused", `一个研究的监管沟通记录最多 ${VCR_REGULATORY_LIMITS.contacts} 条。`);
    }
    const id = vcrId("contact");
    await client.query(
      `INSERT INTO ${VCR_SCHEMA}.regulatory_contacts
         (id, study_id, user_id, agency, meeting, occurred_on, conclusion, source_ref, summary, attachments, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10::jsonb, $11)`,
      [id, input.studyId, input.userId, input.agency, input.type ?? "", input.date, input.outcome ?? "", attachments[0] ?? null,
        input.summary ?? "", JSON.stringify(attachments), input.actor]);
    await store.audit({ client, studyId: input.studyId, userId: input.userId, actor: input.actor, action: "vcr.regulatory.add", object: id,
      detail: { agency: input.agency, date: input.date, attachments: attachments.length } });
    const row = (await client.query(`${SELECT} WHERE id = $1`, [id])).rows[0];
    return { ...contactFromRow(row), existing: false };
  });
}

/**
 * A study's contacts, the latest first (a contact with no date after the dated ones).
 * @param {any} store a `VcrStoreBase` @param {string} studyId @param {number} [limit]
 */
export async function regulatoryContacts(store, studyId, limit = 200) {
  const rows = await store.rows(`${SELECT} WHERE study_id = $1 ORDER BY occurred_on DESC NULLS LAST, created_at DESC, id LIMIT $2`, [studyId, limit]);
  return rows.map(contactFromRow);
}
