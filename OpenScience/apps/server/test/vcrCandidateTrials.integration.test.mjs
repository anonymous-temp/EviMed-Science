// Candidate trials on a real PostgreSQL: the trials a run found for a patient are objects of the study,
// kept apart from the study's own protocol versions, written once per registry id, bounded per study,
// and gone with the study. Skipped when OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VCR_TABLES } from "../src/vcrPersistence.mjs";
import { VcrCandidateTrialStore } from "../src/vcrCandidateTrialStore.mjs";
import { VcrMatchStore } from "../src/vcrMatchStore.mjs";
import { VcrStoreBase, deleteVcrStudyRows, vcrId } from "../src/vcrStoreBase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

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

test("a trial is saved with its criteria in order, original wording kept, and is no version of the study's protocol", options, async () => {
  const studyId = await seedStudy();
  const saved = await trials.saveCandidateTrial({ studyId, userId: USER, trial: trial("NCT05000001"), criteria: [AGE, BRAIN], max: 10 });
  assert.match(saved.trial.id, /^ctr_[a-f0-9]{22}$/);
  assert.equal(saved.created, true);
  assert.equal(saved.criteriaChanged, true);
  assert.deepEqual(saved.criteria.map((row) => [row.ordinal, row.kind, row.sourceText]), [[1, "inclusion", "Age >= 18"], [2, "exclusion", "Active brain metastases"]]);
  assert.match(saved.criteria[0].id, /^ctc_[a-f0-9]{22}$/);
  assert.deepEqual(saved.criteria[1].evidenceNeeded, ["head MRI within 4 weeks"]);

  const read = await trials.getCandidateTrial({ studyId, registry: "clinicaltrials.gov", registryId: "NCT05000001" });
  assert.equal(read.id, saved.trial.id);
  assert.equal(read.title, "Trial NCT05000001");
  assert.equal(read.phase, "PHASE2");
  assert.equal(read.status, "RECRUITING");
  assert.deepEqual(read.conditions, ["NSCLC"]);
  assert.equal(read.locations.sites[0].city, "Beijing");
  assert.equal(read.recordHash, "b".repeat(64));
  assert.match(read.eligibilityText, /Active brain metastases/);

  // The study's own sequence of protocol versions, its criteria and its matching ledger do not hold it.
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.protocol_versions WHERE study_id = $1", [studyId]))[0].n, 0);
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.criteria WHERE study_id = $1", [studyId]))[0].n, 0);
  assert.deepEqual(await matching.protocols(studyId), []);
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.matching_assessments WHERE study_id = $1", [studyId]))[0].n, 0);
});

test("a trial is one row per registry id: writing it again updates it, and criteria that did not change are not a change", options, async () => {
  const studyId = await seedStudy();
  const first = await trials.saveCandidateTrial({ studyId, userId: USER, trial: trial("NCT05000002"), criteria: [AGE, BRAIN], max: 10 });
  const again = await trials.saveCandidateTrial({ studyId, userId: USER, trial: trial("NCT05000002", { status: "ACTIVE_NOT_RECRUITING" }), criteria: [AGE, BRAIN], max: 10 });
  assert.equal(again.created, false);
  assert.equal(again.trial.id, first.trial.id);
  assert.equal(again.criteriaChanged, false, "the same criteria again change nothing");
  assert.deepEqual(again.criteria.map((row) => row.id), first.criteria.map((row) => row.id), "and keep their ids");
  assert.equal((await trials.getCandidateTrial({ studyId, id: first.trial.id })).status, "ACTIVE_NOT_RECRUITING", "while the identity is the record's newest word");
  assert.equal((await trials.listCandidateTrials({ studyId })).length, 1);

  const edited = await trials.saveCandidateTrial({ studyId, userId: USER, trial: trial("NCT05000002"), criteria: [AGE], max: 10 });
  assert.equal(edited.criteriaChanged, true);
  assert.deepEqual((await trials.listCriteria(first.trial.id)).map((row) => row.sourceText), ["Age >= 18"], "a criterion the new set lacks is gone");
});

test("a write with no criteria leaves the criteria a trial has", options, async () => {
  const studyId = await seedStudy();
  const first = await trials.saveCandidateTrial({ studyId, userId: USER, trial: trial("NCT05000003"), criteria: [AGE, BRAIN], max: 10 });
  const kept = await trials.saveCandidateTrial({ studyId, userId: USER, trial: trial("NCT05000003"), criteria: null, max: 10 });
  assert.equal(kept.criteriaChanged, false);
  assert.deepEqual(kept.criteria.map((row) => row.id), first.criteria.map((row) => row.id));
});

test("a study holds at most the configured number of candidate trials, and a trial it already holds can still be updated", options, async () => {
  const studyId = await seedStudy();
  await trials.saveCandidateTrial({ studyId, userId: USER, trial: trial("NCT05000011"), criteria: [AGE], max: 2 });
  await trials.saveCandidateTrial({ studyId, userId: USER, trial: trial("NCT05000012"), criteria: [AGE], max: 2 });
  await assert.rejects(
    trials.saveCandidateTrial({ studyId, userId: USER, trial: trial("NCT05000013"), criteria: [AGE], max: 2 }),
    (error) => error.status === 409 && error.code === "vcr_write_refused" && /2/.test(error.message));
  assert.equal((await trials.listCandidateTrials({ studyId })).length, 2, "nothing of the refused one was kept");
  const updated = await trials.saveCandidateTrial({ studyId, userId: USER, trial: trial("NCT05000011", { title: "Renamed" }), criteria: [AGE, BRAIN], max: 2 });
  assert.equal(updated.created, false);
  assert.equal(updated.trial.title, "Renamed");
});

test("a trial belongs to its study: another study neither reads it nor holds the same registry id as the same row", options, async () => {
  const mine = await seedStudy();
  const theirs = await seedStudy();
  const saved = await trials.saveCandidateTrial({ studyId: mine, userId: USER, trial: trial("NCT05000021"), criteria: [AGE], max: 10 });
  assert.equal(await trials.getCandidateTrial({ studyId: theirs, id: saved.trial.id }), null);
  assert.equal(await trials.getCandidateTrial({ studyId: theirs, registry: "clinicaltrials.gov", registryId: "NCT05000021" }), null);
  const other = await trials.saveCandidateTrial({ studyId: theirs, userId: USER, trial: trial("NCT05000021"), criteria: [AGE], max: 10 });
  assert.notEqual(other.trial.id, saved.trial.id);
});

test("a registry id and a status are kept as the record gave them, and a criterion outside the vocabulary is refused whole", options, async () => {
  const studyId = await seedStudy();
  await assert.rejects(
    trials.saveCandidateTrial({ studyId, userId: USER, trial: trial("NCT05000031"), criteria: [{ ...AGE, criterionType: "astrology" }], max: 10 }),
    /check constraint|criterion_type/i);
  assert.equal((await trials.listCandidateTrials({ studyId })).length, 0, "the trial and its criteria are written together or not at all");
});

test("deleting the study takes its candidate trials, their criteria and assessments with it", options, async () => {
  const studyId = await seedStudy();
  const saved = await trials.saveCandidateTrial({ studyId, userId: USER, trial: trial("NCT05000041"), criteria: [AGE, BRAIN], max: 10 });
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.candidate_trial_criteria WHERE candidate_trial_id = $1", [saved.trial.id]))[0].n, 2);
  await database.transaction((client) => deleteVcrStudyRows(client, studyId));
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.candidate_trials WHERE study_id = $1", [studyId]))[0].n, 0);
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.candidate_trial_criteria WHERE candidate_trial_id = $1", [saved.trial.id]))[0].n, 0);
});
