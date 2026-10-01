import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeManager } from "../src/runtimeManager.mjs";
import { generateBrowserSessionSecret } from "../src/dshBrowserAuth.mjs";
import { mockAcceptsBrowserSession, startMockDshRuntime } from "../src/mockDshRuntime.mjs";
import { callRuntimeUnary } from "../src/dshEventPump.mjs";
import { DshMux } from "../src/dshMux.mjs";

const DAY = 24 * 60 * 60 * 1000;

async function launchedRuntime(t, kernel) {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-auth-renewal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "paper1", userId: "alice", rootDir: root,
    metaDir: path.join(root, "meta"), workspaceDir: path.join(root, "workspace"), runtimeDir: path.join(root, "runtime") };
  await Promise.all([project.metaDir, project.workspaceDir, project.runtimeDir].map(directory => mkdir(directory)));
  const manager = new RuntimeManager({ runtimeMode: "mock", runtimeProvider: "docker", runtimeUiProxyEnabled: true,
    runtimeProxyConnectTimeoutMs: 1000, runtimeProxyRequestTimeoutMs: 2000, runtimeReadyTimeoutMs: 2000,
    maxJsonBytes: 1024 * 1024, maxLogFileBytes: 1024 * 1024 });
  // Only the launch provider is replaced. The production startKernel record,
  // readiness, unary callers and mux authentication run against real sockets.
  manager.syncCapsuleMethods = async () => ({ count: 0, promptBytes: 0 });
  const child = new EventEmitter();
  child.pid = process.pid;
  manager.provider = {
    preflight: async () => {}, prepare: async () => ({ runtimeUrl: kernel.url, sandboxMode: "mock" }),
    bootstrap: async () => ({ browserSessionSecret: kernel.secret }), launch: async () => child,
    close: async () => {}, afterExit: async () => {},
  };
  const runtime = await manager.startKernel(project);
  manager.runtimes.set(manager.key(project), runtime);
  return { manager, runtime, project };
}

const cookiePayload = cookie => JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[1], "base64url").toString());

test("a 27-hour running kernel renews expired authentication for readiness, unary calls and mux reconnects", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const kernel = await startMockDshRuntime({ pingIntervalMs: 0 });
  t.after(() => kernel.close());
  const { manager, runtime, project } = await launchedRuntime(t, kernel);
  const startupCookie = runtime.cookie;
  const firstMux = new DshMux(runtime);
  await firstMux.connect({ signal: AbortSignal.timeout(2000) });
  firstMux.close();
  now += 27 * 60 * 60 * 1000;
  const expired = await fetch(`${kernel.url}/api/session/list`, { method: "POST",
    headers: { cookie: startupCookie, "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "expired", method: "session/list", payload: { args: { _request: {} } } }) });
  assert.equal(expired.status, 401, "the independent kernel verifier refuses the actual startup cookie after 24 hours");
  await expired.text();
  const freshCookie = runtime.cookie;
  assert.notEqual(freshCookie, startupCookie);
  assert.equal(cookiePayload(freshCookie).issuedAt, now);
  assert.equal(cookiePayload(freshCookie).expiresAt - now, DAY, "renewal keeps the original bounded lifetime");
  assert.equal(Object.keys(runtime).includes("cookie"), false);
  assert.equal(JSON.stringify(runtime).includes(kernel.secret), false, "the signing secret is held only in a closure");
  await manager.waitUntilReady(runtime);
  assert.ok(await manager.callKernel(runtime, project, "session/list", { _request: {} }, AbortSignal.timeout(2000)));
  assert.equal((await callRuntimeUnary(runtime, "session/list", { _request: {} })).ok, true);
  const reconnectedMux = new DshMux(runtime);
  t.after(() => reconnectedMux.close());
  await reconnectedMux.connect({ signal: AbortSignal.timeout(2000) });
  now += 27 * 60 * 60 * 1000;
  assert.equal((await callRuntimeUnary(runtime, "session/list", { _request: {} })).ok, true, "renewal works repeatedly across another lifetime");
});

test("the same runtime getter renews credentials for shared assets and the UI HTTP proxy", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const secret = generateBrowserSessionSecret();
  const kernel = createServer((req, res) => {
    if (!mockAcceptsBrowserSession({ secret, authority: req.headers.host, cookieHeader: req.headers.cookie })) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    if (req.url === "/api/session/list") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: { ok: true, value: [] } }));
    } else res.writeHead(200, { "content-type": "text/plain" }).end("authenticated asset");
  });
  await new Promise(resolve => kernel.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => kernel.close(resolve)));
  const url = `http://127.0.0.1:${kernel.address().port}`;
  const { manager, runtime, project } = await launchedRuntime(t, { url, secret });
  const startupCookie = runtime.cookie;
  now += 27 * 60 * 60 * 1000;
  const rejected = await fetch(`${url}/assets/plain.js`, { headers: { cookie: startupCookie } });
  assert.equal(rejected.status, 401);
  await rejected.text();
  const asset = await manager.sharedUiAsset(project.userId, "/assets/plain.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.body.toString(), "authenticated asset");
  manager.start = async () => runtime;
  const proxy = createServer((req, res) => void manager.proxy(req, res, project, "/assets/plain.js", { surface: "ui" }));
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const rendered = await fetch(`http://127.0.0.1:${proxy.address().port}/assets/plain.js`, { headers: { cookie: "browser-login=not-the-kernel-cookie" } });
  assert.equal(rendered.status, 200);
  assert.equal(await rendered.text(), "authenticated asset");
});
