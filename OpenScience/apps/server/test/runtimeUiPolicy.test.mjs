import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../src/config.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";
import { createRuntimeUiServer } from "../src/runtimeUiServer.mjs";
import { InMemoryStore } from "../src/store.mjs";

const UI_ORIGIN = "https://science.example:8443";
const SHELL_ORIGIN = "https://science.example";

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
  return { config, store, session, cookie, received, peers, handshakes, connect, base, dataDir, started, ui };
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
