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
  try { const request = await f.save(), result = await importExistingEngineReceipt(request); assert.equal(result.passed, 2); assert.equal(result.passedPublishedSources, 1); assert.equal(result.fullResearchReproductions, 0); assert.deepEqual(await importExistingEngineReceipt(request), result); }
  finally { await rm(f.dataDir, { recursive: true, force: true }); }
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
    assert.match(digest.lines[0], /adr-analysis.*2\/2/);
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
