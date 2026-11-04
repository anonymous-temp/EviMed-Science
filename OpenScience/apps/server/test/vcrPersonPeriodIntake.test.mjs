// A person-period file (one row per person and period, the shape registry data usually arrive in) reaches a target-trial emulation through the data plane's
// existing longitudinal shape: the field map names the period column `visit_date` and the treatment, outcome, eligibility and covariates `measurement`s,
// the derivation files one row per person, period and parameter (USUBJID, PARAMCD, AVAL, ADT), and that table passes the shape's own checks. The engine
// reads the very bytes this test derives: `tests/numeric/N80_*` case N80c runs a clone-censor-weight job on `fixtures/vcr-person-period/longitudinal.csv`.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { analysisTableIssues, deriveAnalysisShapes, normalizeFieldMap, tablesNeededBy, toCsv, validateFieldMap } from "../src/vcrDataPlane.mjs";
import { vcrOutcomeColumns } from "../src/vcrSeal.mjs";

const FIXTURE = new URL("./fixtures/vcr-person-period/longitudinal.csv", import.meta.url);

/** A small deterministic person-period table: treatment starts at a hazard that rises with age, the event hazard falls once it has started. */
function personPeriods() {
  let state = 20261109;
  const next = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
  const rows = [];
  for (let i = 1; i <= 60; i += 1) {
    const age = Math.round(50 + 20 * next());
    let started = 0;
    for (let period = 0; period < 7; period += 1) {
      if (!started && next() < 0.12 + 0.004 * (age - 50)) started = 1;
      const event = next() < (started ? 0.03 : 0.07) ? 1 : 0;
      rows.push([`REG${String(i).padStart(3, "0")}`, String(period), String(started), String(event), period === 0 ? "1" : "0", String(age)]);
      if (event) break;
    }
  }
  return { header: ["PATIENT_NO", "PERIOD", "TREATED", "EVENT", "ELIGIBLE", "AGE"], rows };
}

test("a file with one row per person and period is filed as the longitudinal shape and passes its checks", () => {
  const table = { name: "registry.csv", ...personPeriods() };
  const map = [
    { table: "registry.csv", column: "PATIENT_NO", role: "subject_key", identifier: true },
    { table: "registry.csv", column: "PERIOD", role: "visit_date" },
    { table: "registry.csv", column: "TREATED", role: "measurement", parameter: "treatment" },
    // the outcome is marked, as the notes say: that is what lets the study's seal withhold the table until the plan is frozen
    { table: "registry.csv", column: "EVENT", role: "measurement", parameter: "outcome", outcome: true },
    { table: "registry.csv", column: "ELIGIBLE", role: "measurement", parameter: "eligible" },
    { table: "registry.csv", column: "AGE", role: "measurement", parameter: "age" },
  ];
  const { columns, issues } = normalizeFieldMap(map);
  assert.deepEqual(issues, []);
  const checked = validateFieldMap(columns, [table]);
  assert.deepEqual(checked.issues, [], "the field map is valid");
  assert.deepEqual(vcrOutcomeColumns(checked.columns), ["EVENT"], "the outcome column is the one the seal withholds");
  const derived = deriveAnalysisShapes({ tables: [table], entries: checked.columns, key: Buffer.alloc(32, 7) });
  const long = derived.shapes.longitudinal;
  assert.ok(long, "a longitudinal table is derived");
  assert.deepEqual(long.header, ["USUBJID", "PARAMCD", "AVAL", "ADT"]);
  assert.deepEqual([...new Set(long.rows.map((row) => row[1]))].sort(), ["age", "eligible", "outcome", "treatment"]);
  // every person-period contributes one row per parameter, and a person-period appears with its own period number
  const perPeriod = new Map();
  for (const row of long.rows) perPeriod.set(`${row[0]}|${row[3]}`, (perPeriod.get(`${row[0]}|${row[3]}`) ?? 0) + 1);
  assert.ok([...perPeriod.values()].every((count) => count === 4), "four parameters per person-period");
  assert.equal(perPeriod.size, table.rows.length, "as many person-periods as the file has rows");
  assert.ok(long.rows.every((row) => /^\d+$/.test(row[3])), "the period is a whole number");
  // the shape's own checks: no blocking defect, and a repeated person is fine (it is not a subject table)
  const objects = long.rows.map((row) => Object.fromEntries(long.header.map((name, at) => [name, row[at]])));
  const defects = analysisTableIssues("longitudinal", objects).filter((issue) => issue.blocking);
  assert.deepEqual(defects, []);
  assert.equal(derived.shapes.subject?.rows.length ?? new Set(long.rows.map((row) => row[0])).size, new Set(long.rows.map((row) => row[0])).size);
  // the bytes the engine reads in its case N80c
  const csv = toCsv(long.header, long.rows);
  if (!existsSync(FIXTURE) || process.env.UPDATE_PERSON_PERIOD_FIXTURE === "1") writeFileSync(FIXTURE, csv);
  assert.equal(csv, readFileSync(FIXTURE, "utf8"), "the engine's fixture is what the data plane derives from the file");
});

test("a job of the target-trial method is given the longitudinal table, and a project without one gets its raw files (which the engine refuses by name)", () => {
  assert.deepEqual(tablesNeededBy("comparator.target_trial", null, ["subject", "longitudinal", "events"]), ["longitudinal"]);
  assert.deepEqual(tablesNeededBy("comparator.target_trial", null, ["subject"]), ["files"]);
  assert.deepEqual(tablesNeededBy("comparator.propensity_weight", "binary", ["subject", "longitudinal"]), ["subject"], "the other comparators still read the subject table");
});
