import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryGatewayHandler, filterCapturedMessage, MEMORY_GATEWAY_TOOLS } from "../../../apps/server/src/memoryGateway.mjs";
import { OpenVikingClient } from "../../../apps/server/src/openVikingClient.mjs";
import { OpenVikingSessions, platformSessionOf } from "../../../apps/server/src/openVikingSessions.mjs";
import { startOpenVikingStub } from "../../../apps/server/test/helpers/openVikingStub.mjs";
import {
  capturedBody, controlUserId, controlUserPrefix, countDiffOperations, createMemoryClient, engineSessionId, firstLine, memoryFileRel, memoryTools,
  LabClockSessions, messageTimes, redact, sessionUsage, splitTurns, startGatewayServer, taskUsage, toolAnswer,
} from "../run/lab.mjs";

test("engine sessions carry the dsh- prefix raw history indexes, in the plugin's alphabet", () => {
  const id = engineSessionId("smoke-run-1", "U01", "s001");
  assert.equal(id, "dsh-smoke-run-1-U01-s001");
  assert.equal(platformSessionOf(id), "smoke-run-1-U01-s001");
  assert.equal(engineSessionId("r.1", "u 2", "s/3"), "dsh-r_1-u_2-s_3");
  const long = engineSessionId("r".repeat(64), "U".repeat(64), "s".repeat(64));
  assert.ok(long.length <= 164 && platformSessionOf(long));
  assert.notEqual(long, engineSessionId("r".repeat(64), "U".repeat(64), `${"s".repeat(63)}t`));
  assert.equal(controlUserId("smoke-run-1", "U01"), "evlab_smoke-run-1_U01");
  assert.ok(controlUserId("smoke-run-1", "U01").startsWith(controlUserPrefix("smoke-run-1")));
});

test("message times follow the session's time, one second per message, unless a message has its own", () => {
  const session = { at: "2026-03-07T02:53:48.000Z", messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "c", at: "2026-03-07T03:00:00Z" }] };
  assert.deepEqual(messageTimes(session), ["2026-03-07T02:53:48.000Z", "2026-03-07T02:53:49.000Z", "2026-03-07T03:00:00.000Z"]);
  assert.throws(() => messageTimes({ at: "never", messages: [] }), /ISO time/);
  const body = capturedBody(session.messages[0], "2026-03-07T02:53:48.000Z");
  const decision = filterCapturedMessage(body);
  assert.ok("forward" in decision);
  assert.equal(decision.forward.created_at, "2026-03-07T02:53:48.000Z", "the door keeps the time the engine dates memories by");
});

test("turns start at user messages; leading assistant messages belong to the first turn", () => {
  const roles = (/** @type {string} */ text) => [...text].map((letter) => ({ role: letter === "u" ? "user" : "assistant" }));
  assert.deepEqual(splitTurns(roles("uaua")), [[0, 2], [2, 4]]);
  assert.deepEqual(splitTurns(roles("auaau")), [[0, 4], [4, 5]]);
  assert.deepEqual(splitTurns(roles("uu")), [[0, 1], [1, 2]]);
  assert.deepEqual(splitTurns([]), []);
});

test("snapshots keep memory .md files only, as run_native_eval reads them", () => {
  const root = "viking://user/u-x/memories";
  assert.equal(memoryFileRel(`${root}/profile.md`, root), "profile.md");
  assert.equal(memoryFileRel(`${root}/preferences/self/tea.md`, root), "preferences/self/tea.md");
  assert.equal(memoryFileRel(`${root}/observations/x.md`, root), "observations/x.md");
  assert.equal(memoryFileRel(`${root}/.overview.md`, root), null);
  assert.equal(memoryFileRel(`${root}/preferences/.abstract.md`, root), null);
  assert.equal(memoryFileRel(`${root}/identity.md`, root), null);
  assert.equal(memoryFileRel(`${root}/notes/a.json`, root), null);
  assert.equal(memoryFileRel("viking://user/u-y/memories/profile.md", root), null);
});

test("diff operations count memory files and observation notes apart; usage comes from the task", () => {
  const root = "viking://user/u-x/memories";
  const diff = { operations: { adds: [{ uri: `${root}/profile.md` }, { uri: `${root}/observations/a.md` }], updates: [{ uri: `${root}/preferences/self/t.md` }], deletes: [] } };
  assert.deepEqual(countDiffOperations(diff, root), { adds: 1, updates: 1, deletes: 0, observations: 1 });
  assert.deepEqual(countDiffOperations({ summary: { total_adds: 2, total_updates: 0, total_deletes: 1 } }, root), { adds: 2, updates: 0, deletes: 1, observations: 0 });
  assert.deepEqual(countDiffOperations(null, root), { adds: 0, updates: 0, deletes: 0, observations: 0 });
  assert.deepEqual(taskUsage({ result: { token_usage: { llm: { prompt_tokens: 27988, completion_tokens: 142, cached_tokens: 768 } } } }), { promptTokens: 27988, completionTokens: 142, cachedTokens: 768 });
  assert.deepEqual(taskUsage(null), { promptTokens: 0, completionTokens: 0, cachedTokens: 0 });
});

test("tool answers: event streams, plain JSON-RPC, JSON-RPC errors and gateway refusals", () => {
  const sse = `event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }], isError: false } })}\r\n\r\n`;
  assert.deepEqual(toolAnswer({ status: 200, contentType: "text/event-stream", text: sse }, 7), { blocks: ["a", "b"], isError: false });
  assert.deepEqual(toolAnswer({ status: 200, contentType: "application/json", text: JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "x" }], isError: true } }) }, 3), { blocks: ["x"], isError: true });
  assert.deepEqual(toolAnswer({ status: 200, contentType: "application/json", text: JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Tool not available: grep" } }) }, 3), { blocks: ["Tool not available: grep"], isError: true });
  assert.deepEqual(toolAnswer({ status: 401, contentType: "application/json", text: JSON.stringify({ status: "error", error: { code: "memory_gateway_unauthenticated", message: "no" } }) }, 1), { blocks: ["memory_gateway_unauthenticated: no"], isError: true });
  assert.equal(toolAnswer({ status: 200, contentType: "application/json", text: "<html>" }, 1).isError, true);
});

test("redaction removes secrets, database URLs and bearers; firstLine keeps one line with the code", () => {
  const text = redact("key=abcdef123456 url=postgres://u:p@h:5432/db auth Bearer lab-xyz", ["abcdef123456"]);
  assert.equal(text, "key=[redacted] url=[database-url] auth Bearer [redacted]");
  assert.equal(firstLine(Object.assign(new Error("boom\nstack line"), { code: "memory_index_timeout" })), "memory_index_timeout: boom");
  assert.equal(firstLine(new Error("secret-value-1 leaked"), ["secret-value-1"]), "[redacted] leaked");
});

test("memory tools are the product's five, with its descriptions and schemas", () => {
  const tools = memoryTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["search", "read", "list", "remember", "forget"]);
  assert.equal(tools[0].description, MEMORY_GATEWAY_TOOLS.search.description);
  assert.deepEqual(tools[0].inputSchema, MEMORY_GATEWAY_TOOLS.search.inputSchema);
});

/** The real gateway over a stub engine, with no database: what `memory.callTool` and `memory.fetchJSON` reach. */
async function gatewayOverStub(t) {
  const stub = await startOpenVikingStub(t);
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const sessions = new OpenVikingSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const userId = "evlab_test_U01";
  const engineUser = sessions.engineUser(userId);
  await sessions.register(userId);
  const profile = stub.seedMemory(engineUser, "profile.md", "# Invented person\n- keeps a blue teapot (as of 2026-01-02)", { type: "profile" });
  stub.seedMemory(engineUser, "preferences/self/tea.md", "- prefers green tea", { type: "preferences" });
  const token = "lab-test-token";
  const handler = createMemoryGatewayHandler({
    config: { memoryEngineEnabled: true, memoryEnabled: true, memoryHistorySearchEnabled: false },
    runtimeManager: { assertActiveEviMedWorkloadToken: async (given) => { if (given === token) return { userId, projectId: "default" }; throw new Error("unknown"); } },
    store: { userById: async (id) => ({ id }), requireProject: async (user, id) => ({ id, userId: user.id, name: "我的项目" }) },
    sessions, admission: { admit: async () => ({ learn: true, recall: true, learnReason: null, recallReason: null, sessionId: null }) },
  });
  const server = await startGatewayServer(handler);
  t.after(() => server.close());
  return { stub, server, token, engineUser, profile };
}

test("memory.callTool is a real JSON-RPC tools/call through the gateway; writes are refused while read-only", async (t) => {
  const { server, token, profile } = await gatewayOverStub(t);
  const memory = createMemoryClient({ base: server.base, token });
  const searched = await memory.callTool("search", { query: "teapot" });
  assert.equal(searched.isError, false);
  const hits = JSON.parse(searched.blocks[0]);
  assert.deepEqual(hits.memories.map((/** @type {any} */ hit) => hit.uri), [profile]);
  const read = await memory.callTool("read", { uris: [profile] });
  assert.equal(read.isError, false);
  assert.match(read.blocks.join("\n"), /blue teapot/);
  assert.deepEqual(await memory.callTool("remember", { messages: [{ role: "user", content: "remember this" }] }), { blocks: ["lab_read_only: remember is not executed by this memory object"], isError: true });
  assert.equal((await memory.callTool("forget", { uri: profile })).isError, true);
  const refused = await memory.callTool("grep", { pattern: "x" });
  assert.equal(refused.isError, true);
  assert.match(refused.blocks[0], /Tool not available/);
  const stranger = createMemoryClient({ base: server.base, token: "lab-unknown" });
  assert.deepEqual(await stranger.callTool("search", { query: "teapot" }), { blocks: ["memory_gateway_unauthenticated: The memory gateway does not know this caller."], isError: true });
});

test("memory.fetchJSON answers the plugin's REST reads as the plugin's own client does", async (t) => {
  const { server, token, engineUser, profile } = await gatewayOverStub(t);
  const memory = createMemoryClient({ base: server.base, token });
  const status = await memory.fetchJSON("/api/v1/system/status");
  assert.deepEqual(status, { ok: true, status: 200, result: { initialized: true, user: engineUser } });
  const spaces = await memory.fetchJSON(`/api/v1/fs/ls?uri=${encodeURIComponent("viking://user")}&output=original`);
  assert.deepEqual(spaces.result.map((/** @type {any} */ entry) => entry.name), [engineUser]);
  assert.deepEqual(await memory.fetchJSON(`/api/v1/content/read?uri=${encodeURIComponent(profile)}`), { ok: true, status: 200, result: "# Invented person\n- keeps a blue teapot (as of 2026-01-02)" });
  const listing = await memory.fetchJSON(`/api/v1/fs/ls?uri=${encodeURIComponent(`viking://user/${engineUser}/memories/preferences`)}&output=agent&recursive=true&abs_limit=512&node_limit=512`);
  assert.equal(listing.ok, true);
  assert.deepEqual(listing.result.filter((/** @type {any} */ entry) => !entry.isDir).map((/** @type {any} */ entry) => entry.rel_path), ["self/tea.md"]);
  assert.ok(listing.result.every((/** @type {any} */ entry) => !("abstract" in entry)), "the gateway's listing carries no abstracts");
  const outside = await memory.fetchJSON(`/api/v1/content/read?uri=${encodeURIComponent("viking://user/u-someone-else/memories/profile.md")}`);
  assert.equal(outside.ok, false);
  assert.equal(outside.status, 403);
  const unreachable = createMemoryClient({ base: "http://127.0.0.1:9/internal/memory/v1", token, timeoutMs: 2_000 });
  const down = await unreachable.fetchJSON("/api/v1/system/status");
  assert.equal(down.ok, false);
  assert.equal(down.status, 0);
});

test("a session's engine tokens are cumulative: each commit is the difference, the total is the last figure", () => {
  const task = (/** @type {number} */ prompt, /** @type {number} */ completion, /** @type {number} */ cached) => ({ result: { token_usage: { llm: { prompt_tokens: prompt, completion_tokens: completion, cached_tokens: cached } } } });
  const usage = sessionUsage([task(19228, 72, 18816), null, task(38639, 284, 37760)]);
  assert.deepEqual(usage.total, { promptTokens: 38639, completionTokens: 284, cachedTokens: 37760 });
  assert.deepEqual(usage.perCommit, [{ promptTokens: 19228, completionTokens: 72, cachedTokens: 18816 }, { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    { promptTokens: 19411, completionTokens: 212, cachedTokens: 18944 }]);
  assert.deepEqual(sessionUsage([]).total, { promptTokens: 0, completionTokens: 0, cachedTokens: 0 });
});

test("a message the product writes without a time gets the conversation's time; a timed one keeps its own", async (t) => {
  const stub = await startOpenVikingStub(t);
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const clock = new Map([["evlab_test_U02", "2026-02-01T09:00:00.000Z"]]);
  const sessions = new LabClockSessions(client, { timeoutMs: 2_000, fastTimeoutMs: 1_000 }, clock);
  await sessions.register("evlab_test_U02");
  await sessions.createSession("evlab_test_U02", "dsh-x");
  await sessions.addMessage("evlab_test_U02", "dsh-x", { role: "assistant", parts: [{ type: "text", text: "platform line" }] });
  await sessions.addMessage("evlab_test_U02", "dsh-x", { role: "user", parts: [{ type: "text", text: "words" }], created_at: "2026-02-01T09:00:05.000Z" });
  const sent = stub.sent("POST", "/api/v1/sessions/dsh-x/messages").map((request) => request.body.created_at);
  assert.deepEqual(sent, ["2026-02-01T09:00:00.000Z", "2026-02-01T09:00:05.000Z"]);
  clock.clear();
  await sessions.addMessage("evlab_test_U02", "dsh-x", { role: "assistant", parts: [{ type: "text", text: "no clock" }] });
  assert.equal(stub.sent("POST", "/api/v1/sessions/dsh-x/messages").at(-1).body.created_at, undefined);
});


test("settlement drains the product's pending summary invalidations before consuming commits", async () => {
  const { settleLabCommits } = await import('../run/lab.mjs');
  let invalid = true, pending = true;
  const calls = [];
  const worker = {
    async drainSummaryInvalidations() { invalid = false; calls.push('drain'); },
    async processCommits() { assert.equal(invalid, false); pending = false; calls.push('consume'); return 1; },
  };
  const result = await settleLabCommits({ worker, userId: 'fixture', deadline: Date.now() + 1000,
    overlay: { async openCommits() { return pending ? [{ state: 'pending', taskId: 'task' }] : []; } },
    waitTask: async () => { throw new Error('No task wait needed after settlement'); } });
  assert.deepEqual(calls, ['drain', 'consume']);
  assert.equal(result.open, 0);
  assert.equal(result.settled, 1);
});

test('unsettled product commits stop replay rather than masquerading as completed sessions', async () => {
  const { settleLabCommits } = await import('../run/lab.mjs');
  await assert.rejects(settleLabCommits({
    worker: { async drainSummaryInvalidations() {}, async processCommits() { return 0; } },
    overlay: { async openCommits() { return [{ state: 'pending', taskId: 'task' }]; } },
    userId: 'fixture', deadline: Date.now() - 1, waitTask: async () => ({ status: 'completed' }),
  }), { code: 'lab_unsettled_commits' });
});

test('settlement polls transient engine summary conflicts and waits for the next product pass', async () => {
  const { settleLabCommits } = await import('../run/lab.mjs');
  let drains = 0, passes = 0;
  const result = await settleLabCommits({
    worker: {
      async drainSummaryInvalidations() { if (++drains === 1) throw Object.assign(new Error('busy sidecar'), { code: 'memory_index_conflict' }); },
      async processCommits() { passes += 1; return passes === 2 ? 1 : 0; },
    },
    overlay: { async openCommits() { return passes < 2 ? [{ state: 'pending', taskId: 'task' }] : []; } },
    userId: 'fixture', deadline: Date.now() + 1000, pollMs: 1, waitTask: async () => ({ status: 'completed' }),
  });
  assert.equal(result.open, 0);
  assert.equal(result.settled, 1);
  assert.ok(drains > 1);
  assert.equal(passes, 2);
});

test('the switched lab catalogue offers lines and statement without requiring uri', () => {
  const config = { memoryForgetTargetsEnabled: true };
  const tool = memoryTools(config).find(row => row.name === 'forget');
  assert.equal(tool.inputSchema.properties.lines.type, 'array');
  assert.equal(tool.inputSchema.properties.statement.type, 'string');
  assert.equal(tool.inputSchema.required, undefined);
  assert.match(tool.description, /no memory file/);
  assert.deepEqual(createMemoryClient({ base: 'http://unused', token: 'test', config }).tools, memoryTools(config));
  assert.deepEqual(memoryTools({ memoryForgetTargetsEnabled: false }), memoryTools());
});
