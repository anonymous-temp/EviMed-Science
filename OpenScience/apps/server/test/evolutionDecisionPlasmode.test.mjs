import test from "node:test";
import assert from "node:assert/strict";
import { runDecisionNetBenefitPlasmode } from "../src/evolutionDecisionPlasmode.mjs";
const covariates = Array.from({ length: 100 }, (_, index) => ({ age: 20 + index, biomarker: Math.sin(index / 5) + index / 100 }));
const columns = ["age", "biomarker"];
const specification = { seed: "reproducible-fixture", replicates: 200, knownSignal: 1.5, negativeControl: true };
const correct = async inputs => inputs.map(({ specification: input }) => ({ netBenefit: (input.truePositive - input.falsePositive * input.threshold / (1 - input.threshold)) / input.n }));
test("decision plasmode retains real-covariate structure, injects known signal and reports Monte Carlo error", async () => {
  const snapshot = JSON.stringify(covariates);
  const calls = [];
  const result = await runDecisionNetBenefitPlasmode({ covariates, columns, specification, executeSpecifications: async inputs => {
    calls.push(inputs);
    for (const input of inputs) {
      assert.deepEqual(Object.keys(input), ["specification"]);
      assert.deepEqual(Object.keys(input.specification), ["n", "truePositive", "falsePositive", "eventCount", "threshold"]);
    }
    return correct(inputs);
  } });
  assert.equal(result.passed, true);
  assert.equal(result.empiricalEvidence, false);
  assert.equal(result.replicates, 200);
  assert.ok(result.monteCarloError > 0);
  assert.notEqual(result.injected.expected, result.negativeControl.expected);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, 200);
  assert.equal(JSON.stringify(covariates), snapshot);
  assert.doesNotMatch(JSON.stringify(result), /"age":|"biomarker":/);
  const repeated = await runDecisionNetBenefitPlasmode({ covariates, columns, specification, executeSpecifications: correct });
  assert.deepEqual(repeated, result);
});
test("wrong aggregate estimator fails known-target recovery", async () => {
  const result = await runDecisionNetBenefitPlasmode({ covariates, columns, specification, executeSpecifications: async inputs => inputs.map(() => ({ netBenefit: 0 })) });
  assert.equal(result.passed, false);
  assert.equal(result.monteCarloError, 0);
});
test("constant covariates and unbounded simulation protocols remain untested", async () => {
  await assert.rejects(runDecisionNetBenefitPlasmode({ covariates: Array.from({ length: 20 }, () => ({ age: 1 })), columns: ["age"], specification, executeSpecifications: correct }), /variation/);
  await assert.rejects(runDecisionNetBenefitPlasmode({ covariates, columns, specification: { ...specification, replicates: 1001 }, executeSpecifications: correct }), /Invalid/);
});
