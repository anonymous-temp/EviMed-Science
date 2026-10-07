// The frontier's links to the evidence cards in the real hosted app, against a real PostgreSQL, composed exactly as a
// deployment composes them (flywheel F09, F10): a card published in a followed zone reaches the follower's inbox through
// the hook the server wires, and the public feed answers over HTTP to a request that carries no session, lists what the
// plugin may read, answers 304 to its ETag, and shows in the operator's scrape.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const PASSWORD = "test-only-flywheel-password";
const accounts = { owner: "fw-owner", follower: "fw-follower" };
let context = null;
let isolated = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "fwapp");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-flywheel-app-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres",
    requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    frontierEnabled: true, frontierAudience: "all", evidencePublicWebEnabled: true, publicUrl: "https://www.evimed.test",
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: memoryPlugin({ sources: [pluginSource("nejm")] }).fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} },
  });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  await app.frontierWorker.tick();
  await app.frontierWorker.close();
  context = { app, base: `http://127.0.0.1:${address.port}`, dataDir };
});
after(async () => {
  if (!context) return;
  await context.app.close();
  await rm(context.dataDir, { recursive: true, force: true });
  await isolated?.drop();
});

test("a card published in a followed zone reaches the follower's inbox through the server's own hook, and the public feed lists it", options, async () => {
  const { app, base } = context;
  const zones = app.frontier.evidenceZones;
  const owner = { id: accounts.owner };
  const follower = { id: accounts.follower };
  const { zone } = await zones.save(owner, { title: "房颤抗凝", description: "d", background: "b" });
  const live = (await zones.save(owner, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
  const open = (await zones.setVisibility(owner, live.id, { visibility: "internet", expectedRevision: live.revision })).zone;
  await zones.act(follower, open.id, "follow", { expectedRevision: open.revision });
  // The feed carries a researcher's card only from an established author: three published cards with a quotation the platform verified.
  const standing = (await zones.save(owner, { title: "已核验", description: "d", background: "b" })).zone;
  await zones.save(owner, { expectedRevision: standing.revision, state: "published" }, standing.id);
  for (const name of ["a", "b", "c"]) await zones.saveEditorial(owner, {
    title: `已核验 ${name}`, subtype: "academic", summary: "摘要", body: "正文", state: "published", limitations: "单中心", provenance: "p",
    sources: [{ title: "Registry", url: "https://example.org/registry", excerpt: "x", documentText: "单中心结果显示出血较少。" }], content: { question: "q", answer: "a" },
    claims: [{ claimId: "CLM-1", claimType: "direct", claim: "出血较少。", sourceIndexes: [1], supportQuote: "出血较少" }],
  }, standing.id, null, true, "result");
  const card = (await zones.saveEditorial(owner, {
    title: "单中心房颤抗凝出血", subtype: "academic", summary: "摘要", body: "正文", state: "published", limitations: "单中心", provenance: "p",
    sources: [{ title: "Registry", url: "https://example.org/registry", excerpt: "x" }], content: { question: "q", answer: "单中心结果。" }, originality: "original_research",
    lineage: { resultVersionId: `rv_${"5".repeat(64)}` },
  }, open.id, null, true, "result")).evidence;

  // The hook the server composed told the notifier; its worker delivers.
  assert.equal(Number((await app.store.database.query("SELECT count(*) AS n FROM evimed_product.jobs WHERE kind='frontier-notify' AND user_id=$1", [follower.id])).rows[0].n), 1);
  await app.frontier.notifications.deliverDue();
  const inbox = (await app.store.database.query("SELECT title, body, source FROM evimed_inbox.notifications WHERE user_id=$1", [follower.id])).rows;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].title, "单中心房颤抗凝出血");
  assert.deepEqual(inbox[0].source, { type: "system", id: `frontier-zone:${open.id}:${card.id}` });
  assert.deepEqual((await app.store.database.query("SELECT 1 FROM evimed_inbox.notifications WHERE user_id=$1", [owner.id])).rows, [], "the author is not told of their own card");

  // The feed: no cookie, no CSRF header, and the researcher's original research in an open zone is in it.
  const feed = await fetch(`${base}/evidence/feed.json`);
  assert.equal(feed.status, 200);
  const body = await feed.json();
  assert.deepEqual(body.items.map((item) => item.id), [card.id]);
  assert.equal(body.items[0].url, `https://www.evimed.test/evidence/c/${card.id}`);
  assert.equal(body.items[0].primary, true);
  const etag = feed.headers.get("etag");
  assert.equal((await fetch(`${base}/evidence/feed.json`, { headers: { "if-none-match": etag } })).status, 304);
  assert.equal((await fetch(`${base}/evidence/feed.xml`)).status, 200);

  const scrape = await (await fetch(`${base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  assert.match(scrape, /^open_science_evidence_feed_requests_total\{outcome="served"\} 2$/m);
  assert.match(scrape, /^open_science_evidence_feed_requests_total\{outcome="not_modified"\} 1$/m);
  assert.match(scrape, /^open_science_frontier_notifications_total\{outcome="zoneQueued"\} 1$/m);
});
