/**
 * Candidate trials on disk: the trials a run found for a patient, their criteria, and the verdicts about
 * a patient against each (「给患者找试验」, `vcrPatientTrials.mjs`).
 *
 * Hidden knowledge:
 *
 * - **A candidate trial is not a version of the study's protocol.** The study's own matching reads
 *   `protocol_versions`, `criteria` and `matching_assessments`; a candidate in any of them would join the
 *   protocol list, the funnel and the referral ledger of a trial that is not the study's. Candidates and
 *   the verdicts about them have tables of their own, with the same columns for what they record, so
 *   the one evaluator reads both and no count of the study's own trial changes.
 * - **One row per registry id.** Writing a trial again is the same trial: its identity is the record's
 *   newest word and its criteria are replaced only when they differ. Criteria that did not change keep
 *   their ids, so an answer to one of its language criteria stays bound to it.
 * - **A verdict is derived; a changed criterion set makes the old ones wrong.** When the criteria of a
 *   trial change, the verdicts made against the old ones are removed in the same transaction and the
 *   caller is handed the patients who had one (`reassess`), so the platform evaluates them again on the
 *   new criteria. A page never ranks a trial by a verdict about criteria it no longer has.
 * - **A trial and its criteria are written together or not at all**, and a study holds at most a
 *   configured number of candidates (each costs an evaluation per patient). A trial already held can
 *   always be updated.
 *
 * @module vcrCandidateTrialStore
 */

import { HttpError } from "./security.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase, vcrId } from "./vcrStoreBase.mjs";
import { matchingInputDigest } from "./vcrMatching.mjs";

/** @param {unknown} value @returns {string | null} */
const iso = (value) => (value ? new Date(/** @type {any} */ (value)).toISOString() : null);

/** @param {any} row */
const trialOf = (row) => (row ? {
  id: String(row.id),
  studyId: String(row.study_id),
  registry: String(row.registry),
  registryId: String(row.registry_id),
  title: String(row.title ?? ""),
  phase: String(row.phase ?? ""),
  status: String(row.status ?? ""),
  conditions: Array.isArray(row.conditions) ? row.conditions : [],
  locations: row.locations && typeof row.locations === "object" ? row.locations : {},
  url: String(row.url ?? ""),
  recordHash: row.record_hash ?? null,
  retrievedAt: iso(row.retrieved_at),
  eligibilityText: String(row.eligibility_text ?? ""),
  criteriaHash: String(row.criteria_hash ?? ""),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
} : null);

/** A criterion as the evaluator reads it: the shape `vcrMatchStore` gives a protocol's. @param {any} row */
const criterionOf = (row) => (row ? {
  id: String(row.id),
  studyId: String(row.study_id),
  candidateTrialId: String(row.candidate_trial_id),
  protocolVersionId: null,
  ordinal: Number(row.ordinal),
  kind: String(row.kind),
  criterionType: String(row.criterion_type),
  requirement: row.requirement ?? {},
  applicability: row.applicability ?? null,
  sourceText: String(row.source_text ?? ""),
  sourceLocator: row.source_locator ?? {},
  evidenceNeeded: Array.isArray(row.evidence_needed) ? row.evidence_needed : [],
  reviewState: String(row.review_state ?? "ai_set"),
  createdAt: iso(row.created_at),
} : null);

/**
 * What a criteria set is, for telling whether a write changed it: the parts the evaluator reads, in order.
 * @param {readonly any[]} criteria
 */
export function candidateCriteriaHash(criteria) {
  return matchingInputDigest((criteria ?? []).map((criterion) => ({
    kind: criterion?.kind === "exclusion" ? "exclusion" : "inclusion", criterionType: criterion?.criterionType ?? "other",
    requirement: criterion?.requirement ?? {}, applicability: criterion?.applicability ?? null, sourceText: String(criterion?.sourceText ?? ""),
  })));
}

/** Candidate trials, their criteria and the verdicts about a patient against each. One store, from the module's shared base. */
export class VcrCandidateTrialStore extends VcrStoreBase {
  /**
   * Write a candidate trial and, when `criteria` is given, its criteria — in one transaction.
   *
   * `criteria: null` leaves the criteria the trial has (a write that only names patients to evaluate);
   * an array replaces them when it differs from what is held, and then the verdicts made against the
   * old ones are removed and the patients who had one are answered in `reassess`.
   * @param {{ studyId: string, userId: string, trial: Record<string, any>, criteria?: readonly any[] | null, max: number }} input
   * @returns {Promise<{ trial: NonNullable<ReturnType<typeof trialOf>>, criteria: NonNullable<ReturnType<typeof criterionOf>>[],
   *   created: boolean, criteriaChanged: boolean, reassess: string[] }>}
   */
  async saveCandidateTrial({ studyId, userId, trial, criteria = null, max }) {
    return this.transaction(async (client) => {
      // Two writers of the same study must not both find room for the last candidate.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vcr-candidate-trials:${studyId}`]);
      const held = (await client.query(
        `SELECT * FROM ${VCR_SCHEMA}.candidate_trials WHERE study_id = $1 AND registry = $2 AND registry_id = $3 FOR UPDATE`,
        [studyId, trial.registry, trial.registryId])).rows[0] ?? null;
      if (!held) {
        const count = Number((await client.query(`SELECT count(*)::int AS n FROM ${VCR_SCHEMA}.candidate_trials WHERE study_id = $1`, [studyId])).rows[0]?.n ?? 0);
        if (count >= max) {
          throw new HttpError(409, "vcr_write_refused", `本研究最多保存 ${max} 个候选试验，已满：先在已有的里挑，或换一个研究。`);
        }
      }
      const row = (await client.query(
        `INSERT INTO ${VCR_SCHEMA}.candidate_trials
           (id, study_id, user_id, registry, registry_id, title, phase, status, conditions, locations, url, record_hash, retrieved_at, eligibility_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14)
         ON CONFLICT (study_id, registry, registry_id) DO UPDATE SET
           title = EXCLUDED.title, phase = EXCLUDED.phase, status = EXCLUDED.status, conditions = EXCLUDED.conditions,
           locations = EXCLUDED.locations, url = EXCLUDED.url, record_hash = EXCLUDED.record_hash,
           retrieved_at = EXCLUDED.retrieved_at, eligibility_text = EXCLUDED.eligibility_text, updated_at = now()
         RETURNING *`,
        [held?.id ?? vcrId("candidateTrial"), studyId, userId, trial.registry, trial.registryId, String(trial.title ?? ""), String(trial.phase ?? ""),
          String(trial.status ?? ""), JSON.stringify(trial.conditions ?? []), JSON.stringify(trial.locations ?? {}), String(trial.url ?? ""),
          trial.recordHash ?? null, trial.retrievedAt ?? null, String(trial.eligibilityText ?? "")])).rows[0];

      let criteriaChanged = false;
      /** @type {string[]} */
      let reassess = [];
      if (criteria !== null) {
        const hash = candidateCriteriaHash(criteria);
        criteriaChanged = !held || held.criteria_hash !== hash;
        if (criteriaChanged) {
          reassess = (await client.query(
            `SELECT DISTINCT subject_key FROM ${VCR_SCHEMA}.candidate_trial_assessments WHERE candidate_trial_id = $1 ORDER BY subject_key`,
            [row.id])).rows.map((entry) => String(entry.subject_key));
          // Derived rows: the verdicts about criteria this trial no longer has go, and are made again by the caller.
          await client.query(`DELETE FROM ${VCR_SCHEMA}.candidate_trial_assessments WHERE candidate_trial_id = $1`, [row.id]);
          for (const [index, criterion] of criteria.entries()) {
            await client.query(
              `INSERT INTO ${VCR_SCHEMA}.candidate_trial_criteria
                 (id, study_id, candidate_trial_id, user_id, ordinal, kind, criterion_type, requirement, applicability, source_text, source_locator, evidence_needed, review_state)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13)
               ON CONFLICT (candidate_trial_id, ordinal) DO UPDATE SET
                 kind = EXCLUDED.kind, criterion_type = EXCLUDED.criterion_type, requirement = EXCLUDED.requirement,
                 applicability = EXCLUDED.applicability, source_text = EXCLUDED.source_text, source_locator = EXCLUDED.source_locator,
                 evidence_needed = EXCLUDED.evidence_needed, review_state = EXCLUDED.review_state`,
              [vcrId("candidateCriterion"), studyId, row.id, userId, index + 1, criterion?.kind === "exclusion" ? "exclusion" : "inclusion",
                criterion?.criterionType ?? "other", JSON.stringify(criterion?.requirement ?? {}),
                criterion?.applicability ? JSON.stringify(criterion.applicability) : null, String(criterion?.sourceText ?? ""),
                JSON.stringify(criterion?.sourceLocator ?? {}), JSON.stringify(criterion?.evidenceNeeded ?? []), criterion?.reviewState ?? "ai_set"]);
          }
          await client.query(`DELETE FROM ${VCR_SCHEMA}.candidate_trial_criteria WHERE candidate_trial_id = $1 AND ordinal > $2`, [row.id, criteria.length]);
          await client.query(`UPDATE ${VCR_SCHEMA}.candidate_trials SET criteria_hash = $2 WHERE id = $1`, [row.id, hash]);
          row.criteria_hash = hash;
        }
      }
      const saved = (await client.query(
        `SELECT * FROM ${VCR_SCHEMA}.candidate_trial_criteria WHERE candidate_trial_id = $1 ORDER BY ordinal`, [row.id])).rows.map(criterionOf);
      await this.audit({
        client, studyId, userId, actor: "runtime", action: "vcr.candidate_trial.save", object: row.id,
        detail: { registry: trial.registry, registryId: trial.registryId, created: !held, criteria: saved.length, criteriaChanged },
      });
      return { trial: /** @type {any} */ (trialOf(row)), criteria: /** @type {any} */ (saved), created: !held, criteriaChanged, reassess };
    });
  }

  /**
   * The study's candidate trials, newest first. A trial of another study is not here, whoever asks.
   * @param {{ studyId: string, limit?: number }} input
   */
  async listCandidateTrials({ studyId, limit = 200 }) {
    const rows = await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.candidate_trials WHERE study_id = $1 ORDER BY updated_at DESC, id LIMIT $2`,
      [studyId, Math.max(1, Math.min(1000, Number(limit) || 200))]);
    return rows.map(trialOf);
  }

  /**
   * One trial of the study, by its id or by its registry and registry id.
   * @param {{ studyId: string, id?: string | null, registry?: string | null, registryId?: string | null }} input
   */
  async getCandidateTrial({ studyId, id = null, registry = null, registryId = null }) {
    if (id) return trialOf(await this.one(`SELECT * FROM ${VCR_SCHEMA}.candidate_trials WHERE study_id = $1 AND id = $2`, [studyId, id]));
    if (!registryId) return null;
    return trialOf(await this.one(
      `SELECT * FROM ${VCR_SCHEMA}.candidate_trials WHERE study_id = $1 AND registry_id = $2 AND ($3::text IS NULL OR registry = $3)
        ORDER BY updated_at DESC LIMIT 1`, [studyId, registryId, registry]));
  }

  /** The criteria of one trial, in order. @param {string} candidateTrialId */
  async listCriteria(candidateTrialId) {
    return (await this.rows(`SELECT * FROM ${VCR_SCHEMA}.candidate_trial_criteria WHERE candidate_trial_id = $1 ORDER BY ordinal`, [candidateTrialId])).map(criterionOf);
  }

  /**
   * The criteria of several trials of one study, by trial id.
   * @param {string} studyId @param {readonly string[]} ids @returns {Promise<Map<string, NonNullable<ReturnType<typeof criterionOf>>[]>>}
   */
  async criteriaOfTrials(studyId, ids) {
    /** @type {Map<string, any[]>} */
    const byTrial = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return byTrial;
    const rows = await this.rows(
      `SELECT * FROM ${VCR_SCHEMA}.candidate_trial_criteria WHERE study_id = $1 AND candidate_trial_id = ANY($2::text[]) ORDER BY candidate_trial_id, ordinal`,
      [studyId, [...ids]]);
    for (const row of rows) byTrial.get(String(row.candidate_trial_id))?.push(criterionOf(row));
    return byTrial;
  }
}
