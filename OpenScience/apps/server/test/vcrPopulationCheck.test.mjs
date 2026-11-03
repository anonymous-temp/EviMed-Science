// The population check (remediation plan D2): the profile that is copied in as the generated side, whether the second table is made
// from other evidence, and what the page says of the result. No database.
import assert from "node:assert/strict";
import test from "node:test";
import { validateEngineJob } from "@evimed/domain";
import { populationCheckIndependence, populationCheckRows, presentPopulationCheck } from "../src/vcrPopulationCheck.mjs";
import { presentPopulationTab } from "../src/vcrViewsTabs.mjs";

const PROFILE = [
  { variable: "age", label: "年龄", kind: "continuous", n: 400, missing: 4, mean: 62.1, sd: 9.4, median: 62, histogram: { breaks: [1], counts: [1] } },
  { variable: "male", kind: "binary", n: 400, missing: 0, levels: [{ level: "0", n: 180, p: 0.45 }, { level: "1", n: 220, p: 0.55 }] },
  { variable: "ecog", kind: "categorical", n: 400, levels: [{ level: "0", n: 160, p: 0.4 }, { level: "1", n: 200, p: 0.5 }, { level: "2", n: 40, p: null, suppressed: true }] },
  { variable: "free_text", kind: "text", n: 400 },
  { variable: "empty_levels", kind: "categorical", n: 400, levels: [] },
];

test("D2: the generated side is the population's own profile, in the scenario's shape, and nothing else is copied", () => {
  const rows = populationCheckRows(PROFILE);
  assert.deepEqual(rows.map((row) => row.variable), ["age", "male", "ecog"], "a kind the check does not read and a variable with no level are left out");
  assert.deepEqual(rows[0], { variable: "age", kind: "continuous", label: "年龄", n: 396, mean: 62.1, sd: 9.4 }, "n is the observed count");
  assert.deepEqual(rows[1].levels, [{ level: "0", p: 0.45 }, { level: "1", p: 0.55 }]);
  assert.deepEqual(rows[2].levels[2], { level: "2", p: null }, "a hidden proportion stays hidden");
  // a job built from them is one the engine's own validator reads clean
  const job = { jobId: "job_1", studyId: "std_1", kind: "population_check", method: "population.check", methodVersion: "1.0.0", protocolVersion: 1, seed: 1, cpuSecondsLimit: 60,
    scenario: { baselineTable: [{ variable: "age", mean: 63, sd: 10 }], generated: rows, referenceN: 300 }, inputs: [] };
  assert.deepEqual(validateEngineJob(job), []);
  assert.deepEqual(populationCheckRows(null), []);
  assert.deepEqual(populationCheckRows([{ variable: "age" }, "x", null]), []);
});

test("D2: a second table is independent when it shares no evidence with the population's own baseline", () => {
  assert.deepEqual(populationCheckIndependence({ populationEvidenceIds: ["ev_a", "ev_b"], referenceEvidenceIds: ["ev_c"] }), { independent: true, shared: [], populationSourced: true });
  assert.deepEqual(populationCheckIndependence({ populationEvidenceIds: ["ev_a", "ev_b"], referenceEvidenceIds: ["ev_b", "ev_c", "ev_a"] }), { independent: false, shared: ["ev_a", "ev_b"], populationSourced: true });
  // a population whose numbers were stated, not sourced, shares nothing: independent, and said to be unsourced
  assert.deepEqual(populationCheckIndependence({ populationEvidenceIds: undefined, referenceEvidenceIds: ["ev_c"] }), { independent: true, shared: [], populationSourced: false });
});

/** A check result as the engine writes it and the control plane completes it. */
const result = (over = {}) => ({
  id: "res_check", kind: "population_check", subjectId: "pop_1", version: 1, conclusion: "estimable",
  diagnostics: {
    floor: 0.1,
    rows: [
      { variable: "age", label: "年龄", kind: "continuous", state: "close", generated: { mean: 62.1, sd: 9.4 }, reference: { mean: 61.5, sd: 10 }, difference: 0.6, standardizedDifference: 0.06 },
      { variable: "male", kind: "binary", state: "apart", generated: { proportion: 0.55 }, reference: { proportion: 0.4 }, difference: 0.15, standardizedDifference: 0.3001, standardError: 0.04, withinTwoStandardErrors: false },
      { variable: "ecog", kind: "categorical", state: "close", levels: [{ level: "0", generated: 0.4, reference: 0.38, difference: 0.02 }, { level: "1", generated: 0.5, reference: 0.52, difference: -0.02 }], totalVariation: 0.02 },
      { variable: "stage", kind: "binary", state: "not_comparable", reason: "not_in_population" },
    ],
    coverage: { compared: 3, referenceOnly: ["stage"], generatedOnly: ["bmi"], notCompared: ["joint_distribution", "distribution_shape"] },
    populationCheck: { populationResultId: "res_pop", independent: true, populationSourced: true },
  },
  ...over,
});

test("D2: an independent check says what it covered and that what it did not cover is not a validation", () => {
  const view = presentPopulationCheck(result(), { currentResultId: "res_pop" });
  assert.equal(view.title, "与第二份基线表独立对照");
  assert.equal(view.independent, true);
  assert.match(view.sentence, /^3 个变量逐个对照了各自的分布，1 个差距超过 0\.1。对照表和生成这份人群用的不是同一批证据。$/);
  assert.match(view.covered, /^这里没有对照的部分不算验证：变量之间的相关性；分布的形状和尾部；对照表里有而人群里没有的变量（stage）；人群里有而对照表里没有的变量（bmi）。$/);
  assert.deepEqual(view.rows.map((row) => [row.key, row.state, row.stateLabel, row.smd, row.totalVariation]), [
    ["age", "close", "接近", 0.06, null], ["male", "apart", "有差距", 0.3, null], ["ecog", "close", "接近", null, 0.02], ["stage", "not_comparable", "没法对照", null, null]]);
  assert.equal(view.rows[0].ours, "62.1（SD 9.4）");
  assert.equal(view.rows[0].theirs, "61.5（SD 10）");
  assert.equal(view.rows[1].ours, "55%");
  assert.equal(view.rows[1].note, "差距超过了两个标准误");
  assert.equal(view.rows[2].ours, "0 40% / 1 50%");
  assert.equal(view.rows[3].note, "生成的人群里没有这个变量");
  assert.equal(view.ofEarlierVersion, false);
});

test("D2: a check on the same evidence is a comparison with the inputs, and the page never says 验证 of it", () => {
  const shared = result();
  shared.diagnostics.populationCheck = { populationResultId: "res_pop", independent: false, populationSourced: true, sharedEvidenceIds: ["ev_a"] };
  const view = presentPopulationCheck(shared, { currentResultId: "res_pop" });
  assert.equal(view.title, "与第二份基线表对照");
  assert.equal(view.independent, false);
  assert.match(view.sentence, /这只是与输入对照，不是独立对照。$/);
  assert.doesNotMatch(JSON.stringify(view), /验证/);
  // an earlier population version is named as such, and nothing is hidden by it
  assert.equal(presentPopulationCheck(result(), { currentResultId: "res_newer" }).ofEarlierVersion, true);
  // a population whose own numbers were never sourced says so once
  const unsourced = result();
  unsourced.diagnostics.populationCheck = { populationResultId: "res_pop", independent: true, populationSourced: false };
  assert.match(presentPopulationCheck(unsourced).sentence, /这份人群的数没有绑定证据来源；对照表有。$/);
  assert.equal(presentPopulationCheck(null), null);
  assert.equal(presentPopulationCheck(result({ diagnostics: {} })), null);
});

test("D2: the population tab carries the newest check filed under the shown population, and none for another", () => {
  const population = { id: "pop_1", version: 2, kind: "literature", resultId: "res_pop", name: "p", counts: {}, definition: {}, waterfall: [], profile: {}, quality: {} };
  const pop = { id: "res_pop", kind: "population", subjectId: "pop_1", version: 1, conclusion: "estimable", counts: {}, measures: [], diagnostics: {}, createdAt: "2026-11-01T10:00:00.000Z" };
  const bundle = (/** @type {any[]} */ results) => ({
    now: new Date("2026-11-01T12:00:00.000Z"), study: { id: "std_1", dataTier: "T0", steps: {}, abilities: [] }, populations: [population], stale: [], protocol: null, criteria: [],
    results, allResults: results, executions: new Map(), jobs: [], table: null, knowledge: null, currentNodes: new Set(), jobMarks: [],
  });
  const tab = presentPopulationTab(bundle([pop, result()]));
  assert.equal(tab.check.title, "与第二份基线表独立对照");
  assert.equal(presentPopulationTab(bundle([pop, result({ subjectId: "pop_other" })])).check, null);
  assert.equal(presentPopulationTab(bundle([pop])).check, null);
  assert.equal(presentPopulationTab(bundle([pop, result({ supersededBy: "res_later" })])).check, null);
});
