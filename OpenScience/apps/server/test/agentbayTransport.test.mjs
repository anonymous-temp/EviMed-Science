// The `wss` runtime transport, end to end on loopback (plan §3.1 #3): the real
// session bridge in front of a kernel, a stand-in for AgentBay's link proxy in
// front of the bridge, and the control plane's real link tunnel and dialers —
// the unary call path, the event mux and the WebSocket client the kernel UI
// proxy uses — driven through all of it.
//
// The kernel is the mock DSH runtime, which authenticates exactly as the real
// one: a browser-session cookie whose name and signature are bound to the Host
// it receives. So a call only succeeds when the bridge rewrote Host to the
// authority the kernel trusts, which is what this file proves first.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { browserSessionCookie } from "../src/dshBrowserAuth.mjs";
import { callRuntimeUnary, openRuntimeMux } from "../src/dshEventPump.mjs";
import { requestRuntime } from "../src/runtimeManager.mjs";
import * as tunnelModule from "../src/agentbay/linkTunnel.mjs";
import { startMockDshRuntime } from "../src/mockDshRuntime.mjs";
import * as bridgeModule from "../../../deploy/runtime-dsh/evimed-session-bridge.mjs";

const { createLinkTunnel, linkTarget } = tunnelModule;
const { createSessionBridge } = bridgeModule;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve(undefined)));
}

/**
 * A stand-in for AgentBay's session link proxy: `/request_ai/<token>/path/…`
 * reaches the session port with the suffix, `/websocket_ai/<token>[…]` is the
 * WebSocket endpoint and forwards whatever follows the token. `strip` models
 * a proxy that drops custom headers, which the path-prefix fallback exists for.
 */
async function linkProxy({ bridgePort, token, strip = false }) {
  const sockets = new Set();
  const clean = (headers) => Object.fromEntries(Object.entries(headers)
    .filter(([name]) => !(strip && name.toLowerCase().startsWith("x-evimed-")) && name.toLowerCase() !== "host"));
  const server = http.createServer((req, res) => {
    const prefix = `/request_ai/${token}/path`;
    if (!req.url.startsWith(`${prefix}/`)) { res.writeHead(404); res.end("unknown link"); return; }
    const upstream = http.request({ host: "127.0.0.1", port: bridgePort, method: req.method, path: req.url.slice(prefix.length), headers: { ...clean(req.headers), host: `127.0.0.1:${bridgePort}` } }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.once("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    const prefix = `/websocket_ai/${token}`;
    if (!req.url.startsWith(prefix)) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
    const suffix = req.url.slice(prefix.length) || "/";
    const upstream = net.connect({ host: "127.0.0.1", port: bridgePort }, () => {
      const lines = [`GET ${suffix} HTTP/1.1`, `Host: 127.0.0.1:${bridgePort}`];
      for (const [name, value] of Object.entries(clean(req.headers))) lines.push(`${name}: ${value}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.once("error", close);
    socket.once("error", close);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const port = await listen(server);
  return {
    links: { http: `http://127.0.0.1:${port}/request_ai/${token}/path/`, ws: `ws://127.0.0.1:${port}/websocket_ai/${token}` },
    async close() { for (const socket of sockets) socket.destroy(); await closeServer(server); },
  };
}

async function fixture(t, { mode = "header", strip = false } = {}) {
  const mock = await startMockDshRuntime();
  t.after(() => mock.close().catch(() => {}));
  const secret = randomBytes(32).toString("base64url");
  const bridge = createSessionBridge({ secret, upstreamPort: Number(new URL(mock.url).port) });
  const bridgePort = await listen(bridge);
  t.after(() => closeServer(bridge));
  const proxy = await linkProxy({ bridgePort, token: "tok-1", strip });
  t.after(() => proxy.close());
  const dir = await mkdtemp(path.join(os.tmpdir(), "rt-tunnel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tunnel = createLinkTunnel({ socketPath: path.join(dir, "dsh.sock"), secret, mode, links: proxy.links });
  await tunnel.listen();
  t.after(() => tunnel.close());
  const runtime = { url: "http://dsh.runtime", socketPath: tunnel.socketPath, cookie: browserSessionCookie({ secret: mock.secret, authority: "dsh.runtime" }) };
  return { mock, secret, bridge, bridgePort, proxy, tunnel, runtime, dir };
}

test("the tunnel keeps each dialer's own names: the session bridge's constants are one pair of copies", () => {
  for (const name of ["BRIDGE_MARKER", "BRIDGE_SECRET_HEADER", "BRIDGE_TARGET_HEADER", "BRIDGE_HEALTH_PATH"]) {
    assert.equal(tunnelModule[name], bridgeModule[name], `${name} differs between the tunnel and the bridge`);
  }
});

test("a unary kernel call crosses the link with its Host rewritten, so the kernel's own cookie check passes", async (t) => {
  const { runtime } = await fixture(t);
  const listed = await callRuntimeUnary(runtime, "session/list", { _request: {} });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  // The dialer is the one every unary call uses, over the tunnel's socket.
  const response = await requestRuntime(runtime, new URL("http://dsh.runtime/api/session/list"), {
    method: "POST",
    headers: { cookie: runtime.cookie, "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ type: "client-request", rpcId: "rpc_1", method: "session/list", payload: { args: { _request: {} } } })),
  });
  assert.equal(response.status, 200);
  await response.body?.cancel();
});

test("the event mux and the UI proxy's WebSocket client both upgrade through the link", async (t) => {
  const { runtime } = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const mux = await openRuntimeMux(runtime, { signal: controller.signal });
  t.after(() => mux.close());
  const first = await mux.open("$events", {}, { signal: controller.signal }).next();
  assert.equal(first.value?.type, "ready", "the kernel's host stream answered through the bridge");

  // `runtimeUiMuxProxy.mjs` dials with the `ws` client over the same socket.
  const socket = new WebSocket("ws://dsh.runtime/api/remote.mux", {
    headers: { host: "dsh.runtime", cookie: runtime.cookie },
    createConnection: () => net.connect({ path: runtime.socketPath }),
    perMessageDeflate: false,
  });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.close();
});

test("the bridge refuses a caller without the session's secret before a byte reaches the kernel", async (t) => {
  const { bridgePort, secret } = await fixture(t);
  const call = (headers, requestPath = "/api/session/list") => new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port: bridgePort, method: "POST", path: requestPath, headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.end("{}");
  });
  assert.equal(await call({}), 401);
  assert.equal(await call({ "x-evimed-bridge-secret": `${secret}x` }), 401);
  assert.equal(await call({}, `/__evimed_bridge/wrong/api/session/list`), 401);
  assert.equal(await call({ "x-evimed-bridge-secret": secret, "x-evimed-bridge-target": "//evil" }), 400);
});

test("a proxy that strips custom headers is crossed by the path-prefix form, and only by it", async (t) => {
  const stripped = await fixture(t, { mode: "path", strip: true });
  const listed = await callRuntimeUnary(stripped.runtime, "session/list", { _request: {} });
  assert.equal(listed.ok, true, "the secret travelled in the path");
  const controller = new AbortController();
  t.after(() => controller.abort());
  const mux = await openRuntimeMux(stripped.runtime, { signal: controller.signal });
  t.after(() => mux.close());
  assert.equal((await mux.open("$events", {}, { signal: controller.signal }).next()).value?.type, "ready");

  const headerMode = await fixture(t, { mode: "header", strip: true });
  const refused = await callRuntimeUnary(headerMode.runtime, "session/list", { _request: {} });
  assert.equal(refused.ok, false, "a stripped header leaves the bridge nothing to check, and it refuses");
});

test("the heartbeat reads the kernel's state through the link, and a replaced link resumes where the run is", async (t) => {
  const { runtime, tunnel, bridgePort, mock, secret } = await fixture(t);
  assert.deepEqual(await tunnel.probe(), { ok: true, upstream: true, status: 200 });

  // A session created and prompted before the link changes…
  const created = await callRuntimeUnary(runtime, "session/create", { request: { cwd: "/workspace", agentPreset: "evimed-universal" } });
  assert.equal(created.ok, true, JSON.stringify(created));
  const sessionId = created.value.sessionId;

  // …the link is replaced (an expired token, a proxy that cut the socket):
  // relayed sockets on the old link are dropped so their owners reconnect.
  const controller = new AbortController();
  t.after(() => controller.abort());
  const mux = await openRuntimeMux(runtime, { signal: controller.signal });
  const replacement = await linkProxy({ bridgePort, token: "tok-2" });
  t.after(() => replacement.close());
  const closed = new Promise((resolve) => mux.frames.once("mux:closed", resolve));
  tunnel.replaceLinks(replacement.links);
  await closed;
  assert.equal(mux.closed, true, "the mux on the old link ended");

  // A new mux and the unary `session/page` the ledger resumes from both work
  // on the new link, and the session is the one created before.
  const again = await openRuntimeMux(runtime, { signal: controller.signal });
  t.after(() => again.close());
  assert.equal((await again.open("$events", {}, { signal: controller.signal }).next()).value?.type, "ready");
  const page = await callRuntimeUnary(runtime, "session/page", { request: { address: { kind: "session", sessionId }, throughSeq: 0, maxMessages: 25 } });
  assert.deepEqual(page, { ok: true, value: { records: [], hasMore: false } }, "session/page answered through the new link");
  const listed = await callRuntimeUnary(runtime, "session/list", { _request: {} });
  assert.ok(JSON.stringify(listed.value).includes(sessionId), "the session outlived the link change");

  // The kernel going away is what the heartbeat reports, not a link failure.
  await mock.close();
  const probe = await tunnel.probe();
  assert.equal(probe.ok, true, "the bridge still answers");
  assert.equal(probe.upstream, false, "and says the kernel behind it does not");
  void secret;
});

test("a kernel address keeps its raw query, combo syntax included, in both link forms", () => {
  const combo = "/plugins/??@deepseek-ai/dsh-web-app/client.js,@evimed/dsh-socket/dist/client.js&rev=abc123def456";
  const header = linkTarget("https://gw.example:8008/request_ai/tok/path/", combo, { secret: "s", mode: "header", websocket: false });
  assert.equal(`${header.pathname}${header.search}`, `/request_ai/tok/path${combo}`);
  const pathMode = linkTarget("https://gw.example:8008/request_ai/tok/path/", combo, { secret: "s/+", mode: "path", websocket: false });
  assert.equal(`${pathMode.pathname}${pathMode.search}`, `/request_ai/tok/path/__evimed_bridge/s%2F%2B${combo}`);
  const websocket = linkTarget("wss://gw.example:8008/websocket_ai/tok", "/api/remote.mux", { secret: "s", mode: "header", websocket: true });
  assert.equal(websocket.href, "https://gw.example:8008/websocket_ai/tok");
});
