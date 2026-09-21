import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { createServer, request } from "node:http";
import test from "node:test";
import { isLocalhostProbe } from "../../../scripts/test/localhostProbeGuard.mjs";

/** One raw request, so the Host header is exactly what a port scanner sends. */
function send(port, { host, method = "GET", path = "/" }) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method, path, headers: { host } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("a port scanner's GET / never reaches a fixture; the test's own requests all do", async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.headers.host?.split(":")[0]} ${req.url}`);
    res.end("fixture");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  assert.equal(await send(port, { host: `localhost:${port}` }), 404, "the scanner is told there is nothing here");
  assert.equal(await send(port, { host: "localhost" }), 404);
  assert.equal(await send(port, { host: `127.0.0.1:${port}` }), 200);
  assert.equal(await send(port, { host: `localhost:${port}`, path: "/v1/chat/completions", method: "POST" }), 200,
    "only the scanner's exact shape is turned away");
  assert.equal(await send(port, { host: `localhost:${port}`, path: "/api/ready" }), 200);
  assert.deepEqual(seen, ["GET 127.0.0.1 /", "POST localhost /v1/chat/completions", "GET localhost /api/ready"]);
});

test("the probe's shape is exactly GET / addressed to localhost", () => {
  const probe = (method, url, host) => isLocalhostProbe(/** @type {any} */ ({ method, url, headers: { host } }));
  assert.equal(probe("GET", "/", "localhost:5173"), true);
  assert.equal(probe("GET", "/", "LOCALHOST:5173"), true);
  assert.equal(probe("GET", "/", "127.0.0.1:5173"), false);
  assert.equal(probe("GET", "/", "localhost.example:5173"), false);
  assert.equal(probe("HEAD", "/", "localhost:5173"), false);
  assert.equal(probe("GET", "/index.html", "localhost:5173"), false);
});

test("every node test suite in the repository runs behind the guard", async () => {
  // Without it a suite fails on whatever the machine's tooling happens to
  // probe while it runs — the socket package's citation bridge did, the first
  // full run after the server's suite was guarded (2026-09-21). A script edit
  // that drops the import, or a new suite that never had it, would look like
  // nothing until the next unlucky run.
  const root = new URL("../../../", import.meta.url);
  const manifests = [];
  for (const group of ["apps", "packages"]) {
    for (const entry of await readdir(new URL(`${group}/`, root), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = await readFile(new URL(`${group}/${entry.name}/package.json`, root), "utf8").then(JSON.parse).catch(() => null);
      if (pkg) manifests.push([`${group}/${entry.name}`, pkg]);
    }
  }
  const suites = manifests.flatMap(([where, pkg]) => Object.entries(pkg.scripts ?? {})
    .filter(([, script]) => /\bnode\b[^&|;]*--test\b/.test(String(script)))
    .map(([name, script]) => [`${where} ${name}`, String(script)]));
  // The walk proves it walked: these five suites run fake servers or sit beside ones that do.
  for (const expected of ["apps/server test", "packages/socket test", "packages/contracts test", "packages/domain test", "packages/harness-port test"]) {
    assert.ok(suites.some(([name]) => name === expected), `${expected} was not found; the walk read ${suites.length} suites`);
  }
  for (const [name, script] of suites) {
    assert.match(script, /\bnode --import \.\.\/\.\.\/scripts\/test\/localhostProbeGuard\.mjs --test /, name);
  }
});
