// The public pages' building blocks without a database (flywheel F08): the escaping template, the link rule, the page functions over a
// view model, the stylesheet made from the design tokens, the indexing decision, the sitemap, and the router doing nothing at all while
// its switch is off (a database that counts its queries proves it).
import assert from "node:assert/strict";
import test from "node:test";
import { COLOR_ROLES, colorRole } from "@evimed/design-tokens";
import { escapeHtml, externalLink, html, raw, safeHref, timeTag } from "../src/evidencePublicHtml.mjs";
import { aigcMetadata, renderPage } from "../src/evidencePublicLayout.mjs";
import { createEvidencePublicIndexing, evidenceAbsoluteUrl, evidenceSitemapXml } from "../src/evidencePublicIndexing.mjs";
import { aboutPage, cardPage, claimCountsText, indexPage, metricsPage, requestsPage, simulationPage, simulationsPage, withdrawnCardPage, zonePage } from "../src/evidencePublicPages.mjs";
import { createEvidencePublicRoutes } from "../src/evidencePublicRoutes.mjs";
import { evidencePublicStylesheet } from "../src/evidencePublicStyle.mjs";
import { evidencePublicIsBot, evidencePublicDay } from "../src/evidencePublicReads.mjs";

test("escapeHtml turns <script>, quotes and & into text, and the template escapes every interpolation", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script> & 'y'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(0), "0");
  const hostile = `"><img src=x onerror=alert(1)>`;
  const page = String(html`<p title="${hostile}">${hostile}</p>`);
  assert.equal(page.includes("<img"), false, "an interpolated value cannot open a tag");
  assert.equal(page.includes('title=""'), false, "or close an attribute");
  assert.match(page, /^<p title="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;">&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;<\/p>$/);
  // Markup is only what another `html` call (or `raw`) produced; lists join; false and null are nothing.
  assert.equal(String(html`<ul>${["a", "<b>"].map((item) => html`<li>${item}</li>`)}</ul>${false}${null}${undefined}`), "<ul><li>a</li><li>&lt;b&gt;</li></ul>");
  assert.equal(String(html`${raw("<hr>")}`), "<hr>");
});

test("a link is made only from an http or https address without credentials; anything else is its label alone", () => {
  assert.equal(safeHref("https://example.org/a?b=c"), "https://example.org/a?b=c");
  assert.equal(safeHref("http://example.org"), "http://example.org/");
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "//example.org", "/relative", ["https://", "user", ":", "pw", "@example.org/"].join(""), "", "  ", 5, null, `https://example.org/${"a".repeat(2100)}`]) {
    assert.equal(safeHref(bad), null, String(bad).slice(0, 40));
  }
  assert.equal(String(externalLink("javascript:alert(1)", "The <trial>")), "The &lt;trial&gt;", "no anchor at all for a script address");
  const linked = String(externalLink("https://example.org/t?a=1&b=2", "Trial"));
  assert.match(linked, /^<a href="https:\/\/example\.org\/t\?a=1&amp;b=2" rel="nofollow noopener noreferrer" target="_blank">Trial<\/a>$/);
});

test("a day is the platform's own (Asia/Shanghai), and a bad instant is nothing", () => {
  assert.equal(String(timeTag("2026-10-05T17:30:00Z")), '<time datetime="2026-10-05T17:30:00.000Z">2026-10-06</time>');
  assert.equal(String(timeTag("not a date")), "");
  assert.equal(String(timeTag(null)), "");
  assert.equal(evidencePublicDay(new Date("2026-10-05T16:00:00Z")), "2026-10-06");
});

test("a user agent that names a program, or none at all, is not a reader; a browser is", () => {
  for (const agent of ["Googlebot/2.1", "Mozilla/5.0 (compatible; bingbot/2.0)", "Baiduspider", "curl/8.0", "Wget/1.21", "python-requests/2.31", "HeadlessChrome/120", "facebookexternalhit/1.1", "", undefined, "  "]) {
    assert.equal(evidencePublicIsBot(agent), true, String(agent));
  }
  for (const agent of ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36", "node"]) {
    assert.equal(evidencePublicIsBot(agent), false, agent);
  }
});

const producer = { kind: "enterprise", kindLabel: "企业", name: "Acme <Pharma>", relation: "own_product", relationLabel: "涉及出品方自己的产品", products: ["Drug A"] };
const card = (extra = {}) => ({
  id: "ec_0123456789ab", zoneId: "ez_0123456789ab", zoneTitle: "Zone", zoneKind: "product", title: `Does it work? <script>alert(1)</script>`, summary: "A summary.", revision: 2,
  producer, originality: "original_research", originalityLabel: "原创研究", primary: true, aiGenerated: true,
  creator: { id: "alice", name: "Alice" }, claims: { total: 2, verified: 1, warned: 1, derived: 0 }, currency: "new_evidence_pending", currencyLabel: "有新证据，尚未纳入",
  pendingItems: 2, hasPendingEvidence: true, lastCheckedAt: "2026-10-01T00:00:00Z", withdrawn: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z",
  view: "clinical", viewContent: { kind: "clinical", header: {}, population: "Adults", rows: [], counts: { total: 2 } },
  claimList: [
    { claimId: "CLM-001", claimType: "direct", text: "Fewer strokes.", mark: "✓", status: "verified", quotes: [{ quote: "7 had a stroke", source: { index: 1, title: "Trial", url: "https://example.org/t" } }], applicability: null, uncertainty: null, confidence: null, valueSource: null },
    { claimId: "CLM-002", claimType: "direct", text: "More bleeding.", mark: "⚠", status: "quote_not_found", quotes: [{ quote: "9 of 100", source: { index: 2, title: "Bad <source>", url: "javascript:alert(1)" } }], applicability: null, uncertainty: null, confidence: null, valueSource: null },
  ],
  sources: [{ index: 1, title: "Trial", url: "https://example.org/t", coverage: "full-text", checkedAt: "2026-10-01T00:00:00Z" }, { index: 2, title: "Bad <source>", url: null, coverage: null, checkedAt: null }],
  disclosure: { model: "deepseek-v4-flash", modelVersion: "2026-09", aiSteps: ["search", "synthesize"], generatedAt: "2026-10-01T00:00:00Z", authors: [{ name: "Dr. Li", affiliation: "PUMCH" }], reviewers: [] },
  content: { question: "Does it?", answer: "Yes." }, lineage: null, zone: { id: "ez_0123456789ab", title: "Zone", kind: "product" }, ...extra,
});
const links = { previous: null, origin: null, next: [], research: [] };

test("a card page shows the producer first, the marks, the quotations, the sources, the disclosure and the AI label — and no raw value", () => {
  const page = cardPage({ card: card(), links, view: "clinical" });
  const body = String(page.body);
  assert.ok(body.indexOf('class="producer"') < body.indexOf("<h1>"), "the producer line is above the title");
  assert.ok(body.includes("Acme &lt;Pharma&gt;"), "the producer's name is escaped");
  assert.equal(body.includes("<script"), false, "a card title cannot inject a script");
  assert.match(body, /<span class="mark-ok">✓<\/span>/);
  assert.match(body, /<span class="mark-warn">⚠<\/span>/);
  assert.match(body, /<blockquote>7 had a stroke<\/blockquote>/);
  assert.equal(body.includes('href="javascript:'), false, "a script address is never a link");
  assert.ok(body.includes("Bad &lt;source&gt;"));
  assert.match(body, /<span class="badge ai">AI 生成<\/span>/);
  assert.match(body, /AI 做了哪几步<\/dt><dd>检索、综合<\/dd>/);
  assert.match(body, /deepseek-v4-flash 2026-09/);
  assert.match(body, /有 2 项可能影响这张卡的新研究|2 项可能影响这张卡的新研究/);
  assert.match(body, /href="\/app\/frontier\/zones\/ez_0123456789ab\/evidence\/ec_0123456789ab"/, "the call to action leads into the app");
  assert.match(body, /不要引用这张卡/, "a card says it is an index, not evidence");
  assert.equal(/style=/.test(body), false, "no inline style");
});

test("renderPage writes noindex, the canonical address, lang, the AI-content metadata and no structured markup for machines that read answers", () => {
  const page = cardPage({ card: card(), links, view: "clinical" });
  const aigc = aigcMetadata({ producerName: "EviMed 证据中心", produceId: "ec_0123456789ab@2", propagateId: "ec_0123456789ab@2" });
  const text = renderPage({ ...page, path: "/evidence/c/ec_0123456789ab", noindex: true, aigc, publicUrl: "https://www.evimed.test/anything", wide: false });
  assert.match(text, /^<!doctype html>\n<html lang="zh-CN">/);
  assert.match(text, /<meta name="robots" content="noindex">/);
  assert.match(text, /<link rel="canonical" href="https:\/\/www\.evimed\.test\/evidence\/c\/ec_0123456789ab">/);
  assert.match(text, /<title>[^<]+· EviMed 证据中心<\/title>/);
  assert.match(text, /<meta name="description" content="[^"]+">/);
  const meta = /<meta name="AIGC" content="([^"]+)">/.exec(text);
  assert.ok(meta, "the implicit label is in the page's metadata");
  assert.deepEqual(JSON.parse(meta[1].replaceAll("&quot;", '"')), {
    Label: "1", ContentProducer: "EviMed 证据中心", ProduceID: "ec_0123456789ab@2", ReserveCode1: "", ContentPropagator: "EviMed 证据中心", PropagateID: "ec_0123456789ab@2", ReserveCode2: "",
  });
  for (const forbidden of ["application/ld+json", "itemscope", "itemtype", "schema.org", "llms.txt", "<script"]) assert.equal(text.includes(forbidden), false, forbidden);
  const indexable = renderPage({ ...page, path: "/evidence/c/x", noindex: false, publicUrl: "not a url" });
  assert.equal(indexable.includes('name="robots"'), false, "an indexable page says nothing: the default is to index");
  assert.equal(indexable.includes('rel="canonical"'), false, "no usable public address, no canonical");
  assert.equal(indexable.includes('name="AIGC"'), false, "a human-written card carries no AI label");
});

test("the zone, index, simulations, requests and withdrawn pages escape every value they are given", () => {
  const zone = { id: "ez_0123456789ab", title: `<b>Zone</b> & "co"`, description: "<i>d</i>", background: "<u>b</u>", kind: "user", kindLabel: "用户专区", producer: null, owner: { id: "alice", name: "<Alice>" }, follows: 3, cards: 1, withdrawnCards: 0, currencyCounts: { current: 1 }, lastCheckedAt: null };
  const cards = { items: [card({ aiGenerated: false })], next: "abc" };
  const zoneBody = String(zonePage({ zone, cards }).body);
  const indexBody = String(indexPage({ official: [], product: [{ ...zone, kind: "product", producer }], user: [{ ...zone }] }).body);
  const requests = String(requestsPage({ items: [{ id: "tr_x", title: "<script>x</script>", requesters: 3, zoneId: null, zoneTitle: null, createdAt: "2026-10-01T00:00:00Z" }] }).body);
  const simulations = String(simulationsPage({ reader: true, items: [{ id: "s<1>", title: "<s>sim</s>", summary: "<p>" }], next: null }).body);
  const withdrawn = String(withdrawnCardPage({ card: card({ withdrawn: { at: "2026-10-04T00:00:00Z", reason: "<b>wrong</b>", changeLogId: "7" } }) }).body);
  for (const [name, body] of Object.entries({ zoneBody, indexBody, requests, simulations, withdrawn })) {
    assert.equal(/<(script|b|i|u|s|p)>/.test(body.replace(/<p[ >]/g, "")), false, `${name} has no markup from a value`);
  }
  assert.match(zoneBody, /href="\/evidence\/z\/ez_0123456789ab\?cursor=abc"/, "a next page is a cursor link");
  assert.match(indexBody, /<h2 id="official">官方专区<\/h2>[\s\S]*<h2 id="product">产品专区<\/h2>[\s\S]*<h2 id="user">用户专区<\/h2>/);
  assert.match(withdrawn, /changes\?before=8#log-7/, "the withdrawal links to its log entry");
});

test("the monthly page says a month has no data, never 0, and the simulations banner and value-source labels are fixed", () => {
  const full = { verification: { cards: 2, claims: 4, verified: 3, passRate: 0.75 }, corrections: { entries: 1, medianLatencyHours: 30 }, challenges: { filed: 2, upheld: 1, amended: 0, withdrawn: 0, open: 1, upheldShare: 1 } };
  const body = String(metricsPage({ months: [{ month: "2026-10", data: true, figures: full }, { month: "2026-09", data: false, figures: null }] }).body);
  assert.match(body, /75%/);
  assert.match(body, /30 小时/);
  assert.match(body, /2026-09<\/td><td colspan="3" class="muted">这个月没有数据。/);
  const sim = simulationPage({ id: "s1", title: "S", summary: "x", numbers: [{ label: "HR", value: 0.8, valueSource: "predicted" }, { label: "N", value: 100 }] });
  const text = String(sim.body);
  assert.match(text, /模拟研究的结果是模拟，不是证据/);
  assert.match(text, /<td>HR<\/td><td class="num">0\.8<\/td><td>预测<\/td>/);
  assert.match(text, /<td>N<\/td><td class="num">100<\/td><td>来源未标注<\/td>/, "a number with no source says so");
  // The record 虚拟临研 stores when a study lead publishes a report: sections with their own numbers, a cover's use and limits, receipts.
  const published = String(simulationPage({ id: "s2", title: "T", summary: "", publishedAt: "2026-10-06T00:00:00.000Z", producer: { kind: "researcher", name: "<b>lead</b>" },
    intendedUse: "设计支持", limitations: ["样本来自单中心", "<i>x</i>"], receipts: ["rcp_1"],
    sections: [{ heading: "检验效能", text: "按情景估计。", values: [{ label: "效能", value: "0.82", unit: "", valueSource: "calculated" }, { label: "事件数", value: "未计算", valueSource: "observed" }] }] }).body);
  assert.match(published, /<h2>检验效能<\/h2><p>按情景估计。<\/p>/);
  assert.match(published, /<td>效能<\/td><td class="num">0\.82<\/td><td>[^<]+<\/td>/, "every number keeps its value-source label");
  assert.match(published, /<td>事件数<\/td><td class="num">未计算<\/td>/, "a suppressed small cell is shown as not computed");
  assert.match(published, /<h2>用途<\/h2><p>设计支持<\/p>/);
  assert.match(published, /<li>样本来自单中心<\/li><li>&lt;i&gt;x&lt;\/i&gt;<\/li>/, "a limitation is text, never markup");
  assert.match(published, /&lt;b&gt;lead&lt;\/b&gt;/);
  assert.match(published, /回执编号：rcp_1/);
  assert.match(String(simulationsPage({ reader: true, items: [{ id: "s2", title: "T", summary: "", publishedAt: "2026-10-06T00:00:00.000Z", producer: { name: "lead" } }], next: null }).body), /lead · <time/);
  assert.match(String(simulationsPage({ reader: false, items: [], next: null }).body), /没有公开的模拟研究/);
  assert.match(String(claimCountsText({ total: 0, verified: 0, warned: 0, derived: 0 })), /没有列出结论/);
});

test("《编辑说明》 states the five principles of the plan and that money buys publication and distribution, never ranking or conclusions", () => {
  const body = String(aboutPage().body);
  const principles = /<h2 id="principles">[\s\S]*?<ol>([\s\S]*?)<\/ol>/.exec(body);
  assert.ok(principles);
  assert.equal(principles[1].match(/<li>/g)?.length, 5);
  for (const sentence of ["出品方如实标注", "同一把尺子", "每句可溯源", "官方内容只由平台出品，研究只认原始来源", "钱买得到发布和分发，买不到排名和结论"]) assert.ok(body.includes(sentence), sentence);
  for (const sentence of ["核验没有通过（⚠）的结论不发布", "每周最多发两张", "记录只追加，发布后不能改", "撤回的卡片保留一个说明页", "任何人都能申请选题"]) assert.ok(body.includes(sentence), sentence);
});

test("the stylesheet is generated from the design tokens: every colour in it is a token's, nothing is requested, and a phone gets one column", () => {
  const { css, etag } = evidencePublicStylesheet();
  const tokens = new Set(Object.keys(COLOR_ROLES).flatMap((role) => [colorRole(role, "light"), colorRole(role, "dark")].map((value) => value.toLowerCase())));
  const colours = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0].toLowerCase());
  assert.ok(colours.length > 20);
  for (const colour of colours) assert.ok(tokens.has(colour), `${colour} is a token's`);
  assert.ok(css.includes(`--accent: ${colorRole("accent", "light")};`));
  assert.ok(css.includes("prefers-color-scheme: dark"));
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*grid-template-columns: 1fr/);
  assert.equal(/url\(|@import|@font-face/.test(css), false, "no web font, no image, no import");
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  assert.equal(evidencePublicStylesheet().etag, etag);
});

test("the indexing decision: off is noindex everywhere, a new author is noindex, an official zone and a qualifying author are not, a withdrawn card never is", async () => {
  /** @type {Record<string, boolean>} */
  const qualifies = { veteran: true, newcomer: false };
  const asked = [];
  const reads = { authorQualifies: async (/** @type {string} */ id) => { asked.push(id); return qualifies[id] ?? false; } };
  const off = createEvidencePublicIndexing({ config: { evidencePublicIndexable: false }, reads });
  for (const page of [{ kind: "site" }, { kind: "zone", zoneKind: "official", ownerId: "veteran" }, { kind: "card", zoneKind: "official", authorId: "veteran", withdrawn: false }, { kind: "author", official: true, authorId: "veteran" }]) {
    assert.deepEqual(await off.decide(/** @type {any} */ (page)), { index: false, reason: "switch_off" }, JSON.stringify(page));
  }
  assert.deepEqual(asked, [], "with the switch off no author is even asked about");
  const on = createEvidencePublicIndexing({ config: { evidencePublicIndexable: true }, reads });
  assert.equal((await on.decide({ kind: "site" })).index, true);
  assert.equal((await on.decide({ kind: "never" })).index, false);
  assert.equal((await on.decide({ kind: "zone", zoneKind: "official", ownerId: "newcomer" })).index, true, "official zones are exempt");
  assert.deepEqual(await on.decide({ kind: "zone", zoneKind: "user", ownerId: "newcomer" }), { index: false, reason: "new_author" });
  assert.equal((await on.decide({ kind: "zone", zoneKind: "user", ownerId: "veteran" })).index, true);
  assert.deepEqual(await on.decide({ kind: "card", zoneKind: "user", authorId: "newcomer", withdrawn: false }), { index: false, reason: "new_author" });
  assert.deepEqual(await on.decide({ kind: "card", zoneKind: "official", authorId: "veteran", withdrawn: true }), { index: false, reason: "withdrawn" });
  assert.deepEqual(await on.decide({ kind: "author", official: false, authorId: "newcomer" }), { index: false, reason: "new_author" });
  const paths = await on.sitemapPaths({
    zones: [{ id: "ez_a", kind: "official", authorId: "newcomer", updatedAt: "2026-10-01T00:00:00Z" }, { id: "ez_b", kind: "user", authorId: "newcomer", updatedAt: null }, { id: "ez_c", kind: "user", authorId: "veteran", updatedAt: null }],
    cards: [{ id: "ec_a", kind: "official", authorId: "newcomer", updatedAt: null }, { id: "ec_b", kind: "user", authorId: "newcomer", updatedAt: null }, { id: "ec_c", kind: "user", authorId: "veteran", updatedAt: null }],
  });
  assert.deepEqual(paths.map((entry) => entry.path), [
    "/evidence/", "/evidence/about", "/evidence/metrics", "/evidence/simulations", "/evidence/z/ez_a", "/evidence/z/ez_c", "/evidence/c/ec_a", "/evidence/c/ec_c", "/evidence/a/newcomer", "/evidence/a/veteran",
  ], "the owner of an official zone is exempt, so is listed; a new author with only user zones is not");
  assert.equal(paths.some((entry) => entry.path.endsWith("ez_b") || entry.path.endsWith("ec_b")), false, "a new author's pages are not in the sitemap");
});

test("the sitemap is the sitemaps.org document of absolute addresses, and needs the public address", () => {
  const xml = evidenceSitemapXml([{ path: "/evidence/", lastmod: null }, { path: "/evidence/c/ec_1&2", lastmod: "2026-10-05T00:00:00Z" }], "https://www.evimed.test/x");
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.ok(xml.includes("<loc>https://www.evimed.test/evidence/</loc>"));
  assert.ok(xml.includes("<loc>https://www.evimed.test/evidence/c/ec_1&amp;2</loc><lastmod>2026-10-05T00:00:00.000Z</lastmod>"));
  assert.throws(() => evidenceSitemapXml([{ path: "/evidence/", lastmod: null }], ""), { code: "evidence_public_not_found" });
  assert.equal(evidenceAbsoluteUrl(["http://", "user", ":", "pw", "@x.test/"].join(""), "/evidence/"), null);
  assert.equal(evidenceAbsoluteUrl("ftp://x.test/", "/evidence/"), null);
});

/** A database that counts every call and answers none. */
function countingDatabase() {
  const calls = { query: 0, transaction: 0 };
  return { calls, query: async () => { calls.query += 1; return { rows: [] }; }, transaction: async () => { calls.transaction += 1; throw new Error("no transaction"); } };
}

test("with the switch off (or no database) the router handles nothing, issues no query and has no counters", async () => {
  for (const [config, database] of [[{ evidencePublicWebEnabled: false, evidencePublicIndexable: true }, countingDatabase()], [{ evidencePublicWebEnabled: true }, null]]) {
    const routes = createEvidencePublicRoutes({ config, database, limiter: () => { throw new Error("the limiter must not run"); } });
    for (const path of ["/evidence/", "/evidence", "/evidence/z/ez_0123456789ab", "/evidence/c/ec_0123456789ab", "/evidence/a/alice", "/evidence/about", "/evidence/metrics", "/evidence/simulations", "/evidence/requests", "/evidence/sitemap.xml",
      "/evidence/assets/site.css", "/evidence/api/v1/zones", "/evidence/api/v1/metrics"]) {
      let wrote = false;
      const res = { writeHead: () => { wrote = true; }, end: () => { wrote = true; } };
      assert.equal(await routes(/** @type {any} */ ({ url: path, method: "GET", headers: {} }), res), false, `${JSON.stringify(config)} ${path}`);
      assert.equal(wrote, false, `${path} wrote nothing`);
    }
    assert.equal(routes.stats(), null, "no counters exist for a module that is off");
    if (database) assert.deepEqual(/** @type {any} */ (database).calls, { query: 0, transaction: 0 }, "an off module reads no table");
  }
  // And with it on, a path that is not under /evidence, and the feed's two paths, are not this router's.
  const database = countingDatabase();
  const on = createEvidencePublicRoutes({ config: { evidencePublicWebEnabled: true }, database });
  for (const path of ["/", "/app/frontier/zones", "/api/health", "/evidences", "/evidence/feed.json", "/evidence/feed.xml"]) {
    assert.equal(await on(/** @type {any} */ ({ url: path, method: "GET", headers: {} }), /** @type {any} */ ({})), false, path);
  }
  assert.deepEqual(database.calls, { query: 0, transaction: 0 });
});

test("a request that is not a GET or HEAD is refused 405 by the router while it is on", async () => {
  const on = createEvidencePublicRoutes({ config: { evidencePublicWebEnabled: true }, database: countingDatabase() });
  /** @type {any} */ const seen = {};
  const res = { writeHead: (/** @type {number} */ status, /** @type {any} */ headers) => { seen.status = status; seen.headers = headers; }, end: (/** @type {any} */ body) => { seen.body = body; } };
  assert.equal(await on(/** @type {any} */ ({ url: "/evidence/", method: "POST", headers: {} }), res), true);
  assert.equal(seen.status, 405);
  assert.equal(seen.headers.Allow, "GET, HEAD");
  assert.equal(seen.headers["X-Content-Type-Options"], "nosniff");
});
