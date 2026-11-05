// 「给患者找试验」 evaluated and ranked on a real PostgreSQL: the platform judges one patient against each candidate trial
// with the evaluator the other direction uses, stores the verdicts with what they were made from, replaces the ones a changed
// criteria set made wrong, and lists the trials — the study's own protocol among them — in the order the counts say.
// Skipped when OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrCandidateTrialStore } from "../src/vcrCandidateTrialStore.mjs";
import { VcrMatchStore } from "../src/vcrMatchStore.mjs";
import { assessSubject } from "../src/vcrMatching.mjs";
import { createPatientTrials } from "../src/vcrPatientTrials.mjs";
import { VcrStoreBase, vcrId } from "../src/vcrStoreBase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { seedCandidateLanguage, seedCandidateTrial, seedWrittenTrial } from "./helpers/vcrCandidateSeed.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {any} */
let database = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {VcrCandidateTrialStore} */
let candidates;
/** @type {VcrMatchStore} */
let matching;

const NOW = new Date("2026-10-10T08:00:00.000Z");
const USER = "u_eval";
const HASH = "d".repeat(64);

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcreval");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  await new VcrStoreBase({ database }).ready();
  candidates = new VcrCandidateTrialStore({ database });
  matching = new VcrMatchStore({ database });
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

/** @param {string} sql @param {unknown[]} [values] */
const q = async (sql, values = []) => (await database.query(sql, values)).rows;

/** The seam under test, over the real stores. @param {Record<string, any>} [parts] */
function seam(parts = {}) {
  return createPatientTrials({ candidateStore: candidates, matchStore: matching, now: () => NOW, ...parts });
}

async function seedStudy() {
  const id = vcrId("study");
  await q(`INSERT INTO evimed_vcr.studies (id, user_id, project_id, name, question, data_tier, intended_use)
    VALUES ($1, $2, $3, 'EV-201 二线 NSCLC', '给患者找试验', 'T1', 'exploratory')`, [id, USER, `prj_${id}`]);
  return { id, userId: USER, projectId: `prj_${id}`, dataTier: "T1" };
}

/** A fact a code path read for a patient (no document to re-read). @param {any} study @param {string} subjectKey @param {string} variable @param {any} value @param {Record<string, any>} [extra] */
const fact = (study, subjectKey, variable, value, extra = {}) => matching.saveFact({ studyId: study.id, userId: USER, fact: {
  subjectKey, variable, value, unit: null, polarity: "affirmed", occurredAt: "2026-09-10T00:00:00.000Z", recordedAt: null, visibleAt: "2026-09-10T00:00:00.000Z",
  surface: "", source: null, extractedBy: "code", ...extra } });

const trialOf = (registryId, extra = {}) => ({
  registry: "clinicaltrials.gov", registryId, title: `Trial ${registryId}`, phase: "PHASE2", status: "RECRUITING", conditions: ["NSCLC"],
  locations: { total: 1, countries: ["China"], sites: [] }, url: `https://clinicaltrials.gov/study/${registryId}`, recordHash: HASH,
  retrievedAt: "2026-10-10T07:00:00.000Z", eligibilityText: [AGE_18, AGE_70, ECOG, NO_BRAIN, EGFR, CONSENT].map(item => item.sourceText).join("\n"), ...extra,
});
const criterion = (kind, criterionType, sourceText, requirement) => ({ kind, criterionType, sourceText, requirement, applicability: null, sourceLocator: {}, evidenceNeeded: [], reviewState: "ai_set" });
const AGE_18 = criterion("inclusion", "demographic", "Age >= 18", { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" });
const AGE_70 = criterion("inclusion", "demographic", "Age >= 70", { op: "compare", variable: "age", comparator: "gte", value: 70, unit: "year" });
const ECOG = criterion("inclusion", "performance_status", "ECOG 0-1", { op: "compare", variable: "ecog", comparator: "lte", value: 1 });
const NO_BRAIN = criterion("exclusion", "comorbidity", "Active brain metastases", { op: "absent", variable: "active_brain_metastasis" });
const EGFR = criterion("inclusion", "biomarker", "EGFR mutation", { op: "present", variable: "egfr_mutation" });
const CONSENT = criterion("inclusion", "consent_capacity", "Able to sign consent", { op: "language", text: "Able to sign consent", key: "consent" });

test("a changed source snapshot cannot inherit an old parse or assessment as the current one, and does not delete it", options, async () => {
  const study = await seedStudy(); await seedPatient(study);
  const trials = seam();
  const trial = trialOf("NCT06000990");
  const written = await seedWrittenTrial(trials, candidates, study, { trial, criteria: [AGE_18], subjectKeys: ["P-1"] });
  const oldAssessment = written.evaluation.evaluated[0].assessmentId;
  const newer = { ...trial, recordHash: "e".repeat(64) };
  const updated = await seedCandidateTrial(candidates, { studyId: study.id, userId: USER, trial: newer, criteria: [AGE_18] });
  assert.equal(updated.criteriaChanged, true, "identical expressions over a new source still require reassessment");
  assert.deepEqual(updated.reassess, ["P-1"]);
  const kept = await candidates.getAssessment(oldAssessment, study.id);
  assert.ok(kept, "the verdict made of the earlier source is still readable");
  assert.ok(kept.supersededAt, "and says it is an earlier one");
  assert.equal((await candidates.latestAssessments({ studyId: study.id, subjectKey: "P-1" })).size, 0, "it is no longer the current verdict, so the patient reads as not yet judged against the new source");
});

test("absent registry eligibility and invented criteria remain unknown despite compatible patient facts", options, async () => {
  const study = await seedStudy(); await seedPatient(study);
  const trials = seam();
  const missing = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000991", { registry: "chictr", eligibilityText: "" }), criteria: [AGE_18], subjectKeys: ["P-1"] });
  assert.equal(missing.evaluation.evaluated[0].summary, "insufficient_evidence");
  const full = await candidates.getAssessment(missing.evaluation.evaluated[0].assessmentId, study.id);
  assert.equal(full.judgments[0].state, "unknown");
  assert.equal(full.evidenceGaps[0].reason, "criterion_source_unavailable");
  const invented = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000992", { eligibilityText: "ECOG 0-1" }), criteria: [AGE_18], subjectKeys: ["P-1"] });
  assert.equal(invented.evaluation.evaluated[0].summary, "insufficient_evidence");
  const read = await trials.runtimeRead(study, { id: missing.trial.id });
  assert.equal(read.trials[0].eligibilityCoverage.status, "unavailable");
  assert.equal(read.trials[0].retrievedAt, "2026-10-10T07:00:00.000Z");
});

test("a record with no original wording makes every criterion unknown for 缺登记原文 — whatever the patient's facts say — and the read-back says so (M6)", options, async () => {
  const study = await seedStudy(); await seedPatient(study);
  // ChiCTR through the evidence API is a listing: title, status, sample size — and no eligibility text, so nothing a criterion could quote.
  await fact(study, "P-1", "egfr_mutation", true);
  const trials = seam();
  const written = await seedWrittenTrial(trials, candidates, study, {
    trial: trialOf("ChiCTR2400000001", { registry: "chictr", eligibilityText: "", status: "招募中" }),
    // Age 63 satisfies the first; the brain-metastasis exclusion is explicitly negated; the next is a plain mismatch (63 < 70); and the
    // EGFR fact is there: with the wording, every one of these would be decided.
    criteria: [AGE_18, NO_BRAIN, AGE_70, EGFR], subjectKeys: ["P-1"],
  });
  const verdict = written.evaluation.evaluated[0];
  assert.equal(verdict.summary, "insufficient_evidence");
  assert.deepEqual([verdict.counts.satisfied, verdict.counts.not_satisfied, verdict.counts.unknown], [0, 0, 4], "never satisfied, never not satisfied");
  const detail = await trials.detail(study, { subjectKey: "P-1", id: written.trial.id });
  assert.ok(detail.judgments.every((judgment) => judgment.state === "unknown" && judgment.decidedBy === "code" && judgment.evidence.length === 0));

  const read = await trials.runtimeRead(study, { subjectKey: "P-1" });
  const [row] = read.ranking;
  assert.deepEqual(row.decided, { decided: 0, applicable: 4, percent: 0 }, "unknowns stay in the denominator");
  assert.deepEqual(row.evidenceGaps.map((gap) => [gap.reason, gap.label]), Array(4).fill(["criterion_source_unavailable", "缺登记原文"]), "one gap per criterion: each is missing its own wording");
  assert.deepEqual(row.undecided.map((entry) => [entry.ordinal, entry.reason, entry.label]), [1, 2, 3, 4].map((ordinal) => [ordinal, "criterion_source_unavailable", "缺登记原文"]));
  assert.equal(row.undecided[0].text, "Age >= 18");
  assert.equal(row.statusAsOf, "2026-10-10T07:00:00.000Z");

  const one = await trials.runtimeRead(study, { id: written.trial.id, subjectKey: "P-1" });
  assert.equal(one.trials[0].eligibilityCoverage.status, "unavailable");
  assert.match(one.trials[0].eligibilityCoverage.note, /缺登记原文/);
  assert.ok(one.assessment.judgments.every((judgment) => judgment.missing[0]?.label === "缺登记原文"), "each criterion of the read-back says why it is not decided");
});

test("the list puts a well-decided trial above one with few parsed criteria, says how much of each is decided, and keeps the unknowns in the count (M5)", options, async () => {
  const study = await seedStudy(); await seedPatient(study);
  const trials = seam();
  // Thin: one parsed criterion the patient's chart says nothing about. Fewer open (1) than the other trial's two, which used to win.
  await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000101", { title: "Thin" }), criteria: [EGFR], subjectKeys: ["P-1"] });
  await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000102", { title: "Well decided" }), criteria: [AGE_18, ECOG, NO_BRAIN, EGFR, CONSENT], subjectKeys: ["P-1"] });
  const read = await trials.runtimeRead(study, { subjectKey: "P-1" });
  assert.deepEqual(read.ranking.map((row) => [row.registryId, row.decided.decided, row.decided.applicable, row.decided.percent]), [
    ["NCT06000102", 3, 5, 60],
    ["NCT06000101", 0, 1, 0],
  ]);
  assert.equal(read.ranking[0].ranking.score, 0.6);
  assert.equal(read.ranking[0].ranking.unknown, 2);
  assert.deepEqual(read.ranking[0].undecided.map((entry) => entry.text), ["EGFR mutation", "Able to sign consent"], "what is still to settle is named, in the trial's own words");
  assert.ok(read.ranking[0].undecided.every((entry) => entry.reason && entry.label), "each with the reason it is not decided");
  assert.equal(read.ranking[0].statusAsOf, "2026-10-10T07:00:00.000Z", "the registry's word is dated by the day its record was read");
});

async function seedPatient(study, subjectKey = "P-1") {
  await fact(study, subjectKey, "age", 63, { unit: "year" });
  await fact(study, subjectKey, "ecog", 1);
  await fact(study, subjectKey, "active_brain_metastasis", false, { polarity: "negated" });
}

test("a patient is judged against every candidate trial by the evaluator the other direction uses, and the trials come back in order", options, async () => {
  const study = await seedStudy();
  await seedPatient(study);
  const trials = seam();
  const met = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000001"), criteria: [AGE_18, ECOG, NO_BRAIN], subjectKeys: ["P-1"] });
  assert.deepEqual(met.evaluation.evaluated.map((row) => [row.subjectKey, row.registryId, row.summary]), [["P-1", "NCT06000001", "eligible"]]);
  assert.equal(met.evaluation.evaluated[0].counts.satisfied, 3);
  await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000002", { status: "NOT_YET_RECRUITING" }), criteria: [AGE_18, EGFR], subjectKeys: ["P-1"] });
  await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000003", { status: "RECRUITING" }), criteria: [AGE_18, EGFR], subjectKeys: ["P-1"] });
  await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000004"), criteria: [AGE_70, ECOG], subjectKeys: ["P-1"] });

  const listed = await trials.ranked(study, { subjectKey: "P-1" });
  assert.deepEqual(listed.map((row) => [row.rank, row.registryId, row.summary]), [
    [1, "NCT06000001", "eligible"],
    [2, "NCT06000003", "insufficient_evidence"], // one criterion to settle, and recruiting
    [3, "NCT06000002", "insufficient_evidence"], // the same count, and not yet recruiting
    [4, "NCT06000004", "ineligible"],
  ]);
  assert.deepEqual(listed.map((row) => row.kind), ["registry", "registry", "registry", "registry"]);
  assert.equal(listed[0].ranking.exclusionSatisfied, 1);
  assert.equal(listed[0].ranking.score, 1);
  assert.equal(listed[1].ranking.unknown, 1);
  assert.equal(listed[1].ranking.score, 0.5);
  assert.equal(listed[3].ranking.decisiveFailures, 1);
  assert.equal(listed[1].counts.unknown, 1);
  assert.deepEqual(listed[1].evidenceGaps.map((gap) => [gap.variable, gap.reason]), [["egfr_mutation", "not_recorded"]]);
  assert.equal(listed[0].asOf, NOW.toISOString());
  assert.match(listed[0].assessmentId, /^cta_[a-f0-9]{22}$/);
});

test("the verdicts are stored with what they were made from, and a page reads them without the platform's private references", options, async () => {
  const study = await seedStudy();
  await seedPatient(study);
  const trials = seam();
  const written = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000011"), criteria: [AGE_18, NO_BRAIN], subjectKeys: ["P-1"] });
  const [row] = await q("SELECT * FROM evimed_vcr.candidate_trial_assessments WHERE candidate_trial_id = $1", [written.trial.id]);
  assert.equal(row.subject_key, "P-1");
  assert.equal(row.summary, "eligible");
  assert.equal(new Date(row.as_of).toISOString(), NOW.toISOString());
  assert.equal(row.provenance.direction, "patient_to_trial");
  assert.equal(row.provenance.candidateTrialId, written.trial.id);
  assert.equal(row.provenance.recordHash, HASH);
  assert.equal(row.provenance.vocabularyVersion, "evimed-internal-sex-1");
  assert.equal(Object.keys(row.provenance.inputFactHashes).length, 3, "every fact of the patient the evaluation could read is referenced by id and hash, as in the other direction");
  assert.equal(Object.keys(row.provenance.inputCriterionHashes).length, 2);
  assert.match(row.input_snapshot_id, /^[a-f0-9]{64}$/);
  const judgments = await q("SELECT state, applicable, decided_by FROM evimed_vcr.candidate_trial_judgments WHERE assessment_id = $1 ORDER BY created_at, id", [row.id]);
  assert.equal(judgments.length, 2);
  assert.ok(judgments.every((judgment) => judgment.state === "satisfied" && judgment.decided_by === "code"));
  const read = await candidates.getAssessment(row.id, study.id);
  assert.equal(read.judgments.length, 2);
  assert.equal(read.provenance.inputFactIds, undefined, "the references a verdict was rebuilt from are the platform's own");
  assert.equal(read.provenance.candidateTrialId, written.trial.id);
  assert.equal(await candidates.getAssessment(row.id, "std_other"), null, "an assessment of another study is not found");
});

test("a patient the facts say nothing about is unknown on every criterion: the platform never fills a verdict in", options, async () => {
  const study = await seedStudy();
  await fact(study, "P-2", "sex", "female");
  const trials = seam();
  const written = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000021"), criteria: [AGE_18, ECOG, NO_BRAIN], subjectKeys: ["P-2"] });
  assert.equal(written.evaluation.evaluated[0].summary, "insufficient_evidence");
  assert.deepEqual([written.evaluation.evaluated[0].counts.unknown, written.evaluation.evaluated[0].counts.satisfied], [3, 0]);
});

test("a trial written again with different criteria keeps the verdicts about the old ones as earlier conclusions and makes them again for the patients who had one", options, async () => {
  const study = await seedStudy();
  await seedPatient(study, "P-1");
  await seedPatient(study, "P-3");
  const trials = seam();
  await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000031"), criteria: [AGE_18, ECOG], subjectKeys: ["P-1", "P-3"] });
  const before = await trials.ranked(study, { subjectKey: "P-3" });
  assert.equal(before[0].summary, "eligible");
  const again = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000031"), criteria: [AGE_18, ECOG, EGFR], subjectKeys: ["P-1"] });
  assert.equal(again.criteriaChanged, true);
  assert.deepEqual(again.evaluation.evaluated.map((row) => row.subjectKey).sort(), ["P-1", "P-3"], "a patient who is not named but had a verdict is judged again");
  const afterOne = await trials.ranked(study, { subjectKey: "P-1" });
  const afterThree = await trials.ranked(study, { subjectKey: "P-3" });
  assert.equal(afterOne[0].summary, "insufficient_evidence");
  assert.equal(afterThree[0].summary, "insufficient_evidence", "nobody is ranked by a verdict about criteria the trial no longer has");
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.candidate_trial_assessments WHERE candidate_trial_id = $1 AND superseded_at IS NULL", [again.trial.id]))[0].n, 2, "the current verdicts are the new ones");
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.candidate_trial_assessments WHERE candidate_trial_id = $1 AND superseded_at IS NOT NULL", [again.trial.id]))[0].n, 2, "and the earlier ones are kept, marked");
  // The same criteria written again are not a change: nothing is dropped, and the named patient is judged again at the new instant.
  const same = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000031"), criteria: [AGE_18, ECOG, EGFR], subjectKeys: ["P-1"] });
  assert.equal(same.criteriaChanged, false);
  assert.deepEqual(same.evaluation.evaluated.map((row) => row.subjectKey), ["P-1"]);
});

test("a patient whose new evaluation cannot be made keeps the earlier conclusion in the list, marked, and is owed a new one", options, async () => {
  const study = await seedStudy();
  await seedPatient(study, "P-1");
  const trials = seam();
  const first = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000032"), criteria: [AGE_18, ECOG], subjectKeys: ["P-1"] });
  assert.equal((await trials.ranked(study, { subjectKey: "P-1" }))[0].summary, "eligible");
  // The criteria are rewritten and no patient is judged against them (nobody is named, and the writer is told not to look back).
  await seedCandidateTrial(candidates, { studyId: study.id, userId: USER, trial: trialOf("NCT06000032"), criteria: [AGE_18, ECOG, EGFR] });
  const listed = await trials.ranked(study, { subjectKey: "P-1" });
  assert.equal(listed.length, 1, "the earlier conclusion is still in the patient's list");
  assert.equal(listed[0].summary, "eligible", "as it was concluded");
  assert.equal(listed[0].assessmentId, first.evaluation.evaluated[0].assessmentId);
  assert.deepEqual([listed[0].stale?.reason, Boolean(listed[0].supersededAt)], ["criteria_rewritten", true], "marked as an earlier one");
  assert.deepEqual((await trials.unjudged(study, { subjectKey: "P-1" })).map((entry) => entry.registryId), ["NCT06000032"], "and the trial is owed a new judgment");
  // The next evaluation replaces it as the current one.
  await trials.evaluate(study, { subjectKeys: ["P-1"], trialIds: [first.trial.id] });
  const renewed = await trials.ranked(study, { subjectKey: "P-1" });
  assert.equal(renewed[0].summary, "insufficient_evidence");
  assert.equal(renewed[0].stale, undefined);
  assert.deepEqual(await trials.unjudged(study, { subjectKey: "P-1" }), []);
});

test("naming only patients judges them against every trial the study holds, and one trial that cannot be judged does not stop the rest", options, async () => {
  const study = await seedStudy();
  await seedPatient(study);
  const trials = seam();
  const first = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000041"), criteria: [AGE_18], subjectKeys: [] });
  assert.equal(first.evaluation.evaluated.length, 0, "a trial written for nobody is judged for nobody");
  await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000042"), criteria: [AGE_70], subjectKeys: [] });
  const all = await trials.evaluate(study, { subjectKeys: ["P-1"] });
  assert.deepEqual(all.evaluated.map((row) => [row.registryId, row.summary]).sort(), [["NCT06000041", "eligible"], ["NCT06000042", "ineligible"]]);

  // A verdict that cannot be stored is that pair's, named; the other pair is judged and stored as it would have been.
  const broken = createPatientTrials({
    candidateStore: Object.assign(Object.create(candidates), {
      saveAssessment: async (/** @type {any} */ input) => {
        if (input.assessment.candidateTrialId === first.trial.id) throw Object.assign(new Error("disk"), { code: "XX000" });
        return candidates.saveAssessment(input);
      },
    }),
    matchStore: matching, now: () => new Date(NOW.getTime() + 60_000),
  });
  const partial = await broken.evaluate(study, { subjectKeys: ["P-1"] });
  assert.deepEqual(partial.evaluated.map((row) => row.registryId), ["NCT06000042"]);
  assert.deepEqual(partial.unavailable.map((row) => [row.registryId, row.subjectKey, row.code]), [["NCT06000041", "P-1", "XX000"]]);
  assert.equal(broken.counters.evaluationFailed, 1);
});

test("the study's own protocol joins the list once it has judged this patient, version by version, and not before", options, async () => {
  const study = await seedStudy();
  await seedPatient(study);
  const trials = seam();
  await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000051"), criteria: [AGE_18, ECOG], subjectKeys: ["P-1"] });
  // No protocol yet: only the registry trial.
  assert.deepEqual((await trials.ranked(study, { subjectKey: "P-1" })).map((row) => row.kind), ["registry"]);

  const v1 = await matching.saveProtocolVersion({ studyId: study.id, userId: USER, title: "EV-201 方案 v1", criteria: [AGE_18, ECOG, EGFR] });
  const v2 = await matching.saveProtocolVersion({ studyId: study.id, userId: USER, title: "EV-201 方案 v2", criteria: [AGE_18, ECOG] });
  // A protocol that has not judged this patient is not a result about them: the list is still the registry trial alone.
  assert.deepEqual((await trials.ranked(study, { subjectKey: "P-1" })).map((row) => row.kind), ["registry"]);
  const ownCriteria = (await matching.listCriteria({ studyId: study.id, protocolVersionId: v2.id }));
  const facts = await matching.listFacts({ studyId: study.id, subjectKey: "P-1" });
  await matching.saveAssessment({ userId: USER, assessment: assessSubject({
    studyId: study.id, protocolVersionId: v2.id, subjectKey: "P-1", direction: "patient_to_trial", criteria: ownCriteria, facts, asOf: NOW }) });
  const listed = await trials.ranked(study, { subjectKey: "P-1" });
  assert.deepEqual(listed.map((row) => [row.kind, row.title, row.summary]), [
    ["registry", "Trial NCT06000051", "eligible"],
    ["protocol", "EV-201 方案 v2", "eligible"],
  ], "the study's own trial is a candidate for its patient too, and on a tie the registry's recruiting trial comes first");
  assert.equal(listed[1].ranking.version, "criterion-proportion-v1");
  assert.equal(listed[1].ranking.score, 1);
  assert.equal(listed[1].ranking.applicable, 2);
  assert.equal(listed[1].registryId, null);
  assert.equal(listed[1].url, "");
  assert.ok(!listed.some((row) => row.id === v1.id), "an earlier version nobody judged this patient against is not a second copy of the trial");
  assert.deepEqual(await trials.unjudged(study, { subjectKey: "P-1" }), [], "the registry trial has judged this patient");

  // Judged against the earlier version too, it is listed as well.
  await matching.saveAssessment({ userId: USER, assessment: assessSubject({
    studyId: study.id, protocolVersionId: v1.id, subjectKey: "P-1", direction: "patient_to_trial",
    criteria: await matching.listCriteria({ studyId: study.id, protocolVersionId: v1.id }), facts, asOf: NOW }) });
  assert.equal((await trials.ranked(study, { subjectKey: "P-1" })).filter((row) => row.kind === "protocol").length, 2);
  // And the study's own matching knows nothing of the candidate: its protocols and its tallies are what they were.
  assert.deepEqual((await matching.protocols(study.id)).map((row) => row.title), ["EV-201 方案 v2", "EV-201 方案 v1"]);
  const tallies = await matching.assessmentTallies(study.id);
  assert.equal(Object.values(tallies).reduce((sum, count) => sum + count, 0), 1, "one patient judged against the study's own protocol; the registry trial's verdict is not in its funnel");
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.matching_assessments WHERE study_id = $1", [study.id]))[0].n, 2);
});

test("an answer to a trial's language criterion is bound to that trial, anchored in the patient's own words, and judges the pair again", options, async () => {
  const study = await seedStudy();
  await seedPatient(study);
  const chart = "患者本人可理解研究内容并签署知情同意。";
  const documents = { async read(_study, { documentId }) { return documentId === "doc_1" ? { id: "doc_1", text: chart, visibleAt: "2026-09-01T00:00:00.000Z" } : null; } };
  const trials = seam({ documents });
  const written = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000061"), criteria: [AGE_18, CONSENT], subjectKeys: ["P-1"] });
  assert.equal(written.evaluation.evaluated[0].summary, "insufficient_evidence", "a criterion only language can decide is unknown until it is answered");

  const saved = await seedCandidateLanguage(candidates, {
    studyId: study.id, userId: USER, subjectKey: "P-1", candidateTrialId: written.trial.id, criterionKey: "consent", state: "satisfied",
    evidence: [{ documentId: "doc_1", start: 0, end: chart.length, quote: chart, visibleAt: "2026-09-01T00:00:00.000Z" }],
    provenance: { schema: 1, status: "unknown", runId: null },
  });
  assert.match(saved.id, /^jdg_/);
  const [stored] = await q("SELECT protocol_version_id, candidate_trial_id FROM evimed_vcr.language_judgments WHERE id = $1", [saved.id]);
  assert.deepEqual([stored.protocol_version_id, stored.candidate_trial_id], [null, written.trial.id]);
  const judged = await trials.evaluate(study, { subjectKeys: ["P-1"], trialIds: [written.trial.id] });
  assert.equal(judged.evaluated[0].summary, "eligible");
  const detail = await trials.detail(study, { subjectKey: "P-1", id: written.trial.id });
  const consent = detail.judgments.find((judgment) => judgment.decidedBy === "model");
  assert.equal(consent.state, "satisfied");
  assert.equal(consent.evidence[0].quote, chart);

  // An answer whose quotation is not in the patient's chart is not evidence: the criterion falls back to unknown.
  const forged = await seedCandidateLanguage(candidates, {
    studyId: study.id, userId: USER, subjectKey: "P-1", candidateTrialId: written.trial.id, criterionKey: "consent", state: "satisfied",
    evidence: [{ documentId: "doc_1", start: 0, end: 10, quote: "患者拒绝签署知情同意", visibleAt: "2026-09-01T00:00:00.000Z" }], provenance: null,
  });
  assert.ok(forged.id);
  assert.equal((await trials.evaluate(study, { subjectKeys: ["P-1"], trialIds: [written.trial.id] })).evaluated[0].summary, "insufficient_evidence");

  // An answer for another trial is not this trial's.
  const other = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000062"), criteria: [AGE_18, CONSENT], subjectKeys: ["P-1"] });
  assert.equal(other.evaluation.evaluated[0].summary, "insufficient_evidence", "the answer about one trial does not answer another's criterion of the same name");
});

test("a table of the study's patients is read for the facts a trial asks about, once, and a table that cannot be read leaves the other sources as they were", options, async () => {
  const study = await seedStudy();
  await fact(study, "P-9", "ecog", 1);
  let reads = 0;
  const table = {
    available: true, snapshotId: "snp_table", sha256: "e".repeat(64), header: ["USUBJID", "AGE", "EGFR"],
    rows: [["P-9", "55", "L858R"], ["P-8", "30", ""]],
    columns: [{ name: "AGE", concept: "age", type: "integer", unit: "year" }, { name: "EGFR", concept: "egfr_mutation", type: "string" }], withheld: [],
    // What the dataset recorded about the column's codes: L858R is the mutation being there. A filled cell is a value, and is no answer until a meaning reads it.
    meaning: { columns: { EGFR: { valueMap: { values: { L858R: "present" }, measurement: false } } } },
  };
  const trials = seam({ subjectTable: { async read() { reads += 1; return table; } } });
  const written = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000071"), criteria: [AGE_18, ECOG, EGFR], subjectKeys: ["P-9"] });
  assert.equal(written.evaluation.evaluated[0].summary, "eligible", "age and the biomarker from the table, ECOG from the fact");
  assert.equal(reads, 1);
  const detail = await trials.detail(study, { subjectKey: "P-9", id: written.trial.id });
  const age = detail.judgments.find((judgment) => judgment.criterionId === written.criteria[0].id);
  assert.match(age.evidence[0].quote, /age/, "the evidence names the column");
  assert.ok(!JSON.stringify(age.evidence).includes("55"), "and not the value in it");

  // The same table with no recorded meaning: the cell is filled and its code is unread, so the biomarker is unknown, never taken for present.
  const unreadCodes = seam({ subjectTable: { async read() { return { ...table, meaning: null }; } } });
  const codes = await unreadCodes.evaluate(study, { subjectKeys: ["P-9"], trialIds: [written.trial.id] });
  assert.equal(codes.evaluated[0].summary, "insufficient_evidence");
  // and when the meaning could not be proposed the answer says so, as a note beside the rest
  const noted = seam({ subjectTable: { async read() { return { ...table, meaning: null, meaningStatus: { status: "not_proposed", code: "upstream_unavailable" } }; } } });
  assert.deepEqual((await noted.evaluate(study, { subjectKeys: ["P-9"], trialIds: [written.trial.id] })).notes, [{ code: "vcr_table_meaning_not_proposed" }]);

  const refused = seam({ subjectTable: { async read() { throw Object.assign(new Error("no grant"), { code: "vcr_access_denied" }); } } });
  const unread = await refused.evaluate(study, { subjectKeys: ["P-9"] });
  assert.equal(unread.evaluated[0].summary, "insufficient_evidence", "the table's facts are missing, and the criteria that needed them are unknown");
  assert.deepEqual(unread.notes, [{ code: "vcr_access_denied" }]);
});

test("a candidate trial that has not judged this patient is named as owed, not listed as a result about them", options, async () => {
  const study = await seedStudy();
  await seedPatient(study, "P-1");
  await fact(study, "P-5", "age", 40, { unit: "year" });
  const trials = seam();
  const first = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000081"), criteria: [AGE_18], subjectKeys: ["P-1"] });
  await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000082"), criteria: [AGE_70], subjectKeys: ["P-1"] });
  assert.deepEqual((await trials.ranked(study, { subjectKey: "P-5" })), [], "nothing has been judged for P-5");
  assert.deepEqual((await trials.unjudged(study, { subjectKey: "P-5" })).map((row) => row.registryId).sort(), ["NCT06000081", "NCT06000082"]);
  const read = await trials.runtimeRead(study, { subjectKey: "P-5" });
  assert.deepEqual([read.ranking.length, read.unjudged.length], [0, 2], "a run is told what it still owes this patient");
  // A trial with no criteria cannot judge anybody, so it is owed nothing.
  await candidateStore_clear(first.trial.id);
  assert.deepEqual((await trials.unjudged(study, { subjectKey: "P-5" })).map((row) => row.registryId), ["NCT06000082"]);
  // Judging it makes it a result.
  await trials.evaluate(study, { subjectKeys: ["P-5"] });
  assert.deepEqual((await trials.ranked(study, { subjectKey: "P-5" })).map((row) => row.registryId), ["NCT06000082"]);
  assert.deepEqual(await trials.unjudged(study, { subjectKey: "P-5" }), []);
});

/** @param {string} trialId */
async function candidateStore_clear(trialId) {
  await q("DELETE FROM evimed_vcr.candidate_trial_criteria WHERE candidate_trial_id = $1", [trialId]);
}

test("stale assessments cannot be written after a trial source changes", options, async () => {
  const study = await seedStudy();
  const trials = seam();
  const saved = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000991"), criteria: [AGE_18], subjectKeys: [] });
  const old = saved.trial;
  await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000991", { recordHash: "e".repeat(64) }), criteria: [AGE_18], subjectKeys: [] });
  await assert.rejects(candidates.saveAssessment({ userId: USER, expectedRecordHash: old.recordHash, expectedCriteriaHash: old.criteriaHash,
    assessment: { studyId: study.id, candidateTrialId: old.id, subjectKey: "P-1", asOf: NOW, summary: "eligible", judgments: [] } }), /changed during evaluation/);
  assert.equal((await candidates.latestAssessments({ studyId: study.id, subjectKey: "P-1" })).size, 0);
});

test("ranked eligibility is rebuilt from persisted judgments and missing judgments", options, async () => {
  const study = await seedStudy(); await seedPatient(study);
  const trials = seam();
  const saved = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000992"), criteria: [AGE_18, NO_BRAIN], subjectKeys: ["P-1"] });
  const assessment = (await candidates.latestAssessments({ studyId: study.id, subjectKey: "P-1" })).get(saved.trial.id);
  await q("UPDATE evimed_vcr.candidate_trial_judgments SET state='not_satisfied' WHERE assessment_id=$1 AND criterion_id=$2", [assessment.id, saved.criteria[1].id]);
  let row = (await trials.ranked(study, { subjectKey: "P-1" }))[0];
  assert.equal(row.summary, "ineligible"); assert.equal(row.storedSummary, "eligible");
  assert.equal(row.ranking.decisiveFailures, 1);
  await q("DELETE FROM evimed_vcr.candidate_trial_judgments WHERE assessment_id=$1 AND criterion_id=$2", [assessment.id, saved.criteria[1].id]);
  row = (await trials.runtimeRead(study, { subjectKey: "P-1" })).ranking[0];
  assert.equal(row.eligibility, "insufficient_evidence"); assert.equal(row.ranking.unknown, 1);
  const exact = await trials.runtimeRead(study, { subjectKey: "P-1", id: saved.trial.id });
  assert.equal(exact.assessment.summary, "insufficient_evidence");
  assert.equal(exact.assessment.criteriaCounts.unknown, 1);
  const detail = await trials.detail(study, { subjectKey: "P-1", id: saved.trial.id });
  assert.equal(detail.assessment.summary, "insufficient_evidence");
});

test("verified collection provenance survives candidate persistence and runtime reads", options, async () => {
  const study = await seedStudy(); const trials = seam();
  const collection = { id: "public-collection", revision: "revision-1", sha256: "b".repeat(64) };
  const saved = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000993", { collection }), criteria: [AGE_18], subjectKeys: [] });
  assert.deepEqual(saved.trial.collection, collection);
  const read = await trials.runtimeRead(study, { id: saved.trial.id });
  assert.deepEqual(read.trials[0].collection, collection);
});


test("ranking snapshot remains coherent across a concurrent trial refresh", options, async () => {
  const study = await seedStudy(); await seedPatient(study);
  const trials = seam();
  const original = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000994"), criteria: [AGE_18], subjectKeys: ["P-1"] });
  let release; let ready;
  const paused = new Promise(resolve => { ready = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const isolatedStore = Object.create(candidates);
  isolatedStore.transaction = operation => candidates.transaction(client => operation({ query: async (sql, args) => {
    const result = await client.query(sql, args);
    if (sql.includes("SELECT * FROM evimed_vcr.candidate_trials WHERE")) { ready(); await resume; }
    return result;
  }}));
  const read = isolatedStore.rankingSnapshot(study.id, "P-1");
  await paused;
  await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000994", { recordHash: "f".repeat(64) }), criteria: [AGE_70], subjectKeys: [] });
  release();
  const snapshot = await read;
  assert.equal(snapshot.trials[0].recordHash, original.trial.recordHash);
  assert.equal(snapshot.criteria[0].sourceText, AGE_18.sourceText);
  assert.equal(snapshot.assessments[0].summary, "eligible");
  assert.equal(snapshot.judgments[0].state, "satisfied");
});

test("exact candidate read selects one registry record and id takes precedence over conflicting registry filters", options, async () => {
  const study = await seedStudy(); await seedPatient(study);
  const trials = seam();
  const first = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000995", { registry: "clinicaltrials.gov" }), criteria: [AGE_18], subjectKeys: ["P-1"] });
  const second = await seedWrittenTrial(trials, candidates, study, { trial: trialOf("NCT06000995", { registry: "ctis" }), criteria: [AGE_70], subjectKeys: ["P-1"] });
  const byRegistry = await trials.runtimeRead(study, { subjectKey: "P-1", registryId: "NCT06000995", registry: "ctis" });
  assert.equal(byRegistry.trials[0].id, second.trial.id);
  assert.equal(byRegistry.trials[0].criteria.length, 1);
  assert.equal(byRegistry.assessment.summary, "ineligible");
  const byId = await trials.runtimeRead(study, { subjectKey: "P-1", id: first.trial.id, registryId: "NCT06000995", registry: "ctis" });
  assert.equal(byId.trials[0].id, first.trial.id);
  assert.equal(byId.trials[0].criteria[0].sourceText, AGE_18.sourceText);
  assert.equal(byId.assessment.summary, "eligible");
  const anyRegistry = await trials.runtimeRead(study, { subjectKey: "P-1", registryId: "NCT06000995" });
  assert.equal(anyRegistry.trials.length, 1);
  assert.equal(anyRegistry.trials[0].criteria.length, 1);
  assert.equal(anyRegistry.assessment.summary, anyRegistry.trials[0].id === first.trial.id ? "eligible" : "ineligible");
});
