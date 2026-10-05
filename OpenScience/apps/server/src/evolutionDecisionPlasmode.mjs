import { createHash } from "node:crypto";
/** Decision-curve plasmode conditioned on preserved real numeric covariates.
 * Synthetic disease and test labels follow known mechanisms; only aggregate counts
 * reach the isolated arithmetic tool. This is a researcher diagnostic, not empirical validation.
 * @param {{covariates:any[], columns:string[], specification:any, execute?:any, executeSpecifications?:any, signal?:AbortSignal}} input */
export async function runDecisionNetBenefitPlasmode({ covariates, columns, specification, execute, executeSpecifications, signal }) {
  const n = covariates.length;
  if (n < 20 || !columns.length || columns.length > 12 || covariates.some(row => columns.some(key => !Number.isFinite(row[key])))) throw new Error("Plasmode requires preserved complete numeric covariates.");
  const repetitions = Number(specification.replicates ?? 200);
  const sensitivity = Number(specification.sensitivity ?? 0.8), specificity = Number(specification.specificity ?? 0.9);
  const threshold = Number(specification.threshold ?? 0.2), intercept = Number(specification.intercept ?? -1);
  const coefficient = Number(specification.knownSignal ?? 1), tolerance = Number(specification.tolerance ?? 0.002);
  if (!Number.isInteger(repetitions) || repetitions < 2 || repetitions > 1000 || ![sensitivity, specificity].every(value => Number.isFinite(value) && value > 0 && value < 1) || !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1 || !Number.isFinite(intercept) || Math.abs(intercept) > 10 || !Number.isFinite(coefficient) || Math.abs(coefficient) > 10 || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.05) throw new Error("Invalid preregistered plasmode profile.");
  const means = columns.map(key => covariates.reduce((sum, row) => sum + row[key], 0) / n);
  const deviations = columns.map((key, index) => Math.sqrt(covariates.reduce((sum, row) => sum + (row[key] - means[index]) ** 2, 0) / n));
  if (!deviations.some(value => value > 0)) throw new Error("Known signal requires variation in real covariates.");
  const scores = covariates.map(row => columns.reduce((sum, key, index) => sum + (deviations[index] ? (row[key] - means[index]) / deviations[index] : 0), 0) / Math.sqrt(columns.length));
  const confidenceMultiplier = specification.negativeControl === true ? 2.241402727604947 : 1.959963984540054;
  const seed = String(specification.seed ?? "evimed-dca-plasmode-v2");
  const protocol = { version: 2, confidenceMultiplier, familywiseAlpha: 0.05, repetitions, sensitivity, specificity, threshold, intercept, coefficient, tolerance, seed, columns };
  const protocolHash = createHash("sha256").update(JSON.stringify(protocol)).digest("hex");
  const odds = threshold / (1 - threshold);
  const perform = async (magnitude, label) => {
    const risks = scores.map(score => 1 / (1 + Math.exp(-(intercept + magnitude * score))));
    const prevalence = risks.reduce((sum, value) => sum + value, 0) / n;
    const truth = prevalence * sensitivity - (1 - prevalence) * (1 - specificity) * odds;
    let state = createHash("sha256").update(`${seed}:${label}`).digest().readUInt32LE(0);
    const random = () => { state = (state + 0x6D2B79F5) >>> 0; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
    const inputs = [];
    for (let replicate = 0; replicate < repetitions; replicate++) {
      signal?.throwIfAborted();
      let events = 0, truePositive = 0, falsePositive = 0;
      for (const risk of risks) {
        const disease = random() < risk;
        const positive = random() < (disease ? sensitivity : 1 - specificity);
        if (disease) events++;
        if (positive && disease) truePositive++;
        if (positive && !disease) falsePositive++;
      }
      inputs.push({ specification: { n, truePositive, falsePositive, eventCount: events, threshold } });
    }
    const results = executeSpecifications ? await executeSpecifications(inputs, { signal }) : await Promise.all(inputs.map(input => execute(input, { signal })));
    if (!Array.isArray(results) || results.length !== repetitions || results.some(measured => !Number.isFinite(measured?.netBenefit))) throw new Error("Plasmode arithmetic tool returned incomplete numerical net benefits.");
    const estimates = results.map(measured => measured.netBenefit);
    const mean = estimates.reduce((sum, value) => sum + value, 0) / repetitions;
    const variance = estimates.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (repetitions - 1);
    const monteCarloError = Math.sqrt(variance / repetitions);
    return { expected: truth, estimate: mean, bias: mean - truth, monteCarloError, replicates: repetitions, confidenceMultiplier, familywiseAlpha: 0.05, passed: Math.abs(mean - truth) <= tolerance + confidenceMultiplier * monteCarloError };
  };
  const injected = await perform(coefficient, "injected");
  const negativeControl = specification.negativeControl === true ? await perform(0, "negative-control") : null;
  return { procedure: "decision-net-benefit-plasmode", empiricalEvidence: false, rows: n, covariateColumns: columns, protocolHash, preservedCovariateHash: createHash("sha256").update(JSON.stringify(covariates)).digest("hex"), knownSignal: coefficient, injected, negativeControl, knownTarget: injected.expected, estimate: injected.estimate, replicates: repetitions, monteCarloError: injected.monteCarloError, passed: injected.passed && (!negativeControl || negativeControl.passed), explanation: "Conditioned on preserved researcher covariates; generated disease/test labels follow preregistered known mechanisms. Monte Carlo error measures replicated net-benefit estimates, not uncertainty in observed clinical outcomes." };
}
