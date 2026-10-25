// The memory gateway and the engine's session calls, as of OpenViking v0.5.2 readiness and the next round's notes (2026-10-25):
// the engine's three privacy tools are refused by name, a recall is noted without ever failing, the observations are hidden from the
// engine's own recall, a privacy placeholder is machine text, and a session's deletion takes its privacy configuration with it
// (404 from a v0.5.1.1 engine is fine). Each runs the real handler over HTTP against the stub engine.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import test from "node:test";

import { MEMORY_GATEWAY_PATH, MEMORY_GATEWAY_TOOLS, createMemoryGatewayHandler, parseEventStream } from "../src/memoryGateway.mjs";
import { nativeMemoryCounters, resetNativeMemoryMetrics } from "../src/nativeMemoryMetrics.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { openVikingUserId } from "../src/openVikingLayout.mjs";
import { OpenVikingSessions, privacySessionTarget } from "../src/openVikingSessions.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const TOKEN = "workload-token-for-tests";
const USER = "user-a";
const OV_USER = openVikingUserId(USER);
const ROOT = `viking://user/${OV_USER}`;
const SESSION = "dsh-session_0123456789abcdef0123456789abcdef";
const everything = { native: true, learn: true, recall: true, learnReason: null, recallReason: null, sessionId: null };

async function fixture(t, { overlay = null } = {}) {
  resetNativeMemoryMetrics();
  const stub = await startOpenVikingStub(t);
  const client = new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" });
  const sessions = new OpenVikingSessions(client, { timeoutMs: 4_000, fastTimeoutMs: 1_300 });
  const handler = createMemoryGatewayHandler({
    config: { memoryEngineEnabled: true, memoryEnabled: true },
    runtimeManager: { assertActiveEviMedWorkloadToken: async (token) => { if (token === TOKEN) return { userId: USER, projectId: "p1" }; throw new Error("no"); } },
    store: { userById: async (id) => (id === USER ? { id } : null), requireProject: async (_user, id) => ({ id, userId: USER }) },
    sessions, admission: { admit: async () => everything }, overlay,
  });
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}${MEMORY_GATEWAY_PATH}`;
  const call = async (method, path, body = undefined) => {
    const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, text };
  };
  const mcp = async (message) => {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(message) });
    const text = await response.text();
    const type = response.headers.get("content-type") ?? "";
    return type.includes("event-stream") ? parseEventStream(text) : [JSON.parse(text)].flat();
  };
  return { stub, call, mcp, sessions, client };
}

const overlayDouble = (extra = {}) => ({ configured: true, account: async () => ({ registeredAt: "x" }), noteRegistered: async () => {}, recordCommit: async () => {}, noteSession: async () => {}, sensitiveUris: async () => [], ...extra });

test("the engine's three privacy tools are refused by name, and tools/list names the five of this platform alone", async (t) => {
  const { stub, mcp } = await fixture(t, { overlay: overlayDouble() });
  for (const name of ["privacy_tree", "privacy_resolve", "privacy_upsert"]) {
    const [answer] = await mcp({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: { session_id: SESSION } } });
    assert.equal(answer.error.code, -32601, name);
    assert.match(answer.error.message, /Tool not available/);
  }
  assert.equal(nativeMemoryCounters().refusals.memory_gateway_tool_refused, 3);
  assert.equal(stub.sent("POST", "/mcp").length, 0, "none of them reached the engine: privacy_resolve would have answered with plaintext credentials");
  const [listed] = await mcp({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), Object.keys(MEMORY_GATEWAY_TOOLS).sort());
  assert.equal(listed.result.tools.some((tool) => /^privacy_/.test(tool.name)), false);
  // The same name inside a batch next to a permitted call is refused alone.
  const batch = await mcp([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "privacy_resolve", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list", arguments: { uri: `${ROOT}/memories` } } },
  ]);
  assert.equal(batch.find((message) => message.id === 1).error.code, -32601);
  assert.ok(batch.find((message) => message.id === 2).result);
});

test("a recall notes the memory files it returned, through a search, a read and the plugin's own read, and never waits on it", async (t) => {
  const noted = [];
  const { stub, call, mcp } = await fixture(t, { overlay: overlayDouble({ noteRecalled: async (userId, uris) => { noted.push([userId, [...uris].sort()]); } }) });
  const profile = stub.seedMemory(OV_USER, "profile.md", "# 用户\n- 结构工程师", { type: "profile" });
  const preference = stub.seedMemory(OV_USER, "preferences/self/回答结构.md", "- 先给结论。", { type: "preferences" });
  stub.seedMemory(OV_USER, "evimed/user/preference/rec1.md", "derived index, not a memory");
  await call("GET", `/api/v1/content/read?uri=${encodeURIComponent(profile)}`);
  await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { uris: [preference, `${ROOT}/memories/evimed/user/preference/rec1.md`] } } });
  await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query: "结构" } } });
  await call("POST", "/api/v1/search/search", { query: "结构" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(noted.length >= 3, `${noted.length} notes`);
  assert.ok(noted.every(([userId]) => userId === USER));
  const files = new Set(noted.flatMap(([, uris]) => uris));
  assert.ok(files.has(profile) && files.has(preference), "the files a read and a search returned");
  assert.equal([...files].some((uri) => uri.includes("/evimed/")), false, "the derived index is no memory file and is never noted");
  assert.ok(nativeMemoryCounters().recallNotes.noted >= 3);
});

test("a recall whose note cannot be written is the same recall, and the failure is counted", async (t) => {
  const { stub, call, mcp } = await fixture(t, { overlay: overlayDouble({ noteRecalled: async () => { throw new Error("database unavailable"); } }) });
  const profile = stub.seedMemory(OV_USER, "profile.md", "# 用户\n- 结构工程师", { type: "profile" });
  const read = await call("GET", `/api/v1/content/read?uri=${encodeURIComponent(profile)}`);
  assert.equal(read.status, 200);
  assert.equal(read.json.result, "# 用户\n- 结构工程师");
  const [tool] = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { uris: [profile] } } });
  assert.ok(tool.result, "the tool answered");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(nativeMemoryCounters().recallNotes.failed >= 2);
  // An overlay that is not there, or does not have the method (a double), is no reason either.
  const bare = await fixture(t, { overlay: null });
  bare.stub.seedMemory(OV_USER, "profile.md", "# 用户\n- x", { type: "profile" });
  assert.equal((await bare.call("GET", `/api/v1/content/read?uri=${encodeURIComponent(`${ROOT}/memories/profile.md`)}`)).status, 200);
});

test("the observations are the control plane's notes: the engine's own recall is told to leave them out and no tool can read or list them", async (t) => {
  const { stub, call, mcp } = await fixture(t, { overlay: overlayDouble() });
  const note = stub.seedMemory(OV_USER, "observations/预算类表格-透视表.md", "- 预算类表格：带透视表（月度汇总时）", { type: "observations" });
  stub.seedMemory(OV_USER, "preferences/self/回答结构.md", "- 先给结论。", { type: "preferences" });
  await call("POST", "/api/v1/search/search", { query: "透视表", mode: "context" });
  const sent = stub.sent("POST", "/api/v1/search/search").at(-1).body;
  assert.ok(sent.exclude_uris.includes(`${ROOT}/memories/observations`), "the engine's recall leaves the directory out");
  assert.equal((await call("GET", `/api/v1/content/read?uri=${encodeURIComponent(note)}`)).status, 404, "it is not a memory file, so it reads as not there");
  const listed = await call("GET", `/api/v1/fs/ls?uri=${encodeURIComponent(`${ROOT}/memories`)}&output=agent&recursive=true`);
  assert.equal(listed.json.result.some((entry) => String(entry.uri).includes("/observations/")), false);
  const [read] = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { uris: [note] } } });
  assert.match(read.result.content[0].text, /没有可读取的记忆文件/);
  const searched = await call("POST", "/api/v1/search/search", { query: "透视表" });
  assert.equal(JSON.stringify(searched.json).includes("observations"), false);
});

test("a message carrying an OpenViking privacy placeholder is machine text: accepted and not forwarded", async (t) => {
  const { stub, call } = await fixture(t, { overlay: overlayDouble() });
  await call("POST", "/api/v1/sessions", { session_id: SESSION });
  const answer = await call("POST", `/api/v1/sessions/${SESSION}/messages`, { role: "user", content: "密码是 {{ov_privacy:session:dsh-abc:password}}，记一下" });
  assert.equal(answer.status, 200);
  assert.equal(stub.sent("POST", `/api/v1/sessions/${SESSION}/messages`).length, 0, "not forwarded");
  assert.equal(nativeMemoryCounters().messages.platform_context, 1);
  const own = await call("POST", `/api/v1/sessions/${SESSION}/messages`, { role: "user", content: "我是结构工程师。" });
  assert.equal(own.status, 200);
  assert.equal(stub.sent("POST", `/api/v1/sessions/${SESSION}/messages`).length, 1, "the person's own words go on");
});

// ----------------------------------------------------------------------------------------------- the privacy configuration

test("a session's deletion deletes its privacy configuration, and a v0.5.1.1 engine's 404 is fine", async (t) => {
  const { stub, sessions } = await fixture(t);
  await sessions.createSession(USER, SESSION);
  stub.privacyConfigs.add(`${OV_USER}/${SESSION}`);
  assert.equal(await sessions.deleteSession(USER, SESSION), true);
  assert.equal(stub.privacyConfigs.size, 0, "deleted with the session");
  assert.equal(stub.sent("DELETE", `/api/v1/privacy-configs/session/${SESSION}`).length, 1);
  assert.equal(nativeMemoryCounters().privacyDeletes.deleted, 1);
  // A session that is already gone still has its configuration deleted: the engine retained it.
  stub.privacyConfigs.add(`${OV_USER}/dsh-session_gone`);
  assert.equal(await sessions.deleteSession(USER, "dsh-session_gone"), false);
  assert.equal(stub.privacyConfigs.size, 0);
  // An engine with none of it (v0.5.1.1), or a session that had none, answers 404 and the deletion is complete.
  await sessions.createSession(USER, "dsh-session_plain");
  assert.equal(await sessions.deleteSession(USER, "dsh-session_plain"), true);
  assert.equal(nativeMemoryCounters().privacyDeletes.absent, 1);
});

test("a failure of the privacy deletion is counted and never fails the deletion of the session", async (t) => {
  const { stub, sessions, client } = await fixture(t);
  await sessions.createSession(USER, SESSION);
  const request = client.request.bind(client);
  client.request = async (call) => {
    if (String(call.path).startsWith("/api/v1/privacy-configs/")) throw Object.assign(new Error("engine error"), { code: "memory_index_upstream_error" });
    return request(call);
  };
  assert.equal(await sessions.deleteSession(USER, SESSION), true);
  assert.equal(nativeMemoryCounters().privacyDeletes.failed, 1);
  assert.equal(stub.sessions.has(`${OV_USER}/${SESSION}`), false, "the session itself is gone");
});

test("the target of a privacy configuration is the session id when it is an engine identifier, else an underscore and the first 24 hex of its sha-256", () => {
  assert.equal(privacySessionTarget(SESSION), SESSION);
  assert.equal(privacySessionTarget("evimed-page-0123"), "evimed-page-0123");
  const long = `dsh-${"a".repeat(150)}`;
  assert.equal(privacySessionTarget(long), `_${createHash("sha256").update(long).digest("hex").slice(0, 24)}`);
  const twoAt = "a@b@c";
  assert.match(privacySessionTarget(twoAt), /^_[a-f0-9]{24}$/);
  assert.throws(() => privacySessionTarget("../x"), /memory session id is invalid/);
});
