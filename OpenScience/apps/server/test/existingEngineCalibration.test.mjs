import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { importExistingEngineReceipt } from "../src/existingEngineCalibration.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "existing-engine-")), methodId = "faers-ror-published-data-v1";
  await mkdir(path.join(dataDir, "paper-gold/candidate-cases"), { recursive: true });
  await mkdir(path.join(dataDir, "paper-gold/engine-calibration"));
  const definition = JSON.stringify({ frozen: true, methodId, cases: [{ id: "paper", publicationId: "10.1234/paper", sourceHash: "a".repeat(64), numeric: { ROR: { value: 2, absoluteTolerance: 0 } } }] });
  await writeFile(path.join(dataDir, "paper-gold/candidate-cases", `${methodId}.json`), definition);
  const report = { executedAt: "2026-10-04T00:00:00Z", methodId, executionKind: "actual-existing-engine", scope: "deterministic-method-only", replicates: 2, sourceDefinitionHash: hash(definition), engineDigest: "b".repeat(64), runtimeDigest: "c".repeat(64), scorerDigest: "d".repeat(64), rows: [0, 1].map(replicate => ({ replicate, caseId: "paper", publicationId: "10.1234/paper", sourceHash: "a".repeat(64), engineId: "pharmacovigilance", engineImplementation: "safety_agent.signals.disproportionality.ror", passed: true, numeric: { ROR: 2 } })) };
  const save = async () => { const bytes = JSON.stringify(report), reportHash = hash(bytes); await writeFile(path.join(dataDir, "paper-gold/engine-calibration", `${methodId}-${reportHash}.json`), bytes); return { dataDir, methodId, reportHash }; };
  return { dataDir, report, save };
}
test("operator receipt independently scores both real-engine replicates without promoting full research", async () => {
  const f = await fixture();
  try {
    const request = await f.save(), result = await importExistingEngineReceipt(request);
    // One case run twice is one case: the two replicates are a determinism check, not two cases.
    assert.deepEqual({ cases: result.cases, agree: result.agree, disagree: result.disagree, couldNotRun: result.couldNotRun, rows: result.rows }, { cases: 1, agree: 1, disagree: 0, couldNotRun: 0, rows: 2 });
    assert.equal(result.methodCases, 1); assert.equal(result.passed, 1); assert.equal(result.units.length, 1);
    assert.equal(result.passedPublishedSources, 1); assert.equal(result.fullResearchReproductions, 0); assert.deepEqual(await importExistingEngineReceipt(request), result);
  } finally { await rm(f.dataDir, { recursive: true, force: true }); }
});
test("a ruler reports disagreement and what could not run; every case that entered stays in the denominator", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "existing-engine-honest-")), methodId = "faers-ror-published-data-v9";
  try {
    await mkdir(path.join(dataDir, "paper-gold/candidate-cases"), { recursive: true }); await mkdir(path.join(dataDir, "paper-gold/engine-calibration"));
    const reference = (id, publicationId, value, printed) => ({ id, kind: "published", publicationId, sourceHash: "a".repeat(64), numeric: { ROR: { value, printed, absoluteTolerance: 0.005, relativeTolerance: 0 } } });
    const definition = JSON.stringify({ frozen: true, schemaVersion: 2, methodId, cases: [reference("agrees", "10.1/a", 2, "2.00"), reference("exact-quantile", "10.1/a", 3.21, "3.21"), reference("inconsistent", "10.1/b", 1.5, "1.50"), reference("refused", "10.1/b", 4, "4.00")],
      excluded: [{ id: "zero", publicationId: "10.1/b", reason: "zero_cell_ratio_undefined_without_correction", rule: "fixed-before-scoring" }] });
    await writeFile(path.join(dataDir, "paper-gold/candidate-cases", `${methodId}.json`), definition);
    const base = (caseId, publicationId, replicate) => ({ replicate, caseId, publicationId, sourceHash: "a".repeat(64), engineId: "pharmacovigilance" });
    const ran = (caseId, publicationId, value, agree, diagnosis) => [0, 1].map(replicate => ({ ...base(caseId, publicationId, replicate), engineImplementation: "safety_agent.signals.disproportionality.ror", passed: agree, outcome: agree ? "agree" : "disagree",
      reason: agree ? "within_reference_tolerance" : "outside_reference_tolerance", ...(diagnosis ? { diagnosis, adjudication: "unadjudicated" } : {}), numeric: { ROR: value } }));
    const rows = [...ran("agrees", "10.1/a", 2.004, true), ...ran("exact-quantile", "10.1/a", 3.2162, false, "reference_follows_exact_normal_quantile"), ...ran("inconsistent", "10.1/b", 1.46, false, "reference_not_reproduced_by_textbook_formula_from_its_own_counts"),
      ...[0, 1].map(replicate => ({ ...base("refused", "10.1/b", replicate), passed: false, outcome: "could-not-run", reason: "engine_raised_ValueError", unsupported: "engine_raised" }))];
    const report = { executedAt: "2026-10-05T00:00:00Z", schemaVersion: 2, methodId, executionKind: "actual-existing-engine", scope: "deterministic-method-only", replicates: 2, sourceDefinitionHash: hash(definition), engineDigest: "b".repeat(64), runtimeDigest: "c".repeat(64), scorerDigest: "d".repeat(64),
      summary: { cases: 4, agree: 1, disagree: 2, couldNotRun: 1 }, rows };
    const save = async () => { const bytes = JSON.stringify(report), reportHash = hash(bytes); await writeFile(path.join(dataDir, "paper-gold/engine-calibration", `${methodId}-${reportHash}.json`), bytes); return { dataDir, methodId, reportHash }; };
    const result = await importExistingEngineReceipt(await save());
    assert.equal(result.ok, false);
    assert.deepEqual({ cases: result.cases, agree: result.agree, disagree: result.disagree, couldNotRun: result.couldNotRun, excluded: result.excludedBeforeScoring, entered: result.entered, rows: result.rows }, { cases: 4, agree: 1, disagree: 2, couldNotRun: 1, excluded: 1, entered: 5, rows: 8 });
    assert.deepEqual({ sources: result.publishedSources, fullyAgreeing: result.sourcesFullyAgreeing, passed: result.passedPublishedSources }, { sources: 2, fullyAgreeing: 0, passed: 0 });
    assert.deepEqual(result.bySource["10.1/a"], { cases: 2, agree: 1, disagree: 1, couldNotRun: 0 });
    assert.deepEqual(result.disagreementDiagnoses, { reference_follows_exact_normal_quantile: 1, reference_not_reproduced_by_textbook_formula_from_its_own_counts: 1 });
    assert.deepEqual(result.units.map(unit => [unit.caseId, unit.outcome, unit.allStagesValid, unit.adjudication ?? null]), [["agrees", "agree", true, null], ["exact-quantile", "disagree", false, "unadjudicated"], ["inconsistent", "disagree", false, "unadjudicated"], ["refused", "could-not-run", false, null]]);
    assert.equal(result.units[3].unsupported, true); assert.equal(result.units[3].reason, "engine_raised_ValueError");
    // The operator script's own summary cannot say more than this scoring finds.
    report.summary = { cases: 4, agree: 4, disagree: 0, couldNotRun: 0 };
    await assert.rejects(importExistingEngineReceipt(await save()), /self-check disagree/);
    // And a case cannot be left out of the receipt to improve it.
    report.summary = undefined; report.rows = report.rows.filter(row => row.caseId !== "inconsistent");
    await assert.rejects(importExistingEngineReceipt(await save()), /both replicates of every frozen method case/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test("the MR row is named for the library it runs and says nothing about the MR engine", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "existing-engine-mr-")), methodId = "mr-ivw-published-data-v9";
  try {
    await mkdir(path.join(dataDir, "paper-gold/candidate-cases"), { recursive: true }); await mkdir(path.join(dataDir, "paper-gold/engine-calibration"));
    const definition = JSON.stringify({ frozen: true, schemaVersion: 2, methodId, cases: [{ id: "example", kind: "other-implementation", publicationId: "10.1/mr", sourceHash: "a".repeat(64), numeric: { estimate: { value: 0.5, absoluteTolerance: 0, relativeTolerance: 1e-6 }, pValue: { value: 3e-25, quantity: "p-value", absoluteTolerance: 0, relativeTolerance: 1e-6 } } }] });
    await writeFile(path.join(dataDir, "paper-gold/candidate-cases", `${methodId}.json`), definition);
    const implementation = "TwoSampleMR::mr_ivw_fe (library component; the platform MR engine pipeline is not executed)";
    const report = { executedAt: "2026-10-05T00:00:00Z", schemaVersion: 2, methodId, executionKind: "library-component", scope: "deterministic-method-only", replicates: 2, sourceDefinitionHash: hash(definition), engineDigest: "b".repeat(64), runtimeDigest: "c".repeat(64), scorerDigest: "d".repeat(64),
      rows: [0, 1].map(replicate => ({ replicate, caseId: "example", publicationId: "10.1/mr", sourceHash: "a".repeat(64), engineId: "mr", engineImplementation: implementation, passed: true, outcome: "agree", numeric: { estimate: 0.5, pValue: 3e-25 } })) };
    const save = async () => { const bytes = JSON.stringify(report), reportHash = hash(bytes); await writeFile(path.join(dataDir, "paper-gold/engine-calibration", `${methodId}-${reportHash}.json`), bytes); return { dataDir, methodId, reportHash }; };
    const result = await importExistingEngineReceipt(await save());
    assert.equal(result.executionKind, "library-component");
    assert.deepEqual({ engineId: result.units[0].engineId, capabilityId: result.units[0].capabilityId, referenceKind: result.units[0].referenceKind, executionKind: result.units[0].executionKind }, { engineId: "twosamplemr-library", capabilityId: null, referenceKind: "other-implementation", executionKind: "library-component" });
    // A p-value an order of magnitude off no longer rides an absolute tolerance.
    for (const row of report.rows) row.numeric.pValue = 3e-24;
    await assert.rejects(importExistingEngineReceipt(await save()), /self-check disagree/);
    // The old label, which called this the actual MR engine, is refused.
    for (const row of report.rows) { row.numeric.pValue = 3e-25; row.engineImplementation = "production-TwoSampleMR::mr_ivw_fe"; }
    report.executionKind = "actual-existing-engine";
    await assert.rejects(importExistingEngineReceipt(await save()), /not bound to frozen sources and execution/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test("self-declared engine success cannot override incorrect numerical results or changed source identity", async () => {
  const f = await fixture();
  try { f.report.rows[0].numeric.ROR = 999; await assert.rejects(importExistingEngineReceipt(await f.save()), /self-check disagree/); f.report.rows[0].numeric.ROR = 2; f.report.rows[0].sourceHash = "0".repeat(64); await assert.rejects(importExistingEngineReceipt(await f.save()), /changed source/); }
  finally { await rm(f.dataDir, { recursive: true, force: true }); }
});
test("reference-only implementations and missing replicates cannot masquerade as production engine calibration", async () => {
  const f = await fixture();
  try { f.report.rows[0].engineImplementation = "reference-numpy"; await assert.rejects(importExistingEngineReceipt(await f.save()), /source evidence/); f.report.rows[0].engineImplementation = "safety_agent.signals.disproportionality.ror"; f.report.rows.pop(); await assert.rejects(importExistingEngineReceipt(await f.save()), /both replicates/); }
  finally { await rm(f.dataDir, { recursive: true, force: true }); }
});
test("imported engine units enter the evaluation ledger and daily digest without hidden values", async () => {
  const { persistExistingEngineEvaluation } = await import("../src/existingEngineCalibration.mjs");
  const { evolutionEvaluationDigest } = await import("../src/evolutionDecisions.mjs");
  const f = await fixture(), records = new Map();
  try {
    const request = await f.save();
    const service = { now: () => new Date("2026-10-04T12:00:00Z"), get: async id => records.get(id), save: async (type, id, payload) => { assert.equal(type, "evaluation"); const row = { id, payload }; records.set(id, row); return row; } };
    const paperGold = { importExistingMethods: input => importExistingEngineReceipt({ dataDir: f.dataDir, ...input }) };
    const row = await persistExistingEngineEvaluation({ service, paperGold, methodId: request.methodId, reportHash: request.reportHash });
    assert.equal(row.payload.units[0].engineId, "pharmacovigilance");
    const digest = evolutionEvaluationDigest(row);
    assert.deepEqual(digest.capabilityIds, ["adr-analysis"]);
    assert.match(digest.lines[0], /adr-analysis.*1\/1/);
    assert.doesNotMatch(JSON.stringify(row.payload), /"numeric"|"input"|"value"/);
    assert.equal((await persistExistingEngineEvaluation({ service, paperGold, methodId: request.methodId, reportHash: request.reportHash })).id, row.id);
    assert.equal(records.size, 1);
  } finally { await rm(f.dataDir, { recursive: true, force: true }); }
});
test("operator import route accepts only existing receipt identities and rejects supplied scoring data", async () => {
  const { Readable } = await import("node:stream");
  const { createEvolutionRoutes } = await import("../src/evolutionRoutes.mjs");
  const jobs = [];
  const route = createEvolutionRoutes({ config: { evolutionEnabled: true }, store: { ensureSessionUser: async () => ({ user: { id: "operator" } }), assertCsrf: async () => {} },
    isOperator: async () => true, service: { enqueue: async (...args) => { jobs.push(args); return { id: "job" }; } } });
  const request = input => Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), { method: "POST", url: "/api/evolution/evaluations/import-existing-methods", headers: { "content-type": "application/json" } });
  const response = { writeHead() {}, end() {} };
  const input = { methodId: "faers-ror-published-data-v1", reportHash: "a".repeat(64) };
  assert.equal(await route(request(input), response), true);
  assert.equal(jobs[0][0], "evaluate"); assert.equal(jobs[0][1].action, "import-existing-methods");
  await assert.rejects(route(request({ ...input, units: [] }), response), { code: "evolution_evaluation_invalid" });
  assert.equal(jobs.length, 1);
});
