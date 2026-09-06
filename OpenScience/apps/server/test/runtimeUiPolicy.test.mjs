import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect as connectSocket } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { HttpError } from "../src/security.mjs";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";
import { createRuntimeUiServer } from "../src/runtimeUiServer.mjs";
import { issueRuntimeUiFrame, renewRuntimeUiFrame } from "../src/runtimeUiFrames.mjs";
import { InMemoryStore, PostgresStore } from "../src/store.mjs";
import { RUNTIME_UI_DENIED_METHODS, RUNTIME_UI_DENIED_NAMESPACES } from "@evimed/domain";

const UI_ORIGIN = "https://science.example:8443";
const SHELL_ORIGIN = "https://science.example";

async function eventually(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.ok(predicate(), "condition did not become true within 500ms");
}

async function fixture(t, overrides = {}, muxOptions = {}, { authorizePrompt = null } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-ui-policy-"));
  const config = loadConfig({
    dataDir, devAuth: true, runtimeMode: "mock", runtimeUiProxyEnabled: true,
    runtimeUiPublicOrigin: UI_ORIGIN, publicUrl: SHELL_ORIGIN, ...overrides,
  });
  const store = new InMemoryStore(config);
  const user = await store.devUser();
  let cookie;
  const req = { headers: {}, socket: {} };
  const res = { getHeader() { return undefined; }, setHeader(_name, value) { cookie = String(value).split(";")[0]; } };
  const session = await store.createSession(user, req, res);
  const loginCookie = cookie;
  const frame = issueRuntimeUiFrame({ config, req: { headers: { cookie } }, user, session, project: await store.requireProject(user, "default") });
  cookie += `; ${frame.cookie.split(";")[0]}`;
  const received = [];
  const handshakes = [];
  const peers = new Set();
  const upstream = createServer();
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (peer, request) => {
    peers.add(peer);
    handshakes.push(request.headers);
    peer.on("close", () => peers.delete(peer));
    peer.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      received.push(frame);
      if (frame.type === "open") peer.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: { reached: frame.endpoint } }));
      else if (frame.type === "cancel") peer.send(JSON.stringify({ type: "end", streamId: frame.streamId }));
    });
  });
  const socketPath = path.join(dataDir, "mux.sock");
  await new Promise((resolve) => upstream.listen(socketPath, resolve));
  const manager = new RuntimeManager(config);
  const proxyUpgrade = manager.proxyUpgrade.bind(manager);
  manager.proxyUpgrade = (req, socket, head, project, suffix, policy) =>
    proxyUpgrade(req, socket, head, project, suffix, { ...policy, ...muxOptions });
  const started = [];
  manager.start = async (project) => {
    started.push(project.id);
    return { url: "http://kernel.local", socketPath, cookie: "kernel_auth=internal-only" };
  };
  manager.proxy = async (_req, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  };
  const ui = createRuntimeUiServer({ config, store, runtimeManager: manager, authorizePrompt });
  const address = await ui.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${address.port}`;
  const base = `${origin}${frame.prefix.slice(0, -1)}`;
  const clients = new Set();
  function connect(headers = {}, suffix = "/api/remote.mux", options = {}) {
    const target = suffix.startsWith("/__evimed/") ? `${origin}${suffix}` : `${base}${suffix}`;
    const ws = new WebSocket(target.replace("http", "ws"), {
      ...options,
      headers: { Cookie: cookie, Origin: UI_ORIGIN, ...headers },
    });
    clients.add(ws);
    const messages = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (waiters.length) waiters.shift()(frame);
      else messages.push(frame);
    });
    ws.on("error", () => {});
    return {
      ws,
      opened: new Promise((resolve, reject) => {
        ws.once("open", () => resolve(101));
        ws.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); ws.terminate(); });
        ws.once("error", reject);
      }),
      next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiters.push(resolve)),
      send: (frame) => ws.send(JSON.stringify(frame)),
    };
  }
  t.after(async () => {
    for (const client of clients) client.terminate();
    for (const peer of peers) peer.terminate();
    await ui.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { config, store, user, session, cookie, loginCookie, frame, origin, received, peers, handshakes, connect, base, dataDir, started, ui, manager, upstream };
}

const open = (streamId, endpoint, args = {}) => ({ type: "open", streamId, endpoint, payload: { args } });

test("native HTTP prompts check the bound session before forwarding while source history stays readable", async t => {
  const checked = [];
  const f = await fixture(t, {}, {}, { authorizePrompt: async (project, sessionId) => {
    checked.push({ userId: project.userId, projectId: project.id, sessionId });
    if (sessionId === "source-private") throw new HttpError(403, "agent_background_only", "Use Sources to adjust or retry this source.");
  } });
  const forwarded = [];
  f.manager.proxy = async (req, res) => { forwarded.push(req.__openScienceProxyBody?.toString("utf8") ?? "read"); res.writeHead(200); res.end("{}"); };
  const request = sessionId => JSON.stringify({ type: "client-request", rpcId: `rpc-${sessionId}`, method: "session/prompt",
    payload: { args: { request: { requestId: `req-${sessionId}`, sessionId, mode: "queue", content: [{ type: "text", text: "An ordinary follow-up" }] } } } });
  const send = body => fetch(`${f.base}/api/session/prompt`, { method: "POST",
    headers: { cookie: f.cookie, origin: UI_ORIGIN, "content-type": "application/json" }, body });
  const denied = await send(request("source-private"));
  assert.equal(denied.status, 403); assert.ok((await denied.text()).includes("资料页")); assert.equal(forwarded.length, 0);
  const publicRequest = request("public-session");
  assert.equal((await send(publicRequest)).status, 200); assert.deepEqual(forwarded, [publicRequest]);
  assert.equal(checked[0].userId, f.user.id); assert.equal(checked[0].projectId, "default");
  const history = await fetch(`${f.base}/api/session/page`, { method: "POST",
    headers: { cookie: f.cookie, origin: UI_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ sessionId: "source-private" }) });
  assert.equal(history.status, 200); assert.equal(checked.length, 2);
});

test("native mux denies internal-session prompts before upstream and preserves public frames", async t => {
  const f = await fixture(t, {}, {}, { authorizePrompt: async (_project, sessionId) => {
    if (sessionId === "source-private") throw new HttpError(403, "agent_background_only", "Use Sources to adjust or retry this source.");
  } });
  const c = f.connect(); assert.equal(await c.opened, 101);
  const prompt = (id, sessionId) => open(id, "session/prompt", { request: { requestId: id, sessionId, mode: "queue", content: [{ type: "text", text: "A follow-up" }] } });
  c.send(prompt("blocked", "source-private"));
  const denied = await c.next(); assert.equal(denied.type, "error"); assert.equal(denied.error.code, "agent_background_only");
  assert.equal((await c.next()).type, "end");
  assert.equal(f.received.length, 0);
  const ordinary = prompt("ordinary", "public-session"); c.send(ordinary);
  assert.equal((await c.next()).type, "item"); assert.deepEqual(f.received, [ordinary]);
  // End the accepted prompt before sending another stream, as the native
  // admission owner waits for its explicit terminal acknowledgement.
  for (const peer of f.peers) peer.send(JSON.stringify({ type: "end", streamId: "ordinary" }));
  await c.next();
  c.send(open("history", "session/page", { request: { sessionId: "source-private" } }));
  assert.equal((await c.next()).type, "item"); assert.equal(f.received.at(-1).endpoint, "session/page");
});

test("real HTTP and mux startup cannot replace a bounded source workspace and history opens after release", async t => {
  const f = await fixture(t, { runtimeIdleTimeoutMs: 0 });
  const project = await f.store.requireProject(f.user, "default");
  const sourceProject = { ...project, workspaceDir: path.join(project.baseDir, "knowledge-base/.evimed-derived/source-job") };
  await mkdir(sourceProject.workspaceDir, { recursive: true });
  const calls = { stop: 0, spawn: 0, close: 0, http: 0 };
  const bounded = { kind: "mock", url: "http://kernel.local", socketPath: path.join(f.dataDir, "mux.sock"), cookie: "kernel_auth=fixture",
    project: sourceProject, workspaceDir: sourceProject.workspaceDir, startedAt: new Date().toISOString(), pid: null, exitedAt: null,
    modelGatewayScope: { runId: "source_reserved", dailyLimit: 20, weeklyLimit: 80, runLimit: 8 },
    close: async () => { calls.close++; } };
  // Exercise real admission/startup/proxy methods. Only the external process
  // launcher and the upstream kernel protocol are fixtures.
  f.manager.start = RuntimeManager.prototype.start.bind(f.manager);
  f.manager.proxy = RuntimeManager.prototype.proxy.bind(f.manager);
  f.manager.config.runtimeMode = "kernel";
  f.manager.startKernel = async (selected, scope) => {
    calls.spawn++;
    return { ...bounded, project: selected, workspaceDir: selected.workspaceDir, modelGatewayScope: scope,
      closedByManager: false, close: async () => {} };
  };
  const stop = f.manager.stop.bind(f.manager);
  f.manager.stop = async selected => { calls.stop++; return stop(selected); };
  f.manager.runtimes.set(f.manager.key(project), bounded);
  t.after(() => f.manager.closeAll());
  f.upstream.on("request", (_req, res) => { calls.http++; res.writeHead(200, { "content-type": "application/json" }); res.end('{"history":true}'); });

  assert.equal(await f.manager.start(sourceProject), bounded, "same-workspace read startup must reuse its runtime");
  const denied = await fetch(`${f.base}/`, { headers: { cookie: f.cookie } });
  assert.equal(denied.status, 423);
  assert.ok((await denied.text()).includes("后台任务正在进行"));
  const socketDenied = f.connect(); assert.equal(await socketDenied.opened, 423);
  assert.deepEqual(calls, { stop: 0, spawn: 0, close: 0, http: 0 });
  assert.equal(f.manager.runtimes.get(f.manager.key(project)), bounded);
  assert.equal(f.manager.boundedRuntimeScope(project).runId, "source_reserved");

  assert.equal(await f.manager.endBoundedRuntime(sourceProject, "source_reserved"), true);
  assert.equal(calls.stop, 1); assert.equal(calls.close, 1);
  const history = await fetch(`${f.base}/`, { headers: { cookie: f.cookie } });
  assert.equal(history.status, 200); assert.deepEqual(await history.json(), { history: true });
  const socket = f.connect(); assert.equal(await socket.opened, 101);
  socket.send(open("history-after-release", "session/page", { request: { sessionId: "source-session" } }));
  assert.equal((await socket.next()).type, "item");
  assert.equal(calls.spawn, 1, "the HTTP and mux readers reuse one ordinary runtime after release");
  assert.equal(calls.stop, 1);
});

// Source-derived contract: @deepseek-ai/dsh-api-gateway@0.1.2-rc.1,
// lib/client.js:105-146. Its native parser requires these exact keys and a
// record for details; a malformed error closes the shared carrier with 4002.
function assertNativeError(frame, streamId, code) {
  assert.deepEqual(Object.keys(frame).sort(), ["error", "streamId", "type"]);
  assert.equal(frame.type, "error");
  assert.equal(frame.streamId, streamId);
  assert.deepEqual(Object.keys(frame.error).sort(), ["code", "details", "message"]);
  assert.equal(frame.error.code, code);
  assert.equal(typeof frame.error.message, "string");
  assert.deepEqual(frame.error.details, {});
}

function pauseUpgradeRevalidation(t, f) {
  let resume;
  let entered;
  const paused = new Promise((resolve) => { entered = resolve; });
  const proceed = new Promise((resolve) => { resume = resolve; });
  const ensureSessionUser = f.store.ensureSessionUser.bind(f.store);
  let calls = 0;
  f.store.ensureSessionUser = async (...args) => {
    if (++calls === 2) { entered(); await proceed; }
    return ensureSessionUser(...args);
  };
  t.after(() => resume());
  return { paused, resume };
}

test("mux rejects unauthenticated, forged/expired cookies and foreign or missing Origins", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  for (const [headers, status] of [
    [{ Cookie: "" }, 401], [{ Cookie: `${f.config.sessionCookieName}=forged` }, 401],
    [{ Origin: "https://foreign.example" }, 403], [{ Origin: "null" }, 403], [{ Origin: "" }, 403],
  ]) assert.equal(await f.connect(headers).opened, status);
  f.session.expiresAt = Date.now() - 1;
  assert.equal(await f.connect().opened, 401);
  assert.equal(f.handshakes.length, 0);
});

test("HTTP mutation accepts only the exact UI or shell Origin", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  for (const origin of ["https://foreign.example", "null", "", `${UI_ORIGIN}/path`, "https://science.example:8444"]) {
    const response = await fetch(`${f.base}/api/session/create`, { method: "POST", headers: { Cookie: f.cookie, Origin: origin } });
    assert.equal(response.status, 403, origin);
  }
  for (const origin of [UI_ORIGIN, SHELL_ORIGIN]) {
    const response = await fetch(`${f.base}/api/session/create`, { method: "POST", headers: { Cookie: f.cookie, Origin: origin } });
    assert.equal(response.status, 200);
  }
});

test("mux denies forbidden logical methods per stream while allowing native read and cancel frames", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const c = f.connect({ Authorization: "Bearer browser-secret", "x-api-key": "browser-secret" });
  assert.equal(await c.opened, 101);
  const subscription = open("events", "$events");
  c.send(subscription);
  assert.equal((await c.next()).value.reached, "$events");
  c.send(open("denied", "settings/update"));
  assertNativeError(await c.next(), "denied", "runtime_ui_method_denied");
  assert.deepEqual(await c.next(), { type: "end", streamId: "denied" });
  const event = { type: "item", streamId: "events", value: { sequence: 1 } };
  [...f.peers][0].send(JSON.stringify(event));
  assert.deepEqual(await c.next(), event);
  const pong = once(c.ws, "pong");
  c.ws.ping("after-policy-error");
  assert.equal(String((await pong)[0]), "after-policy-error");
  const allowed = open("read", "session/page", { sessionId: "s1" });
  c.send(allowed);
  assert.deepEqual(await c.next(), { type: "item", streamId: "read", value: { reached: "session/page" } });
  const cancel = { type: "cancel", streamId: "read" };
  c.send(cancel);
  assert.deepEqual(await c.next(), { type: "end", streamId: "read" });
  const control = open("control", "session/cancel", { sessionId: "s1" });
  c.send(control);
  assert.equal((await c.next()).value.reached, "session/cancel");
  assert.deepEqual(f.received, [subscription, allowed, cancel, control]);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  assert.equal(f.handshakes[0].cookie, "kernel_auth=internal-only");
  assert.equal(f.handshakes[0].host, "kernel.local");
  assert.equal(f.handshakes[0].authorization, undefined);
  assert.equal(f.handshakes[0]["x-api-key"], undefined);
});

test("mux refuses spending at admission and preserves already available reads", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { userDailySpendLimit: 10 });
  await mkdir(path.join(f.dataDir, ".openscience"), { recursive: true });
  await writeFile(path.join(f.dataDir, ".openscience", "usage.jsonl"), `${JSON.stringify({
    at: new Date().toISOString(), resourceType: "model", userId: "dev", projectId: "default", cost: 40, currency: "CNY", priced: true,
  })}\n`);
  const c = f.connect();
  assert.equal(await c.opened, 101);
  c.send(open("read", "session/page"));
  assert.equal((await c.next()).type, "item");
  c.send(open("spend", "session/prompt", { sessionId: "s1", prompt: "no model may run" }));
  assertNativeError(await c.next(), "spend", "credits_daily_limit_reached");
  assert.deepEqual(await c.next(), { type: "end", streamId: "spend" });
  const page = { type: "item", streamId: "read", value: { sequence: 2 } };
  [...f.peers][0].send(JSON.stringify(page));
  assert.deepEqual(await c.next(), page);
  c.send({ type: "cancel", streamId: "read" });
  assert.deepEqual(await c.next(), { type: "end", streamId: "read" });
  assert.deepEqual(f.received.map((frame) => frame.type), ["open", "cancel"]);
  assert.equal(f.received[0].endpoint, "session/page");
  assert.equal(c.ws.readyState, WebSocket.OPEN);
});

test("a revoked session terminates both mux peers before another operation", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const c = f.connect();
  assert.equal(await c.opened, 101);
  await f.store.logout({ headers: { cookie: f.cookie } });
  const closed = once(c.ws, "close");
  c.send(open("revoked", "session/page"));
  assert.equal((await c.next()).error?.code, "unauthorized");
  assert.equal((await closed)[0], 1008);
  assert.deepEqual(f.received, []);
});

test("oversized mux messages terminate without reaching the kernel", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { maxJsonBytes: 1024 });
  const c = f.connect();
  assert.equal(await c.opened, 101);
  const closed = once(c.ws, "close");
  c.send(open("large", "session/prompt", { prompt: "x".repeat(2048) }));
  assert.equal((await closed)[0], 1009);
  assert.deepEqual(f.received, []);
});

test("mux connection quotas are held until close and then released", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { maxRuntimeProxyConnections: 1, maxRuntimeProxyConnectionsPerProject: 1 });
  const first = f.connect();
  assert.equal(await first.opened, 101);
  assert.equal(await f.connect().opened, 429);
  const closed = once(first.ws, "close");
  first.ws.close();
  await closed;
  assert.equal(await f.connect().opened, 101);
});

test("every deployment method uses the same denial policy on HTTP and mux", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const c = f.connect({ Origin: SHELL_ORIGIN });
  assert.equal(await c.opened, 101);
  const methods = [...RUNTIME_UI_DENIED_METHODS, ...RUNTIME_UI_DENIED_NAMESPACES.map((namespace) => `${namespace}/update`)];
  for (const [index, endpoint] of methods.entries()) {
    const response = await fetch(`${f.base}/api/${endpoint}`, { method: "POST", headers: { Cookie: f.cookie, Origin: UI_ORIGIN } });
    assert.equal((await response.json()).error?.code, "runtime_ui_method_denied", endpoint);
    c.send(open(String(index), endpoint));
    assert.equal((await c.next()).error?.code, "runtime_ui_method_denied", endpoint);
    assert.equal((await c.next()).type, "end");
  }
  assert.deepEqual(f.received, []);
});

test("HTTP rejects revoked and malformed session cookies without dev-session minting", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.store.logout({ headers: { cookie: f.cookie } });
  for (const cookie of [f.cookie, `${f.config.sessionCookieName}=forged`, `${f.config.sessionCookieName}=%ZZ`]) {
    const response = await fetch(`${f.base}/api/session/page`, { method: "POST", headers: { Cookie: cookie, Origin: UI_ORIGIN } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(f.store.sessions.size, 0);
});

test("strict PostgreSQL session lookup rejects missing sessions while preserving default dev auth", async () => {
  const store = Object.create(PostgresStore.prototype);
  store.config = { devAuth: true, production: false, sessionCookieName: "session" };
  store.database = { async query() { return { rowCount: 0, rows: [] }; } };
  let minted = 0;
  store.devUser = async () => ({ id: "dev" });
  store.createSession = async () => { minted++; return { userId: "dev" }; };
  const req = { headers: { cookie: "session=revoked" } };
  await assert.rejects(store.ensureSessionUser(req, null, { allowDevAuth: false }), (error) => error.code === "unauthorized");
  assert.equal(minted, 0);
  assert.equal((await store.ensureSessionUser(req, null)).user.id, "dev");
  assert.equal(minted, 1);
});

test("idle session expiration closes both peers without waiting for another browser request", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const c = f.connect();
  assert.equal(await c.opened, 101);
  const serverPeer = [...f.peers][0];
  const upstreamClosed = once(serverPeer, "close");
  const browserClosed = once(c.ws, "close");
  f.session.expiresAt = Date.now() - 1;
  assert.equal((await browserClosed)[0], 1008);
  await upstreamClosed;
  await eventually(() => f.manager.activeProxyCount() === 0);
});

test("renewing a frame keeps its existing mux alive beyond the original expiry and still honors logout", { timeout: 5000 }, async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t, { runtimeUiFrameTtlMs: 5000, sessionTtlMs: 60000 });
  const c = f.connect();
  assert.equal(await c.opened, 101);
  const other = issueRuntimeUiFrame({ config: f.config, req: { headers: { cookie: f.loginCookie } }, user: f.user, session: f.session,
    project: await f.store.requireProject(f.user, "default") });
  const unrenewed = f.connect({ Cookie: `${f.loginCookie}; ${other.cookie.split(";")[0]}` }, `${other.prefix}api/remote.mux`);
  assert.equal(await unrenewed.opened, 101);
  c.send(open("active-work", "session/follow", { request: { address: { kind: "session", sessionId: "s1" } } }));
  await c.next();
  now += 4000;
  const renewed = renewRuntimeUiFrame({ config: f.config, req: { headers: { cookie: f.loginCookie } }, user: f.user, session: f.session,
    frameId: f.frame.frameId, renewalToken: f.frame.renewalToken });
  assert.equal(f.ui.refreshFrameBinding(renewed), 1);
  now += 2000;
  c.send(open("after-old-expiry", "session/page"));
  assert.equal((await c.next()).value.reached, "session/page");
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  assert.equal(f.handshakes.length, 2, "renewal must not cancel work or replace either mux");
  assert.equal(f.received.filter((item) => item.type === "cancel").length, 0);
  const otherClosed = once(unrenewed.ws, "close");
  unrenewed.send(open("still-expired", "session/page"));
  assertNativeError(await unrenewed.next(), "still-expired", "runtime_ui_frame_expired");
  assert.equal((await otherClosed)[0], 1008, "renewing one frame must not extend a different frame");
  assert.equal((await fetch(`${f.base}/api/session/page`, { headers: { cookie: f.cookie } })).status, 401, "the expired original cookie must remain expired");
  const freshCookie = `${f.loginCookie}; ${renewed.cookie.split(";")[0]}`;
  assert.equal((await fetch(`${f.base}/api/session/page`, { headers: { cookie: freshCookie } })).status, 200);
  const closed = once(c.ws, "close");
  await f.store.logout({ headers: { cookie: f.loginCookie } });
  assert.equal((await closed)[0], 1008);
  await eventually(() => f.manager.activeProxyCount() === 0);
  assert.equal(f.ui.refreshFrameBinding(renewed), 0, "closed sockets must leave the renewal registry");
});

test("a suspended frame can reconnect with a renewed cookie while project deletion still revokes it", { timeout: 5000 }, async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t, { runtimeUiFrameTtlMs: 5000, sessionTtlMs: 60000 });
  await f.store.createProject(f.user, "resumable", "Resumable");
  const project = await f.store.requireProject(f.user, "resumable");
  const issued = issueRuntimeUiFrame({ config: f.config, req: { headers: { cookie: f.loginCookie } }, user: f.user, session: f.session, project });
  now += 6000;
  const renewed = renewRuntimeUiFrame({ config: f.config, req: { headers: { cookie: f.loginCookie } }, user: f.user, session: f.session,
    frameId: issued.frameId, renewalToken: issued.renewalToken });
  const c = f.connect({ Cookie: `${f.loginCookie}; ${renewed.cookie.split(";")[0]}` }, `${issued.prefix}api/remote.mux`);
  assert.equal(await c.opened, 101);
  const closed = once(c.ws, "close");
  await f.store.deleteProject(f.user, "resumable");
  assert.equal((await closed)[0], 1008);
  await eventually(() => f.manager.activeProxyCount() === 0);
});

test("renewal preserves an admitted unary prompt response across the old expiry without replay", { timeout: 5000 }, async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t, { runtimeUiFrameTtlMs: 5000, sessionTtlMs: 60000 });
  f.manager.proxy = RuntimeManager.prototype.proxy.bind(f.manager);
  let respond;
  let entered;
  const admitted = new Promise((resolve) => { entered = resolve; });
  const requests = [];
  f.upstream.on("request", async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(Buffer.concat(chunks).toString());
    respond = () => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"accepted":true}'); };
    entered();
  });
  const payload = JSON.stringify({ type: "client-request", rpcId: "original-prompt", method: "session/prompt", payload: { args: { input: "native draft" } } });
  const response = fetch(`${f.base}/api/session/prompt`, { method: "POST", headers: { cookie: f.cookie, Origin: UI_ORIGIN, "content-type": "application/json" }, body: payload });
  await admitted;
  now += 4000;
  const renewed = renewRuntimeUiFrame({ config: f.config, req: { headers: { cookie: f.loginCookie } }, user: f.user, session: f.session,
    frameId: f.frame.frameId, renewalToken: f.frame.renewalToken });
  f.ui.refreshFrameBinding(renewed);
  now += 2000;
  respond();
  const result = await response;
  assert.equal(result.status, 200, "an accepted response must validate the renewed ticket");
  assert.deepEqual(await result.json(), { accepted: true });
  assert.deepEqual(requests, [payload]);
  await eventually(() => f.manager.activeProxyCount() === 0);
  const next = renewRuntimeUiFrame({ config: f.config, req: { headers: { cookie: f.loginCookie } }, user: f.user, session: f.session,
    frameId: f.frame.frameId, renewalToken: f.frame.renewalToken });
  assert.equal(f.ui.refreshFrameBinding(next), 0, "finished responses must leave the renewal registry");
});

test("interleaved frame assets, unary calls and reconnects retain independent project bindings", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.store.createProject(f.user, "second", "Second");
  const second = await f.store.requireProject(f.user, "second");
  const secondFrame = issueRuntimeUiFrame({ config: f.config, req: { headers: { cookie: f.loginCookie } }, user: f.user, session: f.session, project: second });
  const secondCookie = `${f.loginCookie}; ${secondFrame.cookie.split(";")[0]}`;
  const routed = [];
  f.manager.proxy = async (_req, res, project, suffix) => { routed.push([project.id, suffix]); res.end("ok"); };
  const first = f.connect();
  const other = f.connect({ Cookie: secondCookie }, `${secondFrame.prefix}api/remote.mux`);
  assert.equal(await first.opened, 101);
  assert.equal(await other.opened, 101);
  for (const [base, cookie, suffix] of [
    [f.base, f.cookie, "/assets/a.js"],
    [`${f.origin}${secondFrame.prefix.slice(0, -1)}`, secondCookie, "/plugins/??app&rev=b"],
    [f.base, f.cookie, "/api/session/page"],
    [`${f.origin}${secondFrame.prefix.slice(0, -1)}`, secondCookie, "/api/session/page"],
  ]) assert.equal((await fetch(`${base}${suffix}`, { headers: { cookie } })).status, 200);
  assert.deepEqual(routed, [["default", "/assets/a.js"], ["second", "/plugins/??app&rev=b"], ["default", "/api/session/page"], ["second", "/api/session/page"]]);
  const closed = once(first.ws, "close");
  first.ws.close(); await closed;
  assert.equal(await f.connect().opened, 101);
  assert.deepEqual(f.started, ["default", "second", "default"]);
  const mismatched = await fetch(`${f.base}/assets/a.js`, { headers: { cookie: secondCookie } });
  assert.equal(mismatched.status, 401);
  assert.equal(routed.length, 4);
  for (const suffix of ["/", "/?project=second", "/api/session/page", "/plugins/??app&rev=a"]) {
    assert.equal((await fetch(`${f.origin}${suffix}`, { headers: { cookie: `${f.cookie}; evimed_ui_project=second` } })).status, 401);
  }
});

test("deleting the pinned project revokes a live socket before its next operation", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.store.createProject(f.user, "second", "Second");
  const second = await f.store.requireProject(f.user, "second");
  const frame = issueRuntimeUiFrame({ config: f.config, req: { headers: { cookie: f.loginCookie } }, user: f.user, session: f.session, project: second });
  const c = f.connect({ Cookie: `${f.loginCookie}; ${frame.cookie.split(";")[0]}` }, `${frame.prefix}api/remote.mux`);
  assert.equal(await c.opened, 101);
  await f.store.deleteProject(f.user, "second");
  const closed = once(c.ws, "close");
  c.send(open("read", "session/page"));
  assert.equal((await c.next()).error?.code, "project_not_found");
  assert.equal((await closed)[0], 1008);
  assert.deepEqual(f.received, []);
});

test("fragmented native text and ping controls preserve read, host events and cancel streams", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const c = f.connect();
  assert.equal(await c.opened, 101);
  const text = JSON.stringify(open("read", "session/page"));
  const pong = once(c.ws, "pong");
  c.ws.send(text.slice(0, 20), { fin: false });
  c.ws.ping("still-alive");
  c.ws.send(text.slice(20), { fin: true });
  assert.equal((await c.next()).type, "item");
  assert.equal(String((await pong)[0]), "still-alive");
  const upstream = [...f.peers][0];
  const upstreamPong = once(upstream, "pong");
  upstream.ping("kernel-heartbeat");
  assert.equal(String((await upstreamPong)[0]), "kernel-heartbeat");
  c.send(open("events", "$events"));
  assert.equal((await c.next()).value.reached, "$events");
  c.send({ type: "cancel", streamId: "events" });
  assert.equal((await c.next()).type, "end");
});

test("invalid endpoints receive isolated named errors and unknown upgrade paths are refused", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  assert.equal(await f.connect({}, "/api/settings/update").opened, 403);
  const c = f.connect();
  assert.equal(await c.opened, 101);
  for (const endpoint of ["settings/update/", "/session/prompt", "session/%70rompt"]) {
    c.send(open("bad", endpoint));
    assert.equal((await c.next()).error?.code, "runtime_ui_endpoint_invalid");
    assert.equal((await c.next()).type, "end");
  }
  c.send(open("read", "session/page"));
  assert.equal((await c.next()).type, "item");
});

test("active streams are bounded without disrupting a previously accepted read", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const c = f.connect();
  assert.equal(await c.opened, 101);
  for (let index = 0; index < 256; index++) {
    c.send(open(String(index), "session/page"));
    assert.equal((await c.next()).type, "item");
  }
  c.send(open("overflow", "session/page"));
  assert.equal((await c.next()).error?.code, "runtime_ui_stream_limit");
  assert.equal((await c.next()).type, "end");
  c.send({ type: "cancel", streamId: "0" });
  assert.equal((await c.next()).type, "end");
  c.send(open("replacement", "session/page"));
  assert.equal((await c.next()).type, "item");
});

test("closing either peer closes the other and releases its proxy capacity", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const c = f.connect();
  assert.equal(await c.opened, 101);
  const peerClosed = once([...f.peers][0], "close");
  c.ws.terminate();
  await peerClosed;
  await eventually(() => f.manager.activeProxyCount() === 0);
  const next = f.connect();
  assert.equal(await next.opened, 101);
  const clientClosed = once(next.ws, "close");
  [...f.peers][0].close();
  await clientClosed;
  await eventually(() => f.manager.activeProxyCount() === 0);
});

test("browser heartbeat releases capacity for a missing pong despite active upstream pings", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { maxRuntimeProxyConnections: 1, maxRuntimeProxyConnectionsPerProject: 1 }, {
    heartbeat: { intervalMs: 50, timeoutMs: 70 },
  });
  const c = f.connect({}, "/api/remote.mux", { autoPong: false });
  assert.equal(await c.opened, 101);
  const upstream = [...f.peers][0];
  let browserPings = 0;
  let upstreamPongs = 0;
  c.ws.on("ping", () => { browserPings++; });
  upstream.on("pong", () => { upstreamPongs++; });
  const upstreamPingTimer = setInterval(() => {
    if (upstream.readyState === WebSocket.OPEN) upstream.ping("kernel-is-alive");
  }, 10);
  t.after(() => clearInterval(upstreamPingTimer));
  const clientClosed = once(c.ws, "close");
  const upstreamClosed = once(upstream, "close");
  await eventually(() => c.ws.readyState === WebSocket.CLOSED);
  const [code, reason] = await clientClosed;
  assert.equal(code, 1001);
  assert.equal(String(reason), "runtime_ui_heartbeat_timeout");
  await upstreamClosed;
  assert.ok(browserPings > 0, "the proxy must probe the browser independently");
  assert.ok(upstreamPongs > 1, "upstream auto-pongs cannot establish browser liveness");
  await eventually(() => f.peers.size === 0 && f.manager.activeProxyCount() === 0);
  const replacement = f.connect();
  assert.equal(await replacement.opened, 101);
  replacement.send(open("read", "session/page"));
  assert.equal((await replacement.next()).value.reached, "session/page");
});

test("browser heartbeat preserves a healthy mux through repeated pong deadlines", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, {}, { heartbeat: { intervalMs: 50, timeoutMs: 70 } });
  const c = f.connect();
  assert.equal(await c.opened, 101);
  let pings = 0;
  c.ws.on("ping", () => { pings++; });
  await eventually(() => pings >= 4);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  assert.equal(f.manager.activeProxyCount(), 1);
  c.send(open("read", "session/page"));
  assert.equal((await c.next()).value.reached, "session/page");
  const closed = once(c.ws, "close");
  c.ws.close();
  await closed;
  await eventually(() => f.peers.size === 0 && f.manager.activeProxyCount() === 0);
});

test("slow browser delivery resumes without losing or reordering native frames", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { maxJsonBytes: 256 * 1024 });
  const c = f.connect();
  assert.equal(await c.opened, 101);
  c.send(open("read", "session/page"));
  await c.next();
  c.ws.pause();
  const upstream = [...f.peers][0];
  for (let index = 0; index < 40; index++) {
    upstream.send(JSON.stringify({ type: "item", streamId: "read", value: { index, text: "x".repeat(128 * 1024) } }));
  }
  c.ws.resume();
  for (let index = 0; index < 40; index++) assert.equal((await c.next()).value.index, index);
});

test("malformed browser messages and duplicate IDs cannot alias existing streams", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  for (const data of [Buffer.from("binary"), "not json", JSON.stringify({ type: "other", streamId: "x" }), JSON.stringify(open(2, "session/page"))]) {
    const c = f.connect();
    assert.equal(await c.opened, 101);
    const closed = once(c.ws, "close");
    c.ws.send(data);
    assert.equal((await closed)[0], 1008);
  }
  const c = f.connect();
  assert.equal(await c.opened, 101);
  c.send(open("same", "session/page"));
  await c.next();
  const closed = once(c.ws, "close");
  c.send(open("same", "session/prompt"));
  assert.equal((await closed)[0], 1008);
  assert.deepEqual(f.received.map((frame) => frame.endpoint), ["session/page"]);
});

test("malformed upstream messages close the connection instead of reaching the browser", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  for (const [data, code] of [[Buffer.from("binary"), 1003], ["not json", 1008]]) {
    const c = f.connect();
    assert.equal(await c.opened, 101);
    const upstream = [...f.peers].at(-1);
    const closed = once(c.ws, "close");
    upstream.send(data);
    assert.equal((await closed)[0], code);
  }
});

test("a burst cannot grow the asynchronous authorization queue without a bound", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { maxJsonBytes: 1024 });
  const c = f.connect();
  assert.equal(await c.opened, 101);
  const closed = once(c.ws, "close");
  for (let index = 0; index < 300; index++) c.send(open(String(index), "session/page", { text: "x".repeat(700) }));
  assert.equal((await closed)[0], 1009);
});

test("expired auth during runtime startup never completes the browser upgrade", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const start = f.manager.start.bind(f.manager);
  f.manager.start = async (project) => {
    const runtime = await start(project);
    f.session.expiresAt = Date.now() - 1;
    return runtime;
  };
  assert.equal(await f.connect().opened, 401);
  await eventually(() => f.peers.size === 0 && f.manager.activeProxyCount() === 0);
});

test("upstream handshake refusal releases capacity and returns a named HTTP error", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  f.upstream.removeAllListeners("upgrade");
  f.upstream.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
  assert.equal(await f.connect().opened, 502);
  await eventually(() => f.manager.activeProxyCount() === 0);
});

test("upstream close during revalidation cannot complete a late browser upgrade or retain capacity", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { maxRuntimeProxyConnections: 1, maxRuntimeProxyConnectionsPerProject: 1 });
  const gate = pauseUpgradeRevalidation(t, f);
  const c = f.connect();
  await gate.paused;
  assert.equal(c.ws.readyState, WebSocket.CONNECTING);
  assert.equal(f.manager.activeProxyCount(), 1);
  const upstream = [...f.peers][0];
  const closed = once(upstream, "close");
  upstream.close();
  await closed;
  // Outlast shutdown's forced-close timer while no browser WebSocket exists.
  await delay(1100);
  gate.resume();
  assert.equal(await c.opened, 502);
  await eventually(() => f.peers.size === 0 && f.manager.activeProxyCount() === 0);
  assert.equal(await f.connect().opened, 101);
});

test("raw client close during revalidation cannot upgrade or retain proxy capacity", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { maxRuntimeProxyConnections: 1, maxRuntimeProxyConnectionsPerProject: 1 });
  const gate = pauseUpgradeRevalidation(t, f);
  const client = connectSocket({ host: "127.0.0.1", port: Number(new URL(f.base).port) });
  t.after(() => client.destroy());
  let response = "";
  client.on("data", (data) => { response += data.toString(); });
  await once(client, "connect");
  client.write(`GET ${f.frame.prefix}api/remote.mux HTTP/1.1\r\nHost: ${new URL(f.base).host}\r\n`
    + `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n`
    + `Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\nCookie: ${f.cookie}\r\nOrigin: ${UI_ORIGIN}\r\n\r\n`);
  await gate.paused;
  assert.equal(f.manager.activeProxyCount(), 1);
  const closed = once(client, "close");
  client.destroy();
  await closed;
  gate.resume();
  await eventually(() => f.peers.size === 0 && f.manager.activeProxyCount() === 0);
  assert.doesNotMatch(response, /^HTTP\/1\.1 101/m);
  assert.equal(await f.connect().opened, 101);
});

test("server shutdown terminates active mux sockets without holding close open", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const c = f.connect();
  assert.equal(await c.opened, 101);
  const closed = once(c.ws, "close");
  await f.ui.close();
  await closed;
  await eventually(() => f.peers.size === 0 && f.manager.activeProxyCount() === 0);
});

test("encoded or malformed native API paths cannot bypass the HTTP method and spend policy", async (t) => {
  const f = await fixture(t);
  let reached = 0;
  f.manager.proxy = async (_req, res) => { reached++; res.end("bad"); };
  for (const suffix of ["/api/session/%70rompt", "/a%70i/session/prompt", "/api/settings/%75pdate", "/api/session/prompt/extra", "/api//session/prompt", "/api/session/prompt/"]) {
    const response = await fetch(`${f.base}${suffix}`, { method: "POST", headers: { cookie: f.cookie, Origin: UI_ORIGIN } });
    assert.equal(response.status, 400, suffix);
  }
  assert.equal(reached, 0);
});

test("the exact native host-event result endpoint remains available for user-question replies", async (t) => {
  const f = await fixture(t);
  const reached = [];
  f.manager.proxy = async (_req, res, project, suffix) => { reached.push([project.id, suffix]); res.end("ok"); };
  for (const [suffix, status] of [["/api/$events/result", 200], ["/api/%24events/result", 400], ["/api/$events/other", 400]]) {
    const response = await fetch(`${f.base}${suffix}`, { method: "POST", headers: { cookie: f.cookie, Origin: UI_ORIGIN } });
    assert.equal(response.status, status);
  }
  assert.deepEqual(reached, [["default", "/api/$events/result"]]);
});

test("the relay rejects non-native request keys before they reach a live kernel stream", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    { type: "cancel", streamId: "read", payload: {} },
    { ...open("other", "session/page"), extra: true },
    { type: "open", streamId: "other", endpoint: "session/page" },
    { ...open("other", "session/page"), endpoint: null },
    { ...open("other", "session/page"), endpoint: "" },
  ]) {
    const c = f.connect();
    assert.equal(await c.opened, 101);
    c.send(open("read", "session/page"));
    assert.equal((await c.next()).value.reached, "session/page");
    const before = f.received.length;
    const closed = once(c.ws, "close");
    c.send(invalid);
    assert.equal((await closed)[0], 1008);
    assert.equal(f.received.length, before, "malformed frame must not mutate the existing stream");
  }
});

test("the relay rejects malformed upstream native frames instead of forwarding corrupted errors", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    { type: "error", streamId: "read", error: { code: "bad", message: "bad", details: [] } },
    { type: "error", streamId: "read", error: { code: "bad", message: "bad", details: {}, extra: true } },
    { type: "end", streamId: "read", extra: true },
    { type: "item", streamId: "read", value: 1, extra: true },
    { type: "item", streamId: "" },
    { type: "other", streamId: "read" },
  ]) {
    const c = f.connect();
    assert.equal(await c.opened, 101);
    c.send(open("read", "session/page"));
    await c.next();
    const received = [];
    c.ws.on("message", raw => received.push(raw.toString()));
    const closed = once(c.ws, "close");
    [...f.peers].at(-1).send(JSON.stringify(invalid));
    assert.equal((await closed)[0], 1008);
    assert.deepEqual(received, []);
  }
});

test("native workspace registration is limited to the bound project's exact runtime directory", async (t) => {
  const f = await fixture(t);
  f.manager.runtimeWorkspaceRoot = () => "/workspace";
  const request = { type: "client-request", rpcId: "workspace-bind", method: "workspace/create", payload: { args: { request: { path: "/workspace" } } } };
  const post = body => fetch(`${f.base}/api/workspace/create`, { method: "POST", headers: { cookie: f.cookie, Origin: UI_ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post(request)).status, 200);
  for (const change of [{ path: "/other" }, { path: "/workspace", extra: true }, { path: "/workspace/../other" }]) {
    assert.equal((await post({ ...request, payload: { args: { request: change } } })).status, 403);
  }
  assert.equal((await post({ ...request, method: "workspace/delete" })).status, 403);
  const c = f.connect(); assert.equal(await c.opened, 101);
  c.send(open("workspace", "workspace/create", { request: { path: "/workspace" } }));
  assertNativeError(await c.next(), "workspace", "runtime_ui_method_denied");
});

test("bound workspace registration is rechecked when runtime startup changes its directory", async (t) => {
  const f = await fixture(t);
  f.manager.runtimeWorkspaceRoot = () => "/workspace";
  let reached = false;
  f.manager.proxy = async (_req, _res, _project, _suffix, policy) => {
    f.manager.runtimeWorkspaceRoot = () => "/different-workspace";
    await policy.revalidate(); reached = true;
  };
  const response = await fetch(`${f.base}/api/workspace/create`, { method: "POST", headers: { cookie: f.cookie, Origin: UI_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "workspace-bind", method: "workspace/create", payload: { args: { request: { path: "/workspace" } } } }) });
  assert.equal(response.status, 403); assert.equal(reached, false);
});

test("plugin apply admission covers native HTTP prompt forwarding and refuses a concurrent apply", async t => {
  const f = await fixture(t);
  let applying = true;
  let admissions = 0;
  f.manager.pluginService = {
    withAdmission: async (_project, operation) => {
      admissions++;
      if (applying) throw new HttpError(423, "plugin_apply_in_progress", "Applying plugin settings.");
      return operation();
    },
  };
  const request = () => fetch(`${f.base}/api/session/prompt`, { method: "POST", headers: { cookie: f.cookie, origin: UI_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "prompt", method: "session/prompt", payload: { args: { request: {} } } }) });
  assert.equal((await request()).status, 423);
  applying = false;
  assert.equal((await request()).status, 200);
  assert.equal(admissions, 2);
});

test("PostgreSQL plugin fence holds native mux admission through kernel ACK and retains an unknown disconnect", {
  skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, timeout: 10000,
}, async t => {
  const { ControlPlaneDatabase } = await import("../src/controlPlaneDatabase.mjs");
  const { PluginService } = await import("../src/pluginService.mjs");
  const f = await fixture(t);
  const url = new URL(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname)); assert.match(url.pathname, /evimed_test/);
  const db = new ControlPlaneDatabase({ databaseUrl: url.href, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  const project = await f.store.requireProject(f.user, "default");
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Native admission','development')", [f.user.id]);
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,'Native',1000000)", [f.user.id, project.id]);
  t.after(async () => { await db.query("DELETE FROM evimed_control.users WHERE id=$1", [f.user.id]); await db.close(); });
  const service = new PluginService(db); f.manager.pluginService = service;
  const connection = f.connect(); await connection.opened;
  connection.send(open("plugin-prompt", "session/prompt"));
  assert.equal((await connection.next()).type, "item");
  const lockKey = `plugin-project:${f.user.id}:${project.id}`;
  const claim = () => db.transaction(client => client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired", [lockKey]));
  assert.equal((await claim()).rows[0].acquired, false, "the item is not the terminal ACK");
  for (const peer of f.peers) peer.send(JSON.stringify({ type: "end", streamId: "plugin-prompt" }));
  assert.equal((await connection.next()).type, "end");
  for (let n = 0; n < 50; n++) { if ((await claim()).rows[0].acquired) break; await delay(10); }
  assert.equal((await claim()).rows[0].acquired, true);
  await db.transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey]);
    const before = f.received.length; connection.send(open("during-apply", "session/prompt"));
    assertNativeError(await connection.next(), "during-apply", "plugin_apply_in_progress");
    await connection.next(); assert.equal(f.received.length, before);
  });
  connection.send(open("unknown-prompt", "session/prompt")); await connection.next();
  connection.ws.terminate();
  for (let n = 0; n < 50; n++) { if (await service.hasPendingPrompts(project)) break; await delay(10); }
  assert.equal(await service.hasPendingPrompts(project), true);
});
