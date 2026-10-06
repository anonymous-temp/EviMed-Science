// The public evidence pages as the real server composes them while they are off (flywheel F08): every /evidence/… path is answered
// exactly as a path nothing serves is answered — the single-page app's fallback where there is a build, 404 where there is none — and
// the operator's scrape carries no series for a module that does not exist.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

/** @param {Record<string, any>} overrides @param {(base: string, dataDir: string) => Promise<void>} run */
async function withApp(overrides, run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-evidence-public-app-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", operatorMetricsToken: "test-only-metrics-token", ...overrides });
  const address = await app.listen(0, "127.0.0.1");
  try { await run(`http://127.0.0.1:${address.port}`, dataDir); } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
}

/** The request id differs per request; everything else of the body is what is compared. @param {string} body */
const withoutRequestId = (body) => body.replace(/req_[0-9a-f]{32}/g, "req_x");
const PATHS = ["/evidence/", "/evidence", "/evidence/z/ez_0123456789ab", "/evidence/c/ec_0123456789ab", "/evidence/a/alice", "/evidence/about", "/evidence/metrics", "/evidence/simulations", "/evidence/requests",
  "/evidence/sitemap.xml", "/evidence/assets/site.css", "/evidence/api/v1/zones", "/evidence/api/v1/metrics"];

test("with the pages off, every /evidence path is answered as an unknown path is, with no static build and with one", async () => {
  await withApp({ evidencePublicWebEnabled: false, evidencePublicIndexable: true }, async (base) => {
    const unknown = await fetch(`${base}/nothing-lives-here`);
    const expected = withoutRequestId(await unknown.text());
    assert.equal(unknown.status, 404);
    for (const route of PATHS) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 404, route);
      assert.equal(withoutRequestId(await response.text()), expected, route);
      assert.equal(response.headers.get("x-robots-tag"), null, `${route} carries nothing of the pages' own headers`);
    }
  });
  const staticDir = await mkdtemp(path.join(tmpdir(), "os-evidence-public-static-"));
  try {
    await writeFile(path.join(staticDir, "index.html"), "<!doctype html><title>the app</title>");
    await withApp({ evidencePublicWebEnabled: false, staticDir }, async (base) => {
      const unknown = await fetch(`${base}/nothing-lives-here`);
      assert.equal(unknown.status, 200);
      const expected = await unknown.text();
      for (const route of PATHS.filter((entry) => !entry.startsWith("/evidence/api/"))) {
        const response = await fetch(`${base}${route}`);
        assert.equal(await response.text(), expected, `${route} is the app's own fallback`);
      }
    });
  } finally {
    await rm(staticDir, { recursive: true, force: true });
  }
});

test("with the pages on but no database there is nothing to read, so the router is not composed and the paths stay unknown", async () => {
  await withApp({ evidencePublicWebEnabled: true }, async (base) => {
    for (const route of ["/evidence/", "/evidence/about", "/evidence/api/v1/zones"]) assert.equal((await fetch(`${base}${route}`)).status, 404, route);
    const scrape = await (await fetch(`${base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
    assert.doesNotMatch(scrape, /open_science_evidence_public_requests_total/, "a module that is not composed exports nothing");
    assert.doesNotMatch(scrape, /open_science_evidence_topic_requests_total/);
  });
});

test("with the pages off the topic-request routes do not exist either, and a session is not asked for", async () => {
  await withApp({ evidencePublicWebEnabled: false }, async (base) => {
    for (const [method, route] of [["GET", "/api/frontier/evidence/topic-requests"], ["POST", "/api/frontier/evidence/topic-requests"], ["POST", `/api/frontier/evidence/topic-requests/tr_${"0".repeat(32)}/second`]]) {
      const response = await fetch(`${base}${route}`, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) });
      assert.ok([401, 404].includes(response.status), `${method} ${route}: ${response.status}`);
      assert.notEqual(response.status, 200);
    }
  });
});
