import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createResultCaptureRepairRoutes } from "../src/resultCaptureRepairRoutes.mjs";

function req(url, body) { return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url, headers: { "content-type": "application/json" } }); }
function res() { return { writeHead() {}, end() {} }; }
function fixture(user = "owner") {
  const calls = [];
  const store = { ensureSessionUser: async () => ({ user: { id: user } }), assertCsrf: async () => calls.push("csrf"),
    requireProject: async (person, id) => { calls.push(["project", person.id, id]); if (person.id !== "owner") throw Object.assign(new Error("forbidden"), { status: 403 }); return { userId: person.id, id }; } };
  const runs = { refreshArtifacts: async (...args) => { calls.push(["refresh", ...args]); return {}; } };
  const service = { plan: async body => { calls.push(["plan", body]); return {}; }, apply: async body => { calls.push(["apply", body]); return {}; } };
  return { calls, route: createResultCaptureRepairRoutes({ store, runs, service, config: { operatorUsers: ["operator"] }, maxJsonBytes: 4096 }) };
}
test("capture repairs require a signed-in operator and CSRF before any account is read", async () => {
  const f = fixture();
  await assert.rejects(f.route(req("/api/ops/result-capture-repairs", { action: "plan", userId: "other", projectId: "p", runId: "r" }), res()), { code: "result_capture_repair_operator_required" });
  assert.deepEqual(f.calls, ["csrf"]);
  const op = fixture("operator");
  await op.route(req("/api/ops/result-capture-repairs", { action: "plan", userId: "owner", projectId: "p", runId: "r" }), res());
  assert.equal(op.calls[1][0], "plan");
  await assert.rejects(op.route(req("/api/ops/result-capture-repairs", { action: "apply", userId: "owner", projectId: "p", runId: "r" }), res()), { code: "result_capture_repair_plan_required" });
});
test("ordinary artifact refresh resolves the session user's project and cannot select another owner or invoke capture", async () => {
  const f = fixture();
  await f.route(req("/api/agent-runs/r/artifacts/refresh", { projectId: "p", expectedTranscriptSha256: "a".repeat(64) }), res());
  assert.deepEqual(f.calls.slice(0, 2), ["csrf", ["project", "owner", "p"]]);
  assert.equal(f.calls[2][0], "refresh");
  await assert.rejects(f.route(req("/api/agent-runs/r/artifacts/refresh", { projectId: "p", userId: "other", expectedTranscriptSha256: "a".repeat(64) }), res()), { code: "invalid_payload" });
  const other = fixture("other");
  await assert.rejects(other.route(req("/api/agent-runs/r/artifacts/refresh", { projectId: "p", expectedTranscriptSha256: "a".repeat(64) }), res()), { status: 403 });
  assert.ok(other.calls.every(call => !Array.isArray(call) || call[0] !== "refresh"));
});
