// The co-creation routes in the real hosted app over HTTP, against a real PostgreSQL: who sees them, the CSRF check, the
// author page and a card's links as a reader gets them, continuing research from another account's card into the caller's
// own project (the library's own write path), and the counters on the operator's scrape — composed exactly as a
// deployment composes it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { memoryPlugin, pluginEntry, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const suffix = randomUUID().slice(0, 8);
const accounts = { author: `author${suffix}`, reader: `reader${suffix}`, outsider: `outsider${suffix}` };
const PASSWORD = "test-only-cocreation-password";
/** @type {any} */ let context = null;
/** @type {any} */ let isolated = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "cocreate");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-cocreate-app-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [pluginEntry("nejm", 1)] });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    // The audience is the preview list: two accounts are in it, the outsider is not.
    frontierEnabled: true, frontierAudience: "operators", frontierPreviewUsers: [accounts.author, accounts.reader],
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: plugin.fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} },
  });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  await app.frontierWorker.tick();
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

const call = async (role, method, pathname, body) => {
  const response = await fetch(`${context.base}${pathname}`, { method, headers: context.sessions[role], ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
};

test("the four routes need a session, the frontier audience and, to write, the CSRF token", options, async () => {
  const rv = `rv_${"a".repeat(64)}`;
  for (const [method, pathname] of [["POST", `/api/results/${rv}/evidence-card`], ["POST", "/api/frontier/evidence/ec_0123456789abcdef/continue"], ["POST", "/api/frontier/evidence/ec_0123456789abcdef/verify-sources"], ["GET", "/api/frontier/evidence/ec_0123456789abcdef/links"], ["GET", `/api/frontier/authors/${accounts.author}`]]) {
    assert.equal((await fetch(`${context.base}${pathname}`, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) })).status, 401, `${method} ${pathname}`);
    const outside = await call("outsider", method, pathname, method === "POST" ? {} : undefined);
    assert.equal(outside.status, 404, `${method} ${pathname}`);
    assert.equal(outside.body.code, "frontier_not_enabled");
  }
  const { "x-open-science-csrf": _csrf, ...withoutCsrf } = context.sessions.reader;
  const forged = await fetch(`${context.base}/api/frontier/evidence/ec_0123456789abcdef/continue`, { method: "POST", headers: withoutCsrf, body: "{}" });
  assert.equal(forged.status, 403);
});

test("having the platform read a card's sources is the owner's: another account's card, and one that is not there, are the same 404, and a GET is not the route", options, async () => {
  const zone = (await call("author", "POST", "/api/frontier/zones", { title: "Verify zone", description: "", background: "", requestId: "request-verify-zone" })).body.data.zone;
  const card = (await call("author", "POST", `/api/frontier/zones/${zone.id}/evidence`, { title: "A trial", subtype: "academic", summary: "s", body: "b", limitations: "l", provenance: "p",
    sources: [{ title: "Trial", excerpt: "Observed outcomes only the author typed." }], requestId: "request-verify-card" })).body.data.evidence;
  for (const id of [card.id, "ec_0123456789abcdef"]) {
    const refused = await call("reader", "POST", `/api/frontier/evidence/${id}/verify-sources`, {});
    assert.equal(refused.status, 404, id);
    assert.equal(refused.body.code, "evidence_not_found");
  }
  assert.equal((await call("author", "GET", `/api/frontier/evidence/${card.id}/verify-sources`)).status, 405);
  // The owner's own request: a source with no address has nothing to read, and the answer says so for that source alone.
  const own = await call("author", "POST", `/api/frontier/evidence/${card.id}/verify-sources`, {});
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.data.sources, [{ sourceIndex: 1, status: "no_address" }]);
  const scrape = await (await fetch(`${context.base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  assert.match(scrape, /^open_science_evidence_source_verifications_total\{outcome="nothing_to_read"\} 1$/m);
  assert.match(scrape, /^open_science_evidence_source_reads_total\{outcome="no_address"\} 1$/m);
});

test("a result that is not there is not found, and a result route with a bad body is refused by name", options, async () => {
  const rv = `rv_${"a".repeat(64)}`;
  const missing = await call("author", "POST", `/api/results/${rv}/evidence-card`, { projectId: "default", newZone: { title: "x" } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "result_version_unavailable");
  const invalid = await call("author", "POST", `/api/results/${rv}/evidence-card`, { projectId: "default" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "evidence_result_zone_required");
});

test("an author's page and a card's links as a reader gets them, and continuing from the card writes its sources into the reader's project", options, async () => {
  const created = await call("author", "POST", "/api/frontier/zones", { title: "Stroke research", description: "", background: "", requestId: "request-cocreate-zone" });
  const zone = created.body.data.zone;
  // Nothing is published yet: there is no page, and the answer is the one an id that is no account gets.
  assert.equal((await call("reader", "GET", `/api/frontier/authors/${accounts.author}`)).body.code, "evidence_author_not_found");
  assert.equal((await call("reader", "GET", `/api/frontier/authors/au_${"0".repeat(16)}`)).body.code, "evidence_author_not_found");
  await call("author", "PATCH", `/api/frontier/zones/${zone.id}`, { expectedRevision: zone.revision, state: "published" });
  const card = (await call("author", "POST", `/api/frontier/zones/${zone.id}/evidence`, {
    title: "Does the drug prevent stroke?", subtype: "academic", summary: "s", body: "b", limitations: "", requestId: "request-cocreate-card",
    sources: [{ title: "Trial A", url: "https://example.org/a", excerpt: "Among 100 adults on the drug, 7 had a stroke" }],
  })).body.data.evidence;
  // A draft card has no links for anyone else, and is not on the page of an author whose zone is published.
  assert.equal((await call("reader", "GET", `/api/frontier/evidence/${card.id}/links`)).status, 404);
  await call("author", "PATCH", `/api/frontier/zones/${zone.id}/evidence/${card.id}`, { expectedRevision: card.revision, state: "published" });
  // The author is named by an opaque handle, from the card's links on; the login name is not an address and is in no body.
  const links = (await call("reader", "GET", `/api/frontier/evidence/${card.id}/links`)).body.data;
  const handle = links.author.id;
  assert.match(handle, /^au_[a-f0-9]{16}$/);
  assert.deepEqual(links.author, { id: handle, name: accounts.author });
  assert.equal((await call("reader", "GET", `/api/frontier/authors/${accounts.author}`)).status, 404, "the account id is not an address");
  const page = await call("reader", "GET", `/api/frontier/authors/${handle}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(page.body.data.zones.map((entry) => entry.title), ["Stroke research"]);
  assert.deepEqual(page.body.data.cards.map((entry) => entry.id), [card.id]);
  assert.deepEqual(page.body.data.totals, { cards: 1, followers: 0, runsFromCards: 0 });
  assert.equal(page.body.data.author.platform, false);
  assert.equal(page.body.data.author.id, handle, "the page names its author by the handle too");
  assert.deepEqual(links.related, []);

  // 用这张卡继续研究: a new project of the reader's, the card's source in its knowledge base, the question unsent.
  const continued = await call("reader", "POST", `/api/frontier/evidence/${card.id}/continue`, {});
  if (continued.status === 404) {
    assert.equal(continued.body.code, "evidence_continue_unavailable", "where the knowledge base is not composed the refusal is named");
    return;
  }
  assert.equal(continued.status, 201);
  const answer = continued.body.data;
  assert.equal(answer.originCardId, card.id);
  assert.equal(answer.library.failed.length, 0);
  assert.equal(answer.library.saved.length, 1);
  assert.match(answer.draft, /> 证据卡：Does the drug prevent stroke\?/);
  const projects = await call("reader", "GET", "/api/projects");
  assert.ok(JSON.stringify(projects.body).includes(answer.projectId), "the project is the reader's own");
  const root = path.join(context.dataDir, "users", accounts.reader);
  const saved = await readdir(root, { recursive: true });
  const file = saved.find((entry) => String(entry).includes("knowledge-base/evidence/") && String(entry).endsWith(".md"));
  assert.ok(file, "the source was written into the reader's knowledge base");
  assert.match(await readFile(path.join(root, String(file)), "utf8"), /Among 100 adults on the drug/);
  // Another account cannot read it: the author's own project has nothing from this.
  assert.equal((await call("outsider", "POST", `/api/frontier/evidence/${card.id}/continue`, {})).status, 404);
});

test("the operator's scrape carries the co-creation counters, with the citation gift off", options, async () => {
  const text = await (await fetch(`${context.base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  assert.match(text, /^open_science_evidence_citation_gift_enabled 0$/m);
  assert.match(text, /^open_science_evidence_result_cards_total\{outcome="created"\} \d+$/m);
  assert.match(text, /^open_science_evidence_continuations_total\{outcome="started"\} \d+$/m);
  assert.match(text, /^open_science_evidence_card_runs_total\{by="others"\} \d+$/m);
});
