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
 * - **`basis_changed` is text with two writers.** The erasure store writes a plain cause word (`document`, `permission`, ...); the registry watch writes
 *   a JSON object that starts `{"kind":"registry_record"` (the record the verdict was made of has since changed). A row reads back as the word or the
 *   object, and the watch only ever writes over an empty column or its own earlier mark, so a cause written later is never taken back.
 *
 * @module vcrMatchJudgmentStore
 */

import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase, vcrId } from "./vcrStoreBase.mjs";

/** The key that says two rows are the same judgment, in code. @param {Record<string, any>} row */
export const judgmentKey = (row) => [row.subjectKey, row.targetKind, row.targetId, row.targetHash, row.documentHash, row.mode, row.promptVersion, row.model, row.thinking, row.producer].join("\u0000");

/** The kind of the registry watch's mark, and the words a reader shows for it. */
export const REGISTRY_RECORD_BASIS = "registry_record";
export const REGISTRY_RECORD_LABEL = "登记记录已更新，结论来自旧版本";
/** What the watch's mark starts with, as a `LIKE` pattern: the column is text, and a cause word is not JSON. */
const REGISTRY_MARK_PATTERN = `{"kind":"${REGISTRY_RECORD_BASIS}"%`;
/** A trial read from a frozen collection is never refreshed: its text is the collection's, not the registry's. */
const NOT_FROZEN = "COALESCE(j.answer->'target'->'collection', 'null'::jsonb) = 'null'::jsonb";
const NOT_WITHDRAWN = `NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals w WHERE w.study_id=j.study_id AND w.subject_key=j.subject_key)`;

/** A stored `basis_changed`: the erasure store's cause word as it is, the registry watch's mark as the object it wrote. @param {unknown} value */
function basisChangedOf(value) {
  if (value == null || value === "") return null;
  const text = String(value);
  if (!text.startsWith("{")) return text;
  try { return JSON.parse(text); } catch { return text; }
}

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
    basisChanged: basisChangedOf(row.basis_changed), jobId: row.job_id ?? null,
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

  // -------------------------------------------------------- the registry watch

  /**
   * The trials a person holds a finished verdict about, one entry per study and trial, the least recently checked first (never checked before any
   * checked). A trial checked fine is due again after `okBefore`; one whose last check failed is due again after `retryBefore`, which is sooner, so a
   * registry that was down is asked again while the others go first (a record the registry no longer has is an answer, and waits like a good read). A frozen
   * collection's trial and a person who withdrew are not here.
   * @param {{ okBefore: Date, retryBefore: Date, limit: number }} input
   * @returns {Promise<Array<{ studyId: string, userId: string, targetId: string, registry: string | null }>>}
   */
  async dueTargets({ okBefore, retryBefore, limit }) {
    const rows = await this.rows(`SELECT j.study_id, s.user_id, j.target_id, (array_agg(j.answer->'target'->>'registry' ORDER BY j.updated_at DESC))[1] AS registry, c.checked_at
        FROM ${VCR_SCHEMA}.match_judgments j
        JOIN ${VCR_SCHEMA}.studies s ON s.id=j.study_id AND s.deleted_at IS NULL
        LEFT JOIN ${VCR_SCHEMA}.match_target_checks c ON c.study_id=j.study_id AND c.target_id=j.target_id
       WHERE j.target_kind='candidate_trial' AND j.status='done' AND ${NOT_FROZEN} AND ${NOT_WITHDRAWN}
         AND (c.checked_at IS NULL OR c.checked_at < CASE WHEN c.last_status IN ('ok', 'registry_not_found', 'registry_unknown') THEN $1::timestamptz ELSE $2::timestamptz END)
       GROUP BY j.study_id, s.user_id, j.target_id, c.checked_at
       ORDER BY c.checked_at ASC NULLS FIRST, j.study_id, j.target_id
       LIMIT $3`, [okBefore.toISOString(), retryBefore.toISOString(), Math.max(1, Math.min(500, Math.floor(limit)))]);
    return rows.map((row) => ({ studyId: String(row.study_id), userId: String(row.user_id), targetId: String(row.target_id), registry: row.registry ? String(row.registry) : null }));
  }

  /**
   * The record of a trial now reads as `hash`: every finished row of this study's trial made of another record is marked, keeping its verdict, and a row
   * made of this record that an earlier mark called old is cleared (the record went back). Only an empty column or the watch's own mark is written over,
   * so a cause the erasure store wrote since stands, and a person who withdrew is untouched.
   * @param {{ studyId: string, targetId: string, hash: string, at: string }} input
   * @returns {Promise<{ marked: number, cleared: number }>}
   */
  async markRegistryChanged({ studyId, targetId, hash, at }) {
    const mark = JSON.stringify({ kind: REGISTRY_RECORD_BASIS, label: REGISTRY_RECORD_LABEL, newHash: hash, at });
    return this.transaction(async (client) => {
      const marked = await client.query(`UPDATE ${VCR_SCHEMA}.match_judgments j SET basis_changed=$4
         WHERE j.study_id=$1 AND j.target_kind='candidate_trial' AND j.target_id=$2 AND j.status='done' AND j.target_hash<>$3 AND ${NOT_FROZEN} AND ${NOT_WITHDRAWN}
           AND (j.basis_changed IS NULL OR (j.basis_changed LIKE $5 AND j.basis_changed NOT LIKE $6))`,
      [studyId, targetId, hash, mark, REGISTRY_MARK_PATTERN, `%"newHash":"${hash}"%`]);
      const cleared = await client.query(`UPDATE ${VCR_SCHEMA}.match_judgments j SET basis_changed=NULL
         WHERE j.study_id=$1 AND j.target_kind='candidate_trial' AND j.target_id=$2 AND j.status='done' AND j.target_hash=$3 AND j.basis_changed LIKE $4`,
      [studyId, targetId, hash, REGISTRY_MARK_PATTERN]);
      return { marked: marked.rowCount ?? 0, cleared: cleared.rowCount ?? 0 };
    });
  }

  /** That the watch looked at this trial now, and what it read. @param {{ studyId: string, targetId: string, hash?: string, status: string, at: string }} input */
  async recordCheck({ studyId, targetId, hash = "", status, at }) {
    await this.query(`INSERT INTO ${VCR_SCHEMA}.match_target_checks (study_id, target_id, checked_at, last_hash, last_status) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (study_id, target_id) DO UPDATE SET checked_at=EXCLUDED.checked_at, last_hash=CASE WHEN EXCLUDED.last_hash<>'' THEN EXCLUDED.last_hash ELSE ${VCR_SCHEMA}.match_target_checks.last_hash END,
        last_status=EXCLUDED.last_status`, [studyId, targetId, at, hash, status]);
  }
}
