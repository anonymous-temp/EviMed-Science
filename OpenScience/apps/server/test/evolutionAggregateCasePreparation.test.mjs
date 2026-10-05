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
test("a seed's token has to print its number, and its tolerance stays inside the rule's bounds", async () => {
  const prepare = async numeric => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "aggregate-bond-"));
    try {
      const directory = path.join(dataDir, "paper-gold/method-sources");
      await mkdir(directory, { recursive: true });
      const cases = [];
      for (const index of [0, 1]) {
        const source = `Fixture ${index}: the posterior probability was 37.5% among 250 patients.`;
        await writeFile(path.join(directory, `fixture-${index}.xml`), source);
        cases.push({ id: `fixture-${index}`, publicationId: `fixture-publication-${index}`, sourceFile: `fixture-${index}.xml`, sourceHash: createHash("sha256").update(source).digest("hex"), independentQa: { passed: true },
          input: { specification: { priorOdds: 0.03, likelihoodRatios: { test: 20 } } }, numeric: { "results.test.posteriorProbability": numeric } });
      }
      await writeFile(path.join(directory, "diagnostic-posterior.json"), JSON.stringify({ methodId: "diagnostic-posterior", cases }));
      const controller = { execVerify: async () => ({ ok: true, joined: true, output: JSON.stringify({ numeric: { "results.test.posteriorProbability": 0.375 } }) }) };
      const result = await createEvolutionCasePreparation({ config: { evaluationDataDir: dataDir }, controller }).prepareCases({ methodId: "diagnostic-posterior" });
      return { result, frozen: result.ok ? JSON.parse(await readFile(path.join(dataDir, "paper-gold/candidate-cases/diagnostic-posterior.json"), "utf8")) : null };
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  };
  const admitted = await prepare({ value: 0.375, absoluteTolerance: 0.0005, sourceToken: "37.5%" });
  assert.equal(admitted.result.ok, true);
  assert.deepEqual({ printed: admitted.frozen.cases[0].numeric["results.test.posteriorProbability"].printed, basis: admitted.frozen.cases[0].numeric["results.test.posteriorProbability"].toleranceBasis }, { printed: "37.5%", basis: "printed-precision" });
  // "250" occurs in the source; it is not the number 0.375. Occurring somewhere used to be the whole bond.
  await assert.rejects(prepare({ value: 0.375, absoluteTolerance: 0.0005, sourceToken: "250" }), /printed_value_bond_failed/);
  // A hand-written seed may loosen only with a named reason, and never past the bound.
  await assert.rejects(prepare({ value: 0.375, absoluteTolerance: 0.002, sourceToken: "37.5%" }), /tolerance_reason_required/);
  assert.equal((await prepare({ value: 0.375, absoluteTolerance: 0.002, toleranceReason: "inputs-rounded-in-source", sourceToken: "37.5%" })).result.ok, true);
  await assert.rejects(prepare({ value: 0.375, absoluteTolerance: 0.2, toleranceReason: "stochastic-method", sourceToken: "37.5%" }), /tolerance_exceeds_bound/);
});
