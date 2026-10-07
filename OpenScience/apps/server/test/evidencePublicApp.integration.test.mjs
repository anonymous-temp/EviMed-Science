// The public evidence pages in the real hosted app over HTTP, against a real PostgreSQL, composed exactly as a deployment composes them
// (flywheel F08, F27): every page kind is fetched with no session, the pages' own security headers win over the app's, the server's
// per-address limiter answers 429, the feed still answers beside them, the signed-in topic-request routes work through a real session
// with the CSRF check, and the operator's scrape carries the pages' counters.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { authorHandlesFor } from "../src/evidenceAuthorHandles.mjs";
import { createEvidenceChangeLog } from "../src/evidenceChangeLog.mjs";
import { memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const PASSWORD = "test-only-public-pages-password";
const PUBLIC_URL = "https://www.evimed.test";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const accounts = { owner: "pp-owner", reader: "pp-reader" };
const SIMULATIONS = [{ id: "sim-1", title: "Simulated trial", summary: "A model run.", createdAt: "2026-10-03T00:00:00Z", numbers: [{ label: "Hazard ratio", value: 0.8, valueSource: "predicted" }] }];
const TEXT = "Among 100 adults on the drug, 7 had a stroke. Among 100 adults on usual care, 12 had a stroke.";
/** @type {any} */ let context = null;
/** @type {any} */ let isolated = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "pubapp");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-public-app-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres",
    requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    frontierEnabled: true, frontierAudience: "all", evidencePublicWebEnabled: true, evidencePublicIndexable: true, publicUrl: PUBLIC_URL, evidencePublicRatePerMinute: 25,
    evidenceTopicRequestsPerDay: 2, evidenceSimulations: { list: async () => ({ items: SIMULATIONS, next: null }), get: async (/** @type {string} */ id) => SIMULATIONS.find((entry) => entry.id === id) ?? null },
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: memoryPlugin({ sources: [pluginSource("nejm")] }).fetchImpl,
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
  await context.app.close();
  await rm(context.dataDir, { recursive: true, force: true });
  await isolated?.drop();
});

/** A page as an anonymous browser gets it. @param {string} pathname @param {RequestInit} [init] */
const page = async (pathname, init = {}) => {
  const response = await fetch(`${context.base}${pathname}`, { ...init, headers: { "user-agent": BROWSER, ...(init.headers ?? {}) } });
  return { status: response.status, headers: response.headers, body: await response.text() };
};
const call = async (/** @type {string} */ role, /** @type {string} */ method, /** @type {string} */ pathname, /** @type {unknown} */ body) => {
  const response = await fetch(`${context.base}${pathname}`, { method, headers: context.sessions[role], ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) };
};

test("every page kind is fetched with no session through the real app, the pages' own headers win over the app's, and the API and the feed answer beside them", options, async () => {
  const zones = context.app.frontier.evidenceZones;
  const owner = { id: accounts.owner };
  const { zone } = await zones.save(owner, { title: "房颤抗凝", description: "房颤患者抗凝治疗的证据。", background: "背景" });
  const live = (await zones.save(owner, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
  const open = (await zones.setVisibility(owner, live.id, { visibility: "internet", expectedRevision: live.revision })).zone;
  const closed = (await zones.save(owner, { title: "仅平台可见", description: "", background: "" })).zone;
  const card = (await zones.saveEditorial(owner, {
    title: "阿哌沙班和卒中", subtype: "academic", summary: "摘要。", body: "正文", state: "published", limitations: "单项试验", provenance: "p",
    sources: [{ title: "试验", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT, documentText: TEXT, coverage: "full-text" }],
    content: { question: "能预防卒中吗？", answer: "卒中更少。", population: "成人", comparisons: [{ title: "卒中", outcome: "卒中", timeframe: "2 年", denominator: 100, control: { label: "常规治疗", events: 12 }, intervention: { label: "阿哌沙班", events: 7 }, outcomeRole: "benefit", sourceIndexes: [1] }] },
    claims: [{ claimId: "CLM-001", claimType: "direct", claim: "阿哌沙班组卒中更少。", sourceIndexes: [1], supportQuote: "Among 100 adults on the drug, 7 had a stroke" }],
    originality: "original_research",
  }, open.id, null, true, "result")).evidence;
  await createEvidenceChangeLog({ database: context.app.store.database }).append({ zoneId: open.id, cardId: card.id, category: "searched_no_change", trigger: "scheduled_check", facts: {} });
  const sessionless = { headers: {} };
  const ownerHandle = /** @type {string} */ ((await authorHandlesFor(context.app.store.database, [accounts.owner])).get(accounts.owner));

  const index = await page("/evidence/", sessionless);
  assert.equal(index.status, 200);
  assert.ok(index.body.includes("房颤抗凝") && !index.body.includes("仅平台可见"));
  for (const [pathname, needle] of [
    [`/evidence/z/${open.id}`, "阿哌沙班和卒中"], [`/evidence/z/${open.id}/changes`, "已重新检索，结论未变"], [`/evidence/c/${card.id}`, "结果总结（临床版）"], [`/evidence/c/${card.id}?view=public`, "事实框"],
    [`/evidence/a/${ownerHandle}`, "房颤抗凝"], ["/evidence/about", "钱买得到发布和分发，买不到排名和结论"], ["/evidence/metrics", "核验通过率"], ["/evidence/simulations", "Simulated trial"],
    ["/evidence/simulations/sim-1", "预测"], ["/evidence/requests", "选题申请"],
  ]) {
    const answer = await page(pathname);
    assert.equal(answer.status, 200, pathname);
    assert.ok(answer.body.includes(needle), `${pathname} carries ${needle}`);
    assert.match(answer.headers.get("content-type") ?? "", /^text\/html; charset=utf-8/);
    // The pages' policy replaced the app's: no inline script or style allowed, nothing connects, nothing frames.
    const policy = answer.headers.get("content-security-policy") ?? "";
    assert.equal(policy, "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", pathname);
    assert.equal(answer.headers.get("referrer-policy"), "strict-origin-when-cross-origin", pathname);
    assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
    assert.equal(answer.headers.get("set-cookie"), null, pathname);
  }
  assert.equal((await page(`/evidence/z/${closed.id}`)).status, 404, "a zone that is not published to the internet does not exist here");
  // The new author is indexable only at three ✓ cards: this one has one, so it opens but says noindex; indexing is on in this app.
  const robots = await page(`/evidence/c/${card.id}`);
  assert.equal(robots.headers.get("x-robots-tag"), "noindex");
  assert.ok(robots.body.includes(`<link rel="canonical" href="${PUBLIC_URL}/evidence/c/${card.id}">`));
  const sitemap = await page("/evidence/sitemap.xml");
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get("content-type") ?? "", /^application\/xml/);
  assert.ok(sitemap.body.includes(`${PUBLIC_URL}/evidence/`) && !sitemap.body.includes(card.id), "a new author's card is not in the sitemap");
  const css = await page("/evidence/assets/site.css");
  assert.equal(css.status, 200);
  assert.ok(css.body.includes("--accent:"));

  // The read-only API: CORS for anyone, and not the app's credentialed CORS beside it.
  const api = await fetch(`${context.base}/evidence/api/v1/zones/${open.id}/cards`, { headers: { origin: PUBLIC_URL } });
  assert.equal(api.status, 200);
  assert.equal(api.headers.get("access-control-allow-origin"), "*");
  assert.equal(api.headers.get("access-control-allow-credentials"), null, "a wildcard origin is never paired with credentials");
  assert.equal(api.headers.get("set-cookie"), null);
  assert.deepEqual((await api.json()).data.cards.map((entry) => entry.id), [card.id]);

  // The feed is the feed's, and still answers.
  assert.equal((await fetch(`${context.base}/evidence/feed.json`)).status, 200);
  assert.equal((await fetch(`${context.base}/evidence/feed.xml`)).status, 200);

  // The reads were counted, once per page view, and the operator's scrape carries the pages' counters.
  const reads = await context.app.store.database.query("SELECT card_id, reads FROM evimed_frontier.evidence_page_reads ORDER BY card_id");
  assert.deepEqual(reads.rows.map((row) => [row.card_id === "" ? "zone" : "card", row.reads]).sort(), [["card", 3], ["zone", 1]],
    "the card page was read three times (clinical, public, the noindex check) and the zone page once; the closed zone's 404, the change log and the API are not reads");
  const scrape = await (await fetch(`${context.base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  assert.match(scrape, /^open_science_evidence_public_requests_total\{kind="page"\} \d+$/m);
  assert.match(scrape, /^open_science_evidence_public_requests_total\{kind="api"\} \d+$/m);
  assert.match(scrape, /^open_science_evidence_public_page_reads_total\{outcome="counted"\} \d+$/m);
  assert.match(scrape, /^open_science_evidence_public_noindex_total\{reason="new_author"\} [1-9]\d*$/m);
  assert.match(scrape, /^open_science_evidence_topic_requests_total\{outcome="filed"\} 0$/m);
});

test("the topic requests need a session, the CSRF token and the frontier audience; filing and seconding count once per account and show on the public page", options, async () => {
  const route = "/api/frontier/evidence/topic-requests";
  assert.equal((await fetch(`${context.base}${route}`, { method: "POST", body: JSON.stringify({ title: "Anticoagulation after stroke" }), headers: { "content-type": "application/json" } })).status, 401);
  assert.equal((await fetch(`${context.base}${route}`)).status, 401);
  const { "x-open-science-csrf": _csrf, ...withoutCsrf } = context.sessions.owner;
  assert.equal((await fetch(`${context.base}${route}`, { method: "POST", headers: withoutCsrf, body: JSON.stringify({ title: "Anticoagulation after stroke" }) })).status, 403);
  const filed = await call("owner", "POST", route, { title: "Anticoagulation after stroke" });
  assert.equal(filed.status, 200);
  assert.equal(filed.body.data.filed, true);
  assert.equal(filed.body.data.request.requesters, 1);
  const id = filed.body.data.request.id;
  const seconded = await call("reader", "POST", `${route}/${id}/second`);
  assert.equal(seconded.status, 200);
  assert.equal(seconded.body.data.request.requesters, 2);
  assert.equal((await call("reader", "POST", `${route}/${id}/second`)).body.data.alreadySeconded, true, "one vote per account");
  assert.equal((await call("reader", "POST", route, { title: "x" })).body.code, "evidence_topic_request_invalid");
  assert.equal((await call("reader", "POST", `${route}/tr_${"0".repeat(32)}/second`)).body.code, "evidence_topic_request_not_found");
  const list = await call("reader", "GET", route);
  assert.deepEqual(list.body.data.items.map((item) => [item.title, item.requesters]), [["Anticoagulation after stroke", 2]]);
  assert.deepEqual(list.body.data.seconded, [id]);
  // The daily limit is the lever's: this app allows two new votes a day, the reader has used one.
  assert.equal((await call("reader", "POST", route, { title: "A second topic" })).status, 200);
  const over = await call("reader", "POST", route, { title: "A third topic" });
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "evidence_topic_request_limit");
  const publicPage = await page("/evidence/requests");
  assert.ok(publicPage.body.includes("Anticoagulation after stroke") && publicPage.body.includes("2 人申请"));
  assert.ok(publicPage.body.indexOf("Anticoagulation after stroke") < publicPage.body.indexOf("A second topic"), "ordered by requesters");
  assert.equal(publicPage.headers.get("x-robots-tag"), "noindex");
  const scrape = await (await fetch(`${context.base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  assert.match(scrape, /^open_science_evidence_topic_requests_total\{outcome="filed"\} 2$/m);
  assert.match(scrape, /^open_science_evidence_topic_requests_total\{outcome="refused_limit"\} 1$/m);
});

test("the server's own limiter keeps an address to its minute and answers 429 with Retry-After, apart from the API's limiter", options, async () => {
  let limited = null;
  for (let attempt = 0; attempt < 40 && !limited; attempt += 1) {
    const response = await page("/evidence/about");
    if (response.status === 429) limited = response;
  }
  assert.ok(limited, "the 25-a-minute lever limited an address that asked for more");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal(limited.headers.get("x-robots-tag"), "noindex");
  assert.ok(limited.body.includes("访问太频繁"));
  // The app's API is limited by its own rule and is not the pages' budget: a request to it is not refused by this one.
  assert.notEqual((await fetch(`${context.base}/api/health`)).status, 429);
});
