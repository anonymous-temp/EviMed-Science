// The Mermaid bundle imports its renderer from a root path of the application's origin, outside every frame's prefix:
// `import("/dsh-mermaid/mermaid-runtime.js?rev=<content hash>")`. That path has no frame to resolve and was answered 401, so
// a reply drew a diagram's code and never the diagram (seen in the hosted frame on the 0.2 kernel, and identically with the
// previous bundle version). It is now one more file the shared asset route serves: login alone, GET and HEAD, one exact
// path whose revision names the content, read from the account's own runtime and kept in memory after the first fetch.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ROOT_PLUGIN_RUNTIME_ASSET, isImmutableRuntimeUiAsset } from "../src/runtimeManager.mjs";
import { createWebApiApp } from "../src/server.mjs";

const ASSET = "/dsh-mermaid/mermaid-runtime.js?rev=d7c361216dce";

test("only the one renderer path, with a revision, is a root plugin asset", () => {
  assert.equal(ROOT_PLUGIN_RUNTIME_ASSET.test(ASSET), true);
  for (const other of [
    "/dsh-mermaid/mermaid-runtime.js", "/dsh-mermaid/mermaid-runtime.js?rev=a", "/dsh-mermaid/mermaid-runtime.js?rev=d7c361216dce&x=1",
    "/dsh-mermaid/other.js?rev=d7c361216dce", "/dsh-mermaid/../api/session/list?rev=d7c361216dce", "//dsh-mermaid/mermaid-runtime.js?rev=d7c361216dce",
    "/dsh-annotation/client.js?rev=d7c361216dce", "/api/session/list", "/",
  ]) assert.equal(ROOT_PLUGIN_RUNTIME_ASSET.test(other), false, other);
  assert.equal(isImmutableRuntimeUiAsset(ASSET), true, "its URL names its content, so it is kept for a year");
  assert.equal(isImmutableRuntimeUiAsset("/dsh-mermaid/mermaid-runtime.js"), false);
});

test("the renderer is served at the origin's root to a logged-in account, once from the runtime, and to nobody else", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "os-runtime-ui-plugin-asset-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, runtimeUiProxyEnabled: true, runtimeUiPort: 0,
    publicUrl: "https://science.example", runtimeUiPublicOrigin: "https://science.example:8443" });
  const address = await app.listen(0, "127.0.0.1");
  const body = `window.mermaid = "${"x".repeat(4096)}";`;
  /** @type {string[]} */
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push(String(req.url));
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" });
    res.end(body);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", () => resolve(undefined)));
  const manager = app.runtimeManager;
  /** @type {string} */
  let key = "";
  t.after(async () => {
    if (key) manager.runtimes.delete(key);
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(() => resolve(undefined)));
    await app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const seeded = await fetch(`http://127.0.0.1:${address.port}/api/projects`);
  const loginCookie = (seeded.headers.getSetCookie?.() ?? []).map((item) => item.split(";")[0]).join("; ");
  assert.ok(loginCookie, "the fixture needs a session cookie");
  const ui = app.runtimeUi.address();
  assert.ok(ui, "the browser-application origin must be bound when the surface is on");
  const origin = `http://127.0.0.1:${ui.port}`;
  const user = await app.store.devUser();
  key = `${user.id}:default`;
  manager.runtimes.set(key, { url: `http://127.0.0.1:${upstream.address().port}`, cookie: "native=internal", project: { id: "default", userId: user.id }, close: async () => {} });

  const first = await fetch(`${origin}${ASSET}`, { headers: { cookie: loginCookie, "accept-encoding": "gzip" } });
  assert.equal(first.status, 200);
  assert.match(String(first.headers.get("content-type")), /javascript/);
  assert.equal(first.headers.get("content-encoding"), "gzip", "text crosses the network compressed");
  assert.equal(first.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(await first.text(), body);
  const again = await fetch(`${origin}${ASSET}`, { headers: { cookie: loginCookie, "accept-encoding": "identity" } });
  assert.equal(await again.text(), body);
  assert.deepEqual(seen, [ASSET], "the kernel was asked for the file once; the second read came from memory");
  const head = await fetch(`${origin}${ASSET}`, { method: "HEAD", headers: { cookie: loginCookie } });
  assert.equal(head.status, 200);

  // Refused without reaching the kernel: no login, a write, another path, no revision.
  const anonymous = await fetch(`${origin}${ASSET}`);
  assert.equal(anonymous.status, 401);
  for (const [label, route, init] of [
    ["a write", ASSET, { method: "POST" }],
    ["another file of the bundle", "/dsh-mermaid/other.js?rev=d7c361216dce", {}],
    ["no revision", "/dsh-mermaid/mermaid-runtime.js", {}],
    ["a traversal", "/dsh-mermaid/../api/session/list?rev=d7c361216dce", {}],
  ]) {
    const response = await fetch(`${origin}${route}`, { ...init, headers: { cookie: loginCookie, Origin: "https://science.example:8443" } });
    assert.notEqual(response.status, 200, label);
  }
  assert.deepEqual(seen, [ASSET], "no refused request reached the kernel");

  // With no runtime of the account running, what is not in memory has nowhere to come from; what is, needs none.
  manager.runtimes.delete(key);
  const kept = await fetch(`${origin}${ASSET}`, { headers: { cookie: loginCookie } });
  assert.equal(kept.status, 200);
});
