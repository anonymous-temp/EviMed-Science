// What the engine fills in when a scenario states nothing (remediation plan A2), the zero-effect case a two-arm design is also run
// under (A1), and the replicate floors by intended use (decision 3). All three are the domain's, so both sides read one answer.
import assert from "node:assert/strict";
import test from "node:test";
import {
  VCR_REPLICATES_NULL_MIN, VCR_REPLICATES_NULL_MIN_BORROWING, VCR_REPLICATES_NULL_MIN_BY_USE, VCR_INTENDED_USES, replicateFloor, replicatePlan,
  validateScenario, vcrAppliedDefaults, vcrBorrowsExternally, vcrIsNullScenario, vcrNullReplicateFloor, vcrNullTruth, vcrReplicateFloorFor, vcrReplicatePlanFor,
} from "../index.mjs";

/** The two-arm survival design that states six values and nothing else: the sizes, the effect, the control median, the accrual and the follow-up. */
const SIX_VALUES = Object.freeze({
  design: { kind: "two_arm_fixed", nTreat: 150, nControl: 150 }, endpoint: { type: "time_to_event" },
  truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { duration: 18, followup: 12 },
});

const taken = (/** @type {string} */ method, /** @type {any} */ scenario) => Object.fromEntries(vcrAppliedDefaults(method, scenario).map((entry) => [entry.path, entry.value]));

test("the six-value two-arm survival design: everything else the simulation uses is listed as a default, a dropout of 0 among it", () => {
  assert.deepEqual(validateScenario("design.simulate", SIX_VALUES), []);
  assert.deepEqual(taken("design.simulate", SIX_VALUES), {
    "truth.controlDistribution.kind": "exponential",
    "analysis.alpha": 0.025,
    "analysis.sided": 1,
    "accrual.kind": "uniform",
    "accrual.dropoutAnnual": 0,
    timeUnit: "months",
    "analysis.method": "logrank",
  });
  // The dropout is the one the page must show: it is in with its unit.
  assert.deepEqual(vcrAppliedDefaults("design.simulate", SIX_VALUES).find((entry) => entry.path === "accrual.dropoutAnnual"),
    { path: "accrual.dropoutAnnual", value: 0, unit: "proportion per year" });
  // The sizing calculation takes the allocation, the power and the same error rates and dropout.
  const analytic = taken("design.analytic", { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" }, truth: SIX_VALUES.truth, accrual: SIX_VALUES.accrual });
  assert.equal(analytic["design.allocation"], 0.5);
  assert.equal(analytic["analysis.power"], 0.9);
  assert.equal(analytic["accrual.dropoutAnnual"], 0);
});

test("what a scenario states is not a default, and a block left out whole is read as empty only where the engine reads it that way", () => {
  const stated = { ...SIX_VALUES, analysis: { method: "rmst", alpha: 0.05, sided: 2, tau: 24 }, accrual: { kind: "uniform", duration: 18, followup: 12, dropoutAnnual: 0.1 },
    truth: { ...SIX_VALUES.truth, controlDistribution: { kind: "weibull", shape: 1.2, scale: 14 } }, timeUnit: "months" };
  assert.deepEqual(taken("design.simulate", stated), {});
  // No accrual and no analysis at all: both are read whole, with their defaults; a design prior the scenario leaves out is not (it has no defaults to take).
  const bare = taken("design.simulate", { design: SIX_VALUES.design, endpoint: SIX_VALUES.endpoint, truth: SIX_VALUES.truth });
  assert.equal(bare["accrual.dropoutAnnual"], 0);
  assert.equal(bare["analysis.alpha"], 0.025);
  assert.equal(Object.keys(bare).some((path) => path.startsWith("designPrior")), false);
  // A field that does not apply to this endpoint is never listed: a binary design has no accrual, no time unit.
  const binary = taken("design.simulate", { design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "binary" }, truth: { controlRate: 0.3, treatmentRate: 0.45 } });
  assert.deepEqual(Object.keys(binary).sort(), ["analysis.alpha", "analysis.method", "analysis.sided", "truth.covariateLogit"]);
  assert.equal(binary["analysis.method"], "risk_difference");
  // Single-arm designs state their analysis, so it is never a default.
  assert.equal("analysis.method" in taken("design.simulate", { design: { kind: "single_arm", n: 40 }, endpoint: { type: "binary" }, truth: { nullRate: 0.2, responseRate: 0.4 },
    analysis: { method: "exact_binomial", alternative: "greater", sided: 1 } }), false);
  assert.deepEqual(vcrAppliedDefaults("no.such.method", SIX_VALUES), []);
  assert.deepEqual(vcrAppliedDefaults("design.simulate", null), []);
});

test("a two-arm design has a null case of its own: one key says no effect, the rest of the truth stays, and it is the null case", () => {
  const nullOf = (/** @type {any} */ scenario) => ({ ...scenario, truth: vcrNullTruth(scenario) });
  const survival = nullOf(SIX_VALUES);
  assert.deepEqual(survival.truth, { hazardRatio: 1, controlMedian: 12 });
  assert.deepEqual(validateScenario("design.simulate", survival), []);
  assert.equal(vcrIsNullScenario(survival), true);
  assert.equal(vcrIsNullScenario(SIX_VALUES), false);
  const binary = { design: { kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, endpoint: { type: "binary" }, truth: { controlRate: 0.3, treatmentRate: 0.45, covariateLogit: 0.2 } };
  assert.deepEqual(vcrNullTruth(binary), { controlRate: 0.3, covariateLogit: 0.2, riskDifference: 0 }, "no copy of the control rate: it may be a card's");
  assert.equal(vcrIsNullScenario(nullOf(binary)), true);
  assert.deepEqual(validateScenario("design.simulate", nullOf(binary)), []);
  const continuous = { design: { kind: "two_arm_fixed", nTreat: 60, nControl: 60 }, endpoint: { type: "continuous" }, truth: { effect: 4, sd: 10, baselineCorrelation: 0.3, null: false } };
  assert.deepEqual(vcrNullTruth(continuous), { sd: 10, baselineCorrelation: 0.3, effect: 0 }, "a stated label that would contradict the law is left out");
  assert.equal(vcrIsNullScenario(nullOf(continuous)), true);
  // Group-sequential survival is a two-arm design; a truth left out entirely is an empty one.
  assert.deepEqual(vcrNullTruth({ ...SIX_VALUES, design: { kind: "group_sequential" }, truth: undefined }), { hazardRatio: 1 });
  // Single-arm designs state their effect over a benchmark in other keys: there is no second case of this kind.
  assert.equal(vcrNullTruth({ design: { kind: "single_arm", n: 40 }, endpoint: { type: "binary" }, truth: { nullRate: 0.2, responseRate: 0.4 } }), null);
  assert.equal(vcrNullTruth({ design: { kind: "simon_two_stage" }, endpoint: { type: "binary" }, truth: {} }), null);
});

test("the null floor by intended use is a table beside the existing floors (decision 3)", () => {
  assert.deepEqual({ ...VCR_REPLICATES_NULL_MIN_BY_USE }, { exploratory: 20_000, design_support: 20_000, specified_analysis: 100_000, submission_preparation: 100_000 });
  assert.deepEqual(Object.keys(VCR_REPLICATES_NULL_MIN_BY_USE), [...VCR_INTENDED_USES], "one row per intended use, in the ladder's order");
  assert.equal(VCR_REPLICATES_NULL_MIN, 20_000, "the existing floor does not move");
  assert.equal(VCR_REPLICATES_NULL_MIN_BORROWING, 100_000);
  assert.deepEqual(vcrNullReplicateFloor({ intendedUse: "exploratory" }), { floor: 20_000, basis: "default" });
  assert.deepEqual(vcrNullReplicateFloor({ intendedUse: "design_support" }), { floor: 20_000, basis: "default" });
  assert.deepEqual(vcrNullReplicateFloor({ intendedUse: "specified_analysis" }), { floor: 100_000, basis: "intended_use" });
  assert.deepEqual(vcrNullReplicateFloor({ intendedUse: "submission_preparation" }), { floor: 100_000, basis: "intended_use" });
  assert.deepEqual(vcrNullReplicateFloor({ intendedUse: "exploratory", borrowing: true }), { floor: 100_000, basis: "borrowing" });
  assert.deepEqual(vcrNullReplicateFloor({ intendedUse: "specified_analysis", borrowing: true }), { floor: 100_000, basis: "borrowing" });
  assert.deepEqual(vcrNullReplicateFloor({}), { floor: 20_000, basis: "default" }, "no use stated is an exploration");
  assert.deepEqual(vcrNullReplicateFloor({ intendedUse: "no such use" }), { floor: 20_000, basis: "default" });
});

test("the floor of a scenario takes the use and the borrowing into account, and says which set it", () => {
  const nullCase = { ...SIX_VALUES, truth: { hazardRatio: 1, controlMedian: 12 } };
  assert.equal(vcrReplicateFloorFor(nullCase), 20_000);
  assert.equal(vcrReplicateFloorFor(nullCase, { intendedUse: "specified_analysis" }), 100_000);
  assert.equal(vcrReplicateFloorFor(SIX_VALUES, { intendedUse: "specified_analysis" }), 5_000, "the alternative's floor does not move with the use");
  assert.equal(replicateFloor({ isNull: true, intendedUse: "submission_preparation" }), 100_000);
  assert.equal(replicateFloor({ isNull: false, intendedUse: "submission_preparation" }), 5_000);
  assert.deepEqual(vcrReplicatePlanFor(nullCase, { intendedUse: "specified_analysis" }), { floor: 100_000, basis: "intended_use", isNull: true, targetMcse: null });
  // The precision a scenario asks for outranks the use only when it needs more, and then it is what set the number.
  assert.equal(vcrReplicatePlanFor({ ...nullCase, targetMcse: 0.001 }, { intendedUse: "specified_analysis" }).basis, "intended_use");
  assert.deepEqual(replicatePlan({ isNull: true, targetMcse: 0.0004, intendedUse: "specified_analysis" }), { floor: 152_344, basis: "target_mcse", isNull: true, targetMcse: 0.0004 });
  // A stratified external control borrows from outside the trial, and a grid that has one among its designs does too.
  const external = { design: { kind: "single_arm_external", n: 100 }, endpoint: { type: "binary" }, truth: { controlRates: [0.3, 0.4], treatmentRates: [0.3, 0.4] }, external: { targetPrevalence: 0.5 } };
  assert.equal(vcrBorrowsExternally(external), true);
  assert.equal(vcrBorrowsExternally({ designs: [{ kind: "two_arm_fixed" }, { kind: "single_arm_external" }] }), true);
  assert.equal(vcrBorrowsExternally(SIX_VALUES), false);
  assert.equal(vcrReplicateFloorFor(external, { intendedUse: "exploratory" }), 100_000);
  assert.equal(vcrReplicatePlanFor(external, { intendedUse: "exploratory" }).basis, "borrowing");
});
