import assert from "node:assert/strict";
import test from "node:test";

import { cellPresence, columnForVariable, columnsWithMeaning, matchingVariablesOf, subjectTableFacts } from "../src/vcrMatchingTable.mjs";
import { assessSubject, storedExclusion } from "../src/vcrMatching.mjs";

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
    { id: "hb_mmol", kind: "inclusion", criterionType: "lab", requirement: { op: "compare", variable: "hb", comparator: "gte", value: 6, unit: "mmol/L" } },
    { id: "washout", kind: "inclusion", criterionType: "prior_treatment", requirement: { op: "elapsed_since", variable: "last_chemo", days: 14 } },
    { id: "pregnancy", kind: "exclusion", criterionType: "pregnancy", requirement: { op: "present", variable: "pregnancy" } },
  ];
  const states = (facts) => Object.fromEntries(assessSubject({ studyId: "s", subjectKey: "x", criteria, facts, asOf: "2026-10-05T00:00:00.000Z" }).judgments.map((judgment) => [judgment.criterionId, judgment.state]));
  const first = states(built.subjects[0].facts);
  assert.equal(first.age, "satisfied");
  assert.equal(first.hb, "satisfied");
  assert.equal(first.hb_g_dl, "satisfied", "g/L to g/dL is in the unit table (evimed-lab-units-4): 128 g/L is 12.8 g/dL");
  assert.equal(first.hb_mmol, "unknown", "haemoglobin in mmol/L depends on monomer or tetramer, which the table does not guess: unknown, never a raw comparison");
  assert.equal(first.washout, "satisfied", "the last dose was 15 days before the instant and 14 are needed");
  assert.equal(states(built.subjects[2].facts).washout, "pending_recheck", "four days ago: not yet, and the answer changes on a known day");
  assert.equal(first.pregnancy, "unknown", "a variable no column holds is not recorded");
  const second = states(built.subjects[1].facts);
  assert.equal(second.age, "not_satisfied");
  assert.equal(second.hb, "unknown");
  assert.equal(second.washout, "unknown");
});

// ---------------------------------------------------------------------------
// What a filled cell means (G7) and which column answers a variable (G21)
// ---------------------------------------------------------------------------

const DM_COLUMNS = [
  { name: "age", source: "AGE", concept: "age", unit: "year", type: "integer" },
  { name: "DIABETES", source: "DIABETES", concept: "", unit: null, type: "integer" },
];
const DM_CRITERIA = [
  { id: "age", kind: "inclusion", criterionType: "demographic", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18 } },
  // An exclusion is stored as the negation of the condition it names.
  { id: "dm", kind: "exclusion", criterionType: "condition", requirement: storedExclusion({ op: "present", variable: "diabetes" }) },
];
/** The model's reading of a yes/no column: these codes are absent, these present. */
const yesNo = (absent, present) => ({ columns: { DIABETES: { concept: "diabetes", valueMap: { values: { ...Object.fromEntries(absent.map((code) => [code, "absent"])), ...Object.fromEntries(present.map((code) => [code, "present"])) }, measurement: false } } } });
/** The verdict of one person whose DIABETES cell is `cell`, read through `meaning`. */
function verdictFor(cell, meaning) {
  const built = subjectTableFacts({ header: ["USUBJID", "age", "DIABETES"], rows: [["P1", "50", cell]], snapshotId: "s1", columns: DM_COLUMNS, variables: ["age", "diabetes"], meaning });
  const assessment = assessSubject({ studyId: "s", subjectKey: "P1", criteria: DM_CRITERIA, facts: built.subjects[0].facts, asOf: "2026-10-05T00:00:00.000Z" });
  return { summary: assessment.summary, dm: assessment.judgments.find((judgment) => judgment.criterionId === "dm"), facts: built.subjects[0].facts };
}

test("G7: 0, No, 否, 无, false and N are denials under the model's map: an exclusion on the column does not exclude them, and 1, 是 and Yes do", () => {
  for (const cell of ["0", "No", "否", "无", "false", "N"]) {
    const { summary, dm, facts } = verdictFor(cell, yesNo([cell], ["1", "是", "Yes", "true", "Y"]));
    assert.equal(summary, "eligible", `${cell} is not excluded`);
    assert.equal(dm.state, "satisfied", cell);
    assert.equal(facts.find((fact) => fact.variable === "diabetes").presence, "absent", cell);
  }
  for (const cell of ["1", "是", "Yes", "true", "Y"]) {
    const { summary, dm } = verdictFor(cell, yesNo(["0", "No", "否", "无", "false", "N"], [cell]));
    assert.equal(summary, "ineligible", `${cell} is excluded`);
    assert.equal(dm.state, "not_satisfied", cell);
  }
});

test("G7: a code the map does not name, a code the map calls unknown and no map at all read unknown, never excluded", () => {
  const named = yesNo(["0"], ["1"]);
  for (const [cell, meaning, label] of [["2", named, "a code the model did not name"], ["N/A", { columns: { DIABETES: { concept: "diabetes", valueMap: { values: { "N/A": "unknown", "1": "present" }, measurement: false } } } }, "unknown by the model's word"],
    ["1", { columns: { DIABETES: { concept: "diabetes" } } }, "a concept with no value map"], ["1", null, "no meaning at all"]]) {
    const { summary, dm } = verdictFor(cell, meaning);
    // The column is reached by its name and the cell is filled: what is missing is the reading of the code, and the gap says so.
    assert.equal(summary, "insufficient_evidence", label);
    assert.equal(dm.state, "unknown", label);
    assert.equal(dm.missing[0].reason, "coding_unmapped", label);
  }
});

test("G7: a declared type does not make a code an indicator: the integer column holding 0 is a denial only because the map says so", () => {
  const { facts } = verdictFor("0", { columns: { DIABETES: { concept: "diabetes" } } });
  assert.equal(facts.find((fact) => fact.variable === "diabetes").presence, "unknown");
  assert.equal(facts.find((fact) => fact.variable === "diabetes").value, 0, "the number is still the number");
});

test("a comparison reads the value and never asks what 0 means: ecog <= 1 holds for 0 whatever the map says", () => {
  const columns = [{ name: "ECOG", source: "ECOG", concept: "ecog", unit: null, type: "integer" }];
  const criteria = [{ id: "ecog", kind: "inclusion", criterionType: "performance", requirement: { op: "compare", variable: "ecog", comparator: "lte", value: 1 } }];
  const odd = { columns: { ECOG: { valueMap: { values: { "0": "absent" }, measurement: false } } } };
  for (const meaning of [null, odd, { columns: { ECOG: { valueMap: { values: {}, measurement: true } } } }]) {
    const built = subjectTableFacts({ header: ["USUBJID", "ECOG"], rows: [["P1", "0"], ["P2", "3"]], snapshotId: "s1", columns, variables: ["ecog"], meaning });
    const states = built.subjects.map((subject) => assessSubject({ studyId: "s", subjectKey: subject.subjectKey, criteria, facts: subject.facts, asOf: "2026-10-05T00:00:00.000Z" }).judgments[0].state);
    assert.deepEqual(states, ["satisfied", "not_satisfied"]);
  }
  // and a text column still compares for equality, as it always did
  const sex = subjectTableFacts({ header: ["USUBJID", "sex"], rows: [["P1", "F"]], snapshotId: "s1", columns: COLUMNS, variables: ["sex"], meaning: { columns: { sex: { valueMap: { values: { F: "absent" }, measurement: false } } } } });
  const female = [{ id: "f", kind: "inclusion", criterionType: "demographic", requirement: { op: "compare", variable: "sex", comparator: "eq", value: "female" } }];
  assert.equal(assessSubject({ studyId: "s", subjectKey: "P1", criteria: female, facts: sex.subjects[0].facts, asOf: "2026-10-05T00:00:00.000Z" }).judgments[0].state, "satisfied");
});

test("format needs no map: a real date in a date column is the event, and a number in a measurement column is the measurement being there", () => {
  assert.equal(cellPresence("2026-08-01", { type: "date" }, undefined), "present");
  assert.equal(cellPresence("unknown", { type: "date" }, undefined), "unknown");
  assert.equal(cellPresence("128", { type: "number" }, { values: {}, measurement: true }), "present");
  assert.equal(cellPresence("0", { type: "number" }, { values: {}, measurement: true }), "present", "a measured zero is a measurement");
  assert.equal(cellPresence("n/a", { type: "number" }, { values: {}, measurement: true }), "unknown");
  assert.equal(cellPresence("128", { type: "number" }, { values: {}, measurement: false }), "unknown", "a number is not an indicator unless the map says what it indicates");
  assert.equal(cellPresence("128", { type: "number" }, undefined), "unknown");
  assert.equal(cellPresence("constructor", { type: "text" }, { values: {}, measurement: false }), "unknown", "a code is looked up as its own key, never as a property");
  // the same through the evaluator, on a window-less question about a prior therapy
  const columns = [{ name: "last_chemo", source: "CHEMO_DT", concept: "last_chemo", unit: null, type: "date" }, { name: "hb", source: "HGB", concept: "hb", unit: "g/L", type: "number" }];
  const built = subjectTableFacts({ header: ["USUBJID", "last_chemo", "hb"], rows: [["P1", "2026-08-01", "128"]], snapshotId: "s1", columns, variables: ["last_chemo", "hb"],
    meaning: { columns: { hb: { valueMap: { values: {}, measurement: true } } } } });
  const criteria = [
    { id: "prior", kind: "inclusion", criterionType: "prior_treatment", requirement: { op: "present", variable: "last_chemo" } },
    { id: "hb", kind: "inclusion", criterionType: "lab", requirement: { op: "present", variable: "hb" } },
  ];
  const states = assessSubject({ studyId: "s", subjectKey: "P1", criteria, facts: built.subjects[0].facts, asOf: "2026-10-05T00:00:00.000Z" }).judgments.map((judgment) => judgment.state);
  assert.deepEqual(states, ["satisfied", "satisfied"]);
});

test("G21: a variable the model chose reaches its column by the concept the meaning recorded; the field map's concept stands, and two columns of one concept answer nothing", () => {
  const columns = [{ name: "EGFR_STATUS", source: "EGFR", concept: "", unit: null, type: "text" }, { name: "hb", source: "HGB", concept: "haemoglobin", unit: "g/L", type: "number" }];
  const meaning = { columns: { EGFR_STATUS: { concept: "egfr_mutation" }, hb: { concept: "something_else" } } };
  assert.deepEqual(columnForVariable("egfr_mutation", columns), { column: null, ambiguous: false }, "by exact name alone nothing answers");
  assert.equal(columnForVariable("egfr_mutation", columnsWithMeaning(columns, meaning)).column.name, "EGFR_STATUS");
  assert.equal(columnForVariable("something_else", columnsWithMeaning(columns, meaning)).column, null, "the field map already named that column");
  assert.equal(columnForVariable("haemoglobin", columnsWithMeaning(columns, meaning)).column.name, "hb");
  const twice = columnsWithMeaning(columns, { columns: { EGFR_STATUS: { concept: "x" }, hb: { concept: "" } } }).map((column) => (column.name === "hb" ? { ...column, concept: "x" } : column));
  assert.deepEqual(columnForVariable("x", twice), { column: null, ambiguous: true });

  const built = subjectTableFacts({ header: ["USUBJID", "EGFR_STATUS", "hb"], rows: [["P1", "Positive", "120"], ["P2", "Negative", "120"]], snapshotId: "s1", columns, variables: ["egfr_mutation"],
    meaning: { columns: { EGFR_STATUS: { concept: "egfr_mutation", valueMap: { values: { Positive: "present", Negative: "absent" }, measurement: false } } } } });
  assert.deepEqual(built.mapped, [{ variable: "egfr_mutation", column: "EGFR_STATUS" }]);
  const inclusion = [{ id: "egfr", kind: "inclusion", criterionType: "biomarker", requirement: { op: "present", variable: "egfr_mutation" } }];
  const states = built.subjects.map((subject) => assessSubject({ studyId: "s", subjectKey: subject.subjectKey, criteria: inclusion, facts: subject.facts, asOf: "2026-10-05T00:00:00.000Z" }).judgments[0].state);
  assert.deepEqual(states, ["satisfied", "not_satisfied"]);
  assert.deepEqual(subjectTableFacts({ header: ["USUBJID", "EGFR_STATUS"], rows: [["P1", "Positive"]], snapshotId: "s1", columns, variables: ["egfr_mutation"] }).unmapped, ["egfr_mutation"], "without the meaning it is unmapped, as before");
});
