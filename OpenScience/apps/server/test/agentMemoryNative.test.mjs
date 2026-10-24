/**
 * The agent-memory API on an account whose memory is OpenViking's native engine (2026-10-23).
 *
 * The API knew one engine. On a native account `/episodes` answered 202 over nothing, `/recall` read stale PostgreSQL copies, and a
 * forget through `/records` changed rows the engine never reads. These cases drive the real routes with doubles that count what
 * they were asked, so "the legacy rows were not read" is asserted on the double's side: the dashboard, the list, the recall and
 * every record act go to the store the memory page uses, `/episodes` is refused by name before any subject account is made, and an
 * account on the other engine is answered exactly as before.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_KEY_SCOPES } from "../src/agentApiKeys.mjs";
import { AGENT_MEMORY_PATH, createAgentMemoryRoutes } from "../src/agentMemoryRoutes.mjs";
import { nativeRecallSource } from "../src/agentMemoryRecall.mjs";
import { agentMemoryOpenApi } from "../src/agentMemoryOpenApi.mjs";
import { HttpError } from "../src/security.mjs";

/** A response double that records the status, the body and the headers `sendJson` wrote. */
function response() {
  const captured = { status: 0, body: null, headers: {} };
  return { captured, writeHead(status, headers) { captured.status = status; captured.headers = headers ?? {}; }, end(payload) { captured.body = payload ? JSON.parse(String(payload)) : null; }, setHeader() {} };
}

/** @param {string} path @param {any} [body] @param {string} [method] @param {Record<string, string>} [extra] */
function request(path, body = undefined, method = body === undefined ? "GET" : "POST", extra = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  return { url: path, method, headers: { authorization: "Bearer evk_good", "content-type": "application/json", ...extra }, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
}

const nativeRecord = (overrides = {}) => ({
  id: "nm_0123456789abcdef01234567", scope: "user", scopeId: "", kind: "preference", key: "preferences/self/引用格式.md", value: "<!-- MEMORY_FIELDS {} -->\n- 参考文献一律用 AMA 格式。",
  summary: "引用格式", origin: "explicit", status: "active", confidence: 1, importance: 0.5, sensitive: false, version: 77, revisions: [],
  createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", engine: "native", nativeType: "preferences", ...overrides,
});

/**
 * @param {{ engine?: "native" | "legacy", configured?: boolean, subjects?: boolean, knownSubjects?: string[], native?: any, config?: any }} [options]
 */
function fixture({ engine = "native", configured = true, subjects = false, knownSubjects = [], native = {}, config = {} } = {}) {
  /** @type {any[][]} */
  const calls = [];
  const apiKeys = {
    async resolve(token) {
      if (token !== "evk_good") throw new HttpError(401, "agent_key_invalid", "The API key is not valid.");
      return { userId: "u1", keyId: "agk_1", projectId: null, scopes: [...AGENT_KEY_SCOPES], subjects };
    },
    async subjectAccount(owner, subject) { calls.push(["subjectAccount", owner, subject]); return { userId: `subj_${subject}`, created: true }; },
    async findSubjectAccount(_owner, subject) { return knownSubjects.includes(subject) ? `subj_${subject}` : null; },
  };
  const store = {
    async userById(id) { return { id, accountCreatedAt: "2026-01-01T00:00:00.000Z" }; },
    async requireProject(user, id) { return { id, userId: user.id }; },
  };
  const capsules = {
    async recall(userId, input) { calls.push(["capsule.recall", userId, input]); return { items: [], mode: "none" }; },
    async active() { return { record: null, items: [] }; },
    async entries() { return { items: [], nextCursor: null }; },
    async get() { throw new HttpError(404, "capsule_not_found", "The capsule is unavailable."); },
    async note(userId, projectId, input) { calls.push(["note", userId, projectId, input]); return { id: "entry_1", ...input }; },
    documents: { async list() { return { items: [] }; }, async get() { return null; } },
  };
  const researchMemory = {
    configured: true,
    async memoryEngine(userId) { calls.push(["memoryEngine", userId]); return engine; },
    async listRecords(userId) { calls.push(["legacy.listRecords", userId]); return [{ id: "legacy_row" }]; },
    async settings() { return { learningPaused: false, recallPaused: false }; },
    async updateSettings(userId, input) { calls.push(["updateSettings", userId, input]); return { learningPaused: Boolean(input.learningPaused), recallPaused: Boolean(input.recallPaused) }; },
    async recordUsage() { calls.push(["legacy.recordUsage"]); return {}; },
    async recentChanges() { calls.push(["legacy.recentChanges"]); return []; },
    async getRecord() { calls.push(["legacy.getRecord"]); throw new HttpError(404, "memory_not_found", "Memory not found."); },
    async upsertRecord() { calls.push(["legacy.upsertRecord"]); throw new Error("a native account's memory is not a row of this store"); },
    async undo() { calls.push(["legacy.undo"]); throw new Error("a native account's memory is not a row of this store"); },
  };
  const memorySubstrate = { recallEnabled: true, async recall() { calls.push(["legacy.substrateRecall"]); return [{ id: "stale", content: "stale copy", kind: "preference", scope: "user" }]; } };
  const nativeMemory = {
    configured,
    async search(userId, query) {
      calls.push(["native.search", userId, query]);
      return { items: [nativeRecord(), nativeRecord({ id: "nm_secret", sensitive: true, value: "- 隐私" }),
        nativeRecord({ id: "nm_project", scope: "project", scopeId: "p1", value: "- 本项目用 R。" }), nativeRecord({ id: "nm_elsewhere", scope: "project", scopeId: "p9", value: "- 另一个项目。" }),
        nativeRecord({ id: "nm_old", status: "archived", value: "- 已忘记" })], query };
    },
    async listRecords(userId, input) { calls.push(["native.listRecords", userId, input]); return [nativeRecord()]; },
    async records(userId) { calls.push(["native.records", userId]); return [nativeRecord()]; },
    async changes(userId, input) { calls.push(["native.changes", userId, input]); return [{ id: "nm_0123456789abcdef01234567", kind: "preference", change: "created", summary: "新记下的", changedAt: "2026-10-22T00:00:00Z", version: 77 }]; },
    async update(userId, id, input) { calls.push(["native.update", userId, id, input]); return nativeRecord({ id, ...(input.status ? { status: "archived", version: 99 } : { value: input.value }) }); },
    async undo(userId, id, input) { calls.push(["native.undo", userId, id, input]); return { undone: "restored", record: nativeRecord({ id }), restored: [] }; },
    async setLearning(userId, learning) { calls.push(["native.setLearning", userId, learning]); },
    ...native,
  };
  const memoryIntelligence = { async recordRun() { calls.push(["recordRun"]); return { proposed: 1, extracted: 1, activated: 0, pending: 1, rejected: 0 }; } };
  const routes = createAgentMemoryRoutes({
    config: { agentMemoryApiEnabled: true, maxJsonBytes: 1_048_576, ovNativeMemoryEnabled: true, ...config }, apiKeys, store, researchMemory, capsules, memoryIntelligence, memorySubstrate,
    nativeMemory, audit: async (event, status, details) => { calls.push(["audit", event, details]); },
  });
  const run = async (path, body = undefined, method = undefined, extra = {}) => { const res = response(); await routes(request(path, body, method, extra), res); return res.captured; };
  return { run, calls, routes };
}

const called = (calls, name) => calls.filter((entry) => entry[0] === name);
const rejected = async (promise) => promise.then(() => null, (error) => error);

test("an episode for a native account is refused by name, before a subject's account is made, and nothing is extracted", async () => {
  const { run, calls } = fixture({ subjects: true });
  const error = await rejected(run(`${AGENT_MEMORY_PATH}/episodes`, { messages: [{ role: "user", text: "我吃素" }] }, "POST", { "x-subject": "doctor-1" }));
  assert.equal(error.status, 400);
  assert.equal(error.code, "memory_engine_unsupported");
  assert.match(error.message, /POST \/note/);
  assert.equal(called(calls, "recordRun").length, 0);
  assert.equal(called(calls, "subjectAccount").length, 0, "a refused call makes no account");
  // The same call for the institution's own native account is refused the same way.
  const own = fixture();
  assert.equal((await rejected(own.run(`${AGENT_MEMORY_PATH}/episodes`, { messages: [{ role: "user", text: "我吃素" }] }, "POST")))?.code, "memory_engine_unsupported");
  // An account on the other engine is extracted as before, and says which engine it is.
  const legacy = fixture({ engine: "legacy" });
  const done = await legacy.run(`${AGENT_MEMORY_PATH}/episodes`, { projectId: "p1", messages: [{ role: "user", text: "我吃素" }] }, "POST");
  assert.equal(done.status, 202);
  assert.equal(done.body.data.engine, "legacy");
  assert.equal(done.headers["X-Memory-Engine"], "legacy");
  assert.equal(called(legacy.calls, "recordRun").length, 1);
});

test("a recall of a native account reads the engine's files and not the PostgreSQL copies, in the account's own scope", async () => {
  const { run, calls } = fixture();
  const answer = await run(`${AGENT_MEMORY_PATH}/recall`, { query: "引用格式", projectId: "p1", scope: "conversation", methods: "none" });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.data.engine, "native");
  assert.equal(answer.headers["X-Memory-Engine"], "native");
  assert.equal(called(calls, "legacy.substrateRecall").length, 0, "the stale copies are not read");
  assert.deepEqual(called(calls, "native.search"), [["native.search", "u1", "引用格式"]]);
  const items = answer.body.data.items;
  // The account's own and this project's; never a sensitive one, another project's, or one that is not in force.
  assert.deepEqual(items.map((item) => item.id), ["nm_0123456789abcdef01234567", "nm_project"]);
  assert.deepEqual([items[0].source, items[0].memoryType, items[0].kind, items[0].contextOnly], ["memory", "native", "preference", true]);
  assert.equal(items[0].content, "- 参考文献一律用 AMA 格式。", "the engine's own field comment is not the person's text");
  // The capsule's half is the capsule store's, on both engines.
  const both = await run(`${AGENT_MEMORY_PATH}/recall`, { query: "引用格式", scope: "all", methods: "none" });
  assert.equal(called(calls, "capsule.recall").length >= 1, true);
  assert.equal(both.body.data.engine, "native");
  // The other engine is read where it always was.
  const legacy = fixture({ engine: "legacy" });
  const old = await legacy.run(`${AGENT_MEMORY_PATH}/recall`, { query: "引用格式", scope: "conversation", methods: "none" });
  assert.equal(called(legacy.calls, "legacy.substrateRecall").length, 1);
  assert.deepEqual([old.body.data.engine, old.headers["X-Memory-Engine"]], ["legacy", "legacy"]);
});

test("the adapter hands recall the engine's memories as records: no sensitive one, no long file, a project only in its own", async () => {
  const source = nativeRecallSource({ async search() { return { items: [nativeRecord({ value: "长".repeat(5_000) }), nativeRecord({ id: "nm_s", sensitive: true }), nativeRecord({ id: "nm_p", scope: "project", scopeId: "p1" })] }; } });
  assert.equal(source.recallEnabled, true);
  const named = await source.recall("u1", "q", { projectId: "p1" });
  assert.deepEqual(named.map((memo) => memo.id), ["nm_0123456789abcdef01234567", "nm_p"]);
  assert.equal([...named[0].content].length, 2_000);
  assert.deepEqual((await source.recall("u1", "q", { projectId: null })).map((memo) => memo.id), ["nm_0123456789abcdef01234567"], "no project named: the account's own only");
});

test("the list and the dashboard of a native account are the engine's, with no usage counts and no pending records", async () => {
  const { run, calls } = fixture();
  const list = await run(`${AGENT_MEMORY_PATH}/records?kind=preference&scope=user&query=AMA&pageSize=5`);
  assert.equal(list.headers["X-Memory-Engine"], "native");
  assert.deepEqual(list.body.data.map((record) => record.id), ["nm_0123456789abcdef01234567"]);
  assert.deepEqual(called(calls, "native.listRecords")[0][2], { scopes: ["user"], kinds: ["preference"], scopeId: "", query: "AMA", pageSize: 5 });
  assert.equal(called(calls, "legacy.listRecords").length, 0);
  // The engine's memories are all in force: a proposal, a replaced or a forgotten one is none of them.
  const pending = await run(`${AGENT_MEMORY_PATH}/records?status=pending`);
  assert.deepEqual(pending.body.data, []);
  const both = await run(`${AGENT_MEMORY_PATH}/records?status=active,archived`);
  assert.equal(both.body.data.length, 1);

  const board = await run(`${AGENT_MEMORY_PATH}/dashboard`);
  assert.equal(board.body.data.engine, "native");
  assert.equal(board.headers["X-Memory-Engine"], "native");
  assert.deepEqual(board.body.data.records.map((row) => [row.id, row.source, row.usage.count]), [["nm_0123456789abcdef01234567", "self", 0]]);
  assert.deepEqual(board.body.data.pending, []);
  assert.deepEqual(board.body.data.recentChanges.map((change) => [change.recordId, change.undo.path, change.undo.expectedVersion]), [["nm_0123456789abcdef01234567", "records/nm_0123456789abcdef01234567/undo", 77]]);
  for (const name of ["legacy.listRecords", "legacy.recordUsage", "legacy.recentChanges"]) assert.equal(called(calls, name).length, 0, name);

  const legacy = fixture({ engine: "legacy" });
  const old = await legacy.run(`${AGENT_MEMORY_PATH}/dashboard`);
  assert.equal(old.body.data.engine, "legacy");
  assert.equal(called(legacy.calls, "legacy.listRecords").length, 1);
});

test("the acts on a native memory are the page's acts on the file: a forget removes it from the engine and names the version its undo needs", async () => {
  const { run, calls } = fixture();
  const id = "nm_0123456789abcdef01234567";
  const forgotten = await run(`${AGENT_MEMORY_PATH}/records/${id}/forget`, { expectedVersion: 77 }, "POST");
  assert.equal(forgotten.headers["X-Memory-Engine"], "native");
  assert.deepEqual([forgotten.body.data.status, forgotten.body.data.version], ["archived", 99]);
  assert.deepEqual(called(calls, "native.update")[0].slice(1), ["u1", id, { status: "archived", expectedVersion: 77 }]);
  const undone = await run(`${AGENT_MEMORY_PATH}/records/${id}/undo`, { expectedVersion: 99 }, "POST");
  assert.equal(undone.status, 200);
  assert.deepEqual(called(calls, "native.undo")[0].slice(1), ["u1", id, { expectedVersion: 99 }]);
  const edited = await run(`${AGENT_MEMORY_PATH}/records/${id}`, { expectedVersion: 77, value: "参考文献改用 Vancouver 格式。" }, "PATCH");
  assert.equal(edited.body.data.value, "参考文献改用 Vancouver 格式。");
  assert.deepEqual(called(calls, "native.update").at(-1).slice(1), ["u1", id, { value: "参考文献改用 Vancouver 格式。", expectedVersion: 77 }]);
  // What a file does not have is said by name, and nothing of it reaches the legacy store.
  assert.equal((await rejected(run(`${AGENT_MEMORY_PATH}/records/${id}`, { expectedVersion: 77, summary: "引用" }, "PATCH")))?.code, "memory_engine_unsupported");
  const restore = await rejected(run(`${AGENT_MEMORY_PATH}/records/${id}/restore`, { expectedVersion: 99 }, "POST"));
  assert.deepEqual([restore.status, restore.code], [400, "memory_engine_unsupported"]);
  const confirm = await rejected(run(`${AGENT_MEMORY_PATH}/records/${id}/confirm`, { expectedVersion: 77 }, "POST"));
  assert.deepEqual([confirm.status, confirm.code], [409, "memory_not_pending"]);
  for (const name of ["legacy.getRecord", "legacy.upsertRecord", "legacy.undo"]) assert.equal(called(calls, name).length, 0, name);
  // A stale version is the engine's own conflict, the same code as the legacy store's.
  const stale = fixture({ native: { async update() { throw new HttpError(409, "memory_conflict", "Structured memory changed before this update was applied.") } } });
  assert.equal((await rejected(stale.run(`${AGENT_MEMORY_PATH}/records/${id}/forget`, { expectedVersion: 1 }, "POST")))?.code, "memory_conflict");
});

test("a pause on a native account is the engine's own policy too, and the answer names the engine", async () => {
  const { run, calls } = fixture();
  const done = await run(`${AGENT_MEMORY_PATH}/settings`, { learningPaused: true }, "PUT");
  assert.deepEqual([done.body.data.learningPaused, done.body.data.engine], [true, "native"]);
  assert.deepEqual(called(calls, "native.setLearning"), [["native.setLearning", "u1", false]]);
  // A recall pause alone does not touch the engine's learning, and an engine that cannot be told does not undo the switch.
  const recallOnly = fixture();
  await recallOnly.run(`${AGENT_MEMORY_PATH}/settings`, { recallPaused: true }, "PUT");
  assert.equal(called(recallOnly.calls, "native.setLearning").length, 0);
  const down = fixture({ native: { async setLearning() { throw new HttpError(503, "memory_engine_unavailable", "down"); } } });
  const stillDone = await down.run(`${AGENT_MEMORY_PATH}/settings`, { learningPaused: true }, "PUT");
  assert.equal(stillDone.body.data.learningPaused, true);
  assert.equal(called(down.calls, "audit").some((entry) => entry[1] === "agent-memory.settings.engine"), true);
  const legacy = fixture({ engine: "legacy" });
  assert.equal((await legacy.run(`${AGENT_MEMORY_PATH}/settings`, { learningPaused: true }, "PUT")).body.data.engine, "legacy");
  assert.equal(called(legacy.calls, "native.setLearning").length, 0);
});

test("a native account in a deployment that cannot reach the engine is told so, never served the other engine's rows; a subject with no account is an empty memory", async () => {
  const down = fixture({ configured: false });
  for (const path of ["records", "dashboard"]) {
    const error = await rejected(down.run(`${AGENT_MEMORY_PATH}/${path}`));
    assert.deepEqual([error.status, error.code], [503, "memory_engine_unavailable"], path);
  }
  assert.equal((await rejected(down.run(`${AGENT_MEMORY_PATH}/recall`, { query: "x" }, "POST")))?.code, "memory_engine_unavailable");
  assert.equal(called(down.calls, "legacy.listRecords").length, 0);
  // A subject nobody has written for yet has no account on either engine: an empty answer, and nothing is created by reading.
  const unseen = fixture({ subjects: true, configured: false });
  const board = await unseen.run(`${AGENT_MEMORY_PATH}/dashboard`, undefined, "GET", { "x-subject": "doctor-9" });
  assert.deepEqual([board.status, board.body.data.records, board.body.data.engine], [200, [], "native"], "the engine a new account would be given");
  assert.equal(called(unseen.calls, "subjectAccount").length, 0);
  const recall = await unseen.run(`${AGENT_MEMORY_PATH}/recall`, { query: "x", methods: "none" }, "POST", { "x-subject": "doctor-9" });
  assert.deepEqual([recall.status, recall.body.data.items], [200, []]);
});

test("the description names the engine: a schema, a header, the episode refusal, and a rule of its own", () => {
  const document = agentMemoryOpenApi({ basePath: AGENT_MEMORY_PATH, rateLimitPerMinute: 120 });
  assert.match(document.info.description, /^Three rules hold everywhere/m);
  assert.match(document.info.description, /3\. An account's memory is on one of two engines/);
  assert.deepEqual(document.components.schemas.Engine.enum, ["legacy", "native"]);
  assert.equal(document.components.schemas.RecallResponse.properties.data.properties.engine.$ref, "#/components/schemas/Engine");
  assert.equal(document.components.schemas.Dashboard.properties.data.properties.engine.$ref, "#/components/schemas/Engine");
  assert.equal(document.paths["/records"].get.responses[200].headers["X-Memory-Engine"].$ref, "#/components/headers/MemoryEngine");
  assert.match(document.paths["/episodes"].post.responses[400].description, /memory_engine_unsupported/);
});
