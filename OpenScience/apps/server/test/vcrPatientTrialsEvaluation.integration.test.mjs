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
  return createPatientTrials({ candidateStore: candidates, matchStore: matching, config: { vcrCandidateTrialsMax: 20 }, now: () => NOW, ...parts });
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
  retrievedAt: "2026-10-10T07:00:00.000Z", eligibilityText: "", ...extra,
});
const criterion = (kind, criterionType, sourceText, requirement) => ({ kind, criterionType, sourceText, requirement, applicability: null, sourceLocator: {}, evidenceNeeded: [], reviewState: "ai_set" });
const AGE_18 = criterion("inclusion", "demographic", "Age >= 18", { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" });
const AGE_70 = criterion("inclusion", "demographic", "Age >= 70", { op: "compare", variable: "age", comparator: "gte", value: 70, unit: "year" });
const ECOG = criterion("inclusion", "performance_status", "ECOG 0-1", { op: "compare", variable: "ecog", comparator: "lte", value: 1 });
const NO_BRAIN = criterion("exclusion", "comorbidity", "Active brain metastases", { op: "absent", variable: "active_brain_metastasis" });
const EGFR = criterion("inclusion", "biomarker", "EGFR mutation", { op: "present", variable: "egfr_mutation" });
const CONSENT = criterion("inclusion", "consent_capacity", "Able to sign consent", { op: "language", text: "Able to sign consent", key: "consent" });

async function seedPatient(study, subjectKey = "P-1") {
  await fact(study, subjectKey, "age", 63, { unit: "year" });
  await fact(study, subjectKey, "ecog", 1);
  await fact(study, subjectKey, "active_brain_metastasis", false, { polarity: "negated" });
}

test("a patient is judged against every candidate trial by the evaluator the other direction uses, and the trials come back in order", options, async () => {
  const study = await seedStudy();
  await seedPatient(study);
  const trials = seam();
  const met = await trials.writeTrial(study, { trial: trialOf("NCT06000001"), criteria: [AGE_18, ECOG, NO_BRAIN], subjectKeys: ["P-1"] });
  assert.deepEqual(met.evaluation.evaluated.map((row) => [row.subjectKey, row.registryId, row.summary]), [["P-1", "NCT06000001", "eligible"]]);
  assert.equal(met.evaluation.evaluated[0].counts.satisfied, 3);
  await trials.writeTrial(study, { trial: trialOf("NCT06000002", { status: "NOT_YET_RECRUITING" }), criteria: [AGE_18, EGFR], subjectKeys: ["P-1"] });
  await trials.writeTrial(study, { trial: trialOf("NCT06000003", { status: "RECRUITING" }), criteria: [AGE_18, EGFR], subjectKeys: ["P-1"] });
  await trials.writeTrial(study, { trial: trialOf("NCT06000004"), criteria: [AGE_70, ECOG], subjectKeys: ["P-1"] });

  const listed = await trials.ranked(study, { subjectKey: "P-1" });
  assert.deepEqual(listed.map((row) => [row.rank, row.registryId, row.summary]), [
    [1, "NCT06000001", "eligible"],
    [2, "NCT06000003", "insufficient_evidence"], // one criterion to settle, and recruiting
    [3, "NCT06000002", "insufficient_evidence"], // the same count, and not yet recruiting
    [4, "NCT06000004", "ineligible"],
  ]);
  assert.deepEqual(listed.map((row) => row.kind), ["registry", "registry", "registry", "registry"]);
  assert.equal(listed[1].counts.unknown, 1);
  assert.deepEqual(listed[1].evidenceGaps.map((gap) => [gap.variable, gap.reason]), [["egfr_mutation", "not_recorded"]]);
  assert.equal(listed[0].asOf, NOW.toISOString());
  assert.match(listed[0].assessmentId, /^cta_[a-f0-9]{22}$/);
});

test("the verdicts are stored with what they were made from, and a page reads them without the platform's private references", options, async () => {
  const study = await seedStudy();
  await seedPatient(study);
  const trials = seam();
  const written = await trials.writeTrial(study, { trial: trialOf("NCT06000011"), criteria: [AGE_18, NO_BRAIN], subjectKeys: ["P-1"] });
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
  const written = await trials.writeTrial(study, { trial: trialOf("NCT06000021"), criteria: [AGE_18, ECOG, NO_BRAIN], subjectKeys: ["P-2"] });
  assert.equal(written.evaluation.evaluated[0].summary, "insufficient_evidence");
  assert.deepEqual([written.evaluation.evaluated[0].counts.unknown, written.evaluation.evaluated[0].counts.satisfied], [3, 0]);
});

test("a trial written again with different criteria drops the verdicts about the old ones and makes them again for the patients who had one", options, async () => {
  const study = await seedStudy();
  await seedPatient(study, "P-1");
  await seedPatient(study, "P-3");
  const trials = seam();
  await trials.writeTrial(study, { trial: trialOf("NCT06000031"), criteria: [AGE_18, ECOG], subjectKeys: ["P-1", "P-3"] });
  const before = await trials.ranked(study, { subjectKey: "P-3" });
  assert.equal(before[0].summary, "eligible");
  const again = await trials.writeTrial(study, { trial: trialOf("NCT06000031"), criteria: [AGE_18, ECOG, EGFR], subjectKeys: ["P-1"] });
  assert.equal(again.criteriaChanged, true);
  assert.deepEqual(again.evaluation.evaluated.map((row) => row.subjectKey).sort(), ["P-1", "P-3"], "a patient who is not named but had a verdict is judged again");
  const afterOne = await trials.ranked(study, { subjectKey: "P-1" });
  const afterThree = await trials.ranked(study, { subjectKey: "P-3" });
  assert.equal(afterOne[0].summary, "insufficient_evidence");
  assert.equal(afterThree[0].summary, "insufficient_evidence", "nobody is ranked by a verdict about criteria the trial no longer has");
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.candidate_trial_assessments WHERE candidate_trial_id = $1", [again.trial.id]))[0].n, 2);
  // The same criteria written again are not a change: nothing is dropped, and the named patient is judged again at the new instant.
  const same = await trials.writeTrial(study, { trial: trialOf("NCT06000031"), criteria: [AGE_18, ECOG, EGFR], subjectKeys: ["P-1"] });
  assert.equal(same.criteriaChanged, false);
  assert.deepEqual(same.evaluation.evaluated.map((row) => row.subjectKey), ["P-1"]);
});

test("naming only patients judges them against every trial the study holds, and one trial that cannot be judged does not stop the rest", options, async () => {
  const study = await seedStudy();
  await seedPatient(study);
  const trials = seam();
  const first = await trials.writeTrial(study, { trial: trialOf("NCT06000041"), criteria: [AGE_18], subjectKeys: [] });
  assert.equal(first.evaluation.evaluated.length, 0, "a trial written for nobody is judged for nobody");
  await trials.writeTrial(study, { trial: trialOf("NCT06000042"), criteria: [AGE_70], subjectKeys: [] });
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
    matchStore: matching, config: { vcrCandidateTrialsMax: 20 }, now: () => new Date(NOW.getTime() + 60_000),
  });
  const partial = await broken.evaluate(study, { subjectKeys: ["P-1"] });
  assert.deepEqual(partial.evaluated.map((row) => row.registryId), ["NCT06000042"]);
  assert.deepEqual(partial.unavailable.map((row) => [row.registryId, row.subjectKey, row.code]), [["NCT06000041", "P-1", "XX000"]]);
  assert.equal(broken.counters.evaluationFailed, 1);
});

test("the study's own protocol joins the list: its newest version always, an older one only once it has judged this patient", options, async () => {
  const study = await seedStudy();
  await seedPatient(study);
  const trials = seam();
  await trials.writeTrial(study, { trial: trialOf("NCT06000051"), criteria: [AGE_18, ECOG], subjectKeys: ["P-1"] });
  // No protocol yet: only the registry trial.
  assert.deepEqual((await trials.ranked(study, { subjectKey: "P-1" })).map((row) => row.kind), ["registry"]);

  const v1 = await matching.saveProtocolVersion({ studyId: study.id, userId: USER, title: "EV-201 方案 v1", criteria: [AGE_18, ECOG, EGFR] });
  const v2 = await matching.saveProtocolVersion({ studyId: study.id, userId: USER, title: "EV-201 方案 v2", criteria: [AGE_18, ECOG] });
  const ownCriteria = (await matching.listCriteria({ studyId: study.id, protocolVersionId: v2.id }));
  const facts = await matching.listFacts({ studyId: study.id, subjectKey: "P-1" });
  await matching.saveAssessment({ userId: USER, assessment: assessSubject({
    studyId: study.id, protocolVersionId: v2.id, subjectKey: "P-1", direction: "patient_to_trial", criteria: ownCriteria, facts, asOf: NOW }) });
  const listed = await trials.ranked(study, { subjectKey: "P-1" });
  assert.deepEqual(listed.map((row) => [row.kind, row.title, row.summary]), [
    ["registry", "Trial NCT06000051", "eligible"],
    ["protocol", "EV-201 方案 v2", "eligible"],
  ], "the study's own trial is a candidate for its patient too, and on a tie the registry's recruiting trial comes first");
  assert.equal(listed[1].registryId, null);
  assert.equal(listed[1].url, "");
  assert.ok(!listed.some((row) => row.id === v1.id), "an earlier version nobody judged this patient against is not a second copy of the trial");

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
  const written = await trials.writeTrial(study, { trial: trialOf("NCT06000061"), criteria: [AGE_18, CONSENT], subjectKeys: ["P-1"] });
  assert.equal(written.evaluation.evaluated[0].summary, "insufficient_evidence", "a criterion only language can decide is unknown until it is answered");
  assert.deepEqual(await trials.languageKeys(study, written.trial.id), ["consent"]);
  assert.deepEqual(await trials.languageKeys(study, "ctr_not_this_study"), []);

  const saved = await trials.saveLanguageJudgment(study, {
    subjectKey: "P-1", candidateTrialId: written.trial.id, criterionKey: "consent", state: "satisfied",
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
  const forged = await trials.saveLanguageJudgment(study, {
    subjectKey: "P-1", candidateTrialId: written.trial.id, criterionKey: "consent", state: "satisfied",
    evidence: [{ documentId: "doc_1", start: 0, end: 10, quote: "患者拒绝签署知情同意", visibleAt: "2026-09-01T00:00:00.000Z" }], provenance: null,
  });
  assert.ok(forged.id);
  assert.equal((await trials.evaluate(study, { subjectKeys: ["P-1"], trialIds: [written.trial.id] })).evaluated[0].summary, "insufficient_evidence");

  // A key the trial does not have is refused, and an answer for another trial is not this trial's.
  await assert.rejects(trials.saveLanguageJudgment(study, { subjectKey: "P-1", candidateTrialId: written.trial.id, criterionKey: "nothing", state: "unknown", evidence: [] }), /language key/i);
  const other = await trials.writeTrial(study, { trial: trialOf("NCT06000062"), criteria: [AGE_18, CONSENT], subjectKeys: ["P-1"] });
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
  };
  const trials = seam({ subjectTable: { async read() { reads += 1; return table; } } });
  const written = await trials.writeTrial(study, { trial: trialOf("NCT06000071"), criteria: [AGE_18, ECOG, EGFR], subjectKeys: ["P-9"] });
  assert.equal(written.evaluation.evaluated[0].summary, "eligible", "age and the biomarker from the table, ECOG from the fact");
  assert.equal(reads, 1);
  const detail = await trials.detail(study, { subjectKey: "P-9", id: written.trial.id });
  const age = detail.judgments.find((judgment) => judgment.criterionId === written.criteria[0].id);
  assert.match(age.evidence[0].quote, /age/, "the evidence names the column");
  assert.ok(!JSON.stringify(age.evidence).includes("55"), "and not the value in it");

  const refused = seam({ subjectTable: { async read() { throw Object.assign(new Error("no grant"), { code: "vcr_access_denied" }); } } });
  const unread = await refused.evaluate(study, { subjectKeys: ["P-9"] });
  assert.equal(unread.evaluated[0].summary, "insufficient_evidence", "the table's facts are missing, and the criteria that needed them are unknown");
  assert.deepEqual(unread.notes, [{ code: "vcr_access_denied" }]);
});
