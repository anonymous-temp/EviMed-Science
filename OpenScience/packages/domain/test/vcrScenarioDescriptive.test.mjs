// The keys a model writes to describe what the engine does anyway (2026-11-01: a design comparison paid several refused calls for
// `analysis.method: "logrank"`, `accrual.kind: "uniform"` and the labels of a grid's designs). The list is closed and per method; a
// described value that disagrees with the engine, and every other key, keeps being refused.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_DESCRIPTIVE_SCENARIO_KEYS, VCR_LABELLED_SCENARIO_LISTS, validateScenario, vcrNormalizeScenarioKeys } from "../index.mjs";

const ANALYTIC = Object.freeze({
  design: { kind: "two_arm_fixed", allocation: 0.5 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.75, controlMedian: 13.5 },
  analysis: { alpha: 0.025, power: 0.9, sided: 1 }, accrual: { duration: 24, followup: 12, dropoutAnnual: 0.05 }, timeUnit: "months",
});
const codes = (/** @type {string} */ method, /** @type {any} */ scenario) => validateScenario(method, scenario).map((issue) => `${issue.code}@${issue.field}`);

test("the two descriptions of design_analytic are left out, said, and the scenario is the one without them", () => {
  const described = { ...ANALYTIC, analysis: { ...ANALYTIC.analysis, method: "logrank" }, accrual: { ...ANALYTIC.accrual, kind: "uniform" } };
  assert.deepEqual(codes("design.analytic", described), ["scenario_field_unknown@scenario.analysis.method", "scenario_field_unknown@scenario.accrual.kind"], "refused as they stand");
  const read = vcrNormalizeScenarioKeys("design.analytic", described);
  assert.deepEqual(read.scenario, ANALYTIC);
  assert.deepEqual(read.applied.map((entry) => [entry.field, entry.value]), [["analysis.method", "logrank"], ["accrual.kind", "uniform"]]);
  assert.match(read.applied[0].took, /changes nothing/);
  assert.deepEqual(read.conflicts, []);
  assert.deepEqual(codes("design.analytic", read.scenario), []);
  // a group-sequential design is sized with the same test
  const sequential = { ...described, design: { kind: "group_sequential", allocation: 0.5, informationRates: [0.5, 1] } };
  assert.deepEqual(vcrNormalizeScenarioKeys("design.analytic", sequential).applied.map((entry) => entry.field), ["analysis.method", "accrual.kind"]);
  // and the input is not edited
  assert.equal(described.analysis.method, "logrank");
});

test("a described value the analytic design would not honour is a conflict that says why, and stays in the scenario to be refused", () => {
  for (const method of ["maxcombo", "rmst", "LogRank "]) {
    const asked = { ...ANALYTIC, analysis: { ...ANALYTIC.analysis, method } };
    const read = vcrNormalizeScenarioKeys("design.analytic", asked);
    assert.equal(read.scenario.analysis.method, method, `${method} is not dropped`);
    assert.equal(read.conflicts.length, 1);
    assert.equal(read.conflicts[0].field, "scenario.analysis.method");
    assert.match(read.conflicts[0].detail, /log-rank/);
    assert.deepEqual(read.applied, []);
    assert.ok(codes("design.analytic", read.scenario).some((code) => code.endsWith("@scenario.analysis.method")), "still refused, by its path");
  }
  const poisson = vcrNormalizeScenarioKeys("design.analytic", { ...ANALYTIC, accrual: { ...ANALYTIC.accrual, kind: "piecewise" } });
  assert.equal(poisson.conflicts[0].field, "scenario.accrual.kind");
});

test("they are descriptive only where the engine does what they say: a single-arm or binary design keeps them refused", () => {
  const single = { design: { kind: "single_arm", n: 40 }, endpoint: { type: "binary" }, truth: { nullRate: 0.2, responseRate: 0.4 },
    analysis: { method: "logrank", alternative: "greater", alpha: 0.05 } };
  const read = vcrNormalizeScenarioKeys("design.analytic", single);
  assert.deepEqual(read.scenario, single, "the condition does not hold: nothing is touched and nothing is a conflict");
  assert.deepEqual(read.conflicts, []);
  const binary = { design: { kind: "two_arm_fixed" }, endpoint: { type: "binary" }, truth: { controlRate: 0.3, treatmentRate: 0.45 }, analysis: { method: "logrank" } };
  assert.deepEqual(vcrNormalizeScenarioKeys("design.analytic", binary).applied, []);
});

test("a key that is not on the list is never dropped: a misspelling would change the computation", () => {
  const misspelt = { ...ANALYTIC, accrual: { duration: 24, followup: 12, dropoutAnual: 0.05 } };
  const read = vcrNormalizeScenarioKeys("design.analytic", misspelt);
  assert.deepEqual(read.scenario, misspelt);
  assert.deepEqual(codes("design.analytic", read.scenario), ["scenario_field_unknown@scenario.accrual.dropoutAnual"]);
  // a method that reads the keys for real is left alone
  const simulate = { design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 12 },
    analysis: { method: "logrank", alpha: 0.025 }, accrual: { kind: "uniform", duration: 12, followup: 12 } };
  assert.deepEqual(vcrNormalizeScenarioKeys("design.simulate", simulate), { scenario: simulate, applied: [], conflicts: [] });
  assert.deepEqual(codes("design.simulate", simulate), []);
  // not a scenario at all
  assert.deepEqual(vcrNormalizeScenarioKeys("design.analytic", null).applied, []);
  assert.deepEqual(vcrNormalizeScenarioKeys("design.analytic", [1]).applied, []);
  assert.deepEqual(Object.keys(VCR_DESCRIPTIVE_SCENARIO_KEYS), ["design.analytic"]);
});

test("the labels of a grid's designs and truths are for the page: left out, and no other key of an entry is", () => {
  const grid = {
    design: { kind: "two_arm_fixed", nControl: 415, nTreat: 415 }, endpoint: { type: "time_to_event" }, truth: { controlMedian: 13.5, hazardRatio: 0.75 },
    accrual: { duration: 24, followup: 12 }, performance: ["power"],
    designs: [{ kind: "two_arm_fixed", label: "A 固定 1:1", nControl: 415, nTreat: 415 }, { kind: "two_arm_fixed", nControl: 320, nTreat: 639 }],
    truths: [{ hazardRatio: 0.75, label: "HR 0.75" }, { hazardRatio: 1, null: true }],
  };
  assert.deepEqual(codes("design.grid", grid).sort(), ["scenario_field_unknown@scenario.designs[0].label", "scenario_field_unknown@scenario.truths[0].label"].sort());
  const read = vcrNormalizeScenarioKeys("design.grid", grid);
  assert.deepEqual(read.applied.map((entry) => entry.field), ["designs[].label", "truths[].label"]);
  assert.deepEqual(read.applied[0].value, ["A 固定 1:1"]);
  assert.equal(read.scenario.designs[0].nTreat, 415);
  assert.equal("label" in read.scenario.designs[0], false);
  assert.deepEqual(codes("design.grid", read.scenario), []);
  // a name is not a label, and an entry's misspelling is still refused
  const named = vcrNormalizeScenarioKeys("design.grid", { ...grid, designs: [{ kind: "two_arm_fixed", name: "A", nControl: 415, nTreat: 415 }] });
  assert.deepEqual(codes("design.grid", named.scenario).filter((code) => code.includes("designs[0]")), ["scenario_field_unknown@scenario.designs[0].name"]);
  assert.deepEqual(Object.keys(VCR_LABELLED_SCENARIO_LISTS), ["design.grid"]);
});
