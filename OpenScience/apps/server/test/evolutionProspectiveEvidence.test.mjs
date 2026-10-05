import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createProspectiveExecutionEvidence, createProspectiveStageAssessment } from "../src/evolutionProspectiveEvidence.mjs";
import { STAGES } from "../../../evals/paper-gold/evaluator.mjs";

test("prospective logs and delivered code remain immutable beyond runtime retention", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prospective-execution-"));
  try {
    const workspaceDir = path.join(directory, "workspace"); await mkdir(workspaceDir);
    await writeFile(path.join(workspaceDir, "analysis.py"), "print(1)\n");
    const api = createProspectiveExecutionEvidence({ evaluationDataDir: directory });
    const input = { userId: "owner", project: { id: "project", workspaceDir }, run: { id: "run", status: "succeeded", artifacts: [{ path: "analysis.py" }] },
      transcript: { header: { completeness: "complete" }, messages: [{ role: "assistant", parts: [{ type: "text", text: "Predicted effect 1." }] }] }, predictionHash: "prediction", sealedAt: "2026-10-04T10:00:00Z" };
    assert.equal(await api.preserve(input), null, "registration cannot create original completion evidence");
    const captured = await api.capture(input);
    await writeFile(path.join(workspaceDir, "analysis.py"), "print('altered after completion')\n");
    const reference = await api.preserve(input);
    assert.deepEqual(reference, captured);
    const record = { userId: "owner", projectId: "project", producerRunId: "run", predictionHash: "prediction", frozenAt: "2026-10-04T10:01:00Z", executionEvidence: reference };
    await rm(workspaceDir, { recursive: true });
    assert.equal((await api.read(record)).artifacts[0].text, "print(1)\n");
    await assert.rejects(api.read({ ...record, producerRunId: "changed" }), /frozen prospective execution changed/);
    await assert.rejects(api.read({ ...record, frozenAt: "2026-10-03" }), /frozen prospective execution changed/);
    const file = path.join(directory, "paper-gold", "prospective-evidence", `${reference.id}.json`);
    const modified = JSON.parse(await readFile(file, "utf8")); modified.evidence.transcript.messages = [];
    await writeFile(file, JSON.stringify(modified));
    await assert.rejects(api.read(record), /frozen prospective execution changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("full prospective research needs actual stage evidence and numeric agreement, not a positive reviewer alone", async () => {
  const stageChecks = Object.fromEntries(STAGES.filter(stage => stage !== "calculation").map(stage => [stage, [`${stage}-proof`]]));
  const text = "Independently reported effect 1.", sourceHash = createHash("sha256").update(text).digest("hex");
  const gold = { inputAvailable: true, stageChecks, targetIdentity: "target", sourceHash, reachableEvidenceIds: ["prior-primary-source"], numeric: { effect: { value: 1, absoluteTolerance: 0.01 } }, preservedEvidence: [{ id: "target", sha256: sourceHash, text }] };
  const observed = { transcript: { messages: [{ parts: [{ type: "tool", tool: "public_source", status: "completed", output: '{"status":"ok","data":{"sourceId":"prior-primary-source"}}' }] }] }, artifacts: [{ text: "Actual original method and calculation logs." }] };
  let observedQuote = "Actual original method", calls = 0;
  const assess = createProspectiveStageAssessment({ config: { reviewProvider: "dashscope", evolutionDailyBudgetCny: 50 }, executionEvidence: { read: async () => observed },
    review: async (_dependencies, request) => { calls++; assert.equal(request.purpose, "evolution"); return { modelReported: true, model: "qwen-plus", value: { checks: Object.fromEntries(Object.values(stageChecks).flat().map(name => [name, { valid: true, observedQuote, sourceQuote: "Independently reported effect" }])) } }; } });
  const input = { record: { userId: "owner", projectId: "internal", producerRunId: "run", executionEvidence: { evidenceHash: "frozen" } }, gold, numeric: { effect: 1 }, pinned: { modelFamily: "deepseek" } };
  const passed = await assess(input); assert.equal(passed.allStagesValid, true); assert.equal(passed.eligibleForMainMetric, true);
  assert.equal(passed.recall.found, 1);
  assert.equal((await assess({ ...input, numeric: { effect: 2 } })).allStagesValid, false);
  observedQuote = "Fabricated execution";
  assert.equal((await assess(input)).allStagesValid, false);
  const before = calls;
  assert.equal((await assess({ ...input, gold: { ...gold, stageChecks: {} } })).eligibleForMainMetric, false);
  assert.equal((await assess({ ...input, gold: { ...gold, preservedEvidence: [{ id: "target", sha256: sourceHash, text: "Changed evidence" }] } })).eligibleForMainMetric, false);
  assert.equal(calls, before);
  observedQuote = "Actual original method";
  observed.transcript.messages = [];
  assert.equal((await assess(input)).stages.recall.valid, false);
});
