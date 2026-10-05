import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { numericScore, simulationScore, timeHoldout, freezeCycle, validateRewrite, scoreUnit, STAGES, reportReplicates, screenRetractions } from "./evaluator.mjs";
test("numeric tolerances, analytic/cross-implementation references and defensible intervals", () => {
  assert.equal(numericScore(1.02, { value: 1, absoluteTolerance: .03 }).valid, true);
  assert.equal(numericScore(3, { interval: [1, 2] }).valid, false);
  assert.equal(numericScore(NaN, { value: 1 }).valid, false);
  assert.equal(timeHoldout({ firstPublicDates: ["2024-01-01", "2023-01-01"] }, "2023-06-01", "2022-01-01"), false);
  const samples = Array.from({ length: 100 }, (_, i) => ({ estimate: 0, lower: -.1, upper: .1, p: i < 5 ? .01 : .5 }));
  assert.equal(simulationScore(samples, { truth: 0, alpha: .05, coverage: 1, maxBias: .01, coverageTolerance: .01, falsePositiveTolerance: .01 }).valid, true);
});
test("frozen scorer cannot change in cycle", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gold-"));
  try { await freezeCycle(dir, "cycle", { scorer: 1 }); await freezeCycle(dir, "cycle", { scorer: 1 }); await assert.rejects(freezeCycle(dir, "cycle", { scorer: 2 }), /frozen/); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
test("stage completeness and independently evidenced cross-family disagreements", async () => {
  const gold = { type: "research", stageChecks: Object.fromEntries(STAGES.map(stage => [stage, [stage]])), numeric: { effect: { value: 1 } } };
  const unit = { id: "case", checks: Object.fromEntries(STAGES.map(stage => [stage, true])), numeric: { effect: 2 }, modelFamily: "deepseek" };
  const scored = await scoreUnit(unit, gold, { review: async () => ({ reviewerFamily: "other", verdict: "paper_error", evidenceIds: ["source"], codeVerified: true }) });
  assert.equal(scored.allStagesValid, true);
  assert.equal(reportReplicates([scored, scored])[0].n, 2);
  await assert.rejects(scoreUnit(unit, gold, { review: async () => ({ reviewerFamily: "deepseek" }) }), /cross-family/);
  assert.throws(() => reportReplicates([scored]), /two replicates/);
  assert.throws(() => validateRewrite({ writer: "a", qaExecutor: "a" }, {}), /independent/);
});
test("Crossref notice downgrades target or included evidence", async () => {
  const rows = await screenRetractions(["10.123/a"], async () => ({ ok: true, json: async () => ({ message: { "update-to": [{ type: "retraction" }] } }) }));
  assert.equal(rows[0].status, "development_only");
});
test("method examples judge method and computation without pretending to test end-to-end recall", async () => {
  const result = await scoreUnit({ id: "method", checks: { appropriate: true }, numeric: { effect: 1 } }, { type: "method", stageChecks: { method: ["appropriate"] }, numeric: { effect: { value: 1 } } });
  assert.equal(result.allStagesValid, true);
  assert.equal(result.stages.recall.observed, false);
});

test("runner tests every neutral variant in two isolated replicates", async () => {
  const { runCycle } = await import("./run.mjs");
  const directory = await mkdtemp(path.join(os.tmpdir(), "paper-variants-"));
  try {
    const calls = [];
    const definition = { cases: [{ id: "example", type: "method", track: "meta", publicationId: "10.1234/paper", sourceHash: "a".repeat(64), dois: ["10.1234/paper"], input: "Estimate a population effect. Preserve method inputs.", capabilityId: "meta-analysis", policy: { aliases: [], titles: [] }, rewrite: { writer: "writer", qaExecutor: "independent", qaPassed: true, question: "Estimate a population effect.", variants: ["Quantify a population effect.", "Calculate a population effect.", "Assess a population effect."] }, gold: { numeric: { effect: { value: 2, absoluteTolerance: 0 } }, stageChecks: { method: ["method"] } } }] };
    const report = await runCycle({ dataDir: directory, cycleId: "variants", definition, adapter: {
      noToolBaseline: async () => ({}), baselineMemorized: () => false,
      fetchImpl: async () => ({ ok: true, json: async () => ({ message: {} }) }),
      dispatch: async request => { calls.push(request); return { request, project: { id: "observed-project" }, run: { id: `observed-run-${calls.length}` } }; },
      extract: async () => ({ numeric: { effect: 2 }, checks: { method: true } }),
    } });
    assert.equal(calls.length, 6);
    assert.equal(new Set(calls.map(row => row.replicate)).size, 6);
    for (const variant of definition.cases[0].rewrite.variants) assert.equal(calls.filter(row => row.caseRecord.input.startsWith(variant)).length, 2);
    assert.equal(report.cases[0].n, 6);
    assert.equal(report.cases[0].allStagesValidRate, 1);
    assert.equal(report.units.length, 6);
    assert.equal(report.units[0].type, "method");
    assert.equal(report.units[0].track, "E");
    assert.equal(report.units[0].producerRunId, "observed-run-1");
    assert.equal(report.units[0].producerProjectId, "observed-project");
    assert.equal(report.units[0].publishedPaperId, "10.1234/paper");
    assert.equal(report.units[0].goldSourceHash, "a".repeat(64));
    assert.equal(report.units[0].retracted, false);
    assert.equal(report.units[0].independent, false);
    assert.equal(report.units[0].group, "calibration");
    assert.equal(report.units[0].exposureTier, "unknown");
    assert.equal(report.units[0].fullResearchReproductionValid, false);
    const resumed = await runCycle({ dataDir: directory, cycleId: "variants", definition, adapter: {
      fetchImpl: async () => ({ ok: true, json: async () => ({ message: {} }) }),
      noToolBaseline: async () => { throw new Error("Completed baseline must not repeat"); },
      baselineMemorized: () => false, dispatch: async () => { throw new Error("Completed run must not repeat"); },
    } });
    assert.equal(resumed.cases[0].n, 6);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("question-only success leaves uncovered science stages unknown and cannot enter full reproduction", async () => {
  const result = await scoreUnit({ id: "question-only", exposureTier: "unexposed", checks: { q: true, m: true, c: true, w: true } }, {
    type: "question", benchmarkScope: "question-only", inputAvailable: false, numeric: {}, applicableStages: ["question", "method", "certainty", "writing"],
    stageChecks: { question: ["q"], method: ["m"], certainty: ["c"], writing: ["w"] },
  });
  assert.equal(result.applicableStagesValid, true);
  assert.equal(result.allStagesValid, false);
  assert.equal(result.fullResearchReproductionValid, false);
  assert.equal(result.benchmarkScope, "question-only");
  for (const stage of ["recall", "extraction", "calculation"]) assert.deepEqual(result.stages[stage], { valid: false, observed: false });
});
