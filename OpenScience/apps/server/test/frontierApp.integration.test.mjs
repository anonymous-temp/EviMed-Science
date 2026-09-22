// The frontier module in the real hosted app over HTTP, against a real
// PostgreSQL: who sees it, the CSRF check on writes, 304s over the wire, the
// readiness check and the metrics — composed exactly as a deployment composes it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { insertItem, insertSource, memoryPlugin, pluginEntry, pluginSource } from "./helpers/frontierFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const suffix = randomUUID().slice(0, 8);
const accounts = { operator: `ops${suffix}`, preview: `preview${suffix}`, reader: `reader${suffix}` };
const PASSWORD = "test-only-frontier-password";
let context = null;

before(async () => {
  if (!databaseUrl) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-frontier-app-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [pluginEntry("nejm", 1), pluginEntry("nejm", 2)] });
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl, operatorMetricsToken: "test-only-metrics-token",
    operatorUsers: [accounts.operator], frontierEnabled: true, frontierAudience: "operators", frontierPreviewUsers: [accounts.preview],
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: plugin.fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} } });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  // Drive the worker by hand from here: one tick makes the owner's project and
  // pulls the stream, and nothing else moves the tables under the assertions.
  await app.frontierWorker.tick();
  await app.frontierWorker.close();
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [role, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: id, password: PASSWORD }) });
    const body = await login.json();
    sessions[role] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0],
      "x-open-science-csrf": body.data.csrfToken };
  }
  context = { app, base, sessions, plugin, dataDir };
});

after(async () => {
  if (!context) return;
  await context.app.store.database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [Object.values(accounts)]);
  await context.app.close();
  await rm(context.dataDir, { recursive: true, force: true });
});

test("one tick of the composed worker made the owner's project and pulled the plugin's stream", options, async () => {
  const { app } = context;
  const project = await app.store.database.query("SELECT name FROM evimed_control.projects WHERE user_id=$1 AND id='evimed-frontier'", [accounts.operator]);
  assert.equal(project.rows[0]?.name, "EviMed 前沿动态");
  assert.deepEqual(app.frontier.editor.owner, { userId: accounts.operator, projectId: "evimed-frontier" });
  const entries = await app.store.database.query("SELECT count(*)::integer AS n FROM evimed_frontier.entries WHERE source_id='nejm'");
  assert.equal(entries.rows[0].n, 2);
  // The internal project never shows in the operator's own list.
  const me = await (await fetch(`${context.base}/api/me`, { headers: context.sessions.operator })).json();
  assert.equal(me.data.projects.some((entry) => entry.id === "evimed-frontier"), false);
  assert.equal(me.data.features.frontier, true);
});

test("under the operators audience, a reader gets the same 404 a URL that never existed gets; operators and the preview list see it", options, async () => {
  const { base, sessions } = context;
  const reader = await fetch(`${base}/api/frontier/status`, { headers: sessions.reader });
  assert.equal(reader.status, 404);
  assert.equal((await reader.json()).code, "frontier_not_enabled");
  assert.equal((await (await fetch(`${base}/api/me`, { headers: sessions.reader })).json()).data.features.frontier, false);
  for (const role of ["operator", "preview"]) {
    const answer = await fetch(`${base}/api/frontier/status`, { headers: sessions[role] });
    assert.equal(answer.status, 200, role);
    const body = await answer.json();
    assert.equal(body.data.audience, "operators");
    assert.equal(body.data.plugin.state, "ok");
    assert.equal(answer.headers.get("cache-control"), "private, no-cache");
  }
  const anonymous = await fetch(`${base}/api/frontier/status`);
  assert.equal(anonymous.status, 401);
});

test("a list over the wire: ETag, a 304 for the same tag, and a star that needs the CSRF token", options, async () => {
  const { app, base, sessions } = context;
  await insertSource(app.store.database, "nejm");
  const item = await insertItem(app.store.database, { selected: true, title: "Wire test", timelineAt: new Date().toISOString(), visibleAt: new Date().toISOString() });
  const first = await fetch(`${base}/api/frontier/items`, { headers: sessions.preview });
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.match(String(etag), /^W\/"\d+\.\d+\.[a-f0-9]{16}"$/);
  const page = await first.json();
  assert.ok(page.data.items.some((entry) => entry.id === item.publicId));
  const again = await fetch(`${base}/api/frontier/items`, { headers: { ...sessions.preview, "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");

  const { "x-open-science-csrf": _csrf, ...withoutCsrf } = sessions.preview;
  const forged = await fetch(`${base}/api/frontier/items/${item.publicId}/star`, { method: "POST", headers: withoutCsrf, body: "{}" });
  assert.equal(forged.status, 403);
  const star = await fetch(`${base}/api/frontier/items/${item.publicId}/star`, { method: "POST", headers: sessions.preview, body: "{}" });
  assert.equal(star.status, 200);
  assert.deepEqual((await star.json()).data.state, { starred: true, hidden: false, read: false });
  const changed = await fetch(`${base}/api/frontier/items`, { headers: { ...sessions.preview, "if-none-match": etag } });
  assert.equal(changed.status, 200, "a star moves the reader's tag");

  const ops = await fetch(`${base}/api/frontier/ops/items/${item.publicId}/pin`, { method: "POST", headers: sessions.preview, body: "{}" });
  assert.equal(ops.status, 403, "the preview list sees the feed; it does not operate it");
  const withdrawn = await fetch(`${base}/api/frontier/ops/items/${item.publicId}/withdraw`, { method: "POST", headers: sessions.operator,
    body: JSON.stringify({ reason: "Test withdrawal" }) });
  assert.equal(withdrawn.status, 200);
  const gone = await fetch(`${base}/api/frontier/items/${item.publicId}`, { headers: sessions.operator });
  assert.equal(gone.status, 404);
});

test("readiness carries a green frontier check, and a plugin that goes away is a warning, never red", options, async () => {
  const { app, base, plugin } = context;
  const ready = await (await fetch(`${base}/api/ready`)).json();
  const check = ready.data.checks.frontier;
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.required, true);
  assert.equal(check.plugin.state, "ok");
  assert.equal(check.warning, undefined);

  plugin.down = true;
  app.frontier.ingest.backoffUntil = 0;
  await app.frontier.ingest.pull().catch(() => null);
  const degraded = (await (await fetch(`${base}/api/ready`)).json()).data.checks.frontier;
  assert.equal(degraded.ok, true, "an unreachable plugin must never turn readiness red");
  assert.equal(degraded.warning, "frontier_plugin_unreachable");
  plugin.down = false;
  app.frontier.ingest.backoffUntil = 0;
  await app.frontier.ingest.pull();
});

test("the metrics carry the module's families", options, async () => {
  const { base } = context;
  const text = await (await fetch(`${base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  for (const family of ["open_science_frontier_enabled 1", "open_science_frontier_plugin_state{state=\"ok\"} 1", "open_science_frontier_pulls_total",
    "open_science_frontier_entries{state=\"received\"}", "open_science_frontier_items_published_today", "open_science_frontier_budget_limit_cny",
    "open_science_frontier_unknown_vocabulary_total", "open_science_frontier_plugin_compatible{contract=\"1.0.0\"} 1",
    "open_science_readiness_check{check=\"frontier\",code=\"ok\"} 1"]) {
    assert.ok(text.includes(family), `${family} is missing from the metrics`);
  }
});
