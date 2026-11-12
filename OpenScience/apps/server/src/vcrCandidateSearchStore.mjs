/**
 * The record of one search for a patient's trials (G11, G24): what was asked, what each registry did, whether the list was reordered, and
 * the list in the order it was kept.
 *
 * Hidden knowledge:
 *
 * - **A receipt is the study's, never a patient's.** It holds the phrases the run searched with (the same words that went to the public
 *   registries), what each registry answered, and compact rows of the trials found. The summary the reranker read is kept as a hash and a
 *   length, so a receipt can say a summary was used without keeping what it said of the patient.
 * - **The list is read back without a registry.** A page of it (`offset`, `limit`) answers a second look at a long list, and a judging job
 *   takes its trial ids from the first `candidateLimit` rows (`resolveSelection`), so a run does not carry five hundred ids through its
 *   context. A frozen collection's receipt names the collection and revision the rows came from.
 * - **Reading and writing one is never a gate.** A receipt that cannot be written is a search without a `searchId`, and says so; nothing in
 *   the answer waits on it.
 * - **Twenty are kept per study**, the newest; the page shows the latest one's line.
 *
 * @module vcrCandidateSearchStore
 */

import { createHash } from "node:crypto";

import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase, vcrId } from "./vcrStoreBase.mjs";

/** How many receipts a study keeps. */
export const CANDIDATE_SEARCHES_KEPT = 20;

/** @param {unknown} value @returns {string | null} */
const iso = (value) => (value ? new Date(/** @type {any} */ (value)).toISOString() : null);

/** @param {any} row */
const receiptOf = (row) => (row ? {
  id: String(row.id),
  studyId: String(row.study_id),
  subjectKey: row.subject_key ?? null,
  createdAt: iso(row.created_at),
  request: row.request && typeof row.request === "object" ? row.request : {},
  registries: Array.isArray(row.registries) ? row.registries : [],
  rerank: row.rerank && typeof row.rerank === "object" ? row.rerank : null,
  collection: row.collection && typeof row.collection === "object" ? row.collection : null,
  found: Number(row.found) || 0,
  items: Array.isArray(row.items) ? row.items : [],
} : null);

/** The hash and length of the summary a search was reranked against, for the receipt. @param {string} summary */
export const summaryStamp = (summary) => ({ sha256: createHash("sha256").update(summary, "utf8").digest("hex"), chars: [...summary].length });

export class VcrCandidateSearchStore extends VcrStoreBase {
  /**
   * @param {{ id: string, userId: string }} study
   * @param {{ subjectKey?: string | null, request: Record<string, any>, registries: any[], rerank: Record<string, any> | null,
   *   collection?: Record<string, any> | null, found: number, items: Array<Record<string, any>> }} entry
   * @returns {Promise<string>} the receipt's id
   */
  async save(study, entry) {
    const id = vcrId("candidateSearch");
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO ${VCR_SCHEMA}.candidate_searches (id, study_id, user_id, subject_key, request, registries, rerank, collection, found, items)
         SELECT $1::text,$2::text,$3::text,$4::text,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::integer,$10::jsonb
         WHERE $4::text IS NULL OR NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals w WHERE w.study_id = $2::text AND w.subject_key = $4::text)`,
        [id, study.id, study.userId, entry.subjectKey ?? null, JSON.stringify(entry.request), JSON.stringify(entry.registries),
          entry.rerank ? JSON.stringify(entry.rerank) : null, entry.collection ? JSON.stringify(entry.collection) : null, entry.found, JSON.stringify(entry.items)]);
      await client.query(
        `DELETE FROM ${VCR_SCHEMA}.candidate_searches WHERE study_id = $1 AND id NOT IN
           (SELECT id FROM ${VCR_SCHEMA}.candidate_searches WHERE study_id = $1 ORDER BY created_at DESC, id DESC LIMIT ${CANDIDATE_SEARCHES_KEPT})`, [study.id]);
    });
    return id;
  }

  /**
   * A search that was made with no person named, judged for one: its receipt now belongs to them, so their withdrawal takes it. A receipt that already has a person keeps it.
   * @param {{ id: string }} study @param {string} searchId @param {string} subjectKey
   */
  async stampSubject(study, searchId, subjectKey) {
    await this.query(`UPDATE ${VCR_SCHEMA}.candidate_searches s SET subject_key = $3 WHERE s.study_id = $1 AND s.id = $2 AND s.subject_key IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals w WHERE w.study_id = s.study_id AND w.subject_key = $3)`, [study.id, searchId, subjectKey]);
  }

  /** One receipt of this study, or null. @param {{ id: string }} study @param {string} id */
  async get(study, id) {
    return receiptOf(await this.one(`SELECT * FROM ${VCR_SCHEMA}.candidate_searches WHERE study_id = $1 AND id = $2`, [study.id, id]));
  }

  /** The newest receipt of the study (of a patient, when one is named), without its list. @param {{ id: string }} study @param {{ subjectKey?: string | null }} [options] */
  async latest(study, { subjectKey = null } = {}) {
    const row = await this.one(
      `SELECT id, study_id, subject_key, created_at, request, registries, rerank, collection, found, '[]'::jsonb AS items FROM ${VCR_SCHEMA}.candidate_searches
       WHERE study_id = $1 AND ($2::text IS NULL OR subject_key = $2) ORDER BY created_at DESC, id DESC LIMIT 1`, [study.id, subjectKey]);
    return receiptOf(row);
  }

  /**
   * The trials a judging job should take from a receipt: the first `limit` rows in the order the search kept them. The registry and id of
   * each, and the collection they came from when the search was of a frozen one.
   * @param {{ id: string }} study @param {string} searchId @param {number | null} [limit]
   * @returns {Promise<{ registryIds: string[], collection: string | null, collectionRevision: string | null, available: number } | null>}
   */
  async resolveSelection(study, searchId, limit = null) {
    const receipt = await this.get(study, searchId);
    if (!receipt) return null;
    const rows = receipt.items.filter((item) => item && typeof item.registryId === "string");
    const taken = limit ? rows.slice(0, limit) : rows;
    return {
      registryIds: [...new Set(taken.map((item) => String(item.registryId)))],
      collection: receipt.collection?.id ?? null,
      collectionRevision: receipt.collection?.revision ?? null,
      available: rows.length,
    };
  }
}
