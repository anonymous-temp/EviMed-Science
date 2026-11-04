/**
 * The records of a model's judgment of a patient against a trial or a protocol version (owner decisions of 2026-11-04). A server job and a
 * conversation tool write the same row and the same readers read it.
 *
 * Hidden knowledge:
 *
 * - **A pair is judged once for given inputs.** The unique key holds the words on both sides by hash, the mode, the prompt, the model, the
 *   thinking setting and the producer. A later job, a re-claimed one or a restart finds the row and pays nothing; a failed row is replaced
 *   the next time the pair is tried, and a finished one is never overwritten by a job. A conversation's own later answer replaces its
 *   earlier one, because that is the same producer changing its mind on the same inputs.
 * - **A withdrawn person has no row, whatever is in flight.** `save` writes nothing once the withdrawal is on record, so a job that was already
 *   holding the record's text cannot put a judgment back after `vcrErasureStore` took them away.
 * - **Deletion follows the study.** The rows cascade with their study, so a project's and an account's deletion take them in the transaction
 *   that removes the study; a soft-deleted study keeps them unreachable, as it keeps its facts.
 *
 * @module vcrMatchJudgmentStore
 */

import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase, vcrId } from "./vcrStoreBase.mjs";

/** The key that says two rows are the same judgment, in code. @param {Record<string, any>} row */
export const judgmentKey = (row) => [row.subjectKey, row.targetKind, row.targetId, row.targetHash, row.documentHash, row.mode, row.promptVersion, row.model, row.thinking, row.producer].join("\u0000");

/** The columns of a row without its answer and usage, which are what is large. */
const LIGHT = ["id", "study_id", "user_id", "subject_key", "target_kind", "target_id", "target_hash", "document_hash", "mode", "prompt_version", "model", "thinking", "producer", "status", "error_code",
  "fit", "confidence", "verdict", "basis_changed", "job_id", "created_at", "updated_at"].map((column) => `j.${column}`).join(", ");

/** @param {any} row */
function judgmentOf(row) {
  return {
    id: String(row.id), studyId: String(row.study_id), userId: String(row.user_id), subjectKey: String(row.subject_key),
    targetKind: String(row.target_kind), targetId: String(row.target_id), targetHash: String(row.target_hash), documentHash: String(row.document_hash),
    mode: String(row.mode), promptVersion: String(row.prompt_version), model: String(row.model), thinking: String(row.thinking), producer: String(row.producer),
    status: String(row.status), errorCode: row.error_code ?? null, fit: row.fit == null ? null : Number(row.fit), confidence: row.confidence == null ? null : Number(row.confidence),
    verdict: row.verdict ?? null, answer: row.answer ?? {}, usage: row.usage ?? {}, documentIds: Array.isArray(row.document_ids) ? row.document_ids.map(String) : [],
    basisChanged: row.basis_changed ?? null, jobId: row.job_id ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null, updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/** The store of judgments. @extends VcrStoreBase */
export class VcrMatchJudgmentStore extends VcrStoreBase {
  /**
   * Write one judgment. Answers the stored row, or null when the person's consent has been withdrawn.
   * @param {{ studyId: string, userId: string, subjectKey: string, targetKind: string, targetId: string, targetHash?: string, documentHash?: string, mode: string, promptVersion: string,
   *   model?: string, thinking?: string, producer: string, status: string, errorCode?: string | null, fit?: number | null, confidence?: number | null, verdict?: string | null,
   *   answer?: Record<string, any>, usage?: Record<string, any>, documentIds?: readonly string[], jobId?: string | null }} entry
   */
  async save(entry) {
    const row = await this.one(`INSERT INTO ${VCR_SCHEMA}.match_judgments
      (id, study_id, user_id, subject_key, target_kind, target_id, target_hash, document_hash, mode, prompt_version, model, thinking, producer, status, error_code, fit, confidence, verdict, answer, usage, document_ids, job_id)
      SELECT $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$11::text,$12::text,$13::text,$14::text,$15::text,$16::integer,$17::double precision,$18::text,$19::jsonb,$20::jsonb,$21::jsonb,$22::text
      WHERE NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals w WHERE w.study_id=$2::text AND w.subject_key=$4::text)
      ON CONFLICT (study_id, subject_key, target_kind, target_id, target_hash, document_hash, mode, prompt_version, model, thinking, producer) DO UPDATE SET
        status=EXCLUDED.status, error_code=EXCLUDED.error_code, fit=EXCLUDED.fit, confidence=EXCLUDED.confidence, verdict=EXCLUDED.verdict, answer=EXCLUDED.answer, usage=EXCLUDED.usage,
        document_ids=EXCLUDED.document_ids, job_id=EXCLUDED.job_id, basis_changed=NULL, updated_at=now()
      WHERE match_judgments.status <> 'done' OR EXCLUDED.producer = 'conversation'
      RETURNING *`,
    [vcrId("matchJudgment"), entry.studyId, entry.userId, entry.subjectKey, entry.targetKind, entry.targetId, entry.targetHash ?? "", entry.documentHash ?? "", entry.mode, entry.promptVersion,
      entry.model ?? "", entry.thinking ?? "", entry.producer, entry.status, entry.errorCode ?? null, entry.fit ?? null, entry.confidence ?? null, entry.verdict ?? null,
      JSON.stringify(entry.answer ?? {}), JSON.stringify(entry.usage ?? {}), JSON.stringify(entry.documentIds ?? []), entry.jobId ?? null]);
    if (row) return judgmentOf(row);
    // Nothing written: a finished row is what is held for this key, or the person has withdrawn.
    const held = await this.one(`SELECT * FROM ${VCR_SCHEMA}.match_judgments WHERE study_id=$1 AND subject_key=$2 AND target_kind=$3 AND target_id=$4 AND target_hash=$5 AND document_hash=$6
      AND mode=$7 AND prompt_version=$8 AND model=$9 AND thinking=$10 AND producer=$11`,
    [entry.studyId, entry.subjectKey, entry.targetKind, entry.targetId, entry.targetHash ?? "", entry.documentHash ?? "", entry.mode, entry.promptVersion, entry.model ?? "", entry.thinking ?? "", entry.producer]);
    return held ? judgmentOf(held) : null;
  }

  /**
   * The finished judgments a job's resume finds, by key: what a job needs to skip a pair and to rank it, and none of the answers, so a roster of thousands stays small.
   * @param {{ studyId: string, promptVersions: readonly string[], model: string, thinking: string, subjectKeys?: readonly string[] | null }} input
   * @returns {Promise<Map<string, ReturnType<typeof judgmentOf>>>}
   */
  async doneFor({ studyId, promptVersions, model, thinking, subjectKeys = null }) {
    const rows = await this.rows(`SELECT ${LIGHT} FROM ${VCR_SCHEMA}.match_judgments j WHERE j.study_id=$1 AND j.status='done' AND j.producer='job' AND j.prompt_version=ANY($2::text[]) AND j.model=$3 AND j.thinking=$4
      AND ($5::text[] IS NULL OR j.subject_key=ANY($5::text[]))`, [studyId, [...promptVersions], model, thinking, subjectKeys ? [...subjectKeys] : null]);
    const out = new Map();
    for (const row of rows) { const judgment = judgmentOf(row); out.set(judgmentKey(judgment), judgment); }
    return out;
  }

  /**
   * What a reader ranks from: every row of one person, or of one target, newest first, without the answers. A row says whether it states a disqualifier, which is the one thing
   * of an answer an order needs; the page it then shows is read whole by `byIds`. People who withdrew are not in it.
   * @param {{ studyId: string, subjectKey?: string | null, targetKind?: string | null, targetId?: string | null, limit?: number }} input
   */
  async list({ studyId, subjectKey = null, targetKind = null, targetId = null, limit = 20_000 }) {
    const rows = await this.rows(`SELECT ${LIGHT},
        EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.answer->'rows')='array' THEN j.answer->'rows' ELSE '[]'::jsonb END) c
          WHERE c->>'basis'='stated' AND c->>'label' IN ('excluded','not_included')) AS disqualified,
        j.answer->'target' AS target
      FROM ${VCR_SCHEMA}.match_judgments j WHERE j.study_id=$1 AND ($2::text IS NULL OR j.subject_key=$2) AND ($3::text IS NULL OR j.target_kind=$3)
      AND ($4::text IS NULL OR j.target_id=$4)
      AND NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals w WHERE w.study_id=j.study_id AND w.subject_key=j.subject_key)
      ORDER BY j.updated_at DESC, j.id LIMIT $5`, [studyId, subjectKey, targetKind, targetId, limit]);
    return rows.map((row) => ({ ...judgmentOf(row), disqualified: row.disqualified === true, target: row.target ?? null }));
  }

  /** Whole rows, for the page a reader shows. @param {string} studyId @param {readonly string[]} ids */
  async byIds(studyId, ids) {
    if (!ids.length) return [];
    return (await this.rows(`SELECT j.* FROM ${VCR_SCHEMA}.match_judgments j WHERE j.study_id=$1 AND j.id=ANY($2::text[])
      AND NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals w WHERE w.study_id=j.study_id AND w.subject_key=j.subject_key)`, [studyId, [...ids]])).map(judgmentOf);
  }
}
