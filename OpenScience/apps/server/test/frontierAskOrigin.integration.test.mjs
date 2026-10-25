// A conversation opened from an item of 前沿动态 (c3-ask): the origin-reference route accepts the kind `frontier-item` beside
// `frontier-event`, names it with the server's own title read through the frontier service as the person's page reads it, and
// refuses an item that is not there, a source switched off, and anything that is not a public id — over HTTP, against a real
// PostgreSQL, composed as a deployment composes it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { insertItem, memoryPlugin, pluginEntry, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const account = `reader${randomUUID().slice(0, 8)}`;
const PASSWORD = "test-only-frontier-password";
/** @type {any} */
let context = null;
/** @type {any} */
let isolated = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "askorigin");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-frontier-ask-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [pluginEntry("nejm", 1)] });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    operatorUsers: [], frontierEnabled: true, frontierAudience: "all", knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile,
    knowledgePluginFetch: plugin.fetchImpl, frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} },
  });
  await app.store.createUser(account, PASSWORD, account);
  const address = await app.listen(0, "127.0.0.1");
  await app.frontierWorker.tick();
  await app.frontierWorker.close();
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: account, password: PASSWORD }) });
  const body = await login.json();
  const headers = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": body.data.csrfToken };
  context = { app, base, headers, dataDir };
});

after(async () => {
  if (!context) return;
  await context.app.store.database.query("DELETE FROM evimed_control.users WHERE id = $1", [account]);
  await context.app.close();
  await rm(context.dataDir, { recursive: true, force: true });
  await isolated?.drop();
});

/** @param {string} session @param {unknown} body */
async function put(session, body) {
  const response = await fetch(`${context.base}/api/research-sessions/${session}/origin-reference`, {
    method: "PUT", headers: context.headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test("an item is an origin: the title is the server's, read for this account, and the session keeps it", options, async () => {
  const database = context.app.store.database;
  const item = await insertItem(database, { title: "Oral PCSK9 Inhibition", titleZh: "口服 PCSK9 抑制剂的心血管结局", sourceId: "nejm" });
  const answer = await put("ses_ask_item", { kind: "frontier-item", id: item.publicId, title: "A title the page made up" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body.data.originReference, { kind: "frontier-item", id: item.publicId, title: "口服 PCSK9 抑制剂的心血管结局" });
  const scope = await (await fetch(`${context.base}/api/research-sessions/ses_ask_item/source-scope`, { headers: context.headers })).json();
  assert.deepEqual(scope.data.originReference, { kind: "frontier-item", id: item.publicId, title: "口服 PCSK9 抑制剂的心血管结局" },
    "the composer's chip reads the reference back from the session");
});

test("an item that is not there, from a source switched off, or withdrawn is no origin", options, async () => {
  const database = context.app.store.database;
  assert.deepEqual([(await put("ses_ask_none", { kind: "frontier-item", id: "zzzzzzzzzzzzzz", title: "x" })).status,
    (await put("ses_ask_none", { kind: "frontier-item", id: "zzzzzzzzzzzzzz", title: "x" })).body.code], [404, "frontier_item_not_found"]);
  const withdrawn = await insertItem(database, { title: "Withdrawn", state: "withdrawn" });
  assert.equal((await put("ses_ask_none", { kind: "frontier-item", id: withdrawn.publicId, title: "x" })).status, 404);
  await database.query("UPDATE evimed_frontier.sources SET enabled = false WHERE id = 'nejm'");
  try {
    const off = await insertItem(database, { title: "From a source switched off" });
    assert.equal((await put("ses_ask_none", { kind: "frontier-item", id: off.publicId, title: "x" })).status, 404);
  } finally {
    await database.query("UPDATE evimed_frontier.sources SET enabled = true WHERE id = 'nejm'");
  }
  const scope = await (await fetch(`${context.base}/api/research-sessions/ses_ask_none/source-scope`, { headers: context.headers })).json();
  assert.equal(scope.data.originReference, null, "a refused origin leaves the session with none");
});

test("another kind, a malformed id and a body that is not an object are refused before the feed is asked; an event is still an origin kind", options, async () => {
  for (const body of [{ kind: "frontier-topic", id: "k7q2m9x4t1b8" }, { kind: "frontier-item", id: "short" }, { kind: "frontier-item", id: "K7Q2M9X4T1B8" },
    { kind: "frontier-item" }, { id: "k7q2m9x4t1b8" }]) {
    const answer = await put("ses_ask_bad", body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body.code, "invalid_request", JSON.stringify(body));
  }
  for (const body of [null, "frontier-item", [1]]) assert.equal((await put("ses_ask_bad", body)).status, 400, JSON.stringify(body));
  const event = await put("ses_ask_bad", { kind: "frontier-event", id: "e0123456789abcde", title: "x" });
  assert.equal(event.status, 404, "an event that is not there is still refused by name");
  assert.equal(event.body.code, "frontier_event_not_found");
});
