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
 * - **A withdrawn person has no row, whatever is in flight, and neither does a deleted document.** `save` writes nothing once the withdrawal is on record or, for a job or a conversation,
 *   once a document the answer read has gone, so a job that was already holding the record's text cannot put a judgment back after `vcrErasureStore` took it away. The two share a lock per
 *   person (`lockSubject`), so a save caught between an erasure's delete and its commit waits and then finds nothing to stand on.
 * - **Deletion follows the study.** The rows cascade with their study, so a project's and an account's deletion take them in the transaction
 *   that removes the study; a soft-deleted study keeps them unreachable, as it keeps its facts.
 * - **`basis_changed` is text with two writers.** The erasure store writes a plain cause word (`document`, `permission`, ...); the registry watch writes
 *   a JSON object that starts `{"kind":"registry_record"` (the record the verdict was made of has since changed). A row reads back as the word or the
 *   object, and the watch only ever writes over an empty column or its own earlier mark, so a cause written later is never taken back.
 *
 * @module vcrMatchJudgmentStore
 */

import { rankJudgments } from "@evimed/domain";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase, lockSubject, vcrId } from "./vcrStoreBase.mjs";

/** The key that says two rows are the same judgment, in code. @param {Record<string, any>} row */
export const judgmentKey = (row) => [row.subjectKey, row.targetKind, row.targetId, row.targetHash, row.documentHash, row.mode, row.promptVersion, row.model, row.thinking, row.producer].join("\u0000");

/** The kind of the registry watch's mark, and the words a reader shows for it. */
export const REGISTRY_RECORD_BASIS = "registry_record";
export const REGISTRY_RECORD_LABEL = "登记记录已更新，结论来自旧版本";
/** What stands in a job's frozen roster in place of someone who withdrew: a position in the job's marks still means the same pair, and the job no longer names them. */
export const WITHDRAWN_SUBJECT_MARK = "withdrawn";
/** What the watch's mark starts with, as a `LIKE` pattern: the column is text, and a cause word is not JSON. */
const REGISTRY_MARK_PATTERN = `{"kind":"${REGISTRY_RECORD_BASIS}"%`;
/** A trial read from a frozen collection is never refreshed: its text is the collection's, not the registry's. */
const NOT_FROZEN = "COALESCE(j.answer->'target'->'collection', 'null'::jsonb) = 'null'::jsonb";
const NOT_WITHDRAWN = `NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals w WHERE w.study_id=j.study_id AND w.subject_key=j.subject_key)`;

/** A stored `basis_changed`: the erasure store's cause word as it is, the registry watch's mark as the object it wrote. @param {unknown} value */
export function basisChangedOf(value) {
  if (value == null || value === "") return null;
  const text = String(value);
  if (!text.startsWith("{")) return text;
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Which rows of a pair a verdict rests on. Two rows stand together only when they read the same words (the person's record and the trial's, by hash). When they did not, the newer reading stands
 * alone and the other is history: a score of a later note beside clauses of an earlier one would call someone 符合 on what the note has since overtaken.
 * @template T @param {T & { documentHash?: string, targetHash?: string, updatedAt?: string | null } | null} fit @param {T & { documentHash?: string, targetHash?: string, updatedAt?: string | null } | null} criteria
 * @returns {{ fit: T | null, criteria: T | null, older: 'fit' | 'criteria' | null }}
 */
export function standingRows(fit, criteria) {
  if (!fit || !criteria || (fit.documentHash === criteria.documentHash && fit.targetHash === criteria.targetHash)) return { fit, criteria, older: null };
  return String(fit.updatedAt ?? '') >= String(criteria.updatedAt ?? '') ? { fit, criteria: null, older: 'criteria' } : { fit: null, criteria, older: 'fit' };
}

/** What a row says of what its verdict did not read, in words a person reads; null when it read it all. @param {Record<string, any> | null | undefined} answer */
export function recordGapOf(answer) {
  const gaps = [];
  const count = (/** @type {unknown} */ value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  if (count(answer?.unreadableDocuments)) gaps.push(`${count(answer?.unreadableDocuments)} 份病历没能读取`);
  if (count(answer?.documentsLeftOut)) gaps.push(`${count(answer?.documentsLeftOut)} 份较早的病历因为太多没有读`);
  if (answer?.tableUnread) gaps.push('表格里的数据这次没读到');
  if (answer?.longUnread) gaps.push('结构化记录这次没读到');
  if (count(answer?.leftOut?.rows)) gaps.push(`结构化数据里 ${count(answer?.leftOut?.rows)} 行较早或关系较小的记录没有列出`);
  if (count(answer?.clausesWithoutWords)) gaps.push(`方案里有 ${count(answer?.clausesWithoutWords)} 条条件没有原文，没有判这几条`);
  return gaps.length ? `这条结论没有读全：${gaps.join('，')}。` : null;
}

const OPEN_STATES = Object.freeze(['queued', 'running', 'awaiting_budget']);

/**
 * Which of a job's pairs its second stage is for and has not done: per person the best K by rank among the pairs the job asked about, where a trial with no eligibility text has nothing to ask.
 * The same choice the job makes, so that what a reader calls left is what a continuation does.
 * @param {ReadonlyArray<Record<string, any>>} done pairs with a verdict: `subjectKey`, `targetId`, `fit`, `confidence`, `eligibilitySource`, `judgedByClauses`
 * @param {Record<string, any>} scenario the job's @param {(pair: any) => boolean} inJob
 */
export function clauseStageOf(done, scenario, inJob) {
  const topK = scenario?.topK ?? 0;
  /** @type {Map<string, any[]>} */
  const bySubject = new Map();
  for (const pair of done) {
    if (!inJob(pair) || pair.eligibilitySource === 'none') continue;
    bySubject.set(String(pair.subjectKey), [...(bySubject.get(String(pair.subjectKey)) ?? []), pair]);
  }
  const wanted = topK === 0 ? [] : [...bySubject.values()].flatMap((own) => {
    const ranked = rankJudgments(own.map((pair) => ({ ...pair, id: String(pair.targetId) })));
    return topK === 'all' ? ranked : ranked.slice(0, Number(topK));
  });
  return { wanted: wanted.length, done: wanted.filter((pair) => pair.judgedByClauses).length, left: wanted.filter((pair) => !pair.judgedByClauses) };
}

/**
 * How the judging of a scope stands, from its jobs (newest first) and the pairs it has: what was asked, what is done, what failed, what never ran and which clause work is owed. The page's and the
 * conversation's reads say the same thing because they read it from here.
 * @param {{ direction: 'patient_to_trial' | 'trial_to_patient', jobs: ReadonlyArray<any>, done: ReadonlyArray<any>, failed: ReadonlyArray<any>, withdrawn?: ReadonlySet<string>, only?: string | null }} input
 */
export function judgingProgress({ direction, jobs, done, failed, withdrawn = new Set(), only = null }) {
  const objectOf = (/** @type {unknown} */ value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
  const askedBy = (/** @type {any} */ job) => {
    const scenario = objectOf(job?.scenario);
    if (direction === 'patient_to_trial') return (Array.isArray(scenario.trials) ? scenario.trials : []).flatMap((trial) => (trial?.registryId ? [String(trial.registryId)] : []));
    return (Array.isArray(scenario.subjects) ? scenario.subjects : []).map(String).filter((key) => !withdrawn.has(key) && key !== WITHDRAWN_SUBJECT_MARK && (!only || key === only));
  };
  const idOf = (/** @type {any} */ pair) => String(direction === 'patient_to_trial' ? pair.targetId : pair.subjectKey);
  const asked = new Set(jobs.flatMap(askedBy));
  const finished = new Set(done.map(idOf));
  const lost = new Set(failed.map(idOf));
  for (const id of [...finished, ...lost]) asked.add(id);
  // A pair whose newest reading failed after an older one finished still has its last verdict, and is still owed its re-judgment: it is failed here as much as one with nothing.
  const refailed = done.filter((pair) => pair.rejudgeFailure).map(idOf);
  const failedOnly = [...new Set([...[...lost].filter((id) => !finished.has(id)), ...refailed])];
  const waiting = [...asked].filter((id) => !finished.has(id) && !lost.has(id));
  const latest = jobs[0] ?? null;
  const running = latest ? OPEN_STATES.includes(String(latest.state)) : false;
  const inLatest = new Set(askedBy(latest));
  const clauses = latest ? clauseStageOf(done, objectOf(latest.scenario), (pair) => inLatest.has(idOf(pair))) : { wanted: 0, done: 0, left: [] };
  const clauseLeft = [...new Set(clauses.left.map(idOf))];
  const total = asked.size;
  return {
    total, finished: finished.size, failed: failedOnly.length, waiting: waiting.length, waitingIds: waiting, latest, running,
    state: running ? (String(latest.state) === 'awaiting_budget' ? 'waiting_budget' : 'running') : total === 0 ? 'idle' : waiting.length || failedOnly.length || clauseLeft.length ? 'stopped' : 'done',
    clauses: { wanted: clauses.wanted, done: clauses.done, left: clauses.left.length },
    // What is still to do: the pairs that never ran, the ones that failed, and the ones whose clauses are owed. A continuation starts exactly these, and the ledger has the rest.
    left: [...new Set([...waiting, ...failedOnly, ...clauseLeft])],
  };
}

/** What a pair says when its newest reading did not finish and the verdict shown is the one before. */
export const REJUDGE_FAILED_NOTE_ZH = '重新判定没有完成，这里仍是上一次的结论，读的是更早的病历或登记内容。';

/**
 * The newest failure of a mode's rows (newest first) that is newer than the finished row in use: a later reading that did not finish. Null when the newest row is the one in use, or none finished.
 * @param {ReadonlyArray<{ status: string, updatedAt?: string | null, errorCode?: string | null }>} rows
 */
export function newerFailureOf(rows) {
  const used = rows.find((row) => row.status === 'done');
  if (!used) return null;
  const failure = rows.find((row) => row.status === 'failed' && String(row.updatedAt ?? '') > String(used.updatedAt ?? ''));
  return failure ? { code: failure.errorCode ?? 'vcr_match_judge_failed', at: failure.updatedAt ?? null } : null;
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
   * Write one judgment. Answers the stored row, or null when the person's consent has been withdrawn or, for a finished row that says `liveDocuments`, when a document it read has gone since: a
   * job still holding that text writes nothing of it back. Under the person's shared lock (`lockSubject`), so a save racing an erasure either comes before it, and the erasure takes the row, or
   * comes after it, and finds what the erasure left.
   * @param {{ studyId: string, userId: string, subjectKey: string, targetKind: string, targetId: string, targetHash?: string, documentHash?: string, mode: string, promptVersion: string,
   *   model?: string, thinking?: string, producer: string, status: string, errorCode?: string | null, fit?: number | null, confidence?: number | null, verdict?: string | null,
   *   answer?: Record<string, any>, usage?: Record<string, any>, documentIds?: readonly string[], jobId?: string | null, liveDocuments?: boolean }} entry
   */
  async save(entry) {
    return this.transaction(async (client) => {
      await lockSubject(client, entry.studyId, entry.subjectKey, { shared: true });
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.match_judgments
      (id, study_id, user_id, subject_key, target_kind, target_id, target_hash, document_hash, mode, prompt_version, model, thinking, producer, status, error_code, fit, confidence, verdict, answer, usage, document_ids, job_id)
      SELECT $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$11::text,$12::text,$13::text,$14::text,$15::text,$16::integer,$17::double precision,$18::text,$19::jsonb,$20::jsonb,$21::jsonb,$22::text
      WHERE NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals w WHERE w.study_id=$2::text AND w.subject_key=$4::text)
        AND (NOT $23::boolean OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text($21::jsonb) named(id)
          WHERE NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.source_files f WHERE f.study_id=$2::text AND f.id=named.id AND f.erased_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.document_projections p WHERE p.study_id=$2::text AND p.id=named.id AND p.retired_at IS NULL)))
      ON CONFLICT (study_id, subject_key, target_kind, target_id, target_hash, document_hash, mode, prompt_version, model, thinking, producer) DO UPDATE SET
        status=EXCLUDED.status, error_code=EXCLUDED.error_code, fit=EXCLUDED.fit, confidence=EXCLUDED.confidence, verdict=EXCLUDED.verdict, answer=EXCLUDED.answer, usage=EXCLUDED.usage,
        document_ids=EXCLUDED.document_ids, job_id=EXCLUDED.job_id, basis_changed=NULL, updated_at=now()
      WHERE match_judgments.status <> 'done' OR EXCLUDED.producer = 'conversation'
      RETURNING *`,
    [vcrId("matchJudgment"), entry.studyId, entry.userId, entry.subjectKey, entry.targetKind, entry.targetId, entry.targetHash ?? "", entry.documentHash ?? "", entry.mode, entry.promptVersion,
      entry.model ?? "", entry.thinking ?? "", entry.producer, entry.status, entry.errorCode ?? null, entry.fit ?? null, entry.confidence ?? null, entry.verdict ?? null,
      JSON.stringify(entry.answer ?? {}), JSON.stringify(entry.usage ?? {}), JSON.stringify(entry.documentIds ?? []), entry.jobId ?? null, entry.liveDocuments === true && entry.status === "done"])).rows[0];
      if (row) return judgmentOf(row);
      // Nothing written: a finished row is what is held for this key, or what it read has gone.
      const held = (await client.query(`SELECT * FROM ${VCR_SCHEMA}.match_judgments WHERE study_id=$1 AND subject_key=$2 AND target_kind=$3 AND target_id=$4 AND target_hash=$5 AND document_hash=$6
        AND mode=$7 AND prompt_version=$8 AND model=$9 AND thinking=$10 AND producer=$11`,
      [entry.studyId, entry.subjectKey, entry.targetKind, entry.targetId, entry.targetHash ?? "", entry.documentHash ?? "", entry.mode, entry.promptVersion, entry.model ?? "", entry.thinking ?? "", entry.producer])).rows[0];
      return held ? judgmentOf(held) : null;
    });
  }

  /**
   * The finished judgments a job's resume finds, by key: what a job needs to skip a pair and to rank it, and none of the answers, so a roster of thousands stays small.
   * @param {{ studyId: string, promptVersions: readonly string[], model: string, thinking: string, subjectKeys?: readonly string[] | null }} input
   * @returns {Promise<Map<string, ReturnType<typeof judgmentOf>>>}
   */
  async doneFor({ studyId, promptVersions, model, thinking, subjectKeys = null }) {
    const rows = await this.rows(`SELECT ${LIGHT} FROM ${VCR_SCHEMA}.match_judgments j WHERE j.study_id=$1 AND j.status='done' AND j.producer='job' AND j.prompt_version=ANY($2::text[]) AND j.model=$3 AND j.thinking=ANY($4::text[])
      AND ($5::text[] IS NULL OR j.subject_key=ANY($5::text[]))`, [studyId, [...promptVersions], model, Array.isArray(thinking) ? [...new Set(thinking)] : [thinking], subjectKeys ? [...subjectKeys] : null]);
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
        j.answer->'target' AS target, j.answer->>'eligibilitySource' AS eligibility_source
      FROM ${VCR_SCHEMA}.match_judgments j WHERE j.study_id=$1 AND ($2::text IS NULL OR j.subject_key=$2) AND ($3::text IS NULL OR j.target_kind=$3)
      AND ($4::text IS NULL OR j.target_id=$4)
      AND NOT EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals w WHERE w.study_id=j.study_id AND w.subject_key=j.subject_key)
      ORDER BY j.updated_at DESC, j.id LIMIT $5`, [studyId, subjectKey, targetKind, targetId, limit]);
    return rows.map((row) => ({ ...judgmentOf(row), disqualified: row.disqualified === true, target: row.target ?? null, eligibilitySource: row.eligibility_source ?? null }));
  }

  /**
   * The judging jobs of a scope, newest first, and only what a reader of their progress needs of them.
   * @param {{ studyId: string, direction: 'patient_to_trial' | 'trial_to_patient', subjectKey?: string | null, protocolVersionId?: string | null, limit?: number }} input
   */
  async jobsOf({ studyId, direction, subjectKey = null, protocolVersionId = null, limit = 30 }) {
    const columns = `id, state, scenario, checkpoint #>> '{judge,used,cost}' AS carried_cost, created_at, updated_at, finished_at`;
    return direction === 'patient_to_trial'
      ? this.rows(`SELECT ${columns} FROM ${VCR_SCHEMA}.jobs WHERE study_id = $1 AND kind = 'match_judge' AND scenario ->> 'direction' = 'patient_to_trial'
          AND scenario -> 'subjects' @> to_jsonb($2::text) ORDER BY created_at DESC LIMIT ${Math.max(1, Math.floor(limit))}`, [studyId, subjectKey])
      : this.rows(`SELECT ${columns} FROM ${VCR_SCHEMA}.jobs WHERE study_id = $1 AND kind = 'match_judge' AND scenario ->> 'direction' = 'trial_to_patient'
          AND scenario ->> 'protocolVersionId' = $2 ORDER BY created_at DESC LIMIT ${Math.max(1, Math.floor(limit))}`, [studyId, protocolVersionId]);
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
