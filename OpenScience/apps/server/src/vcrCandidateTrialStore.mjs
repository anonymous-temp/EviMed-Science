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
import { languageKeysOf, matchingInputDigest, publicMatchingProvenance } from "./vcrMatching.mjs";
import { languageCriterionHash, languageInput } from "./vcrMatchingSnapshot.mjs";

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

/** One patient judged against one candidate trial. The references the verdict was rebuilt from are the platform's own and are not read out. @param {any} row */
const assessmentOf = (row) => (row ? {
  id: String(row.id),
  studyId: String(row.study_id),
  candidateTrialId: String(row.candidate_trial_id),
  subjectKey: String(row.subject_key),
  asOf: iso(row.as_of),
  summary: String(row.summary),
  counts: row.counts ?? {},
  evidenceGaps: Array.isArray(row.evidence_gaps) ? row.evidence_gaps : [],
  provenance: publicMatchingProvenance(row.provenance ?? {}),
  createdAt: iso(row.created_at),
} : null);

/** @param {any} row */
const judgmentOf = (row) => (row ? {
  id: String(row.id),
  assessmentId: String(row.assessment_id),
  criterionId: String(row.criterion_id),
  state: String(row.state),
  applicable: row.applicable !== false,
  decidedBy: String(row.decided_by ?? "code"),
  evidence: Array.isArray(row.evidence) ? row.evidence : [],
  recheckAt: iso(row.recheck_at),
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
  // ------------------------------------------------------- assessments

  /**
   * One patient's verdict against one candidate trial, with its per-criterion judgments, in one transaction: a judgment that failed to
   * land would read as a finished evaluation with fewer criteria and the same summary. Writing the same instant and inputs again replaces
   * the set. A trial of another study is not found.
   * @param {{ assessment: any, userId: string }} input
   */
  async saveAssessment({ assessment, userId }) {
    return this.transaction(async (client) => {
      const owned = await client.query(
        `SELECT 1 FROM ${VCR_SCHEMA}.candidate_trials WHERE id = $1 AND study_id = $2`, [assessment.candidateTrialId, assessment.studyId]);
      if (!owned.rowCount) throw new HttpError(404, "vcr_write_refused", "This candidate trial is not the study's.");
      const row = (await client.query(
        `INSERT INTO ${VCR_SCHEMA}.candidate_trial_assessments
           (id, study_id, candidate_trial_id, user_id, subject_key, as_of, summary, counts, evidence_gaps, provenance, input_snapshot_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11)
         ON CONFLICT (candidate_trial_id, subject_key, as_of, input_snapshot_id) DO UPDATE SET
           summary = EXCLUDED.summary, counts = EXCLUDED.counts, evidence_gaps = EXCLUDED.evidence_gaps, provenance = EXCLUDED.provenance
         RETURNING *`,
        [vcrId("candidateAssessment"), assessment.studyId, assessment.candidateTrialId, userId, assessment.subjectKey, assessment.asOf, assessment.summary,
          JSON.stringify(assessment.counts ?? {}), JSON.stringify(assessment.evidenceGaps ?? []), JSON.stringify(assessment.provenance ?? {}),
          String(assessment.provenance?.inputSnapshotId ?? "")])).rows[0];
      const kept = (assessment.judgments ?? []).map((/** @type {any} */ judgment) => String(judgment.criterionId));
      await client.query(`DELETE FROM ${VCR_SCHEMA}.candidate_trial_judgments WHERE assessment_id = $1 AND NOT (criterion_id = ANY($2::text[]))`, [row.id, kept]);
      for (const judgment of assessment.judgments ?? []) {
        await client.query(
          `INSERT INTO ${VCR_SCHEMA}.candidate_trial_judgments (id, assessment_id, criterion_id, user_id, state, applicable, decided_by, evidence, recheck_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           ON CONFLICT (assessment_id, criterion_id) DO UPDATE SET
             state = EXCLUDED.state, applicable = EXCLUDED.applicable, decided_by = EXCLUDED.decided_by, evidence = EXCLUDED.evidence, recheck_at = EXCLUDED.recheck_at`,
          [vcrId("candidateJudgment"), row.id, judgment.criterionId, userId, judgment.state, judgment.applicable !== false, judgment.decidedBy ?? "code",
            JSON.stringify(judgment.evidence ?? []), judgment.recheckAt ?? null]);
      }
      await this.audit({
        client, studyId: assessment.studyId, userId, actor: "control-plane", action: "vcr.candidate_assessment.save", object: row.id,
        detail: { candidateTrialId: assessment.candidateTrialId, subjectKey: assessment.subjectKey, summary: assessment.summary, asOf: assessment.asOf },
      });
      return { ...assessmentOf(row), judgments: (assessment.judgments ?? []).map((/** @type {any} */ judgment) => ({ ...judgment })) };
    });
  }

  /**
   * One assessment with its judgments. With a `studyId`, an assessment of another study is not found, whoever asks.
   * @param {string} id @param {string | null} [studyId]
   */
  async getAssessment(id, studyId = null) {
    const row = await this.one(`SELECT * FROM ${VCR_SCHEMA}.candidate_trial_assessments WHERE id = $1 AND ($2::text IS NULL OR study_id = $2)`, [id, studyId]);
    if (!row) return null;
    const judgments = await this.rows(`SELECT * FROM ${VCR_SCHEMA}.candidate_trial_judgments WHERE assessment_id = $1 ORDER BY created_at, id`, [id]);
    return { ...assessmentOf(row), judgments: judgments.map(judgmentOf) };
  }

  /**
   * The newest verdict about this patient against each trial of the study that has judged them, by trial id: what a page ranks.
   * @param {{ studyId: string, subjectKey: string }} input
   * @returns {Promise<Map<string, NonNullable<ReturnType<typeof assessmentOf>>>>}
   */
  async latestAssessments({ studyId, subjectKey }) {
    const rows = await this.rows(
      `SELECT DISTINCT ON (candidate_trial_id) * FROM ${VCR_SCHEMA}.candidate_trial_assessments
        WHERE study_id = $1 AND subject_key = $2 ORDER BY candidate_trial_id, as_of DESC, created_at DESC`, [studyId, subjectKey]);
    return new Map(rows.map((row) => [String(row.candidate_trial_id), /** @type {any} */ (assessmentOf(row))]));
  }

  // --------------------------------------------- language criteria

  /**
   * The answer to a criterion of a candidate trial that only language can decide, bound to that trial (and to the wording of the criteria
   * that carry the key, so an answer to a criterion that has since changed is not read as an answer to the new one). Each answer is its own
   * row; the newest per (patient, key) is the one evaluated. The quotation's own check is the writer's, and the evaluator re-reads it.
   * @param {{ studyId: string, userId: string, subjectKey: string, candidateTrialId: string, criterionKey: string, state: string,
   *   evidence: readonly any[], provenance?: any }} input
   */
  async saveLanguageJudgment({ studyId, userId, subjectKey, candidateTrialId, criterionKey, state, evidence, provenance = null }) {
    return this.transaction(async (client) => {
      const trial = (await client.query(`SELECT id FROM ${VCR_SCHEMA}.candidate_trials WHERE id = $1 AND study_id = $2`, [candidateTrialId, studyId])).rows[0];
      if (!trial) throw new HttpError(409, "vcr_write_refused", "This candidate trial is not the study's.");
      const criteria = (await client.query(
        `SELECT * FROM ${VCR_SCHEMA}.candidate_trial_criteria WHERE candidate_trial_id = $1 ORDER BY ordinal`, [trial.id])).rows.map(criterionOf)
        .filter((/** @type {any} */ criterion) => languageKeysOf(criterion.requirement, criterion.id).includes(criterionKey));
      if (!criteria.length) throw new HttpError(409, "vcr_criterion_malformed", "This language key does not belong to the candidate trial.");
      const visibleAt = (evidence ?? []).map((/** @type {any} */ item) => Date.parse(item?.visibleAt ?? "")).filter(Number.isFinite);
      const row = (await client.query(
        `INSERT INTO ${VCR_SCHEMA}.language_judgments
           (id, study_id, user_id, subject_key, criterion_key, state, evidence, visible_at, protocol_version_id, candidate_trial_id, criterion_hash, provenance)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NULL, $9, $10, $11::jsonb) RETURNING *`,
        [vcrId("judgment"), studyId, userId, subjectKey, criterionKey, state, JSON.stringify(evidence ?? []),
          new Date(visibleAt.length ? Math.max(...visibleAt) : Date.now()).toISOString(), trial.id,
          languageCriterionHash(/** @type {any} */ (criteria), criterionKey), provenance ? JSON.stringify(provenance) : null])).rows[0];
      if (provenance) {
        await client.query(
          `INSERT INTO ${VCR_SCHEMA}.matching_producers (study_id, target_id, producer_hash, provenance) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
          [studyId, row.id, matchingInputDigest(provenance), JSON.stringify(provenance)]);
      }
      await this.audit({ client, studyId, userId, actor: "runtime", action: "vcr.candidate_language_judgment.save", object: row.id,
        detail: { candidateTrialId, subjectKey, criterionKey, state } });
      return { id: String(row.id), subjectKey, criterionKey, state };
    });
  }

  /**
   * The newest answer per criterion key about one patient and one candidate trial, visible by `visibleBy`: `{ criterionKey → { id, state,
   * evidence, … } }`, only those whose key and wording still match the trial's criteria.
   * @param {{ studyId: string, candidateTrialId: string, subjectKey: string, visibleBy?: string | null }} input
   * @returns {Promise<Record<string, any>>}
   */
  async latestLanguageJudgments({ studyId, candidateTrialId, subjectKey, visibleBy = null }) {
    const criteria = await this.listCriteria(candidateTrialId);
    const rows = await this.rows(
      `SELECT DISTINCT ON (criterion_key) * FROM ${VCR_SCHEMA}.language_judgments
        WHERE study_id = $1 AND candidate_trial_id = $2 AND subject_key = $3 AND ($4::timestamptz IS NULL OR visible_at <= $4)
        ORDER BY criterion_key, created_at DESC, id DESC`, [studyId, candidateTrialId, subjectKey, visibleBy]);
    /** @type {Record<string, any>} */
    const answers = {};
    for (const row of rows) {
      const bound = criteria.filter((/** @type {any} */ criterion) => languageKeysOf(criterion.requirement, criterion.id).includes(row.criterion_key));
      if (!bound.length || row.criterion_hash !== languageCriterionHash(/** @type {any} */ (bound), row.criterion_key)) continue;
      answers[String(row.criterion_key)] = languageInput({ id: row.id, state: row.state, evidence: row.evidence, protocolVersionId: null,
        criterionHash: row.criterion_hash, provenance: row.provenance });
    }
    return answers;
  }
}
