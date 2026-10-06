// The public base path in the real hosted app (flywheel review 2026-10-06, `OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH=/evimed-evidence`),
// composed as a deployment composes it, against a real PostgreSQL: every page kind, the API, the feed, the sitemap and the stylesheet are
// served under the configured base, every link in the markup and every absolute address in the feed and the sitemap uses it, and the
// other base — which on such a deployment belongs to another product — is not answered by these routes.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { authorHandlesFor } from "../src/evidenceAuthorHandles.mjs";
import { setEvidencePublicBase } from "../src/evidencePublicPaths.mjs";
import { createEvidenceChangeLog } from "../src/evidenceChangeLog.mjs";
import { memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const PASSWORD = "test-only-base-path-password";
const PUBLIC_URL = "https://www.evimed.test";
const BASE = "/evimed-evidence";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const OWNER = "base-owner";
const TEXT = "Among 100 adults on the drug, 7 had a stroke. Among 100 adults on usual care, 12 had a stroke.";
/** @type {any} */ let context = null;
/** @type {any} */ let isolated = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "basepath");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-base-path-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres",
    requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    frontierEnabled: true, frontierAudience: "all", evidencePublicWebEnabled: true, evidencePublicIndexable: true, publicUrl: PUBLIC_URL, evidencePublicRatePerMinute: 10_000,
    evidencePublicBasePath: BASE,
    evidenceSimulations: { list: async () => ({ items: [{ id: "sim-1", title: "Simulated trial", summary: "A model run.", createdAt: "2026-10-03T00:00:00Z" }], next: "more" }), get: async () => null },
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: memoryPlugin({ sources: [pluginSource("nejm")] }).fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} },
  });
  await app.store.createUser(OWNER, PASSWORD, "李明");
  const address = await app.listen(0, "127.0.0.1");
  await app.frontierWorker.tick();
  await app.frontierWorker.close();
  context = { app, base: `http://127.0.0.1:${address.port}`, dataDir };
});
after(async () => {
  setEvidencePublicBase("/evidence");
  if (!context) return;
  await context.app.close();
  await rm(context.dataDir, { recursive: true, force: true });
  await isolated?.drop();
});

/** Whether a body writes an address under the other base (the in-app reading page, `/app/frontier/zones/<id>/evidence/<id>`, is the app's). @param {string} body */
const writesOtherBase = (body) => /(?<!\/app\/frontier\/zones\/[A-Za-z0-9_-]+)\/evidence\//.test(body);

/** @param {string} pathname */
const get = async (pathname) => {
  const response = await fetch(`${context.base}${pathname}`, { headers: { "user-agent": BROWSER } });
  return { status: response.status, headers: response.headers, body: await response.text() };
};

test("with the base at /evimed-evidence the composed app serves every page kind, the API, the feed, the sitemap and the stylesheet under it, links and addresses use it, and /evidence/… is not answered", options, async () => {
  const zones = context.app.frontier.evidenceZones;
  const owner = { id: OWNER };
  const { zone } = await zones.save(owner, { title: "房颤抗凝", description: "房颤患者抗凝治疗的证据。", background: "背景" });
  const live = (await zones.save(owner, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
  const open = (await zones.setVisibility(owner, live.id, { visibility: "internet", expectedRevision: live.revision })).zone;
  const input = (/** @type {string} */ title) => ({
    title, subtype: "academic", summary: "摘要。", body: "正文", state: "published", limitations: "单项试验", provenance: "p",
    sources: [{ title: "试验", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT, documentText: TEXT, coverage: "full-text" }],
    content: { question: "能预防卒中吗？", answer: "卒中更少。", population: "成人" },
    claims: [{ claimId: "CLM-001", claimType: "direct", claim: "阿哌沙班组卒中更少。", sourceIndexes: [1], supportQuote: "Among 100 adults on the drug, 7 had a stroke" }],
    lineage: { resultVersionId: `rv_${"7".repeat(64)}` }, originality: "original_research",
  });
  // Three ✓ cards make the author established: the sitemap, the feed and the indexable pages all carry them.
  const cards = [];
  for (const name of ["一", "二", "三"]) cards.push((await zones.saveEditorial(owner, input(`卡片${name}`), open.id, null, true, "result")).evidence);
  await createEvidenceChangeLog({ database: context.app.store.database }).append({ zoneId: open.id, cardId: cards[0].id, category: "searched_no_change", trigger: "scheduled_check", facts: {} });
  const handle = /** @type {string} */ ((await authorHandlesFor(context.app.store.database, [OWNER])).get(OWNER));

  const pages = [
    `${BASE}/`, `${BASE}/about`, `${BASE}/metrics`, `${BASE}/simulations`, `${BASE}/requests`, `${BASE}/z/${open.id}`, `${BASE}/z/${open.id}/changes`,
    `${BASE}/c/${cards[0].id}`, `${BASE}/c/${cards[0].id}?view=public`, `${BASE}/a/${handle}`,
  ];
  for (const pathname of pages) {
    const answer = await get(pathname);
    assert.equal(answer.status, 200, pathname);
    assert.match(answer.headers.get("content-type") ?? "", /^text\/html/, pathname);
    assert.equal(writesOtherBase(answer.body), false, `${pathname} writes no /evidence/ address`);
    for (const [, href] of answer.body.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^https?:\/\//.test(href)) continue;
      assert.ok(href.startsWith(BASE) || href === "/login" || href.startsWith("/app/"), `${pathname}: ${href} is under the base`);
    }
    assert.ok(answer.body.includes(`href="${BASE}/assets/site.css"`), `${pathname}: the stylesheet link`);
  }
  const card = await get(`${BASE}/c/${cards[0].id}`);
  assert.ok(card.body.includes(`<link rel="canonical" href="${PUBLIC_URL}${BASE}/c/${cards[0].id}">`), "the canonical address is under the base");
  assert.ok(card.body.includes(`href="${BASE}/a/${handle}"`) && card.body.includes(`href="${BASE}/z/${open.id}"`) && card.body.includes(`href="${BASE}/c/${cards[0].id}?view=public"`));
  assert.ok((await get(`${BASE}/simulations`)).body.includes(`href="${BASE}/simulations/sim-1"`) && (await get(`${BASE}/simulations`)).body.includes(`${BASE}/simulations?cursor=more`));
  assert.equal((await get(`${BASE}/assets/site.css`)).status, 200);
  assert.equal((await fetch(`${context.base}${BASE}`, { redirect: "manual" })).headers.get("location"), `${BASE}/`);

  // The API: its own paths and the addresses inside its documents.
  for (const pathname of [`${BASE}/api/v1/zones`, `${BASE}/api/v1/zones/${open.id}`, `${BASE}/api/v1/zones/${open.id}/cards`, `${BASE}/api/v1/zones/${open.id}/changes`,
    `${BASE}/api/v1/cards/${cards[0].id}`, `${BASE}/api/v1/authors/${handle}`, `${BASE}/api/v1/metrics`]) {
    const answer = await get(pathname);
    assert.equal(answer.status, 200, pathname);
    assert.equal(writesOtherBase(answer.body), false, `${pathname} writes no /evidence/ address`);
  }
  const apiCard = JSON.parse((await get(`${BASE}/api/v1/cards/${cards[0].id}`)).body).data.card;
  assert.equal(apiCard.path, `${BASE}/c/${cards[0].id}`);
  assert.equal(apiCard.url, `${PUBLIC_URL}${BASE}/c/${cards[0].id}`);
  assert.equal(JSON.parse((await get(`${BASE}/api/v1/authors/${handle}`)).body).data.author.path, `${BASE}/a/${handle}`);

  // The feed and the sitemap: every absolute address is under the base.
  const feed = await get(`${BASE}/feed.json`);
  assert.equal(feed.status, 200);
  const items = JSON.parse(feed.body).items;
  assert.equal(items.length, 3);
  for (const item of items) assert.ok(item.url.startsWith(`${PUBLIC_URL}${BASE}/c/`), item.url);
  const rss = await get(`${BASE}/feed.xml`);
  assert.equal(rss.status, 200);
  assert.ok(rss.body.includes(`<link>${PUBLIC_URL}${BASE}/</link>`) && rss.body.includes(`<link>${PUBLIC_URL}${BASE}/c/`));
  assert.equal(writesOtherBase(rss.body), false);
  const sitemap = await get(`${BASE}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  const locations = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.ok(locations.length >= 8, "the static pages, the zone, the cards and the author");
  for (const location of locations) assert.ok(location.startsWith(`${PUBLIC_URL}${BASE}/`), location);
  for (const expected of [`/z/${open.id}`, `/c/${cards[2].id}`, `/a/${handle}`]) assert.ok(locations.includes(`${PUBLIC_URL}${BASE}${expected}`), expected);

  // The other member of the closed set is another product's on this deployment: none of these routes answers under it.
  for (const pathname of ["/evidence/", "/evidence/about", `/evidence/z/${open.id}`, `/evidence/c/${cards[0].id}`, `/evidence/a/${handle}`, "/evidence/api/v1/zones", "/evidence/sitemap.xml", "/evidence/assets/site.css", "/evidence/feed.json", "/evidence/feed.xml"]) {
    const answer = await get(pathname);
    assert.equal((answer.headers.get("content-security-policy") ?? "").startsWith("default-src 'none'; style-src 'self'"), false, `${pathname}: not the pages' own answer`);
    assert.equal(answer.body.includes("EviMed 证据中心"), false, `${pathname}: no page of ours`);
    assert.equal(answer.body.includes('"items"') && answer.body.includes("evimed-evidence-feed"), false, `${pathname}: no feed of ours`);
    assert.notEqual(answer.status, 200, `${pathname}: not served`);
  }

  // The operator can see which base is served, and the app tells its own page where the public pages are.
  const scrape = await (await fetch(`${context.base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  assert.match(scrape, /^open_science_evidence_public_base_path\{path="\/evimed-evidence"\} 1$/m);
  await context.app.store.createUser("base-reader", PASSWORD, "王芳");
  const login = await fetch(`${context.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "base-reader", password: PASSWORD }) });
  const csrf = (await login.json()).data.csrfToken;
  const status = await (await fetch(`${context.base}/api/frontier/status`, { headers: { cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": csrf } })).json();
  assert.equal(status.data.capabilities.evidencePublicPages, true);
  assert.equal(status.data.capabilities.evidencePublicBasePath, BASE);
});
