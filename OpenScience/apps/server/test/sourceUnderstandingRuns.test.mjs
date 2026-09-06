import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSourceText, sourceUnderstandingSchema } from "@evimed/domain";
import { SourceUnderstandingRuns } from "../src/sourceUnderstandingRuns.mjs";

function fixture() {
  const source = { id: "src_one", payload: { generation: 2 } };
  const job = { id: "job_one", userId: "u", projectId: "p" };
  const input = normalizeSourceText({ sourceId: source.id, generation: 2, docType: "note-memo", depth: "structured", text: "Take notes." });
  const output = { ...Object.fromEntries(["schemaVersion", "sourceId", "generation", "docType", "depth"].map(key => [key, input[key]])),
    summary: "Notes", slots: Object.fromEntries(sourceUnderstandingSchema(input.docType).slots.map(key => [key, { state: "unknown", reason: "Not specified." }])),
    claims: [], methods: [], omissionAudit: { status: "not_run", reason: "Not audited.", omissionRate: null } };
  return { source, job, parsed: { input }, output };
}

test("bounded source recovery reuses safe stable dispatch identity and trusted job context", async () => {
  const f = fixture(); const calls = [];
  const adapter = new SourceUnderstandingRuns({ dispatch: async input => { calls.push(input); return { runId: "run_one", sessionId: "sess_one" }; },
    readResult: async () => ({ status: "running" }) });
  const first = await adapter.execute(f);
  const second = await adapter.execute(f);
  assert.equal(first.state, "pending");
  assert.equal(first.dispatchId, second.dispatchId);
  assert.match(first.dispatchId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
  assert.equal(calls[0].job, f.job);
  assert.equal(calls[0].input.text, "Take notes.");
});

test("completed result keeps actual CNY model usage and discards unrecognized output fields", async () => {
  const f = fixture(); f.output.internalToken = "do-not-publish";
  const usage = { currency: "CNY", modelId: "actual-configured-model", providerId: "deepseek", actualCost: 0.125, inputTokens: 34, outputTokens: 56 };
  const adapter = new SourceUnderstandingRuns({ dispatch: async () => ({ runId: "run_one", sessionId: "sess_one" }),
    readResult: async () => ({ status: "succeeded", output: f.output, usage }) });
  const result = await adapter.execute(f);
  assert.deepEqual(result.usage, usage);
  assert.equal(result.output.internalToken, undefined);
  f.output.generation = 3;
  await assert.rejects(adapter.execute(f), { code: "source_understanding_invalid" });
});

test("a missing gateway receipt cannot be replaced with invented Flash or zero cost", async () => {
  const f = fixture();
  const adapter = new SourceUnderstandingRuns({ dispatch: async () => ({ runId: "run_one", sessionId: "sess_one" }),
    readResult: async () => ({ status: "succeeded", output: f.output }) });
  await assert.rejects(adapter.execute(f), { code: "source_understanding_usage_invalid" });
});
