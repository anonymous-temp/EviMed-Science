import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeManager } from "../src/runtimeManager.mjs";
import { generateBrowserSessionSecret } from "../src/dshBrowserAuth.mjs";
import { mockAcceptsBrowserSession, startMockDshRuntime } from "../src/mockDshRuntime.mjs";
import { callRuntimeUnary } from "../src/dshEventPump.mjs";
import { DshMux } from "../src/dshMux.mjs";

const DAY = 24 * 60 * 60 * 1000;

function fixtureOwner(t) {
  const fixture = { muxes: [], requests: [], kernel: null, proxy: null, manager: null, root: null, releaseWriters: () => {} };
  let cleaned = false;
  fixture.observe = promise => {
    // Attach the rejection observer at creation, before teardown can run.
    fixture.requests.push(promise.then(() => null, error => error));
  };
  fixture.cleanup = async (primaryError = null) => {
    if (cleaned) return;
    cleaned = true;
    const errors = primaryError ? [primaryError] : [];
    const attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    for (const mux of fixture.muxes) await attempt(() => mux.close());
    if (fixture.proxy) await attempt(() => new Promise(resolve => fixture.proxy.close(resolve)));
    await attempt(() => fixture.releaseWriters());
    errors.push(...(await Promise.all(fixture.requests)).filter(Boolean));
    if (fixture.kernel) await attempt(() => fixture.kernel.close());
    if (fixture.manager) await attempt(() => fixture.manager.closeAll());
    if (fixture.root) await attempt(() => rm(fixture.root, { recursive: true, force: true }));
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Runtime auth fixture cleanup failed");
  };
  t?.after(() => fixture.cleanup());
  return fixture;
}

async function launchedRuntime(fixture, kernel) {
  try {
    const root = fixture.root = await mkdtemp(path.join(os.tmpdir(), "runtime-auth-renewal-"));
    const project = { id: "paper1", userId: "alice", rootDir: root,
      metaDir: path.join(root, "meta"), workspaceDir: path.join(root, "workspace"), runtimeDir: path.join(root, "runtime") };
    await Promise.all([project.metaDir, project.workspaceDir, project.runtimeDir].map(directory => mkdir(directory)));
    const manager = fixture.manager = new RuntimeManager({ runtimeMode: "mock", runtimeProvider: "docker", runtimeUiProxyEnabled: true,
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
  } catch (error) {
    await fixture.cleanup(error);
    throw error;
  }
}

const cookiePayload = cookie => JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[1], "base64url").toString());

test("a 27-hour running kernel renews expired authentication for readiness, unary calls and mux reconnects", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const fixture = fixtureOwner(t);
  const kernel = await startMockDshRuntime({ pingIntervalMs: 0 });
  fixture.kernel = kernel;
  const { manager, runtime, project } = await launchedRuntime(fixture, kernel);
  const startupCookie = runtime.cookie;
  const firstMux = new DshMux(runtime);
  fixture.muxes.push(firstMux);
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
  fixture.muxes.push(reconnectedMux);
  await reconnectedMux.connect({ signal: AbortSignal.timeout(2000) });
  now += 27 * 60 * 60 * 1000;
  assert.equal((await callRuntimeUnary(runtime, "session/list", { _request: {} })).ok, true, "renewal works repeatedly across another lifetime");
});

test("the same runtime getter renews credentials for shared assets and the UI HTTP proxy", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const fixture = fixtureOwner(t);
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
  fixture.kernel = { close: () => new Promise(resolve => kernel.close(resolve)) };
  await new Promise(resolve => kernel.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${kernel.address().port}`;
  const { manager, runtime, project } = await launchedRuntime(fixture, { url, secret });
  const proxyWritersReleased = new Promise(resolve => { fixture.releaseWriters = resolve; });
  let completedProxyWriters = 0;
  const startupCookie = runtime.cookie;
  now += 27 * 60 * 60 * 1000;
  const rejected = await fetch(`${url}/assets/plain.js`, { headers: { cookie: startupCookie } });
  assert.equal(rejected.status, 401);
  await rejected.text();
  const asset = await manager.sharedUiAsset(project.userId, "/assets/plain.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.body.toString(), "authenticated asset");
  manager.start = async () => runtime;
  const proxy = fixture.proxy = createServer((req, res) => {
    fixture.observe((async () => {
      await manager.proxy(req, res, project, "/assets/plain.js", { surface: "ui" });
      // Hold a final metadata writer until teardown: response completion must
      // never authorize deleting the directory still owned by its handler.
      await proxyWritersReleased;
      await writeFile(path.join(project.metaDir, `proxy-writer-${++completedProxyWriters}`), "drained");
    })());
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const rendered = await fetch(`http://127.0.0.1:${proxy.address().port}/assets/plain.js`, { headers: { cookie: "browser-login=not-the-kernel-cookie" } });
  assert.equal(rendered.status, 200);
  assert.equal(await rendered.text(), "authenticated asset");
  assert.doesNotMatch(rendered.headers.get("content-security-policy"), /frame-src/);
  manager.config.managedBrowserEnabled = true;
  const managed = await fetch(`http://127.0.0.1:${proxy.address().port}/assets/plain.js`);
  assert.equal(managed.status, 200);
  assert.match(managed.headers.get("content-security-policy"), /; frame-src 'self' blob:$/);
  assert.equal(await managed.text(), "authenticated asset");
  assert.equal(completedProxyWriters, 0, "both response bodies arrive before the held writers finish");
  await fixture.cleanup();
  assert.equal(completedProxyWriters, 2);
});


test("auth fixture drains rejected handlers and closes every resource before reporting the error", async () => {
  const fixture = fixtureOwner();
  const kernel = createServer((req, res) => res.end("ok"));
  fixture.kernel = { close: () => new Promise(resolve => kernel.close(resolve)) };
  await new Promise(resolve => kernel.listen(0, "127.0.0.1", resolve));
  fixture.root = await mkdtemp(path.join(os.tmpdir(), "runtime-auth-rejection-"));
  let managerClosed = false;
  fixture.manager = { closeAll: async () => { managerClosed = true; } };
  const failure = new Error("deliberate handler failure");
  fixture.observe(Promise.reject(failure));
  await assert.rejects(fixture.cleanup(), error => error === failure);
  assert.equal(kernel.listening, false);
  assert.equal(managerClosed, true);
  await assert.rejects(stat(fixture.root), { code: "ENOENT" });
});

test("auth fixture owns startup resources before startKernel can fail", async t => {
  const fixture = fixtureOwner(t);
  const kernel = createServer((req, res) => res.end("ok"));
  fixture.kernel = { close: () => new Promise(resolve => kernel.close(resolve)) };
  await new Promise(resolve => kernel.listen(0, "127.0.0.1", resolve));
  const failure = new Error("deliberate startup failure");
  let managerClosed = false;
  t.mock.method(RuntimeManager.prototype, "startKernel", async () => { throw failure; });
  const closeAll = RuntimeManager.prototype.closeAll;
  t.mock.method(RuntimeManager.prototype, "closeAll", async function () { managerClosed = true; await closeAll.call(this); });
  await assert.rejects(launchedRuntime(fixture, { url: "unused", secret: "unused" }), error => error === failure);
  assert.equal(kernel.listening, false);
  assert.equal(managerClosed, true);
  await assert.rejects(stat(fixture.root), { code: "ENOENT" });
});
