import assert from "node:assert/strict";
import test from "node:test";

import { columnForVariable, matchingVariablesOf, subjectTableFacts } from "../src/vcrMatchingTable.mjs";
import { assessSubject } from "../src/vcrMatching.mjs";

test("the variables a criterion asks are collected through every connective, its applicability included, and a language node asks the model", () => {
  const criteria = [
    { id: "c1", requirement: { op: "all", operands: [{ op: "compare", variable: "age", comparator: "gte", value: 18 }, { op: "not", operand: { op: "present", variable: "pregnancy" } }] } },
    { id: "c2", requirement: { op: "any", operands: [{ op: "language", key: "k" }, { op: "elapsed_since", variable: "last_chemo", days: 28 }] },
      applicability: { op: "compare", variable: "sex", comparator: "eq", value: "female" } },
    { id: "c3", requirement: null },
  ];
  assert.deepEqual(matchingVariablesOf(criteria), ["age", "last_chemo", "pregnancy", "sex"]);
  assert.deepEqual(matchingVariablesOf([]), []);
});

test("a variable maps to a column only by an exact name, the alias before the concept before the source column; two at one level answer nothing", () => {
  const columns = [
    { name: "age", source: "AGE_Y", concept: "age" }, { name: "ecog", source: "ECOG", concept: "performance_status" },
    { name: "gender", source: "SEX", concept: "sex" }, { name: "hb", source: "HGB", concept: "haemoglobin" }, { name: "hb2", source: "HGB2", concept: "haemoglobin" },
  ];
  assert.equal(columnForVariable("age", columns).column.name, "age");
  assert.equal(columnForVariable("performance_status", columns).column.name, "ecog", "by the concept the field map gave it");
  assert.equal(columnForVariable("HGB", columns).column.name, "hb", "by the source column when nothing says otherwise");
  assert.equal(columnForVariable("sex", columns).column.name, "gender", "sex and gender are one variable");
  assert.deepEqual(columnForVariable("haemoglobin", columns), { column: null, ambiguous: true }, "two columns of one concept: nothing is guessed");
  assert.deepEqual(columnForVariable("creatinine", columns), { column: null, ambiguous: false });
  assert.deepEqual(columnForVariable("", columns), { column: null, ambiguous: false });
  // a column named like another's concept does not outrank the alias
  assert.equal(columnForVariable("age", [{ name: "x", concept: "age" }, { name: "age", concept: "other" }]).column.name, "age");
});

const COLUMNS = [
  { name: "age", source: "AGE", concept: "age", unit: "year", type: "integer" },
  { name: "sex", source: "SEX", concept: "sex", unit: null, type: null },
  { name: "last_chemo", source: "CHEMO_DT", concept: "last_chemo", unit: null, type: "date" },
  { name: "hb", source: "HGB", concept: "haemoglobin", unit: "g/L", type: "number" },
];
const table = (rows) => ({ header: ["USUBJID", "age", "sex", "last_chemo", "hb"], rows, snapshotId: "snp_9", columns: COLUMNS });

test("each row is a candidate, a blank cell is no fact, a number is a number and a date places the fact in time", () => {
  const built = subjectTableFacts({ ...table([["P1", "54", "F", "2026-08-01", "128"], ["P2", "", "M", "", "n/a"], ["P3", "", "", "", ""]]),
    variables: ["age", "sex", "last_chemo", "hb", "creatinine"] });
  assert.deepEqual(built.subjects.map((subject) => [subject.subjectKey, subject.facts.length]), [["P1", 4], ["P2", 2], ["P3", 0]], "a person with nothing recorded is still a candidate");
  const [age, sex, chemo, hb] = built.subjects[0].facts;
  assert.deepEqual([age.value, age.unit, age.extractedBy, age.polarity, age.hideValue], [54, "year", "code", "affirmed", true]);
  assert.equal(sex.value, "F");
  assert.equal(chemo.occurredAt, "2026-08-01T00:00:00.000Z");
  assert.deepEqual([hb.value, hb.unit], [128, "g/L"]);
  assert.deepEqual(built.subjects[1].facts.find((fact) => fact.variable === "hb").value, "n/a", "a cell that is not a number stays text, and a comparison of it is unknown");
  assert.deepEqual(built.unmapped, ["creatinine"]);
  assert.deepEqual(built.mapped.map((item) => item.variable), ["age", "sex", "last_chemo", "hb"]);
  assert.ok(built.subjects[0].facts.every((fact) => fact.id.startsWith("tbl:snp_9:P1:") && fact.snapshot.id === "snp_9"), "a fact says which snapshot and which column it came from");
});

test("a row with no key, a key seen twice, and rows past the limit are not evaluated and are counted", () => {
  const built = subjectTableFacts({ ...table([["P1", "1", "", "", ""], ["", "2", "", "", ""], ["P1", "3", "", "", ""], ["P2", "4", "", "", ""], ["P3", "5", "", "", ""]]), variables: ["age"], limit: 2 });
  assert.deepEqual(built.subjects.map((subject) => subject.subjectKey), ["P1", "P2"]);
  assert.equal(built.rows, 5);
  assert.equal(built.notEvaluated, 3);
  const keyless = subjectTableFacts({ header: ["age"], rows: [["54"]], snapshotId: "s", columns: COLUMNS, variables: ["age"] });
  assert.deepEqual(keyless.subjects, [], "a table with no subject column names nobody");
});

test("the facts feed the one evaluator: unknown where the table holds nothing, a window needs a date, a unit needs a unit", () => {
  const built = subjectTableFacts({ ...table([["P1", "54", "F", "2026-09-20", "128"], ["P2", "17", "M", "", ""], ["P3", "60", "F", "2026-10-01", ""]]), variables: ["age", "sex", "last_chemo", "hb"] });
  const criteria = [
    { id: "age", kind: "inclusion", criterionType: "demographic", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18 } },
    { id: "hb", kind: "inclusion", criterionType: "lab", requirement: { op: "compare", variable: "hb", comparator: "gte", value: 100, unit: "g/L" } },
    { id: "hb_g_dl", kind: "inclusion", criterionType: "lab", requirement: { op: "compare", variable: "hb", comparator: "gte", value: 10, unit: "g/dL" } },
    { id: "washout", kind: "inclusion", criterionType: "prior_treatment", requirement: { op: "elapsed_since", variable: "last_chemo", days: 14 } },
    { id: "pregnancy", kind: "exclusion", criterionType: "pregnancy", requirement: { op: "present", variable: "pregnancy" } },
  ];
  const states = (facts) => Object.fromEntries(assessSubject({ studyId: "s", subjectKey: "x", criteria, facts, asOf: "2026-10-05T00:00:00.000Z" }).judgments.map((judgment) => [judgment.criterionId, judgment.state]));
  const first = states(built.subjects[0].facts);
  assert.equal(first.age, "satisfied");
  assert.equal(first.hb, "satisfied");
  assert.equal(first.hb_g_dl, "unknown", "g/L to g/dL is a conversion nobody told the evaluator: unknown, never a raw comparison");
  assert.equal(first.washout, "satisfied", "the last dose was 15 days before the instant and 14 are needed");
  assert.equal(states(built.subjects[2].facts).washout, "pending_recheck", "four days ago: not yet, and the answer changes on a known day");
  assert.equal(first.pregnancy, "unknown", "a variable no column holds is not recorded");
  const second = states(built.subjects[1].facts);
  assert.equal(second.age, "not_satisfied");
  assert.equal(second.hb, "unknown");
  assert.equal(second.washout, "unknown");
});
