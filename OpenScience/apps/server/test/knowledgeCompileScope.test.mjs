import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { KnowledgePageService } from "../src/knowledgePageService.mjs";
import { createKnowledgePageRoutes } from "../src/knowledgePageRoutes.mjs";
import { loadConfig } from "../src/config.mjs";

function fixture({ includeLibrary, projectFailure = false, libraryFailure = false, drift = false, libraryAppliesWhole = true } = {}) {
  const records = new Map();
  const calls = [];
  const source = { id: "src_a", projectId: "p1", payload: { analysis: { textSha256: "a".repeat(64) } } };
  const documents = { get: async (_u, _k, id) => records.get(id) ?? null,
    put: async (_u, _k, id, payload, { expectedRevision }) => records.set(id, { payload, revision: expectedRevision + 1 }),
    list: async () => ({ items: [], nextCursor: null }) };
  const sourceSync = { reconcileProject: async (_u, id, options) => {
    calls.push(["project", id, options]);
    return { failed: projectFailure ? ["failed"] : [], missing: drift ? ["missing"] : [], stale: [], extra: [] };
  }, reconcileLibrary: async () => { calls.push(["librarySync"]); if (libraryFailure) throw new Error("unrelated library unavailable"); return { failed: [] }; },
  expected: async () => new Map([[source.id, { sha: source.payload.analysis.textSha256 }]]) };
  const resources = { configured: true, roots: () => ({ sources: "project-sources", library: "account-library", wiki: "wiki", kg: "kg" }),
    treeUri: () => "wiki", tree: async () => [], listSources: async () => { calls.push(["libraryRead"]); return ["private"]; },
    submitCompile: async (_u, input) => { calls.push(["compile", input]); return { taskId: "task", status: "pending" }; } };
  const service = new KnowledgePageService({ config: { ovKnowledgeEnabled: true, knowledgePagesMinSources: 1, knowledgePagesDebounceMs: 0,
    ...(includeLibrary === undefined ? {} : { knowledgePagesIncludeLibrary: includeLibrary }) }, documents,
  sources: { list: async (_u, { projectId }) => { assert.equal(projectId, "p1"); return { items: [source] }; }, get: async () => source },
  jobs: { enqueue: async () => { calls.push(["enqueue"]); return {}; } }, store: { userById: async () => ({ id: "u1" }), requireProject: async (_u, id) => ({ id }) }, resources, sourceSync, entries: {},
  libraryAppliesWhole: async (userId, projectId) => { calls.push(["libraryScope", userId, projectId]); return libraryAppliesWhole; } });
  return { service, calls, records, run: () => service.runJob({ userId: "u1", projectId: "p1", payload: { projectId: "p1", round: 1 } }) };
}

test("storage never enters Compile through callbacks, manual requests, scheduling or queued jobs", async () => {
  const { service, calls, records } = fixture();
  await service.noteSourceReady("u1", "evimed-library", "src_a", { strict: true });
  assert.equal(await service.catchUp("u1", "evimed-library"), "skipped");
  assert.equal(await service.schedule("u1", "evimed-library"), null);
  await assert.rejects(service.requestRound("u1", "evimed-library"), { code: "knowledge_storage_project" });
  assert.deepEqual(await service.runJob({ userId: "u1", payload: { projectId: "evimed-library" } }), { result: { skipped: "storage_project" } });
  assert.equal(records.size, 0); assert.equal(calls.length, 0);
});

test("HTTP storage Compile rejects before changing language or asking the service", async () => {
  let mutations = 0;
  const route = createKnowledgePageRoutes({ store: { ensureSessionUser: async () => ({ user: { id: "u1" } }), assertCsrf: async () => {}, requireProject: async () => ({ id: "evimed-library" }) },
    service: { enabled: true, noteLanguage: async () => { mutations++; }, requestRound: async () => { mutations++; } }, sources: {}, maxJsonBytes: 1024 });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ projectId: "evimed-library", language: "en" }))]), { url: "/api/knowledge-pages/compile", method: "POST", headers: {} });
  await assert.rejects(route(req, {}), { code: "knowledge_storage_project" }); assert.equal(mutations, 0);
});

test("project-only Compile ignores unrelated library failures and keeps exact project continuity checks", async () => {
  const held = fixture({ libraryFailure: true });
  assert.equal((await held.run()).defer.code, "knowledge_compile_running");
  assert.deepEqual(held.calls.filter(([kind]) => kind === "compile")[0][1].from, ["project-sources"]);
  assert.equal(held.calls.some(([kind]) => kind.startsWith("library")), false);
  assert.deepEqual(held.calls.filter(([kind]) => kind === "project").map(([, id, options]) => [id, options]), [["p1", undefined], ["p1", { apply: false }]]);
  for (const setup of [{ projectFailure: true }, { drift: true }]) {
    const blocked = fixture(setup); assert.equal((await blocked.run()).defer.code, "knowledge_source_sync_pending");
    assert.equal(blocked.calls.some(([kind]) => kind === "compile"), false);
  }
});

test("explicit operator opt-in retains library sync and wiki inputs", async () => {
  const held = fixture({ includeLibrary: true }); await held.run();
  assert.deepEqual(held.calls.find(([kind]) => kind === "compile")[1].from, ["project-sources", "account-library"]);
  assert.ok(held.calls.some(([kind]) => kind === "librarySync"));
  const blocked = fixture({ includeLibrary: true, libraryFailure: true });
  assert.equal((await blocked.run()).defer.code, "knowledge_source_sync_pending");
});

test("configuration defaults to project inputs and preserves explicit operator choice", () => {
  assert.equal(loadConfig({}).knowledgePagesIncludeLibrary, false);
  assert.equal(loadConfig({ knowledgePagesIncludeLibrary: true }).knowledgePagesIncludeLibrary, true);
});

test("the library joins a project's compile only while every entry of it applies to that project", async () => {
  // One entry limited to other projects: the engine reads a root whole, so the root is not offered to this project at all.
  const limited = fixture({ includeLibrary: true, libraryAppliesWhole: false });
  await limited.run();
  assert.deepEqual(limited.calls.find(([kind]) => kind === "compile")[1].from, ["project-sources"]);
  assert.deepEqual(limited.calls.find(([kind]) => kind === "libraryScope"), ["libraryScope", "u1", "p1"]);
  assert.equal(limited.calls.some(([kind]) => kind === "libraryRead"), false, "the library is not even listed for this project");
  // Where the question cannot be answered the answer is no library, never the whole of it.
  const unknown = fixture({ includeLibrary: true });
  unknown.service.libraryAppliesWhole = async () => { throw new Error("library unavailable"); };
  await unknown.run();
  assert.deepEqual(unknown.calls.find(([kind]) => kind === "compile")[1].from, ["project-sources"]);
  // And a service built without the question never feeds the library.
  const absent = fixture({ includeLibrary: true });
  absent.service.libraryAppliesWhole = null;
  await absent.run();
  assert.deepEqual(absent.calls.find(([kind]) => kind === "compile")[1].from, ["project-sources"]);
});
