// The path a researcher's correction takes to a lesson, end to end, with the real parts at every join.
//
// Owner ruling of 2026-10-12: the loop is to learn the researcher's research methods from what they correct, no longer how to pass
// the delivery gate. Every link of that path had its own test — the extractor reporting `corrections`, the trigger reading them, the
// distillation reading the correction records back — and none held the links together, so "a correction reaches the distiller
// as the researcher's own words" was believed rather than seen. The extractor's model is the one stub; the rest is the code that runs.
import assert from "node:assert/strict";
import test from "node:test";

import { MemoryIntelligence } from "../src/memoryIntelligence.mjs";
import { LearningTriggers } from "../src/learningTriggers.mjs";
import { MethodDistillationRuns } from "../src/methodDistillationRuns.mjs";

class MemoryStoreDouble {
  constructor() { this.records = new Map(); this.nextId = 1; }
  async listRecords() { return [...this.records.values()]; }
  async upsertRecord(_userId, input, evidence) {
    const key = [input.scope, input.scopeId ?? "", input.kind, input.key].join("\u0000");
    const existing = this.records.get(key);
    const record = { ...existing, ...input, id: existing?.id ?? `record_${this.nextId++}`, version: (existing?.version ?? 0) + 1,
      evidence: [...(existing?.evidence ?? []), ...(evidence ? [evidence] : [])], createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" };
    this.records.set(key, record);
    return record;
  }
}

const config = {
  deepseekProviderEnabled: true, deepseekApiKey: "unit-test-key", deepseekBaseUrl: "https://api.deepseek.com", deepseekModel: "deepseek-v4-pro",
  memoryExtractionEnabled: true, memoryExtractionTimeoutMs: 1_000,
};
const project = { id: "project_1", userId: "user_1" };
const finishedRun = {
  id: "run_corrected", sessionId: "session_1", mode: "open-domain", agentId: null, effectiveAgentId: "clinical-evidence-synthesis", model: "deepseek/deepseek-v4-pro",
  status: "succeeded", errorCode: null, artifacts: ["reports/result.md"], startedAt: "2026-10-12T01:00:00.000Z", finishedAt: "2026-10-12T01:10:00.000Z",
  transcript: { completeness: "complete" },
};
const WORDS = "不对，这次综述只纳入随机对照试验，观察性研究不要放进纳入标准里。";
const conversation = [
  { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "帮我做一份 SGLT2 抑制剂心衰结局的证据综述。" }] },
  { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "已按队列研究和随机对照试验一并检索，共纳入 14 项研究。" }] },
  { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: WORDS }] },
  { info: { id: "a2", role: "assistant" }, parts: [{ type: "text", text: "好的，改为只纳入随机对照试验。" }] },
];
/** The extractor's model, asked once: it records the correction, citing the researcher's own message. */
const extractor = (sources) => {
  const said = sources.find((source) => source.role === "user" && source.text.includes("观察性研究不要放进"));
  return [{ scope: "user", kind: "correction", key: "correction.include_rcts_only", value: "综述的纳入标准只写随机对照试验，不纳入观察性研究",
    summary: "纳入标准只含随机对照试验", origin: "explicit", importance: 0.9, sensitive: false, sourceRef: said.sourceRef, evidenceQuote: "观察性研究不要放进纳入标准里" }];
};
const modelFetch = (factory) => async (_input, init) => Response.json({
  choices: [{ message: { content: JSON.stringify({ candidates: factory(JSON.parse(JSON.parse(String(init.body)).messages[1].content).sources) }) } }],
});

test("what the researcher corrected is recorded by the extractor, queued as a correction lesson that is never sampled, and reaches the distiller in their own words", async () => {
  // 1. The extractor records the correction, and the run's memory result says so.
  const store = new MemoryStoreDouble();
  const memoryResult = await new MemoryIntelligence(config, store, { fetchImpl: modelFetch(extractor) }).recordRun(project, finishedRun, conversation);
  assert.equal(memoryResult.corrections.length, 1, "the researcher corrected the assistant, and the result says so");
  const [recorded] = memoryResult.corrections;
  assert.equal(recorded.key, "correction.include_rcts_only");

  // 2. The trigger queues it — with the repair sample at nothing, so only an explicit signal can get through — and carries the record's id.
  /** @type {any[]} */ const queue = [];
  const jobs = { enqueue: async (userId, kind, payload, options) => { queue.push({ userId, kind, payload, key: options.idempotencyKey, projectId: options.projectId }); return { id: `job_${queue.length}` }; } };
  const triggers = new LearningTriggers({ jobs, agentRuns: { list: async () => [finishedRun], runWorkflowProjection: async () => null }, repairShare: 0 });
  const queued = await triggers.afterRun(project, finishedRun, memoryResult);
  assert.deepEqual(queued, { queued: ["correction"], skipped: null });
  assert.deepEqual(queue.map((job) => [job.kind, job.payload.trigger, job.key]), [["distill", "correction", "distill:run_corrected:correction"]]);
  assert.deepEqual(queue[0].payload.corrections, [{ recordId: recorded.recordId, key: "correction.include_rcts_only" }], "the record by id; its words stay in the memory store");

  // 3. The distillation reads the record back and opens its input with the researcher's words, as the researcher's evidence.
  /** @type {any[]} */ const dispatched = [];
  const distillation = new MethodDistillationRuns({
    dispatch: async (request) => { dispatched.push(request); return { runId: "bounded_1", sessionId: "bounded_session", dispatchId: request.dispatchId }; },
    readResult: async () => ({ status: "succeeded", output: { candidate: { operation: "no_change", reason: "the dispatch is the thing under test" } } }),
    learning: { listMethods: async () => ({ items: [] }) },
    readCorrections: async (_userId, recordIds) => [...store.records.values()].filter((record) => recordIds.includes(record.id))
      .map((record) => ({ recordId: String(record.id), key: record.key, text: String(record.summary || record.value) })),
  });
  await distillation.execute({ job: { userId: "user_1", projectId: "project_1", id: "job_1", payload: queue[0].payload }, project, run: finishedRun });
  const [request] = dispatched;
  assert.equal(request.capabilityId, "method-distillation");
  assert.equal(request.input.trigger, "correction");
  assert.equal(request.input.signal, "researcher", "a correction is the only evidence a personal method may rest on");
  assert.deepEqual(request.input.corrections.map((entry) => ({ source: entry.source, recordId: entry.recordId, key: entry.key })),
    [{ source: "memory", recordId: recorded.recordId, key: "correction.include_rcts_only" }]);
  assert.match(request.input.corrections[0].text, /随机对照试验/);
});

test("a correction is a lesson whether or not the run delivered, and a run with nothing recorded and nothing steered queues none", async () => {
  /** @type {any[]} */ const queue = [];
  const jobs = { enqueue: async (_userId, _kind, payload) => { queue.push(payload.trigger); return { id: "job" }; } };
  const failed = { ...finishedRun, id: "run_failed", status: "failed", artifacts: [] };
  const triggers = (/** @type {any} */ run) => new LearningTriggers({ jobs, agentRuns: { list: async () => [run], runWorkflowProjection: async () => null } });
  const heard = { corrections: [{ recordId: "record_1", key: "correction.include_rcts_only", scope: "user" }] };
  assert.deepEqual(await triggers(failed).afterRun(project, failed, heard), { queued: ["correction"], skipped: null });
  const quiet = { ...finishedRun, id: "run_quiet", artifacts: [] };
  assert.deepEqual(await triggers(quiet).afterRun(project, quiet, { corrections: [] }), { queued: [], skipped: null });
  assert.deepEqual(queue, ["correction"]);
  // And the one gate it does pass: a conversation the loop could not read whole teaches nothing.
  const unread = { ...finishedRun, id: "run_unread", transcript: { completeness: "partial" } };
  assert.deepEqual(await triggers(unread).afterRun(project, unread, heard), { queued: [], skipped: "transcript_incomplete" });
});
