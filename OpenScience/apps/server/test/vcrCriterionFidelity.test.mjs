import assert from "node:assert/strict";
import test from "node:test";
import { criterionFidelityWarnings } from "../src/vcrCriterionFidelity.mjs";

const present = { op: "present", variable: "qualifying_condition" };
const absent = { op: "absent", variable: "disqualifying_condition" };
const warn = (sourceText, requirement = present, applicability = null) =>
  criterionFidelityWarnings({ sourceText, requirement, applicability });

test("explicit numeric comparisons paired only with presence rules receive an advisory", () => {
  for (const text of ["BMI >25", "BMI >= 25.5", "BMI ≥25.5", "LVEF < 40%", "LVEF <=40%",
    "LVEF ≤40%", "Change = -0.5", "Change > -.5", "Change ≥ +.5", "Change ≥ −0.5", "评分＞２５．５"]) {
    const criterion = { sourceText: text, requirement: present };
    const before = structuredClone(criterion);
    const warnings = criterionFidelityWarnings(criterion);
    assert.equal(warnings.length, 1, text);
    assert.equal(warnings[0].code, "numeric_threshold_requires_review");
    assert.match(warnings[0].message, /复核/);
    assert.deepEqual(criterion, before, "review leaves both the original clause and rule intact");
  }
});

test("Boolean combinations and applicability stay within the warning's narrow scope", () => {
  const requirement = { op: "not", operand: { op: "any", operands: [
    present, { op: "all", operands: [present, absent] },
  ] } };
  assert.equal(warn("Body mass index >25", requirement, absent).length, 1);
  assert.equal(warn("Body mass index >25", present, { op: "not", operand: absent }).length, 1);
});

test("categorical identifiers, stages and numbered statements do not imply numeric comparisons", () => {
  for (const text of ["NCT01234567", "HER2-positive", "CYP2D6 genotype", "Stage IIIB or IV",
    "2. Confirmed diagnosis", "3) No heart failure", "Second-line therapy", "2nd-line treatment",
    "Age 18 to 65 years", "At least 1 prior therapy", "Change from 10->25", ""] ) {
    assert.deepEqual(warn(text), [], text);
  }
  for (const text of [null, undefined, 25]) assert.deepEqual(warn(text), []);
});

test("numeric, temporal and language representations suppress the advisory", () => {
  const alternatives = [
    { op: "compare", variable: "body_mass_index", comparator: "gt", value: 25 },
    { op: "elapsed_since", variable: "treatment", days: 14 },
    { op: "language", key: "clause", text: "Body mass index >25" },
    { ...present, window: { months: 6 } },
  ];
  for (const node of alternatives) {
    assert.deepEqual(warn("Body mass index >25", node), []);
    assert.deepEqual(warn("Body mass index >25", { op: "all", operands: [present, node] }), []);
    assert.deepEqual(warn("Body mass index >25", present, node), []);
  }
  assert.deepEqual(warn("Body mass index >25", { op: "unknown" }), []);
  assert.deepEqual(warn("Body mass index >25", null), []);
});
