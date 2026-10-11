// `vcr_write what: "candidate_trial"` — the run hands the platform a registry id and its structuring of that trial's
// eligibility text; the platform reads the trial's identity out of the registry's record, checks every criterion against
// the closed grammar, finds where each one's original wording stands in the record, and refuses item by item.
import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "../src/security.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { statedRequirement, storedExclusion } from "../src/vcrMatching.mjs";
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

// ---------------------------------------------------------------------------
// The answer to a criterion only language can decide, about a candidate trial
// ---------------------------------------------------------------------------

const CHART = "患者本人可理解研究内容并签署知情同意。";

/** The seams a language answer meets. @param {Record<string, any>} [options] */
function languageSeams(options = {}) {
  /** @type {any[]} */
  const saved = [];
  /** @type {any[]} */
  const evaluated = [];
  const patientTrials = {
    async holds(_study, { id }) { return id === "ctr_1"; },
    async languageKeys(_study, id) { return id === "ctr_1" ? ["consent"] : []; },
    async saveLanguageJudgment(_study, input) { saved.push(input); return { id: "jdg_1" }; },
    async evaluate(_study, input) {
      evaluated.push(input);
      return { evaluated: [{ trialId: "ctr_1", registryId: "NCT05000001", subjectKey: input.subjectKeys[0], summary: options.summary ?? "eligible", counts: { satisfied: 2 } }], unavailable: [], notes: [] };
    },
  };
  const matchStore = { async holdsSubject() { return true; }, async saveLanguageJudgment() { throw new Error("a trial's answer is not a protocol's"); } };
  // The cloud-approved reader the writers verify a quotation through (`vcrDocumentsSeam.runtimeRead`).
  const documents = { async runtimeRead(_study, { documentId }) { return documentId === "doc_1" ? { id: "doc_1", text: CHART, visibleAt: "2026-09-01T00:00:00.000Z" } : null; } };
  const matching = { async languageKeys() { throw new Error("a trial's key is not a protocol's"); } };
  return { saved, evaluated, deps: { store: {}, service: {}, orchestrator: null, study, matchStore, matching, patientTrials, documents } };
}

const answer = (extra = {}) => ({
  subjectKey: "P-0192", candidateTrialId: "ctr_1", criterionKey: "consent", state: "satisfied",
  evidence: [{ documentId: "doc_1", quote: CHART }], ...extra,
});

test("an answer about a candidate trial's language criterion is checked against the patient's own words, kept for that trial, and the verdict is made again once", async () => {
  const seam = languageSeams();
  const outcome = await vcrRuntimeWrite({ ...seam.deps, what: "language_judgment", items: [answer(), answer({ criterionKey: "consent", state: "unknown", evidence: [] })], data: null });
  assert.deepEqual(outcome.issues, []);
  assert.deepEqual(outcome.ids, ["jdg_1", "jdg_1"]);
  assert.equal(seam.saved.length, 2);
  assert.deepEqual([seam.saved[0].candidateTrialId, seam.saved[0].subjectKey, seam.saved[0].criterionKey, seam.saved[0].state], ["ctr_1", "P-0192", "consent", "satisfied"]);
  assert.deepEqual(seam.saved[0].evidence, [{ documentId: "doc_1", start: 0, end: CHART.length, quote: CHART, visibleAt: "2026-09-01T00:00:00.000Z" }],
    "the platform found where the sentence stands, in the patient's own document");
  assert.deepEqual(seam.evaluated, [{ subjectKeys: ["P-0192"], trialIds: ["ctr_1"] }], "two answers about one pair are one new verdict");
  const verdict = outcome.results.find((row) => row.candidateTrialId === "ctr_1");
  assert.deepEqual(verdict, { candidateTrialId: "ctr_1", subjectKey: "P-0192", evaluated: [{ subjectKey: "P-0192", summary: "eligible", counts: { satisfied: 2 } }] });
});

test("a language answer names a protocol version or a candidate trial, not both; a trial or a key the study does not have is refused with the keys it has", async () => {
  const seam = languageSeams();
  const both = await vcrRuntimeWrite({ ...seam.deps, what: "language_judgment", items: [answer({ protocolVersionId: "prt_1" })], data: null });
  assert.deepEqual(both.issues.map((entry) => [entry.field, entry.code]), [["candidateTrialId", "vcr_write_value_invalid"]]);
  const noTrial = await vcrRuntimeWrite({ ...seam.deps, what: "language_judgment", items: [answer({ candidateTrialId: "ctr_9" })], data: null });
  assert.equal(noTrial.issues[0].field, "candidateTrialId");
  assert.match(noTrial.issues[0].message, /候选试验/);
  const noKey = await vcrRuntimeWrite({ ...seam.deps, what: "language_judgment", items: [answer({ criterionKey: "pregnancy" })], data: null });
  assert.equal(noKey.issues[0].field, "criterionKey");
  assert.match(noKey.issues[0].message, /候选试验.*consent/);
  assert.equal(seam.saved.length + seam.evaluated.length, 0, "nothing was kept, and nothing was judged again");

  const forged = await vcrRuntimeWrite({ ...seam.deps, what: "language_judgment", items: [answer({ evidence: [{ documentId: "doc_1", quote: "患者拒绝签署知情同意" }] })], data: null });
  assert.equal(forged.ok, false, "a quotation that is not in the patient's chart is not evidence");
  assert.equal(seam.saved.length, 0);
});

test("a language answer about the study's own protocol is written exactly as it was, and judges no candidate", async () => {
  const seam = languageSeams();
  /** @type {any[]} */
  const kept = [];
  seam.deps.matching = { async languageKeys() { return ["consent"]; } };
  seam.deps.matchStore = { async holdsSubject() { return true; }, async saveLanguageJudgment(input) { kept.push(input); return { id: "jdg_9" }; } };
  const outcome = await vcrRuntimeWrite({ ...seam.deps, what: "language_judgment", items: [{ ...answer({ protocolVersionId: "prt_1" }), candidateTrialId: undefined }], data: null });
  assert.deepEqual(outcome.issues, []);
  assert.deepEqual(outcome.ids, ["jdg_9"]);
  assert.equal(kept[0].protocolVersionId, "prt_1");
  assert.equal(seam.saved.length + seam.evaluated.length, 0);
});

// Two live 给患者找试验 runs (real DSH + DeepSeek, 2026-10-11) wrote all twelve of their structured exclusions as the registry states
// them -- "Modified rankin scale > 3" as `gt 3`, "Diagnosis of atrial fibrillation" as `present` -- the second after the skill asked for
// the negated form, while the grammar reads every stored requirement as what keeps the patient in: an AF patient read as passing an AF
// exclusion. Negating is mechanical, so it is the platform's: an exclusion is written as stated and stored as its negation, and a run
// reads it back as stated.
test("an exclusion is written as the registry states it and stored as the requirement that keeps the patient in", async () => {
  const seam = seams();
  const AF = { kind: "exclusion", criterionType: "comorbidity", sourceText: "Diagnosis of atrial fibrillation",
    requirement: { op: "present", variable: "atrial_fibrillation" } };
  const MRS = { kind: "exclusion", criterionType: "other", sourceText: "Modified rankin scale > 3",
    requirement: { op: "compare", variable: "modified_rankin_scale", comparator: "gt", value: 3 } };
  const answer = await write(seam, [{ registryId: "NCT05000001", subjectKeys: ["P-0192"], criteria: [AGE, AF, MRS] }]);
  assert.deepEqual(answer.issues, []);
  assert.deepEqual(seam.written[0].criteria.map((criterion) => criterion.requirement), [
    AGE.requirement, { op: "not", operand: AF.requirement }, { op: "not", operand: MRS.requirement },
  ], "an inclusion is stored as written, an exclusion as the negation of what was written");
});

test("a run reads an exclusion back as it wrote it, and a criterion stored before reads as its negation", () => {
  const stated = { op: "present", variable: "atrial_fibrillation" };
  assert.deepEqual(statedRequirement({ kind: "exclusion", requirement: storedExclusion(stated) }), stated, "written as stated, read as stated");
  const legacy = { op: "absent", variable: "active_brain_metastasis" };
  assert.deepEqual(statedRequirement({ kind: "exclusion", requirement: legacy }), { op: "not", operand: legacy },
    "one stored as a requirement that keeps the patient in reads as the condition that excludes");
  assert.deepEqual(statedRequirement({ kind: "inclusion", requirement: stated }), stated, "an inclusion reads as it is stored");
  // What a run reads, written back, means what it meant: the evaluator's negation is three-valued, so not(not(x)) is x.
  const rewritten = storedExclusion(statedRequirement({ kind: "exclusion", requirement: legacy }));
  assert.deepEqual(rewritten, { op: "not", operand: { op: "not", operand: legacy } });
});

// The run after the change (2026-10-11) wrote twelve of fourteen exclusions as stated and negated two by hand ("Patients older than
// 85 years" as not(age > 85)), which the platform's own negation turned back into "older than 85 keeps you in". Whether a written
// not(...) is the registry's own negative ("unable to consent") or a hand negation is language, so the platform does not decide it:
// it says so beside the write, and the run that wrote it looks again.
test("an exclusion written as a negation is kept and named in the write's warnings, so the run can look again", async () => {
  const seam = seams();
  const OLDER = { kind: "exclusion", criterionType: "demographic", sourceText: "Patients older than 85 years",
    requirement: { op: "not", operand: { op: "compare", variable: "age", comparator: "gt", value: 85 } } };
  const AF = { kind: "exclusion", criterionType: "comorbidity", sourceText: "Diagnosis of atrial fibrillation", requirement: { op: "present", variable: "atrial_fibrillation" } };
  const answer = await write(seam, [{ registryId: "NCT05000001", subjectKeys: ["P-0192"], criteria: [AGE, OLDER, AF] }]);
  assert.deepEqual(answer.issues, []);
  assert.equal(seam.written[0].criteria.length, 3, "kept: a written negation can be the registry's own wording");
  const warned = (answer.results[0].warnings ?? []).filter((found) => found.code === "exclusion_written_negated");
  assert.deepEqual(warned.map((found) => found.field), ["criteria[1].requirement"]);
  assert.match(warned[0].message, /照原句/);
});

test("a protocol write keeps a negated exclusion and names it beside the version, as the candidate-trial write does", async () => {
  /** @type {any[]} */
  const saved = [];
  const store = {
    async latestProtocolVersion() { return null; },
    async saveProtocolVersion(/** @type {any} */ input) { saved.push(input); return { id: "prt_1", version: 1 }; },
  };
  const OLDER = { kind: "exclusion", criterionType: "demographic", sourceText: "年龄大于 85 岁者除外",
    requirement: { op: "not", operand: { op: "compare", variable: "age", comparator: "gt", value: 85 } } };
  const answer = await vcrRuntimeWrite({ store, service: {}, orchestrator: null, study, what: "criteria", items: [{ title: "v1", criteria: [AGE, OLDER] }], data: null });
  assert.deepEqual(answer.issues, []);
  assert.equal(saved[0].criteria.length, 2);
  const warned = answer.results.flatMap((row) => row.warnings ?? []).filter((found) => found.code === "exclusion_written_negated");
  assert.deepEqual(warned.map((found) => found.field), ["criteria[1].requirement"]);
});
