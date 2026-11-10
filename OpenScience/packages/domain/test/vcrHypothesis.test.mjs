// T1 (algorithm round, 2026-11-03): the hypothesis of a two-arm design, design.analytic / design.simulate / design.grid 1.4.0.
import assert from "node:assert/strict";
import test from "node:test";
import { validateEngineJob, validateScenario, vcrIsNullScenario, vcrNullTruth, VCR_ENGINE_METHODS } from "../index.mjs";

/** @param {number} margin @param {string} [direction] a mean or a risk states which way is better; a hazard ratio does not */
const ni = (margin, direction) => ({ kind: "non_inferiority", margin, ...(direction === undefined ? {} : { direction }) });
/** @param {Record<string, any>} [extra] */
const analytic = (extra = {}) => ({ design: { kind: "two_arm_fixed" }, endpoint: { type: "continuous" }, truth: { effect: 0, sd: 1 }, analysis: { alpha: 0.025, power: 0.9 }, ...extra });
/** @param {Record<string, any>} [extra] */
const simulate = (extra = {}) => ({ design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "continuous" }, truth: { effect: 0, sd: 1 }, ...extra });
/** @param {string} method @param {string} kind @param {string} methodVersion @param {Record<string, any>} scenario */
const job = (method, kind, methodVersion, scenario) => ({ jobId: "job_h", studyId: "std_h", kind, method, methodVersion, protocolVersion: 1, scenario, inputs: [{ kind: "assumption", id: "asm_h@1" }], seed: 1, cpuSecondsLimit: 600, cores: 1, ...(method === "design.simulate" ? { replicates: 5000 } : {}) });
/** @param {ReadonlyArray<{ code: string, field: string }>} issues */
const keys = (issues) => issues.map((issue) => `${issue.code}@${issue.field}`);

test("a non-inferiority margin is a positive number on the scale of the endpoint, for a two-arm design only", () => {
  assert.deepEqual(validateScenario("design.analytic", analytic({ hypothesis: ni(0.3, "higher_better") })), []);
  assert.deepEqual(validateScenario("design.analytic", analytic({ hypothesis: { kind: "superiority" } })), []);
  assert.deepEqual(keys(validateScenario("design.analytic", analytic({ hypothesis: { kind: "non_inferiority", direction: "higher_better" } }))), ["scenario_field_missing@scenario.hypothesis.margin"]);
  assert.deepEqual(keys(validateScenario("design.analytic", analytic({ hypothesis: ni(-1, "higher_better") }))), ["scenario_value_invalid@scenario.hypothesis.margin"]);
  // the scale: a risk difference is below 1, a hazard ratio above 1
  const binary = { design: { kind: "two_arm_fixed" }, endpoint: { type: "binary" }, truth: { controlRate: 0.5, treatmentRate: 0.5 } };
  assert.deepEqual(validateScenario("design.analytic", { ...binary, hypothesis: ni(0.1, "higher_better") }), []);
  assert.deepEqual(keys(validateScenario("design.analytic", { ...binary, hypothesis: ni(1.2, "higher_better") })), ["scenario_value_invalid@scenario.hypothesis.margin"]);
  const tte = { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 1, controlMedian: 12 }, accrual: { duration: 12, followup: 12 } };
  assert.deepEqual(validateScenario("design.analytic", { ...tte, hypothesis: ni(1.3) }), []);
  assert.deepEqual(keys(validateScenario("design.analytic", { ...tte, hypothesis: ni(0.8) })), ["scenario_value_invalid@scenario.hypothesis.margin"]);
  // a single-arm design states its benchmark; the analysis a margin is tested with is the endpoint's own
  const single = { design: { kind: "single_arm", n: 40 }, endpoint: { type: "binary" }, truth: { nullRate: 0.2, responseRate: 0.3 }, analysis: { method: "exact_binomial", alternative: "greater", alpha: 0.05 } };
  assert.ok(keys(validateScenario("design.simulate", { ...single, hypothesis: ni(0.1, "higher_better") })).includes("scenario_value_invalid@scenario.hypothesis.kind"));
  assert.deepEqual(keys(validateScenario("design.simulate", simulate({ hypothesis: ni(0.3, "higher_better"), analysis: { method: "ancova" } }))), ["scenario_value_invalid@scenario.analysis.method"]);
  assert.deepEqual(validateScenario("design.simulate", simulate({ hypothesis: ni(0.3, "higher_better"), analysis: { method: "ttest", alpha: 0.025 } })), []);
});

test("the null of a non-inferiority design is the margin, not an effect of zero", () => {
  assert.equal(vcrIsNullScenario(simulate({ hypothesis: ni(0.3, "higher_better"), truth: { effect: -0.3, sd: 1 } })), true);
  assert.equal(vcrIsNullScenario(simulate({ hypothesis: ni(0.3, "higher_better"), truth: { effect: 0, sd: 1 } })), false);
  assert.equal(vcrIsNullScenario(simulate({ truth: { effect: 0, sd: 1 } })), true, "without a hypothesis an effect of zero is still the null");
  const tte = { design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "time_to_event" }, accrual: { duration: 12, followup: 12 } };
  assert.equal(vcrIsNullScenario({ ...tte, hypothesis: ni(1.3), truth: { hazardRatio: 1.3, controlMedian: 12 } }), true);
  assert.equal(vcrIsNullScenario({ ...tte, hypothesis: ni(1.3), truth: { hazardRatio: 1, controlMedian: 12 } }), false);
  const binary = { design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "binary" } };
  assert.equal(vcrIsNullScenario({ ...binary, hypothesis: ni(0.1, "higher_better"), truth: { controlRate: 0.8, riskDifference: -0.1 } }), true);
  assert.equal(vcrIsNullScenario({ ...binary, hypothesis: ni(0.1, "higher_better"), truth: { controlRate: 0.8, treatmentRate: 0.7 } }), true);
  // the case the programme runs beside the alternative to measure the type I error is the margin itself
  assert.deepEqual(vcrNullTruth(simulate({ hypothesis: ni(0.3, "higher_better") })), { sd: 1, effect: -0.3 });
  assert.deepEqual(vcrNullTruth({ ...tte, hypothesis: ni(1.3), truth: { hazardRatio: 1, controlMedian: 12 } }), { controlMedian: 12, hazardRatio: 1.3 });
  assert.deepEqual(vcrNullTruth({ ...binary, hypothesis: ni(0.1, "higher_better"), truth: { controlRate: 0.8, treatmentRate: 0.8 } }), { controlRate: 0.8, riskDifference: -0.1 });
  assert.deepEqual(vcrNullTruth(simulate()), { sd: 1, effect: 0 }, "a superiority design keeps its null");
});

test("the hypothesis is 1.4.0's: an older label replays what it had and cannot carry one", () => {
  for (const method of ["design.analytic", "design.simulate", "design.grid"]) {
    // (design.simulate and design.grid went on to 1.5.0 with the modestly weighted test, T12; the hypothesis stays theirs from 1.4.0)
    assert.equal(/** @type {any} */ (VCR_ENGINE_METHODS)[method].version, method === "design.analytic" ? "1.4.0" : "1.5.0", method);
    assert.ok(/** @type {any} */ (VCR_ENGINE_METHODS)[method].compatibleVersions.includes("1.3.0"), method);
  }
  assert.deepEqual(validateEngineJob(job("design.analytic", "design_analytic", "1.4.0", analytic({ hypothesis: ni(0.3, "higher_better") }))), []);
  assert.deepEqual(validateEngineJob(job("design.analytic", "design_analytic", "1.3.0", analytic())), [], "a superiority job recorded at 1.3.0 replays");
  assert.ok(keys(validateEngineJob(job("design.analytic", "design_analytic", "1.3.0", analytic({ hypothesis: ni(0.3, "higher_better") })))).includes("method_version_mismatch@methodVersion"));
  assert.ok(keys(validateEngineJob(job("design.simulate", "design_simulation", "1.3.0", simulate({ hypothesis: ni(0.3, "higher_better") })))).includes("method_version_mismatch@methodVersion"));
  assert.ok(keys(validateEngineJob(job("design.analytic", "design_analytic", "1.0.0", analytic({ hypothesis: ni(0.3, "higher_better") })))).includes("method_version_mismatch@methodVersion"));
});

test("a grid cell inherits the hypothesis and is checked against it", () => {
  const grid = { ...simulate({ hypothesis: ni(0.3, "higher_better") }), designs: [{ nTreat: 100 }], truths: [{ effect: 0 }, { effect: -0.3 }] };
  assert.deepEqual(validateScenario("design.grid", grid), []);
  assert.ok(keys(validateScenario("design.grid", { ...grid, hypothesis: ni(0.3, "higher_better"), analysis: { method: "ancova" } })).length > 0);
});

test("a margin on a mean or a risk states which way is better, and a hazard ratio does not", () => {
  // never defaulted: the same margin is a different question the other way (34,504 patients against 1,404 for the same two event rates)
  assert.deepEqual(keys(validateScenario("design.analytic", analytic({ hypothesis: ni(0.3) }))), ["scenario_field_missing@scenario.hypothesis.direction"]);
  assert.deepEqual(keys(validateScenario("design.simulate", simulate({ hypothesis: ni(0.3) }))), ["scenario_field_missing@scenario.hypothesis.direction"]);
  assert.deepEqual(validateScenario("design.analytic", analytic({ hypothesis: ni(0.3, "lower_better") })), []);
  assert.deepEqual(keys(validateScenario("design.analytic", analytic({ hypothesis: ni(0.3, "smaller") }))), ["scenario_value_invalid@scenario.hypothesis.direction"]);
  const binary = { design: { kind: "two_arm_fixed" }, endpoint: { type: "binary" }, truth: { controlRate: 0.1, treatmentRate: 0.08 } };
  assert.deepEqual(keys(validateScenario("design.analytic", { ...binary, hypothesis: ni(0.03) })), ["scenario_field_missing@scenario.hypothesis.direction"]);
  assert.deepEqual(validateScenario("design.analytic", { ...binary, hypothesis: ni(0.03, "lower_better") }), []);
  // a hazard ratio has its direction already (a lower ratio is the benefit): the key is not read, and a superiority design does not state one
  const tte = { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 1, controlMedian: 12 }, accrual: { duration: 12, followup: 12 } };
  assert.deepEqual(keys(validateScenario("design.analytic", { ...tte, hypothesis: ni(1.3, "lower_better") })), ["scenario_field_unknown@scenario.hypothesis.direction"]);
  assert.deepEqual(keys(validateScenario("design.analytic", analytic({ hypothesis: { kind: "superiority", direction: "higher_better" } }))), ["scenario_field_unknown@scenario.hypothesis.direction"]);
});

test("the null of a margin where lower is better is PLUS the margin", () => {
  assert.equal(vcrIsNullScenario(simulate({ hypothesis: ni(0.3, "lower_better"), truth: { effect: 0.3, sd: 1 } })), true);
  assert.equal(vcrIsNullScenario(simulate({ hypothesis: ni(0.3, "lower_better"), truth: { effect: -0.3, sd: 1 } })), false);
  const binary = { design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "binary" } };
  assert.equal(vcrIsNullScenario({ ...binary, hypothesis: ni(0.03, "lower_better"), truth: { controlRate: 0.1, riskDifference: 0.03 } }), true);
  assert.equal(vcrIsNullScenario({ ...binary, hypothesis: ni(0.03, "lower_better"), truth: { controlRate: 0.1, treatmentRate: 0.13 } }), true);
  assert.equal(vcrIsNullScenario({ ...binary, hypothesis: ni(0.03, "lower_better"), truth: { controlRate: 0.1, treatmentRate: 0.07 } }), false);
  assert.deepEqual(vcrNullTruth(simulate({ hypothesis: ni(0.3, "lower_better") })), { sd: 1, effect: 0.3 });
  assert.deepEqual(vcrNullTruth({ ...binary, hypothesis: ni(0.03, "lower_better"), truth: { controlRate: 0.1, treatmentRate: 0.08 } }), { controlRate: 0.1, riskDifference: 0.03 });
});
