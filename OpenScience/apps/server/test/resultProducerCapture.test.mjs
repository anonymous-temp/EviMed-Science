import test from "node:test";
import assert from "node:assert/strict";
import { createResultCaptureQueue, createResultProducerCapture } from "../src/resultProducerCapture.mjs";

test("capture backlog preserves event order and bounds work without blocking delivery or propagating audit failures", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const observed = []; const failures = [];
  const project = { userId: "owner", id: "project" };
  const queue = createResultCaptureQueue({ maxPendingEvents: 2,
    resolveProject: async value => { await gate; return { ...value, workspaceDir: "/owned/workspace" }; },
    capture: { async observe(full, runId, value) { observed.push([full.workspaceDir, runId, value.event.callId]); } },
    onFailure: failure => { failures.push(failure.code); throw new Error("Audit is unavailable"); },
  });
  const event = callId => ({ sessionId: "session", event: { type: "tool/call", callId, tool: "write", input: { path: "result.md", content: "Result" } } });
  queue.observe(project, "run", event("first"));
  queue.observe(project, "run", event("second"));
  queue.observe(project, "run", event("overflow"));
  queue.observe(project, "run", event("still-overflow"));
  assert.deepEqual(failures, ["result_capture_queue_full"]);
  release();
  await queue.drain();
  assert.deepEqual(observed, [["/owned/workspace", "run", "first"], ["/owned/workspace", "run", "second"]]);
  queue.observe(project, "run", event("recovered"));
  await queue.drain();
  assert.equal(observed.at(-1)[2], "recovered");
});

test("oversized captures and failed project hydration leave explicit gaps and a drainable queue", async () => {
  const failures = [];
  const queue = createResultCaptureQueue({ maxPendingBytes: 300,
    resolveProject: async () => { throw Object.assign(new Error("Project removed"), { code: "result_project_forbidden" }); },
    capture: { observe() { assert.fail("No capture may outlive project authorization"); } },
    onFailure: failure => failures.push(failure.code),
  });
  const project = { userId: "owner", id: "project" };
  queue.observe(project, "run", { event: { type: "tool/call", tool: "write", input: { content: "x".repeat(1024) } } });
  queue.observe(project, "run", { event: { type: "tool/call", tool: "literature_search" } });
  queue.observe(project, "run", { event: { type: "tool/result", callId: "one", status: "completed" } });
  await queue.drain();
  assert.deepEqual(failures, ["result_capture_queue_full", "result_project_forbidden"]);
});

test("failed writes and evicted call inputs cannot lend capture authority to a later result", async () => {
  const captured = []; const failures = [];
  const adapter = createResultProducerCapture({ service: { captureFile: async value => captured.push(value) },
    maxPendingCalls: 1, maxPendingCallBytes: 300, onFailure: value => failures.push(value.code) });
  const project = { userId: "owner", id: "p" };
  const call = (id, content = "short") => ({ sessionId: "s", event: { type: "tool/call", callId: id, tool: "write", input: { path: "output.md", content } } });
  const result = (id, status = "completed") => ({ sessionId: "s", event: { type: "tool/result", callId: id, status } });
  await adapter.observe(project, "r", call("failed"));
  await adapter.observe(project, "r", result("failed", "failed"));
  await adapter.observe(project, "r", result("failed"));
  await adapter.observe(project, "r", call("old"));
  await adapter.observe(project, "r", call("current"));
  await adapter.observe(project, "r", result("old"));
  await adapter.observe(project, "r", result("current"));
  await adapter.observe(project, "r", call("oversized", "x".repeat(1000)));
  await adapter.observe(project, "r", result("oversized"));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].producer.callId, "current");
  assert.deepEqual(failures, ["result_capture_queue_full"]);
});
