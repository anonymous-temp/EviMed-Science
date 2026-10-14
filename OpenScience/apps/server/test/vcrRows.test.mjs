// The rows of a generated table, as a list: a page of patients filtered and sorted by the server, one patient's record, the
// distribution of every column, and the numbers the page sets beside what the study declared (R3, 2026-10-14). Pure over a CSV the
// test writes, and through `createVcrRecords` — so the doors a download goes through are the doors a page goes through.
//
// The payloads the web renders its virtual-patients page from are written here (`VCR_VIEWS_WRITE_FIXTURES=1`), beside the page
// fixtures `vcrViews.integration.test.mjs` writes: the diff of those files is the review of the contract.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { validatePopulationProfile } from "@evimed/domain";

import { createVcrRecords } from "../src/vcrRecords.mjs";
import { vcrCalibration } from "../src/vcrCalibration.mjs";
import {
  VCR_ROWS_PAGE_MAX, clearRowTableCache, coxHazardRatio, kaplanMeier, loadRowTable, outcomeStatistics, pageOfFile, pageOfTable, patientRecord,
  profileOfTable, readCsvRows,
} from "../src/vcrRows.mjs";
import { FIXTURE_DIR } from "./vcrViewsFixtures.mjs";
import { seedVirtualPatientsCsv } from "./vcrViewsSeed.mjs";

const WRITE = process.env.VCR_VIEWS_WRITE_FIXTURES === "1";
const study = { id: "std_1", userId: "owner", projectId: "prj_1", name: "EV-201" };
const sha = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");

/** @param {string} name @param {unknown} value */
function check(name, value) {
  const file = path.join(FIXTURE_DIR, name);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (WRITE) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return;
  }
  assert.equal(text, readFileSync(file, "utf8"), `${name} differs from what the rows module now sends; regenerate with VCR_VIEWS_WRITE_FIXTURES=1 and read the diff`);
}

let plane = "";
const PATIENTS = seedVirtualPatientsCsv();
/** A scenario population of 60: age, ECOG, BMI — a different table from the patients', as the engine writes one. */
const POPULATION = (() => {
  let state = 77;
  const uniform = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state + 0.5) / 2 ** 32; };
  const lines = ["age,ecog,bmi"];
  for (let index = 0; index < 60; index += 1) lines.push(`${Math.round((60 + 12 * (uniform() - 0.5) * 2) * 10) / 10},${uniform() < 0.4 ? 0 : 1},${index % 15 === 0 ? "" : Math.round((22 + 8 * uniform()) * 10) / 10}`);
  return `${lines.join("\n")}\n`;
})();
const PATIENTS_LOCATION = "derived/std_1/job_vp/virtual-patients.csv";
const POPULATION_LOCATION = "derived/std_1/job_pop/population.csv";

before(async () => {
  plane = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-rows-"));
  for (const [relative, text] of [[PATIENTS_LOCATION, PATIENTS], [POPULATION_LOCATION, POPULATION]]) {
    await fs.mkdir(path.dirname(path.join(plane, relative)), { recursive: true });
    await fs.writeFile(path.join(plane, relative), text);
  }
  await fs.chmod(plane, 0o700);
});
after(async () => { await fs.rm(plane, { recursive: true, force: true }); clearRowTableCache(); });

/** The module over doubles of the store: one patient set, one population, one real cohort, and one table whose bytes changed. */
function records() {
  const table = (/** @type {string} */ name, /** @type {string} */ location, /** @type {string} */ text, /** @type {number} */ rows) => ({ name, location, sha256: sha(text), rows });
  const results = /** @type {Record<string, any>} */ ({
    res_vp: { id: "res_vp", kind: "patient_set", executionId: "ex_vp", subjectId: "pts_1", tables: [table("virtual-patients", PATIENTS_LOCATION, PATIENTS, 2000)], diagnostics: {} },
    res_pop: { id: "res_pop", kind: "population", executionId: "ex_pop", subjectId: "pop_1", tables: [table("population", POPULATION_LOCATION, POPULATION, 60)], diagnostics: {} },
    res_real: { id: "res_real", kind: "population", executionId: "ex_real", subjectId: "pop_2", tables: [table("population", POPULATION_LOCATION, POPULATION, 60)], diagnostics: {} },
    res_changed: { id: "res_changed", kind: "patient_set", executionId: "ex_vp", subjectId: "pts_1", tables: [{ ...table("virtual-patients", PATIENTS_LOCATION, PATIENTS, 2000), sha256: sha("other bytes") }], diagnostics: {} },
  });
  const executions = /** @type {Record<string, any>} */ ({
    ex_vp: { method: "patients.time_to_event", inputs: [], finished_at: "2026-10-07T11:05:00Z" },
    ex_pop: { method: "population.scenario", inputs: [], finished_at: "2026-10-07T11:00:00Z" },
    ex_real: { method: "cohort.build", inputs: [{ kind: "snapshot", id: "snp_1", valueSource: "observed" }], finished_at: "2026-10-07T11:00:00Z" },
  });
  /** @type {any[]} */
  const audits = [];
  const store = {
    async result(/** @type {string} */ _studyId, /** @type {string} */ id) { return results[id] ?? null; },
    async one(/** @type {string} */ sql, /** @type {any[]} */ values) {
      if (/FROM evimed_vcr\.executions e JOIN/.test(sql)) return { scenario: { endpoint: { type: "time_to_event" }, truth: { controlMedian: 4.1, hazardRatio: 0.6 } } };
      if (/FROM evimed_vcr\.executions/.test(sql)) return executions[String(values[0])] ?? null;
      if (/FROM evimed_vcr\.populations/.test(sql)) return { allowed_uses: ["design"] };
      return null;
    },
    async audit(/** @type {any} */ entry) { audits.push(entry); },
  };
  return { module: createVcrRecords({ store, config: { vcrDataPlaneDir: plane } }), audits };
}

// --- the reader --------------------------------------------------------------------------------------------------------------

test("a CSV is read as RFC 4180 says: quotes, doubled quotes, a newline inside a cell, a byte-order mark, blank lines", async () => {
  const file = path.join(plane, "tricky.csv");
  await fs.writeFile(file, '﻿"patientId","arm","note"\r\n"vp_1",1,"a, ""b"""\n"vp_2",0,"x\ny"\n\n"vp_3",0,\n');
  /** @type {string[][]} */
  const rows = [];
  for await (const row of readCsvRows(file)) rows.push(row);
  assert.deepEqual(rows, [["patientId", "arm", "note"], ["vp_1", "1", 'a, "b"'], ["vp_2", "0", "x\ny"], ["vp_3", "0", ""]]);
  // A table too long for memory is flagged and its rows are the first ones, never a silent truncation presented as the table.
  const long = await loadRowTable(path.join(plane, PATIENTS_LOCATION), { maxCells: 1_000 });
  assert.equal(long.complete, false);
  assert.ok(long.rows.length > 0 && long.rows.length < 200);
});

// --- a page ---------------------------------------------------------------------------------------------------------------------

test("a page is the rows that pass the filters, in the order asked, from the offset, at most the limit — and says how many there were", async () => {
  const table = await loadRowTable(path.join(plane, PATIENTS_LOCATION));
  const first = pageOfTable(table, { limit: 3 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual([first.total, first.all, first.rows.length, first.offset, first.limit], [2000, 2000, 3, 0, 3]);
  assert.deepEqual(first.columns.map((column) => column.key), ["patientId", "age", "ecog", "arm", "time", "status", "entry"], "the constant labels are not the person's columns");
  assert.deepEqual(first.arms.map((arm) => [arm.value, arm.label, arm.n]), [["1", "试验", 1000], ["0", "对照", 1000]]);

  const treated = pageOfTable(table, { arm: "treatment", limit: 5, sort: "-time" });
  if (!treated.ok) throw new Error("page refused");
  assert.equal(treated.total, 1000);
  assert.ok(treated.rows.every((row) => row.arm === 1));
  assert.deepEqual(treated.rows.map((row) => row.time), [...treated.rows.map((row) => /** @type {number} */ (row.time))].sort((a, b) => b - a));
  assert.deepEqual(treated.sort, { column: "time", descending: true });

  const ranged = pageOfTable(table, { filters: { age: "60..70", ecog: "1" }, limit: 5000 });
  if (!ranged.ok) throw new Error("page refused");
  assert.ok(ranged.total > 0 && ranged.total < 2000);
  assert.ok(ranged.rows.every((row) => Number(row.age) >= 60 && Number(row.age) <= 70 && row.ecog === 1));
  const open = pageOfTable(table, { filters: { age: "..45" }, limit: 5000 });
  if (!open.ok) throw new Error("page refused");
  assert.ok(open.rows.every((row) => Number(row.age) <= 45));

  // The offset walks the same order, and a page never exceeds the ceiling.
  const second = pageOfTable(table, { limit: 3, offset: 3, sort: "patientId" });
  const whole = pageOfTable(table, { limit: 6, sort: "patientId" });
  if (!second.ok || !whole.ok) throw new Error("page refused");
  assert.deepEqual(second.rows, whole.rows.slice(3, 6));
  const big = pageOfTable(table, { limit: 10_000 });
  if (!big.ok) throw new Error("page refused");
  assert.equal(big.limit, VCR_ROWS_PAGE_MAX);

  // A column the table does not have is refused by name, and so is a filter its kind cannot take.
  for (const query of [{ sort: "nope" }, { filters: { nope: "1" } }, { filters: { age: "abc" } }, { filters: { arm: "" } }]) {
    const refused = pageOfTable(table, query);
    assert.equal(refused.ok, false, JSON.stringify(query));
  }
});

test("a table too long for memory is streamed: filtered and counted in its own order, never sorted by guess", async () => {
  const file = path.join(plane, PATIENTS_LOCATION);
  const streamed = await pageOfFile(file, { arm: "0", limit: 4, offset: 10 });
  const loaded = pageOfTable(await loadRowTable(file), { arm: "0", limit: 4, offset: 10 });
  if (!streamed.ok || !loaded.ok) throw new Error("page refused");
  assert.deepEqual(streamed.rows, loaded.rows);
  assert.deepEqual([streamed.total, streamed.all], [loaded.total, loaded.all]);
  const sorted = await pageOfFile(file, { sort: "time" });
  assert.deepEqual(sorted, { ok: false, issue: { error: "too_large", column: "time" } });
});

// --- one patient ----------------------------------------------------------------------------------------------------------------

test("a patient's record is who they are, what happened to them and where they stand among their arm", async () => {
  const table = await loadRowTable(path.join(plane, PATIENTS_LOCATION));
  const first = table.rows[0][0];
  const record = patientRecord(table, first);
  assert.ok(record);
  assert.equal(record.id, first);
  assert.deepEqual(record.arm, { value: "1", label: "试验" });
  assert.deepEqual(record.baseline.map((entry) => entry.key), ["age", "ecog"]);
  assert.deepEqual(record.outcome.map((entry) => entry.key), ["time", "status", "entry"]);
  assert.equal(record.position.kind, "time_to_event");
  assert.ok(record.position.survival >= 0 && record.position.survival <= 1);
  assert.equal(record.position.armSize, 1000);
  assert.equal(record.trajectories, null, "the engine left one outcome per patient, so there is one trajectory");
  assert.equal(patientRecord(table, "vp_nobody"), null);
  // Both assumptions' trajectories appear when — and only when — the table holds an outcome for each.
  const both = { header: ["patientId", "arm", "y0", "y1"], rows: [["vp_a", "1", "2.5", "3.1"]], complete: /** @type {const} */ (true),
    columns: [{ key: "patientId", index: 0, kind: /** @type {const} */ ("text"), missing: 0 }, { key: "arm", index: 1, kind: /** @type {const} */ ("number"), missing: 0 },
      { key: "y0", index: 2, kind: /** @type {const} */ ("number"), missing: 0 }, { key: "y1", index: 3, kind: /** @type {const} */ ("number"), missing: 0 }] };
  assert.deepEqual(patientRecord(both, "vp_a")?.trajectories, [
    { arm: "0", label: "对照", values: { y: 2.5 } }, { arm: "1", label: "试验", values: { y: 3.1 } }]);
});

// --- the numbers ------------------------------------------------------------------------------------------------------------------

test("the Kaplan–Meier median and Cox's hazard ratio are the table's own, and agree with what generated it", async () => {
  // A hand case: ten subjects, no ties; the curve drops by a tenth at each death and crosses a half at the fifth.
  const km = kaplanMeier(Array.from({ length: 10 }, (_unused, index) => ({ time: index + 1, event: true })));
  assert.equal(km.median, 5);
  assert.deepEqual(km.steps.slice(0, 2).map((step) => [step.time, Number(step.survival.toFixed(2)), step.atRisk]), [[1, 0.9, 10], [2, 0.8, 9]]);
  // A censored subject leaves the risk set without a drop: [1 event, 2 censored, 3 event] → S = 2/3 at 1, then 1/3 at 3.
  const censored = kaplanMeier([{ time: 1, event: true }, { time: 2, event: false }, { time: 3, event: true }]);
  assert.deepEqual(censored.steps.map((step) => [step.time, Number(step.survival.toFixed(3))]), [[1, 0.667], [3, 0]]);

  const statistics = outcomeStatistics(await loadRowTable(path.join(plane, PATIENTS_LOCATION)));
  assert.ok(statistics && statistics.endpoint === "time_to_event");
  assert.deepEqual([statistics.control.n, statistics.treated.n], [1000, 1000]);
  // The generator's control median is 4.1 and its hazard ratio 0.6: a sample of a thousand a side lands near them.
  assert.ok(Math.abs(statistics.control.median - 4.1) < 0.45, `control median ${statistics.control.median}`);
  assert.ok(Math.abs(Math.log(statistics.hazardRatio.value / 0.6)) < 0.12, `hazard ratio ${statistics.hazardRatio.value}`);
  assert.ok(statistics.hazardRatio.low < statistics.hazardRatio.value && statistics.hazardRatio.value < statistics.hazardRatio.high);
  // A table with nobody who had the event in one arm has no hazard ratio to state.
  assert.equal(coxHazardRatio([{ time: 1, event: false }], [{ time: 2, event: true }]), null);
});

test("a profile describes every variable in the engine's own shape, and passes the contract", async () => {
  const profile = profileOfTable(await loadRowTable(path.join(plane, PATIENTS_LOCATION)), { labels: { age: "年龄", ecog: "ECOG" } });
  assert.deepEqual(validatePopulationProfile(profile), []);
  assert.deepEqual(profile.map((entry) => entry.variable), ["age", "ecog", "arm", "time", "status"], "the identity column and the column that says one thing on every row are not variables");
  const [age, ecog, arm, time, status] = profile;
  assert.deepEqual([age.label, age.kind, age.n, age.missing], ["年龄", "continuous", 2000, 0]);
  assert.equal(age.histogram.counts.length, 7);
  assert.equal(age.histogram.counts.reduce((/** @type {number} */ sum, /** @type {number} */ count) => sum + count, 0), 2000);
  assert.deepEqual([ecog.kind, arm.kind, status.kind], ["binary", "categorical", "binary"]);
  assert.deepEqual(arm.levels.map((/** @type {any} */ level) => [level.level, level.n]), [["0", 1000], ["1", 1000]]);
  assert.ok(time.max <= 14 && time.min >= 0);
  // A column with missing cells counts them.
  const withGaps = profileOfTable(await loadRowTable(path.join(plane, POPULATION_LOCATION)));
  assert.equal(withGaps.find((entry) => entry.variable === "bmi")?.missing, 4);
  assert.deepEqual(validatePopulationProfile(withGaps), []);
});

test("the calibration sets what was generated beside what the study declared and the interval the evidence gives, and marks what falls outside", () => {
  const statistics = { endpoint: "time_to_event", control: { n: 1000, events: 900, median: 3.9 }, treated: { n: 1000, events: 760 }, hazardRatio: { value: 0.66 } };
  const cards = [
    { key: "control_median_pfs", version: 2, pointValue: 4.1, unit: "个月", pooling: { predictionInterval: { low: 3.0, high: 5.6 } } },
    { key: "hazard_ratio_target", version: 1, pointValue: 0.6, unit: "", distribution: { range: { low: 0.7, high: 0.9 } } },
  ];
  const named = vcrCalibration({ statistics, scenario: { truth: { controlMedian: 4.1, hazardRatio: 0.6 } }, cards, unitWord: (card) => card?.unit ?? null });
  assert.ok(named);
  assert.deepEqual(named.rows.map((row) => [row.key, row.declared, row.generated, row.status]), [
    ["control_median", 4.1, 3.9, "within"],
    ["hazard_ratio", 0.6, 0.66, "outside"],
    ["event_rate", null, 0.83, "unknown"],
  ]);
  assert.deepEqual(named.rows[0].interval, { low: 3, high: 5.6, kind: "prediction" });
  assert.equal(named.rows[0].unit, "个月");
  assert.deepEqual(named.arms.map((arm) => [arm.value, arm.n, arm.events]), [["1", 1000, 760], ["0", 1000, 900]]);
  // Nothing declared is nothing to calibrate against: no row for it, and no table of the wrong shape is read as one.
  assert.deepEqual(vcrCalibration({ statistics, scenario: {}, cards: [] })?.rows.map((row) => row.key), ["event_rate"]);
  assert.equal(vcrCalibration({ statistics: null }), null);
});

// --- through the same doors a download goes through --------------------------------------------------------------------------

test("the rows come through the doors the download does: synthetic only, the recorded bytes, the kind asked for", async () => {
  const { module, audits } = records();
  const page = await module.rows(study, "res_vp", { limit: 2, kind: "patient_set" });
  assert.equal(page.result, "res_vp");
  assert.equal(page.rows.length, 2);
  // A real cohort's rows never leave the data plane, whoever asks and however they ask.
  await assert.rejects(module.rows(study, "res_real", { kind: "population" }), { code: "vcr_records_not_synthetic" });
  // The bytes are what the result recorded.
  await assert.rejects(module.rows(study, "res_changed", { kind: "patient_set" }), { code: "vcr_records_not_found" });
  // A list of patients is a patient set's table: a population's is not the table asked for.
  await assert.rejects(module.rows(study, "res_pop", { kind: "patient_set" }), { code: "vcr_records_not_found" });
  await assert.rejects(module.rows(study, "res_nobody", { kind: "patient_set" }), { code: "vcr_records_not_found" });
  // A column the table does not have; a sort a streamed table cannot honour is not this table's case.
  await assert.rejects(module.rows(study, "res_vp", { sort: "nope", kind: "patient_set" }), { code: "vcr_rows_query_invalid" });
  await assert.rejects(module.record(study, "res_vp", "vp_nobody", "patient_set"), { code: "vcr_patient_not_found" });
  assert.deepEqual(audits, [], "the route audits a page; the module answers");
  // A table that may not be read is described as nothing, not as an error: the page then has no list and no profile.
  assert.equal(await module.describe(study, "res_real"), null);
});

test("the payloads the web renders the virtual patients from", async () => {
  clearRowTableCache();
  const { module } = records();
  const first = await module.rows(study, "res_vp", { limit: 10, kind: "patient_set" });
  check("ev201/patients-rows.json", first);
  check("ev201/patients-rows-filtered.json", await module.rows(study, "res_vp", { limit: 5, sort: "-time", arm: "1", filters: { age: "60..70" }, kind: "patient_set" }));
  check("ev201/patients-record.json", await module.record(study, "res_vp", String(first.rows[0].patientId), "patient_set"));
  const censored = first.rows.find((row) => row.status === 0) ?? first.rows[1];
  check("ev201/patients-record-censored.json", await module.record(study, "res_vp", String(censored.patientId), "patient_set"));
  check("ev201/population-rows.json", await module.rows(study, "res_pop", { limit: 8, kind: "population" }));
});
