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

import { VCR_MIN_CELL_SIZE, VCR_QUALITY_CATEGORIES, VCR_REAL_PATIENT_SOURCES, suppressForModel } from "@evimed/domain";
import {
  VCR_ANALYSIS_TABLE_BLOCKING_ISSUES, VCR_COLUMN_SOURCE_ORDER, VCR_DATA_PLANE_CODES, VCR_PROFILER_SCRIPT,
  analysisTableIssues, asOfIssues, assertDataPlaneLocation, assertDataPlaneRoot, checkedTable, columnSourceIssues, decodeUploadText, deriveAnalysisShapes,
  dictionaryEntries, fieldMapHash, isOutcomeEntry, jsonTable, latestDataFiles, normalizeFieldMap, parseDelimited, parseTable, profilerFieldMap, projectTable, pseudonymOf,
  qualitySummary, rowsVisibleAsOf, safeUploadName, sha256OfFile, snapshotClocks, suppressSmallCells, tablesNeededBy, tableVisibleAsOf, toCsv, treatmentEvidence,
  validateFieldMap, weakestSource, writeContentAddressed,
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

test("AC-26 the plane's suppression is the domain's: one rule, the shapes the stores produce, the caller's object untouched", () => {
  const source = {
    counts: { realPatients: 3, events: 40 },
    waterfall: [{ rule: "年龄", kept: 41, excluded: 3 }, { rule: "ECOG", kept: 37, excluded: 4 }],
    diagnostics: { arms: [{ arm: "A", n: 41, mean: 62.1 }, { arm: "B", n: 3, mean: 58.4 }, { arm: "C", n: 37, mean: 60.0 }] },
    note: "四个数分开显示",
  };
  const { aggregate, suppression } = suppressSmallCells(source);
  assert.equal(suppression.minCellSize, VCR_MIN_CELL_SIZE);
  assert.deepEqual(aggregate, suppressForModel(source, { minCell: VCR_MIN_CELL_SIZE }), "no second copy of the rule");
  assert.equal(aggregate.counts.realPatients, null, "a standalone small count is hidden");
  assert.deepEqual(aggregate.counts.suppressed, ["realPatients"]);
  assert.equal(aggregate.counts.events, 40);
  const arms = aggregate.diagnostics.arms;
  assert.ok(arms.filter((/** @type {any} */ arm) => arm.n === null).length >= 2, "a single hidden cell is recoverable from the total, so a second goes with it");
  assert.ok(arms.every((/** @type {any} */ arm) => arm.n === null ? arm.mean === undefined : true), "a hidden cell loses every number it carried");
  assert.equal(aggregate.note, "四个数分开显示");
  assert.ok(suppression.cellsSuppressed >= 3);
  assert.equal(source.counts.realPatients, 3, "the caller's object is untouched");
  assert.equal(source.diagnostics.arms[1].n, 3);
});

test("AC-26 a payload with no head count passes unchanged, and the floor is the caller's to raise", () => {
  const plain = { cells: [{ key: "hr", value: 0.72 }, { key: "ci", value: 0.51 }] };
  const { aggregate, suppression } = suppressSmallCells(plain);
  assert.deepEqual(aggregate, plain);
  assert.equal(suppression.cellsSuppressed, 0);
  const { aggregate: raised } = suppressSmallCells({ cells: [{ key: "a", n: 12 }, { key: "b", n: 40 }] }, { minCellSize: 50 });
  assert.ok(raised.cells.every((/** @type {any} */ cell) => cell.n === null));
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
  assert.deepEqual(json.asOfFilter.whole, [], "every table said when its rows became visible");
  const all = await profile([file], fieldMap);
  assert.equal(all.json.snapshot.rowCount, 3);
  assert.equal(all.json.asOfFilter.applied, false);
  // A standalone run leaves a table with no visibility column whole — and says so,
  // where the control plane (which refuses to freeze such a file with a date) never asks.
  const plain = await write("plain.csv", "USUBJID,LDH\nS1,210\nS2,260\n");
  const mixed = await profile([file, plain], fieldMap, ["--as-of", "2026-01-20T00:00:00Z"]);
  assert.deepEqual(mixed.json.asOfFilter.whole, ["plain.csv"]);
  assert.equal(mixed.json.snapshot.rowCount, 3, "the dated file's one visible row and the undated file's two");
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

test("AC-26 PA-36 a profile's vocabulary hides small entries together with the next-smallest, so no single hidden entry can be recovered", async () => {
  // Twelve people on arm A, three on arm B, and everybody's own survival time.
  const rows = ["USUBJID,ARM,OS_TIME"];
  for (let index = 1; index <= 12; index += 1) rows.push(`S${String(index).padStart(3, "0")},A,${300 + index}`);
  for (let index = 13; index <= 15; index += 1) rows.push(`S${String(index).padStart(3, "0")},B,${300 + index}`);
  const file = await write("vocabulary.csv", `${rows.join("\n")}\n`);
  const { json, text } = await profile([file], {});
  const columns = Object.fromEntries(json.profile.tables[0].columns.map((/** @type {any} */ column) => [column.name, column]));
  assert.equal(json.minCellSize, VCR_MIN_CELL_SIZE);
  // B (3 people) is hidden; hidden alone it would be 15 - 12 from the row count
  // and the distinct count, so A goes with it: two entries, 15 people, above the floor.
  assert.deepEqual(columns.ARM.vocabulary.values, []);
  assert.equal(columns.ARM.vocabulary.suppressedValues, 2, "the count of hidden entries stays; which they are does not");
  assert.equal(columns.ARM.vocabulary.complete, false, "a partial vocabulary says it is partial");
  assert.deepEqual(columns.OS_TIME.vocabulary.values, []);
  assert.equal(columns.OS_TIME.vocabulary.suppressedValues, 15);
  assert.equal(columns.OS_TIME.vocabulary.withheld, undefined, "fifteen people in fifteen entries are enough to hide them together");
  assert.ok(!text.includes("312") && !text.includes("315"), "no individual's survival time reaches the profile");
  assert.equal(columns.OS_TIME.distinct, 15, "the shape of the column is still reported");
  assert.equal(columns.OS_TIME.filled, 15);
});

test("PA-36 340 on one arm and 5 on the other: the small arm's label and count are not in the profile, the large arm's are only if they are not its complement", async () => {
  const rows = ["PATIENT_NO,ARM,GRADE"];
  for (let n = 1; n <= 345; n += 1) rows.push(`P${n},${n <= 340 ? "A" : "B"},${["low", "mid", "high"][n % 3]}`);
  const file = await write("arms.csv", `${rows.join("\n")}\n`);
  const { json, text } = await profile([file], {});
  const columns = Object.fromEntries(json.profile.tables[0].columns.map((/** @type {any} */ column) => [column.name, column]));
  assert.ok(columns.ARM.vocabulary.suppressedValues >= 2);
  assert.ok(!text.includes('"B"'), "the small arm's label is not written");
  assert.deepEqual(columns.GRADE.vocabulary.values.map((/** @type {any[]} */ pair) => pair[0]).sort(), ["high", "low", "mid"], "categories that many people share stay");
  // Every entry that is written stands for at least the floor.
  for (const column of Object.values(columns)) for (const pair of /** @type {any} */ (column).vocabulary.values) assert.ok(pair[1] >= VCR_MIN_CELL_SIZE);
});

test("PA-36 when even every entry together is under the floor the vocabulary is withheld whole", async () => {
  const file = await write("tiny.csv", "ID,ARM\n1,A\n2,A\n3,B\n4,C\n");
  const { json } = await profile([file], {});
  const arm = json.profile.tables[0].columns.find((/** @type {any} */ column) => column.name === "ARM");
  assert.deepEqual(arm.vocabulary.values, []);
  assert.equal(arm.vocabulary.withheld, true);
});

test("a file is profiled under the name it was uploaded as, and a table name is given once per file", async () => {
  const file = await write("3f9c0a.csv", "A,B\n1,2\n");
  const named = await profile([file], {}, ["--table-name=cohort.csv"]);
  assert.equal(named.json.profile.tables[0].name, "cohort.csv");
  assert.equal(named.json.snapshot.files[0].name, "cohort.csv");
  await assert.rejects(() => profile([file], {}, ["--table-name=a.csv", "--table-name=b.csv"]), /once per input file/);
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

// ---------------------------------------------------------------------------
// The field map, in pure functions
// ---------------------------------------------------------------------------

const TABLES = [{ name: "cohort.csv", header: ["PATIENT_NO", "ARM", "AGE", "OS_MONTHS", "OS_DEAD"] }, { name: "visits.csv", header: ["PATIENT_NO", "SBP"] }];
const GOOD_MAP = [
  { table: "cohort.csv", column: "PATIENT_NO", role: "subject_key", identifier: true },
  { table: "cohort.csv", column: "ARM", role: "arm", alias: "arm", codes: { treated: ["TRT"], control: ["CTL"] } },
  { table: "cohort.csv", column: "AGE", role: "covariate", alias: "age", unit: "year", range: [18, 100], type: "integer" },
  { table: "cohort.csv", column: "OS_MONTHS", role: "outcome_time", parameter: "OS" },
  { table: "cohort.csv", column: "OS_DEAD", role: "outcome_event", parameter: "OS" },
  { table: "visits.csv", column: "PATIENT_NO", role: "subject_key" },
  { table: "visits.csv", column: "SBP", role: "measurement", parameter: "SBP" },
];
/** @param {(entries: any[]) => any[]} change */
const issuesOf = (change) => {
  const { columns, issues } = normalizeFieldMap(change(structuredClone(GOOD_MAP)));
  return [...issues.map((issue) => issue.code), ...validateFieldMap(columns, TABLES).issues.map((issue) => issue.code)].sort();
};

test("PA-10 a field map is checked one entry at a time: closed vocabularies, names, ranges, codes — and nothing that is code", () => {
  assert.deepEqual(issuesOf((entries) => entries), []);
  const { columns, issues } = normalizeFieldMap([
    ...GOOD_MAP.slice(0, 2),
    { table: "cohort.csv", column: "AGE", role: "wizard" },
    { table: "cohort.csv", column: "SEX", role: "covariate", alias: "9lives" },
    { table: "cohort.csv", column: "ECOG", role: "covariate", alias: "ecog", timeKind: "whenever" },
    { table: "cohort.csv", column: "X", role: "covariate", alias: "x", missingReason: "because" },
    { table: "cohort.csv", column: "Y", role: "covariate", alias: "y", range: [5, 1] },
    { table: "cohort.csv", column: "Z", role: "covariate", alias: "z", expression: "system('id')" },
    { table: "cohort.csv", column: "W", role: "outcome_event", parameter: "OS", codes: { event: ["1"], invent: ["2"] } },
    "not an object",
  ]);
  assert.equal(columns.length, 2, "the good entries are kept");
  assert.deepEqual(issues.map((issue) => `${issue.index}:${issue.field || issue.code}`),
    ["2:role", "3:alias", "4:timeKind", "5:missingReason", "6:range", "7:expression", "8:codes", "9:entry_not_object"]);
  assert.equal(normalizeFieldMap({}).issues[0].code, "field_map_not_list");
  assert.equal(normalizeFieldMap(Array.from({ length: 501 }, (_, index) => ({ column: `C${index}` }))).issues[0].code, "field_map_too_long");
  // A column twice is one column.
  assert.equal(normalizeFieldMap([GOOD_MAP[0], GOOD_MAP[0]]).issues[0].code, "column_duplicate");
  // The hash is of the map, not of its spelling.
  assert.equal(fieldMapHash(normalizeFieldMap(GOOD_MAP).columns), fieldMapHash(normalizeFieldMap([...GOOD_MAP].reverse()).columns));
  assert.notEqual(fieldMapHash(normalizeFieldMap(GOOD_MAP).columns), fieldMapHash(normalizeFieldMap(GOOD_MAP.map((entry) => (entry.column === "AGE" ? { ...entry, unit: "y" } : entry))).columns));
});

test("CS-40 the whole map is validated against the files: unknown columns, keys, outcome pairs, names used twice, identifiers used as data", () => {
  assert.deepEqual(issuesOf((entries) => entries.filter((entry) => entry.column !== "OS_DEAD")), ["outcome_pair_incomplete"]);
  assert.deepEqual(issuesOf((entries) => entries.filter((entry) => !(entry.column === "PATIENT_NO" && entry.table === "visits.csv"))), ["subject_key_missing"]);
  assert.deepEqual(issuesOf((entries) => [...entries, { table: "cohort.csv", column: "GHOST", role: "covariate", alias: "ghost" }]), ["column_unknown"]);
  assert.deepEqual(issuesOf((entries) => [...entries, { table: "nofile.csv", column: "A", role: "other" }]), ["table_unknown"]);
  assert.deepEqual(issuesOf((entries) => [...entries, { column: "PATIENT_NO", role: "other" }]), ["column_ambiguous"]);
  assert.deepEqual(issuesOf((entries) => entries.map((entry) => (entry.column === "AGE" ? { ...entry, alias: "arm" } : entry))), ["alias_duplicate"]);
  assert.deepEqual(issuesOf((entries) => entries.map((entry) => (entry.column === "AGE" ? { ...entry, alias: "USUBJID" } : entry))), ["alias_reserved"]);
  assert.deepEqual(issuesOf((entries) => entries.map((entry) => (entry.column === "AGE" ? { ...entry, alias: undefined } : entry))), [], "a column named like an analysis column needs no alias");
  assert.deepEqual(issuesOf((entries) => entries.map((entry) => (entry.column === "AGE" ? { ...entry, identifier: true } : entry))), ["identifier_used_as_data"]);
  assert.deepEqual(issuesOf((entries) => entries.map((entry) => (entry.column === "SBP" ? { ...entry, parameter: undefined } : entry))), ["parameter_missing"]);
  assert.deepEqual(issuesOf((entries) => entries.map((entry) => (entry.column === "ARM" ? { ...entry, codes: { treated: ["A"], control: ["A"] } } : entry))), ["codes_overlap"]);
  assert.deepEqual(issuesOf((entries) => entries.map((entry) => (entry.column === "AGE" ? { ...entry, codes: { treated: ["A"] } } : entry))), ["codes_misplaced"]);
  assert.deepEqual(issuesOf((entries) => [...entries, { table: "visits.csv", column: "PATIENT_NO", role: "subject_key" }]), ["column_duplicate"]);
  assert.ok(validateFieldMap([], []).issues.length === 0, "an empty map over no files is empty, not wrong");
  assert.equal(validateFieldMap(normalizeFieldMap(GOOD_MAP).columns, []).issues[0].code, "no_files");
  const resolved = validateFieldMap(normalizeFieldMap([{ column: "SBP", role: "measurement", parameter: "SBP" }]).columns, TABLES).columns[0];
  assert.equal(resolved.table, "visits.csv", "a column in one file needs no table named");
});

test("the profiler is handed the map the way it reads it: table.column keys, the subject key as an identifier", () => {
  const map = profilerFieldMap(normalizeFieldMap(GOOD_MAP).columns);
  assert.equal(map["cohort.csv.PATIENT_NO"].subjectKey, true);
  assert.equal(map["cohort.csv.PATIENT_NO"].identifier, true);
  assert.equal(map["visits.csv.PATIENT_NO"].identifier, true, "even where the entry did not say so");
  assert.deepEqual(map["cohort.csv.AGE"].range, [18, 100]);
  assert.equal(map["cohort.csv.AGE"].type, "integer");
});

// ---------------------------------------------------------------------------
// Deriving the three tables (C2-23) and the pseudonym (PA-35)
// ---------------------------------------------------------------------------

test("PA-35 the pseudonym is the study's own: stable inside it, different in another, and never the source id", () => {
  const one = Buffer.alloc(32, 1);
  const two = Buffer.alloc(32, 2);
  assert.equal(pseudonymOf(one, "HZ-30001"), pseudonymOf(one, " HZ-30001 "));
  assert.match(pseudonymOf(one, "HZ-30001"), /^P[a-f0-9]{16}$/);
  assert.notEqual(pseudonymOf(one, "HZ-30001"), pseudonymOf(two, "HZ-30001"));
  assert.notEqual(pseudonymOf(one, "HZ-30001"), pseudonymOf(one, "HZ-30002"));
});

test("C2-23 the tables are derived in code from the map: pseudonymous keys, CNSR polarity, arm codes, joined baselines, nothing identifying", () => {
  const cohort = { name: "cohort.csv", header: TABLES[0].header, rows: [
    ["A1", "TRT", "50", "12.5", "1"], ["A2", "CTL", "61", "8", "0"], ["", "TRT", "40", "3", "1"], ["A3", "??", "70", "5", "1"]] };
  const visits = { name: "visits.csv", header: ["PATIENT_NO", "SBP"], rows: [["A1", "120"], ["A1", "130"], ["A2", ""], ["A2", "111"]] };
  const key = Buffer.alloc(32, 7);
  const { shapes, identity, dropped } = deriveAnalysisShapes({ tables: [cohort, visits], entries: validateFieldMap(normalizeFieldMap(GOOD_MAP).columns, TABLES).columns, key });
  assert.deepEqual(shapes.subject?.header, ["USUBJID", "age", "arm"]);
  assert.equal(shapes.subject?.rows.length, 3, "a row with no subject key is not a person");
  const a1 = pseudonymOf(key, "A1");
  assert.deepEqual(shapes.subject?.rows.find((row) => row[0] === a1), [a1, "50", "1"], "TRT is 1");
  assert.deepEqual(shapes.subject?.rows.find((row) => row[0] === pseudonymOf(key, "A2")), [pseudonymOf(key, "A2"), "61", "0"], "CTL is 0");
  assert.deepEqual(shapes.subject?.rows.find((row) => row[0] === pseudonymOf(key, "A3")), [pseudonymOf(key, "A3"), "70", ""], "an arm the map does not name is unknown, not control");
  assert.equal(dropped.blank_subject_key, 1);
  assert.equal(dropped.arm_value_not_coded, 1);
  assert.deepEqual(shapes.events?.header, ["USUBJID", "PARAMCD", "AVAL", "CNSR"]);
  assert.deepEqual(shapes.events?.rows.find((row) => row[0] === a1), [a1, "OS", "12.5", "0"], "OS_DEAD 1 is an event: CNSR 0");
  assert.deepEqual(shapes.events?.rows.find((row) => row[0] === pseudonymOf(key, "A2")), [pseudonymOf(key, "A2"), "OS", "8", "1"], "OS_DEAD 0 is censored: CNSR 1");
  assert.equal(shapes.events?.outcomeBearing, true);
  assert.deepEqual(shapes.longitudinal?.rows.filter((row) => row[0] === a1).map((row) => row[2]), ["120", "130"]);
  assert.equal(shapes.longitudinal?.rows.length, 3, "a blank measurement is not a row");
  assert.equal(shapes.longitudinal?.outcomeBearing, false);
  assert.equal(identity.length, 3);
  assert.ok(!JSON.stringify(shapes).includes("A1"), "no source subject id in any derived table");
  // Deterministic: the same files and map give the same bytes.
  const again = deriveAnalysisShapes({ tables: [visits, cohort], entries: validateFieldMap(normalizeFieldMap([...GOOD_MAP].reverse()).columns, TABLES).columns, key });
  assert.equal(toCsv(again.shapes.subject?.header ?? [], again.shapes.subject?.rows ?? []), toCsv(shapes.subject?.header ?? [], shapes.subject?.rows ?? []));
});

test("C2-23 a column the profiler calls identifying is never carried into a table, and a repeated baseline stays repeated so the table is refused", () => {
  const cohort = { name: "cohort.csv", header: ["ID", "PHONE", "AGE"], rows: [["A1", "13800138000", "50"], ["A1", "13800138000", "51"]] };
  const entries = validateFieldMap(normalizeFieldMap([
    { table: "cohort.csv", column: "ID", role: "subject_key" }, { table: "cohort.csv", column: "PHONE", role: "covariate", alias: "phone" },
    { table: "cohort.csv", column: "AGE", role: "covariate", alias: "age" }]).columns, [{ name: "cohort.csv", header: cohort.header }]).columns;
  const { shapes, excluded } = deriveAnalysisShapes({ tables: [cohort], entries, key: Buffer.alloc(32, 3), identifying: new Set(["PHONE"]) });
  assert.deepEqual(excluded, [{ column: "PHONE", reason: "identifying" }]);
  assert.deepEqual(shapes.subject?.header, ["USUBJID", "age"]);
  const objects = (shapes.subject?.rows ?? []).map((cells) => Object.fromEntries((shapes.subject?.header ?? []).map((name, index) => [name, cells[index]])));
  assert.ok(analysisTableIssues("subject", objects).some((issue) => issue.issue === "duplicate-subject-id" && issue.blocking));
});

test("C2-23 an events table with two rows for one subject and parameter is refused by name", () => {
  const rows = [{ USUBJID: "P1", PARAMCD: "OS", AVAL: "5", CNSR: "0" }, { USUBJID: "P1", PARAMCD: "OS", AVAL: "6", CNSR: "1" }, { USUBJID: "P1", PARAMCD: "PFS", AVAL: "2", CNSR: "0" }];
  const issues = analysisTableIssues("events", rows);
  assert.ok(issues.some((issue) => issue.issue === "duplicate-event-row" && issue.blocking));
  assert.ok(VCR_ANALYSIS_TABLE_BLOCKING_ISSUES.includes("duplicate-event-row"));
  assert.ok(!analysisTableIssues("events", rows.slice(1)).some((issue) => issue.issue === "duplicate-event-row"));
});

// ---------------------------------------------------------------------------
// A snapshot's as-of reaches the tables the engine reads (AC-15, data side)
// ---------------------------------------------------------------------------

/** A baseline file that says, per row, when the platform could first see it. */
const REPLAY_TABLES = [
  { name: "cohort.csv", header: ["PATIENT_NO", "ARM", "AGE", "OS_MONTHS", "OS_DEAD", "SHARED"] },
  { name: "visits.csv", header: ["PATIENT_NO", "SBP", "SHARED"] },
];
const REPLAY_MAP = [
  ...GOOD_MAP.filter((entry) => entry.table === "cohort.csv"),
  { table: "cohort.csv", column: "SHARED", role: "other", timeKind: "visible_at" },
  { table: "visits.csv", column: "PATIENT_NO", role: "subject_key" },
  { table: "visits.csv", column: "SBP", role: "measurement", parameter: "SBP" },
  { table: "visits.csv", column: "SHARED", role: "other", timeKind: "visible_at" },
];
/** Four people; B3 became visible after the replay's date, B4 has no visibility date at all. */
const REPLAY_COHORT = { name: "cohort.csv", header: REPLAY_TABLES[0].header, rows: [
  ["B1", "TRT", "50", "12", "1", "2026-01-05"],
  ["B2", "CTL", "61", "8", "0", "2026-01-19"],
  ["B3", "TRT", "44", "20", "1", "2026-03-01"],
  ["B4", "CTL", "70", "5", "1", ""],
] };
const REPLAY_VISITS = { name: "visits.csv", header: REPLAY_TABLES[1].header, rows: [
  ["B1", "120", "2026-01-06"], ["B1", "130", "2026-02-10"], ["B2", "111", "2026-01-19"], ["B3", "150", "2026-03-02"],
] };
const replayEntries = () => validateFieldMap(normalizeFieldMap(REPLAY_MAP).columns, REPLAY_TABLES).columns;

test("AC-15 a replay's tables are cut to the rows visible then before anything is derived from them", () => {
  const key = Buffer.alloc(32, 9);
  const entries = replayEntries();
  const all = deriveAnalysisShapes({ tables: [REPLAY_COHORT, REPLAY_VISITS], entries, key });
  assert.equal(all.shapes.subject?.rows.length, 4, "no date, no cut");
  assert.equal(all.asOf, null);

  const replay = deriveAnalysisShapes({ tables: [REPLAY_COHORT, REPLAY_VISITS], entries, key, asOf: "2026-01-20T00:00:00.000Z" });
  const b1 = pseudonymOf(key, "B1");
  const b2 = pseudonymOf(key, "B2");
  assert.deepEqual(replay.shapes.subject?.rows.map((row) => row[0]).sort(), [b1, b2].sort(), "B3 and B4 were not visible on the 20th");
  assert.deepEqual(replay.shapes.events?.rows.map((row) => row[0]).sort(), [b1, b2].sort(), "nor is anything of theirs an outcome");
  // The visit the platform got on 10 February is not part of a replay dated 20 January.
  assert.deepEqual(replay.shapes.longitudinal?.rows.map((row) => `${row[0] === b1 ? "B1" : "B2"}:${row[2]}`).sort(), ["B1:120", "B2:111"]);
  assert.deepEqual(replay.identity.map(([pseudonym]) => pseudonym).sort(), [b1, b2].sort(), "a hidden person is not in the way back either");
  assert.deepEqual(replay.dropped, { not_yet_visible: 3, visible_date_missing: 1 });
  assert.deepEqual(replay.asOf, { at: "2026-01-20T00:00:00.000Z", files: [
    { file: "cohort.csv", column: "SHARED", decidable: true, visible: 2, hidden: 1, undated: 1 },
    { file: "visits.csv", column: "SHARED", decidable: true, visible: 2, hidden: 2, undated: 0 },
  ] });
  // Later, more of them are visible: the date is the only thing that changed.
  const later = deriveAnalysisShapes({ tables: [REPLAY_COHORT, REPLAY_VISITS], entries, key, asOf: "2026-03-05T00:00:00.000Z" });
  assert.equal(later.shapes.subject?.rows.length, 3, "B3 is visible by March; B4 never says when");
  assert.equal(later.dropped.visible_date_missing, 1);
});

test("AC-15 a file with no visibility column contributes no rows to a replay, and the freeze names it", () => {
  const cohort = { name: "cohort.csv", header: ["PATIENT_NO", "ARM"], rows: [["C1", "TRT"], ["C2", "CTL"]] };
  const entries = validateFieldMap(normalizeFieldMap([
    { table: "cohort.csv", column: "PATIENT_NO", role: "subject_key" }, { table: "cohort.csv", column: "ARM", role: "arm", alias: "arm" }]).columns,
  [{ name: "cohort.csv", header: cohort.header }]).columns;
  const replayed = tableVisibleAsOf(cohort, entries, "2026-01-20T00:00:00Z");
  assert.deepEqual(replayed.table.rows, [], "'we do not know when we could see this' is not 'we could always see it'");
  assert.deepEqual(replayed.report, { file: "cohort.csv", column: null, decidable: false, visible: 0, hidden: 0, undated: 0 });
  const derived = deriveAnalysisShapes({ tables: [cohort], entries, key: Buffer.alloc(32, 1), asOf: "2026-01-20T00:00:00Z" });
  assert.equal(derived.shapes.subject, undefined);
  assert.equal(derived.dropped.as_of_undecidable, 2);
  // The freeze refuses before any of that: it names the file and what to mark.
  const refused = asOfIssues(entries, "2026-01-20T00:00:00.000Z");
  assert.deepEqual(refused.map((issue) => [issue.code, issue.table]), [["as_of_needs_visible_at", "cohort.csv"]]);
  assert.match(refused[0].message, /cohort\.csv.*平台可见时间/);
  assert.deepEqual(asOfIssues(entries, null), [], "no date, nothing to demand");
  assert.deepEqual(asOfIssues(replayEntries(), "2026-01-20T00:00:00.000Z"), []);
  const twice = replayEntries().map((entry) => (entry.column === "AGE" ? { ...entry, timeKind: "visible_at" } : entry));
  assert.deepEqual(asOfIssues(twice, "2026-01-20T00:00:00.000Z").map((issue) => issue.code), ["as_of_visible_at_repeated"]);
});

test("AC-06 a blank treatment is counted under its missing reason and never becomes the control arm", () => {
  const cohort = { name: "cohort.csv", header: TABLES[0].header, rows: [["D1", "TRT", "50", "1", "1"], ["D2", "", "51", "2", "0"], ["D3", "CTL", "52", "3", "1"], ["D4", "  ", "53", "4", "1"]] };
  const map = GOOD_MAP.filter((entry) => entry.table === "cohort.csv").map((entry) => (entry.column === "ARM" ? { ...entry, missingReason: "restricted_in_trial" } : entry));
  const entries = validateFieldMap(normalizeFieldMap(map).columns, [TABLES[0]]).columns;
  const key = Buffer.alloc(32, 5);
  const { shapes, treatment, dropped } = deriveAnalysisShapes({ tables: [cohort], entries, key });
  const armOf = (/** @type {string} */ id) => shapes.subject?.rows.find((row) => row[0] === pseudonymOf(key, id))?.[2];
  assert.equal(armOf("D1"), "1");
  assert.equal(armOf("D3"), "0");
  assert.equal(armOf("D2"), "", "not told is not 'control'");
  assert.equal(armOf("D4"), "");
  assert.deepEqual(treatment, { arm: { recorded: 2, unknown: 2, notApplicable: 0, missingReason: "restricted_in_trial" } });
  assert.equal(dropped.arm_value_not_coded, undefined, "a blank is not a value the map failed to code");
  // Where the map says the absence is not applicable, that is what is counted.
  const notApplicable = validateFieldMap(normalizeFieldMap(map.map((entry) => (entry.column === "ARM" ? { ...entry, missingReason: "not_applicable" } : entry))).columns, [TABLES[0]]).columns;
  assert.deepEqual(deriveAnalysisShapes({ tables: [cohort], entries: notApplicable, key }).treatment.arm, { recorded: 2, unknown: 0, notApplicable: 2, missingReason: null });
});

test("AC-03 a column names its own value source, and a table of mixed columns is never called observed", () => {
  assert.deepEqual([...VCR_COLUMN_SOURCE_ORDER].sort(), [...VCR_REAL_PATIENT_SOURCES].sort(), "the order ranks exactly the real-patient sources");
  assert.equal(weakestSource(["observed", "observed"], "observed"), "observed");
  assert.equal(weakestSource(["observed", "calculated", "extracted"], "observed"), "calculated");
  assert.equal(weakestSource(["imputed", "observed"], "observed"), "imputed");
  assert.equal(weakestSource([], "extracted"), "extracted");
  assert.equal(weakestSource(["synthetic"], "synthetic"), "synthetic", "a source that is not a real person's is not improved by ranking");

  const { columns, issues } = normalizeFieldMap([
    { table: "cohort.csv", column: "AGE", role: "covariate", alias: "age", valueSource: "imputed" },
    { table: "cohort.csv", column: "ARM", role: "arm", alias: "arm", valueSource: "" },
    { table: "cohort.csv", column: "OS_MONTHS", role: "outcome_time", parameter: "OS", valueSource: "synthetic" },
    { table: "cohort.csv", column: "OS_DEAD", role: "outcome_event", parameter: "OS", valueSource: "guessed" },
  ]);
  assert.deepEqual(issues.map((issue) => `${issue.index}:${issue.code}`), ["2:value_source_not_individual", "3:value_source_unknown"]);
  assert.equal(columns.find((entry) => entry.column === "AGE")?.valueSource, "imputed");
  assert.ok(!("valueSource" in (columns.find((entry) => entry.column === "ARM") ?? {})), "a column that says nothing keeps the map's old spelling and hash");
  assert.equal(fieldMapHash(normalizeFieldMap(GOOD_MAP).columns), fieldMapHash(normalizeFieldMap(GOOD_MAP.map((entry) => ({ ...entry, valueSource: null }))).columns));
  assert.notEqual(fieldMapHash(normalizeFieldMap(GOOD_MAP).columns),
    fieldMapHash(normalizeFieldMap(GOOD_MAP.map((entry) => (entry.column === "AGE" ? { ...entry, valueSource: "imputed" } : entry))).columns));

  const cohort = { name: "cohort.csv", header: TABLES[0].header, rows: [["E1", "TRT", "50", "12.5", "1"], ["E2", "CTL", "61", "8", "0"]] };
  const visits = { name: "visits.csv", header: TABLES[1].header, rows: [["E1", "120"], ["E2", "111"]] };
  const mixed = validateFieldMap(normalizeFieldMap(GOOD_MAP.map((entry) => (
    entry.column === "AGE" ? { ...entry, valueSource: "imputed" } : entry.column === "SBP" ? { ...entry, valueSource: "calculated" } : entry))).columns, TABLES).columns;
  const derived = deriveAnalysisShapes({ tables: [cohort, visits], entries: mixed, key: Buffer.alloc(32, 4), fileSource: "observed" });
  assert.deepEqual(derived.shapes.subject?.columnSources, { age: "imputed", arm: "observed" });
  assert.equal(derived.shapes.subject?.valueSource, "imputed", "one imputed covariate keeps the whole table from reading observed");
  assert.deepEqual(derived.shapes.events?.columnSources, { AVAL: "observed", CNSR: "observed" });
  assert.equal(derived.shapes.events?.valueSource, "observed", "the events table holds no imputed column and says so");
  assert.deepEqual(derived.shapes.longitudinal?.columnSources, { AVAL: "calculated" });
  assert.equal(derived.shapes.longitudinal?.valueSource, "calculated");
  assert.deepEqual(derived.shapes.subject?.columns.map((column) => [column.name, column.valueSource]), [["age", "imputed"], ["arm", "observed"]]);
  // A file extracted from documents is extracted throughout, except where a column says it was observed.
  const extracted = deriveAnalysisShapes({ tables: [cohort, visits], entries: validateFieldMap(normalizeFieldMap(GOOD_MAP.map((entry) => (
    entry.column === "AGE" ? { ...entry, valueSource: "observed" } : entry))).columns, TABLES).columns, key: Buffer.alloc(32, 4), fileSource: "extracted" });
  assert.deepEqual(extracted.shapes.subject?.columnSources, { age: "observed", arm: "extracted" });
  assert.equal(extracted.shapes.subject?.valueSource, "extracted");
  // On a synthetic or aggregate source, a column may not claim to be real.
  assert.deepEqual(columnSourceIssues(mixed, "observed"), []);
  assert.deepEqual(columnSourceIssues(mixed, "synthetic").map((issue) => issue.code), ["column_source_on_non_individual_source", "column_source_on_non_individual_source"]);
  assert.deepEqual(columnSourceIssues(validateFieldMap(normalizeFieldMap(GOOD_MAP).columns, TABLES).columns, "synthetic"), []);
});

// ---------------------------------------------------------------------------
// The door: names, encodings, tables
// ---------------------------------------------------------------------------

test("PA-10 an upload's name is display text: no path, no comma, an extension the role accepts", () => {
  assert.deepEqual(safeUploadName("C:\\data\\队列,v2.CSV", "data"), { name: "队列_v2.CSV", ext: "csv", format: "csv" });
  assert.deepEqual(safeUploadName("../../etc/x.tsv", "data"), { name: "x.tsv", ext: "tsv", format: "tsv" });
  assert.equal(safeUploadName("note.md", "document").format, "txt");
  for (const [name, role, code] of [["a.parquet", "data", "vcr_data_format_unsupported"], ["a.xls", "data", "vcr_data_format_unsupported"], ["a.txt", "data", "vcr_data_format_unsupported"],
    ["a.csv", "document", "vcr_data_format_unsupported"], [".hidden.csv", "data", "vcr_data_file_name_invalid"], ["noext", "data", "vcr_data_file_name_invalid"], [42, "data", "vcr_data_file_name_invalid"]]) {
    assert.throws(() => safeUploadName(name, role), (error) => /** @type {any} */ (error).code === code, `${name} as ${role}`);
  }
  assert.ok(safeUploadName(`${"长".repeat(300)}.csv`, "data").name.length <= 100);
});

test("PA-10 bytes become text whatever a hospital's Excel wrote, or are refused", () => {
  assert.deepEqual(decodeUploadText(Buffer.from("a,b\n1,2\n")), { text: "a,b\n1,2\n", encoding: "utf-8" });
  assert.equal(decodeUploadText(Buffer.from("\uFEFFa,b\n", "utf8")).text, "a,b\n", "a UTF-8 byte-order mark is not a column name");
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,姓名\n", "utf16le")]);
  assert.deepEqual(decodeUploadText(utf16), { text: "a,姓名\n", encoding: "utf-16le" });
  const gbk = Buffer.from([0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0x61]); // 姓名,a
  assert.deepEqual(decodeUploadText(gbk), { text: "姓名,a", encoding: "gb18030" });
  assert.throws(() => decodeUploadText(Buffer.from([0x61, 0x00, 0x62, 0x00, 0x63])), (error) => /** @type {any} */ (error).code === "vcr_data_file_unreadable");
  assert.throws(() => decodeUploadText(Buffer.from([0x81, 0x30, 0x81, 0x20])), (error) => /** @type {any} */ (error).code === "vcr_data_file_unreadable", "neither UTF-8 nor GB18030 is refused, not guessed");
});

test("PA-10 a table is a header and rows: blank header cells are named, repeats refused, JSON records become a table, and CSV round-trips through the writer", () => {
  assert.deepEqual(checkedTable(",b\n1,2\n", ","), { header: ["col_1", "b"], rows: [["1", "2"]], renamed: 1 });
  assert.throws(() => checkedTable("a,a\n1,2\n", ","), (error) => /** @type {any} */ (error).code === "vcr_data_file_unreadable" && /same name/.test(/** @type {any} */ (error).message));
  assert.throws(() => checkedTable("", ","), (error) => /** @type {any} */ (error).code === "vcr_data_file_unreadable");
  assert.throws(() => checkedTable(`${Array.from({ length: 501 }, (_, index) => `c${index}`).join(",")}\n`, ","), /at most 500 columns/);
  assert.deepEqual(jsonTable('[{"a":1,"b":"x"},{"a":2,"c":true}]'), { header: ["a", "b", "c"], rows: [["1", "x", ""], ["2", "", "true"]] });
  assert.throws(() => jsonTable('[{"a":{"nested":1}}]'), /nested value/);
  assert.throws(() => jsonTable("not json"), (error) => /** @type {any} */ (error).code === "vcr_data_file_unreadable");
  const header = ["名字", "note"];
  const rows = [["张,三", 'he said "hi"'], [" padded ", "line\nbreak"], ["", ""]];
  const written = toCsv(header, rows);
  const read = parseTable(written);
  assert.deepEqual(read.header, header);
  assert.deepEqual(read.rows.slice(0, 2), rows.slice(0, 2), "commas, quotes, padding and newlines survive");
  assert.deepEqual(parseDelimited("a\tb\n1\t2\n", "\t").rows, [{ a: "1", b: "2" }]);
});

test("PA-10 a data dictionary is three short columns per variable, in either language, and nothing else", () => {
  const entries = dictionaryEntries({ header: ["变量名", "说明", "单位", "患者姓名"], rows: [["AGE", "年龄", "岁", "张三"], ["", "空", "", ""], ["OS", "总生存期".repeat(100), "月", "李四"]] });
  assert.deepEqual(entries.map((entry) => entry.column), ["AGE", "OS"]);
  assert.equal(entries[0].unit, "岁");
  assert.ok(entries[1].label.length <= 120);
  assert.ok(!JSON.stringify(entries).includes("张三"), "a fourth column is not read");
  assert.throws(() => dictionaryEntries({ header: ["x", "y"], rows: [] }), (error) => /** @type {any} */ (error).code === "vcr_data_file_unreadable");
});

test("PA-10 projecting a table drops columns, renames them and pseudonymises the key; a row with no key belongs to nobody", () => {
  const table = { header: ["ID", "AGE", "PHONE"], rows: [["A1", "50", "138"], ["", "60", "139"], ["A2", "70", "140"]] };
  const key = Buffer.alloc(32, 5);
  const view = projectTable(table, { keep: ["AGE"], rename: { AGE: "age" }, keyColumn: "ID", key });
  assert.deepEqual(view.header, ["USUBJID", "age"]);
  assert.deepEqual(view.rows, [[pseudonymOf(key, "A1"), "50"], [pseudonymOf(key, "A2"), "70"]]);
  assert.deepEqual(projectTable(table, { keep: ["AGE", "PHONE"] }).header, ["AGE", "PHONE"], "without a key column nothing is added");
});

test("PA-10 a stored file is named by its bytes and written once", async () => {
  const root = await fs.mkdtemp(path.join(scratch, "plane-"));
  const first = await writeContentAddressed(root, "studies/std_1/tables", "csv", "a,b\n1,2\n");
  assert.match(first.location, /^studies\/std_1\/tables\/[a-f0-9]{64}\.csv$/);
  assert.equal(first.sha256, await sha256OfFile(path.join(root, first.location)));
  const before = (await fs.stat(path.join(root, first.location))).mtimeMs;
  const second = await writeContentAddressed(root, "studies/std_1/tables", "csv", "a,b\n1,2\n");
  assert.deepEqual(second, first);
  assert.equal((await fs.stat(path.join(root, first.location))).mtimeMs, before, "the same bytes are not written again");
  await assert.rejects(() => writeContentAddressed(root, "../out", "csv", "x"), (error) => /** @type {any} */ (error).code === VCR_DATA_PLANE_CODES.locationOutside);
  await assert.rejects(() => writeContentAddressed(root, "knowledge-base", "csv", "x"), (error) => /** @type {any} */ (error).code === VCR_DATA_PLANE_CODES.locationRuntimeReadable);
  assert.deepEqual((await fs.readdir(path.join(root, "studies/std_1/tables"))).filter((name) => name.endsWith(".part")), []);
});

test("PB-10 a baseline column can itself be the outcome: it is sealed like the pair, and its table says it holds one", () => {
  const tables = [{ name: "cohort.csv", header: ["ID", "ARM", "RESPONSE", "AGE"] }];
  const map = [
    { table: "cohort.csv", column: "ID", role: "subject_key" }, { table: "cohort.csv", column: "ARM", role: "arm", alias: "arm" },
    { table: "cohort.csv", column: "RESPONSE", role: "covariate", alias: "y", outcome: true }, { table: "cohort.csv", column: "AGE", role: "covariate", alias: "age" }];
  const { columns, issues } = normalizeFieldMap(map);
  assert.deepEqual(issues, []);
  assert.deepEqual(validateFieldMap(columns, tables).issues, []);
  assert.deepEqual(columns.filter(isOutcomeEntry).map((entry) => entry.column), ["RESPONSE"]);
  const cohort = { name: "cohort.csv", header: tables[0].header, rows: [["A", "TRT", "1", "50"], ["B", "CTL", "0", "60"]] };
  const derived = deriveAnalysisShapes({ tables: [cohort], entries: validateFieldMap(columns, tables).columns, key: Buffer.alloc(32, 9) });
  assert.equal(derived.shapes.subject?.outcomeBearing, true);
  assert.deepEqual(derived.shapes.subject?.header, ["USUBJID", "age", "arm", "y"], "in the order of the source columns' names");
  // The flag belongs on a baseline or measurement column only.
  const bad = normalizeFieldMap([...map.slice(0, 1), { table: "cohort.csv", column: "ARM", role: "arm", alias: "arm", outcome: true }]);
  assert.deepEqual(validateFieldMap(bad.columns, tables).issues.map((issue) => issue.code), ["outcome_flag_invalid"]);
});

test("a method is given the tables it reads and no more: files to profile, the subject table, the events table for a time-to-event comparison", () => {
  const all = ["events", "longitudinal", "subject"];
  assert.deepEqual(tablesNeededBy("profile.snapshot", null, all), ["files"]);
  assert.deepEqual(tablesNeededBy("cohort.build", null, all), ["subject"]);
  assert.deepEqual(tablesNeededBy("comparator.rmst", "time_to_event", all), ["subject", "events"]);
  assert.deepEqual(tablesNeededBy("comparator.entropy_balance", "time_to_event", all), ["subject", "events"]);
  assert.deepEqual(tablesNeededBy("comparator.entropy_balance", "binary", all), ["subject"], "a binary outcome is a column of the subject table");
  assert.deepEqual(tablesNeededBy("comparator.propensity_weight", null, all), ["subject"]);
  // the comparator-effect methods: an event time is always read by the Cox and the time-to-event MAIC, by the covariate sets only for that endpoint
  assert.deepEqual(tablesNeededBy("comparator.weighted_cox", "time_to_event", all), ["subject", "events"]);
  assert.deepEqual(tablesNeededBy("comparator.maic_time_to_event", null, all), ["subject", "events"]);
  assert.deepEqual(tablesNeededBy("comparator.covariate_sets", "time_to_event", all), ["subject", "events"]);
  assert.deepEqual(tablesNeededBy("comparator.covariate_sets", "binary", all), ["subject"]);
  assert.deepEqual(tablesNeededBy("comparator.aipw", "binary", all), ["subject"]);
  assert.deepEqual(tablesNeededBy("population.synthpop", null, all), ["subject"]);
  assert.deepEqual(tablesNeededBy("something.new", null, all), ["subject"]);
  assert.deepEqual(tablesNeededBy("comparator.rmst", "time_to_event", ["subject"]), ["files"], "no events table derived: the raw files, which the engine also takes");
  assert.deepEqual(tablesNeededBy("cohort.build", null, []), ["files"]);
});

test("a corrected upload is a newer version of the same file: a snapshot takes the latest of each name", () => {
  const files = [{ id: "a", name: "cohort.csv", role: "data" }, { id: "b", name: "visits.csv", role: "data" }, { id: "c", name: "cohort.csv", role: "data" }, { id: "d", name: "dict.csv", role: "dictionary" }];
  assert.deepEqual(latestDataFiles(files).map((file) => file.id).sort(), ["b", "c"]);
});
