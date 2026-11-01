// A hazard ratio that changes over time and the MaxCombo analysis (remediation plan D1): the schema, the refusals by name, the replay
// rule for older versions, and the null case. The numbers are held by the engine's cases N58 and the verdicts' parity with the engine by N00.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_ENGINE_METHODS, VCR_TWO_ARM_ANALYSIS_METHODS, validateEngineJob, validateScenario, vcrIsNullScenario } from "../index.mjs";

const NPH = { breaks: [6], ratios: [1, 0.6] };
const simulate = (/** @type {Record<string, any>} */ over = {}) => ({
  design: { kind: "two_arm_fixed", nTreat: 150, nControl: 150 }, endpoint: { type: "time_to_event" }, accrual: { duration: 12, followup: 18 },
  truth: { treatmentHazardRatios: NPH, controlMedian: 12 }, analysis: { method: "maxcombo", alpha: 0.025, sided: 1 }, ...over,
});
const job = (/** @type {string} */ method, /** @type {string} */ kind, /** @type {string} */ version, /** @type {any} */ scenario) =>
  ({ jobId: "job_1", studyId: "std_1", kind, method, methodVersion: version, protocolVersion: 1, seed: 1, cpuSecondsLimit: 60, scenario, inputs: [] });
const codes = (/** @type {readonly { code: string, field: string }[]} */ issues) => issues.map((issue) => `${issue.code}@${issue.field}`);

test("D1: a simulation states one hazard law, either one ratio or one that changes over time, and MaxCombo is an analysis of a fixed design", () => {
  assert.deepEqual(validateScenario("design.simulate", simulate()), []);
  assert.deepEqual(validateScenario("design.simulate", simulate({ truth: { hazardRatio: 0.7, controlMedian: 12 }, analysis: { method: "maxcombo" } })), []);
  assert.deepEqual(codes(validateScenario("design.simulate", simulate({ truth: { hazardRatio: 0.7, treatmentHazardRatios: NPH, controlMedian: 12 } }))), ["scenario_value_invalid@scenario.truth.treatmentHazardRatios"]);
  assert.deepEqual(codes(validateScenario("design.simulate", simulate({ truth: { controlMedian: 12 } }))), ["scenario_field_missing@scenario.truth.hazardRatio"]);
  assert.deepEqual(codes(validateScenario("design.simulate", simulate({ truth: { treatmentHazardRatios: { breaks: [6, 12], ratios: [1, 0.6] }, controlMedian: 12 } }))), ["scenario_value_invalid@scenario.truth.treatmentHazardRatios.ratios"]);
  assert.deepEqual(codes(validateScenario("design.simulate", simulate({ truth: { treatmentHazardRatios: { breaks: [12, 6], ratios: [1, 0.6, 0.5] }, controlMedian: 12 } }))).length, 1, "breaks increase");
  // MaxCombo is not for a group-sequential design, which looks with the log-rank
  assert.deepEqual(codes(validateScenario("design.simulate", simulate({ design: { kind: "group_sequential", nTreat: 150, nControl: 150, informationRates: [0.5, 1] }, truth: { hazardRatio: 0.7, controlMedian: 12 } }))),
    ["scenario_value_invalid@scenario.analysis.method"]);
  // a single-arm trial against its benchmark still states its one ratio, and has no law that changes over time
  assert.deepEqual(codes(validateScenario("design.simulate", { design: { kind: "single_arm", n: 60 }, endpoint: { type: "time_to_event" }, truth: { controlMedian: 12 }, analysis: { method: "one_sample_logrank", alternative: "less", sided: 1, alpha: 0.025 }, accrual: { duration: 12, followup: 12 } })),
    ["scenario_field_missing@scenario.truth.hazardRatio"]);
  assert.ok(validateScenario("design.simulate", { design: { kind: "single_arm", n: 60 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, treatmentHazardRatios: NPH, controlMedian: 12 }, analysis: { method: "one_sample_logrank", alternative: "less", sided: 1, alpha: 0.025 }, accrual: { duration: 12, followup: 12 } })
    .some((issue) => issue.code === "scenario_field_unknown"));
  // the log-rank stays the first (and so the default) analysis of the table
  assert.deepEqual([...VCR_TWO_ARM_ANALYSIS_METHODS.time_to_event], ["logrank", "rmst", "maxcombo"]);
});

test("D1: the analytic design and the assurance refuse both by name and point to the simulation", () => {
  const analytic = { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { duration: 12, followup: 18 }, analysis: { alpha: 0.025, power: 0.9, sided: 1 } };
  assert.deepEqual(validateScenario("design.analytic", analytic), []);
  const nph = validateScenario("design.analytic", { ...analytic, truth: { ...analytic.truth, treatmentHazardRatios: NPH } });
  assert.ok(codes(nph).includes("scenario_value_invalid@scenario.truth.treatmentHazardRatios"));
  assert.ok(!codes(nph).includes("scenario_field_unknown@scenario.truth.treatmentHazardRatios"), "named, not merely unread");
  assert.match(nph.find((issue) => issue.code === "scenario_value_invalid")?.detail ?? "", /design_simulation/);
  const mc = validateScenario("design.analytic", { ...analytic, analysis: { ...analytic.analysis, method: "maxcombo" } });
  assert.ok(codes(mc).includes("scenario_value_invalid@scenario.analysis.method"));
  assert.ok(!codes(mc).includes("scenario_field_unknown@scenario.analysis.method"));
});

test("D1: a hazard ratio that changes over time is a null case only when every ratio is 1; a grid truth that states its own law replaces the base's", () => {
  assert.equal(vcrIsNullScenario(simulate({ truth: { treatmentHazardRatios: { breaks: [6], ratios: [1, 1] }, controlMedian: 12 } })), true);
  assert.equal(vcrIsNullScenario(simulate()), false);
  assert.equal(vcrIsNullScenario(simulate({ truth: { hazardRatio: 1, controlMedian: 12 } })), true);
  const grid = { ...simulate({ truth: { hazardRatio: 0.7, controlMedian: 12 }, analysis: { method: "logrank", alpha: 0.025, sided: 1 } }), designs: [{ nTreat: 100 }], truths: [{ treatmentHazardRatios: NPH }, { hazardRatio: 0.8 }] };
  assert.deepEqual(validateScenario("design.grid", grid), []);
  // a cell still has to be one valid law: a ratio list of the wrong length is the cell's fault, named by it
  assert.ok(codes(validateScenario("design.grid", { ...grid, truths: [{ treatmentHazardRatios: { breaks: [6], ratios: [1] } }] })).includes("scenario_value_invalid@truths[0]"));
});

test("D1/D5: design.simulate and design.grid are 1.3.0; 1.2.0 results replay, unless the scenario asks for what 1.3.0 added", () => {
  for (const method of ["design.simulate", "design.grid"]) {
    assert.equal(/** @type {any} */ (VCR_ENGINE_METHODS)[method].version, "1.3.0");
    assert.deepEqual([.../** @type {any} */ (VCR_ENGINE_METHODS)[method].compatibleVersions], ["1.2.0"]);
  }
  const ph = simulate({ truth: { hazardRatio: 0.7, controlMedian: 12 }, analysis: { method: "logrank", alpha: 0.025, sided: 1 } });
  assert.deepEqual(validateEngineJob(job("design.simulate", "design_simulation", "1.2.0", ph)), [], "proportional hazards replay under 1.2.0");
  assert.deepEqual(validateEngineJob(job("design.simulate", "design_simulation", "1.3.0", simulate())), []);
  assert.ok(codes(validateEngineJob(job("design.simulate", "design_simulation", "1.2.0", simulate()))).includes("method_version_mismatch@methodVersion"));
  assert.ok(codes(validateEngineJob(job("design.simulate", "design_simulation", "1.2.0", simulate({ truth: { hazardRatio: 0.7, controlMedian: 12 } })))).includes("method_version_mismatch@methodVersion"), "MaxCombo is 1.3.0's");
  const grid = { ...ph, designs: [{ nTreat: 100 }], truths: [{ treatmentHazardRatios: NPH }] };
  assert.ok(codes(validateEngineJob(job("design.grid", "design_grid", "1.2.0", grid))).includes("method_version_mismatch@methodVersion"));
  assert.deepEqual(validateEngineJob(job("design.grid", "design_grid", "1.2.0", { ...ph, designs: [{ nTreat: 100 }], truths: [{ hazardRatio: 0.8 }] })), []);
  // the 1.0.0 and 1.1.0 records keep their own rule
  assert.deepEqual(validateEngineJob(job("design.simulate", "design_simulation", "1.1.0", ph)), []);
});
