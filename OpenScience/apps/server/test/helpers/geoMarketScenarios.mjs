// The market's behaviour, written once and run twice: against the in-memory
// double (geoMarket.test.mjs) and against PostgreSQL on the real DDL
// (geoMarket.integration.test.mjs). A fake vendor on 127.0.0.1 plays the
// marketplace; a fake web reader serves published pages through the
// platform's own HTML extractor.
import assert from "node:assert/strict";
import { geoClaimReferenceMarker } from "@evimed/domain";
import {
  MARKET_RULES,
  cancelOrder,
  clearStop,
  confirmTopup,
  markOrderLost,
  marketStatus,
  noteCitation,
  projectIdentityBreaks,
  projectMoney,
  resolveUnknownOrder,
  setBudget,
  tickCatalogue,
  tickOrders,
  tickPoll,
  tickReconcile,
  tickTopups,
  tickVerify,
} from "../../src/geoMarket.mjs";
import { sha256Hex } from "../../src/geoMarketText.mjs";
import { MediaMarketClient } from "../../src/mediaMarketClient.mjs";
import { extractHtml } from "../../src/webReadExtract.mjs";
import { startFakeMediaMarket, vendorRow } from "./fakeMediaMarket.mjs";

export const ARTICLE_MARKDOWN = `# 司美格鲁肽每周注射一次，需要注意什么？

司美格鲁肽（诺和泰）起始剂量为每周 0.25 mg，4 周后增至每周 0.5 mg，每周注射一次。

| 周数 | 剂量 |
|---|---|
| 1-4 | 0.25 mg |
| 5-8 | 0.5 mg |

- 常见不良反应为恶心，发生率约 20%。
- 出处：说明书 [1]，https://www.nmpa.gov.cn/label/123 ，PMID: 12345678。
`;

/** The article as an outlet would publish it: its own chrome around our body. @param {string} markdown */
export function publishedHtml(markdown) {
  const body = markdown.replace(/^# .*\n/, "");
  const rows = body.split("\n").filter(Boolean).map((line) => {
    if (line.startsWith("|---")) return "";
    if (line.startsWith("|")) return `<tr>${line.split("|").slice(1, -1).map((cell) => `<td>${cell.trim()}</td>`).join("")}</tr>`;
    if (line.startsWith("- ")) return `<li>${line.slice(2)}</li>`;
    return `<p>${line}</p>`;
  });
  return `<html><head><title>健康时报网</title></head><body><header>首页 新闻 健康</header><article><h1>司美格鲁肽每周注射一次</h1>${
    rows.join("").replace(/(<tr>.*<\/tr>)/, "<table>$1</table>").replace(/(<li>.*<\/li>)/, "<ul>$1</ul>")}</article><footer>版权所有</footer></body></html>`;
}

/** A web reader that serves registered pages through the platform's extractor. */
export function fakeWebReader() {
  /** @type {Map<string, { html?: string, finalUrl?: string, error?: string }>} */
  const pages = new Map();
  /** @type {string[]} */
  const calls = [];
  return {
    pages,
    calls,
    /** @param {string} url */
    async read(url) {
      calls.push(url);
      const page = pages.get(url);
      if (!page || page.error) throw Object.assign(new Error("not found"), { code: page?.error ?? "web_read_not_found", status: 404 });
      const finalUrl = page.finalUrl ?? url;
      const html = page.html ?? "<html><body><article><p>案例页面</p></article></body></html>";
      const extracted = extractHtml(html, { baseUrl: new URL(finalUrl) });
      return { receipt: { url, finalUrl, status: 200, sha256: sha256Hex(html) }, text: extracted.text };
    },
  };
}

/** A test clock that, like a real one, never reads the same millisecond twice. @param {string} start */
export function testClock(start = "2026-09-25T02:00:00.000Z") {
  let now = Date.parse(start);
  return {
    now: () => new Date(now++),
    /** @param {number} ms */
    advance(ms) { now += ms; },
  };
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** The standard catalogue: two admissible health outlets on different domains, and the ones that must never be picked. */
export function standardCatalogue() {
  return {
    website: [
      vendorRow({ resource_id: 101, title: "健康时报网首发", remarks: "修改不通知，收录好", case_link: "https://www.jksb.com.cn/a/1.html", price: "100.00" }),
      vendorRow({ resource_id: 102, title: "生命健康网", remarks: "周末可发", case_link: "https://www.smjk.cn/n/2.html", price: "120.00", publish_rate: "70" }),
      vendorRow({ resource_id: 103, title: "某财经网", field_1: "1003", case_link: "https://www.caijing-x.cn/1.html", price: "50.00" }),
      vendorRow({ resource_id: 104, title: "博客园（医疗排名）", remarks: "可发 GEO 医疗排名类稿件，AI 收录好", case_link: "https://www.cnblogs.com/x/p/1.html", price: "30.00" }),
      vendorRow({ resource_id: 105, title: "某健康门户首发", case_link: "https://www.big-health.cn/1.html", price: "2500.00" }),
      vendorRow({ resource_id: 106, title: "某生活健康网", remarks: "医疗金融不发，改稿不通知", case_link: "https://www.shjk.cn/1.html", price: "60.00" }),
      vendorRow({ resource_id: 108, title: "某养生网", remarks: "可带网址、二维码任何联系方式", case_link: "https://www.yangsheng-y.cn/1.html", price: "40.00" }),
    ],
    wemedia: [
      vendorRow({ resource_id: 201, title: "某健康号", case_link: "https://www.health-b.com/p/1", price: "150.00" }),
    ],
  };
}

/**
 * @typedef {object} MarketFixture
 * @property {any} store
 * @property {{ project: (row: any) => Promise<void>, group: (row: any) => Promise<void>, article: (row: any) => Promise<void>,
 *   source: (row: any) => Promise<void>, target: (row: any) => Promise<void> }} seed
 * @property {(row: { geoProjectId: string, orderId: string, kind: string, amountCny: number }) => Promise<void>} tamperLedger
 * @property {{ article: (id: string, patch: Record<string, any>) => Promise<void>, project: (id: string, patch: Record<string, any>) => Promise<void> }} [alter]
 *   what a second writer does to a row meanwhile: an article's status, safety, gate or hash, a project's status
 * @property {() => Promise<void>} close
 */

/**
 * Build one scenario's world.
 * @param {() => Promise<MarketFixture>} makeFixture
 * @param {{ catalogue?: any, balance?: number, sendTimeoutMs?: number, configured?: boolean, config?: Record<string, any> }} [options]
 */
export async function world(makeFixture, { catalogue = standardCatalogue(), balance = 1_000, sendTimeoutMs = 2_000, configured = true, config = {} } = {}) {
  const fixture = await makeFixture();
  const fake = await startFakeMediaMarket({ catalogue, balance });
  const clock = testClock();
  const reader = fakeWebReader();
  const market = new MediaMarketClient({
    baseUrl: configured ? fake.url : "", apiKey: fake.state.apiKey, minIntervalMs: 0, sleep: async () => {}, timeoutMs: 2_000, sendTimeoutMs,
  });
  const syncMarket = configured ? market : new MediaMarketClient({ baseUrl: fake.url, apiKey: fake.state.apiKey, minIntervalMs: 0, sleep: async () => {} });
  /** @type {Map<string, string>} */
  const bodies = new Map();
  /** @type {any[]} */
  const alerts = [];
  /** @type {any[]} */
  const notices = [];
  for (const row of [...(catalogue.website ?? []), ...(catalogue.wemedia ?? [])]) {
    const host = new URL(row.case_link).hostname;
    reader.pages.set(row.case_link, { finalUrl: row.resource_id === 999 ? "https://elsewhere.example.com/" : `https://${host}/landing` });
  }
  const deps = {
    store: fixture.store,
    market,
    webReader: reader,
    now: clock.now,
    // The module on for everyone: the audience rule is its own scenario.
    config: { geoEnabled: true, geoAudience: "all", ...config },
    articleBody: async (/** @type {any} */ article) => ({ markdown: bodies.get(article.id) }),
    notify: async (/** @type {any} */ event) => { notices.push(event); },
    alertOperator: async (/** @type {any} */ event) => { alerts.push(event); },
  };
  /**
   * A GEO project with a budget and one publishable article per entry.
   * @param {{ id?: string, userId?: string, totalCny?: number, dailyCny?: number, articles?: Array<Record<string, any>>, engines?: string[] }} [spec]
   */
  /**
   * `checked`: the outlet domains whose three conditions the project's source
   * table has checked and found to hold, beside jksb.com.cn (the market admits
   * no other).
   */
  const project = async ({ id = "geo_p1", userId = "u1", totalCny = 1_000, dailyCny = 1_000, articles = [{}], engines = ["deepseek", "doubao"],
    checked = ["smjk.cn", "health-b.com"] } = {}) => {
    await fixture.seed.project({ id, userId, engines, product: { brandName: "诺和泰", genericName: "司美格鲁肽" }, createdAt: clock.now().toISOString() });
    await fixture.seed.group({ id: `${id}_g1`, userId, geoProjectId: id, pool: "P2", name: "用法", isControl: false });
    // The project's source table has seen DeepSeek cite this domain: it is the outlet to beat.
    await fixture.seed.source({ geoProjectId: id, domain: "jksb.com.cn", layer: "coverage", icpMatches: true, newsIndexed: true,
      medicalVertical: true, cited: { deepseek: { P2: 5 } } });
    for (const domain of checked) {
      await fixture.seed.source({ geoProjectId: id, domain, layer: "coverage", icpMatches: true, newsIndexed: true, medicalVertical: true });
    }
    await fixture.seed.group({ id: `${id}_gc`, userId, geoProjectId: id, pool: "P2", name: "对照", isControl: true });
    const ids = [];
    for (const [index, spec] of articles.entries()) {
      const articleId = spec.id ?? `${id}_a${index + 1}`;
      const markdown = spec.markdown ?? ARTICLE_MARKDOWN;
      bodies.set(articleId, markdown);
      await fixture.seed.article({
        id: articleId, userId, geoProjectId: id, layer: spec.layer ?? "popular", title: spec.title ?? `稿件 ${index + 1}`,
        groupId: spec.control ? `${id}_gc` : `${id}_g1`, gate: "passed", safety: spec.safety ?? "clear",
        contentSha256: sha256Hex(markdown), status: spec.status ?? "publishable", createdAt: new Date(clock.now().getTime() + index).toISOString(),
      });
      ids.push(articleId);
    }
    if (totalCny != null) await setBudget(deps, { userId, geoProjectId: id, totalCny, dailyCny });
    return { id, userId, articleIds: ids };
  };
  await tickCatalogue({ ...deps, market: syncMarket });
  return {
    fixture, fake, clock, reader, market, deps, bodies, alerts, notices, project,
    async close() { await fake.close(); await fixture.close(); },
  };
}

/** @param {any} store @param {string} geoProjectId */
export async function orders(store, geoProjectId) {
  return store.listOrders({ geoProjectId, limit: 500 });
}

/** @param {any} store @param {string} geoProjectId */
export async function moneyOf(store, geoProjectId) {
  const project = await store.getProject({ geoProjectId });
  return projectMoney(project, await store.ledgerSums({ geoProjectId }));
}

/**
 * Register every scenario with `test`.
 * @param {(name: string, options: any, fn: () => Promise<void>) => any} test
 * @param {() => Promise<MarketFixture>} makeFixture
 * @param {any} [options] node:test options (a skip reason when there is no database)
 */
export function defineGeoMarketScenarios(test, makeFixture, options = {}) {
  test("catalogue sync: both lines, category names, blacklist rules, domains verified from the case page", options, async () => {
    const catalogue = standardCatalogue();
    catalogue.website.push(vendorRow({ resource_id: 999, title: "冒名时报网", case_link: "https://www.shibao-fake.cn/1.html", price: "80.00" }));
    const w = await world(makeFixture, { catalogue });
    try {
      const store = w.fixture.store;
      const [jksb] = await store.getMediaRows("website", ["101"]);
      assert.equal(jksb.name, "健康时报网首发");
      assert.equal(jksb.domain, "jksb.com.cn");
      assert.equal(jksb.domainVerified, true);
      assert.deepEqual(jksb.fields.field_1, { ids: ["1007"], titles: ["健康医疗"] });
      assert.equal(jksb.flags.medicalCategory, true);
      assert.equal(jksb.flags.newsSourceCategory, true);
      assert.equal(jksb.flags.silentEdits, true);
      assert.equal(jksb.priceCny, 100);
      const byId = new Map((await store.getMediaRows("website", ["103", "104", "106", "108", "999"])).map((row) => [row.resourceId, row]));
      assert.equal(byId.get("103").flags.medicalCategory, false);
      assert.equal(byId.get("104").blacklistReason, "community_ranking_slot");
      assert.equal(byId.get("106").blacklistReason, "refuses_medical");
      assert.equal(byId.get("108").blacklistReason, "contact_allowed");
      assert.equal(byId.get("999").domainVerified, false, "a case page that lands on another domain does not verify");
      assert.equal(byId.get("999").flags.domainCheck, "left_domain");
      const [wemedia] = await store.getMediaRows("wemedia", ["201"]);
      assert.equal(wemedia.domain, "health-b.com");
      assert.ok(w.fake.requestsTo("/api/zi_media_api/media_list").length >= 1);
      assert.ok(w.fake.requestsTo("/api/zi_media_api/get_field").length >= 1);

      // A resync: a price change is kept as history, a row gone from a complete sync is off offer,
      // and a domain verified within 30 days is not read again.
      const readsBefore = w.reader.calls.length;
      w.fake.state.catalogue.website[0].price = "110.00";
      w.fake.state.catalogue.wemedia = [];
      w.clock.advance(DAY);
      const counts = await tickCatalogue(w.deps);
      assert.equal(counts.priceChanges, 1);
      const [again] = await store.getMediaRows("website", ["101"]);
      assert.equal(again.priceCny, 110);
      assert.deepEqual(again.priceHistory.map((entry) => [entry.from, entry.to]), [[100, 110]]);
      assert.equal(again.domainVerified, true);
      assert.equal((await store.getMediaRows("wemedia", ["201"]))[0].available, false);
      assert.equal(w.reader.calls.length, readsBefore, "no domain re-read inside the recheck window");
    } finally { await w.close(); }
  });

  test("selector: best admitted outlet within budget, same-domain cap, never control-group or unsafe articles", options, async () => {
    const catalogue = standardCatalogue();
    catalogue.website.push(vendorRow({ resource_id: 107, title: "健康时报网客户端", case_link: "https://news.jksb.com.cn/c/7.html", price: "90.00" }));
    const w = await world(makeFixture, { catalogue, configured: false });
    try {
      const store = w.fixture.store;
      const p = await w.project({ totalCny: 250, dailyCny: 250, articles: [{}, {}, {}, { control: true }, { safety: "open" }] });
      const first = await tickOrders(w.deps);
      assert.equal(first.planned, 2);
      assert.equal(first.skipped.control_group_article, 1);
      assert.equal(first.skipped.safety_open, 1);
      assert.equal(first.skipped.budget_exhausted, 1);
      assert.equal(first.skipped.market_unconfigured, 1);
      let planned = await orders(store, p.id);
      // The cited domain wins first; a second article goes elsewhere (reuse counts about half).
      assert.deepEqual(planned.map((order) => order.resourceId), ["107", "102"]);
      assert.ok(planned.every((order) => order.state === "planned"));
      assert.equal(planned.reduce((total, order) => total + order.reserveCny, 0), 231, "within the 250 budget");
      assert.equal(w.fake.requestsTo("/api/media/send").length, 0);

      // More budget: the third article is placed; nothing blacklisted, unverified or over ¥2,000 ever is.
      await setBudget(w.deps, { userId: p.userId, geoProjectId: p.id, totalCny: 600, dailyCny: 600 });
      await tickOrders(w.deps);
      planned = await orders(store, p.id);
      assert.deepEqual(planned.map((order) => order.resourceId), ["107", "102", "201"]);
      for (const order of planned) {
        assert.ok(!["103", "104", "105", "106", "108"].includes(order.resourceId));
        assert.equal(order.reserveCny, Math.round(order.priceCny * 110) / 100);
      }
      assert.ok(planned.every((order) => order.articleId !== `${p.id}_a4` && order.articleId !== `${p.id}_a5`));

      // Where only one domain qualifies, it takes two articles in 30 days and no third.
      const capped = await w.project({ id: "geo_cap", userId: "u9", totalCny: 2_000, dailyCny: 2_000, articles: [{}, {}, {}], checked: [] });
      await w.fixture.seed.source({ geoProjectId: capped.id, domain: "smjk.cn", layer: "coverage", icpMatches: true, newsIndexed: false, medicalVertical: true });
      // Checked on two conditions, the third never: not admitted either.
      await w.fixture.seed.source({ geoProjectId: capped.id, domain: "health-b.com", layer: "coverage", icpMatches: true, newsIndexed: true });
      const cappedTick = await tickOrders(w.deps);
      const cappedOrders = await orders(store, capped.id);
      assert.equal(cappedOrders.length, 2);
      assert.ok(cappedOrders.every((order) => ["101", "107"].includes(order.resourceId)), "both on jksb.com.cn");
      assert.equal(cappedTick.skipped.no_admitted_outlet, 1);
    } finally { await w.close(); }
  });

  test("the claim references an article carries are taken off before it is sent, the hash is of the reviewed file, and a paid placement keeps its label", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const marker = geoClaimReferenceMarker({ cardId: "ec_AbCd1234Ef", claimId: "dose", revision: 2 });
      const cited = ARTICLE_MARKDOWN.replace("每周注射一次。", `每周注射一次。${marker}`);
      assert.notEqual(cited, ARTICLE_MARKDOWN);
      const p = await w.project({ articles: [{ markdown: cited }] });
      assert.equal((await tickOrders(w.deps)).submitted, 1, "the reviewed file, markers and all, is what the hash binds");
      const [sent] = w.fake.requestsTo("/api/media/send");
      assert.ok(!String(sent.form.content).includes("[[ref:"), "no marker reaches the outlet");
      assert.match(String(sent.form.content), /每周 0\.25 mg，4 周后增至每周 0\.5 mg，每周注射一次。/);
      assert.match(String(sent.form.remark), /商业合作/, "the outlet is asked to carry the label");
      const [article] = await store.getArticles([p.articleIds[0]]);
      assert.equal(article.status, "placed");
      assert.equal(article.placementLabel, "commercial_cooperation", "paid content says so on its own record");
      // What the outlet published is the text without the markers, and the placement verifies against the protected spans sent.
      const [order] = await orders(store, p.id);
      const url = "https://www.jksb.com.cn/p/2026/0925/11.html";
      w.fake.setOrder(order.vendorOrderNid, { status: 2, order_url: url });
      w.reader.pages.set(url, { html: publishedHtml(ARTICLE_MARKDOWN) });
      await tickPoll(w.deps);
      w.clock.advance(HOUR + 60_000);
      assert.equal((await tickVerify(w.deps)).passed, 1);
    } finally { await w.close(); }
  });

  test("lifecycle: submitted → accepted → published → verified → settled, and the money follows", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      const tick = await tickOrders(w.deps);
      assert.equal(tick.submitted, 1);
      let [order] = await orders(store, p.id);
      assert.equal(order.state, "submitted");
      const sends = w.fake.requestsTo("/api/media/send");
      assert.equal(sends.length, 1);
      assert.equal(sends[0].form.third_id, order.id);
      assert.equal(sends[0].form.title, "司美格鲁肽每周注射一次，需要注意什么？");
      assert.match(String(sends[0].form.content), /<td>0\.25 mg<\/td>/);
      assert.ok(!String(sends[0].form.content).includes("<h1>"), "the title travels in its own field");
      assert.equal(sends[0].form.api_key, w.fake.state.apiKey);
      assert.deepEqual(await moneyOf(store, p.id), { budgetCny: 1000, dailyCny: 1000, reservedCny: 110, settledCny: 0, refundedCny: 0, spentCny: 0, availableCny: 890 });
      assert.equal((await store.getArticles([p.articleIds[0]]))[0].status, "placed");

      w.fake.setOrder(order.vendorOrderNid, { status: 1 });
      await tickPoll(w.deps);
      assert.equal((await store.getOrder(order.id)).state, "accepted");
      const url = "https://www.jksb.com.cn/p/2026/0925/9.html";
      w.fake.setOrder(order.vendorOrderNid, { status: 2, order_url: url });
      w.reader.pages.set(url, { html: publishedHtml(ARTICLE_MARKDOWN) });
      await tickPoll(w.deps);
      order = await store.getOrder(order.id);
      assert.equal(order.state, "published");
      assert.equal(order.publishedUrl, url);

      assert.equal((await tickVerify(w.deps)).due, 0, "nothing is due before +1 h");
      w.clock.advance(HOUR + 60_000);
      const verify = await tickVerify(w.deps);
      assert.equal(verify.passed, 1);
      assert.equal(verify.settled, 1);
      order = await store.getOrder(order.id);
      assert.equal(order.state, "settled");
      assert.equal(order.settledCny, 100);
      assert.equal(order.checks[0].checkpoint, "1h");
      assert.equal(order.checks[0].protectedMatched, order.checks[0].protectedTotal);
      assert.deepEqual(await moneyOf(store, p.id), { budgetCny: 1000, dailyCny: 1000, reservedCny: 0, settledCny: 100, refundedCny: 0, spentCny: 100, availableCny: 900 });
      assert.equal((await store.getArticles([p.articleIds[0]]))[0].status, "published");
      const outcomes = await store.getMediaOutcomes([{ mediaType: "website", resourceId: "101" }]);
      assert.deepEqual(outcomes.map((row) => [row.engine, row.placed, row.cited]).sort(), [["deepseek", 1, 0], ["doubao", 1, 0]]);

      // Later checkpoints look again and change nothing when the page holds.
      w.clock.advance(24 * HOUR);
      assert.equal((await tickVerify(w.deps)).passed, 1);
      assert.equal((await store.getOrder(order.id)).checks.length, 2);

      const reconcile = await tickReconcile(w.deps);
      assert.equal(reconcile.status, "ok");
      assert.equal(reconcile.diff, 0);

      // What the 投放 tab reads of it (GeoService.distributionOf, on the database) is the order, its outlet and the ledger: the outlet's name
      // and domain are the catalogue's, the money is the ledger's (asserted above), and an order is its project's owner's alone.
      assert.equal((await marketStatus(w.deps)).configured, true);
      assert.equal((await store.getOrder(order.id)).publishedUrl, url);
      const [outlet] = await store.getMediaRows("website", ["101"]);
      assert.deepEqual([outlet.name, outlet.domain], ["健康时报网首发", "jksb.com.cn"]);
      await assert.rejects(cancelOrder(w.deps, { userId: "someone-else", geoProjectId: p.id, orderId: order.id }), { code: "geo_order_not_found" });

      assert.deepEqual(await noteCitation(w.deps, { url, engine: "deepseek" }), { matched: true, first: true, firstForOrder: true, orderId: order.id, articleId: order.articleId });
      assert.equal((await noteCitation(w.deps, { url, engine: "deepseek" })).first, false);
      assert.equal((await noteCitation(w.deps, { orderId: order.id, engine: "doubao" })).firstForOrder, false);
      const cited = await store.getMediaOutcomes([{ mediaType: "website", resourceId: "101" }]);
      assert.deepEqual(cited.map((row) => [row.engine, row.cited]).sort(), [["deepseek", 1], ["doubao", 1]]);
      assert.deepEqual(await noteCitation(w.deps, { url: "https://elsewhere.example.com/", engine: "kimi" }), { matched: false });
    } finally { await w.close(); }
  });

  test("cancel before acceptance: withdrawn at the vendor, reserve released once the refund is in the balance", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project({ articles: [{}, {}] });
      await tickOrders(w.deps);
      const [first, second] = await orders(store, p.id);
      assert.equal(first.state, "submitted");
      await assert.rejects(cancelOrder(w.deps, { userId: "intruder", geoProjectId: p.id, orderId: first.id }), { code: "geo_order_not_found" });
      const cancelled = await cancelOrder(w.deps, { userId: p.userId, geoProjectId: p.id, orderId: first.id });
      assert.equal(cancelled.state, "cancelled");
      assert.equal(w.fake.requestsTo("/api/media/cancel_order").length, 1);
      assert.equal((await moneyOf(store, p.id)).reservedCny, Math.round((first.reserveCny + second.reserveCny) * 100) / 100, "held until the refund lands");
      const poll = await tickPoll(w.deps);
      assert.equal(poll.refunds, 1);
      assert.equal((await store.getOrder(first.id)).state, "refunded");
      assert.equal((await moneyOf(store, p.id)).reservedCny, second.reserveCny);

      w.fake.setOrder(second.vendorOrderNid, { status: 1 });
      await tickPoll(w.deps);
      await assert.rejects(cancelOrder(w.deps, { userId: p.userId, geoProjectId: p.id, orderId: second.id }), { code: "geo_order_not_cancellable" });
      assert.equal(w.fake.requestsTo("/api/media/cancel_order").length, 1, "an accepted order is not sent a cancel");
      assert.equal((await tickReconcile(w.deps)).status, "ok");
    } finally { await w.close(); }
  });

  test("rejected: refunded only when the flag and the balance agree; the article goes to another outlet", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      await tickOrders(w.deps);
      const [order] = await orders(store, p.id);
      assert.equal(order.resourceId, "101");
      w.fake.setOrder(order.vendorOrderNid, { status: 4, rejection_info: "本媒体不收医疗稿" });
      await tickPoll(w.deps);
      assert.equal((await store.getOrder(order.id)).state, "rejected");
      assert.equal((await moneyOf(store, p.id)).reservedCny, 110);
      // Days pass with no refund flag: the reserve stays held and an operator hears once.
      w.clock.advance(4 * DAY);
      await tickPoll(w.deps);
      await tickPoll(w.deps);
      assert.equal(w.alerts.filter((alert) => alert.type === "refund_overdue" && alert.orderId === order.id).length, 1);
      assert.equal((await moneyOf(store, p.id)).reservedCny, 110);

      w.fake.refund(order.vendorOrderNid, { moveMoney: false });
      const flagged = await tickPoll(w.deps);
      assert.equal(flagged.refunds, 0);
      assert.equal(flagged.pendingRefunds, 1);
      assert.equal((await store.getOrder(order.id)).state, "rejected", "a flag without the money is not a refund");
      assert.ok((await store.listOrderEvents(order.id, 500)).some((event) => event.detail?.phase === "refund_seen"));

      w.fake.adjustBalance(100);
      assert.equal((await tickPoll(w.deps)).refunds, 1);
      assert.equal((await store.getOrder(order.id)).state, "refunded");
      assert.equal((await moneyOf(store, p.id)).reservedCny, 0);
      assert.equal((await moneyOf(store, p.id)).availableCny, 1000);

      await tickOrders(w.deps);
      const again = (await orders(store, p.id)).filter((row) => row.id !== order.id);
      assert.equal(again.length, 1);
      assert.equal(again[0].resourceId, "102", "not the outlet that rejected it");
      assert.equal(again[0].state, "submitted");
      assert.equal((await tickReconcile(w.deps)).status, "ok");
    } finally { await w.close(); }
  });

  test("send timeout: unknown, never resent, the outlet blocked, the balance drop explained, an operator resolves it", options, async () => {
    const w = await world(makeFixture, { sendTimeoutMs: 300 });
    try {
      const store = w.fixture.store;
      const p = await w.project();
      w.fake.state.sendMode = "timeout";
      const tick = await tickOrders(w.deps);
      assert.equal(tick.unknown, 1);
      const [order] = await orders(store, p.id);
      assert.equal(order.state, "unknown");
      assert.equal((await moneyOf(store, p.id)).reservedCny, 110);
      assert.ok(w.alerts.some((alert) => alert.type === "order_unknown" && alert.orderId === order.id));

      w.fake.state.sendMode = "ok";
      await tickOrders(w.deps);
      await tickPoll(w.deps);
      assert.equal(w.fake.requestsTo("/api/media/send").length, 1, "never sent twice");
      assert.equal((await store.getOrder(order.id)).state, "unknown");

      // Another project may not use the blocked outlet either.
      const other = await w.project({ id: "geo_p2", userId: "u2" });
      await tickOrders(w.deps);
      const [placed] = await orders(store, other.id);
      assert.equal(placed.resourceId, "102");
      assert.equal(placed.state, "submitted");

      // The vendor charged for the order we never heard back about.
      w.clock.advance(DAY);
      const reconcile = await tickReconcile(w.deps);
      assert.equal(reconcile.status, "ok");
      assert.equal(reconcile.diff, -100);
      const latest = await store.latestReconciliation();
      assert.deepEqual(latest.details.explainedDebits, [{ orderId: order.id, amountCny: 100 }]);

      const nid = [...w.fake.state.orders.values()].find((row) => row.third_id === order.id).order_nid;
      const resolved = await resolveUnknownOrder(w.deps, { orderId: order.id, operatorId: "op", created: true, vendorOrderNid: nid });
      assert.equal(resolved.state, "submitted");
      assert.equal((await store.getOrder(order.id)).vendorOrderNid, nid);
      w.clock.advance(DAY);
      const next = await tickReconcile(w.deps);
      assert.equal(next.status, "ok");
      assert.equal(next.diff, 0);
    } finally { await w.close(); }
  });

  test("reconciliation: zero diff; an unexplained balance move or a ledger break stops new orders until cleared", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project({ articles: [{}] });
      await tickOrders(w.deps);
      const zero = await tickReconcile(w.deps);
      assert.equal(zero.status, "ok");
      assert.equal(zero.diff, 0);
      assert.equal(zero.projectBreaks, 0);

      w.fake.adjustBalance(-50);
      w.clock.advance(DAY);
      const broken = await tickReconcile(w.deps);
      assert.equal(broken.status, "mismatch");
      assert.equal(broken.residual, -50);
      assert.ok(w.alerts.some((alert) => alert.type === "reconciliation_mismatch"));
      assert.equal((await marketStatus(w.deps)).stopNewOrders.stopped, true);
      w.clock.advance(HOUR);
      const rerun = await tickReconcile(w.deps);
      assert.equal(rerun.residual, 0);
      assert.equal(rerun.status, "mismatch", "a re-run finds the books square again, and still does not lift the stop");
      assert.equal((await store.latestReconciliation()).details.carriedFrom, broken.day);

      await w.fixture.seed.article({ id: "geo_p1_late", userId: p.userId, geoProjectId: p.id, layer: "qa", title: "新稿", groupId: "geo_p1_g1",
        gate: "passed", safety: "clear", contentSha256: sha256Hex(ARTICLE_MARKDOWN), status: "publishable", createdAt: w.clock.now().toISOString() });
      w.bodies.set("geo_p1_late", ARTICLE_MARKDOWN);
      const stopped = await tickOrders(w.deps);
      assert.equal(stopped.skipped.orders_stopped, 1);
      assert.equal(w.fake.requestsTo("/api/media/send").length, 1);
      assert.equal((await clearStop(w.deps, { operatorId: "op", note: "vendor fee, booked" })).cleared, true);
      assert.equal((await tickOrders(w.deps)).submitted, 1);

      // The next day starts from the observed balance; a ledger that disagrees with its orders breaks it again.
      w.clock.advance(DAY);
      assert.equal((await tickReconcile(w.deps)).status, "ok");
      const [order] = await orders(store, p.id);
      await w.fixture.tamperLedger({ geoProjectId: p.id, orderId: order.id, kind: "release", amountCny: 5 });
      w.clock.advance(DAY);
      const ledgerBreak = await tickReconcile(w.deps);
      assert.equal(ledgerBreak.status, "mismatch");
      assert.equal(ledgerBreak.projectBreaks, 1);
      assert.equal((await store.latestReconciliation()).details.projectBreaks[0].problem, "reserve_mismatch");
    } finally { await w.close(); }
  });

  test("post-publication: a changed dose is appealed, the user told, the outlet marked down; a restored page settles", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      await tickOrders(w.deps);
      let [order] = await orders(store, p.id);
      const url = "https://www.jksb.com.cn/p/2026/0925/10.html";
      w.fake.setOrder(order.vendorOrderNid, { status: 2, order_url: url });
      await tickPoll(w.deps);
      w.reader.pages.set(url, { html: publishedHtml(ARTICLE_MARKDOWN.replace("每周 0.5 mg", "每周 5 mg")) });
      w.clock.advance(HOUR + 1);
      const failed = await tickVerify(w.deps);
      assert.equal(failed.failed, 1);
      assert.equal(failed.appeals, 1);
      order = await store.getOrder(order.id);
      assert.equal(order.state, "problem");
      assert.equal(order.appeal.titleId, 2);
      assert.equal(order.appeal.reason, "text_changed");
      assert.equal(w.fake.state.appeals.length, 1);
      assert.equal(w.fake.state.appeals[0].title_id, 2);
      assert.match(w.fake.state.appeals[0].info, /每周 0\.5 mg/);
      assert.equal(w.notices.length, 1);
      assert.equal(w.notices[0].kind, "safety");
      assert.equal(w.notices[0].type, "published_text_changed");
      assert.ok(w.notices[0].changed.includes("每周 0.5 mg"));
      assert.equal((await store.getMediaRows("website", ["101"]))[0].flags.editIncidents, 1);
      assert.equal((await moneyOf(store, p.id)).settledCny, 0, "nothing is paid for a changed article");

      // The outlet restores the text; the vendor closes its after-sale.
      w.reader.pages.set(url, { html: publishedHtml(ARTICLE_MARKDOWN) });
      w.fake.setOrder(order.vendorOrderNid, { status: 2 });
      w.clock.advance(23 * HOUR);
      const restored = await tickVerify(w.deps);
      assert.equal(restored.passed, 1);
      assert.equal(restored.settled, 1);
      assert.equal((await store.getOrder(order.id)).state, "settled");
      assert.equal(w.notices.length, 1, "the user is told once");
      assert.equal(w.fake.state.appeals.length, 1, "an appeal is filed once per reason");
    } finally { await w.close(); }
  });

  test("post-publication: a page still unreachable at +24 h is appealed as a dead link", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      await tickOrders(w.deps);
      const [order] = await orders(store, p.id);
      const url = "https://www.jksb.com.cn/p/gone.html";
      w.fake.setOrder(order.vendorOrderNid, { status: 2, order_url: url });
      await tickPoll(w.deps);
      w.clock.advance(HOUR + 1);
      await tickVerify(w.deps);
      assert.equal((await store.getOrder(order.id)).state, "published", "at +1 h a missing page may not be live yet");
      w.clock.advance(23 * HOUR);
      await tickVerify(w.deps);
      const after = await store.getOrder(order.id);
      assert.equal(after.state, "problem");
      assert.equal(after.appeal.titleId, 3);
      assert.equal(w.fake.state.appeals[0].title_id, 3);
    } finally { await w.close(); }
  });

  test("unconfigured market: plans are made, nothing is sent anywhere", options, async () => {
    const w = await world(makeFixture, { configured: false });
    try {
      const store = w.fixture.store;
      const before = w.fake.state.requests.length;
      const p = await w.project();
      const tick = await tickOrders(w.deps);
      assert.equal(tick.planned, 1);
      assert.equal(tick.submitted, 0);
      assert.equal((await orders(store, p.id))[0].state, "planned");
      for (const run of [tickPoll, tickReconcile, tickTopups, tickCatalogue]) assert.equal((await run(w.deps)).skipped, "market_unconfigured");
      assert.equal(w.fake.state.requests.length, before, "no request reached the vendor");
      assert.equal((await marketStatus(w.deps)).configured, false);
      assert.equal((await marketStatus(w.deps)).notes.includes("market_unconfigured"), true);
      assert.equal((await moneyOf(store, p.id)).reservedCny, 0, "a plan holds no money");
    } finally { await w.close(); }
  });

  test("top-ups: none without a cap; under three days of spend one request, verified by the balance", options, async () => {
    const w = await world(makeFixture, { balance: 150 });
    try {
      const store = w.fixture.store;
      const p = await w.project({ articles: [{}, {}] });
      await tickOrders(w.deps);
      const placed = await orders(store, p.id);
      assert.deepEqual(placed.map((order) => order.state).sort(), ["planned", "submitted"], "the second waits for the platform balance");
      assert.equal(w.fake.state.balance.money, 50);

      const uncapped = await tickTopups(w.deps);
      assert.equal(uncapped.note, "balance_cap_unset");
      assert.equal((await store.listTopups({ limit: 10 })).length, 0);

      const capped = { ...w.deps, config: { ...w.deps.config, mediaMarketBalanceCapCny: 5_000 } };
      const requested = await tickTopups(capped);
      assert.equal(requested.requested, 1);
      const [topup] = await store.listTopups({ limit: 10 });
      // 7-day charges 100/7 + the waiting 120 over 3 days = 54.29 a day; 14 days = 760.06, less the 50 held.
      assert.equal(topup.amountCny, 711);
      assert.equal(topup.status, "requested");
      assert.ok(w.alerts.some((alert) => alert.type === "topup_requested"));
      assert.equal((await tickTopups(capped)).requested, 0, "one open request at a time");

      assert.equal((await confirmTopup(capped, { topupId: topup.id, operatorId: "op" })).status, "awaiting_balance");
      w.fake.adjustBalance(711);
      assert.equal((await tickTopups(capped)).confirmed, 1);
      assert.equal((await store.getTopup(topup.id)).status, "confirmed");
      await assert.rejects(confirmTopup(capped, { topupId: topup.id, operatorId: "op" }), { code: "geo_topup_not_pending" });
      w.clock.advance(DAY);
      assert.equal((await tickReconcile(capped)).status, "ok", "a confirmed top-up is part of the expected balance");
      assert.equal((await tickOrders(capped)).submitted, 1, "the waiting order goes once the money is there");
    } finally { await w.close(); }
  });
}

/**
 * A store that lets a test run something right after one of its writes, as
 * a second writer would. `after(method, args, result)` runs once per call.
 * @param {any} store @param {(method: string, args: any[], result: any) => Promise<void>} after
 */
export function interceptingStore(store, after) {
  return new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return async (/** @type {any[]} */ ...args) => {
        const result = await value.apply(target, args);
        await after(String(key), args, result);
        return result;
      };
    },
  });
}

/** Whether a store write moved an order into `reserved` (either write the market may use). @param {string} method @param {any[]} args */
const reservedBy = (method, args) => method === "reserveForSend" || (method === "transitionOrder" && args[1]?.to === "reserved");

/** A planned order built with the store's own writes. @param {any} store @param {{ userId: string, geoProjectId: string, articleId: string }} key @param {string} at */
async function plannedOrder(store, { userId, geoProjectId, articleId }, at) {
  const [order] = await store.insertOrders([{ userId, geoProjectId, articleId, mediaType: "website", resourceId: "101", priceCny: 100, reserveCny: 110 }], at);
  return order;
}

/**
 * The money path under concurrency and failure (the review of 2026-09-25):
 * each scenario failed before its fix.
 * @param {(name: string, options: any, fn: () => Promise<void>) => any} test
 * @param {() => Promise<MarketFixture>} makeFixture
 * @param {any} [options]
 */
export function defineGeoMarketMoneyPathScenarios(test, makeFixture, options = {}) {
  test("race: a cancel landing right after the reserve never leaves a sent order cancelled", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      /** @type {any} */
      let raced = null;
      const racing = interceptingStore(store, async (method, args, result) => {
        if (!raced && result && reservedBy(method, args)) {
          raced = await cancelOrder({ ...w.deps, store }, { userId: p.userId, geoProjectId: p.id, orderId: args[0] }).catch((error) => error);
        }
      });
      await tickOrders({ ...w.deps, store: racing });
      assert.ok(raced, "the cancel raced the send");
      const [order] = await orders(store, p.id);
      const sends = w.fake.requestsTo("/api/media/send").length;
      if (order.state === "cancelled") assert.equal(sends, 0, "a cancelled order was sent to the vendor");
      else {
        assert.equal(raced.code, "geo_order_in_flight");
        assert.equal(order.state, "submitted");
      }
      assert.deepEqual(projectIdentityBreaks(await orders(store, p.id), await store.ledgerSums({ geoProjectId: p.id })), []);
    } finally { await w.close(); }
  });

  /**
   * A tick in which `change` happens while the file is being read: after the article was checked and before the reserve (M-1).
   * @param {any} w @param {(p: { id: string, articleIds: string[] }) => Promise<void>} change
   */
  const tickWith = async (w, change) => {
    const p = await w.project();
    const inner = w.deps.articleBody;
    w.deps.articleBody = async (/** @type {any} */ article, /** @type {any} */ project) => { await change(p); return inner(article, project); };
    const counts = await tickOrders(w.deps);
    const [order] = await orders(w.fixture.store, p.id);
    return { p, counts, order, sends: w.fake.requestsTo("/api/media/send").length, money: await moneyOf(w.fixture.store, p.id) };
  };

  for (const [name, patch] of /** @type {Array<[string, Record<string, any>]>} */ ([
    ["a clinical-safety finding that opens", { safety: "open", status: "draft" }], ["a withdrawal", { status: "withdrawn" }], ["a failed gate", { gate: "failed" }],
  ])) {
    test(`race (M-1): ${name} after the article was checked stops the send, and the plan with it`, options, async () => {
      const w = await world(makeFixture);
      try {
        const { counts, order, sends, money, p } = await tickWith(w, (p) => w.fixture.alter.article(p.articleIds[0], patch));
        assert.equal(sends, 0, "an article with a finding against it is never placed");
        assert.equal(order.state, "cancelled", "the plan is withdrawn, as at the first check");
        assert.equal(counts.submitted, 0);
        assert.equal(counts.skipped.article_not_placeable, 1);
        assert.deepEqual([money.reservedCny, money.settledCny], [0, 0], "nothing was held");
        assert.deepEqual(projectIdentityBreaks(await orders(w.fixture.store, p.id), await w.fixture.store.ledgerSums({ geoProjectId: p.id })), []);
      } finally { await w.close(); }
    });
  }

  test("race (M-1): an article re-reviewed after its file was read is not sent as the file that was read", options, async () => {
    const w = await world(makeFixture);
    try {
      const { counts, order, sends, money } = await tickWith(w, (p) => w.fixture.alter.article(p.articleIds[0], { contentSha256: "b".repeat(64) }));
      assert.equal(sends, 0, "what goes out is what passed review, and the review moved");
      assert.equal(order.state, "planned", "the plan waits for the next tick, which reads the new file against the new hash");
      assert.equal(counts.skipped.article_changed_since_review, 1);
      assert.deepEqual([money.reservedCny, money.settledCny], [0, 0]);
    } finally { await w.close(); }
  });

  test("race (M-1): a project paused after the tick listed it is not sent for", options, async () => {
    const w = await world(makeFixture);
    try {
      const { counts, order, sends, money } = await tickWith(w, (p) => w.fixture.alter.project(p.id, { status: "paused" }));
      assert.equal(sends, 0, "paused is paused");
      assert.equal(order.state, "planned", "the plan stays for when it is resumed");
      assert.equal(counts.skipped.project_not_active, 1);
      assert.deepEqual([money.reservedCny, money.settledCny], [0, 0]);
    } finally { await w.close(); }
  });

  /**
   * An order sent, published, and about to be verified at +1 h, with a store that fails the first call of one method (M-2).
   * @param {any} w @param {(method: string, args: any[]) => boolean} failing
   */
  const publishedWithFlakyStore = async (w, failing) => {
    const store = w.fixture.store;
    const p = await w.project();
    await tickOrders(w.deps);
    let [order] = await orders(store, p.id);
    w.fake.setOrder(order.vendorOrderNid, { status: 1 });
    await tickPoll(w.deps);
    const url = "https://www.jksb.com.cn/p/2026/0925/9.html";
    w.fake.setOrder(order.vendorOrderNid, { status: 2, order_url: url });
    w.reader.pages.set(url, { html: publishedHtml(ARTICLE_MARKDOWN) });
    await tickPoll(w.deps);
    let failed = false;
    const flaky = new Proxy(store, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return async (/** @type {any[]} */ ...args) => {
          if (!failed && failing(String(key), args)) { failed = true; throw new Error("transient store failure"); }
          return value.apply(target, args);
        };
      },
    });
    w.clock.advance(HOUR + 60_000);
    [order] = await orders(store, p.id);
    return { p, store, flaky, order };
  };

  test("a fault in the bookkeeping beside a settlement no longer strands the verified order with its reserve held (M-2)", options, async () => {
    const w = await world(makeFixture);
    try {
      const { p, store, flaky, order } = await publishedWithFlakyStore(w, (method) => method === "incrementMediaOutcome");
      const first = await tickVerify({ ...w.deps, store: flaky });
      assert.equal(first.errors, 1, "the fault is counted");
      const settled = await store.getOrder(order.id);
      assert.equal(settled.state, "settled", "the money was settled before the bookkeeping");
      assert.equal(settled.settledCny, 100);
      const money = await moneyOf(store, p.id);
      assert.deepEqual([money.reservedCny, money.settledCny], [0, 100], "the reserve is released and the spend recorded");
      assert.deepEqual(projectIdentityBreaks(await orders(store, p.id), await store.ledgerSums({ geoProjectId: p.id })), []);
      const [article] = await store.getArticles([p.articleIds[0]]);
      assert.equal(article.status, "published", "the article's own move ran although the tally before it failed");
    } finally { await w.close(); }
  });

  test("a settlement that failed is finished by a later tick, however late (M-2)", options, async () => {
    const w = await world(makeFixture);
    try {
      const { p, store, flaky, order } = await publishedWithFlakyStore(w, (method, args) => method === "transitionOrder" && args[1]?.to === "settled");
      const first = await tickVerify({ ...w.deps, store: flaky });
      assert.equal(first.errors >= 1, true);
      let current = await store.getOrder(order.id);
      assert.deepEqual([current.state, current.settledCny], ["verified", null], "stranded between the two writes");
      assert.equal((await moneyOf(store, p.id)).reservedCny, 110, "the reserve is still held");
      // Nine days on, past the week the verify list reaches back: the order is settled all the same.
      w.clock.advance(9 * DAY);
      const later = await tickVerify(w.deps);
      assert.deepEqual([later.recovered, later.settled], [1, 1]);
      current = await store.getOrder(order.id);
      assert.deepEqual([current.state, current.settledCny], ["settled", 100]);
      const money = await moneyOf(store, p.id);
      assert.deepEqual([money.reservedCny, money.settledCny], [0, 100]);
      assert.deepEqual(projectIdentityBreaks(await orders(store, p.id), await store.ledgerSums({ geoProjectId: p.id })), []);
      assert.equal((await tickVerify(w.deps)).recovered, 0, "and only once");
    } finally { await w.close(); }
  });

  test("race: a send in flight is not declared unknown before its timeout and margin have passed", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project({ totalCny: null });
      const at = w.clock.now().toISOString();
      const order = await plannedOrder(store, { userId: p.userId, geoProjectId: p.id, articleId: p.articleIds[0] }, at);
      await store.transitionOrder(order.id, { from: ["planned"], to: "reserved", at,
        ledger: [{ kind: "reserve", amountCny: 110, userId: p.userId, geoProjectId: p.id }] });
      await store.annotateOrder(order.id, { at, detail: { phase: "send_started" } });
      w.clock.advance(1_000);
      await tickPoll(w.deps);
      assert.equal((await store.getOrder(order.id)).state, "reserved", "another process may still be waiting for the vendor");
      w.clock.advance(10 * 60_000);
      await tickPoll(w.deps);
      assert.equal((await store.getOrder(order.id)).state, "unknown");
    } finally { await w.close(); }
  });

  test("race: the vendor's order number is kept when the order moved while it was being sent", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      const market = w.market;
      const racingMarket = new Proxy(market, {
        get(target, key) {
          if (key === "send") {
            return async (/** @type {any[]} */ ...args) => {
              const answer = await target.send(...args);
              const [order] = await orders(store, p.id);
              await store.transitionOrder(order.id, { from: ["reserved"], to: "unknown", at: w.clock.now().toISOString(), detail: { reason: "send_interrupted" } });
              return answer;
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await tickOrders({ ...w.deps, market: racingMarket });
      const nid = [...w.fake.state.orders.values()][0].order_nid;
      const [order] = await orders(store, p.id);
      const events = await store.listOrderEvents(order.id, 500);
      assert.ok(events.some((event) => event.detail?.vendorOrderNid === nid), "the order number is in the order's history");
      assert.equal(order.vendorOrderNid, nid);
      assert.equal(order.state, "submitted", "a late answer settles the unknown");
      assert.ok(w.alerts.some((alert) => alert.type === "order_late_send_result" && alert.orderId === order.id));
    } finally { await w.close(); }
  });

  test("failure: the vendor's order number is kept when recording the send fails after the vendor answered (M-9)", options, async () => {
    // The vendor created the order, and the write that moves ours to `submitted` threw: the number used to be dropped on the floor, and the
    // order ended `unknown` for an operator to find by hand.
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      const refuse = (/** @type {string[]} */ methods) => new Proxy(store, {
        get(target, key) {
          if (typeof key === "string" && methods.includes(key)) {
            return async (/** @type {any[]} */ ...args) => {
              if (key === "transitionOrder" && args[1]?.to !== "submitted") return target.transitionOrder(args[0], args[1]);
              throw new Error("connection lost");
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const first = await tickOrders({ ...w.deps, store: refuse(["transitionOrder"]) });
      const nid = [...w.fake.state.orders.values()][0].order_nid;
      assert.ok(nid, "the vendor created the order");
      const [order] = await orders(store, p.id);
      const events = await store.listOrderEvents(order.id, 500);
      assert.ok(events.some((event) => event.detail?.phase === "late_send_result" && event.detail?.vendorOrderNid === nid), "the order number is in the order's history");
      assert.ok(w.alerts.some((alert) => alert.type === "order_late_send_result" && alert.orderId === order.id && alert.vendorOrderNid === nid), "and an operator is told with it");
      assert.equal(first.unknown, 1, "the send counts as one the operator holds, not as an error");
      assert.equal(first.skipped.error ?? 0, 0);
      // The outlet is not sent to again meanwhile: the vendor has an order there that ours does not know.
      const sends = [...w.fake.state.orders.values()].length;
      await tickOrders(w.deps);
      assert.equal([...w.fake.state.orders.values()].length, sends, "nothing more is sent to the outlet or for the article");
    } finally { await w.close(); }
  });

  test("failure: the number reaches the operator even when the order's history cannot be written either (M-9)", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      const down = new Proxy(store, {
        get(target, key) {
          if (key === "annotateOrder") return async () => { throw new Error("connection lost"); };
          if (key === "transitionOrder") {
            return async (/** @type {any} */ id, /** @type {any} */ change) => {
              if (change.to === "submitted") throw new Error("connection lost");
              return target.transitionOrder(id, change);
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await tickOrders({ ...w.deps, store: down });
      const nid = [...w.fake.state.orders.values()][0].order_nid;
      const [order] = await orders(store, p.id);
      assert.ok(w.alerts.some((alert) => alert.type === "order_late_send_result" && alert.orderId === order.id && alert.vendorOrderNid === nid),
        "the alert is the last place the number is kept");
    } finally { await w.close(); }
  });

  test("撤单: a plan the user cancelled is not placed again on the same outlet", options, async () => {
    const w = await world(makeFixture, { configured: false });
    try {
      const store = w.fixture.store;
      const p = await w.project();
      await tickOrders(w.deps);
      const [first] = await orders(store, p.id);
      assert.equal(first.state, "planned");
      assert.equal((await cancelOrder(w.deps, { userId: p.userId, geoProjectId: p.id, orderId: first.id })).state, "cancelled");
      await tickOrders(w.deps);
      const again = (await orders(store, p.id)).filter((order) => order.id !== first.id);
      assert.equal(again.length, 1);
      assert.notEqual(again[0].resourceId, first.resourceId, "the outlet the user cancelled is not chosen again");
    } finally { await w.close(); }
  });

  test("failure: one order's reserve failing neither aborts the tick nor strands money", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project({ articles: [{}, {}] });
      let failed = false;
      const flaky = new Proxy(store, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          return async (/** @type {any[]} */ ...args) => {
            if (!failed && reservedBy(String(key), args)) { failed = true; throw new Error("connection terminated unexpectedly"); }
            return value.apply(target, args);
          };
        },
      });
      const tick = await tickOrders({ ...w.deps, store: flaky });
      assert.ok(failed);
      assert.equal(tick.submitted, 1, "the other order went");
      const states = (await orders(store, p.id)).map((order) => order.state).sort();
      assert.deepEqual(states, ["planned", "submitted"]);
      assert.deepEqual(projectIdentityBreaks(await orders(store, p.id), await store.ledgerSums({ geoProjectId: p.id })), []);
    } finally { await w.close(); }
  });

  test("failure: a reserve that never reached a send is released after ten minutes", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      const at = w.clock.now().toISOString();
      const order = await plannedOrder(store, { userId: p.userId, geoProjectId: p.id, articleId: p.articleIds[0] }, at);
      await store.transitionOrder(order.id, { from: ["planned"], to: "reserved", at,
        ledger: [{ kind: "reserve", amountCny: 110, userId: p.userId, geoProjectId: p.id }] });
      await tickPoll(w.deps);
      assert.equal((await store.getOrder(order.id)).state, "reserved");
      w.clock.advance(11 * 60_000);
      await tickPoll(w.deps);
      assert.equal((await store.getOrder(order.id)).state, "planned");
      assert.equal((await moneyOf(store, p.id)).reservedCny, 0);
    } finally { await w.close(); }
  });

  test("refunds and top-ups: a paid top-up is not taken for a refund", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      await tickOrders(w.deps);
      const [order] = await orders(store, p.id);
      w.fake.setOrder(order.vendorOrderNid, { status: 4 });
      w.fake.refund(order.vendorOrderNid, { moveMoney: false });
      const topup = await store.insertTopup({ amountCny: 150, balanceBefore: w.fake.state.balance.money, at: w.clock.now().toISOString() });
      w.fake.adjustBalance(150);
      await tickPoll(w.deps);
      assert.equal((await store.getOrder(order.id)).state, "rejected", "the balance moved by the top-up, not by the refund");
      assert.equal((await store.getTopup(topup.id)).status, "confirmed", "top-ups are settled before refunds");
      w.fake.adjustBalance(100);
      await tickPoll(w.deps);
      assert.equal((await store.getOrder(order.id)).state, "refunded");
      assert.equal((await tickReconcile(w.deps)).status, "ok");
    } finally { await w.close(); }
  });

  test("refunds and top-ups: a refund is not taken for a paid top-up", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      await tickOrders(w.deps);
      const [order] = await orders(store, p.id);
      w.fake.setOrder(order.vendorOrderNid, { status: 4 });
      await tickPoll(w.deps);
      const topup = await store.insertTopup({ amountCny: 80, balanceBefore: w.fake.state.balance.money, at: w.clock.now().toISOString() });
      w.fake.refund(order.vendorOrderNid);
      w.clock.advance(60_000);
      await tickTopups({ ...w.deps, config: { ...w.deps.config, mediaMarketBalanceCapCny: 5_000 } });
      assert.equal((await store.getTopup(topup.id)).status, "requested", "the money is the refund's");
      await tickPoll(w.deps);
      assert.equal((await store.getOrder(order.id)).state, "refunded");
      assert.equal((await store.getTopup(topup.id)).status, "requested");
    } finally { await w.close(); }
  });

  test("send: a failure after the vendor answered is unknown and never resent", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      w.fake.state.sendQueue = ["http429"];
      await tickOrders(w.deps);
      await tickOrders(w.deps);
      const [order] = await orders(store, p.id);
      assert.equal(order.state, "unknown");
      assert.equal(w.fake.requestsTo("/api/media/send").length, 1);
      assert.equal(w.fake.state.orders.size, 1, "no second order at the vendor");
    } finally { await w.close(); }
  });

  test("send: a request the client refuses to send cancels the plan instead of looping", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const big = `# 太大的稿件\n\n${"司美格鲁肽每周注射一次。".repeat(60_000)}`;
      const p = await w.project({ articles: [{ markdown: big }] });
      await tickOrders(w.deps);
      await tickOrders(w.deps);
      const mine = await orders(store, p.id);
      assert.ok(mine.every((order) => order.state === "cancelled"), mine.map((order) => order.state).join());
      assert.equal(w.fake.requestsTo("/api/media/send").length, 0);
      assert.equal((await moneyOf(store, p.id)).reservedCny, 0);
    } finally { await w.close(); }
  });

  test("audience: no order is placed for an account the module is no longer open to", options, async () => {
    const w = await world(makeFixture, { config: { geoAudience: "operators", operatorUsers: ["someone-else"], geoPreviewUsers: [] } });
    try {
      const store = w.fixture.store;
      const p = await w.project();
      const tick = await tickOrders(w.deps);
      assert.equal(tick.planned, 0);
      assert.equal(tick.skipped.audience_not_allowed, 1);
      assert.equal((await orders(store, p.id)).length, 0);
      assert.equal(w.fake.requestsTo("/api/media/send").length, 0);
    } finally { await w.close(); }
  });

  test("concurrency: two ticks at once plan an article once", options, async () => {
    const w = await world(makeFixture, { configured: false });
    try {
      const store = w.fixture.store;
      const p = await w.project();
      await Promise.all([tickOrders(w.deps), tickOrders(w.deps)]);
      assert.equal((await orders(store, p.id)).length, 1);
    } finally { await w.close(); }
  });

  test("concurrency: an article holds one live order at most (the store refuses a second)", options, async () => {
    const w = await world(makeFixture, { configured: false });
    try {
      const store = w.fixture.store;
      const p = await w.project({ totalCny: null });
      const at = w.clock.now().toISOString();
      await plannedOrder(store, { userId: p.userId, geoProjectId: p.id, articleId: p.articleIds[0] }, at);
      await assert.rejects(plannedOrder(store, { userId: p.userId, geoProjectId: p.id, articleId: p.articleIds[0] }, at), { code: "geo_order_article_live" });
    } finally { await w.close(); }
  });

  test("budget: a budget lowered while an order is being placed is honoured at the reserve", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      const body = w.deps.articleBody;
      let lowered = false;
      const deps = {
        ...w.deps,
        articleBody: async (/** @type {any} */ article, /** @type {any} */ project) => {
          if (!lowered) { lowered = true; await setBudget(w.deps, { userId: p.userId, geoProjectId: p.id, totalCny: 50, dailyCny: 50 }); }
          return body(article, project);
        },
      };
      await tickOrders(deps);
      assert.ok(lowered);
      const [order] = await orders(store, p.id);
      assert.notEqual(order.state, "submitted");
      assert.equal(w.fake.requestsTo("/api/media/send").length, 0);
      assert.equal((await moneyOf(store, p.id)).reservedCny, 0);
    } finally { await w.close(); }
  });

  test("budget: the daily cap nets out a reserve released the same day", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project({ totalCny: 1_000, dailyCny: 150, articles: [{}, {}] });
      w.fake.state.sendQueue = ["refuse"];
      const tick = await tickOrders(w.deps);
      assert.equal(tick.refused, 1);
      assert.equal(tick.submitted, 1, "the refused order's reserve came back the same day");
      const states = (await orders(store, p.id)).map((order) => order.state).sort();
      assert.deepEqual(states, ["cancelled", "submitted"]);
    } finally { await w.close(); }
  });

  test("write-off: an order priced above its reserve is written off at its price", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      const p = await w.project();
      await tickOrders(w.deps);
      let [order] = await orders(store, p.id);
      const url = "https://www.jksb.com.cn/p/over.html";
      w.fake.setOrder(order.vendorOrderNid, { status: 2, order_url: url, price: "150.00" });
      w.reader.pages.set(url, { html: publishedHtml(ARTICLE_MARKDOWN) });
      await tickPoll(w.deps);
      w.clock.advance(HOUR + 1);
      await tickVerify(w.deps);
      order = await store.getOrder(order.id);
      assert.equal(order.state, "problem", "never paid above the reserve automatically");
      const lost = await markOrderLost(w.deps, { orderId: order.id, operatorId: "op", reason: "vendor charged 150" });
      assert.equal(lost.state, "lost");
      assert.equal((await store.getOrder(order.id)).settledCny, 150);
      const money = await moneyOf(store, p.id);
      assert.equal(money.spentCny, 150);
      assert.equal(money.reservedCny, 0);
      assert.equal(money.availableCny, 850);
      assert.deepEqual(projectIdentityBreaks(await orders(store, p.id), await store.ledgerSums({ geoProjectId: p.id })), []);
    } finally { await w.close(); }
  });

  test("turns (M-3): a project past the first page is planned in the tick that reaches it, not never", options, async () => {
    const w = await world(makeFixture, { configured: false });
    try {
      const store = w.fixture.store;
      const page = MARKET_RULES.projectsPerPage;
      // The fiftieth projects, older than the next, with nothing to place; then one more with an article. The tick read the fifty oldest
      // and stopped, so the fifty-first was out of every tick that ever ran.
      for (let index = 0; index < page; index += 1) await w.project({ id: `geo_old${String(index).padStart(2, "0")}`, userId: `u_old${index}`, articles: [] });
      const late = await w.project({ id: "geo_late", userId: "u_late", articles: [{}] });
      const tick = await tickOrders(w.deps);
      assert.equal(tick.projects, page + 1, "every project with a budget had its turn");
      assert.equal(tick.planned, 1);
      assert.equal((await orders(store, late.id)).length, 1);
      assert.equal((await tickOrders(w.deps)).projects, page + 1, "and the next tick again, whichever is first");
    } finally { await w.close(); }
  });

  test("turns (M-3): with more projects than a tick may send for, each is sent for in turn", options, async () => {
    const w = await world(makeFixture, { balance: 1_000_000 });
    try {
      const store = w.fixture.store;
      const count = MARKET_RULES.projectsPerPage + 10;
      const ids = [];
      for (let index = 0; index < count; index += 1) {
        const id = `geo_n${String(index).padStart(3, "0")}`;
        ids.push(id);
        await w.project({ id, userId: `u_${id}`, articles: [{}], totalCny: 1_000, dailyCny: 1_000 });
      }
      const ticks = Math.ceil(count / MARKET_RULES.sendsPerTick);
      let sent = 0;
      for (let tick = 1; tick <= ticks; tick += 1) {
        const counts = await tickOrders(w.deps);
        assert.ok(counts.submitted <= MARKET_RULES.sendsPerTick, "the sends of a tick stay under its cap");
        sent += counts.submitted;
      }
      assert.equal(sent, count, `${count} projects, ${ticks} ticks`);
      const unsent = [];
      for (const id of ids) if (!(await orders(store, id)).some((order) => order.state === "submitted")) unsent.push(id);
      assert.deepEqual(unsent, [], "the ones the first page could not reach were sent for as well");
    } finally { await w.close(); }
  });

  test("turns (M-3): a tick that has made its sends stops there, and the projects it did not reach come first in the next", options, async () => {
    const w = await world(makeFixture, { balance: 1_000_000 });
    try {
      const store = w.fixture.store;
      const count = MARKET_RULES.sendsPerTick + 2;
      const ids = [];
      for (let index = 0; index < count; index += 1) {
        const id = `geo_s${String(index).padStart(2, "0")}`;
        ids.push(id);
        await w.project({ id, userId: `u_${id}`, articles: [{}], totalCny: 1_000, dailyCny: 1_000 });
      }
      const first = await tickOrders(w.deps);
      assert.equal(first.submitted, MARKET_RULES.sendsPerTick);
      assert.equal(first.projects, MARKET_RULES.sendsPerTick, "it went no further than the project that made the last send");
      assert.equal((await orders(store, ids.at(-1))).length, 0, "the two it did not reach have no plan yet");
      const second = await tickOrders(w.deps);
      assert.equal(second.submitted, 2, "the two it did not reach");
      assert.deepEqual((await orders(store, ids.at(-1))).map((order) => order.state), ["submitted"]);
      assert.equal(second.projects, count, "and then the rest, whose orders are sent already");
    } finally { await w.close(); }
  });

  test("turns (M-3): a project that is skipped every tick does not keep its place at the front", options, async () => {
    // The module closed to the account of every project of the first page: they are skipped in every tick, and before turns they
    // were the first page of every tick, so the project after them was never reached.
    const w = await world(makeFixture, { configured: false });
    try {
      const store = w.fixture.store;
      const page = MARKET_RULES.projectsPerPage;
      const blocked = new Set();
      for (let index = 0; index < page; index += 1) {
        const id = `geo_x${String(index).padStart(2, "0")}`;
        blocked.add(`u_${id}`);
        await w.project({ id, userId: `u_${id}`, articles: [{}] });
      }
      const open = await w.project({ id: "geo_open", userId: "u_open", articles: [{}] });
      const deps = { ...w.deps, config: { ...w.deps.config, geoAudience: "operators", operatorUsers: ["u_open"] } };
      const tick = await tickOrders(deps);
      assert.equal(tick.skipped.audience_not_allowed, page);
      assert.equal(tick.planned, 1);
      assert.equal((await orders(store, open.id)).length, 1);
      assert.equal(blocked.size, page);
    } finally { await w.close(); }
  });

  test("reconciliation (M-3): a project past the five-hundredth is checked too", options, async () => {
    const w = await world(makeFixture);
    try {
      const store = w.fixture.store;
      // Five hundred projects older than the one with the break: a budget, no orders, nothing to reconcile.
      const older = new Date(w.clock.now().getTime() - 30 * DAY).toISOString();
      for (let index = 0; index < 500; index += 1) {
        await w.fixture.seed.project({ id: `geo_f${String(index).padStart(3, "0")}`, userId: `u_f${index}`, budget: { totalCny: 100, dailyCny: 100 }, createdAt: older });
      }
      const p = await w.project({ articles: [{}] });
      await tickOrders(w.deps);
      assert.equal((await tickReconcile(w.deps)).status, "ok");
      const [order] = await orders(store, p.id);
      await w.fixture.tamperLedger({ geoProjectId: p.id, orderId: order.id, kind: "release", amountCny: 5 });
      w.clock.advance(DAY);
      const broken = await tickReconcile(w.deps);
      assert.equal(broken.projectBreaks, 1, "the 501st project's ledger disagrees with its orders, and the reconciliation says so");
      assert.equal(broken.status, "mismatch");
      assert.equal((await store.latestReconciliation()).details.projectBreaks[0].geoProjectId, p.id);
    } finally { await w.close(); }
  });

  test("turns (M-3): the store lists active budgeted projects never served first, then the one served longest ago, and marks are bounded", options, async () => {
    const w = await world(makeFixture, { configured: false });
    try {
      const store = w.fixture.store;
      const at = (/** @type {number} */ minute) => new Date(Date.parse("2026-10-10T00:00:00.000Z") + minute * 60_000).toISOString();
      const budget = { totalCny: 100, dailyCny: 100 };
      for (const [index, id] of ["geo_a", "geo_b", "geo_c", "geo_d"].entries()) await w.fixture.seed.project({ id, userId: `u_${id}`, budget, createdAt: at(index) });
      await w.fixture.seed.project({ id: "geo_paused", userId: "u_paused", budget, status: "paused", createdAt: at(0) });
      await w.fixture.seed.project({ id: "geo_nobudget", userId: "u_nobudget", createdAt: at(0) });
      const turn = async (/** @type {number} */ limit = 50, /** @type {number} */ offset = 0) => (await store.listProjectsInTurn(limit, { offset })).map((project) => project.id);
      assert.deepEqual(await turn(), ["geo_a", "geo_b", "geo_c", "geo_d"], "none served: by age; a paused project and one without a budget have no turn");
      assert.equal(await store.markProjectsServed(["geo_a", "geo_c", "geo_nowhere"], at(10)), 2, "a project that is not there is not marked");
      assert.deepEqual(await turn(), ["geo_b", "geo_d", "geo_a", "geo_c"], "the ones never served first; the ones served at the same time by age");
      await store.markProjectsServed(["geo_b"], at(20));
      await store.markProjectsServed(["geo_a"], at(30));
      assert.deepEqual(await turn(), ["geo_d", "geo_c", "geo_b", "geo_a"], "then the one served longest ago");
      assert.deepEqual(await turn(2), ["geo_d", "geo_c"]);
      assert.deepEqual(await turn(2, 2), ["geo_b", "geo_a"], "a page at a time through the same order");
      assert.deepEqual(await turn(2, 4), []);
      // A project's turn is not an edit, and a stable list for reconciling is still by age and still pages.
      assert.deepEqual((await store.listBudgetedProjects(2, { activeOnly: false, offset: 0 })).map((project) => project.id), ["geo_a", "geo_paused"]);
      assert.deepEqual((await store.listBudgetedProjects(2, { activeOnly: false, offset: 2 })).map((project) => project.id), ["geo_b", "geo_c"]);
      assert.deepEqual((await store.listBudgetedProjects(10, { activeOnly: false, offset: 4 })).map((project) => project.id), ["geo_d"]);
      await assert.rejects(store.listProjectsInTurn(501), { code: "geo_market_store_invalid" });
      await assert.rejects(store.listProjectsInTurn(10, { offset: 100_001 }), { code: "geo_market_store_invalid" });
      await assert.rejects(store.listBudgetedProjects(10, { offset: -1 }), { code: "geo_market_store_invalid" });
      await assert.rejects(store.markProjectsServed(Array.from({ length: 10_001 }, (_, index) => `geo_${index}`), at(40)), { code: "geo_market_store_invalid" });
      await assert.rejects(store.markProjectsServed(["geo_a"], "not a time"), { code: "geo_market_store_invalid" });
      assert.equal(await store.markProjectsServed([], at(40)), 0);
    } finally { await w.close(); }
  });

  /**
   * `count` articles of the project written before its others, each seeded as `status` in `group`, and — with `holding` — each holding
   * one planned order (a live order, whatever came after it: the market's rule is the same for planned, placed and settled).
   * @param {any} w @param {{ id: string, userId: string }} p @param {number} count
   * @param {{ status?: string, group?: string, holding?: boolean }} [options]
   */
  const writtenBefore = async (w, p, count, { status = "placed", group = "g1", holding = true } = {}) => {
    const at = w.clock.now().toISOString();
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      const id = `${p.id}_old${String(index).padStart(3, "0")}`;
      ids.push(id);
      w.bodies.set(id, ARTICLE_MARKDOWN);
      await w.fixture.seed.article({ id, userId: p.userId, geoProjectId: p.id, layer: "popular", title: `旧稿 ${index}`, groupId: `${p.id}_${group}`, gate: "passed", safety: "clear",
        contentSha256: sha256Hex(ARTICLE_MARKDOWN), status, createdAt: new Date(Date.parse(at) - DAY - (count - index) * 1_000).toISOString() });
      if (holding) {
        await w.fixture.store.insertOrders([{ userId: p.userId, geoProjectId: p.id, articleId: id, mediaType: "website", resourceId: "101", priceCny: 100, reserveCny: 110 }], at);
      }
    }
    return ids;
  };

  test("window (M-4): articles that already hold an order do not keep a new one out of the plan", options, async () => {
    const w = await world(makeFixture, { configured: false });
    try {
      const store = w.fixture.store;
      // Two hundred articles placed long ago, each holding its order, and two new ones. The list was the oldest two hundred articles
      // that may be placed, placed ones included, so after the two hundredth placement a new article was never planned.
      const p = await w.project({ totalCny: 100_000, dailyCny: 100_000, articles: [{}, {}] });
      await writtenBefore(w, p, 200);
      const tick = await tickOrders(w.deps);
      const fresh = (await orders(store, p.id)).filter((order) => p.articleIds.includes(order.articleId));
      assert.equal(tick.planned, 2, "both new articles are planned");
      assert.deepEqual(fresh.map((order) => order.state), ["planned", "planned"]);
      assert.equal((await orders(store, p.id)).length, 202);
    } finally { await w.close(); }
  });

  test("window (M-4): what the plans already made hold back from the budget is all of them, not those of the articles listed", options, async () => {
    const w = await world(makeFixture, { configured: false });
    try {
      const store = w.fixture.store;
      // Two hundred planned reserves of 110 hold back 22,000 of 22,200: room for one more placement (132 or 165), not two.
      const p = await w.project({ totalCny: 22_200, dailyCny: 22_200, articles: [{}, {}] });
      await writtenBefore(w, p, 200);
      const tick = await tickOrders(w.deps);
      assert.equal(tick.planned, 1, "one placement fits in what is left");
      assert.equal(tick.skipped.budget_exhausted, 1);
      assert.equal((await orders(store, p.id)).length, 201);
    } finally { await w.close(); }
  });

  test("window (M-4): an article whose placement failed is a candidate again, however old", options, async () => {
    const w = await world(makeFixture, { configured: false });
    try {
      const store = w.fixture.store;
      const p = await w.project({ totalCny: 100_000, dailyCny: 100_000, articles: [] });
      const [oldId] = await writtenBefore(w, p, 1, { holding: false });
      const at = w.clock.now().toISOString();
      const [first] = await store.insertOrders([{ userId: p.userId, geoProjectId: p.id, articleId: oldId, mediaType: "website", resourceId: "101", priceCny: 100, reserveCny: 110 }], at);
      await store.transitionOrder(first.id, { from: ["planned"], to: "cancelled", at, detail: { reason: "cancelled_by_user" } });
      const tick = await tickOrders(w.deps);
      assert.equal(tick.planned, 1, "it holds no order now");
      const mine = await orders(store, p.id);
      assert.deepEqual(mine.map((order) => [order.state, order.resourceId === "101"]).sort(), [["cancelled", true], ["planned", false]], "on another outlet than the one that failed");
    } finally { await w.close(); }
  });

  test("window (M-4): two hundred control-group articles, which are never placed, do not keep a new one out either", options, async () => {
    const w = await world(makeFixture, { configured: false });
    try {
      const store = w.fixture.store;
      const p = await w.project({ totalCny: 5_000, dailyCny: 5_000, articles: [{}] });
      await writtenBefore(w, p, 200, { status: "published", group: "gc", holding: false });
      const tick = await tickOrders(w.deps);
      assert.equal(tick.planned, 1);
      assert.deepEqual((await orders(store, p.id)).map((order) => order.articleId), p.articleIds);
      assert.equal(tick.skipped.control_group_article, 199, "the new article took the first place of the two hundred; the control-group ones fill the rest and are skipped by name");
    } finally { await w.close(); }
  });

  test("window (M-4): the store lists the articles that hold no order in the given states, control-group ones last", options, async () => {
    const w = await world(makeFixture, { configured: false });
    try {
      const store = w.fixture.store;
      const p = await w.project({ totalCny: 100_000, dailyCny: 100_000, articles: [{ control: true }, {}] });
      const [held] = await writtenBefore(w, p, 1);
      const ids = async (/** @type {readonly string[]} */ states, limit = 200) => (await store.listPlaceableArticles(p.id, limit, { withoutOrderIn: states })).map((article) => article.id);
      assert.deepEqual(await ids([]), [held, p.articleIds[1], p.articleIds[0]], "with no state named every article is listed: the oldest first, the control-group one last");
      assert.deepEqual(await ids(["planned"]), [p.articleIds[1], p.articleIds[0]], "the one holding a planned order is not");
      assert.deepEqual(await ids(["settled"]), [held, p.articleIds[1], p.articleIds[0]], "an order in another state does not hold it");
      assert.deepEqual(await ids(["planned"], 1), [p.articleIds[1]]);
      await assert.rejects(store.listPlaceableArticles(p.id, 10, { withoutOrderIn: ["no_such_state"] }), { code: "geo_market_store_invalid" });
    } finally { await w.close(); }
  });
}
