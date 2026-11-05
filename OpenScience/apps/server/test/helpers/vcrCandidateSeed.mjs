// Candidate trials as the rows the retired `candidate_trial` write used to leave behind. Production no longer writes them; the readers
// (the ranked list, the matching page's rule assessments, `vcr_read candidate_trials`) and erasure still serve rows already stored, and
// their tests seed those rows here.
import { candidateCriteriaHash } from "../../src/vcrCandidateTrialStore.mjs";
import { VCR_SCHEMA } from "../../src/vcrPersistence.mjs";
import { vcrId } from "../../src/vcrStoreBase.mjs";
import { languageCriteriaByKey, languageCriterionHash } from "../../src/vcrMatchingSnapshot.mjs";
import { matchingInputDigest } from "../../src/vcrMatching.mjs";

/**
 * One candidate trial with its criteria, replacing the criteria it had when they differ (the verdicts made against the old ones are marked superseded).
 * @param {any} store a VcrCandidateTrialStore @param {{ studyId: string, userId: string, trial: Record<string, any>, criteria: readonly any[] }} input
 */
export async function seedCandidateTrial(store, { studyId, userId, trial, criteria }) {
  /** @type {string[]} */
  let reassess = [];
  let created = false;
  let criteriaChanged = false;
  const id = await store.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vcr-candidate-trials:${studyId}`]);
    const held = (await client.query(`SELECT * FROM ${VCR_SCHEMA}.candidate_trials WHERE study_id = $1 AND registry = $2 AND registry_id = $3 FOR UPDATE`,
      [studyId, trial.registry, trial.registryId])).rows[0] ?? null;
    created = !held;
    const sourceChanged = Boolean(held && (held.record_hash ?? null) !== (trial.recordHash ?? null));
    const row = (await client.query(
      `INSERT INTO ${VCR_SCHEMA}.candidate_trials
         (id, study_id, user_id, registry, registry_id, title, phase, status, conditions, locations, url, record_hash, retrieved_at, eligibility_text, source_collection)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15::jsonb)
       ON CONFLICT (study_id, registry, registry_id) DO UPDATE SET
         title = EXCLUDED.title, phase = EXCLUDED.phase, status = EXCLUDED.status, conditions = EXCLUDED.conditions,
         locations = EXCLUDED.locations, url = EXCLUDED.url, record_hash = EXCLUDED.record_hash,
         retrieved_at = EXCLUDED.retrieved_at, eligibility_text = EXCLUDED.eligibility_text, source_collection = EXCLUDED.source_collection, updated_at = now()
       RETURNING *`,
      [held?.id ?? vcrId("candidateTrial"), studyId, userId, trial.registry, trial.registryId, String(trial.title ?? ""), String(trial.phase ?? ""),
        String(trial.status ?? ""), JSON.stringify(trial.conditions ?? []), JSON.stringify(trial.locations ?? {}), String(trial.url ?? ""),
        trial.recordHash ?? null, trial.retrievedAt ?? null, String(trial.eligibilityText ?? ""), JSON.stringify(trial.collection ?? null)])).rows[0];
    const hash = candidateCriteriaHash(criteria);
    criteriaChanged = !held || sourceChanged || held.criteria_hash !== hash;
    if (criteriaChanged) {
      reassess = (await client.query(`SELECT DISTINCT subject_key FROM ${VCR_SCHEMA}.candidate_trial_assessments WHERE candidate_trial_id = $1 ORDER BY subject_key`,
        [row.id])).rows.map((/** @type {any} */ entry) => String(entry.subject_key));
      await client.query(`UPDATE ${VCR_SCHEMA}.candidate_trial_assessments SET superseded_at = now() WHERE candidate_trial_id = $1 AND superseded_at IS NULL`, [row.id]);
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
    }
    return String(row.id);
  });
  const saved = await store.getCandidateTrial({ studyId, id });
  return { trial: saved, criteria: await store.listCriteria(id), created, criteriaChanged, reassess };
}

/**
 * The trial seeded as above and the named patients (and those who had a verdict about the old criteria) judged against it by the evaluator.
 * @param {any} patientTrials @param {any} store @param {any} study @param {{ trial: Record<string, any>, criteria: readonly any[], subjectKeys?: readonly string[] }} input
 */
export async function seedWrittenTrial(patientTrials, store, study, { trial, criteria, subjectKeys = [] }) {
  const saved = await seedCandidateTrial(store, { studyId: study.id, userId: study.userId, trial, criteria });
  const who = [...new Set([...subjectKeys, ...(saved.criteriaChanged ? saved.reassess : [])])];
  const evaluation = who.length ? await patientTrials.evaluate(study, { subjectKeys: who, trialIds: [saved.trial.id] }) : { evaluated: [], unavailable: [], notes: [] };
  return { ...saved, evaluation };
}

/**
 * An answer to a candidate trial's language criterion, bound to the criterion's wording.
 * @param {any} store @param {{ studyId: string, userId: string, subjectKey: string, candidateTrialId: string, criterionKey: string, state: string, evidence: readonly any[], provenance?: any }} input
 */
export async function seedCandidateLanguage(store, input) {
  const { studyId, userId, subjectKey, candidateTrialId, criterionKey, state, evidence, provenance = null } = input;
  const criteria = await store.listCriteria(candidateTrialId);
  const bound = languageCriteriaByKey(criteria).get(criterionKey);
  const binding = bound && languageCriterionHash(bound, criterionKey);
  const visibleAt = (evidence ?? []).map((/** @type {any} */ item) => Date.parse(item?.visibleAt ?? "")).filter(Number.isFinite);
  const row = (await store.rows(
    `INSERT INTO ${VCR_SCHEMA}.language_judgments
       (id, study_id, user_id, subject_key, criterion_key, state, evidence, visible_at, protocol_version_id, candidate_trial_id, criterion_hash, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NULL, $9, $10, $11::jsonb) RETURNING *`,
    [vcrId("judgment"), studyId, userId, subjectKey, criterionKey, state, JSON.stringify(evidence ?? []),
      new Date(visibleAt.length ? Math.max(...visibleAt) : Date.now()).toISOString(), candidateTrialId, binding, provenance ? JSON.stringify(provenance) : null]))[0];
  if (provenance) {
    await store.rows(`INSERT INTO ${VCR_SCHEMA}.matching_producers (study_id, target_id, producer_hash, provenance) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
      [studyId, row.id, matchingInputDigest(provenance), JSON.stringify(provenance)]);
  }
  return { id: String(row.id), subjectKey, criterionKey, state };
}
