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
const subject = (key, summary, counts) => ({ id: `asm_${key}`, subjectKey: key, summary, counts, priority: null, direction: "trial_to_patient", asOf: "2026-10-01T00:00:00.000Z", reviewedBy: null });
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

test("the people still in play come first and the not-eligible ones follow", () => {
  const rows = [subject("A", "ineligible", {}), subject("B", "eligible", { satisfied: 2 }), subject("C", "insufficient_evidence", { unknown: 1 })];
  assert.deepEqual(presentMatchingTab(bundle(rows)).candidates.map((row) => row.id), ["B", "C", "A"]);
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

test("a person asked for by name is on the page even when fifty others rank before them", () => {
  const rows = Array.from({ length: 60 }, (_, index) => subject(`P-${String(index).padStart(3, "0")}`, "eligible", { satisfied: 2 }));
  rows.push(subject("Z-LAST", "ineligible", { not_satisfied: 1 }));
  const without = presentMatchingTab(bundle(rows));
  assert.equal(without.candidates.length, 50);
  assert.equal(without.candidates.some((row) => row.id === "Z-LAST"), false);
  const asked = presentMatchingTab(bundle(rows, { selected: { ...rows[60], judgments: [judgment("crt_1", "not_satisfied")] } }), { candidate: "Z-LAST" });
  assert.ok(asked.candidates.some((row) => row.id === "Z-LAST"));
  assert.equal(asked.selected.candidate.id, "Z-LAST");
});
