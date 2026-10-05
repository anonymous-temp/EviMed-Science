// The evidence feed as the real server composes it (flywheel F09, rule 2): the two paths are reached without a session
// and answer 404 by name while the public pages are off (or where there is no database to read cards from), and the
// operator's scrape carries the guardrail counter of platform content cited as evidence and the feed's own counters
// only where the feed exists.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

/** @param {Record<string, any>} overrides @param {(base: string) => Promise<void>} run */
async function withApp(overrides, run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-evidence-feed-app-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", operatorMetricsToken: "test-only-metrics-token", ...overrides });
  const address = await app.listen(0, "127.0.0.1");
  try { await run(`http://127.0.0.1:${address.port}`); } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
}

test("with the public pages off, both feed paths answer 404 by name to a request that carries no session", async () => {
  await withApp({ evidencePublicWebEnabled: false }, async (base) => {
    for (const route of ["/evidence/feed.json", "/evidence/feed.xml"]) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 404, route);
      assert.equal((await response.json()).code, "evidence_public_not_enabled", route);
    }
  });
});

test("with the pages on but no database to read cards from, the answer is the same name, not a path that never existed", async () => {
  await withApp({ evidencePublicWebEnabled: true }, async (base) => {
    const response = await fetch(`${base}/evidence/feed.json`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.code, "evidence_public_not_enabled");
    assert.match(body.error, /not available in this deployment/);
  });
});

test("the scrape carries the guardrail of platform content cited as evidence, and no feed series where there is no feed", async () => {
  await withApp({}, async (base) => {
    const text = await (await fetch(`${base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
    assert.match(text, /^open_science_evidence_platform_content_cited_total \d+$/m);
    assert.match(text, /^open_science_evidence_platform_content_cited_runs_total \d+$/m);
    assert.doesNotMatch(text, /open_science_evidence_feed_requests_total/, "a feed that does not exist exports nothing");
  });
});
