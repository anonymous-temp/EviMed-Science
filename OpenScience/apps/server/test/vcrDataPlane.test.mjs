// 「虚拟临研」's data plane without a database: where patient-level bytes may
// live, what an aggregate handed to a model may say, what the three ADaM
// shapes must hold, and what the snapshot profiler finds.
//
// The profiler cases run the real `scripts/vcr/profile_snapshot.py` against
// real files. A double would prove that the double works: the whole point of
// C2-24 is that an injected defect is caught by the category that should catch
// it, and only the script decides that.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { VCR_MIN_CELL_SIZE, VCR_QUALITY_CATEGORIES } from "@evimed/domain";
import {
  VCR_ANALYSIS_TABLE_BLOCKING_ISSUES, VCR_DATA_PLANE_CODES, VCR_PROFILER_SCRIPT,
  analysisTableIssues, assertDataPlaneLocation, assertDataPlaneRoot, parseDelimited,
  qualitySummary, rowsVisibleAsOf, sha256OfFile, snapshotClocks, suppressSmallCells, treatmentEvidence,
} from "../src/vcrDataPlane.mjs";

/** @type {string} */
let scratch;
before(async () => { scratch = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-dataplane-")); });
after(async () => { if (scratch) await fs.rm(scratch, { recursive: true, force: true }); });

/** @param {string} name @param {string} body */
async function write(name, body) {
  const file = path.join(scratch, name);
  await fs.writeFile(file, body, "utf8");
  return file;
}

/**
 * Run the profiler the way the control plane does — the field map on stdin —
 * and hand back both the raw bytes and the parsed JSON. The bytes matter: the
 * determinism and the sealing cases are assertions about what the file says,
 * not about what `JSON.parse` makes of it.
 * @param {string[]} files @param {Record<string, any>} fieldMap @param {string[]} [extra]
 */
async function profile(files, fieldMap, extra = []) {
  const args = [VCR_PROFILER_SCRIPT, ...files, "--json", "-", ...extra];
  const text = await new Promise((resolve, reject) => {
    const child = spawn("python3", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`profiler exited ${code}: ${err}`))));
    child.stdin.end(JSON.stringify(fieldMap));
  });
  return { text, json: JSON.parse(text) };
}

/** Every finding of one Kahn category. @param {any} json @param {string} category */
const checks = (json, category) => json.quality[category].map((/** @type {any} */ item) => item.check);

// ---------------------------------------------------------------------------
// Where patient-level bytes may live (plan §8.1: never mounted into a runtime)
// ---------------------------------------------------------------------------

test("AC-03 the data plane refuses a directory a runtime can read", () => {
  assert.equal(assertDataPlaneRoot("/srv/evimed/vcr-data"), "/srv/evimed/vcr-data");
  for (const bad of ["/workspace", "/workspace/vcr", "/srv/knowledge-base/vcr", "/srv/evimed/workspace/vcr"]) {
    assert.throws(() => assertDataPlaneRoot(bad), (error) => {
      assert.equal(error.code, VCR_DATA_PLANE_CODES.locationRuntimeReadable, `${bad} was accepted`);
      return true;
    }, `${bad} was accepted`);
  }
});

test("AC-03 an unconfigured or relative data plane is refused by name", () => {
  assert.throws(() => assertDataPlaneRoot(""), (error) => error.code === VCR_DATA_PLANE_CODES.notConfigured);
  assert.throws(() => assertDataPlaneRoot("   "), (error) => error.code === VCR_DATA_PLANE_CODES.notConfigured);
  assert.throws(() => assertDataPlaneRoot("relative/dir"), (error) => error.code === VCR_DATA_PLANE_CODES.locationOutside);
});

test("AC-03 a snapshot location must be inside the data plane", () => {
  const root = "/srv/evimed/vcr-data";
  assert.equal(assertDataPlaneLocation(root, "studies/std_1/cohort.csv"), `${root}/studies/std_1/cohort.csv`);
  assert.throws(() => assertDataPlaneLocation(root, "../escape/cohort.csv"),
    (error) => error.code === VCR_DATA_PLANE_CODES.locationOutside);
  assert.throws(() => assertDataPlaneLocation(root, "/etc/passwd"),
    (error) => error.code === VCR_DATA_PLANE_CODES.locationOutside);
  assert.throws(() => assertDataPlaneLocation(root, "knowledge-base/cohort.csv"),
    (error) => error.code === VCR_DATA_PLANE_CODES.locationRuntimeReadable);
  assert.throws(() => assertDataPlaneLocation(root, ""),
    (error) => error.code === VCR_DATA_PLANE_CODES.locationOutside);
});

// ---------------------------------------------------------------------------
// AC-26: what an aggregate handed to a model may say
// ---------------------------------------------------------------------------

test("AC-26 an aggregate handed to the model has no cell under ten people", () => {
  const { aggregate, suppression } = suppressSmallCells({
    name: "baseline by arm",
    cells: [{ key: "A", n: 41, mean: 62.1 }, { key: "B", n: 3, mean: 58.4 }, { key: "C", n: 37, mean: 60.0 }],
  });
  assert.equal(suppression.minCellSize, VCR_MIN_CELL_SIZE);
  for (const cell of aggregate.cells) {
    assert.ok(cell.n == null || cell.n >= VCR_MIN_CELL_SIZE, `cell ${cell.key} kept n=${cell.n}`);
  }
  const suppressed = aggregate.cells.filter((/** @type {any} */ cell) => cell.suppressed);
  // One hidden cell is recoverable from the published total, so a second is
  // absorbed: the merged bucket must itself be at or above the floor.
  assert.ok(suppressed.length >= 2, "a single hidden cell is recoverable from the total");
  assert.equal(suppression.cellsSuppressed, suppressed.length);
  // A suppressed cell keeps what it is and loses every number it carried: a
  // mean over four people is four people.
  for (const cell of suppressed) {
    assert.equal(cell.mean, undefined);
    assert.equal(cell.n, null);
    assert.ok(cell.key);
  }
});

test("AC-26 a zero cell is suppressed too, and the whole table goes when it cannot reach the floor", () => {
  const { aggregate } = suppressSmallCells({ cells: [{ key: "A", n: 0 }, { key: "B", n: 55 }] });
  assert.equal(aggregate.cells[0].suppressed, true, "a published zero plus a published total is an exact count");
  assert.equal(aggregate.cells[1].suppressed, true);
  const tiny = suppressSmallCells({ cells: [{ key: "A", n: 2 }, { key: "B", n: 3 }] });
  assert.ok(tiny.aggregate.cells.every((/** @type {any} */ cell) => cell.suppressed), "5 people cannot be published as two cells");
});

test("AC-26 suppression reaches nested tables and leaves the caller's object alone", () => {
  const source = {
    population: { cells: [{ key: "x", n: 100 }, { key: "y", n: 90 }] },
    strata: [{ name: "site", cells: [{ key: "s1", n: 4 }, { key: "s2", n: 60 }, { key: "s3", n: 80 }] }],
    note: "四个数分开显示",
  };
  const { aggregate, suppression } = suppressSmallCells(source);
  assert.equal(suppression.tables, 2);
  assert.equal(aggregate.note, "四个数分开显示");
  assert.equal(aggregate.population.cells.length, 2);
  assert.ok(aggregate.population.cells.every((/** @type {any} */ cell) => !cell.suppressed), "big cells stay");
  assert.equal(aggregate.strata[0].cells[0].suppressed, true);
  assert.equal(source.strata[0].cells[0].n, 4, "the caller's object is untouched");
});

test("AC-26 a table that declares no head count is passed through rather than guessed at", () => {
  const { aggregate, suppression } = suppressSmallCells({ cells: [{ key: "hr", value: 0.72 }, { key: "ci", value: 0.51 }] });
  assert.equal(suppression.cellsSuppressed, 0);
  assert.equal(suppression.cellsShown, 2);
  assert.equal(aggregate.cells[0].value, 0.72);
});

test("AC-26 the floor is configurable, and an event count discloses like a head count", () => {
  const { aggregate } = suppressSmallCells({ cells: [{ key: "a", n: 12 }, { key: "b", n: 40 }] }, { minCellSize: 20 });
  assert.equal(aggregate.cells[0].suppressed, true);
  // Main thread's ruling of 2026-09-28, over this package's first reading:
  // three events are at least three people, so a cell counted in events is
  // suppressed on the same floor. The plan says 人数; disclosure is the reason
  // it says it. Simulation output never reaches this walker — it holds no
  // people — so the wider key list costs nothing where it would be wrong.
  const events = suppressSmallCells({ cells: [{ key: "a", events: 3 }, { key: "b", events: 40 }] });
  assert.equal(events.aggregate.cells[0].suppressed, true, "a cell of three events is a cell of at least three people");
  assert.equal(events.suppression.cellsSuppressed >= 1, true);
});

// ---------------------------------------------------------------------------
// C2-23: the three ADaM shapes
// ---------------------------------------------------------------------------

test("C2-23 a bad ADTTE is refused by name for each defect", () => {
  const issues = analysisTableIssues("events", [
    { USUBJID: "S1", PARAMCD: "OS", AVAL: "12.5", CNSR: "0", STARTDT: "2026-01-01", ADT: "2026-01-13" },
    { USUBJID: "S2", PARAMCD: "OS", AVAL: "-4", CNSR: "0", STARTDT: "2026-01-01", ADT: "2026-02-01" },
    { USUBJID: "S3", PARAMCD: "OS", AVAL: "9", CNSR: "2", STARTDT: "2026-01-01", ADT: "2026-02-01" },
    { USUBJID: "S4", PARAMCD: "OS", AVAL: "9", CNSR: "1", STARTDT: "2026-03-01", ADT: "2026-02-01" },
  ]);
  const named = Object.fromEntries(issues.map((issue) => [issue.issue, issue]));
  assert.equal(named["aval-negative"].rows, 1);
  assert.equal(named["cnsr-not-binary"].rows, 1);
  assert.equal(named["adt-before-startdt"].rows, 1);
  for (const issue of ["aval-negative", "cnsr-not-binary", "adt-before-startdt"]) {
    assert.equal(named[issue].blocking, true, `${issue} must stop the table being registered`);
    assert.ok(named[issue].message.length > 20, `${issue} says what is wrong`);
  }
  assert.ok(issues.every((issue) => VCR_ANALYSIS_TABLE_BLOCKING_ISSUES.includes(issue.issue)));
});

test("C2-23 an ADSL with a repeated subject is refused and a clean one is not", () => {
  const dirty = analysisTableIssues("subject", [
    { USUBJID: "S1", TRT01P: "A" }, { USUBJID: "S1", TRT01P: "B" }, { USUBJID: "S2", TRT01P: "A" },
  ]);
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].issue, "duplicate-subject-id");
  assert.deepEqual(dirty[0].examples, ["S1"]);
  const clean = analysisTableIssues("subject", [{ USUBJID: "S1" }, { USUBJID: "S2" }]);
  assert.deepEqual(clean, []);
});

test("C2-23 a missing required column is named and stops the value checks", () => {
  const issues = analysisTableIssues("events", [{ USUBJID: "S1", PARAMCD: "OS", AVAL: "-1" }]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].issue, "missing-required-column");
  assert.equal(issues[0].column, "CNSR");
  assert.deepEqual(analysisTableIssues("longitudinal", [{ USUBJID: "S1", PARAMCD: "SYSBP", AVAL: "130" }]), []);
  assert.throws(() => analysisTableIssues("adsl", []), TypeError, "a shape outside the vocabulary is a programming error");
});

test("C2-23 a BDS analysis value that is not a number is named", () => {
  const issues = analysisTableIssues("longitudinal", [
    { USUBJID: "S1", PARAMCD: "SYSBP", AVAL: "130" },
    { USUBJID: "S2", PARAMCD: "SYSBP", AVAL: "偏高" },
    { USUBJID: "S3", PARAMCD: "", AVAL: "128" },
  ]);
  const named = Object.fromEntries(issues.map((issue) => [issue.issue, issue]));
  assert.equal(named["aval-not-numeric"].rows, 1);
  assert.equal(named["aval-not-numeric"].blocking, true);
  assert.equal(named["missing-paramcd"].rows, 1);
  assert.equal(named["missing-paramcd"].blocking, false, "a missing parameter code is advisory, not a shape failure");
});

// ---------------------------------------------------------------------------
// AC-15 (data side) and AC-06: three clocks, and unknown is not absent
// ---------------------------------------------------------------------------

test("AC-06 AC-15 a historical replay sees only what was visible then", () => {
  const fieldMaps = [
    { columnName: "LAB_DATE", timeKind: "occurred_at" },
    { columnName: "ENTERED", timeKind: "recorded_at" },
    { columnName: "SHARED", timeKind: "visible_at" },
    { columnName: "LDH", timeKind: null },
  ];
  assert.deepEqual(snapshotClocks(fieldMaps),
    { occurred_at: ["LAB_DATE"], recorded_at: ["ENTERED"], visible_at: ["SHARED"], unmapped: ["LDH"] });
  const rows = [
    { LAB_DATE: "2026-01-01", ENTERED: "2026-01-05", SHARED: "2026-01-12", LDH: "210" },
    { LAB_DATE: "2026-01-02", ENTERED: "2026-01-06", SHARED: "2026-02-20", LDH: "260" },
    { LAB_DATE: "2026-01-03", ENTERED: "2026-01-07", SHARED: "", LDH: "300" },
  ];
  const replay = rowsVisibleAsOf(rows, fieldMaps, "2026-01-20T00:00:00Z");
  assert.equal(replay.decidable, true);
  assert.equal(replay.rows.length, 1, "only the row the platform could already see");
  assert.equal(replay.hidden, 1);
  assert.equal(replay.undated, 1, "a row with no visibility date is withheld, not admitted");
  assert.equal(replay.rows[0].LDH, "210");
  // The event date is not the visibility date: filtering on it would admit
  // both later rows, which is the leak AC-15 exists to catch.
  const wrong = rows.filter((row) => Date.parse(row.LAB_DATE) <= Date.parse("2026-01-20T00:00:00Z"));
  assert.equal(wrong.length, 3);
});

test("AC-06 AC-15 a snapshot with no visibility clock says so instead of guessing", () => {
  const replay = rowsVisibleAsOf([{ A: "1" }], [{ columnName: "A", timeKind: "occurred_at" }], "2026-01-20T00:00:00Z");
  assert.equal(replay.decidable, false);
  assert.equal(replay.reason, "no-visible-at-column");
  assert.deepEqual(replay.rows, []);
  assert.throws(() => rowsVisibleAsOf([], [], "not a date"), TypeError);
});

test("AC-06 an unknown treatment is never read as no treatment", () => {
  const restricted = { missingReason: "restricted_in_trial" };
  assert.equal(treatmentEvidence("", restricted).evidence, "unknown");
  assert.equal(treatmentEvidence("", restricted).value, null);
  assert.equal(treatmentEvidence("", restricted).missingReason, "restricted_in_trial");
  assert.match(String(treatmentEvidence("", restricted).note), /未知的治疗不等于没有治疗/);
  assert.equal(treatmentEvidence("  ", null).evidence, "unknown", "no field map is still not an absence");
  assert.equal(treatmentEvidence("", { missingReason: "not_applicable" }).evidence, "not_applicable");
  assert.equal(treatmentEvidence("卡铂 AUC5", restricted).evidence, "recorded");
  assert.equal(treatmentEvidence("卡铂 AUC5", restricted).value, "卡铂 AUC5");
});

// ---------------------------------------------------------------------------
// Reading the bytes the control plane is allowed to read
// ---------------------------------------------------------------------------

test("the delimited reader handles quotes, embedded separators and blank lines", () => {
  const parsed = parseDelimited('USUBJID,NOTE\r\nS1,"a,b"\r\nS2,"say ""hi"""\r\n\r\nS3,plain\r\n');
  assert.deepEqual(parsed.header, ["USUBJID", "NOTE"]);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0].NOTE, "a,b");
  assert.equal(parsed.rows[1].NOTE, 'say "hi"');
  assert.equal(parsed.rows[2].USUBJID, "S3");
});

test("a file's sha256 is the file's, not the path's", async () => {
  const a = await write("hash-a.csv", "USUBJID\nS1\n");
  const b = await write("hash-b.csv", "USUBJID\nS1\n");
  const c = await write("hash-c.csv", "USUBJID\nS2\n");
  assert.equal(await sha256OfFile(a), await sha256OfFile(b));
  assert.notEqual(await sha256OfFile(a), await sha256OfFile(c));
});

test("the quality summary counts every Kahn category, present or not", () => {
  const summary = qualitySummary({ conformance: [{}, {}], plausibility: [{}] });
  assert.deepEqual(Object.keys(summary.categories).sort(), [...VCR_QUALITY_CATEGORIES].sort());
  assert.equal(summary.categories.conformance, 2);
  assert.equal(summary.categories.linkage, 0);
  assert.equal(summary.findings, 3);
  assert.equal(qualitySummary({}).findings, 0);
});

// ---------------------------------------------------------------------------
// C2-24: an injected defect is caught by the category that should catch it
// ---------------------------------------------------------------------------

test("C2-24 each injected defect is caught by its own Kahn category", async () => {
  const file = await write("defects.csv", [
    "USUBJID,AGE,HEIGHT_CM,VISIT_DATE,ENTERED,SHARED,DX_CODE",
    "S001,54,168,2026-01-05,2026-01-07,2026-01-12,C34.9",
    "S001,61,171,2026-02-05,2026-02-07,2026-02-12,C34.9",  // duplicate subject id
    "S003,204,165,2026-03-05,2026-03-07,2026-03-12,C50.1", // out-of-range age
    "S004,47,166,2031-03-05,2026-03-07,2026-03-12,C50.1",  // a date in the future
    "S005,52,167,2026-04-05,2026-04-01,2026-04-12,ZZZZZ",  // recorded before it happened; bad code
    "",
  ].join("\n"));
  const fieldMap = {
    USUBJID: { concept: "subject", subjectKey: true },
    AGE: { concept: "age", unit: "year", range: [0, 120] },
    HEIGHT_CM: { concept: "height", unit: "cm", range: [20, 260] },
    VISIT_DATE: { timeKind: "occurred_at" },
    ENTERED: { timeKind: "recorded_at" },
    SHARED: { timeKind: "visible_at" },
    DX_CODE: { codingSystem: "icd10" },
  };
  const { json } = await profile([file], fieldMap);

  assert.ok(checks(json, "duplication").includes("duplicate-subject-id"), "a repeated subject id is duplication");
  assert.ok(checks(json, "plausibility").includes("atemporal-implausible-value"), "an age of 204 is plausibility");
  assert.ok(checks(json, "plausibility").includes("temporal-future-date"), "a 2031 visit is plausibility (temporal)");
  assert.ok(checks(json, "plausibility").includes("temporal-clock-order"), "recorded before it happened is plausibility");
  assert.ok(checks(json, "conformance").includes("value-range-conformance"), "outside the declared range is conformance");
  assert.ok(checks(json, "conformance").includes("coding-conformance"), "a value outside ICD-10's shape is conformance");
  assert.ok(json.quality.plausibility.every((/** @type {any} */ item) => item.severity === "advisory"),
    "every new check is advisory (principle 4)");
  assert.deepEqual(Object.keys(json.quality).sort(), [...VCR_QUALITY_CATEGORIES].sort());
  assert.equal(json.counts.findings,
    VCR_QUALITY_CATEGORIES.reduce((total, category) => total + json.quality[category].length, 0));
});

test("C2-24 a unit mistake is a scale finding with the factor, not a column of typos", async () => {
  const file = await write("units.csv", ["USUBJID,HEIGHT_CM", "S1,1.68", "S2,1.71", "S3,1.72", "S4,1.65", ""].join("\n"));
  const { json } = await profile([file], { HEIGHT_CM: { concept: "height", unit: "cm", range: [20, 260] } });
  const scale = json.quality.conformance.find((/** @type {any} */ item) => item.check === "unit-scale-mismatch");
  assert.ok(scale, "a whole column outside its declared range is a scale mistake");
  assert.equal(scale.suspectedFactor, 100, "the correction factor is what makes it fixable");
  assert.equal(scale.unit, "cm");
  const oneTypo = await profile([await write("typo.csv", ["USUBJID,HEIGHT_CM", "S1,168", "S2,171", "S3,4000", ""].join("\n"))],
    { HEIGHT_CM: { concept: "height", unit: "cm", range: [20, 260] } });
  assert.ok(!checks(oneTypo.json, "conformance").includes("unit-scale-mismatch"), "one bad cell is not a scale mistake");
  assert.ok(checks(oneTypo.json, "conformance").includes("value-range-conformance"));
});

test("C2-24 a declared column that is not in the snapshot is a relational-conformance finding", async () => {
  const file = await write("thin.csv", ["USUBJID,AGE", "S1,50", ""].join("\n"));
  const { json } = await profile([file], { USUBJID: { concept: "subject" }, ECOG: { concept: "performance_status", required: true } });
  const relational = json.quality.conformance.find((/** @type {any} */ item) => item.check === "relational-conformance");
  assert.ok(relational, "the dictionary named a column the data does not have");
  assert.equal(relational.column, "ECOG");
});

test("AC-06 an unshared column is reported as unknown, never as absence", async () => {
  const file = await write("unknown-treatment.csv", ["USUBJID,TRT", "S1,", "S2,", "S3,A", ""].join("\n"));
  const { json } = await profile([file], { TRT: { concept: "treatment", missingReason: "restricted_in_trial" } });
  const found = json.quality.completeness.find((/** @type {any} */ item) => item.check === "unknown-is-not-absence");
  assert.ok(found, "a restricted column's blanks are unknown");
  assert.equal(found.rows, 2);
  assert.match(found.message, /不能当作没有发生/);
  const undeclared = await profile([await write("no-reason.csv", ["USUBJID,TRT", "S1,", "S2,A", ""].join("\n"))], {});
  assert.ok(checks(undeclared.json, "completeness").includes("missing-reason-undeclared"),
    "blanks with no stated reason are the finding, not a silent zero");
});

test("AC-32 a sealed column has no statistics in the profile and no findings about it", async () => {
  const file = await write("sealed.csv", [
    "USUBJID,AGE,OS_EVENT,OS_TIME",
    "S1,54,1,410", "S2,61,0,377", "S3,204,1,-5", "",
  ].join("\n"));
  const fieldMap = { AGE: { concept: "age", range: [0, 120] }, OS_TIME: { concept: "age", range: [0, 120] } };
  const open = await profile([file], fieldMap);
  const openColumns = open.json.profile.tables[0].columns.map((/** @type {any} */ column) => column.name);
  assert.ok(openColumns.includes("OS_TIME"));

  const { json, text } = await profile([file], fieldMap, ["--sealed-fields", "OS_EVENT,OS_TIME"]);
  const columns = Object.fromEntries(json.profile.tables[0].columns.map((/** @type {any} */ column) => [column.name, column]));
  assert.deepEqual(columns.OS_EVENT, { name: "OS_EVENT", sealed: true });
  assert.deepEqual(columns.OS_TIME, { name: "OS_TIME", sealed: true });
  assert.equal(columns.OS_TIME.filled, undefined, "a sealed outcome's fill rate is an event rate");
  assert.equal(columns.AGE.filled, 3, "the open columns keep their profile");
  assert.deepEqual(json.sealed, ["OS_EVENT", "OS_TIME"]);
  for (const category of VCR_QUALITY_CATEGORIES) {
    for (const item of json.quality[category]) {
      assert.notEqual(item.column, "OS_TIME", `${category} leaked a finding about a sealed column`);
      assert.notEqual(item.column, "OS_EVENT", `${category} leaked a finding about a sealed column`);
    }
  }
  assert.ok(!text.includes("410") && !text.includes("377"), "no sealed value reaches the profile text");
});

test("AC-06 AC-15 `--as-of` keeps out rows the platform could not yet see", async () => {
  const file = await write("asof.csv", [
    "USUBJID,LDH,SHARED", "S1,210,2026-01-12", "S2,260,2026-02-20", "S3,300,", "",
  ].join("\n"));
  const fieldMap = { SHARED: { timeKind: "visible_at" } };
  const { json } = await profile([file], fieldMap, ["--as-of", "2026-01-20T00:00:00Z"]);
  assert.equal(json.asOfFilter.applied, true);
  assert.equal(json.asOfFilter.hidden, 1);
  assert.equal(json.asOfFilter.undated, 1);
  assert.equal(json.snapshot.rowCount, 1);
  assert.equal(json.asOf, "2026-01-20T00:00:00Z");
  const all = await profile([file], fieldMap);
  assert.equal(all.json.snapshot.rowCount, 3);
  assert.equal(all.json.asOfFilter.applied, false);
});

test("the snapshot profile is byte-identical for the same input", async () => {
  const file = await write("determinism.csv", [
    "USUBJID,AGE,SHARED", "S1,54,2026-01-12", "S2,61,2026-02-20", "",
  ].join("\n"));
  const fieldMap = { AGE: { concept: "age", range: [0, 120] }, SHARED: { timeKind: "visible_at" } };
  const first = await profile([file], fieldMap, ["--as-of", "2026-03-01T00:00:00Z"]);
  const second = await profile([file], fieldMap, ["--as-of", "2026-03-01T00:00:00Z"]);
  assert.equal(first.text, second.text, "same bytes in, same bytes out");
  // The only instant in the profile is the one the caller declared. A profile
  // that carried the wall clock would differ between two runs of the same
  // snapshot, and a snapshot that profiles differently is not frozen.
  const instants = [...first.text.matchAll(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(instants)], ["2026-03-01T00:00:00Z"]);
  assert.ok(!/generatedAt|profiledAt|runAt|timestamp/i.test(first.text), "no key records when the profiler ran");
  assert.equal(first.json.snapshot.files[0].sha256, `sha256:${await sha256OfFile(file)}`);
});

test("AC-26 a profile's vocabulary drops every entry standing for fewer than ten rows", async () => {
  // Twelve people on arm A, three on arm B, and everybody's own survival time.
  const rows = ["USUBJID,ARM,OS_TIME"];
  for (let index = 1; index <= 12; index += 1) rows.push(`S${String(index).padStart(3, "0")},A,${300 + index}`);
  for (let index = 13; index <= 15; index += 1) rows.push(`S${String(index).padStart(3, "0")},B,${300 + index}`);
  const file = await write("vocabulary.csv", `${rows.join("\n")}\n`);
  const { json, text } = await profile([file], {});
  const columns = Object.fromEntries(json.profile.tables[0].columns.map((/** @type {any} */ column) => [column.name, column]));
  assert.equal(json.minCellSize, VCR_MIN_CELL_SIZE);
  // The arm that 12 people share is a category and stays; the one 3 share is
  // three people and goes, and so does every distinct survival time.
  assert.deepEqual(columns.ARM.vocabulary.values, [["A", 12]]);
  assert.equal(columns.ARM.vocabulary.suppressedValues, 1);
  assert.equal(columns.ARM.vocabulary.complete, false, "a partial vocabulary says it is partial");
  assert.deepEqual(columns.OS_TIME.vocabulary.values, []);
  assert.equal(columns.OS_TIME.vocabulary.suppressedValues, 15);
  assert.ok(!text.includes("312") && !text.includes("315"), "no individual's survival time reaches the profile");
  assert.equal(columns.OS_TIME.distinct, 15, "the shape of the column is still reported");
  assert.equal(columns.OS_TIME.filled, 15);
});

test("AC-03 a column the field map calls an identifier is masked whatever its name looks like", async () => {
  const file = await write("adam-ids.csv", ["USUBJID,ECOG", "S001,1", "S002,0", ""].join("\n"));
  const bare = await profile([file], {});
  const declared = await profile([file], { USUBJID: { concept: "subject", subjectKey: true, identifier: true } });
  const column = (/** @type {any} */ json) =>
    json.profile.tables[0].columns.find((/** @type {any} */ entry) => entry.name === "USUBJID");
  // The base profiler's name rule needs a subject token plus an id-shaped
  // suffix token; `USUBJID` is one token and passes it.
  assert.deepEqual(column(bare.json).vocabulary.values, [], "under ten rows every value goes anyway");
  assert.equal(column(declared.json).vocabulary.identifying, true);
  assert.equal(column(declared.json).vocabulary.maskedBy, "field-map");
  assert.ok(!declared.text.includes("S001"), "the study's own dictionary is the authority");
});

test("AC-03 the profiler masks identifying columns rather than printing their values", async () => {
  const file = await write("identifiers.csv", [
    "PATIENT_NAME,MOBILE,AGE", "张三,13800138000,54", "李四,13900139000,61", "",
  ].join("\n"));
  const { json, text } = await profile([file], {});
  const masked = json.profile.masking.map((/** @type {any} */ entry) => entry.column).sort();
  assert.deepEqual(masked, ["MOBILE", "PATIENT_NAME"]);
  assert.ok(!text.includes("13800138000"), "a mobile number never reaches the profile");
  assert.ok(!text.includes("张三"), "a personal name never reaches the profile");
  const age = json.profile.tables[0].columns.find((/** @type {any} */ column) => column.name === "AGE");
  assert.equal(age.vocabulary.identifying, false, "the clinical column keeps its vocabulary");
});
