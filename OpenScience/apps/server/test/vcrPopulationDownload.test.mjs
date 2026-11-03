// The population page offers its generated records as a file (the records route), and a real cohort never: the rows of a real patient do not
// leave the data plane, so the page has no button to press for them (2026-11-02, 「下载 CSV」 on the population page).
import assert from "node:assert/strict";
import test from "node:test";
import { populationDownload } from "../src/vcrService.mjs";

const result = (/** @type {Record<string, any>} */ more = {}) => ({ id: "res_1", tables: [{ name: "population", rows: 500, location: "derived/std_1/job_1/population.csv" }], counts: { generatedRecords: 500 }, ...more });
const bundle = (/** @type {Record<string, any>} */ population, /** @type {Record<string, any>} */ filed = result()) => ({ populations: [{ id: "pop_1", version: 1, resultId: "res_1", ...population }], allResults: [filed] });

test("a cohort generated from a scenario, from a paper's baseline or from a synthesis offers its records, by the records route and with the row count", () => {
  for (const kind of ["scenario", "literature", "empirical_synthetic"]) {
    assert.deepEqual(populationDownload(bundle({ kind })), { path: "records/res_1.csv", rows: 500 }, kind);
  }
  assert.equal(populationDownload(bundle({ kind: "scenario" }, result({ counts: {} }))).rows, null, "a count the engine did not write is not guessed");
});

test("a cohort of real patients offers nothing, whatever table was kept; nor does a population with no result or no kept table", () => {
  assert.equal(populationDownload(bundle({ kind: "real" })), null);
  assert.equal(populationDownload(bundle({ kind: "scenario", resultId: null })), null);
  assert.equal(populationDownload(bundle({ kind: "scenario" }, result({ tables: [] }))), null);
  assert.equal(populationDownload(bundle({ kind: "scenario" }, result({ tables: [{ name: "population", location: "inputs/std_1/snapshot.csv" }] }))), null, "only what the engine derived is a generated record");
  assert.equal(populationDownload({ populations: [], allResults: [] }), null);
});

test("the file is the one of the version on show: the page's population is the newest, and so is the download's", () => {
  const newer = { id: "pop_2", version: 2, kind: "scenario", resultId: "res_2" };
  const older = { id: "pop_1", version: 1, kind: "scenario", resultId: "res_1" };
  const filed = [result(), result({ id: "res_2", counts: { generatedRecords: 800 } })];
  assert.deepEqual(populationDownload({ populations: [newer, older], allResults: filed }), { path: "records/res_2.csv", rows: 800 });
});
