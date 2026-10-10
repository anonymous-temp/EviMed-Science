// `vcr_write what: "candidate_trial"` — the run hands the platform a registry id and its structuring of that trial's
// eligibility text; the platform reads the trial's identity out of the registry's record, checks every criterion against
// the closed grammar, finds where each one's original wording stands in the record, and refuses item by item.
import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "../src/security.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { VCR_READ_WHATS, VCR_WRITE_WHATS } from "../src/vcrService.mjs";

const study = { id: "std_1", userId: "u1", projectId: "prj_1", dataTier: "T1" };
const HASH = "c".repeat(64);
const ELIGIBILITY = "Inclusion Criteria:\n* Age >= 18 years\n* Histologically confirmed NSCLC\nExclusion Criteria:\n* Active brain metastases";

const record = (registryId = "NCT05000001") => ({
  status: "ok",
  trial: { registry: "clinicaltrials.gov", registryId, title: `Trial ${registryId}`, phase: "PHASE2", status: "RECRUITING", conditions: ["NSCLC"],
    locations: { total: 1, countries: ["China"], sites: [] }, url: `https://clinicaltrials.gov/study/${registryId}`, recordHash: HASH,
    retrievedAt: "2026-10-10T08:00:00.000Z", eligibilityText: ELIGIBILITY },
});

const AGE = { kind: "inclusion", criterionType: "demographic", sourceText: "Age >= 18 years",
  requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" } };
const NSCLC = { kind: "inclusion", criterionType: "diagnosis", sourceText: "Histologically confirmed NSCLC",
  requirement: { op: "present", variable: "nsclc" } };
const BRAIN = { kind: "exclusion", criterionType: "comorbidity", sourceText: "Active brain metastases",
  requirement: { op: "absent", variable: "active_brain_metastasis" } };

/** The seams a write meets, as doubles that record what they were asked. @param {Record<string, any>} [options] */
function seams(options = {}) {
  /** @type {any[]} */
  const written = [];
  /** @type {any[]} */
  const fetched = [];
  const evidence = {
    async candidateRecord(input) { fetched.push(input); return options.record ? options.record(input) : record(input.registryId); },
  };
  const patientTrials = options.patientTrials === null ? null : {
    async holds() { return options.holds ?? true; },
    async writeTrial(target, input) {
      written.push({ studyId: target.id, ...input });
      if (options.refuse) throw new HttpError(409, "vcr_write_refused", options.refuse);
      return { trial: { id: "ctr_1", ...input.trial }, criteria: input.criteria?.map((criterion, index) => ({ id: `ctc_${index + 1}`, ...criterion })) ?? [],
        created: true, criteriaChanged: input.criteria !== null, evaluation: { evaluated: input.subjectKeys.map((subjectKey) => ({ subjectKey, summary: "eligible", counts: { satisfied: 3 } })), unavailable: [] } };
    },
  };
  const matchStore = { async candidateSubjects() { return options.roster ?? ["P-0192", "P-0201"]; }, async holdsSubject() { return false; } };
  return { written, fetched, deps: { store: {}, service: {}, orchestrator: null, study, evidence, matchStore, patientTrials, documents: null } };
}

/** @param {ReturnType<typeof seams>} seam @param {any[]} items */
const write = (seam, items) => vcrRuntimeWrite({ ...seam.deps, what: "candidate_trial", items, data: null });

test("candidate_trial is a word the run can write and candidate_trials one it can read", () => {
  assert.ok(VCR_WRITE_WHATS.includes("candidate_trial"));
  assert.ok(VCR_READ_WHATS.includes("candidate_trials"));
});

test("a trial is written from its registry record: identity from the record, criteria from the run, the original wording located", async () => {
  const seam = seams();
  const outcome = await write(seam, [{ registryId: "NCT05000001", criteria: [AGE, NSCLC, BRAIN], subjectKeys: ["P-0192"] }]);
  assert.deepEqual(outcome.issues, []);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ids, ["ctr_1"]);
  assert.deepEqual(seam.fetched, [{ userId: "u1", registry: "clinicaltrials.gov", registryId: "NCT05000001" }]);
  const [call] = seam.written;
  assert.equal(call.trial.title, "Trial NCT05000001", "the title is the record's, not the run's");
  assert.equal(call.trial.status, "RECRUITING");
  assert.deepEqual(call.subjectKeys, ["P-0192"]);
  assert.equal(call.criteria.length, 3);
  assert.equal(call.criteria[0].reviewState, "ai_set");
  assert.deepEqual(call.criteria[0].requirement, AGE.requirement);
  const age = ELIGIBILITY.indexOf("Age >= 18 years");
  assert.deepEqual(call.criteria[0].sourceLocator, { recordHash: HASH, start: age, end: age + "Age >= 18 years".length }, "the platform locates the wording, the run does not");
  assert.deepEqual(outcome.results[0], { index: 0, id: "ctr_1", registryId: "NCT05000001", created: true, criteria: 3, located: 3,
    evaluated: [{ subjectKey: "P-0192", summary: "eligible", counts: { satisfied: 3 } }] });
});

test("wording that is not in the record is kept as written, not located, and said — never a reason to refuse the trial", async () => {
  const seam = seams();
  const paraphrase = { ...AGE, sourceText: "Adults only" };
  const outcome = await write(seam, [{ registryId: "NCT05000001", criteria: [paraphrase, BRAIN] }]);
  assert.deepEqual(outcome.issues, []);
  assert.equal(seam.written[0].criteria[0].sourceText, "Adults only");
  assert.deepEqual(seam.written[0].criteria[0].sourceLocator, { recordHash: HASH, located: false });
  assert.equal(outcome.results[0].located, 1);
  assert.deepEqual(outcome.results[0].warnings.map((warning) => [warning.field, warning.code]), [["criteria[0].sourceText", "source_text_not_in_record"]]);
});

test("a criterion outside the closed grammar refuses its trial whole, by name and path, and the other items are written", async () => {
  const seam = seams();
  const broken = { ...AGE, requirement: { op: "compare", variable: "age", comparator: "ge", value: 18 } };
  const outcome = await write(seam, [{ registryId: "NCT05000001", criteria: [broken, BRAIN] }, { registryId: "NCT05000002", criteria: [AGE] }]);
  assert.deepEqual(outcome.ids, ["ctr_1"], "the second trial is written");
  assert.equal(seam.written.length, 1);
  assert.equal(seam.written[0].trial.registryId, "NCT05000002");
  const refused = outcome.issues.filter((entry) => entry.index === 0);
  assert.equal(refused[0].code, "vcr_criterion_malformed");
  assert.equal(refused[0].field, "criteria[0].requirement");
  assert.match(refused[0].message, /criteria\[0\]\.requirement/);
});

test("a trial missing a line is never written: the lines it has are not a trial that asks less", async () => {
  const seam = seams();
  const outcome = await write(seam, [{ registryId: "NCT05000001", criteria: [AGE, { ...BRAIN, kind: "maybe" }] }]);
  assert.equal(outcome.ok, false);
  assert.equal(seam.written.length, 0, "an exclusion lost to a typo would rank a patient who is excluded as eligible");
  assert.ok(outcome.issues.some((entry) => entry.field === "criteria[1].kind"));
});

test("the identity of a trial is not the run's to type, and an expression is not a requirement", async () => {
  const seam = seams();
  const outcome = await write(seam, [
    { registryId: "NCT05000001", criteria: [AGE], status: "RECRUITING", title: "Better trial" },
    { registryId: "NCT05000002", criteria: [{ ...AGE, requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, expression: "age >= 18" } }] },
  ]);
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.issues.map((entry) => [entry.index, entry.code]), [[0, "vcr_write_field_forbidden"], [1, "vcr_write_field_forbidden"]]);
  assert.equal(seam.written.length, 0);
});

test("a registry that has no such record, or cannot be asked, is named and writes nothing", async () => {
  const absent = seams({ record: () => ({ status: "registry_not_found", reason: "registry_not_found", registryId: "NCT00000000" }) });
  const missing = await write(absent, [{ registryId: "NCT00000000", criteria: [AGE] }]);
  assert.deepEqual(missing.issues.map((entry) => [entry.field, entry.code]), [["registryId", "registry_not_found"]]);
  const offline = seams({ record: () => ({ status: "registry_unavailable", reason: "ENOTFOUND", registryId: "NCT05000001" }) });
  const down = await write(offline, [{ registryId: "NCT05000001", criteria: [AGE] }]);
  assert.deepEqual(down.issues.map((entry) => [entry.field, entry.code]), [["registryId", "registry_unavailable"]]);
  assert.equal(absent.written.length + offline.written.length, 0);
});

test("a new trial needs its criteria; one the study holds can be named again for another patient without them", async () => {
  const seam = seams();
  const bare = await write(seam, [{ registryId: "NCT05000001", subjectKeys: ["P-0192"] }]);
  assert.equal(bare.ok, true, "the study holds this trial, and keeps its criteria");
  assert.equal(seam.written[0].criteria, null);
  assert.deepEqual(seam.written[0].subjectKeys, ["P-0192"]);

  const fresh = seams({ holds: false });
  const refused = await write(fresh, [{ registryId: "NCT05000009", subjectKeys: ["P-0192"] }]);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.issues.map((entry) => [entry.field, entry.code]), [["criteria", "vcr_write_value_invalid"]]);
  assert.equal(fresh.written.length, 0, "a trial nobody structured is nothing to evaluate a patient against");

  const empty = await write(seam, [{ registryId: "NCT05000009", criteria: [] }]);
  assert.equal(empty.ok, false);
  assert.ok(empty.issues.some((entry) => entry.field === "criteria"), "a trial with no line at all is nothing to evaluate against");
});

test("a patient the study does not hold is a warning, and the trial is still written for those it does", async () => {
  const seam = seams();
  const outcome = await write(seam, [{ registryId: "NCT05000001", criteria: [AGE], subjectKeys: ["P-0192", "P-9999"] }]);
  assert.deepEqual(outcome.issues, []);
  assert.deepEqual(seam.written[0].subjectKeys, ["P-0192"]);
  assert.deepEqual(outcome.results[0].warnings.map((warning) => [warning.field, warning.code]), [["subjectKeys[1]", "vcr_subject_not_found"]]);
});

test("the study's cap on candidate trials refuses that trial with the reason, and nothing else", async () => {
  const seam = seams({ refuse: "本研究最多保存 3 个候选试验，已满" });
  const outcome = await write(seam, [{ registryId: "NCT05000001", criteria: [AGE] }]);
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.issues.map((entry) => [entry.index, entry.code]), [[0, "vcr_write_refused"]]);
  assert.match(outcome.issues[0].message, /3 个候选试验/);
});

test("a deployment that has not composed the trials says so by item, not by failing the call", async () => {
  const seam = seams({ patientTrials: null });
  const outcome = await write(seam, [{ registryId: "NCT05000001", criteria: [AGE] }]);
  assert.deepEqual(outcome.issues.map((entry) => entry.code), ["vcr_write_refused"]);
});
