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

test("a missing gateway receipt is recorded as usage not known, never replaced with invented Flash or zero cost", async () => {
  // This used to refuse the understanding with a 502, so a document had none
  // because a cost could not be settled (2026-10-04). The cost is not known and
  // is stored as not known: the model and the figure are never made up.
  for (const usage of [undefined, null, { currency: "CNY", modelId: "", providerId: "deepseek", actualCost: 0.1, inputTokens: 1, outputTokens: 1 },
    { currency: "CNY", modelId: "m", providerId: "deepseek", actualCost: -1, inputTokens: 1, outputTokens: 1 },
    { currency: "USD", modelId: "m", providerId: "deepseek", actualCost: 1, inputTokens: 1, outputTokens: 1 },
    { currency: "CNY", modelId: "m", providerId: "deepseek", actualCost: 1, inputTokens: 1.5, outputTokens: 1 }]) {
    const f = fixture();
    const adapter = new SourceUnderstandingRuns({ dispatch: async () => ({ runId: "run_one", sessionId: "sess_one" }),
      readResult: async () => ({ status: "succeeded", output: f.output, ...(usage === undefined ? {} : { usage }) }) });
    const result = await adapter.execute(f);
    assert.equal(result.state, "complete", JSON.stringify(usage));
    assert.equal(result.usage, null, JSON.stringify(usage));
    assert.equal(result.output.summary, "Notes", "the understanding is stored");
    assert.equal(result.verification, undefined);
  }
});

test("an understanding the run's receipt did not vouch for is stored with that label, and the contract validator still applies", async () => {
  const f = fixture();
  const adapter = new SourceUnderstandingRuns({ dispatch: async () => ({ runId: "run_one", sessionId: "sess_one" }),
    readResult: async () => ({ status: "succeeded", output: f.output, verification: "unverified" }) });
  const result = await adapter.execute(f);
  assert.equal(result.state, "complete");
  assert.equal(result.verification, "unverified");
  // The label is not a pass: what the document is understood to say is still judged against its frozen input.
  f.output.generation = 3;
  await assert.rejects(adapter.execute(f), { code: "source_understanding_invalid" });
});
