import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createEvolutionCasePreparation } from "../src/evolutionCasePreparation.mjs";
import { createEvolutionCandidateEvaluator } from "../src/evolutionCandidateEvaluator.mjs";
test("aggregate primary preparation independently executes references and freezes only control-plane cases", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aggregate-reference-"));
  try {
    const directory = path.join(dataDir, "paper-gold/method-sources");
    await mkdir(directory, { recursive: true });
    const cases = [];
    for (const [index, value] of [0.25, 0.5].entries()) {
      const source = `Primary fixture numerical result ${value}`;
      const sourceFile = `fixture-${index}.xml`;
      await writeFile(path.join(directory, sourceFile), source);
      cases.push({ id: `fixture-${index}`, publicationId: `fixture-publication-${index}`, title: `Independent primary fixture ${index}`, aliases: [`PMC${index + 111}`], sourceFile, sourceHash: createHash("sha256").update(source).digest("hex"), independentQa: { passed: true }, input: { specification: { priorProbability: value, likelihoodRatios: { test: 1 } } }, numeric: { "results.test.posteriorProbability": { value, absoluteTolerance: 0, sourceToken: String(value) } } });
    }
    await writeFile(path.join(directory, "diagnostic-posterior.json"), JSON.stringify({ methodId: "diagnostic-posterior", cases }));
    let calls = 0;
    const config = { evaluationDataDir: dataDir };
    const controller = { execVerify: async body => { calls++; assert.match(body.code, /Rscript/); assert.deepEqual(body.files, {}); return { ok: true, joined: true, output: JSON.stringify({ numeric: { "results.test.posteriorProbability": body.input.specification.priorProbability } }) }; } };
    const result = await createEvolutionCasePreparation({ config, controller }).prepareCases({ methodId: "diagnostic-posterior" });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.equal(result.publishedReferenceCount, 2);
    assert.equal(result.publicInputCount, 2);
    assert.equal(result.access, "evaluation-only");
    assert.doesNotMatch(JSON.stringify(result), /priorProbability|absoluteTolerance|posteriorProbability/);
    const frozen = JSON.parse(await readFile(path.join(dataDir, "paper-gold/candidate-cases/diagnostic-posterior.json"), "utf8"));
    assert.equal(frozen.cases[0].independentImplementation.implementationId, "trusted_primary_formula_R");
    const evaluator = createEvolutionCandidateEvaluator({ config, controller });
    assert.equal((await evaluator.developmentContract({ methodId: "diagnostic-posterior" })).cases.length, 2);
    assert.deepEqual((await evaluator.exclusionPolicy({ methodId: "diagnostic-posterior" })).aliases, ["fixture-publication-0", "fixture-publication-1", "PMC111", "PMC112"]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test("missing aggregate source is an explicit resource gap", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aggregate-reference-"));
  try {
    const result = await createEvolutionCasePreparation({ config: { evaluationDataDir: dataDir }, controller: {} }).prepareCases({ methodId: "decision-net-benefit" });
    assert.equal(result.status, "waiting_resource");
    assert.equal(result.resourceCode, "preserved_primary_arithmetic_unavailable");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
