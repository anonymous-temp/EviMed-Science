import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { simulationScore, simulationRequiredReplicates, simulationSpecificationIssues, SIMULATION_LIMITS } from "./simulation.mjs";

/** Seeded standard normals (Box-Muller over a hash stream), so every figure below is reproducible. */
function normals(seed) {
  let counter = 0;
  const uniform = () => (createHash("sha256").update(`${seed}:${counter++}`).digest().readUIntBE(0, 6) + 0.5) / 2 ** 48;
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}
/** One replicate of an honest estimator: the sample mean of `m` unit-variance draws with a z interval and test of zero. */
function honestReplicates(seed, n, truth, m = 25) {
  const z = normals(seed), se = 1 / Math.sqrt(m);
  return Array.from({ length: n }, () => {
    let sum = 0; for (let i = 0; i < m; i++) sum += truth + z();
    const estimate = sum / m, statistic = Math.abs(estimate / se);
    // Two-sided normal p-value through the complementary error function's series-free bound is not needed:
    // only the rejection decision is scored, so an exact tail is computed from the same quantile.
    return { estimate, lower: estimate - 1.959964 * se, upper: estimate + 1.959964 * se, p: statistic >= 1.959964 ? 0.01 : 0.5 };
  });
}
const specification = { truth: 0.5, alpha: 0.05, coverage: 0.95, coverageTolerance: 0.03, maxBias: 0.05, falsePositiveTolerance: 0.02 };
const nullSpecification = { ...specification, truth: 0 };

test("the reviewer's three probes no longer pass", () => {
  // Two replicates at +5 and -5 around a truth of 0, one interval covering.
  const two = simulationScore([{ estimate: 5, lower: 4, upper: 6, p: 0.5 }, { estimate: -5, lower: -6, upper: 6, p: 0.5 }], { truth: 0, alpha: 0.05, coverage: 0.5, maxBias: 0.01, coverageTolerance: 0.01, falsePositiveTolerance: 0.01 });
  assert.equal(two.valid, false);
  assert.ok(two.reasons.includes("insufficient_replicates"));
  // No p-value at all: a missing p is a failure in the denominator, not "no false positive".
  const required = simulationRequiredReplicates(nullSpecification);
  const withoutP = honestReplicates("no-p", required, 0).map(({ p, ...row }) => row);
  const missing = simulationScore(withoutP, nullSpecification);
  assert.equal(missing.valid, false);
  assert.equal(missing.failures, required);
  assert.equal(missing.falsePositive, 1);
  assert.ok(missing.reasons.includes("failed_outputs"));
  // Unbounded intervals: coverage 1.0 used to pass whenever the tolerance reached 0.05.
  const unbounded = honestReplicates("unbounded", required, 0).map(row => ({ ...row, lower: -1e9, upper: 1e9 }));
  const wide = simulationScore(unbounded, { ...nullSpecification, coverageTolerance: 0.051 });
  assert.equal(wide.valid, false);
  assert.equal(wide.coverage, 1);
  assert.ok(wide.reasons.includes("coverage_outside_tolerance"));
  assert.ok(wide.reasons.includes("interval_width_unbounded"));
});

test("the criteria are judged against their Monte Carlo standard errors, and the errors are reported", () => {
  const n = simulationRequiredReplicates(specification);
  assert.ok(n >= SIMULATION_LIMITS.minReplicates);
  const score = simulationScore(honestReplicates("honest", n, 0.5), specification);
  assert.equal(score.valid, true, JSON.stringify(score.reasons));
  assert.equal(score.n, n);
  assert.equal(score.failures, 0);
  assert.ok(Math.abs(score.empiricalSe - 0.2) < 0.02);
  assert.ok(Math.abs(score.mcseBias - score.empiricalSe / Math.sqrt(n)) < 1e-12);
  assert.ok(Math.abs(score.mcseCoverage - Math.sqrt(score.coverage * (1 - score.coverage) / n)) < 1e-12);
  assert.ok(score.mcseFalsePositive >= 0 && Number.isFinite(score.power));
  assert.ok(Math.abs(score.widthRatio - 1) < 0.05, "a z interval is as wide as the empirical spread says");
  // The same estimator with a real bias of 0.08 against a bound of 0.05 fails, and says why.
  const biased = simulationScore(honestReplicates("biased", n, 0.58), specification);
  assert.equal(biased.valid, false);
  assert.ok(biased.reasons.includes("bias_outside_bound"));
  // Fewer replicates never make a criterion easier: the interval around the estimate must fit inside the bound.
  const few = simulationScore(honestReplicates("honest", SIMULATION_LIMITS.minReplicates, 0.5), { ...specification, replicates: undefined });
  assert.ok(few.n < n);
  assert.equal(few.valid, false, "below the replicate count the specification's own tolerance needs");
});

test("degenerate estimators fail whatever their averages say", () => {
  const n = simulationRequiredReplicates(nullSpecification);
  // A constant: zero bias around a null truth, every interval covering.
  const constant = simulationScore(Array.from({ length: n }, () => ({ estimate: 0, lower: -1, upper: 1, p: 0.5 })), nullSpecification);
  assert.equal(constant.valid, false);
  assert.ok(constant.reasons.includes("degenerate_estimates"));
  // Non-finite and inverted outputs are failures in every denominator.
  const rows = honestReplicates("nan", n, 0);
  const failed = 300;
  for (let i = 0; i < failed; i++) rows[i] = i % 3 === 0 ? { estimate: NaN, lower: 0, upper: 1, p: 0.5 } : i % 3 === 1 ? { estimate: 0, lower: 1, upper: -1, p: 0.5 } : { estimate: 0, lower: -1, upper: 1, p: 2 };
  const broken = simulationScore(rows, nullSpecification);
  assert.equal(broken.valid, false);
  assert.equal(broken.failures, failed);
  assert.ok(broken.coverage <= (n - failed) / n, "a failed output never covers");
  assert.ok(broken.falsePositive >= failed / n, "a failed output is counted as a rejection");
  assert.ok(broken.reasons.includes("failed_outputs"));
  // A null truth cannot tell an estimator from the constant zero, and the score says so.
  assert.equal(simulationScore(honestReplicates("null", n, 0), nullSpecification).discriminatesTrivial, false);
  assert.equal(simulationScore(honestReplicates("alt", n, 0.5), specification).discriminatesTrivial, true);
});

test("a specification cannot buy a pass with its own numbers", () => {
  assert.deepEqual(simulationSpecificationIssues(specification), []);
  assert.ok(simulationSpecificationIssues({ ...specification, coverage: 1 }).includes("coverage_nominal_invalid"));
  assert.ok(simulationSpecificationIssues({ ...specification, coverageTolerance: 0.05 }).includes("coverage_tolerance_exceeds_bound"));
  assert.ok(simulationSpecificationIssues({ ...specification, falsePositiveTolerance: 0.06 }).includes("false_positive_tolerance_exceeds_bound"));
  assert.ok(simulationSpecificationIssues({ ...specification, maxBias: 0.5 }).includes("bias_bound_accepts_trivial_answer"));
  assert.ok(simulationSpecificationIssues({ ...specification, maxBias: -1 }).includes("bias_bound_invalid"));
  assert.ok(simulationSpecificationIssues({ ...specification, truth: "0" }).includes("truth_invalid"));
  assert.ok(simulationSpecificationIssues({ ...specification, maxWidthRatio: 5 }).includes("width_ratio_exceeds_bound"));
  const refused = simulationScore(honestReplicates("x", 1000, 0.5), { ...specification, coverage: 1 });
  assert.equal(refused.valid, false);
  assert.ok(refused.reasons.includes("specification_invalid"));
  assert.throws(() => simulationScore(null, specification), /replicates/);
});
