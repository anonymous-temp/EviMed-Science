/**
 * A study's research question, 「研究问题与假设」, kept as versions (round-2 plan R22; the contract is the domain's
 * `vcrResearchQuestion.mjs`, this module is its store operations and what a reader makes of it).
 *
 * Hidden knowledge:
 *
 * - **A version is a row and a row is never edited.** A patch that changes a field is the next version under the question's key
 *   (`main` unless a run names another); the row holds the whole question as it stood, who wrote each field and which fields this
 *   version changed. A result that recorded `questionRef {id, version}` therefore keeps reading the question it answered.
 * - **The version is allocated under a per-question advisory lock**, so the page and a run writing together make two versions in
 *   an order, never two rows of one version. A patch that changes nothing (a run retrying) writes no row and answers the version
 *   that is already there.
 * - **What a write could not apply is answered, not hidden.** A field the person edited on the page stays; the write's answer lists
 *   it as `kept`, so the agent tells the person instead of believing its own write took.
 * - **The question a job answers is stamped by the platform.** `currentQuestionRef` is what the job intake records on a job that did
 *   not name one; it is the job's record, not its scenario, so it never changes a scenario hash or reaches the engine.
 *
 * @module vcrResearchQuestions
 */

import { applyQuestionPatch, normalizeQuestionPatch, VCR_QUESTION_BASES } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { vcrId } from "./vcrStoreBase.mjs";

/** The question a study has when nobody names another. */
export const VCR_QUESTION_DEFAULT_KEY = "main";
/** A question's key: a short lowercase word, like a model assessment's. */
export const VCR_QUESTION_KEY = /^[a-z][a-z0-9_]{0,59}$/;

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value */
const iso = (value) => (value instanceof Date ? value.toISOString() : value ? String(value) : null);

/** @param {any} row */
export function questionFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.key), version: Number(row.version), studyId: String(row.study_id), fields: object(row.fields), bases: object(row.bases),
    written: list(row.written).map(String), by: String(row.saved_by ?? "") || null, createdAt: iso(row.created_at),
  };
}

/**
 * Write a patch as the next version of a question, or answer the version that already says the same.
 * @param {any} store a `VcrStoreBase`
 * @param {{ studyId: string, userId: string, actor: string, basis: string, key?: string, patch: Record<string, any> }} input
 * `patch` is what `normalizeQuestionPatch` returned.
 */
export async function saveResearchQuestion(store, input) {
  const key = input.key ?? VCR_QUESTION_DEFAULT_KEY;
  if (!VCR_QUESTION_KEY.test(key)) throw new HttpError(400, "vcr_research_question_invalid", "研究问题的 id 是小写英文字母开头、只含小写字母、数字和下划线的短词，例如 main。");
  if (!(/** @type {readonly string[]} */ (VCR_QUESTION_BASES)).includes(input.basis)) throw new TypeError(`unknown question basis ${input.basis}`);
  return store.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vcr-question:${input.studyId}:${key}`]);
    const latest = questionFromRow((await client.query(
      `SELECT * FROM ${VCR_SCHEMA}.research_questions WHERE study_id = $1 AND key = $2 ORDER BY version DESC LIMIT 1`, [input.studyId, key])).rows[0]);
    const next = applyQuestionPatch(latest, input.patch, input.basis);
    if (!next.changed) return { question: latest, created: false, kept: next.kept };
    const row = (await client.query(
      `INSERT INTO ${VCR_SCHEMA}.research_questions (id, study_id, user_id, key, version, fields, bases, written, saved_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9) RETURNING *`,
      [vcrId("question"), input.studyId, input.userId, key, next.version, JSON.stringify(next.fields), JSON.stringify(next.bases),
        JSON.stringify(next.written), input.actor])).rows[0];
    await store.audit({ client, studyId: input.studyId, userId: input.userId, actor: input.actor, action: "vcr.research_question.save", object: String(row.id),
      detail: { key, version: next.version, fields: next.written, basis: input.basis } });
    return { question: questionFromRow(row), created: true, kept: next.kept };
  });
}

/**
 * The current version of every question of a study, the default one first.
 * @param {any} store @param {string} studyId
 */
export async function researchQuestions(store, studyId) {
  const rows = await store.rows(`SELECT DISTINCT ON (key) * FROM ${VCR_SCHEMA}.research_questions WHERE study_id = $1 ORDER BY key, version DESC`, [studyId]);
  // which fields each version wrote, so a result that answered an earlier version can be told what changed since (`history`; a presenter reads it, a page never sees it)
  const written = await store.rows(`SELECT key, version, written FROM ${VCR_SCHEMA}.research_questions WHERE study_id = $1`, [studyId]);
  return rows.map((row) => {
    const question = questionFromRow(row);
    return question && { ...question, history: written.filter((entry) => String(entry.key) === question.id).map((entry) => ({ version: Number(entry.version), written: list(entry.written).map(String) })) };
  }).sort((a, b) => Number(b?.id === VCR_QUESTION_DEFAULT_KEY) - Number(a?.id === VCR_QUESTION_DEFAULT_KEY) || String(b?.createdAt).localeCompare(String(a?.createdAt)));
}

/**
 * The question a new job answers: the default one, else the one written last; none for a study with no question.
 * @param {any} store @param {string} studyId
 * @returns {Promise<{ id: string, version: number } | null>}
 */
export async function currentQuestionRef(store, studyId) {
  const [current] = await researchQuestions(store, studyId);
  return current ? { id: current.id, version: current.version } : null;
}

/**
 * Check a patch the way the page and the run's writer both do, answering the normalised patch or the first issues.
 * @param {unknown} raw
 */
export function checkResearchQuestionPatch(raw) {
  const { patch, issues } = normalizeQuestionPatch(raw);
  return { patch, issues };
}
