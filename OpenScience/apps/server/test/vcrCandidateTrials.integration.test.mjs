// Candidate trials on a real PostgreSQL: the trials a run found for a patient are objects of the study,
// kept apart from the study's own protocol versions, written once per registry id, bounded per study,
// and gone with the study. Skipped when OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VCR_TABLES } from "../src/vcrPersistence.mjs";
import { VcrCandidateTrialStore } from "../src/vcrCandidateTrialStore.mjs";
import { VcrMatchStore } from "../src/vcrMatchStore.mjs";
import { assessSubject, VCR_MATCHING_EVALUATOR_VERSION } from "../src/vcrMatching.mjs";
import { languageCriterionHash } from "../src/vcrMatchingSnapshot.mjs";
import { VcrStoreBase, deleteVcrStudyRows, vcrId } from "../src/vcrStoreBase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { seedCandidateLanguage, seedCandidateTrial } from "./helpers/vcrCandidateSeed.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {any} */
let database = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {VcrCandidateTrialStore} */
let trials;
/** @type {VcrMatchStore} */
let matching;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrtrials");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  await new VcrStoreBase({ database }).ready();
  trials = new VcrCandidateTrialStore({ database });
  matching = new VcrMatchStore({ database });
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

/** @param {string} sql @param {unknown[]} [values] */
const q = async (sql, values = []) => (await database.query(sql, values)).rows;
const USER = "u_trials";

async function seedStudy() {
  const id = vcrId("study");
  await q(`INSERT INTO evimed_vcr.studies (id, user_id, project_id, name, question, data_tier, intended_use)
    VALUES ($1, $2, $3, 'EV-201 二线 NSCLC', '给患者找试验', 'T1', 'exploratory')`, [id, USER, `prj_${id}`]);
  return id;
}

/** The identity a registry record gives, as `candidateTrialFromRecord` makes it. @param {string} registryId @param {Record<string, any>} [extra] */
const trial = (registryId, extra = {}) => ({
  registry: "clinicaltrials.gov", registryId, title: `Trial ${registryId}`, phase: "PHASE2", status: "RECRUITING", conditions: ["NSCLC"],
  locations: { total: 2, countries: ["China"], sites: [{ facility: "A", city: "Beijing", state: "", country: "China", status: "RECRUITING" }] },
  url: `https://clinicaltrials.gov/study/${registryId}`, recordHash: "b".repeat(64), retrievedAt: "2026-10-10T08:00:00.000Z",
  eligibilityText: "Inclusion Criteria:\n* Age >= 18\nExclusion Criteria:\n* Active brain metastases", ...extra,
});

const AGE = { kind: "inclusion", criterionType: "demographic", sourceText: "Age >= 18",
  requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" }, applicability: null, sourceLocator: { recordHash: "b".repeat(64) }, evidenceNeeded: [] };
const BRAIN = { kind: "exclusion", criterionType: "comorbidity", sourceText: "Active brain metastases",
  requirement: { op: "absent", variable: "active_brain_metastasis" }, applicability: null, sourceLocator: {}, evidenceNeeded: ["head MRI within 4 weeks"] };

test("the migration creates the candidate-trial tables and every one is a declared table", options, async () => {
  const have = (await q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'evimed_vcr'")).map((row) => row.table_name);
  for (const name of ["candidate_trials", "candidate_trial_criteria", "candidate_trial_assessments", "candidate_trial_judgments"]) {
    assert.ok(have.includes(name), `${name} is created`);
    assert.ok(VCR_TABLES.includes(name), `${name} is declared, so a deletion path and the persistence test know it`);
  }
  const column = await q("SELECT 1 FROM information_schema.columns WHERE table_schema = 'evimed_vcr' AND table_name = 'language_judgments' AND column_name = 'candidate_trial_id'");
  assert.equal(column.length, 1, "an answer to a language criterion can be bound to a candidate trial");
});

test("both matching stores round-trip applicability language answers and independently evaluated states", options, async () => {
  const studyId = await seedStudy();
  const criterion = { ...AGE, applicability: { op: "language", key: "subgroup", text: "Does this screening apply to the patient's subgroup?" } };
  const protocol = await matching.saveProtocolVersion({ studyId, userId: USER, criteria: [criterion] });
  const registry = await seedCandidateTrial(trials, { studyId, userId: USER, trial: trial("NCT05000099"), criteria: [criterion] });
  const candidateTrialId = registry.trial.id;
  const subjectKey = "P-applicability";
  const asOf = "2026-10-11T00:00:00.000Z";
  const quote = "This screening applies to the subgroup.";
  const documents = { record: { text: quote } };
  const evidence = [{ documentId: "record", quote, start: 0, end: quote.length, visibleAt: "2026-10-10T00:00:00.000Z" }];
  const input = { studyId, userId: USER, subjectKey, criterionKey: "subgroup", state: "satisfied", evidence };
  const protocolAnswer = await matching.saveLanguageJudgment({ ...input, protocolVersionId: protocol.id });
  const candidateAnswer = await seedCandidateLanguage(trials, { ...input, candidateTrialId });
  const protocolAnswers = (await matching.latestLanguageJudgments({ studyId, protocolVersionId: protocol.id, visibleBy: asOf })).get(subjectKey);
  const candidateAnswers = await trials.latestLanguageJudgments({ studyId, candidateTrialId, subjectKey, visibleBy: asOf });
  assert.equal(protocolAnswers.subgroup.id, protocolAnswer.id);
  assert.equal(candidateAnswers.subgroup.id, candidateAnswer.id);
  assert.deepEqual((await trials.languageAnswersForTrials(studyId, subjectKey, [candidateTrialId], new Map([[candidateTrialId, registry.criteria]]))).get(candidateTrialId), new Set(["subgroup"]));

  const facts = [{ id: "age", variable: "age", value: 17, unit: "year", extractedBy: "structured" }];
  const protocolAssessment = assessSubject({ studyId, protocolVersionId: protocol.id, subjectKey, asOf, criteria: protocol.criteria,
    facts, documents, modelJudgments: protocolAnswers, provenance: { inputSnapshotId: "current-protocol" } });
  const candidateAssessment = assessSubject({ studyId, subjectKey, asOf, criteria: registry.criteria, facts,
    documents, modelJudgments: candidateAnswers, provenance: { inputSnapshotId: "current-candidate" } });
  const savedProtocol = await matching.saveAssessment({ userId: USER, assessment: protocolAssessment });
  const savedCandidate = await trials.saveAssessment({ userId: USER, assessment: { ...candidateAssessment, candidateTrialId },
    expectedRecordHash: registry.trial.recordHash, expectedCriteriaHash: registry.trial.criteriaHash });
  for (const saved of [await matching.getAssessment(savedProtocol.id, studyId), await trials.getAssessment(savedCandidate.id, studyId)]) {
    assert.equal(saved.summary, "ineligible");
    assert.equal(saved.provenance.matchingEvaluatorVersion, VCR_MATCHING_EVALUATOR_VERSION);
    assert.equal(saved.judgments[0].requirementState, "not_satisfied");
    assert.equal(saved.judgments[0].applicabilityState, "satisfied");
    assert.equal(saved.judgments[0].applicabilityEvidence[0].quote, quote);
    assert.equal(saved.judgments[0].evidence[0].variable, "age");
  }
  await q("UPDATE evimed_vcr.language_judgments SET withdrawn = '{}'::jsonb WHERE id = $1", [candidateAnswer.id]);
  assert.deepEqual(await trials.latestLanguageJudgments({ studyId, candidateTrialId, subjectKey, visibleBy: asOf }), {});
  assert.deepEqual((await trials.languageAnswersForTrials(studyId, subjectKey, [candidateTrialId], new Map([[candidateTrialId, registry.criteria]]))).get(candidateTrialId), new Set());
});

test("a protocol refuses to reuse a persisted answer across conflicting criteria, and an old candidate trial reads such an answer as none", options, async () => {
  const studyId = await seedStudy();
  const criterionKey = "shared";
  const requirements = [
    { ...AGE, requirement: { op: "language", key: criterionKey, text: "Prior transplant?" } },
    { ...BRAIN, applicability: { op: "language", key: criterionKey, text: "Has HIV?" } },
  ];
  const protocol = await matching.saveProtocolVersion({ studyId, userId: USER, criteria: requirements });
  const registry = await seedCandidateTrial(trials, { studyId, userId: USER, trial: trial("NCT05000098"), criteria: requirements });
  const candidateTrialId = registry.trial.id;
  const subjectKey = "P-legacy-collision";
  const input = { studyId, userId: USER, subjectKey, criterionKey, state: "satisfied", evidence: [] };
  for (const [protocolId, trialId, criteria] of [[protocol.id, null, protocol.criteria], [null, candidateTrialId, registry.criteria]]) {
    await q(`INSERT INTO evimed_vcr.language_judgments (id,study_id,user_id,subject_key,criterion_key,state,protocol_version_id,candidate_trial_id,criterion_hash)
      VALUES ($1,$2,$3,$4,$5,'satisfied',$6,$7,$8)`,
    [vcrId("judgment"), studyId, USER, subjectKey, criterionKey, protocolId, trialId, languageCriterionHash(/** @type {any[]} */ (criteria), criterionKey)]);
  }
  await assert.rejects(matching.saveLanguageJudgment({ ...input, protocolVersionId: protocol.id }), { code: "vcr_criterion_malformed" });
  assert.equal((await matching.latestLanguageJudgments({ studyId, protocolVersionId: protocol.id })).get(subjectKey), undefined);
  assert.deepEqual(await trials.latestLanguageJudgments({ studyId, candidateTrialId, subjectKey }), {});
  assert.deepEqual((await trials.languageAnswersForTrials(studyId, subjectKey, [candidateTrialId], new Map([[candidateTrialId, registry.criteria]]))).get(candidateTrialId), new Set());
});

test("persisted scheduler honors each axis date while respecting inapplicability", options, async () => {
  const studyId = await seedStudy();
  const requirement = { op: "elapsed_since", variable: "treatment", days: 28 };
  const protocol = await matching.saveProtocolVersion({ studyId, userId: USER, criteria: [
    { ...AGE, requirement, applicability: { op: "present", variable: "subgroup" } },
    { ...AGE, requirement, applicability: { ...requirement, days: 14 } },
  ] });
  const [unknownPremise, pendingPremise] = protocol.criteria;
  const facts = [{ id: "treatment", variable: "treatment", occurredAt: "2026-09-20", extractedBy: "structured" }];
  const asOf = "2026-09-28T00:00:00Z";
  const save = (subjectKey, criteria, inputs = facts) => matching.saveAssessment({ userId: USER,
    assessment: assessSubject({ studyId, protocolVersionId: protocol.id, subjectKey, asOf, criteria, facts: inputs }) });
  await save("P-requirement-date", [unknownPremise]);
  await save("P-premise-date", [pendingPremise]);
  await save("P-inapplicable", [unknownPremise], [...facts, { id: "negative", variable: "subgroup", polarity: "negated", extractedBy: "structured" }]);
  assert.deepEqual(await matching.dueRecheckSubjects({ studyId, now: new Date("2026-10-03") }), []);
  const first = await matching.dueRecheckSubjects({ studyId, now: new Date("2026-10-04") });
  assert.deepEqual(first.map(row => [row.subjectKey, new Date(row.due).toISOString()]), [["P-premise-date", "2026-10-04T00:00:00.000Z"]]);
  const both = await matching.dueRecheckSubjects({ studyId, now: new Date("2026-10-18") });
  assert.deepEqual(both.map(row => [row.subjectKey, new Date(row.due).toISOString()]),
    [["P-premise-date", "2026-10-04T00:00:00.000Z"], ["P-requirement-date", "2026-10-18T00:00:00.000Z"]]);
});

test("a trial belongs to its study: another study neither reads it nor holds the same registry id as the same row", options, async () => {
  const mine = await seedStudy();
  const theirs = await seedStudy();
  const saved = await seedCandidateTrial(trials, { studyId: mine, userId: USER, trial: trial("NCT05000021"), criteria: [AGE] });
  assert.equal(await trials.getCandidateTrial({ studyId: theirs, id: saved.trial.id }), null);
  assert.equal(await trials.getCandidateTrial({ studyId: theirs, registry: "clinicaltrials.gov", registryId: "NCT05000021" }), null);
  const other = await seedCandidateTrial(trials, { studyId: theirs, userId: USER, trial: trial("NCT05000021"), criteria: [AGE] });
  assert.notEqual(other.trial.id, saved.trial.id);
});

test("deleting the study takes its candidate trials, their criteria and assessments with it", options, async () => {
  const studyId = await seedStudy();
  const saved = await seedCandidateTrial(trials, { studyId, userId: USER, trial: trial("NCT05000041"), criteria: [AGE, BRAIN] });
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.candidate_trial_criteria WHERE candidate_trial_id = $1", [saved.trial.id]))[0].n, 2);
  await database.transaction((client) => deleteVcrStudyRows(client, studyId));
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.candidate_trials WHERE study_id = $1", [studyId]))[0].n, 0);
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.candidate_trial_criteria WHERE candidate_trial_id = $1", [saved.trial.id]))[0].n, 0);
});
