// A person judged not eligible is a person on the matching page: listed with the rule they fail, opened to their rule-by-rule
// judgement on request, and counted as an evaluation that exists. The page used to list only the people still in play, so a study
// whose assessed people were all not eligible read as one where nothing had been generated.
import assert from "node:assert/strict";
import test from "node:test";

import { presentMatchingTab } from "../src/vcrViewsTabs.mjs";

const NOW = new Date("2026-10-30T00:00:00.000Z");
const criteria = [
  { id: "crt_1", kind: "inclusion", ordinal: 1, sourceText: "年龄 ≥ 18 岁", criterionType: "demographic" },
  { id: "crt_2", kind: "exclusion", ordinal: 2, sourceText: "活动性脑转移", criterionType: "comorbidity" },
];
const subject = (key, summary, counts) => ({ id: `asm_${key}`, subjectKey: key, summary, counts, direction: "trial_to_patient", asOf: "2026-10-01T00:00:00.000Z", reviewedBy: null });
const judgment = (criterionId, state, evidence = []) => ({ criterionId, state, applicable: true, evidence, decidedBy: "code" });

/** @param {any[]} subjects @param {Record<string, any>} [extra] */
function bundle(subjects, extra = {}) {
  const tallies = {};
  for (const row of subjects) tallies[row.summary] = (tallies[row.summary] ?? 0) + 1;
  return {
    study: { dataTier: "T2" }, now: NOW, roles: ["lead"],
    match: {
      criteria, tallies, subjects, protocol: { version: 1, title: "方案 v1" }, protocols: [], candidateRoster: subjects.map((row) => row.subjectKey),
      openByAssessment: new Map(), gapsByCriterion: new Map(), pendingReview: [], comparisons: [], timeline: [], selected: null, ...extra,
    },
    forecastResults: [], scenarios: [],
  };
}

test("everyone assessed is listed even when nobody is eligible, and the funnel is not empty", () => {
  const rows = [subject("P-1", "ineligible", { satisfied: 1, not_satisfied: 1 }), subject("P-2", "ineligible", { satisfied: 1, not_satisfied: 1 })];
  const page = presentMatchingTab(bundle(rows, { openByAssessment: new Map([["asm_P-1", [{ criterionId: "crt_1", state: "not_satisfied", recheckAt: null }]], ["asm_P-2", [{ criterionId: "crt_2", state: "not_satisfied", recheckAt: null }]]]) }));
  assert.deepEqual(page.candidates.map((row) => row.id), ["P-1", "P-2"]);
  assert.equal(page.funnel.find((step) => step.key === "candidates").count, 2);
  assert.deepEqual(page.candidates[0].failed, [{ code: "I1", state: "not_satisfied" }]);
  assert.deepEqual(page.candidates[1].failed, [{ code: "E1", state: "not_satisfied" }]);
  assert.deepEqual(page.candidates[0].open, [], "a failed rule is not an open one");
  assert.match(page.candidates[0].summary, /1 条不满足/);
});

test("the page lists the people in the order the server cut it, and says how big the table is", () => {
  // The order (those still in play first, the not-eligible after) is the query's, held by vcrMatchRulesPage.integration.test.mjs.
  const rows = [subject("B", "eligible", { satisfied: 2 }), subject("C", "insufficient_evidence", { unknown: 1 }), subject("A", "ineligible", {})];
  const page = presentMatchingTab(bundle(rows, { people: { total: 80, offset: 25, limit: 25, verdict: "ineligible" } }));
  assert.deepEqual(page.candidates.map((row) => row.id), ["B", "C", "A"]);
  assert.deepEqual(page.people, { total: 80, offset: 25, limit: 25, more: true, verdict: "ineligible" });
  assert.deepEqual(presentMatchingTab(bundle(rows)).people, { total: 3, offset: 0, limit: 3, more: false, verdict: null });
});

test("a not-eligible person asked for by name is opened to the rules they fail, with the reason as a sentence", () => {
  const rows = [subject("P-1", "eligible", { satisfied: 2 }), subject("P-9", "ineligible", { satisfied: 1, not_satisfied: 1 })];
  const evidence = [{ quote: "既往确诊活动性脑转移", locator: { documentId: "doc_1", start: 0, end: 10 }, quoteKind: "verbatim" }];
  const selected = { ...rows[1], judgments: [judgment("crt_1", "satisfied"), judgment("crt_2", "not_satisfied", evidence)] };
  const page = presentMatchingTab(bundle(rows, { selected }), { candidate: "P-9" });
  assert.equal(page.selected.candidate.id, "P-9");
  assert.equal(page.selected.candidate.eligibility, "ineligible");
  assert.deepEqual(page.selected.criteria.map((row) => [row.code, row.state]), [["I1", "satisfied"], ["E1", "not_satisfied"]]);
  assert.equal(page.selected.criteria[1].evidence.quote, "既往确诊活动性脑转移");
  assert.equal(page.selected.verdict.text, "不符合：E1 不满足");
});

test("a study with no records screens by its rules, and an assessment by an earlier set of rules says so and is offered again", () => {
  const rows = [{ ...subject("P-1", "eligible", { satisfied: 2 }), evaluatorOlder: true }, subject("P-2", "eligible", { satisfied: 2 })];
  const noRecords = presentMatchingTab(bundle(rows, { hasRecords: false }));
  assert.equal(noRecords.evaluateBy, "rules");
  assert.equal(presentMatchingTab(bundle(rows, { hasRecords: true })).evaluateBy, "model");
  assert.equal(presentMatchingTab(bundle(rows)).evaluateBy, "model", "a read that could not say goes to the path that reads what there is");
  const page = presentMatchingTab(bundle(rows));
  assert.equal(page.candidates[0].olderRules, true);
  assert.equal(page.candidates[1].olderRules, undefined);
  assert.deepEqual(page.basisUpdated, { count: 1, subjects: ["P-1"] }, "the one action that evaluates them again");
});
