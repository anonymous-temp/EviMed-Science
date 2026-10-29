// The topic zones' write side in the real hosted app, against a real PostgreSQL, composed exactly as a deployment composes it: a sentence
// drafted (the model is not configured, so the draft is made from the sentence), a reader's zone made, published, edited and deleted over
// HTTP behind the session and the CSRF check, another reader's view of it, a typed follow that is a zone, and the planner's loop in the
// feed's worker.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { TYPED_FOLLOWS_MARKER } from "../src/evidenceZoneWrites.mjs";
import { memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const PASSWORD = "test-only-zone-writes-password";
const accounts = { owner: "zw-owner", other: "zw-other" };
let context = null;
let isolated = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "zwapp");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-zone-writes-app-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres",
    requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    frontierEnabled: true, frontierAudience: "all",
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: memoryPlugin({ sources: [pluginSource("nejm")] }).fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} },
  });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  await app.frontierWorker.close();
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [role, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: id, password: PASSWORD }) });
    const body = await login.json();
    sessions[role] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": body.data.csrfToken };
  }
  context = { app, base, sessions, dataDir };
});
after(async () => {
  if (!context) return;
  await context.app.store.database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [Object.values(accounts)]);
  await context.app.close();
  await rm(context.dataDir, { recursive: true, force: true });
  await isolated?.drop();
});

/** @param {string} role @param {string} method @param {string} route @param {unknown} [body] */
async function call(role, method, route, body) {
  const { base, sessions } = context;
  const response = await fetch(`${base}/api/frontier${route}`, { method, headers: sessions[role], ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("a sentence becomes a zone over HTTP: drafted, previewed, made, published, edited, deleted - and another reader sees only what is published", options, async () => {
  const drafted = await call("owner", "POST", "/zones/draft", { text: "司美格鲁肽 肥胖" });
  assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
  assert.equal(drafted.body.data.draft.definition.scope, "司美格鲁肽 肥胖", "no model is configured: the draft is made from the sentence");
  assert.ok(drafted.body.data.draft.definition.keywords.length >= 1);
  assert.deepEqual(Object.keys(drafted.body.data.preview).sort(), ["band", "borderline", "count30", "perWeek", "recent"]);

  const made = await call("owner", "POST", "/zones", { title: drafted.body.data.draft.title, definition: drafted.body.data.draft.definition, seeds: { positive: [], negative: [] }, published: false, requestId: "zone-writes-app-1" });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const zone = made.body.data.zone;
  assert.deepEqual([zone.kind, zone.published, zone.canEdit, zone.canDelete], ["user", false, true, true]);
  assert.equal((await call("owner", "POST", "/zones", { title: drafted.body.data.draft.title, definition: drafted.body.data.draft.definition, seeds: { positive: [], negative: [] }, published: false, requestId: "zone-writes-app-1" })).body.data.zone.id, zone.id, "a retry is the same zone");

  assert.equal((await call("other", "PATCH", `/zones/${zone.id}`, { title: "劫持", expectedRevision: zone.revision })).status, 404, "a private zone does not exist for another reader");
  assert.equal((await call("other", "DELETE", `/zones/${zone.id}`)).status, 404);
  const published = await call("owner", "PATCH", `/zones/${zone.id}`, { published: true, expectedRevision: zone.revision });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.data.zone.published, true);
  assert.equal((await call("other", "PATCH", `/zones/${zone.id}`, { title: "劫持", expectedRevision: published.body.data.zone.revision })).status, 403, "a published zone is read by others, not changed");
  const stale = await call("owner", "PATCH", `/zones/${zone.id}`, { title: "旧修订", expectedRevision: zone.revision });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.match(JSON.stringify(stale.body), /evidence_revision_conflict/);
  const renamed = await call("owner", "PATCH", `/zones/${zone.id}`, { title: "改名后的专区", expectedRevision: published.body.data.zone.revision });
  assert.equal(renamed.body.data.zone.title, "改名后的专区");
  assert.equal((await call("owner", "POST", "/zones/preview", { definition: { type: "policy", keywords: [] } })).status, 400);
  assert.equal((await call("owner", "POST", `/zones/${zone.id}/items/abcdefabcdef/feedback`, { kind: "not-in" })).status, 404, "an item that does not exist");
  assert.deepEqual((await call("owner", "DELETE", `/zones/${zone.id}`)).body.data, { deleted: true });
  assert.equal((await call("owner", "PATCH", `/zones/${zone.id}`, { title: "没了", expectedRevision: 1 })).status, 404);
});

test("the old zone writes are unchanged: a name and a description still make an old zone", options, async () => {
  const made = await call("owner", "POST", "/zones", { title: "房颤抗凝", description: "d", background: "b" });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.data.zone.title, "房颤抗凝");
  const edited = await call("owner", "PATCH", `/zones/${made.body.data.zone.id}`, { title: "房颤抗凝 2", expectedRevision: made.body.data.zone.revision });
  assert.equal(edited.body.data.zone.title, "房颤抗凝 2", "a zone with no topic definition is edited by the older writer");
});

test("following something typed makes a zone of the words, and no follow", options, async () => {
  const answer = await call("owner", "POST", "/follows", { kind: "query", label: "长新冠 康复" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.data.follow, null);
  assert.equal(answer.body.data.zone.published, false);
  assert.equal(answer.body.data.zone.title, "长新冠 康复");
  const again = await call("owner", "POST", "/follows", { kind: "query", label: " 长新冠  康复 " });
  assert.equal(again.body.data.zone.id, answer.body.data.zone.id);
  const follows = await call("owner", "GET", "/follows");
  assert.deepEqual(follows.body.data.follows.filter((follow) => follow.kind === "query"), []);
  assert.equal((await call("owner", "POST", "/follows", { kind: "query", label: "x", muted: true })).status, 400);
});

test("the typed follows of before were turned into zones once at start, and the planner has its loop in the feed's worker", options, async () => {
  const { app } = context;
  const marker = await app.store.database.query("SELECT 1 FROM evimed_frontier.meta WHERE key = $1", [TYPED_FOLLOWS_MARKER]);
  assert.equal(marker.rowCount, 1);
  assert.ok(app.frontier.zonePlanner, "the planner is composed");
  assert.ok(app.frontier.zoneWrites && app.frontier.zoneDraft);
  const status = app.frontierWorker.status();
  assert.ok("zone-planner" in status.loops);
  assert.ok(status.zonePlanner.counters, "the worker reports the planner");
});
