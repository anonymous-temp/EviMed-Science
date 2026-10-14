// The memory gateway: the one door between a runtime's unmodified memory plugin and OpenViking's native engine. Each test
// drives the real handler over HTTP against a stub engine that records what reached it — the engine's key and identity
// headers, which messages, which search body — so "not forwarded" is asserted on the engine's side, not inferred.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { PLATFORM_CONTEXT_TAGS, carriesPlatformContext } from "@evimed/domain";
import { createMemoryAdmission, isPlatformStartedRun } from "../src/memoryAdmission.mjs";
import {
  MEMORY_GATEWAY_PATH, MEMORY_GATEWAY_TOOLS, PLUGIN_CONTEXT_TAG, createMemoryGatewayHandler, filterCapturedMessage, memoryGatewayRoutePattern, parseEventStream,
} from "../src/memoryGateway.mjs";
import { nativeMemoryCounters, resetNativeMemoryMetrics } from "../src/nativeMemoryMetrics.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { openVikingUserId } from "../src/openVikingLayout.mjs";
import { OpenVikingSessions } from "../src/openVikingSessions.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const TOKEN = "workload-token-for-tests";
const USER = "user-a";
const OV_USER = openVikingUserId(USER);
const ROOT = `viking://user/${OV_USER}`;
const SESSION = "dsh-session_0123456789abcdef0123456789abcdef";

/** An admission that says what the test wants, and records what it was asked. */
function fixedAdmission(answer = {}) {
  const asked = [];
  const base = { native: true, learn: true, recall: true, learnReason: null, recallReason: null, sessionId: null };
  return { asked, admit: async (caller) => { asked.push(caller.engineSessionId ?? null); return { ...base, ...(typeof answer === "function" ? answer(caller) : answer) }; } };
}

async function fixture(t, { admission = fixedAdmission(), config = {}, overlay = null, stubOptions = {}, memoryTool = null, timeoutMs = 4_000 } = {}) {
  resetNativeMemoryMetrics();
  const stub = await startOpenVikingStub(t, stubOptions);
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const sessions = new OpenVikingSessions(client, { timeoutMs, fastTimeoutMs: Math.round(timeoutMs / 3) });
  const failures = [];
  const handler = createMemoryGatewayHandler({
    config: { ovNativeMemoryEnabled: true, memoryEnabled: true, ...config },
    runtimeManager: { assertActiveEviMedWorkloadToken: async (token) => { if (token === TOKEN) return { userId: USER, projectId: "p1" }; throw new Error("no"); } },
    store: { userById: async (id) => (id === USER ? { id } : null), requireProject: async (_user, id) => ({ id, userId: USER }) },
    sessions, admission, overlay, memoryTool,
  });
  const server = createServer((req, res) => { void handler(req, res, (failure) => failures.push(failure)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}${MEMORY_GATEWAY_PATH}`;
  const call = async (method, path, body = undefined, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, text, contentType: response.headers.get("content-type") ?? "" };
  };
  const mcp = async (message) => {
    const answer = await call("POST", "/mcp", message, { accept: "application/json, text/event-stream" });
    const messages = answer.contentType.includes("event-stream") ? parseEventStream(answer.text) : answer.json ? [answer.json].flat() : [];
    return { ...answer, messages };
  };
  return { stub, call, mcp, failures, admission, sessions };
}

test("the engine is asked as the caller the token names, whatever the request says about itself", async (t) => {
  const { stub, call } = await fixture(t);
  const made = await call("POST", "/api/v1/sessions", { session_id: SESSION, auto_commit_policy: { idle_timeout_seconds: 1 } },
    { "x-openviking-user": "somebody-else", "x-openviking-account": "another", "x-api-key": "caller-key" });
  assert.equal(made.status, 200);
  assert.equal(made.json.result.session_id, SESSION);
  const created = stub.sent("POST", "/api/v1/sessions").at(-1);
  assert.equal(created.user, OV_USER, "the user is the token's, hashed");
  assert.equal(created.headers["x-openviking-account"], "evimed");
  assert.equal(created.headers["x-api-key"], stub.apiKey, "the engine's key is the control plane's own");
  assert.deepEqual(created.body, { session_id: SESSION }, "only the session id is the caller's to choose");
  // The first sight of an account registers it with the engine's admin routes, once.
  assert.equal(stub.sent("POST", "/api/v1/admin/accounts/evimed/users").length, 1);
  await call("GET", `/api/v1/sessions/${SESSION}`);
  assert.equal(stub.sent("POST", "/api/v1/admin/accounts/evimed/users").length, 1);
});

test("a caller with no token, a role, or a route outside the table is refused by name and nothing reaches the engine", async (t) => {
  const { stub, call, failures } = await fixture(t);
  const anonymous = await call("GET", "/health", undefined, { authorization: "Bearer wrong" });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error.code, "memory_gateway_unauthenticated");
  const role = await call("GET", "/api/v1/system/status", undefined, { "x-openviking-role": "root" });
  assert.equal(role.status, 403);
  assert.equal(role.json.error.code, "memory_gateway_role_refused");
  for (const [method, path] of [
    ["GET", "/api/v1/stats/memories"], ["POST", "/api/v1/content/write"], ["DELETE", "/api/v1/fs?uri=x"], ["POST", "/api/v1/pack/export"],
    ["POST", "/api/v1/fs/attrs/set_tags"], ["GET", "/api/v1/admin/accounts/evimed/users"], ["POST", "/api/v1/search/find"], ["GET", "/api/v1/fs/tree?uri=x"],
  ]) {
    const refused = await call(method, path, method === "POST" ? {} : undefined);
    assert.equal(refused.status, 404, `${method} ${path}`);
    assert.equal(refused.json.error.code, "memory_gateway_route_refused");
  }
  assert.equal(stub.requests.length, 0, "no refused request reached the engine");
  assert.ok(failures.some((failure) => failure.code === "memory_gateway_route_refused"));
  assert.equal(nativeMemoryCounters().refusals.memory_gateway_route_refused, 8);
  assert.equal(memoryGatewayRoutePattern(`${MEMORY_GATEWAY_PATH}/api/v1/sessions/abc/messages`), `${MEMORY_GATEWAY_PATH}/:messageWrite`);
  assert.equal(memoryGatewayRoutePattern(`${MEMORY_GATEWAY_PATH}/api/v1/stats/memories`), `${MEMORY_GATEWAY_PATH}/:other`);
});

test("health answers liveness and version only, and status is the caller's own space without asking the engine", async (t) => {
  const { stub, call } = await fixture(t);
  const health = await call("GET", "/health");
  assert.deepEqual(health.json, { status: "ok", healthy: true, version: "v0.5.0" });
  assert.equal(stub.requests.at(-1).user, "", "health carries no identity: a request that names a user registers it");
  const before = stub.requests.length;
  const status = await call("GET", "/api/v1/system/status");
  assert.deepEqual(status.json.result, { initialized: true, user: OV_USER });
  const users = await call("GET", "/api/v1/fs/ls?uri=viking%3A%2F%2Fuser&output=original");
  assert.deepEqual(users.json.result.map((entry) => entry.name), [OV_USER]);
  const skills = await call("GET", "/api/v1/skills");
  assert.deepEqual(skills.json.result, { root_uris: [], skills: [], total: 0 });
  assert.equal(stub.requests.length, before, "status, the user listing and the skill catalogue are answered here");
});

test("only the person's and the assistant's own text reaches the engine: platform text, tool parts and peers do not", async (t) => {
  const { stub, call } = await fixture(t);
  await call("POST", "/api/v1/sessions", { session_id: SESSION });
  const post = (body) => call("POST", `/api/v1/sessions/${SESSION}/messages`, body);
  // 1. the person's words, with a peer and a tool part beside them
  assert.equal((await post({ role: "user", peer_id: "proj_alpha", created_at: "2026-10-13T01:00:00.000Z",
    parts: [{ type: "text", text: "以后回答先给结论再给依据。" }, { type: "tool", tool_name: "mcp__evimed__literature_search", tool_input: { query: "x" } }] })).status, 200);
  // 2. a platform brief in the user slot, 3. the plugin's own injected block, 4. an assistant step that is only tool calls
  await post({ role: "user", parts: [{ type: "text", text: "<evimed-vcr-run>\n请完成方案步骤\n</evimed-vcr-run>" }] });
  await post({ role: "user", content: `<${PLUGIN_CONTEXT_TAG} source="profile">\n# 用户\n- 工程师\n</${PLUGIN_CONTEXT_TAG}>` });
  await post({ role: "assistant", parts: [{ type: "tool", tool_name: "mcp__evimed__kb_search", tool_input: { query: "y" } }] });
  // 5. a mid-run correction keeps the words and loses the wrapper
  await post({ role: "user", content: "<evimed-correction>不对，主要终点是大出血，不是死亡</evimed-correction>" });
  // 6. identifier shapes are masked at the door
  await post({ role: "user", content: "我的手机号是 13800138000，以后周报周四发。" });
  const forwarded = stub.sent("POST", `/api/v1/sessions/${SESSION}/messages`).map((request) => request.body);
  assert.deepEqual(forwarded, [
    { role: "user", parts: [{ type: "text", text: "以后回答先给结论再给依据。" }], created_at: "2026-10-13T01:00:00.000Z" },
    { role: "user", parts: [{ type: "text", text: "不对，主要终点是大出血，不是死亡" }] },
    { role: "user", parts: [{ type: "text", text: "我的手机号是 [已省略]，以后周报周四发。" }] },
  ]);
  const counters = nativeMemoryCounters();
  assert.deepEqual({ forwarded: counters.messages.forwarded, platform: counters.messages.platform_context, noText: counters.messages.no_text, masked: counters.masked.messages },
    { forwarded: 3, platform: 2, noText: 1, masked: 1 });
  const invalid = await post({ role: "system", content: "x" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, "memory_gateway_body_invalid");
});

test("the plugin's own context tag is a registered injection tag", () => {
  const entry = PLATFORM_CONTEXT_TAGS.find((item) => item.tag === PLUGIN_CONTEXT_TAG);
  assert.equal(entry?.role, "injected");
  assert.ok(carriesPlatformContext(`<${PLUGIN_CONTEXT_TAG} source="recall">x</${PLUGIN_CONTEXT_TAG}>`));
  assert.deepEqual(filterCapturedMessage({ role: "assistant", content: `as you said <${PLUGIN_CONTEXT_TAG}>x</${PLUGIN_CONTEXT_TAG}>` }), { drop: "platform_context" });
});

test("a commit the engine accepts is written to the ledger with its archive and task; nothing pending is said as such", async (t) => {
  const recorded = [];
  const overlay = { configured: true, account: async () => ({ registeredAt: "2026-10-13T00:00:00.000Z" }), noteRegistered: async () => {},
    recordCommit: async (commit) => { recorded.push(commit); }, sensitiveUris: async () => [] };
  const { stub, call } = await fixture(t, { overlay });
  await call("POST", "/api/v1/sessions", { session_id: SESSION });
  assert.equal(stub.sent("POST", "/api/v1/admin/").length, 0, "an account the overlay knows as registered is not registered again");
  const empty = await call("POST", `/api/v1/sessions/${SESSION}/commit`, { keep_recent_count: 0, wait: true, telemetry: true });
  assert.equal(empty.json.result.status, "skipped");
  assert.equal(recorded.length, 0);
  await call("POST", `/api/v1/sessions/${SESSION}/messages`, { role: "user", content: "我是结构工程师。" });
  const committed = await call("POST", `/api/v1/sessions/${SESSION}/commit`, { keep_recent_count: 0, wait: true });
  assert.equal(committed.json.result.status, "accepted");
  assert.deepEqual(stub.sent("POST", `/api/v1/sessions/${SESSION}/commit`).at(-1).body, { keep_recent_count: 0 }, "only keep_recent_count goes on");
  assert.deepEqual(recorded, [{ userId: USER, archiveUri: `${ROOT}/sessions/${SESSION}/history/archive_001`, engineSession: SESSION, projectId: "p1", origin: "gateway",
    taskId: committed.json.result.task_id }]);
  assert.equal(nativeMemoryCounters().commits.accepted, 1);
});

test("commits are bounded per account per hour, and a held commit loses nothing: the messages stay pending", async (t) => {
  const { stub, call } = await fixture(t, { config: { memoryGatewayCommitsPerHour: 1 } });
  await call("POST", "/api/v1/sessions", { session_id: SESSION });
  await call("POST", `/api/v1/sessions/${SESSION}/messages`, { role: "user", content: "一。" });
  assert.equal((await call("POST", `/api/v1/sessions/${SESSION}/commit`, {})).json.result.status, "accepted");
  await call("POST", `/api/v1/sessions/${SESSION}/messages`, { role: "user", content: "二。" });
  const held = await call("POST", `/api/v1/sessions/${SESSION}/commit`, {});
  assert.equal(held.json.result.status, "skipped");
  assert.equal(stub.sent("POST", `/api/v1/sessions/${SESSION}/commit`).length, 1);
  assert.equal(stub.sessions.get(`${OV_USER}/${SESSION}`).messages.length, 1, "the second message is still in the session");
  assert.equal(nativeMemoryCounters().commits.rate_limited, 1);
});

test("recall is rewritten so custom types can be found: no purpose, no quotas, no expansion, and the derived index, shared areas and sensitive files excluded", async (t) => {
  const sensitive = `${ROOT}/memories/preferences/self/私事.md`;
  const overlay = { configured: true, account: async () => ({ registeredAt: "x" }), noteRegistered: async () => {}, recordCommit: async () => {}, sensitiveUris: async () => [sensitive] };
  const { stub, call } = await fixture(t, { overlay });
  await call("POST", "/api/v1/search/search", { query: "回答的要求", mode: "context", purpose: "coding", quotas: { preferences: 3 }, score_threshold: 0.35, session_id: SESSION, dedup_turns: 5, query_expansion: "auto" });
  const sent = stub.sent("POST", "/api/v1/search/search").at(-1).body;
  assert.equal("purpose" in sent, false);
  assert.equal("quotas" in sent, false);
  assert.equal(sent.query_expansion, "off");
  assert.equal(sent.mode, "context");
  assert.equal(sent.score_threshold, 0.35);
  assert.deepEqual(sent.exclude_uris, ["viking://resources", "viking://agent", `${ROOT}/memories/evimed`, sensitive]);
  // List mode with no target would search every scope the account can see: it is pinned to the caller's memories.
  await call("POST", "/api/v1/search/search", { query: "q", limit: 5 });
  assert.equal(stub.sent("POST", "/api/v1/search/search").at(-1).body.target_uri, `${ROOT}/memories`);
  const outside = await call("POST", "/api/v1/search/search", { query: "q", target_uri: "viking://user/u-000000000000000000000000/memories" });
  assert.equal(outside.status, 403);
  assert.equal(outside.json.error.code, "memory_gateway_uri_refused");
});

test("every URI stays inside the caller's own space, and the derived index and sensitive files read as not there", async (t) => {
  const sensitive = `${ROOT}/memories/preferences/self/私事.md`;
  const overlay = { configured: true, account: async () => ({ registeredAt: "x" }), noteRegistered: async () => {}, recordCommit: async () => {}, sensitiveUris: async () => [sensitive] };
  const { stub, call } = await fixture(t, { overlay });
  stub.seedMemory(OV_USER, "profile.md", "# 用户\n- 结构工程师 (as of 2026-10-12)", { type: "profile" });
  stub.seedMemory(OV_USER, "preferences/self/回答结构.md", "- 先给结论。", { type: "preferences" });
  stub.seedMemory(OV_USER, "preferences/self/私事.md", "- 私事。", { type: "preferences" });
  stub.seedMemory(OV_USER, "evimed/user/preference/rec1.md", "偏好 / 报告呈现");
  stub.seedMemory("u-other", "profile.md", "# 别人");
  const profile = await call("GET", `/api/v1/content/read?uri=${encodeURIComponent(`${ROOT}/memories/profile.md`)}`);
  assert.equal(profile.json.result, "# 用户\n- 结构工程师 (as of 2026-10-12)");
  for (const uri of ["viking://user/u-other/memories/profile.md", `${ROOT}/../u-other/memories/profile.md`, "viking://resources/x.md"]) {
    const refused = await call("GET", `/api/v1/content/read?uri=${encodeURIComponent(uri)}`);
    assert.equal(refused.status, 403, uri);
  }
  for (const uri of [sensitive, `${ROOT}/memories/evimed/user/preference/rec1.md`, `${ROOT}/memories/missing.md`]) {
    assert.equal((await call("GET", `/api/v1/content/read?uri=${encodeURIComponent(uri)}`)).status, 404, uri);
  }
  const listed = await call("GET", `/api/v1/fs/ls?uri=${encodeURIComponent(`${ROOT}/memories`)}&output=agent&recursive=true`);
  assert.deepEqual(listed.json.result.filter((entry) => !entry.isDir).map((entry) => entry.rel_path).sort(), ["preferences/self/回答结构.md", "profile.md"]);
  // A directory the engine has not made yet is an empty listing, as the plugin reads a 404.
  const none = await call("GET", `/api/v1/fs/ls?uri=${encodeURIComponent(`${ROOT}/memories/entities`)}`);
  assert.deepEqual([none.status, none.json.result], [200, []]);
});

test("a caller that is not learned from has its writes accepted and not forwarded; one that is not read for finds nothing", async (t) => {
  const admission = fixedAdmission({ learn: false, recall: false, learnReason: "internal_project", recallReason: "internal_project" });
  const { stub, call, mcp } = await fixture(t, { admission });
  stub.seedMemory(OV_USER, "profile.md", "# 用户\n- 结构工程师", { type: "profile" });
  const made = await call("POST", "/api/v1/sessions", { session_id: SESSION });
  assert.equal(made.json.result.session_id, SESSION);
  const written = await call("POST", `/api/v1/sessions/${SESSION}/messages`, { role: "user", content: "我是结构工程师。" });
  assert.deepEqual(written.json.result, { session_id: SESSION, message_count: 0, pending_tokens: 0 });
  const committed = await call("POST", `/api/v1/sessions/${SESSION}/commit`, {});
  assert.equal(committed.json.result.status, "skipped");
  assert.equal((await call("GET", `/api/v1/content/read?uri=${encodeURIComponent(`${ROOT}/memories/profile.md`)}`)).status, 404);
  assert.deepEqual((await call("GET", `/api/v1/fs/ls?uri=${encodeURIComponent(`${ROOT}/memories/preferences`)}`)).json.result, []);
  assert.deepEqual((await call("POST", "/api/v1/search/search", { query: "q", mode: "context" })).json.result, { entries: [], rendered: "", digest: "" });
  assert.deepEqual((await call("POST", "/api/v1/search/search", { query: "q" })).json.result, { memories: [], resources: [], skills: [], total: 0 });
  const read = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { uris: [`${ROOT}/memories/profile.md`] } } });
  assert.match(read.messages[0].result.content[0].text, /不读取长期记忆/);
  const remember = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remember", arguments: { messages: [{ role: "user", content: "记住我用毫米。" }] } } });
  assert.match(remember.messages[0].result.content[0].text, /没有记下/);
  assert.equal(stub.requests.filter((request) => request.path !== "/health").length, 0, "nothing of this caller reached the engine");
  assert.ok(nativeMemoryCounters().withheld.internal_project >= 6);
});

test("a platform-started turn's messages are not forwarded while the conversation's commit still archives the person's own", async (t) => {
  let automated = false;
  const admission = fixedAdmission(() => (automated ? { learn: false, learnReason: "automated_run" } : {}));
  const { stub, call } = await fixture(t, { admission });
  await call("POST", "/api/v1/sessions", { session_id: SESSION });
  await call("POST", `/api/v1/sessions/${SESSION}/messages`, { role: "user", content: "目标：把综述写完。" });
  automated = true;
  await call("POST", `/api/v1/sessions/${SESSION}/messages`, { role: "assistant", content: "继续推进第二节。" });
  const committed = await call("POST", `/api/v1/sessions/${SESSION}/commit`, {});
  assert.equal(committed.json.result.status, "accepted");
  assert.equal(stub.files.get(`${ROOT}/sessions/${SESSION}/history/archive_001/messages.jsonl`).split("\n").length, 1, "only the person's turn was archived");
});

test("a conversation that read a patient record sends nothing more, and what it had sent is dropped", async (t) => {
  let clinical = false;
  const admission = fixedAdmission(() => (clinical ? { learn: false, learnReason: "clinical_context" } : {}));
  const { stub, call } = await fixture(t, { admission });
  await call("POST", "/api/v1/sessions", { session_id: SESSION });
  await call("POST", `/api/v1/sessions/${SESSION}/messages`, { role: "user", content: "先看一下这份入组记录。" });
  clinical = true;
  await call("POST", `/api/v1/sessions/${SESSION}/messages`, { role: "assistant", content: "这位受试者的情况是……" });
  assert.equal((await call("POST", `/api/v1/sessions/${SESSION}/commit`, {})).json.result.status, "skipped");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stub.sessions.has(`${OV_USER}/${SESSION}`), false, "the engine session, with what was pending in it, is gone");
  assert.equal(stub.sent("POST", `/api/v1/sessions/${SESSION}/commit`).length, 0);
});

test("the model sees five tools with this platform's descriptions, and a call of anything else never reaches the engine", async (t) => {
  const { stub, mcp } = await fixture(t);
  const listed = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = listed.messages[0].result.tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["forget", "list", "read", "remember", "search"]);
  for (const tool of tools) {
    assert.equal(tool.description, MEMORY_GATEWAY_TOOLS[tool.name].description);
    assert.equal("upstream" in tool.inputSchema.properties, false, `${tool.name} carries this platform's schema`);
  }
  assert.match(tools.find((tool) => tool.name === "remember").description, /ONLY when the user explicitly asks/);
  assert.ok(JSON.stringify(tools).length < 3_000, "five short definitions: a tool's description is paid for on every request");
  const before = stub.sent("POST", "/mcp").length;
  for (const name of ["list_users", "write", "add_resource", "grep", "set_acl"]) {
    const refused = await mcp({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: {} } });
    assert.equal(refused.messages[0].error.code, -32601, name);
  }
  const prompts = await mcp({ jsonrpc: "2.0", id: 8, method: "prompts/list" });
  assert.deepEqual(prompts.messages[0].result, { prompts: [] });
  assert.equal((await mcp({ jsonrpc: "2.0", id: 9, method: "sampling/createMessage", params: {} })).messages[0].error.code, -32601);
  assert.equal(stub.sent("POST", "/mcp").length, before, "refused and locally answered calls are not forwarded");
  // The handshake itself goes through unchanged.
  const hello = await mcp({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  assert.equal(hello.messages[0].result.serverInfo.name, "openviking");
  assert.equal((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
});

test("tool arguments are held to the caller's own memories: pinned targets, no recursion, no file outside memories", async (t) => {
  const forgotten = [];
  const { stub, mcp } = await fixture(t, { memoryTool: { forget: async (_user, _project, uri) => { forgotten.push(uri); return { removed: true }; } } });
  stub.seedMemory(OV_USER, "preferences/self/回答结构.md", "- 先给结论。", { type: "preferences" });
  stub.seedMemory(OV_USER, "evimed/user/preference/rec1.md", "偏好 / 报告呈现");
  const call = (name, args) => mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  await call("list", {});
  assert.deepEqual(stub.sent("POST", "/mcp").at(-1).body.params.arguments, { uri: `${ROOT}/memories`, recursive: false });
  await call("search", { query: "回答", purpose: "coding", quotas: { x: 1 }, mode: "context" });
  assert.deepEqual(stub.sent("POST", "/mcp").at(-1).body.params.arguments, {
    query: "回答", limit: 5, target_uri: `${ROOT}/memories`, query_expansion: "off", exclude_uris: ["viking://resources", "viking://agent", `${ROOT}/memories/evimed`],
  });
  const foreign = await call("read", { uris: ["viking://user/u-other/memories/profile.md"] });
  assert.equal(foreign.messages[0].error.code, -32602);
  const derived = await call("read", { uris: [`${ROOT}/memories/evimed/user/preference/rec1.md`] });
  assert.match(derived.messages[0].result.content[0].text, /没有可读取/);
  for (const args of [{ uri: `${ROOT}/memories/preferences`, recursive: true }, { uri: `${ROOT}/memories/preferences` }, { uri: `${ROOT}/sessions/x/history/archive_001/messages.jsonl` },
    { uri: `${ROOT}/memories/evimed/user/preference/rec1.md` }]) {
    const refused = await call("forget", args);
    assert.equal(refused.messages[0].error?.code, -32602, JSON.stringify(args));
  }
  const done = await call("forget", { uri: `${ROOT}/memories/preferences/self/回答结构.md` });
  assert.match(done.messages[0].result.content[0].text, /^Deleted: /);
  assert.deepEqual(forgotten, [`${ROOT}/memories/preferences/self/回答结构.md`], "a forget goes through the memory page's own deletion");
});

test("remember passes the same door as a captured message and its commit enters the ledger", async (t) => {
  const recorded = [];
  const overlay = { configured: true, account: async () => ({ registeredAt: "x" }), noteRegistered: async () => {}, recordCommit: async (commit) => { recorded.push(commit); }, sensitiveUris: async () => [] };
  const { stub, mcp } = await fixture(t, { overlay });
  const answer = await mcp({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "remember", arguments: { messages: [
    { role: "user", content: "记住：图纸尺寸单位一律用毫米，联系电话 13900139000。" },
    { role: "user", content: "<evimed-brief>平台简报</evimed-brief>" },
  ] } } });
  assert.match(answer.messages[0].result.content[0].text, /Submitted 1 message/);
  assert.deepEqual(stub.sent("POST", "/mcp").at(-1).body.params.arguments.messages, [{ role: "user", content: "记住：图纸尺寸单位一律用毫米，联系电话 [已省略]。" }]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].origin, "tool");
  assert.match(recorded[0].archiveUri, new RegExp(`^${ROOT}/sessions/mcp-store-[0-9]+/history/archive_001$`));
  const nothing = await mcp({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "remember", arguments: { messages: [{ role: "user", content: "<evimed-brief>x</evimed-brief>" }] } } });
  assert.match(nothing.messages[0].result.content[0].text, /没有可以记下/);
});

test("an engine that hangs or is down is a 5xx at once, never a wait", async (t) => {
  const { stub, call, failures } = await fixture(t, { timeoutMs: 600 });
  stub.delayMs = 5_000;
  const started = Date.now();
  const hung = await call("POST", "/api/v1/sessions", { session_id: SESSION });
  const waited = Date.now() - started;
  assert.equal(hung.status, 503);
  assert.equal(hung.json.error.code, "memory_gateway_upstream_unavailable");
  assert.ok(waited < 1_500, `answered after ${waited} ms with a 200 ms session-start deadline`);
  stub.delayMs = 0;
  stub.failWith = 503;
  const down = await call("GET", `/api/v1/sessions/${SESSION}`);
  assert.equal(down.status, 503);
  assert.ok(failures.some((failure) => failure.code === "memory_index_timeout"));
  const counters = nativeMemoryCounters().upstreamFailures;
  assert.ok(counters.timeout >= 1 && counters.unavailable >= 1);
});

test("requests and bodies are bounded, and the bound is counted", async (t) => {
  const { call } = await fixture(t, { config: { memoryGatewayRatePerMinute: 3, memoryGatewayMaxBodyBytes: 2_048 } });
  const large = await call("POST", `/api/v1/sessions/${SESSION}/messages`, { role: "user", content: "长".repeat(4_000) });
  assert.equal(large.status, 413);
  assert.equal(large.json.error.code, "memory_gateway_payload_too_large");
  await call("GET", "/api/v1/system/status");
  await call("GET", "/api/v1/system/status");
  const limited = await call("GET", "/api/v1/system/status");
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, "memory_gateway_rate_limited");
  const counters = nativeMemoryCounters().refusals;
  assert.deepEqual([counters.memory_gateway_payload_too_large, counters.memory_gateway_rate_limited], [1, 1]);
});

test("with the native engine off in the deployment the gateway is not there", async (t) => {
  const { stub, call } = await fixture(t, { config: { ovNativeMemoryEnabled: false } });
  const off = await call("GET", "/health");
  assert.equal(off.status, 404);
  assert.equal(off.json.error.code, "memory_gateway_disabled");
  assert.equal(stub.requests.length, 0);
});

// ------------------------------------------------------------------ admission

/** A research-memory double with the switches the admission reads. */
function memoryDouble({ engine = "native", settings = {}, trial = null } = {}) {
  return {
    configured: true,
    memoryEngine: async () => engine,
    settings: async () => ({ learningPaused: false, recallPaused: false, pausedProjects: [], ...settings }),
    sessionState: async (_user, _project, sessionId) => ({ trialCapsuleId: sessionId === trial ? "capsule-x" : null }),
  };
}

test("admission: a captured message belongs to the turn it was spoken in, then to the turn in progress", async () => {
  const sid = "session_0123456789abcdef0123456789abcdef";
  const at = (hour, minute = 0) => Date.parse(`2026-10-14T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
  const iso = (hour) => new Date(at(hour)).toISOString();
  const admit = (runs, when) => createMemoryAdmission({ config: { memoryEnabled: true }, researchMemory: memoryDouble(),
    conversations: { running: async () => runs.filter((run) => run.status === "running"), runsOf: async () => runs } })
    .admit({ user: { id: USER }, project: { id: "p1", userId: USER }, engineSessionId: `dsh-${sid}`, at: when });
  const ledger = [
    { id: "r3", sessionId: sid, status: "running", startedAt: iso(12) },
    { id: "r2", sessionId: sid, status: "succeeded", effectiveRouteReason: "autopilot:routine", startedAt: iso(8), finishedAt: iso(9) },
  ];
  assert.equal((await admit(ledger, at(8, 30))).learnReason, "automated_run", "spoken during the scheduled execution");
  assert.equal((await admit(ledger, at(12, 30))).learn, true, "spoken during the person's turn");
  assert.equal((await admit(ledger, at(10))).learn, true, "spoken between turns: the turn in progress decides");
  assert.equal((await admit(ledger, null)).learn, true, "no time: the turn in progress decides");
  // A message with no turn in progress and no time is the last turn's, as before.
  const idle = [{ ...ledger[1] }];
  assert.equal((await admit(idle, null)).learnReason, "automated_run");
  assert.equal((await admit(idle, at(13))).learnReason, "automated_run", "after every recorded turn: the last one");
  // Two turns at once: the platform's wins, and the person's message is withheld rather than the dispatch learned.
  const both = [{ id: "r4", sessionId: sid, status: "running", startedAt: iso(8) }, { id: "r5", sessionId: sid, status: "running", effectiveRouteReason: "autopilot:routine", startedAt: iso(8) }];
  assert.equal((await admit(both, at(9))).learnReason, "automated_run");
});

test("a scheduled execution's instruction never reaches the engine as the person's message: first, later, replayed, or beside the person's own turn", async (t) => {
  // The wiring as it is: the real admission over a ledger of one reused task conversation, the real gateway, a stub engine that
  // records what reached it. The unmodified plugin posts each message as the kernel emits it and posts again what it could not
  // post (restart, dropped connection), so a dispatch can arrive while another turn is in progress.
  const sid = "session_0123456789abcdef0123456789abcdef";
  const INSTRUCTION = "每天早上检索新文献，按研究类型整理成简报，每次先列出新增数量。";
  const at = (hour) => `2026-10-14T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const ledger = [
    { id: "run_3", sessionId: sid, status: "running", effectiveRouteReason: "adopted:runtime-ui", kernelRequestIds: ["req_person"], startedAt: at(12) },
    { id: "run_2", sessionId: sid, status: "succeeded", effectiveRouteReason: "autopilot:routine", kernelRequestIds: ["req_2"], startedAt: at(8), finishedAt: at(9) },
    { id: "run_1", sessionId: sid, status: "succeeded", effectiveRouteReason: "autopilot:routine", kernelRequestIds: ["req_1"], startedAt: at(1), finishedAt: at(2) },
  ];
  const admission = createMemoryAdmission({
    config: { memoryEnabled: true }, researchMemory: memoryDouble(),
    conversations: { running: async () => ledger.filter((run) => run.status === "running"), runsOf: async (_project, id) => ledger.filter((run) => run.sessionId === id) },
  });
  const { stub, call } = await fixture(t, { admission });
  const engineSession = `dsh-${sid}`;
  await call("POST", "/api/v1/sessions", { session_id: engineSession });
  const post = (body) => call("POST", `/api/v1/sessions/${engineSession}/messages`, body);
  const reached = () => stub.sent("POST", `/api/v1/sessions/${engineSession}/messages`).map((request) => request.body.parts[0].text);

  // The person's turn is in progress. The first execution's instruction, posted again late with the time it was spoken, and the
  // second's, are the platform's: the engine hears neither.
  assert.equal((await post({ role: "user", content: INSTRUCTION, created_at: at(1) })).status, 200);
  assert.equal((await post({ role: "user", content: INSTRUCTION, created_at: at(8) })).status, 200);
  assert.deepEqual(reached(), []);
  // The assistant's answer to an execution is that turn's too.
  await post({ role: "assistant", content: "今天新增 9 篇，其中 RCT 1 篇。", created_at: at(8) });
  assert.deepEqual(reached(), []);
  // What the person says in their own turn is theirs.
  await post({ role: "user", content: "以后简报里的文献一律按发表日期倒序。", created_at: at(12) });
  assert.deepEqual(reached(), ["以后简报里的文献一律按发表日期倒序。"]);
  // The engine's session then holds the person's words and nothing the control plane sent: a commit archives exactly that.
  const committed = await call("POST", `/api/v1/sessions/${engineSession}/commit`, { keep_recent_count: 0, wait: true });
  assert.equal(committed.json.result.status, "accepted");
  assert.ok(!stub.sent("POST", `/api/v1/sessions/${engineSession}/messages`).some((request) => JSON.stringify(request.body).includes("每天早上")));

  // During an execution, the dispatch and the answer are withheld whether or not the message says when it was spoken.
  ledger.splice(0, 1, { id: "run_4", sessionId: sid, status: "running", effectiveRouteReason: "autopilot:routine", kernelRequestIds: ["req_4"], startedAt: at(20) });
  await post({ role: "user", content: INSTRUCTION });
  await post({ role: "user", content: INSTRUCTION, created_at: at(20) });
  await post({ role: "assistant", content: "今天新增 5 篇。", created_at: at(20) });
  assert.deepEqual(reached(), ["以后简报里的文献一律按发表日期倒序。"]);
  assert.equal(nativeMemoryCounters().messages.forwarded, 1);
});

test("admission: who is learned from and who is read for, by reason", async () => {
  const user = { id: USER };
  const project = { id: "p1", userId: USER };
  const sid = "session_0123456789abcdef0123456789abcdef";
  const engineSessionId = `dsh-${sid}`;
  const runs = (list) => ({ running: async () => list.filter((run) => run.status === "running"), runsOf: async (_project, id) => list.filter((run) => run.sessionId === id),
    parentOf: (id, running) => (id === "session_child" ? running[0]?.id ?? null : null) });
  const admit = (options, caller = { user, project, engineSessionId }) => createMemoryAdmission({ config: { memoryEnabled: true }, ...options }).admit(caller);

  const person = await admit({ researchMemory: memoryDouble(), conversations: runs([{ id: "r1", sessionId: sid, status: "running" }]) });
  assert.deepEqual([person.native, person.learn, person.recall, person.sessionId], [true, true, true, sid]);

  const legacy = await admit({ researchMemory: memoryDouble({ engine: "legacy" }) });
  assert.deepEqual([legacy.native, legacy.learn, legacy.recall, legacy.learnReason], [false, false, false, "legacy_engine"]);

  const internal = await admit({ researchMemory: memoryDouble() }, { user, project: { id: "evimed-learning", userId: USER }, engineSessionId });
  assert.deepEqual([internal.learn, internal.recall, internal.learnReason], [false, false, "internal_project"]);

  const paused = await admit({ researchMemory: memoryDouble({ settings: { learningPaused: true } }) });
  assert.deepEqual([paused.learn, paused.recall, paused.learnReason], [false, true, "paused"]);
  const recallPaused = await admit({ researchMemory: memoryDouble({ settings: { recallPaused: true } }) });
  assert.deepEqual([recallPaused.learn, recallPaused.recall, recallPaused.recallReason], [true, false, "paused"]);
  const projectPaused = await admit({ researchMemory: memoryDouble({ settings: { pausedProjects: ["p1"] } }) });
  assert.deepEqual([projectPaused.learn, projectPaused.recall], [false, false]);

  const trial = await admit({ researchMemory: memoryDouble({ trial: sid }) });
  assert.deepEqual([trial.learn, trial.recall, trial.learnReason], [false, false, "trial"]);

  for (const run of [{ automated: true }, { effectiveRouteReason: "autopilot:agenda-1" }, { effectiveRouteReason: "loopx-continuation" }, { effectiveRouteReason: "adopted:runtime-ui:loopx-continuation" }]) {
    const automated = await admit({ researchMemory: memoryDouble(), conversations: runs([{ id: "r1", sessionId: sid, status: "running", ...run }]) });
    assert.deepEqual([automated.learn, automated.recall, automated.learnReason], [false, true, "automated_run"], JSON.stringify(run));
    assert.equal(isPlatformStartedRun(run), true);
  }
  // The person's turn after a continuation is theirs again: the turn in progress decides, not the conversation's history.
  const after = await admit({ researchMemory: memoryDouble(), conversations: runs([
    { id: "r2", sessionId: sid, status: "running", startedAt: "2026-10-13T02:00:00Z" }, { id: "r1", sessionId: sid, status: "succeeded", automated: true, startedAt: "2026-10-13T01:00:00Z" }]) });
  assert.equal(after.learn, true);

  const internalAgent = await admit({ researchMemory: memoryDouble(), conversations: runs([{ id: "r1", sessionId: sid, status: "running", agentId: "method-distillation" }]),
    internalAgent: async (id) => id === "method-distillation" });
  assert.equal(internalAgent.learn, false);

  const clinical = await admit({ researchMemory: memoryDouble(), conversations: runs([{ id: "r1", sessionId: sid, status: "running" }]),
    clinicalContext: async (_user, _project, contexts) => contexts.some((context) => context.runId === "r1") });
  assert.deepEqual([clinical.learn, clinical.recall, clinical.learnReason], [false, true, "clinical_context"]);

  const child = await admit({ researchMemory: memoryDouble(), conversations: runs([{ id: "r1", sessionId: sid, status: "running" }]) },
    { user, project, engineSessionId: "dsh-session_child" });
  assert.deepEqual([child.learn, child.learnReason], [false, "subagent"]);

  // The engine's templates are the never-keep rules: while they cannot be confirmed nothing is sent, and reading goes on.
  const unready = await admit({ researchMemory: memoryDouble(), engineReady: () => ({ ok: false, code: "openviking_memory_templates_missing" }) });
  assert.deepEqual([unready.learn, unready.recall, unready.learnReason], [false, true, "engine_unavailable"]);
});
