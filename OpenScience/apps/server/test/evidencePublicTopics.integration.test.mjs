// The platform's topic zones on the public pages (plan 2026-10-29 §4.7, §6.9), against a real PostgreSQL and over HTTP: what is public
// (the platform's zones only, never a reader's), the page — 最新进展 with numbered references to the originals, 重要更新, the last thirty
// days as a title, a 导读 and a link, no body — its structured data, its canonical address and alias, the content floor, the sitemap's
// agreement with the page, the index by specialty and group, and each zone's feed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { createEvidencePublicRoutes } from "../src/evidencePublicRoutes.mjs";
import { rfc822Beijing, topicZoneJsonLd, topicZoneRss } from "../src/evidencePublicTopicPages.mjs";
import { topicIndexable, topicModified } from "../src/evidencePublicTopicReads.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { sendError } from "../src/security.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const PUBLIC_URL = "https://www.evimed.test";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const NOW = new Date("2026-10-29T04:00:00Z");
const ago = (/** @type {number} */ days, hours = 0) => new Date(NOW.getTime() - (days * 24 + hours) * 3_600_000).toISOString();

/** @type {any} */ let isolated;
/** @type {any} */ let db;
/** @type {Record<string, { id: string, publicId: string }>} */
const items = {};

/**
 * A zone row as the planner and the membership module leave one.
 * @param {Record<string, any>} zone
 */
async function addZone(zone) {
  const row = { owner: "pub", kind: "official", state: "published", visibility: "internet", lifecycle: "active", slug: null, specialties: ["endocrinology"], group: "肥胖", scope: "GLP-1 受体激动剂用于减重的疗效、安全性和获批情况。",
    keywords: [{ label: "GLP-1 受体激动剂", terms: ["GLP-1"], tagIds: [], entityKeys: [] }, { label: "减重", terms: ["减重"], tagIds: [], entityKeys: [] }],
    stats: null, overview: null, overviewAt: null, createdAt: ago(20), ...zone };
  const definition = row.lifecycle === "none" ? null : { version: 1, type: "drug-indication", keywords: row.keywords, perspective: null, scope: row.scope, include: "", exclude: "", excludeTerms: [], specialties: row.specialties, group: row.group, seeds: { positive: [], negative: [] } };
  await db.query(`INSERT INTO evimed_frontier.evidence_zones (id, user_id, title, state, kind, visibility, slug, zone_type, specialties, group_label, scope_zh, description, definition,
      definition_version, lifecycle, stats, overview, overview_at, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'drug-indication',$8,$9,$10,$10,$11::jsonb,1,$12,$13::jsonb,$14::jsonb,$15,$16,$16)`,
  [row.id, row.owner, row.title, row.state, row.kind, row.visibility, row.slug, row.specialties, row.group, row.scope, definition ? JSON.stringify(definition) : null, row.lifecycle,
    row.stats ? JSON.stringify(row.stats) : null, row.overview ? JSON.stringify(row.overview) : null, row.overviewAt, row.createdAt]);
}

/**
 * A published item in a zone.
 * @param {string} name @param {{ zone?: string | null, days?: number, hours?: number, state?: string, relevance?: string | null, verification?: string, flags?: string[], genre?: string | null,
 *   event?: number | null, practice?: boolean, sourceId?: string }} [spec]
 */
async function addItem(name, { zone = "ez_glp1weight", days = 1, hours = 0, state = "in", relevance = "core", verification = "passed", flags = [], genre = "paper", event = null, practice = false, sourceId = "nejm" } = {}) {
  const found = await insertItem(db, { title: `${name} (raw)`, titleZh: name, summaryZh: `${name}的导读。`, verification, flags, sourceId, visibleAt: ago(days, hours), timelineAt: ago(days, hours), publishedAt: ago(days, hours),
    abstract: "THE-FULL-ABSTRACT-THAT-MUST-NOT-LEAVE", selected: true });
  await db.query("UPDATE evimed_frontier.items SET genre = $2, event_id = $3, practice_changing = $4 WHERE id = $1", [found.id, genre, event, practice]);
  await db.query("UPDATE evimed_frontier.item_texts SET model_input = 'THE-MODEL-INPUT-THAT-MUST-NOT-LEAVE' WHERE item_id = $1", [found.id]);
  items[name] = found;
  if (zone) {
    await db.query(`INSERT INTO evimed_frontier.zone_items (zone_id, item_id, state, relevance, via, role, definition_version) VALUES ($1,$2,$3,$4,'tag',$5,1)`,
      [zone, found.id, state, state === "in" || state === "pinned" ? relevance : null, genre === "guideline" ? "guideline" : genre === "approval" ? "approval" : "research"]);
  }
  return found;
}

/** The router in front of a real HTTP server. @param {import("node:test").TestContext} t @param {Record<string, any>} [config] */
async function serve(t, config = {}) {
  const routes = createEvidencePublicRoutes({ config: { evidencePublicWebEnabled: true, publicUrl: PUBLIC_URL, ...config }, database: db, now: () => NOW });
  const server = createServer((req, res) => {
    routes(req, res).then((handled) => { if (!handled) { res.writeHead(418); res.end("not the pages'"); } }, (error) => sendError(res, error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = /** @type {any} */ (server.address());
  const text = async (/** @type {string} */ path) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { "user-agent": BROWSER } });
    return { status: response.status, headers: response.headers, body: await response.text() };
  };
  return { text };
}
const jsonLd = (/** @type {string} */ body) => JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(body)?.[1] ?? "null");

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "ezpublic");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('pub','EviMed 证据中心','development'),('alice','Alice','development')");
  await insertSource(db, "nejm", { name: "NEJM", owner_entity: "nejm-publisher" });
  await insertSource(db, "lancet", { name: "Lancet", owner_entity: "lancet-publisher" });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones, evimed_frontier.items, evimed_frontier.tags CASCADE");
  for (const key of Object.keys(items)) delete items[key];
});

// ───────────────────────── pure parts ─────────────────────────

test("a topic zone page may be indexed at five items in thirty days or with a 最新进展, and it changed when its paragraph or a key update did", () => {
  assert.equal(topicIndexable({ month: 4, hasProgress: false }), false);
  assert.equal(topicIndexable({ month: 5, hasProgress: false }), true);
  assert.equal(topicIndexable({ month: 0, hasProgress: true }), true);
  assert.equal(topicModified({ progressAt: "2026-10-28T01:00:00Z", keyUpdateAt: "2026-10-27T01:00:00Z", createdAt: "2026-10-01T00:00:00Z" }), "2026-10-28T01:00:00Z");
  assert.equal(topicModified({ progressAt: null, keyUpdateAt: "2026-10-27T01:00:00Z", createdAt: "2026-10-01T00:00:00Z" }), "2026-10-27T01:00:00Z");
  assert.equal(topicModified({ progressAt: null, keyUpdateAt: null, createdAt: "2026-10-01T00:00:00Z" }), "2026-10-01T00:00:00Z", "an ordinary item moves nothing");
  assert.equal(rfc822Beijing("2026-10-29T00:30:00Z"), "Thu, 29 Oct 2026 08:30:00 +0800");
});

test("the structured data is made from the page's own view model, escapes what could close its block, and is a collection page, a medical page, a breadcrumb and a list", () => {
  const zone = { id: "ez_abcdefgh", slug: "glp1", title: "GLP-1 </script> 减重", scope: "范围", specialty: { key: "endocrinology", label: "内分泌" }, group: "肥胖", modified: "2026-10-28T01:00:00.000Z",
    keywords: [{ label: "糖尿病", tagIds: [1] }, { label: "司美格鲁肽", tagIds: [2] }, { label: "减重", tagIds: [] }] };
  const tags = new Map([["糖尿病", { kind: "disease", nameEn: "Diabetes Mellitus", meshUi: "D003920" }], ["司美格鲁肽", { kind: "drug", nameEn: "semaglutide", meshUi: null }]]);
  const data = topicZoneJsonLd({ zone: /** @type {any} */ (zone), items: [{ title: "标题一", url: "https://nejm.org/a" }, { title: "没有地址", url: "" }], keywords: zone.keywords, publicUrl: PUBLIC_URL, tags });
  const [page, crumbs, list] = data["@graph"];
  assert.deepEqual(page["@type"], ["CollectionPage", "MedicalWebPage"]);
  assert.equal(page.url, "https://www.evimed.test/evidence/z/ez_abcdefgh");
  assert.equal(page.dateModified, "2026-10-28T01:00:00.000Z");
  assert.deepEqual(page.about, [
    { "@type": "MedicalCondition", name: "糖尿病", alternateName: "Diabetes Mellitus", code: { "@type": "MedicalCode", codeValue: "D003920", codingSystem: "MeSH" } },
    { "@type": "Drug", name: "司美格鲁肽", alternateName: "semaglutide" },
    { "@type": "Thing", name: "减重" },
  ]);
  assert.deepEqual(crumbs.itemListElement.map((entry) => [entry.position, entry.name, entry.item ?? null]), [[1, "EviMed 证据中心", "https://www.evimed.test/evidence/"], [2, "内分泌", null], [3, "肥胖", null], [4, "GLP-1 </script> 减重", "https://www.evimed.test/evidence/z/ez_abcdefgh"]]);
  assert.deepEqual(list.itemListElement, [{ "@type": "ListItem", position: 1, name: "标题一", url: "https://nejm.org/a" }], "an item with no address is not listed");
  assert.equal(JSON.stringify(data).includes("ClaimReview"), false);
});

test("the feed is RSS 2.0 with Beijing dates, a link to each original and a title of its own", () => {
  const rss = topicZoneRss({ zone: /** @type {any} */ ({ id: "ez_abcdefgh", title: "GLP-1 & 减重", scope: "范围" }), generatedAt: NOW, publicUrl: PUBLIC_URL, items: [
    { id: "p1", title: "标题 <一>", guide: "导读 & 一句话", source: "NEJM", url: "https://nejm.org/a?x=1&y=2", at: "2026-10-28T23:30:00Z" },
    { id: "p2", title: "无导读", guide: null, source: "Lancet", url: "javascript:alert(1)", at: null },
  ] });
  assert.match(rss, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="2.0"/);
  assert.match(rss, /<title>GLP-1 &amp; 减重 · EviMed 证据中心<\/title>/);
  assert.match(rss, /<lastBuildDate>Thu, 29 Oct 2026 12:00:00 \+0800<\/lastBuildDate>/);
  assert.match(rss, /<link>https:\/\/nejm\.org\/a\?x=1&amp;y=2<\/link>/);
  assert.match(rss, /<pubDate>Thu, 29 Oct 2026 07:30:00 \+0800<\/pubDate>/);
  assert.match(rss, /<description>导读 &amp; 一句话（来源：NEJM）<\/description>/);
  assert.equal(rss.includes("javascript:"), false, "an address that is not http(s) is not a link");
  assert.match(rss, /<guid isPermaLink="false">evimed-item:p2<\/guid>/);
});

// ───────────────────────── the page ─────────────────────────

/** The full public zone the page tests read. */
async function glpZone(extra = {}) {
  await addZone({ id: "ez_glp1weight", title: "GLP-1 受体激动剂减重", slug: "glp1-weight", ...extra });
}

test("a platform topic zone is a page: its keywords and scope, 最新进展 with numbered references to the originals, 重要更新 and the last thirty days as titles, 导读 and links — never a body", options, async (t) => {
  await db.query(`INSERT INTO evimed_frontier.tags (slug, name, name_en, kind, specialties, mesh_ui, state, origin) VALUES
    ('glp1-ra', 'GLP-1 受体激动剂', 'GLP-1 receptor agonists', 'drug-class', '{}', NULL, 'active', 'seed'),
    ('obesity', '肥胖', 'Obesity', 'disease', '{}', 'D009765', 'active', 'seed')`);
  const tagIds = (await db.query("SELECT id, slug FROM evimed_frontier.tags ORDER BY slug")).rows;
  const idOf = (/** @type {string} */ slug) => Number(tagIds.find((row) => row.slug === slug).id);
  await glpZone({
    keywords: [{ label: "GLP-1 受体激动剂", terms: ["GLP-1"], tagIds: [idOf("glp1-ra")], entityKeys: [] }, { label: "肥胖", terms: ["肥胖"], tagIds: [idOf("obesity")], entityKeys: [] }],
  });
  const approval = await addItem("FDA 批准司美格鲁肽新适应症", { days: 2, genre: "approval", verification: "passed" });
  const guideline = await addItem("肥胖诊疗指南更新", { days: 5, genre: "guideline" });
  for (let n = 1; n <= 6; n += 1) await addItem(`随机对照试验 ${n}`, { days: 3 + n });
  await addItem("只是相关", { days: 2, relevance: "related" });
  await addItem("超过三十天", { days: 40 });
  await addItem("被排除", { days: 2, state: "excluded" });
  await addItem("撤稿的论文", { days: 4, flags: ["retracted"] });
  await addItem("导读没通过核对", { days: 1, hours: 3, verification: "title-only" });
  await db.query("UPDATE evimed_frontier.evidence_zones SET stats = $1::jsonb, overview = $2::jsonb, overview_at = $3 WHERE id = 'ez_glp1weight'", [
    JSON.stringify({ week: 4, month: 12, all: 40, perWeek: 3, keyLatest: { at: ago(2) }, latest: { at: ago(1) } }),
    JSON.stringify({ text: "FDA 批准司美格鲁肽用于新的适应症 [1]；肥胖诊疗指南同步更新 [2]。没有对应的标注 [9]。", refs: [{ n: 1, itemId: approval.publicId }, { n: 2, itemId: guideline.publicId }] }),
    ago(0, 2)]);
  const { text } = await serve(t, { evidencePublicIndexable: true });
  const page = await text("/evidence/z/ez_glp1weight");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-robots-tag"), null, "indexable: nothing said");
  const body = page.body;
  assert.match(body, /<title>GLP-1 受体激动剂减重 · EviMed 证据中心<\/title>/);
  assert.match(body, /<h1>GLP-1 受体激动剂减重<\/h1>/);
  assert.match(body, /关键词：GLP-1 受体激动剂 × 肥胖/);
  assert.match(body, /GLP-1 受体激动剂用于减重的疗效、安全性和获批情况。/);
  assert.match(body, /出品方：<\/strong>EviMed 证据中心/);
  // 最新进展: numbered marks link to the references; a mark with no reference stays text; the references link to the originals.
  assert.match(body, /<h2 id="progress">最新进展<\/h2>/);
  assert.match(body, /<a href="#ref-1">\[1\]<\/a>/);
  assert.match(body, /<a href="#ref-2">\[2\]<\/a>/);
  assert.equal(body.includes('href="#ref-9"'), false);
  assert.match(body, /没有对应的标注 \[9\]/);
  assert.match(body, /<li id="ref-1">FDA 批准司美格鲁肽新适应症（NEJM）<a href="https:\/\/nejm\.example\.org\/[^"]+" rel="nofollow noopener noreferrer" target="_blank">原文<\/a><\/li>/);
  assert.match(body, /截至 <time datetime="[^"]+">2026-10-29<\/time>（北京时间）/);
  // 重要更新 (the approval, the guideline and the retraction) then the list: titles, one-line 导读, the original; core items of thirty days only.
  assert.match(body, /<h2 id="key-updates">重要更新<\/h2>[\s\S]*FDA 批准司美格鲁肽新适应症[\s\S]*肥胖诊疗指南更新/);
  assert.match(body, /<h2 id="latest">最近 30 天的动态<\/h2>/);
  assert.match(body, /随机对照试验 1的导读。/);
  assert.match(body, /撤稿的论文<\/h3>|撤稿的论文 <span class="badge danger">已撤稿<\/span>/);
  for (const absent of ["只是相关", "超过三十天", "被排除", "THE-FULL-ABSTRACT-THAT-MUST-NOT-LEAVE", "THE-MODEL-INPUT-THAT-MUST-NOT-LEAVE"]) assert.equal(body.includes(absent), false, absent);
  assert.match(body, /导读没通过核对<\/h3>\s*<p class="meta">/, "an item whose 导读 was not verified is its title and its link");
  assert.equal(body.includes("导读没通过核对的导读"), false);
  assert.match(body, /<a href="\/evidence\/z\/ez_glp1weight\/feed\.xml">订阅这个专区<\/a>/);
  assert.match(body, /<link rel="alternate" type="application\/rss\+xml" title="GLP-1 受体激动剂减重 · EviMed 证据中心" href="\/evidence\/z\/ez_glp1weight\/feed\.xml">/);
  // The structured data: the page's own, with the MeSH code of the keyword whose tag has one, and the date the sitemap will carry.
  const data = jsonLd(body);
  const [web, crumbs, list] = data["@graph"];
  assert.deepEqual(web.about.map((entry) => [entry["@type"], entry.name, entry.code?.codeValue ?? null]), [["Drug", "GLP-1 受体激动剂", null], ["MedicalCondition", "肥胖", "D009765"]]);
  assert.equal(web.url, `${PUBLIC_URL}/evidence/z/ez_glp1weight`);
  assert.equal(web.dateModified, new Date(ago(0, 2)).toISOString(), "the later of the paragraph and the last key update");
  assert.deepEqual(crumbs.itemListElement.map((entry) => entry.name), ["EviMed 证据中心", "内分泌代谢", "肥胖", "GLP-1 受体激动剂减重"]);
  assert.ok(list.itemListElement.length >= 9 && list.itemListElement.every((entry) => /^https:\/\//.test(entry.url)));
  assert.match(body, /<link rel="canonical" href="https:\/\/www\.evimed\.test\/evidence\/z\/ez_glp1weight">/);
  assert.match(body, /<meta name="AIGC" content="[^"]+ez_glp1weight@/, "a paragraph a model wrote carries the implicit AI-content label");
  assert.match(body, /<meta name="description" content="FDA 批准司美格鲁肽用于新的适应症；肥胖诊疗指南同步更新。没有对应的标注 ?[^"]*">/);
  assert.equal(body.includes("<script>") || /<script(?![^>]*ld\+json)/.test(body), false, "the only script block is the data");
  // The sitemap says the same date.
  const sitemap = await text("/evidence/sitemap.xml");
  assert.match(sitemap.body, new RegExp(`<loc>${PUBLIC_URL}/evidence/z/ez_glp1weight</loc><lastmod>${new Date(ago(0, 2)).toISOString()}</lastmod>`));
  assert.equal(sitemap.body.includes("/z/s/glp1-weight"), false, "one address in the sitemap: the alias is not listed");
});

test("the readable alias says the same page and names the id's address as canonical; the feed answers at both", options, async (t) => {
  await glpZone({ stats: { week: 1, month: 6, all: 6, perWeek: 1 } });
  for (let n = 0; n < 6; n += 1) await addItem(`动态 ${n}`, { days: 1 + n });
  const { text } = await serve(t, { evidencePublicIndexable: true });
  const alias = await text("/evidence/z/s/glp1-weight");
  assert.equal(alias.status, 200);
  assert.match(alias.body, /<link rel="canonical" href="https:\/\/www\.evimed\.test\/evidence\/z\/ez_glp1weight">/);
  assert.match(alias.body, /<h1>GLP-1 受体激动剂减重<\/h1>/);
  const byId = await text("/evidence/z/ez_glp1weight/feed.xml");
  const bySlug = await text("/evidence/z/s/glp1-weight/feed.xml");
  assert.equal(byId.status, 200);
  assert.match(byId.headers.get("content-type") ?? "", /^application\/rss\+xml/);
  assert.equal(byId.body, bySlug.body.replace(/<lastBuildDate>.*<\/lastBuildDate>/, (line) => line), "the same feed");
  assert.equal((byId.body.match(/<item>/g) ?? []).length, 6);
  assert.match(byId.body, /<link>https:\/\/nejm\.example\.org\//);
  assert.equal((await text("/evidence/z/s/unknown-zone")).status, 404);
  assert.equal((await text("/evidence/z/s/unknown-zone/feed.xml")).status, 404);
});

test("only the platform's topic zones are public: a reader's zone is not, however it was opened; neither is a draft, a zone kept to the platform or a zone of cards by this route", options, async (t) => {
  await addZone({ id: "ez_readerzone1", title: "读者的专区", owner: "alice", kind: "user", slug: "readers", visibility: "internet" });
  await addZone({ id: "ez_draftzone01", title: "草稿专区", state: "draft", slug: "draft-zone" });
  await addZone({ id: "ez_platformonly", title: "仅平台内", visibility: "platform", slug: "platform-only" });
  await addZone({ id: "ez_cardzone001", title: "卡片专区", lifecycle: "none", slug: null });
  await addItem("读者专区里的动态", { zone: "ez_readerzone1" });
  const { text } = await serve(t, { evidencePublicIndexable: true });
  const missing = await text("/evidence/z/ez_neverexisted");
  assert.equal(missing.status, 404);
  for (const path of ["/evidence/z/ez_readerzone1", "/evidence/z/s/readers", "/evidence/z/ez_readerzone1/feed.xml", "/evidence/z/ez_draftzone01", "/evidence/z/s/draft-zone", "/evidence/z/ez_platformonly",
    "/evidence/z/s/platform-only", "/evidence/z/ez_platformonly/feed.xml"]) {
    const answer = await text(path);
    assert.equal(answer.status, 404, path);
    assert.equal(answer.body, missing.body, `${path} is answered as an id that never existed`);
  }
  // A zone of cards with no topic is the older page's, and a zone with no cards has no feed.
  assert.equal((await text("/evidence/z/ez_cardzone001/feed.xml")).status, 404);
  const sitemap = await text("/evidence/sitemap.xml");
  for (const id of ["ez_readerzone1", "ez_draftzone01", "ez_platformonly"]) assert.equal(sitemap.body.includes(id), false, id);
  const index = await text("/evidence/");
  for (const title of ["读者的专区", "草稿专区", "仅平台内"]) assert.equal(index.body.includes(title), false, title);
});

test("a topic zone with fewer than five items in thirty days and no 最新进展 is noindex and left out of the sitemap; either lifts it; the deployment's switch off says noindex to all", options, async (t) => {
  await addZone({ id: "ez_thinzone001", title: "条目很少的专区", slug: "thin", stats: { week: 1, month: 3, all: 3, perWeek: 1 } });
  await addZone({ id: "ez_fivezone001", title: "满五条的专区", slug: "five", stats: { week: 2, month: 5, all: 5, perWeek: 1 } });
  await addZone({ id: "ez_wordszone01", title: "有最新进展的专区", slug: "words", stats: { week: 0, month: 2, all: 2, perWeek: 0 },
    overview: { text: "近期有一项新进展。", refs: [] }, overviewAt: ago(1) });
  await addZone({ id: "ez_quietzone01", title: "安静的专区", slug: "quiet", lifecycle: "quiet", stats: { week: 0, month: 7, all: 20, perWeek: 0 } });
  await addZone({ id: "ez_archivedzo1", title: "归档的专区", slug: "archived", lifecycle: "archived", stats: { week: 0, month: 0, all: 20, perWeek: 0 } });
  const on = await serve(t, { evidencePublicIndexable: true });
  const verdict = async (/** @type {string} */ path) => { const answer = await on.text(path); return { status: answer.status, header: answer.headers.get("x-robots-tag"), meta: /<meta name="robots" content="noindex">/.test(answer.body) }; };
  assert.deepEqual(await verdict("/evidence/z/ez_thinzone001"), { status: 200, header: "noindex", meta: true });
  assert.deepEqual(await verdict("/evidence/z/ez_fivezone001"), { status: 200, header: null, meta: false });
  assert.deepEqual(await verdict("/evidence/z/ez_wordszone01"), { status: 200, header: null, meta: false });
  assert.deepEqual(await verdict("/evidence/z/s/thin"), { status: 200, header: "noindex", meta: true }, "the alias is judged as its page is");
  const quiet = await on.text("/evidence/z/ez_quietzone01");
  assert.match(quiet.body, /这个专区近期动态不多/, "a quiet zone keeps its address and says what it is");
  assert.match((await on.text("/evidence/z/ez_archivedzo1")).body, /这个专区已归档，不再更新/);
  const sitemap = (await on.text("/evidence/sitemap.xml")).body;
  for (const id of ["ez_fivezone001", "ez_wordszone01", "ez_quietzone01"]) assert.ok(sitemap.includes(`/evidence/z/${id}<`), `${id} is listed`);
  for (const id of ["ez_thinzone001", "ez_archivedzo1"]) assert.equal(sitemap.includes(id), false, `${id} is not`);
  const off = await serve(t, { evidencePublicIndexable: false });
  assert.deepEqual(await (async () => { const answer = await off.text("/evidence/z/ez_fivezone001"); return { header: answer.headers.get("x-robots-tag"), meta: /name="robots" content="noindex"/.test(answer.body) }; })(), { header: "noindex", meta: true });
  assert.equal((await off.text("/evidence/sitemap.xml")).status, 404);
});

test("the index lists the platform's topic zones by specialty and group, the busiest first and a quiet zone last, archived ones not at all", options, async (t) => {
  await addZone({ id: "ez_obesity0001", title: "GLP-1 受体激动剂减重", slug: "glp1-weight", stats: { week: 8, month: 30, all: 30, perWeek: 8 } });
  await addZone({ id: "ez_obesity0002", title: "手术治疗肥胖", slug: "bariatric", group: "肥胖", stats: { week: 2, month: 9, all: 9, perWeek: 2 } });
  await addZone({ id: "ez_diabetes001", title: "SGLT2 抑制剂心肾保护", slug: "sglt2", group: "糖尿病", stats: { week: 5, month: 20, all: 20, perWeek: 5 } });
  await addZone({ id: "ez_quietone001", title: "安静专区", slug: "quiet", lifecycle: "quiet", group: "肥胖", stats: { week: 0, month: 3, all: 9, perWeek: 0 } });
  await addZone({ id: "ez_oncology001", title: "ADC 治疗乳腺癌", slug: "adc", specialties: ["oncology"], group: "乳腺癌", stats: { week: 20, month: 80, all: 90, perWeek: 20 } });
  await addZone({ id: "ez_archived001", title: "已归档不列", slug: "gone", lifecycle: "archived" });
  await addZone({ id: "ez_nospecialty", title: "没有专科的专区", slug: "nospec", specialties: [], group: "" });
  const { text } = await serve(t, { evidencePublicIndexable: true });
  const index = await text("/evidence/");
  const body = index.body;
  assert.match(body, /<h2 id="topics">证据专区<\/h2>/);
  const order = (/** @type {string[]} */ names) => names.map((name) => body.indexOf(name));
  const positions = order(["ADC 治疗乳腺癌", "GLP-1 受体激动剂减重", "手术治疗肥胖", "安静专区", "SGLT2 抑制剂心肾保护", "没有专科的专区"]);
  assert.ok(positions.every((position) => position > 0), `all listed: ${positions}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "肿瘤 before 内分泌 (the busier specialty), the busier group first, the quiet zone after the live ones, 其他 last");
  assert.equal(body.includes("已归档不列"), false);
  assert.match(body, /<h3>肿瘤学<\/h3>|<h3>肿瘤/);
  assert.match(body, /<p class="group"><strong>肥胖<\/strong><\/p>/);
  assert.match(body, /href="\/evidence\/z\/ez_obesity0001"/);
  assert.equal(body.includes("官方证据卡"), false, "no empty section of cards");
});

test("a title that tries to close the data block does not", options, async (t) => {
  await addZone({ id: "ez_hostile0001", title: "</script><script>alert(1)</script>", slug: "hostile", scope: "<b>范围</b>" });
  await addItem("<img src=x onerror=alert(1)>", { zone: "ez_hostile0001" });
  const { text } = await serve(t, { evidencePublicIndexable: true });
  const body = (await text("/evidence/z/ez_hostile0001")).body;
  assert.equal((body.match(/<script/g) ?? []).length, 1, "one script block, the data");
  assert.equal(body.includes("<img"), false);
  assert.equal(jsonLd(body)["@graph"][0].name, "</script><script>alert(1)</script>", "the data still says what the title was");
});

test("a reader's topic zone opened to the internet through the older route is still never found on the pages of cards", options, async (t) => {
  // The older zone service lets an owner open a zone; a zone with a topic definition must not become a page of cards by it.
  const zones = new EvidenceZoneService({ database: db, platformPublisherUserId: "pub" });
  await addZone({ id: "ez_ownertopic01", title: "读者的主题专区", owner: "alice", kind: "user", slug: "mine", visibility: "platform" });
  const detail = await zones.detail({ id: "alice" }, "ez_ownertopic01");
  await zones.setVisibility({ id: "alice" }, "ez_ownertopic01", { visibility: "internet", expectedRevision: detail.zone.revision });
  const { text } = await serve(t, { evidencePublicIndexable: true });
  assert.equal((await text("/evidence/z/ez_ownertopic01")).status, 404);
  assert.equal((await text("/evidence/z/ez_ownertopic01/changes")).status, 404);
  assert.equal((await text("/evidence/sitemap.xml")).body.includes("ez_ownertopic01"), false);
});
