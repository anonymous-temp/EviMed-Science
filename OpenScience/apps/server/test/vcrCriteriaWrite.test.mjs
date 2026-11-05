// `vcr_write` of the study's own criteria and language answers: an exclusion is written as the registry states it and stored as the
// requirement that keeps the patient in, and a language answer about the protocol is kept exactly as written.
import assert from "node:assert/strict";
import test from "node:test";

import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { statedRequirement, storedExclusion } from "../src/vcrMatching.mjs";
import { VCR_WRITE_WHATS } from "../src/vcrService.mjs";

const study = { id: "std_1", userId: "u1", projectId: "prj_1", dataTier: "T1" };
const AGE = { kind: "inclusion", criterionType: "demographic", sourceText: "Age >= 18 years",
  requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" } };

const CHART = "患者本人可理解研究内容并签署知情同意。";

test("candidate_trial is no word of the write any more, and candidate_trials is still one the run can read", () => {
  assert.ok(!VCR_WRITE_WHATS.includes("candidate_trial"));
  assert.ok(VCR_WRITE_WHATS.includes("language_judgment"));
});

test("a language answer about the study's own protocol is written exactly as it was, and a candidate trial is no target of it", async () => {
  /** @type {any[]} */
  const kept = [];
  const documents = { async runtimeRead(_study, { documentId }) { return documentId === "doc_1" ? { id: "doc_1", text: CHART, visibleAt: "2026-09-01T00:00:00.000Z" } : null; } };
  const deps = { store: {}, service: {}, orchestrator: null, study, documents,
    matching: { async languageKeys() { return ["consent"]; } },
    matchStore: { async holdsSubject() { return true; }, async saveLanguageJudgment(input) { kept.push(input); return { id: "jdg_9" }; } } };
  const item = { subjectKey: "P-0192", criterionKey: "consent", state: "satisfied", evidence: [{ documentId: "doc_1", quote: CHART }], protocolVersionId: "prt_1" };
  const outcome = await vcrRuntimeWrite({ ...deps, what: "language_judgment", items: [item], data: null });
  assert.deepEqual(outcome.issues, []);
  assert.deepEqual(outcome.ids, ["jdg_9"]);
  assert.equal(kept[0].protocolVersionId, "prt_1");
  const aimed = await vcrRuntimeWrite({ ...deps, what: "language_judgment", items: [{ ...item, protocolVersionId: undefined, candidateTrialId: "ctr_1" }], data: null });
  assert.equal(aimed.ok, false);
  assert.deepEqual(aimed.issues.map((entry) => entry.code), ["vcr_write_field_forbidden"]);
  assert.equal(kept.length, 1);
});

// Two live 给患者找试验 runs (real DSH + DeepSeek, 2026-10-11) wrote all twelve of their structured exclusions as the registry states
// them -- "Modified rankin scale > 3" as `gt 3`, "Diagnosis of atrial fibrillation" as `present` -- the second after the skill asked for
// the negated form, while the grammar reads every stored requirement as what keeps the patient in: an AF patient read as passing an AF
// exclusion. Negating is mechanical, so it is the platform's: an exclusion is written as stated and stored as its negation, and a run
// reads it back as stated.
test("an exclusion is written as the registry states it and stored as the requirement that keeps the patient in", async () => {
  /** @type {any[]} */
  const saved = [];
  const store = { async latestProtocolVersion() { return null; }, async saveProtocolVersion(/** @type {any} */ input) { saved.push(input); return { id: "prt_1", version: 1 }; } };
  const AF = { kind: "exclusion", criterionType: "comorbidity", sourceText: "Diagnosis of atrial fibrillation",
    requirement: { op: "present", variable: "atrial_fibrillation" } };
  const MRS = { kind: "exclusion", criterionType: "other", sourceText: "Modified rankin scale > 3",
    requirement: { op: "compare", variable: "modified_rankin_scale", comparator: "gt", value: 3 } };
  const answer = await vcrRuntimeWrite({ store, service: {}, orchestrator: null, study, what: "criteria", items: [{ title: "v1", criteria: [AGE, AF, MRS] }], data: null });
  assert.deepEqual(answer.issues, []);
  assert.deepEqual(saved[0].criteria.map((criterion) => criterion.requirement), [
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
test("a protocol write keeps a negated exclusion and names it beside the version", async () => {
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
