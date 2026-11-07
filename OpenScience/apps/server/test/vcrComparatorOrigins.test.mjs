// Where a comparison's control comes from (in silico plan T13, A11): read from what the run recorded, said on the page and in the
// export, and never counted as observed people unless it is. No database.
import assert from "node:assert/strict";
import test from "node:test";
import { comparatorInputOrigin, comparatorOriginPremises, comparatorOrigins, comparatorOriginsOfReport, originCountsAsObserved, weakestOrigin }
  from "../src/vcrComparatorOrigins.mjs";
import { vcrReportModel } from "../src/vcrRender.mjs";
import { presentComparatorTab } from "../src/vcrViewsTabs.mjs";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const AT = "2026-11-07T11:00:00.000Z";
const bundleOf = (/** @type {Record<string, any>} */ over = {}) => ({
  now: NOW, study: { id: "std_1", intendedUse: "exploratory", dataTier: "T2", steps: {}, abilities: [] }, definition: null, results: [], allResults: [], stale: [], reviews: [],
  jobs: [], budget: null, assumptions: [], members: [], exports: [], decisions: [], roles: [], scenarios: [], comparators: [], comparator: null, populations: [],
  patientSets: [], grid: null, forecasts: [], models: [], executions: new Map(), protocol: null, criteria: [], jobMarks: [], currentNodes: new Set(), ...over,
});
function page({ route = "external_control", method = "comparator.entropy_balance", diagnostics = /** @type {Record<string, any>} */ ({}), counts = {}, models = [] } = {}) {
  const comparator = { id: "cmp_1", version: 1, route, estimand: "ATT", resultId: "res_1", conclusion: "estimable", gapList: [], createdAt: AT, targetTrial: {}, configuration: {} };
  const filed = { id: "res_1", version: 1, kind: "comparator", conclusion: "estimable", counts, measures: [], diagnostics: { estimand: "ATT", ...diagnostics }, createdAt: AT, executionId: "ex_1" };
  const executions = new Map([["ex_1", { id: "ex_1", jobId: "job_1", method, methodVersion: "1.0.0" }]]);
  return presentComparatorTab(bundleOf({ comparators: [comparator], comparator, results: [filed], allResults: [filed], executions, models }));
}

test("an input's origin is its value source, and a lab experiment's arm is simulated whatever it says", () => {
  assert.equal(comparatorInputOrigin({ valueSource: "observed" }), "observed");
  assert.equal(comparatorInputOrigin({ valueSource: "imputed" }), "observed", "a real person's imputed cell is still that person's row");
  assert.equal(comparatorInputOrigin({ valueSource: "aggregate" }), "aggregate");
  assert.equal(comparatorInputOrigin({ valueSource: "reconstructed" }), "reconstructed");
  assert.equal(comparatorInputOrigin({ valueSource: "predicted" }), "model_predicted");
  assert.equal(comparatorInputOrigin({ valueSource: "synthetic" }), "simulated");
  assert.equal(comparatorInputOrigin({ valueSource: "observed", kind: "experiment_arm" }), "simulated");
  assert.equal(comparatorInputOrigin({}), "not_stated");
  assert.equal(originCountsAsObserved("observed"), true);
  for (const origin of ["aggregate", "reconstructed", "model_predicted", "simulated", "not_stated"]) assert.equal(originCountsAsObserved(origin), false);
  assert.equal(weakestOrigin(["observed", "reconstructed"]), "reconstructed");
  assert.equal(weakestOrigin(["observed", "simulated", "reconstructed"]), "simulated");
});

test("A11: the four kinds of control are told apart from what the run recorded, and only the observed one has observed people", () => {
  const observed = comparatorOrigins({ route: "external_control", method: "comparator.entropy_balance", diagnostics: { valueSourcesUsed: { weakest: "calculated" } }, counts: { realPatients: 640 } });
  assert.deepEqual([observed.origin, observed.observedPeople, observed.modelConditional], ["observed", 640, false]);
  const rebuilt = comparatorOrigins({ route: "literature_control", method: "comparator.rmst", diagnostics: { valueSourcesUsed: { weakest: "reconstructed" } }, counts: { realPatients: 120, reconstructedPseudoPatients: 300 } });
  assert.deepEqual([rebuilt.origin, rebuilt.reconstructedPseudoPatients], ["reconstructed", 300]);
  const predicted = comparatorOrigins({ route: "model_comparator", method: "model.prognostic_apply", diagnostics: { valueSourcesUsed: { weakest: "observed" } }, counts: { realPatients: 200 } });
  assert.deepEqual([predicted.origin, predicted.modelConditional], ["model_predicted", true]);
  const simulated = comparatorOrigins({ route: "model_comparator", method: "model.prognostic_apply", diagnostics: { valueSourcesUsed: { weakest: "synthetic" } }, counts: { generatedRecords: 5000, realPatients: 0 } });
  assert.deepEqual([simulated.origin, simulated.observedPeople, simulated.simulatedMembers, simulated.modelConditional], ["simulated", 0, 5000, true]);
  // a simulated control with a row count never becomes people
  const inflated = comparatorOrigins({ route: "model_comparator", diagnostics: { valueSourcesUsed: { weakest: "synthetic" } }, counts: { generatedRecords: 5000, realPatients: 5000 } });
  assert.equal(inflated.observedPeople, 0);
  assert.equal(comparatorOrigins({ route: "literature_control", diagnostics: {}, counts: {} }).origin, "aggregate");
  assert.equal(comparatorOrigins({ route: "prognostic_adjustment", diagnostics: {}, counts: {} }).origin, "not_stated", "nothing recorded is not read as observed");
  // a hybrid reads as its weakest part and keeps both
  const hybrid = comparatorOrigins({ route: "hybrid_control", method: "comparator.maic_time_to_event", diagnostics: { valueSourcesUsed: { weakest: "reconstructed" } }, counts: { realPatients: 90, reconstructedPseudoPatients: 200 } });
  assert.equal(hybrid.origin, "reconstructed");
});

test("an observed control has no origin row, and no comparison carries a generic sentence about other populations", () => {
  const rows = comparatorOriginPremises(comparatorOrigins({ route: "external_control", diagnostics: { valueSourcesUsed: { weakest: "observed" } }, counts: { realPatients: 10 } }));
  assert.deepEqual(rows.map((row) => row.key), []);
  const simulated = comparatorOriginPremises(comparatorOrigins({ route: "model_comparator", diagnostics: { valueSourcesUsed: { weakest: "synthetic" } }, counts: { generatedRecords: 9 } }));
  assert.deepEqual(simulated.map((row) => row.key), ["origin:simulated"]);
  assert.match(simulated[0].value, /不增加真实患者数/);
  const rebuilt = comparatorOriginPremises(comparatorOrigins({ route: "literature_control", diagnostics: { valueSourcesUsed: { weakest: "reconstructed" } }, counts: { reconstructedPseudoPatients: 300 } }));
  assert.match(rebuilt[0].value, /伪个体（共 300 个），/);
});

test("the comparator page says where the control comes from, in the one block, with the model's use premises", () => {
  const view = page({ route: "model_comparator", method: "model.prognostic_apply", counts: { generatedRecords: 800 },
    diagnostics: { sourceCondition: "control", sourceModel: { id: "mdl_1", version: "1" }, endpoint: "ADAS-cog 11", valueSourcesUsed: { weakest: "synthetic" } },
    models: [{ id: "mdl_1", name: "ad", version: "1", card: { executable: true, useEvidence: [{ mode: "factual_forecast", evidenceRef: "paper", independent: true }] } }] });
  assert.equal(view.origins.origin, "simulated");
  assert.equal(view.origins.observedPeople, 0);
  const keys = view.premises.map((/** @type {any} */ row) => row.key);
  assert.ok(keys.includes("origin:simulated") && !keys.includes("origin:transport") && keys.includes("use:use_not_validated"), keys.join(","));
  assert.ok(view.premises.filter((/** @type {any} */ row) => row.decisive).length <= 5);
  assert.equal(view.premises.length, new Set(keys).size);
  const plain = page({ diagnostics: { valueSourcesUsed: { weakest: "observed" } }, counts: { realPatients: 500 } });
  assert.equal(plain.origins.origin, "observed");
  assert.equal(plain.origins.observedPeople, 500);
  assert.ok(!plain.premises.some((/** @type {any} */ row) => row.key === "origin:transport"));
});

test("the export carries the same origin, and a simulated control adds no observed people", () => {
  const study = { id: "std_1", name: "s", question: "q" };
  const comparator = { id: "cmp_1", version: 1, route: "model_comparator", estimand: "ATT" };
  const results = [{ id: "res_1", kind: "comparator", diagnostics: { valueSourcesUsed: { weakest: "synthetic" } }, counts: { generatedRecords: 800, realPatients: 800 }, measures: [] }];
  const report = vcrReportModel({ study, results, comparator });
  assert.equal(report.comparatorOrigins.origin, "simulated");
  assert.equal(report.comparatorOrigins.label, "完全模拟");
  assert.equal(report.comparatorOrigins.observedPeople, 0);
  assert.equal(report.comparatorOrigins.modelConditional, true);
  assert.equal(vcrReportModel({ study, results: [] }).comparatorOrigins, null);
  assert.equal(comparatorOriginsOfReport({}), null);
});
