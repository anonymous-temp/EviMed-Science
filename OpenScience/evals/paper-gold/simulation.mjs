/**
 * How a known-truth simulation is judged (the V1 route for a method with no published worked example).
 *
 * Read the way simulation studies are reported: Morris, White and Crowther, "Using simulation studies
 * to evaluate statistical methods", Stat Med 2019 (the plan's reference 32; "ADEMP"). Every performance
 * measure is an estimate from a finite number of replicates and has a Monte Carlo standard error, and
 * the standard error is evidence about the measure, not slack to add to the bound.
 *
 * What this replaced, and why each rule exists:
 *  - the pass band was `tolerance + 1.96 * MCSE`, so fewer replicates made every criterion easier: two
 *    replicates at +5 and -5 around a truth of 0 passed. Now a criterion passes only when the whole 95%
 *    Monte Carlo interval of the measure lies inside the bound, so fewer replicates can only fail;
 *  - a missing p-value read as "not significant". Now a row whose estimate, bounds or p-value is missing,
 *    non-finite or inverted is a failed output: it stays in every denominator, never covers, and counts
 *    as a rejection;
 *  - coverage was two-sided around nominal with a tolerance the specification chose, so unbounded
 *    intervals (coverage 1.0) passed. Now the tolerance is capped below `1 - nominal`, the interval of
 *    a proportion is Wilson's (it does not collapse to zero width at 0 or 1), and the mean interval
 *    width is bounded against the empirical spread of the estimates;
 *  - nothing required a minimum number of replicates. Now `simulationRequiredReplicates` derives it from
 *    the specification's own tolerance, with a floor.
 */

export const SIMULATION_LIMITS = Object.freeze({
  /** Below this a coverage near 95% has a Monte Carlo standard error above 1.5 points. */
  minReplicates: 200,
  /** The Monte Carlo half-interval must be at most this share of the tolerance, so a method that truly
   *  meets the criterion is not failed by the luck of one fixed set of preregistered datasets. */
  intervalShareOfTolerance: 1 / 3,
  /** A coverage tolerance may be at most this share of `1 - nominal`: 100% coverage must always fail. */
  maxCoverageToleranceShare: 0.6,
  /** Failed outputs a specification may tolerate. Zero unless it preregisters otherwise. */
  maxFailureRate: 0.05,
  /** Mean interval width against the width the empirical spread implies. */
  defaultWidthRatio: 1.5,
  maxWidthRatio: 2,
  /** The 97.5% normal quantile, used for every Monte Carlo interval. */
  z: 1.959963984540054,
});

/** Inverse normal distribution (Acklam's rational approximation; absolute error below 1.2e-9). @param {number} p */
function normalQuantile(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - 0.02425) return -normalQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Wilson's score interval for a proportion: unlike the Wald interval it has width at 0 and at 1. @param {number} successes @param {number} n */
function wilson(successes, n) {
  const z = SIMULATION_LIMITS.z, p = successes / n, denominator = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denominator, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * What is wrong with a preregistered specification, as closed codes. A specification with issues cannot
 * pass: its tolerances are its own, and these are the bounds it may not exceed.
 * @param {any} specification
 * @returns {string[]}
 */
export function simulationSpecificationIssues(specification) {
  const issues = [];
  const s = specification ?? {};
  const nullValue = s.nullValue ?? 0;
  if (typeof s.truth !== 'number' || !Number.isFinite(s.truth) || typeof nullValue !== 'number' || !Number.isFinite(nullValue)) issues.push('truth_invalid');
  if (!(typeof s.alpha === 'number' && s.alpha > 0 && s.alpha < 0.5)) issues.push('alpha_invalid');
  const nominal = typeof s.coverage === 'number' && s.coverage >= 0.5 && s.coverage < 1;
  if (!nominal) issues.push('coverage_nominal_invalid');
  if (!(typeof s.coverageTolerance === 'number' && s.coverageTolerance > 0)) issues.push('coverage_tolerance_invalid');
  else if (nominal && s.coverageTolerance > (1 - s.coverage) * SIMULATION_LIMITS.maxCoverageToleranceShare + 1e-12) issues.push('coverage_tolerance_exceeds_bound');
  if (!(typeof s.maxBias === 'number' && Number.isFinite(s.maxBias) && s.maxBias > 0)) issues.push('bias_bound_invalid');
  // A bias bound as wide as the distance from truth to the null would accept an estimator that always answers the null.
  else if (!issues.includes('truth_invalid') && s.truth !== nullValue && s.maxBias >= Math.abs(s.truth - nullValue)) issues.push('bias_bound_accepts_trivial_answer');
  if (!(typeof s.falsePositiveTolerance === 'number' && s.falsePositiveTolerance >= 0)) issues.push('false_positive_tolerance_invalid');
  else if (typeof s.alpha === 'number' && s.falsePositiveTolerance > s.alpha) issues.push('false_positive_tolerance_exceeds_bound');
  if (s.maxFailureRate !== undefined && !(typeof s.maxFailureRate === 'number' && s.maxFailureRate >= 0 && s.maxFailureRate <= SIMULATION_LIMITS.maxFailureRate)) issues.push('failure_rate_exceeds_bound');
  if (s.maxWidthRatio !== undefined && !(typeof s.maxWidthRatio === 'number' && s.maxWidthRatio > 1 && s.maxWidthRatio <= SIMULATION_LIMITS.maxWidthRatio)) issues.push('width_ratio_exceeds_bound');
  if (s.replicates !== undefined && !(Number.isSafeInteger(s.replicates) && s.replicates >= SIMULATION_LIMITS.minReplicates)) issues.push('replicates_invalid');
  if (s.minPower !== undefined && !(typeof s.minPower === 'number' && s.minPower > 0 && s.minPower < 1)) issues.push('power_bound_invalid');
  return issues;
}

/** The tolerances a score uses: the specification's, never beyond the bounds above. @param {any} specification */
function boundedSpecification(specification) {
  const s = specification ?? {};
  const coverage = typeof s.coverage === 'number' && s.coverage >= 0.5 && s.coverage < 1 ? s.coverage : 0.95;
  const alpha = typeof s.alpha === 'number' && s.alpha > 0 && s.alpha < 0.5 ? s.alpha : 0.05;
  const positive = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    truth: s.truth, nullValue: s.nullValue ?? 0, alpha, coverage,
    coverageTolerance: Math.min(positive(s.coverageTolerance, Infinity), (1 - coverage) * SIMULATION_LIMITS.maxCoverageToleranceShare),
    maxBias: positive(s.maxBias, 0),
    falsePositiveTolerance: Math.min(typeof s.falsePositiveTolerance === 'number' && s.falsePositiveTolerance >= 0 ? s.falsePositiveTolerance : 0, alpha),
    maxFailureRate: Math.min(typeof s.maxFailureRate === 'number' && s.maxFailureRate >= 0 ? s.maxFailureRate : 0, SIMULATION_LIMITS.maxFailureRate),
    maxWidthRatio: Math.min(positive(s.maxWidthRatio, SIMULATION_LIMITS.defaultWidthRatio), SIMULATION_LIMITS.maxWidthRatio),
    minPower: typeof s.minPower === 'number' ? s.minPower : null,
    replicates: Number.isSafeInteger(s.replicates) ? s.replicates : 0,
  };
}

/**
 * The number of replicates a specification needs before any of its criteria can be judged: enough that
 * the Monte Carlo half-interval of each proportion is at most a third of its tolerance (Morris et al.
 * choose n from the target MCSE; a 95% coverage with a 3-point tolerance needs 1,825, the same order as
 * their worked 1,900), and never fewer than the floor or the count the specification preregistered.
 * @param {any} specification
 */
export function simulationRequiredReplicates(specification) {
  const s = boundedSpecification(specification);
  const needed = (rate, tolerance) => tolerance > 0 ? Math.ceil((SIMULATION_LIMITS.z / (tolerance * SIMULATION_LIMITS.intervalShareOfTolerance)) ** 2 * rate * (1 - rate)) : Infinity;
  const proportions = [needed(s.coverage, s.coverageTolerance), ...(s.truth === s.nullValue && s.falsePositiveTolerance > 0 ? [needed(s.alpha, s.falsePositiveTolerance)] : [])];
  return Math.max(SIMULATION_LIMITS.minReplicates, s.replicates, ...proportions.filter(Number.isFinite));
}

/**
 * Score one preregistered scenario. `samples[i]` is the tool's output on the i-th preregistered dataset:
 * `{estimate, lower, upper, p}`. Every sample is in every denominator.
 * @param {any[]} samples @param {any} specification
 */
export function simulationScore(samples, specification) {
  if (!Array.isArray(samples)) throw new Error('Simulation requires an array of replicates.');
  const s = boundedSpecification(specification), n = samples.length;
  const reasons = simulationSpecificationIssues(specification).length ? ['specification_invalid'] : [];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const rows = samples.map(row => {
    const interval = finite(row?.estimate) && finite(row?.lower) && finite(row?.upper) && row.lower <= row.upper;
    const tested = finite(row?.p) && row.p >= 0 && row.p <= 1;
    return { ok: interval && tested, estimate: finite(row?.estimate) ? row.estimate : null, lower: row?.lower, upper: row?.upper, p: row?.p };
  });
  const usable = rows.filter(row => row.ok), failures = n - usable.length;
  const required = simulationRequiredReplicates(specification);
  if (n < required) reasons.push('insufficient_replicates');
  if (n > 0 && failures / n > s.maxFailureRate) reasons.push('failed_outputs');
  const estimates = rows.filter(row => row.estimate !== null).map(row => row.estimate);
  const mean = estimates.reduce((sum, value) => sum + value, 0) / estimates.length;
  const bias = finite(s.truth) && estimates.length ? mean - s.truth : NaN;
  const empiricalSe = estimates.length > 1 ? Math.sqrt(estimates.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (estimates.length - 1)) : NaN;
  const mcseBias = empiricalSe / Math.sqrt(estimates.length);
  // A failed output never covers and always rejects: the worst reading, which is what a missing number earns.
  const covering = usable.filter(row => row.lower <= s.truth && row.upper >= s.truth).length;
  const rejecting = usable.filter(row => row.p < s.alpha).length + failures;
  const coverage = n ? covering / n : NaN, rejection = n ? rejecting / n : NaN;
  const mcseCoverage = Math.sqrt(coverage * (1 - coverage) / n), mcseRejection = Math.sqrt(rejection * (1 - rejection) / n);
  const atNull = s.truth === s.nullValue;
  const meanWidth = usable.length ? usable.reduce((sum, row) => sum + (row.upper - row.lower), 0) / usable.length : NaN;
  const widthRatio = meanWidth / (2 * normalQuantile(1 - (1 - s.coverage) / 2) * empiricalSe);
  // Zero spread across different datasets is not precision: the output does not depend on the data.
  if (!(empiricalSe > 0)) reasons.push('degenerate_estimates');
  if (!(Math.abs(bias) + SIMULATION_LIMITS.z * mcseBias <= s.maxBias)) reasons.push('bias_outside_bound');
  const [coverageLower, coverageUpper] = n ? wilson(covering, n) : [NaN, NaN];
  if (!(coverageLower >= s.coverage - s.coverageTolerance && coverageUpper <= s.coverage + s.coverageTolerance)) reasons.push('coverage_outside_tolerance');
  const [rejectionLower, rejectionUpper] = n ? wilson(rejecting, n) : [NaN, NaN];
  if (atNull && !(rejectionUpper <= s.alpha + s.falsePositiveTolerance)) reasons.push('false_positive_rate_above_bound');
  if (!atNull && s.minPower !== null && !(rejectionLower >= s.minPower)) reasons.push('power_below_bound');
  if (!(widthRatio <= s.maxWidthRatio)) reasons.push('interval_width_unbounded');
  return { n, requiredReplicates: required, usable: usable.length, failures, bias, empiricalSe, coverage, falsePositive: atNull ? rejection : null, power: atNull ? null : rejection,
    meanIntervalWidth: meanWidth, widthRatio, mcseBias, mcseCoverage, mcseFalsePositive: mcseRejection,
    monteCarloIntervals: { bias: [bias - SIMULATION_LIMITS.z * mcseBias, bias + SIMULATION_LIMITS.z * mcseBias], coverage: [coverageLower, coverageUpper], rejection: [rejectionLower, rejectionUpper] },
    // Whether this scenario can tell an estimator from one that always answers the null.
    discriminatesTrivial: finite(s.truth) && Math.abs(s.truth - s.nullValue) > s.maxBias,
    reasons, valid: reasons.length === 0 };
}
