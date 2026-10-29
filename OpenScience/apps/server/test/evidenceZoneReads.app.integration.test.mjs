// The topic zones' read routes through the composed app: the wiring in server.mjs (the reads, the card port, the routes), the session
// and CSRF gates, a zone addressed by its slug, and a reader's private zone that is nobody else's.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { insertItem, insertSource, memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const suffix = randomUUID().slice(0, 8);
const PASSWORD = "test-only-zone-reads-password";
const accounts = { author: `author${suffix}`, reader: `reader${suffix}` };
/** @type {any} */ let isolated, dataDir, seed;
before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "zonereadsapp");
  dataDir = await mkdtemp(path.join(tmpdir(), "evimed-zone-reads-"));
  seed = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(seed, { dimension: 1024 });
});
after(async () => { await seed?.close(); await isolated?.drop(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

const definition = (/** @type {string} */ label) => JSON.stringify({ version: 1, type: "drug-indication", keywords: [{ label, terms: [label], tagIds: [], entityKeys: [] }, { label: `${label}二`, terms: [], tagIds: [], entityKeys: [] }],
  perspective: null, scope: "范围", include: "", exclude: "", excludeTerms: [], specialties: [], group: "", seeds: { positive: [], negative: [] } });

test("the directory, a zone by its slug, its overview, its list and its cards are served to a signed-in reader, and a private zone is its owner's alone", options, async () => {
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [] });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true,
    databaseUrl: isolated.url, frontierEnabled: true, frontierAudience: "all", knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile,
    knowledgePluginFetch: plugin.fetchImpl, frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} },
  });
  try {
    for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id).catch(() => null);
    const owners = Object.fromEntries((await seed.query("SELECT id, name FROM evimed_control.users WHERE name = ANY($1::text[])", [Object.values(accounts)])).rows.map((row) => [row.name, row.id]));
    await seed.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('platform-pub','EviMed','development') ON CONFLICT DO NOTHING");
    await insertSource(seed, "nejm");
    const item = await insertItem(seed, { title: "Semaglutide trial", selected: true, timelineAt: new Date(Date.now() - 86_400_000).toISOString() });
    const zones = [["ez_app_public", "platform-pub", "official", "published", "glp1-app", "司美格鲁肽"], ["ez_app_private", owners[accounts.author], "user", "draft", null, "私人"]];
    for (const [id, owner, kind, state, slug, label] of zones) {
      await seed.query(`INSERT INTO evimed_frontier.evidence_zones (id, user_id, title, state, kind, slug, zone_type, specialties, group_label, scope_zh, definition, definition_version, lifecycle)
        VALUES ($1,$2,$3,$4,$5,$6,'drug-indication','{endocrinology}','肥胖','范围',$7::jsonb,1,'active')`, [id, owner, `${label}专区`, state, kind, slug, definition(String(label))]);
      await seed.query("INSERT INTO evimed_frontier.zone_items (zone_id, item_id, state, relevance, via, role) VALUES ($1,$2,'in','core','tag','research')", [id, item.id]);
    }
    const address = await app.listen(0, "127.0.0.1");
    await app.frontierWorker.close();
    const base = `http://127.0.0.1:${address.port}`;
    /** @type {Record<string, Record<string, string>>} */
    const sessions = {};
    for (const [role, id] of Object.entries(accounts)) {
      const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: id, password: PASSWORD }) });
      sessions[role] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": (await login.json()).data.csrfToken };
    }
    const call = async (/** @type {string} */ role, /** @type {string} */ pathname) => {
      const response = await fetch(`${base}${pathname}`, { headers: sessions[role] });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    const directory = await call("reader", "/api/frontier/zones?view=recommended");
    assert.equal(directory.status, 200);
    assert.deepEqual(directory.body.data.groups.map((group) => group.sections.flatMap((section) => section.zones.map((zone) => zone.slug))), [["glp1-app"]]);
    assert.deepEqual(directory.body.data.userZones, { count: 0, max: 30 });
    assert.equal(directory.body.data.canCreate, true);
    const mine = await call("author", "/api/frontier/zones?view=mine");
    assert.deepEqual(mine.body.data.zones.map((zone) => zone.id), ["ez_app_private"]);
    assert.deepEqual(mine.body.data.zones.map((zone) => [zone.owned, zone.revision, zone.followers]), [[true, 1, 0]]);
    assert.deepEqual((await call("reader", "/api/frontier/zones?view=mine")).body.data.zones, []);

    const bySlug = await call("reader", "/api/frontier/zones/glp1-app");
    assert.equal(bySlug.status, 200);
    assert.equal(bySlug.body.data.zone.id, "ez_app_public");
    assert.equal(bySlug.body.data.zone.creator, "EviMed 证据中心");
    assert.deepEqual([bySlug.body.data.zone.owned, bySlug.body.data.zone.revision, bySlug.body.data.zone.followers], [false, 1, 0]);
    assert.equal(bySlug.body.data.zone.definition, null);
    const overview = await call("reader", "/api/frontier/zones/glp1-app/overview");
    assert.equal(overview.status, 200);
    assert.deepEqual(overview.body.data.modules.map((module) => module.key), ["latest"], "one study: every module with a minimum is left out, the latest list stays");
    assert.equal(overview.body.data.modules[0].items[0].id, item.publicId);
    const listed = await call("reader", "/api/frontier/zones/ez_app_public/items?role=research&window=30d");
    assert.deepEqual([listed.status, listed.body.data.items.map((entry) => entry.id), listed.body.data.roleCounts, listed.body.data.total], [200, [item.publicId], { research: 1 }, 1]);
    assert.deepEqual((await call("reader", "/api/frontier/zones/glp1-app/cards")).body.data, { cards: [], provider: "none" });
    // The old list is still the old list.
    assert.equal((await call("reader", "/api/frontier/zones")).status, 200);

    for (const pathname of ["/api/frontier/zones/ez_app_private", "/api/frontier/zones/ez_app_private/overview", "/api/frontier/zones/ez_app_private/items", "/api/frontier/zones/ez_app_private/cards"]) {
      const refused = await call("reader", pathname);
      assert.equal(refused.status, 404, pathname);
      assert.match(refused.body.code ?? refused.body.error?.code ?? "", /not_found/, pathname);
    }
    assert.equal((await call("author", "/api/frontier/zones/ez_app_private/overview")).status, 200);
    assert.equal((await fetch(`${base}/api/frontier/zones?view=recommended`)).status, 401, "a request with no session is refused before any read");
  } finally { await app.close(); }
});
