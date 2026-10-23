import assert from "node:assert/strict";
import test from "node:test";
import { createAgentMemoryRoutes, AGENT_MEMORY_PATH } from "../src/agentMemoryRoutes.mjs";
import { MemorySubstrate } from "../src/memorySubstrate.mjs";

function fixture({ nativeMemory = null } = {}) {
  const calls = [];
  const researchMemory = {
    configured: true,
    async memoryEngine() { return "native"; },
    async listRecords() { calls.push("legacy-list"); return [{ id: "legacy", status: "active" }]; },
    async settings() { return { learningPaused: false, recallPaused: false, pausedProjects: [] }; },
    async search() { calls.push("legacy-search"); return []; },
  };
  const native = nativeMemory ?? { configured: true,
    async listRecords(_userId, filters) { calls.push(["native-list", filters]); return [{ id: "native", status: "active" }]; },
    async search() { calls.push("native-search"); return { items: [{ id: "native", kind: "preference", scope: "user", value: "Native preference", status: "active" }] }; },
  };
  const routes = createAgentMemoryRoutes({ config: { agentMemoryApiEnabled: true },
    apiKeys: { async resolve() { return { userId: "u1", keyId: "key", scopes: ["memory.read", "memory.write", "memory.manage"], projectId: null }; } },
    store: { async userById(id) { return { id }; }, async requireProject(_user, id) { return { id }; } },
    researchMemory, nativeMemory: native,
    capsules: { async note(_user, _project, input) { calls.push(["note", input]); return { id: "candidate", revision: 1, payload: input }; } },
    memoryIntelligence: { async recordRun() { calls.push("legacy-extract"); return { skipped: true }; } },
  });
  async function call(path, body) {
    const res = { status: 0, json: null, writeHead(status) { this.status = status; }, end(text) { this.json = JSON.parse(text); } };
    const req = { url: `${AGENT_MEMORY_PATH}/${path}`, method: body ? "POST" : "GET", headers: { authorization: "Bearer key" },
      async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    await routes(req, res);
    return res;
  }
  return { calls, researchMemory, native, call };
}

test("native external records never read legacy rows", async () => {
  const f = fixture();
  const result = await f.call("records");
  assert.deepEqual(result.json.data.map(row => row.id), ["native"]);
  assert.ok(!f.calls.includes("legacy-list"));
});

test("native external episodes stage a candidate without extracting", async () => {
  const f = fixture();
  const result = await f.call("episodes", { projectId: "default", sessionId: "outside", messages: [{ role: "user", text: "Prefer concise replies" }] });
  assert.equal(result.status, 202);
  assert.equal(result.json.data.extracted, 0);
  assert.equal(result.json.data.candidateId, "candidate");
  assert.equal(result.json.data.confirm.path, "/api/agent-memory/v1/notes/candidate/confirm");
  assert.ok(!f.calls.includes("legacy-extract"));
});

test("native recall uses native records and refuses unsupported historical recall", async () => {
  const f = fixture();
  const substrate = new MemorySubstrate({}, { store: f.researchMemory, nativeMemory: f.native });
  const rows = await substrate.recall("u1", "preference", { countUsage: false });
  assert.equal(rows[0]?.content, "Native preference");
  assert.ok(!f.calls.includes("legacy-search"));
  await assert.rejects(substrate.recall("u1", "preference", { asOf: Date.parse("2025-01-01") }), error => error.code === "memory_as_of_unsupported");
});

test("unavailable native engine fails closed on external records and recall", async () => {
  const f = fixture({ nativeMemory: { configured: false } });
  await assert.rejects(f.call("records"), error => error.code === "memory_engine_unavailable");
  const substrate = new MemorySubstrate({}, { store: f.researchMemory, nativeMemory: f.native });
  await assert.rejects(substrate.recall("u1", "preference"), error => error.code === "memory_engine_unavailable");
  assert.deepEqual(f.calls, []);
});
