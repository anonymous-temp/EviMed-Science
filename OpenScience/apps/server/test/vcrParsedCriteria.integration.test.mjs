// The account's parse of a registry trial (M2): kept against the registry id and the hash of the record it was made from, read again by a
// second study of the same account, made again when the record changed, and never read by another account. On a real PostgreSQL, through the
// real write path (`vcrRuntimeWrite`) and the real candidate-trial store; the registry's record is a double.
// Skipped when OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrCandidateTrialStore } from "../src/vcrCandidateTrialStore.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { VcrMatchStore } from "../src/vcrMatchStore.mjs";
import { createPatientTrials } from "../src/vcrPatientTrials.mjs";
import { VcrStoreBase, deleteVcrUserRows, vcrId } from "../src/vcrStoreBase.mjs";
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

const ELIGIBILITY = "Inclusion Criteria:\n* Age >= 18 years\n* Histologically confirmed NSCLC\nExclusion Criteria:\n* Active brain metastases";
const HASH_1 = "a".repeat(64);
const HASH_2 = "b".repeat(64);

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrparsed");
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

async function seedStudy(userId) {
  const id = vcrId("study");
  await q(`INSERT INTO evimed_vcr.studies (id, user_id, project_id, name, question, data_tier, intended_use)
    VALUES ($1, $2, $3, 'EV-201', '给患者找试验', 'T1', 'exploratory')`, [id, userId, `prj_${id}`]);
  return { id, userId, projectId: `prj_${id}`, dataTier: "T1" };
}

const AGE = { kind: "inclusion", criterionType: "demographic", sourceText: "Age >= 18 years",
  requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" } };
const NSCLC = { kind: "inclusion", criterionType: "diagnosis", sourceText: "Histologically confirmed NSCLC", requirement: { op: "present", variable: "nsclc" } };
const BRAIN = { kind: "exclusion", criterionType: "comorbidity", sourceText: "Active brain metastases", requirement: { op: "present", variable: "active_brain_metastasis" } };

/** A write the way the run makes it, over the real stores; the registry is a double whose record hash and wording the test sets. */
function writer(study, state) {
  const patientTrials = createPatientTrials({ candidateStore: candidates, matchStore: matching, config: { vcrCandidateTrialsMax: 20 }, now: () => new Date("2026-11-01T08:00:00Z") });
  const evidence = {
    async candidateRecord({ registry, registryId }) {
      return { status: "ok", trial: { registry, registryId, title: `Trial ${registryId}`, phase: "PHASE2", status: "RECRUITING", conditions: ["NSCLC"],
        locations: { total: 1, countries: ["China"], sites: [] }, url: `https://clinicaltrials.gov/study/${registryId}`, recordHash: state.hash,
        retrievedAt: "2026-10-10T08:00:00.000Z", eligibilityText: state.text ?? ELIGIBILITY } };
    },
  };
  const deps = { store: {}, service: {}, orchestrator: null, study, evidence, matchStore: matching, patientTrials, documents: null };
  return { patientTrials, write: (items) => vcrRuntimeWrite({ ...deps, what: "candidate_trial", items, data: null }) };
}

test("a second study of the same account reads the parse of the same record instead of asking for it again; an exclusion keeps its meaning", options, async () => {
  const user = "u_parsed_a";
  const first = await seedStudy(user);
  const second = await seedStudy(user);
  const state = { hash: HASH_1 };

  const firstWriter = writer(first, state);
  const written = await firstWriter.write([{ registryId: "NCT07000001", criteria: [AGE, NSCLC, BRAIN] }]);
  assert.deepEqual(written.issues, []);
  assert.equal(written.results[0].reused, undefined, "the first study parsed it");
  const [kept] = await q("SELECT record_hash, criteria FROM evimed_vcr.parsed_trial_criteria WHERE user_id = $1", [user]);
  assert.equal(kept.record_hash, HASH_1);
  assert.deepEqual(kept.criteria.map((criterion) => criterion.sourceText), [AGE.sourceText, NSCLC.sourceText, BRAIN.sourceText]);
  assert.deepEqual(kept.criteria[2].requirement, BRAIN.requirement, "kept as the run wrote it (an exclusion is stored negated and negated once by the write)");

  const secondWriter = writer(second, state);
  const again = await secondWriter.write([{ registryId: "NCT07000001" }]);
  assert.deepEqual(again.issues, [], "no criteria were written and none were asked for");
  assert.equal(again.ok, true);
  assert.equal(again.results[0].reused, true);
  assert.equal(again.results[0].criteria, 3);
  assert.equal(again.results[0].located, 3, "the wording is found in the record again");
  const mine = await candidates.getCandidateTrial({ studyId: second.id, registryId: "NCT07000001" });
  const copied = await candidates.listCriteria(mine.id);
  const original = await candidates.listCriteria((await candidates.getCandidateTrial({ studyId: first.id, registryId: "NCT07000001" })).id);
  assert.deepEqual(copied.map((criterion) => [criterion.kind, criterion.criterionType, criterion.sourceText, criterion.requirement, criterion.applicability]),
    original.map((criterion) => [criterion.kind, criterion.criterionType, criterion.sourceText, criterion.requirement, criterion.applicability]),
    "the same criteria in the same stored form, the exclusion negated once and not twice");
  assert.notEqual(copied[0].id, original[0].id, "the study's own rows, with their own ids");
  assert.equal(secondWriter.patientTrials.counters.parsedReused, 1);
  assert.equal(firstWriter.patientTrials.counters.parsedKept, 1);
});

test("a record whose hash changed is parsed again: the old parse is not read, and the new one replaces it", options, async () => {
  const user = "u_parsed_b";
  const first = await seedStudy(user);
  const second = await seedStudy(user);
  const third = await seedStudy(user);
  const state = { hash: HASH_1 };
  await writer(first, state).write([{ registryId: "NCT07000002", criteria: [AGE] }]);

  state.hash = HASH_2;
  const changed = await writer(second, state).write([{ registryId: "NCT07000002" }]);
  assert.equal(changed.ok, false, "this record is not the one the parse was made from");
  assert.deepEqual(changed.issues.map((issue) => [issue.field, issue.code]), [["criteria", "vcr_write_value_invalid"]]);
  assert.match(changed.issues[0].message, /解析/);

  await writer(second, state).write([{ registryId: "NCT07000002", criteria: [AGE, NSCLC] }]);
  assert.deepEqual((await q("SELECT record_hash, jsonb_array_length(criteria) AS n FROM evimed_vcr.parsed_trial_criteria WHERE user_id = $1", [user])).map((row) => [row.record_hash, row.n]),
    [[HASH_2, 2]], "one row per trial: the newer record's parse");
  const reused = await writer(third, state).write([{ registryId: "NCT07000002" }]);
  assert.equal(reused.results[0].criteria, 2);
  // The study that parsed the older record keeps its own criteria.
  const old = await candidates.getCandidateTrial({ studyId: first.id, registryId: "NCT07000002" });
  assert.equal((await candidates.listCriteria(old.id)).length, 1);
});

test("another account never reads an account's parse", options, async () => {
  const owner = await seedStudy("u_parsed_owner");
  const other = await seedStudy("u_parsed_other");
  const state = { hash: HASH_1 };
  await writer(owner, state).write([{ registryId: "NCT07000003", criteria: [AGE, BRAIN] }]);

  assert.notEqual(await candidates.parsedCriteriaFor({ userId: "u_parsed_owner", registry: "clinicaltrials.gov", registryId: "NCT07000003", recordHash: HASH_1 }), null);
  assert.equal(await candidates.parsedCriteriaFor({ userId: "u_parsed_other", registry: "clinicaltrials.gov", registryId: "NCT07000003", recordHash: HASH_1 }), null);
  assert.deepEqual([...await candidates.parsedCriteriaHeld({ userId: "u_parsed_other", trials: [{ registry: "clinicaltrials.gov", registryId: "NCT07000003" }] })], []);
  assert.equal([...await candidates.parsedCriteriaHeld({ userId: "u_parsed_owner", trials: [{ registry: "clinicaltrials.gov", registryId: "NCT07000003" }] })].length, 1);

  const refused = await writer(other, state).write([{ registryId: "NCT07000003" }]);
  assert.equal(refused.ok, false, "the other account's study has to structure the trial itself");
  assert.equal(await candidates.getCandidateTrial({ studyId: other.id, registryId: "NCT07000003" }), null, "and nothing was written for it");
  // The same registry id of the other account is a row of its own.
  await writer(other, state).write([{ registryId: "NCT07000003", criteria: [NSCLC] }]);
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.parsed_trial_criteria WHERE registry_id = 'NCT07000003'"))[0].n, 2);
  const mine = await candidates.parsedCriteriaFor({ userId: "u_parsed_owner", registry: "clinicaltrials.gov", registryId: "NCT07000003", recordHash: HASH_1 });
  assert.equal(mine.criteria.length, 2, "and the owner's is untouched");
});

test("a parse that cannot be kept costs the next study a parse and this one nothing; deleting the account takes the parses with it", options, async () => {
  const user = "u_parsed_c";
  const study = await seedStudy(user);
  /** @type {string[]} */
  const reports = [];
  const failing = Object.assign(Object.create(candidates), { saveParsedCriteria: async () => { throw Object.assign(new Error("disk"), { code: "XX000" }); } });
  const saved = await createPatientTrials({ candidateStore: failing, matchStore: matching, config: { vcrCandidateTrialsMax: 20 }, report: (code) => reports.push(code) })
    .writeTrial(study, { trial: { registry: "clinicaltrials.gov", registryId: "NCT07000004", title: "T", recordHash: HASH_1, eligibilityText: ELIGIBILITY }, criteria: [AGE] });
  assert.equal(saved.created, true, "the trial is written");
  assert.deepEqual(reports, ["XX000"]);

  await writer(study, { hash: HASH_1 }).write([{ registryId: "NCT07000005", criteria: [AGE] }]);
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.parsed_trial_criteria WHERE user_id = $1", [user]))[0].n, 1);
  await database.transaction((client) => deleteVcrUserRows(client, user));
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.parsed_trial_criteria WHERE user_id = $1", [user]))[0].n, 0);
});
