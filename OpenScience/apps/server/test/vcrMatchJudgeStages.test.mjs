// What stands behind a verdict once a person has more than one reading, and what the matching page's reader says of a scope too large for one read.
import assert from "node:assert/strict";
import test from "node:test";
import { judgmentTargets, presentJudgment } from "../src/vcrMatchJudge.mjs";

const STUDY = { id: "std_1", userId: "u_1", projectId: "p_1" };

test("clauses judged of newer words leave an older score out of their verdict", () => {
  const fit = { id: "a", status: "done", mode: "fit", subjectKey: "P-1", targetKind: "candidate_trial", targetId: "T", documentHash: "old", targetHash: "t", fit: 90, confidence: 0.9, updatedAt: "2026-11-04T00:00:01Z", answer: { reasons: { eligible: ["e"], ineligible: [], missing: [], rationale: "" } } };
  const criteria = { id: "b", status: "done", mode: "criteria", subjectKey: "P-1", targetKind: "candidate_trial", targetId: "T", documentHash: "new", targetHash: "t", fit: null, confidence: null, updatedAt: "2026-11-04T00:00:02Z", answer: { rows: [{ number: 1, kind: "inclusion", label: "included", basis: "stated" }], missing: [] } };
  const row = presentJudgment(fit, criteria);
  assert.equal(row.fit, null);
  assert.equal(row.verdict, "eligible");
  assert.equal(row.scoreOutdated, true);
  assert.equal(presentJudgment({ ...fit, documentHash: "new" }, criteria).fit, 90, "the same reading stands together");
});

test("a criterion with no words is reported: the target counts it, the row carries it, and the clauses that have words are numbered without it", async () => {
  const targets = judgmentTargets({ matchStore: { async listCriteria() { return [{ id: "c1", kind: "inclusion", sourceText: "Age >= 18" }, { id: "c2", kind: "exclusion", requirement: { op: "present", variable: "pregnancy" }, sourceText: "" }]; }, async protocols() { return []; } } });
  const target = await targets.protocol({ study: STUDY, protocolVersionId: "pv" });
  assert.deepEqual(target.clauses.map((clause) => clause.text), ["Age >= 18"]);
  assert.equal(target.clausesWithoutWords, 1);
  assert.doesNotMatch(target.eligibility, /Exclusion Criteria/u, "no heading is left over a section with no words");
  assert.match(presentJudgment({ id: "a", status: "done", mode: "fit", subjectKey: "P-1", targetKind: "protocol_version", targetId: "pv", answer: { clausesWithoutWords: 1 } }, null).recordGap, /1 条条件没有原文/u);
});

test("a scope past what one read holds says so on the page and at the end of a file, and a person with no score owed reads whole", async () => {
  const { VcrMatchResults } = await import("../src/vcrMatchResults.mjs");
  const fitRow = (target) => ({ id: `f${target}`, subject_key: "P-1", target_kind: "candidate_trial", target_id: target, mode: "fit", status: "done", fit: 70, confidence: 0.8, producer: "job", updated_at: new Date(), document_hash: "d", target_hash: "t", target: { registryId: target, id: target, kind: "candidate_trial", title: target }, missing_reasons: 0, ineligible_reasons: 0 });
  class Reader extends VcrMatchResults {
    constructor(rows, jobs, mostPairs) { super({ database: {}, judgments: { byIds: async () => [], jobsOf: async () => jobs }, mostPairs }); this.held = rows; }
    async rows(sql) { return /subject_withdrawals WHERE study_id/u.test(sql) && /SELECT subject_key/u.test(sql) ? [] : /SELECT DISTINCT j\.subject_key/u.test(sql) ? [] : this.held; }
    async one() { return { cost: 0.5 }; }
  }
  const job = (state, topK = 2) => ({ id: "j", state, created_at: new Date(), scenario: { direction: "patient_to_trial", subjects: ["P-1"], trials: ["NCT1", "NCT2", "NCT3"].map((registryId) => ({ registryId })), fit: true, topK, thinking: "off", thinkingCriteria: "high", estimate: { cost: 1 } } });
  const three = ["NCT1", "NCT2", "NCT3"].map(fitRow);
  const cut = await new Reader(three, [job("succeeded", 0)], 1).forPatient({ id: "s" }, "P-1");
  assert.match(cut.cutNote, /上限/u);
  const whole = await new Reader(three, [job("succeeded", 0)], 20_000).forPatient({ id: "s" }, "P-1");
  assert.equal(whole.cutNote, undefined);
  assert.equal(whole.progress.state, "done");
  // A job cancelled after stage one: stopped, and what a continuation would start is the clause work owed.
  const cancelled = new Reader(three, [job("canceled")], 20_000);
  const page = await cancelled.forPatient({ id: "s" }, "P-1");
  assert.equal(page.progress.state, "stopped");
  assert.deepEqual(page.progress.clauses, { wanted: 2, done: 0, left: 2 });
  assert.equal((await cancelled.resumeSelection({ id: "s" }, { direction: "patient_to_trial", subjectKey: "P-1" })).ids.length, 2);
  // Every clause call failed: the same, and the page's list of what failed says which stage.
  const failedClause = (target) => ({ id: `c${target}`, subject_key: "P-1", target_kind: "candidate_trial", target_id: target, mode: "criteria", status: "failed", error_code: "vcr_match_judge_cut_off", updated_at: new Date(), target: { registryId: target, id: target } });
  const lost = await new Reader([...three, failedClause("NCT1"), failedClause("NCT2")], [job("succeeded")], 20_000).forPatient({ id: "s" }, "P-1");
  assert.equal(lost.progress.state, "stopped");
  assert.equal(lost.failed.count, 2);
  assert.match(lost.failed.listed[0].reason, /^逐条判定没有完成/u);
  assert.match(lost.trials.find((row) => row.id === "NCT1").clausesNote, /^逐条判定没有完成/u);
});
