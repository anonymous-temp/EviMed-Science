import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";
import { createRuntimeUiServer } from "../src/runtimeUiServer.mjs";
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

async function fixture(t, overrides = {}) {
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
  const started = [];
  manager.start = async (project) => {
    started.push(project.id);
    return { url: "http://kernel.local", socketPath, cookie: "kernel_auth=internal-only" };
  };
  manager.proxy = async (_req, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  };
  const ui = createRuntimeUiServer({ config, store, runtimeManager: manager });
  const address = await ui.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const clients = new Set();
  function connect(headers = {}, suffix = "/api/remote.mux") {
    const ws = new WebSocket(`${base.replace("http", "ws")}${suffix}`, {
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
  return { config, store, user, session, cookie, received, peers, handshakes, connect, base, dataDir, started, ui, manager, upstream };
}

const open = (streamId, endpoint, args = {}) => ({ type: "open", streamId, endpoint, payload: { args } });

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
  c.send(open("denied", "settings/update"));
  assert.deepEqual((await c.next()).error?.code, "runtime_ui_method_denied");
  assert.deepEqual(await c.next(), { type: "end", streamId: "denied" });
  const allowed = open("read", "session/page", { sessionId: "s1" });
  c.send(allowed);
  assert.deepEqual(await c.next(), { type: "item", streamId: "read", value: { reached: "session/page" } });
  const cancel = { type: "cancel", streamId: "read" };
  c.send(cancel);
  assert.deepEqual(await c.next(), { type: "end", streamId: "read" });
  assert.deepEqual(f.received, [allowed, cancel]);
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
  c.send(open("spend", "session/prompt", { sessionId: "s1", prompt: "no model may run" }));
  assert.equal((await c.next()).error?.code, "credits_daily_limit_reached");
  assert.equal((await c.next()).type, "end");
  c.send(open("read", "session/page"));
  assert.equal((await c.next()).type, "item");
  assert.deepEqual(f.received.map((frame) => frame.endpoint), ["session/page"]);
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

test("an upgraded socket stays on its project after another frame switches the shared cookie", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.store.createProject(f.user, "second", "Second");
  const c = f.connect();
  assert.equal(await c.opened, 101);
  const validated = [];
  const requireProject = f.store.requireProject.bind(f.store);
  f.store.requireProject = async (user, id) => { validated.push(id); return requireProject(user, id); };
  const switched = await fetch(`${f.base}/?project=second`, { headers: { Cookie: f.cookie }, redirect: "manual" });
  assert.equal(switched.status, 302);
  assert.match(switched.headers.get("set-cookie"), /evimed_ui_project=second/);
  c.send(open("read", "session/page"));
  assert.equal((await c.next()).type, "item");
  assert.deepEqual(validated, ["second", "default"]);
  assert.deepEqual(f.started, ["default"]);
});

test("deleting the pinned project revokes a live socket before its next operation", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await f.store.createProject(f.user, "second", "Second");
  const c = f.connect({ Cookie: `${f.cookie}; evimed_ui_project=second` });
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
  for (const endpoint of ["settings/update/", "/session/prompt", "session/%70rompt", {}, null]) {
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
  assert.equal(f.manager.activeProxyCount(), 0);
  const next = f.connect();
  assert.equal(await next.opened, 101);
  const clientClosed = once(next.ws, "close");
  [...f.peers][0].close();
  await clientClosed;
  assert.equal(f.manager.activeProxyCount(), 0);
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

test("server shutdown terminates active mux sockets without holding close open", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const c = f.connect();
  assert.equal(await c.opened, 101);
  const closed = once(c.ws, "close");
  await f.ui.close();
  await closed;
  await eventually(() => f.peers.size === 0 && f.manager.activeProxyCount() === 0);
});
