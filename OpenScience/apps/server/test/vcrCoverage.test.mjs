// 「从方案出发查覆盖」: which of a protocol's criteria a snapshot's columns can answer, made into the cohort rules the engine evaluates
// three-valued, and the ones that cannot be said by name. The counts are the engine's; this is the choice of rules.
import assert from "node:assert/strict";
import test from "node:test";
import { validateRowRule } from "@evimed/domain";

import { VCR_COVERAGE_SKIP_REASONS, vcrCohortRulesFromCriteria, vcrCriterionCodes } from "../src/vcrCoverage.mjs";

const fieldMap = [
  { column: "AGE", alias: "age", parameter: null, concept: "Age at consent", unit: "years", identifier: false },
  { column: "ECOGBL", alias: "ecog", parameter: "ECOG", concept: "ECOG performance status", unit: null, identifier: false },
  { column: "EGFRMUT", alias: null, parameter: "egfr_mutation", concept: "EGFR mutation status", unit: null, identifier: false },
  { column: "SEX", alias: "sex", parameter: null, concept: "Sex", unit: null, identifier: false },
  { column: "USUBJID", alias: null, parameter: null, concept: "Subject", unit: null, identifier: true },
  { column: "ALT1", alias: "alt", parameter: null, concept: "ALT", unit: "U/L", identifier: false },
  { column: "ALT2", alias: "alt", parameter: null, concept: "ALT", unit: "U/L", identifier: false },
  { column: "WBC1", alias: "wbc", parameter: null, concept: null, unit: "10^9/L", identifier: false },
  { column: "WBC2", alias: null, parameter: null, concept: "wbc", unit: "10^9/L", identifier: false },
];
const criterion = (id, ordinal, kind, requirement, extra = {}) => ({ id, ordinal, kind, requirement, applicability: null, ...extra });

test("a criterion's code is its place among the inclusions or the exclusions of the protocol", () => {
  const codes = vcrCriterionCodes([criterion("c3", 3, "exclusion", {}), criterion("c1", 1, "inclusion", {}), criterion("c2", 2, "inclusion", {}), criterion("c4", 4, "exclusion", {})]);
  assert.deepEqual([...codes.entries()].sort(), [["c1", "I1"], ["c2", "I2"], ["c3", "E1"], ["c4", "E2"]]);
});

test("the criteria a snapshot can answer become cohort rules the engine's own grammar accepts, each named by its code", () => {
  const { rules, skipped } = vcrCohortRulesFromCriteria({ fieldMap, criteria: [
    criterion("c1", 1, "inclusion", { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "years" }),
    criterion("c2", 2, "inclusion", { op: "compare", variable: "ecog", comparator: "between", value: 0, highValue: 1 }),
    criterion("c3", 3, "inclusion", { op: "compare", variable: "egfr_mutation", comparator: "in", value: ["exon19del", "L858R"] }),
    criterion("c4", 4, "exclusion", { op: "not", operand: { op: "compare", variable: "sex", comparator: "eq", value: "unknown" } }),
    criterion("c5", 5, "inclusion", { op: "all", operands: [{ op: "compare", variable: "age", comparator: "lt", value: 75 }, { op: "compare", variable: "ecog", comparator: "ne", value: 4 }] }),
  ] });
  assert.deepEqual(skipped, []);
  assert.deepEqual(rules.map((rule) => rule.name), ["I1", "I2", "I3", "E1", "I4"]);
  assert.deepEqual(rules[0].rule, { op: "compare", column: "age", comparator: "gte", value: 18 });
  assert.deepEqual(rules[1].rule, { op: "between", column: "ecog", low: 0, high: 1 }, "the column is the alias the analysis table carries");
  assert.deepEqual(rules[2].rule, { op: "in", column: "EGFRMUT", values: ["exon19del", "L858R"] }, "a variable meets the column by its parameter, with no alias");
  assert.ok(rules.every((rule) => rule.unknownAs === "exclude"));
  for (const { rule } of rules) assert.deepEqual(validateRowRule(rule, { columns: ["age", "ecog", "EGFRMUT", "sex"] }), [], JSON.stringify(rule));
});

test("a criterion the snapshot cannot answer is said by name and never evaluated on the part that could be", () => {
  const { rules, skipped } = vcrCohortRulesFromCriteria({ fieldMap, criteria: [
    criterion("c1", 1, "inclusion", { op: "compare", variable: "age", comparator: "gte", value: 18 }),
    criterion("c2", 2, "inclusion", { op: "compare", variable: "bmi", comparator: "lt", value: 30 }),
    criterion("c3", 3, "inclusion", { op: "compare", variable: "alt", comparator: "lt", value: 80, unit: "U/L" }),
    criterion("c4", 4, "exclusion", { op: "absent", variable: "myocardial_infarction", window: { months: 6 } }),
    criterion("c5", 5, "inclusion", { op: "compare", variable: "age", comparator: "gte", value: 18, window: { days: 28 } }),
    criterion("c6", 6, "inclusion", { op: "language", key: "consent", text: "能理解并签署知情同意书" }),
    criterion("c7", 7, "inclusion", { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "months" }),
    criterion("c8", 8, "inclusion", { op: "compare", variable: "ecog", comparator: "lt", value: "two" }),
    criterion("c9", 9, "inclusion", { op: "all", operands: [{ op: "compare", variable: "age", comparator: "gte", value: 18 }, { op: "elapsed_since", variable: "chemotherapy", days: 28 }] }),
    criterion("c10", 10, "inclusion", { op: "compare", variable: "wbc", comparator: "gt", value: 3 }),
    criterion("c11", 11, "inclusion", { op: "made_up" }),
  ] });
  // two columns of different files that carry one alias are one column of the analysis table: ALT is answered
  assert.deepEqual(rules.map((rule) => rule.name), ["I1", "I3"], "only the first and the third could be answered");
  const reasons = Object.fromEntries(skipped.map((entry) => [entry.code, entry.reason]));
  assert.deepEqual(reasons, { I2: "no_column", E1: "needs_events", I4: "needs_window", I5: "needs_reading", I6: "unit_differs",
    I7: "not_a_number", I8: "needs_events", I9: "ambiguous_column", I10: "unreadable" });
  for (const entry of skipped) assert.equal(entry.why, VCR_COVERAGE_SKIP_REASONS[entry.reason], "each reason is a sentence for the reader");
  assert.ok(skipped.every((entry) => !/[a-z_]{6,}/.test(entry.why)), "no code in the sentence");
});

test("a criterion that does not apply to everyone keeps the people it does not apply to", () => {
  const { rules } = vcrCohortRulesFromCriteria({ fieldMap, criteria: [criterion("c1", 1, "inclusion",
    { op: "compare", variable: "ecog", comparator: "lte", value: 1 }, { applicability: { op: "compare", variable: "sex", comparator: "in", value: ["female"] } })] });
  assert.deepEqual(rules[0].rule, { op: "any", operands: [{ op: "not", operand: { op: "in", column: "sex", values: ["female"] } },
    { op: "compare", column: "ecog", comparator: "lte", value: 1 }] }, "TRUE where it does not apply, the requirement where it does");
  // an applicability the snapshot cannot answer skips the criterion, not the requirement alone
  const skipped = vcrCohortRulesFromCriteria({ fieldMap, criteria: [criterion("c1", 1, "inclusion", { op: "compare", variable: "ecog", comparator: "lte", value: 1 },
    { applicability: { op: "compare", variable: "pregnancy", comparator: "eq", value: "yes" } })] });
  assert.deepEqual(skipped.rules, []);
  assert.equal(skipped.skipped[0].reason, "no_column");
});
