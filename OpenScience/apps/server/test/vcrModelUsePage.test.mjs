// Every page that shows a model-based result passes the use check's premises into the one block (in silico plan section 6, A04).
// Read from the page's own bundle, no database.
import assert from "node:assert/strict";
import test from "node:test";
import { presentComparatorTab, presentPatientsTab } from "../src/vcrViewsTabs.mjs";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const AT = "2026-11-07T11:00:00.000Z";
const bundleOf = (/** @type {Record<string, any>} */ over = {}) => ({
  now: NOW, study: { id: "std_1", intendedUse: "exploratory", dataTier: "T2", steps: {}, abilities: [] }, definition: null, results: [], allResults: [], stale: [], reviews: [],
  jobs: [], budget: null, assumptions: [], members: [], exports: [], decisions: [], roles: [], scenarios: [], comparators: [], comparator: null, populations: [],
  patientSets: [], grid: null, forecasts: [], models: [], executions: new Map(), protocol: null, criteria: [], jobMarks: [], currentNodes: new Set(), assessments: [], people: new Map(), ...over,
});
const validatedFor = (/** @type {Record<string, any>} */ over = {}) => ({ id: "mdl_1", name: "prognostic-eq", version: "1", tier: "scenario", risk: "low", endpointType: "binary", evidence: [],
  card: { title: "预后方程", executable: true, useEvidence: [{ mode: "factual_forecast", endpoint: "event_free", horizonHours: 8766, evidenceRef: "paper-1", independent: true }], ...over.card }, ...over });

function patientsPage(model, diagnostics = {}) {
  const set = { id: "ps_1", version: 1, populationId: null, modelId: model?.name ?? "gone", modelVersion: model?.version ?? "1", scenario: {}, counts: {}, twinLabel: null, resultId: "res_1", createdAt: AT };
  const result = { id: "res_1", version: 1, kind: "patient_set", conclusion: "estimable", counts: {}, measures: [], diagnostics, createdAt: AT, executionId: "ex_1", subjectId: "ps_1" };
  return presentPatientsTab(bundleOf({ patientSets: [set], results: [result], allResults: [result], models: model ? [model] : [],
    executions: new Map([["ex_1", { id: "ex_1", jobId: "j", method: "model.prognostic_apply", methodVersion: "1.1.0" }]]) }));
}

test("A04: the patients page of a model-based result carries what the model was not validated for, as a sentence of the one block", () => {
  const page = patientsPage(validatedFor(), { endpoint: "event_free" });
  assert.deepEqual(page.premises.map((/** @type {any} */ row) => row.key), ["use:use_not_validated"], "the result stands; the premise is beside it");
  assert.match(page.premises[0].value, /没有为这种用途验证过/);
  assert.equal(page.premises[0].decisive, true);
  assert.doesNotMatch(JSON.stringify(page.premises), /mdl_|prognostic-eq|adapter|job/);
});

test("a model that declares nothing to be held against, or one the library no longer has, adds no sentence and loses no result", () => {
  assert.deepEqual(patientsPage(validatedFor({ card: { useEvidence: undefined } })).premises, []);
  assert.deepEqual(patientsPage(null).premises, []);
  assert.equal(patientsPage(validatedFor()).headline, null);
});

test("the comparator page of a model-predicted control carries the same sentences in the same block", () => {
  const comparator = { id: "cmp_1", version: 1, route: "model_comparator", estimand: "ATT", resultId: "res_1", conclusion: "estimable", gapList: [], createdAt: AT, targetTrial: {}, configuration: {} };
  const filed = { id: "res_1", version: 1, kind: "comparator", conclusion: "estimable", counts: {}, measures: [], diagnostics: { sourceModel: { id: "mdl_1", version: "1" }, endpoint: "event_free" }, createdAt: AT, executionId: "ex_1" };
  const view = presentComparatorTab(bundleOf({ comparators: [comparator], comparator, results: [filed], allResults: [filed], models: [validatedFor()],
    executions: new Map([["ex_1", { id: "ex_1", jobId: "j", method: "model.prognostic_apply", methodVersion: "1.1.0" }]]) }));
  assert.ok(view.premises.some((/** @type {any} */ row) => row.key === "use:use_not_validated"));
  // a comparison made of real people never reads the model library
  const weighted = presentComparatorTab(bundleOf({ comparators: [{ ...comparator, route: "external_control" }], comparator, results: [filed], allResults: [filed], models: [validatedFor()],
    executions: new Map([["ex_1", { id: "ex_1", jobId: "j", method: "comparator.entropy_balance", methodVersion: "1.4.0" }]]) }));
  assert.ok(!weighted.premises.some((/** @type {any} */ row) => String(row.key).startsWith("use:")));
});
