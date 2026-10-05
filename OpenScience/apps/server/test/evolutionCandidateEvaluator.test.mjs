import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createEvolutionCandidateEvaluator } from "../src/evolutionCandidateEvaluator.mjs";
import { pythonExecVerify } from "./helpers/pythonExecVerify.mjs";
const candidate = { id: "candidate", entrypoint: "scripts/estimate.py:estimate", files: { "scripts/estimate.py": "def estimate(x): return {'value':x}" } };
test("trusted numeric evaluator calls published callable twice per independent hidden paper; no gold feedback", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "candidate-gold-"));
  try {
    await mkdir(path.join(dataDir, "paper-gold/candidate-cases"), { recursive: true });
    // An executable reference is frozen beside the cases: without one nothing can tell this callable from a table (evolutionBehaviouralChecks.test.mjs).
    const definition = { methodId: "method", frozen: true, referenceImplementation: { implementationId: "fixture-reference", language: "python", code: "import json,sys\nprint(json.dumps({'numeric':{'value':json.load(sys.stdin)['x']}}))\n" },
      cases: [3, 5].map(id => ({ id: `opaque-${id}`, hidden: true, kind: "published", publicationId: `paper-${id}`, independentQa: { passed: true }, sourceHash: "a".repeat(64), input: { x: id }, numeric: { value: { value: id, absoluteTolerance: 0 } } })) };
    await writeFile(path.join(dataDir, "paper-gold/candidate-cases/method.json"), JSON.stringify(definition));
    const record = { calls: [] };
    const controller = { execVerify: pythonExecVerify(record) };
    const evaluator = createEvolutionCandidateEvaluator({ config: { dataDir, evaluationDataDir: dataDir }, auditCandidateExposure: async () => ({ tier: "unexposed" }), controller });
    const result = await evaluator.evaluate(candidate, { card: { methodId: "method" } });
    assert.equal(result.ok, true); assert.equal(result.verificationLevel, "V2");
    const scored = record.calls.filter(call => Object.keys(call.files).length > 0 && Object.hasOwn(call.input ?? {}, "x"));
    assert.equal(scored.length, 4);
    assert.ok(record.calls.every(call => !call.code.includes("absoluteTolerance") && !Object.hasOwn(call.input ?? {}, "numeric")));
    assert.doesNotMatch(JSON.stringify(result), /absoluteTolerance|outputPath|"value"/);
    const unknown = createEvolutionCandidateEvaluator({ config: { dataDir, evaluationDataDir: dataDir }, controller });
    const unknownResult = await unknown.evaluate(candidate, { card: { methodId: "method" } });
    assert.equal(unknownResult.ok, false);
    // A candidate that passed every case and check and waits only on its development chain's exposure says so.
    assert.deepEqual([unknownResult.status, unknownResult.resourceCode], ["waiting_resource", "development_chain_exposure_unknown"]);
    const exposed = createEvolutionCandidateEvaluator({ config: { dataDir, evaluationDataDir: dataDir }, auditCandidateExposure: async () => ({ tier: "exposed_uncited" }), controller });
    const exposedResult = await exposed.evaluate(candidate, { card: { methodId: "method" } });
    assert.equal(exposedResult.ok, false);
    assert.equal(exposedResult.verificationLevel, "V0");
    assert.equal(exposedResult.exposureTier, "exposed_uncited");
    assert.deepEqual([exposedResult.status, exposedResult.resourceCode], ["waiting_resource", "development_chain_exposed"]);
    assert.ok(exposedResult.assessments.every(row => row.passed === true) && exposedResult.failedCaseIds.length === 0, "the wait is the chain's exposure, not a failed case");
    // The passing evaluation names no resource, and a failed case is a repair, never this wait.
    assert.equal(result.resourceCode, undefined);
    const unavailable = await evaluator.evaluate(candidate, { card: { methodId: "unknown" } });
    assert.equal(unavailable.status, "waiting_resource");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test("candidate's self-reported V2 and one paper never admit a tool", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "candidate-gold-"));
  try {
    const evaluator = createEvolutionCandidateEvaluator({ config: { dataDir }, controller: {} });
    assert.equal((await evaluator.evaluate({ ...candidate, verificationLevel: "V2" })).ok, false);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test("prepareCases reuses an immutable method-bound admitted control-plane asset", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "candidate-gold-"));
  try {
    const folder = path.join(dataDir, "paper-gold/candidate-cases");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "method.json"), JSON.stringify({ methodId: "method", frozen: true, cases: [1, 2].map(id => ({ id: `opaque-${id}`, kind: "published", hidden: true, independentQa: { passed: true }, sourceHash: "a".repeat(64), publicationId: `publication-${id}`, numeric: { value: { value: id } } })) }));
    const evaluator = createEvolutionCandidateEvaluator({ config: { dataDir, evaluationDataDir: dataDir }, controller: {} });
    assert.equal((await evaluator.prepareCases({ id: "method" })).ok, true);
    const waiting = await evaluator.prepareCases({ id: "unavailable" });
    assert.equal(waiting.status, "waiting_resource");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test("preregistered known-truth simulation emits actual Monte Carlo errors accepted by domain", async () => {
  const { createHash } = await import("node:crypto");
  const { evolutionValidationLevel } = await import("@evimed/domain");
  const { simulationRequiredReplicates } = await import("../../../evals/paper-gold/evaluator.mjs");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "candidate-simulation-"));
  try {
    const specification = { truth: 0.5, alpha: 0.05, maxBias: 0.05, coverage: 0.95, coverageTolerance: 0.03, falsePositiveTolerance: 0.02 };
    // Seeded datasets of 25 unit-variance draws around the truth; the tool under test is the sample mean with a z interval.
    let counter = 0;
    const uniform = () => (createHash("sha256").update(`simulation:${counter++}`).digest().readUIntBE(0, 6) + 0.5) / 2 ** 48;
    const inputs = Array.from({ length: simulationRequiredReplicates(specification) }, () => ({ values: Array.from({ length: 25 }, () => Number((specification.truth + Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())).toFixed(6))) }));
    const preregistered = { at: "2026-01-01T00:00:00Z", hash: createHash("sha256").update(JSON.stringify({ inputs, specification })).digest("hex") };
    await mkdir(path.join(dataDir, "paper-gold/candidate-cases"), { recursive: true });
    const definition = { methodId: "simulation", frozen: true, noPublishedExamples: true, cases: [{ id: "simulation-effect", hidden: true, kind: "simulation", independentQa: { passed: true }, sourceHash: "b".repeat(64), inputs, specification, preregistered }] };
    await writeFile(path.join(dataDir, "paper-gold/candidate-cases/simulation.json"), JSON.stringify(definition));
    const record = { calls: [] };
    const evaluator = createEvolutionCandidateEvaluator({ config: { dataDir, evaluationDataDir: dataDir }, controller: { execVerify: pythonExecVerify(record) } });
    assert.equal((await evaluator.prepareCases({ methodId: "simulation" })).simulationReady, true);
    const tool = body => ({ id: "mean", entrypoint: "scripts/estimate.py:estimate", files: { "scripts/estimate.py": `import math\ndef estimate(values):\n${body}` } });
    const honest = tool("    m = sum(values) / len(values); se = 1 / math.sqrt(len(values)); z = abs(m / se)\n    return {'estimate': m, 'lower': m - 1.959964 * se, 'upper': m + 1.959964 * se, 'p': math.erfc(z / math.sqrt(2))}\n");
    const result = await evaluator.evaluate(honest, { card: { methodId: "simulation" } });
    assert.equal(result.ok, true, JSON.stringify(result.assessments));
    assert.equal(result.verificationLevel, "V1");
    assert.equal(result.assessments[0].replicates, inputs.length);
    assert.ok(record.calls.length <= Math.ceil(inputs.length / 250), "replicates run in batches, not one execution each");
    const errors = result.assessments[0].monteCarloError;
    assert.ok(errors.bias > 0 && errors.bias < 0.01 && errors.coverage > 0 && errors.coverage < 0.01 && Number.isFinite(errors.falsePositive));
    assert.equal(evolutionValidationLevel(result.assessments), "V1");
    // The degenerate tools the old criteria passed: a constant, unbounded intervals, and no p-value.
    for (const [body, reason] of [
      ["    return {'estimate': 0.5, 'lower': -1, 'upper': 1, 'p': 0.5}\n", "degenerate_estimates"],
      ["    m = sum(values) / len(values)\n    return {'estimate': m, 'lower': -1e9, 'upper': 1e9, 'p': 0.5}\n", "interval_width_unbounded"],
      ["    m = sum(values) / len(values); se = 1 / math.sqrt(len(values))\n    return {'estimate': m, 'lower': m - 1.959964 * se, 'upper': m + 1.959964 * se}\n", "failed_outputs"],
      ["    if values[0] > 1.5: raise ValueError('refused')\n    m = sum(values) / len(values); se = 1 / math.sqrt(len(values))\n    return {'estimate': m, 'lower': m - 1.959964 * se, 'upper': m + 1.959964 * se, 'p': 0.01}\n", "failed_outputs"],
    ]) {
      const failed = await evaluator.evaluate(tool(body), { card: { methodId: "simulation" } });
      assert.equal(failed.ok, false, reason); assert.equal(failed.verificationLevel, "V0");
      assert.ok(failed.assessments[0].reasons.includes(reason), `${reason}: ${failed.assessments[0].reasons}`);
    }
    // Readiness: an altered preregistration, too few datasets, a null-only truth and a self-serving tolerance are all refused.
    for (const mutate of [d => { d.cases[0].preregistered.hash = "0".repeat(64); }, d => { d.cases[0].inputs = d.cases[0].inputs.slice(0, 10); },
      d => { d.cases[0].specification = { ...specification, truth: 0 }; }, d => { d.cases[0].specification = { ...specification, coverageTolerance: 0.05 }; }]) {
      const changed = structuredClone(definition); mutate(changed);
      if (changed.cases[0].preregistered.hash === preregistered.hash) changed.cases[0].preregistered.hash = createHash("sha256").update(JSON.stringify({ inputs: changed.cases[0].inputs, specification: changed.cases[0].specification })).digest("hex");
      await writeFile(path.join(dataDir, "paper-gold/candidate-cases/simulation.json"), JSON.stringify(changed));
      assert.equal((await evaluator.prepareCases({ methodId: "simulation" })).simulationReady, false);
    }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test("workflow smoke admission comes from executed hidden checks rather than candidate claims", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "candidate-workflow-"));
  try {
    await mkdir(path.join(dataDir, "paper-gold/candidate-cases"), { recursive: true });
    await writeFile(path.join(dataDir, "paper-gold/candidate-cases/workflow.json"), JSON.stringify({ methodId: "workflow", frozen: true, cases: [{ id: "smoke", kind: "workflow-smoke", hidden: true, independentQa: { passed: true }, sourceHash: "a".repeat(64), input: { x: 1 }, numeric: { value: { value: 1, absoluteTolerance: 0 } } }] }));
    let value = 1;
    const evaluator = createEvolutionCandidateEvaluator({ config: { dataDir, evaluationDataDir: dataDir }, controller: { execVerify: async () => ({ ok: true, joined: true, output: JSON.stringify({ value }) }) } });
    assert.equal((await evaluator.prepareCases({ methodId: "workflow" })).workflowSmokeReady, true);
    assert.equal((await evaluator.evaluate(candidate, { card: { methodId: "workflow", toolKind: "workflow" } })).smokePassed, true);
    value = 2;
    const failed = await evaluator.evaluate({ ...candidate, smokePassed: true }, { card: { methodId: "workflow", toolKind: "workflow" } });
    assert.equal(failed.smokePassed, false);
    assert.equal(failed.ok, false);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
