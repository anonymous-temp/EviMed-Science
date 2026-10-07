// The author page shows the author's recent changes where the change log is composed (evidence-flywheel review fix 11, 2026-10-06):
// `server.mjs` used to build EvidenceAuthors without a change-log reader, so the page never had a change section. Through the composed app.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const suffix = randomUUID().slice(0, 8);
const PASSWORD = "test-only-changes-password";
const accounts = { author: `writer${suffix}`, reader: `reader${suffix}` };
/** @type {any} */ let isolated, dataDir;
before(async () => { if (!databaseUrl) return; isolated = await createGeoTestDatabase(databaseUrl, "authorchanges"); dataDir = await mkdtemp(path.join(tmpdir(), "evimed-author-changes-")); });
after(async () => { await isolated?.drop(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

/** The app composed with `overrides`; `run` gets the app and a caller signed in as each account. */
async function withApp(/** @type {Record<string, any>} */ overrides, /** @type {(api: any) => Promise<void>} */ run) {
  const tokenFile = path.join(dataDir, `knowledge-plugin-${randomUUID().slice(0, 6)}.token`);
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [] });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true,
    databaseUrl: isolated.url, frontierEnabled: true, frontierAudience: "all", knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile,
    knowledgePluginFetch: plugin.fetchImpl, frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} }, ...overrides,
  });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id).catch(() => null);
  const address = await app.listen(0, "127.0.0.1");
  await app.frontierWorker.close();
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [role, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: id, password: PASSWORD }) });
    sessions[role] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": (await login.json()).data.csrfToken };
  }
  const call = async (/** @type {string} */ role, /** @type {string} */ method, /** @type {string} */ pathname, /** @type {any} */ body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: sessions[role], ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  try { await run({ app, call }); } finally { await app.close(); }
}

/** The author's published zone and card, and the handle a reader reaches the page by. */
async function published(/** @type {any} */ call, /** @type {any} */ app, /** @type {string} */ tag) {
  const zone = (await call("author", "POST", "/api/frontier/zones", { title: `Zone ${tag}`, description: "", background: "", requestId: `request-zone-${tag}` })).body.data.zone;
  await call("author", "PATCH", `/api/frontier/zones/${zone.id}`, { expectedRevision: zone.revision, state: "published" });
  const card = (await call("author", "POST", `/api/frontier/zones/${zone.id}/evidence`, { title: `Card ${tag}`, subtype: "academic", summary: "s", body: "b", limitations: "", requestId: `request-card-${tag}`,
    sources: [{ title: "Trial A", url: "https://example.org/a", excerpt: "Observed outcomes" }] })).body.data.evidence;
  await call("author", "PATCH", `/api/frontier/zones/${zone.id}/evidence/${card.id}`, { expectedRevision: card.revision, state: "published" });
  const handle = (await call("reader", "GET", `/api/frontier/evidence/${card.id}/links`)).body.data.author.id;
  return { zone, card, handle };
}

test("with the upkeep on the author page carries the author's recent changes, from the log, and with it off the page has no change section", options, async () => {
  await withApp({ evidenceUpkeepEnabled: true }, async ({ app, call }) => {
    const { zone, card, handle } = await published(call, app, "on");
    const page = await call("reader", "GET", `/api/frontier/authors/${handle}`);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.data.changes, [], "a section, empty until something changes");
    const entry = await app.frontier.evidenceUpkeep.changeLog.append({ zoneId: zone.id, cardId: card.id, category: "correction", trigger: "producer_edit" });
    const after = (await call("reader", "GET", `/api/frontier/authors/${handle}`)).body.data;
    assert.deepEqual(after.changes.map((/** @type {any} */ change) => [change.id, change.cardId, change.categoryLabel]), [[entry.id, card.id, entry.categoryLabel]]);
    assert.ok(after.changes[0].summary && after.changes[0].occurredAt);
  });
  await withApp({ evidenceUpkeepEnabled: false }, async ({ app, call }) => {
    const { handle } = await published(call, app, "off");
    const page = await call("reader", "GET", `/api/frontier/authors/${handle}`);
    assert.equal(page.status, 200);
    assert.equal("changes" in page.body.data, false);
  });
});
