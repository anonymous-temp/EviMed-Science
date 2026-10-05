import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createEvolutionCandidateEvaluator } from "../src/evolutionCandidateEvaluator.mjs";
const candidate = { id: "candidate", entrypoint: "scripts/estimate.py:estimate", files: { "scripts/estimate.py": "def estimate(x): return {'value':x}" } };
test("trusted numeric evaluator calls published callable twice per independent hidden paper; no gold feedback", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "candidate-gold-"));
  try {
    await mkdir(path.join(dataDir, "paper-gold/candidate-cases"), { recursive: true });
    const definition = { methodId: "method", frozen: true, cases: [1, 2].map(id => ({ id: `opaque-${id}`, hidden: true, kind: "published", publicationId: `paper-${id}`, independentQa: { passed: true }, sourceHash: "a".repeat(64), input: { x: id }, numeric: { value: { value: id, absoluteTolerance: 0 } } })) };
    await writeFile(path.join(dataDir, "paper-gold/candidate-cases/method.json"), JSON.stringify(definition));
    const calls = [];
    const evaluator = createEvolutionCandidateEvaluator({ config: { dataDir, evaluationDataDir: dataDir }, auditCandidateExposure: async () => ({ tier: "unexposed" }), controller: { execVerify: async body => { calls.push(body); return { ok: true, joined: true, output: JSON.stringify({ value: body.input.x }) }; } } });
    const result = await evaluator.evaluate(candidate, { card: { methodId: "method" } });
    assert.equal(result.ok, true); assert.equal(result.verificationLevel, "V2"); assert.equal(calls.length, 4);
    assert.ok(calls.every(call => !call.code.includes("absoluteTolerance") && !Object.hasOwn(call.input, "numeric")));
    assert.doesNotMatch(JSON.stringify(result), /absoluteTolerance|outputPath|"value"/);
    const unknown = createEvolutionCandidateEvaluator({ config: { dataDir, evaluationDataDir: dataDir }, controller: { execVerify: async body => ({ ok: true, joined: true, output: JSON.stringify({ value: body.input.x }) }) } });
    assert.equal((await unknown.evaluate(candidate, { card: { methodId: "method" } })).ok, false);
    const exposed = createEvolutionCandidateEvaluator({ config: { dataDir, evaluationDataDir: dataDir }, auditCandidateExposure: async () => ({ tier: "exposed_uncited" }), controller: { execVerify: async body => ({ ok: true, joined: true, output: JSON.stringify({ value: body.input.x }) }) } });
    const exposedResult = await exposed.evaluate(candidate, { card: { methodId: "method" } });
    assert.equal(exposedResult.ok, false);
    assert.equal(exposedResult.verificationLevel, "V0");
    assert.equal(exposedResult.exposureTier, "exposed_uncited");
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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "candidate-simulation-"));
  try {
    const inputs = Array.from({ length: 10 }, (_, index) => ({ index }));
    const specification = { truth: 0, alpha: 0.05, maxBias: 0.01, coverage: 1, coverageTolerance: 0.01, falsePositiveTolerance: 0.01 };
    const preregistered = { at: "2026-01-01T00:00:00Z", hash: createHash("sha256").update(JSON.stringify({ inputs, specification })).digest("hex") };
    await mkdir(path.join(dataDir, "paper-gold/candidate-cases"), { recursive: true });
    const definition = { methodId: "simulation", frozen: true, noPublishedExamples: true, cases: [{ id: "simulation-null", hidden: true, kind: "simulation", independentQa: { passed: true }, sourceHash: "b".repeat(64), inputs, specification, preregistered }] };
    await writeFile(path.join(dataDir, "paper-gold/candidate-cases/simulation.json"), JSON.stringify(definition));
    const evaluator = createEvolutionCandidateEvaluator({ config: { dataDir, evaluationDataDir: dataDir }, controller: { execVerify: async () => ({ ok: true, joined: true, output: JSON.stringify({ estimate: 0, lower: -1, upper: 1, p: 0.5 }) }) } });
    assert.equal((await evaluator.prepareCases({ methodId: "simulation" })).simulationReady, true);
    const result = await evaluator.evaluate(candidate, { card: { methodId: "simulation" } });
    assert.equal(result.ok, true);
    assert.equal(result.verificationLevel, "V1");
    assert.deepEqual(result.assessments[0].monteCarloError, { bias: 0, coverage: 0, falsePositive: 0 });
    assert.equal(evolutionValidationLevel(result.assessments), "V1");
    definition.cases[0].preregistered.hash = "0".repeat(64);
    await writeFile(path.join(dataDir, "paper-gold/candidate-cases/simulation.json"), JSON.stringify(definition));
    assert.equal((await evaluator.prepareCases({ methodId: "simulation" })).simulationReady, false);
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
