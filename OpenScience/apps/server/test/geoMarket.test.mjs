// The market's rules as pure functions, then the whole loop against the
// in-memory store double and a fake vendor (the same scenarios run on
// PostgreSQL in geoMarket.integration.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import {
  ORDER_TRANSITIONS,
  VENDOR_STATUS_MAP,
  articleProblems,
  catalogueVerdict,
  dueCheckpoint,
  outletProblems,
  projectIdentityBreaks,
  projectMoney,
  registrableDomain,
  reserveFor,
  scoreOutlet,
  setBudget,
  zonedDay,
  zonedDayStart,
} from "../src/geoMarket.mjs";
import { ORDER_STATES, assertLedgerRow } from "../src/geoMarketStore.mjs";
import { defineGeoMarketMoneyPathScenarios, defineGeoMarketScenarios } from "./helpers/geoMarketScenarios.mjs";
import { GeoMarketStoreDouble } from "./helpers/geoMarketStoreDouble.mjs";

const admitted = {
  resourceId: "1", mediaType: "website", available: true, blacklisted: false, priceCny: 100, domain: "jksb.com.cn", domainVerified: true,
  flags: { medicalCategory: true, newsSourceCategory: true },
};
const article = { id: "a", status: "publishable", isControl: false, safety: "clear", gate: "passed", contentSha256: "a".repeat(64), layer: "popular" };

test("registrable domains follow the Chinese second-level suffixes", () => {
  assert.equal(registrableDomain("www.jksb.com.cn"), "jksb.com.cn");
  assert.equal(registrableDomain("news.qq.com"), "qq.com");
  assert.equal(registrableDomain("myzg.china.com.cn"), "china.com.cn");
  assert.equal(registrableDomain("info.fj.cn"), "info.fj.cn");
  assert.equal(registrableDomain("WWW.Sohu.COM."), "sohu.com");
  assert.equal(registrableDomain("127.0.0.1"), null);
  assert.equal(registrableDomain("localhost"), null);
  assert.equal(registrableDomain("com.cn"), null);
});

test("the catalogue's own words: blacklist rules and remark flags", () => {
  const verdict = (/** @type {string} */ title, /** @type {string} */ remarks, main = ["健康医疗"], all = main) =>
    catalogueVerdict({ title, remarks, mainCategoryTitles: main, categoryTitles: all });
  assert.equal(verdict("某网", "医疗不发").blacklistReason, "refuses_medical");
  assert.equal(verdict("某网", "医疗金融不发，改稿不通知").blacklistReason, "refuses_medical");
  assert.equal(verdict("某网", "肿瘤、癌症、整形、处方药等内容不发").blacklistReason, "refuses_medical");
  assert.equal(verdict("某网", "不发医药类稿件").blacklistReason, "refuses_medical");
  assert.equal(verdict("淘江湖（医疗排名）", "").blacklistReason, "community_ranking_slot");
  assert.equal(verdict("某网", "可发GEO医疗排名类稿件").blacklistReason, "community_ranking_slot");
  assert.equal(verdict("某网", "可带网址、二维码任何联系方式").blacklistReason, "contact_allowed");
  // The catalogue's ordinary boilerplate is not a refusal.
  for (const remarks of ["不带联系方式二维码  周末可以发，稍微修改不通知", "负面维权类不发", "联系方式默认删除", "可发保健品", "默认删除任何联系方式"]) {
    assert.equal(verdict("某网", remarks).blacklisted, false, remarks);
  }
  const flags = verdict("搜狐网快讯（包收录）", "节假日正常出链接，修改不通知，链接时效包一个月").flags;
  assert.equal(flags.silentEdits, true);
  assert.equal(flags.indexingPromise, true);
  assert.equal(flags.weekend, true);
  assert.equal(flags.linkDays, 30);
  assert.equal(verdict("某网", "下午3点截稿 修改不通知 收录不包").flags.indexingPromise, false);
  assert.equal(verdict("某网", "", ["生活消费"], ["生活消费", "健康医疗"]).flags.medicalCategory, false, "only the main category names the channel");
  assert.equal(verdict("某网", "", ["生活消费"], ["生活消费", "百度新闻源"]).flags.newsSourceCategory, true);
});

test("admission: the three conditions, the blacklist, the price and domain caps, an unknown order", () => {
  assert.deepEqual(outletProblems(admitted), []);
  assert.deepEqual(outletProblems({ ...admitted, priceCny: 2000 }), [], "the cap itself is allowed");
  assert.deepEqual(outletProblems({ ...admitted, priceCny: 2000.01 }), ["price_above_auto_cap"]);
  assert.deepEqual(outletProblems({ ...admitted, domainVerified: null }), ["domain_unverified"]);
  assert.deepEqual(outletProblems({ ...admitted, flags: { medicalCategory: false, newsSourceCategory: true } }), ["not_medical"]);
  assert.deepEqual(outletProblems({ ...admitted, flags: { medicalCategory: true } }), ["not_news_indexed"]);
  assert.deepEqual(outletProblems({ ...admitted, flags: {} }, { source: { newsIndexed: true, medicalVertical: true } }), [], "the source table can supply both");
  assert.deepEqual(outletProblems(admitted, { source: { newsIndexed: false } }), ["not_news_indexed"], "our own check outranks the vendor's label");
  assert.deepEqual(outletProblems(admitted, { source: { icpMatches: false } }), ["icp_mismatch"]);
  assert.deepEqual(outletProblems(admitted, { source: { impostor: true } }), ["impostor"]);
  assert.deepEqual(outletProblems(admitted, { domainCount: 1 }), []);
  assert.deepEqual(outletProblems(admitted, { domainCount: 2 }), ["domain_cap_reached"]);
  assert.deepEqual(outletProblems(admitted, { outletBlocked: true }), ["outlet_unknown_order"]);
  assert.deepEqual(outletProblems({ ...admitted, blacklisted: true, blacklistReason: "contact_allowed" }), ["blacklisted:contact_allowed"]);
  assert.deepEqual(outletProblems({ ...admitted, available: false }), ["media_unavailable"]);

  assert.deepEqual(articleProblems(article), []);
  assert.deepEqual(articleProblems({ ...article, safety: "released" }), []);
  assert.deepEqual(articleProblems({ ...article, isControl: true }), ["control_group_article"]);
  assert.deepEqual(articleProblems({ ...article, safety: "open" }), ["safety_open"]);
  assert.deepEqual(articleProblems({ ...article, safety: null }), ["safety_unreviewed"]);
  assert.deepEqual(articleProblems({ ...article, gate: "failed" }), ["gate_failed"]);
  assert.deepEqual(articleProblems({ ...article, contentSha256: null }), ["article_unhashed"]);
  assert.deepEqual(articleProblems({ ...article, status: "withdrawn" }), ["article_not_publishable"]);
  assert.deepEqual(articleProblems({ ...article, layer: "card" }), ["owned_layer_only"]);
});

test("scoring prefers outlets our engines cite, then fit, price, rate and speed, less observed edits", () => {
  const base = { ...admitted, publishRate: 80, publishSeconds: 7200, flags: {} };
  const plain = scoreOutlet(base, { article, engines: ["deepseek"], outcomes: [] });
  const cited = scoreOutlet(base, { article, engines: ["deepseek"], outcomes: [{ engine: "deepseek", placed: 2, cited: 2 }] });
  const citedElsewhere = scoreOutlet(base, { article, engines: ["deepseek"], outcomes: [{ engine: "kimi", placed: 2, cited: 2 }] });
  const sourceCited = scoreOutlet(base, { article, engines: ["deepseek"], outcomes: [], source: { cited: { deepseek: { P2: 10 } } } });
  const edited = scoreOutlet({ ...base, flags: { editIncidents: 1 } }, { article, engines: ["deepseek"], outcomes: [] });
  assert.ok(cited > plain);
  assert.equal(citedElsewhere, plain, "a citation by an engine the project does not measure is not ours");
  assert.ok(sourceCited > plain);
  assert.ok(edited < plain);
  const expensive = scoreOutlet({ ...base, priceCny: 900 }, { article, engines: [], outcomes: [] });
  assert.ok(expensive < plain);
  const deep = { ...article, layer: "deep" };
  assert.ok(scoreOutlet({ ...base, priceCny: 900 }, { article: deep, engines: [], outcomes: [] }) > expensive, "the deep layer is where a dearer outlet fits");
});

test("reserve, money view and the ledger identity", () => {
  assert.equal(reserveFor(100), 110);
  assert.equal(reserveFor(27.3), 30.03);
  const project = { budget: { totalCny: 1000, dailyCny: 200 } };
  const sums = [
    { orderId: "o1", kind: "reserve", amountCny: 110 }, { orderId: "o1", kind: "settle", amountCny: 100 }, { orderId: "o1", kind: "release", amountCny: 10 },
    { orderId: "o2", kind: "reserve", amountCny: 55 },
    { orderId: "o3", kind: "reserve", amountCny: 22 }, { orderId: "o3", kind: "settle", amountCny: 20 }, { orderId: "o3", kind: "release", amountCny: 2 },
    { orderId: "o3", kind: "refund", amountCny: 20 },
    { orderId: null, kind: "budget_set", amountCny: 1000 },
  ];
  assert.deepEqual(projectMoney(project, sums), { budgetCny: 1000, dailyCny: 200, reservedCny: 55, settledCny: 120, refundedCny: 20, spentCny: 100, availableCny: 845 });
  const orders = [
    { id: "o1", state: "settled", reserveCny: 110, settledCny: 100, vendorOrderNid: "1" },
    { id: "o2", state: "accepted", reserveCny: 55, settledCny: null, vendorOrderNid: "2" },
    { id: "o3", state: "refunded", reserveCny: 22, settledCny: 20, vendorOrderNid: "3" },
  ];
  assert.deepEqual(projectIdentityBreaks(orders, sums), []);
  assert.deepEqual(projectIdentityBreaks(orders.map((order) => order.id === "o2" ? { ...order, state: "cancelled", vendorOrderNid: null } : order), sums),
    [{ orderId: "o2", problem: "reserve_mismatch", ledger: 55, expected: 0 }]);
  assert.deepEqual(projectIdentityBreaks(orders, [...sums, { orderId: "ghost", kind: "reserve", amountCny: 5 }]), [{ orderId: "ghost", problem: "ledger_without_order" }]);
  assert.deepEqual(projectIdentityBreaks(orders, [...sums, { orderId: "o1", kind: "refund", amountCny: 101 }]), [{ orderId: "o1", problem: "refund_above_settle" }]);
});

test("money written off above its reserve counts in full and leaves no negative reserve", () => {
  const project = { budget: { totalCny: 1000, dailyCny: 200 } };
  const sums = [{ orderId: "o1", kind: "reserve", amountCny: 110 }, { orderId: "o1", kind: "settle", amountCny: 150 }];
  assert.deepEqual(projectMoney(project, sums), { budgetCny: 1000, dailyCny: 200, reservedCny: 0, settledCny: 150, refundedCny: 0, spentCny: 150, availableCny: 850 });
  assert.deepEqual(projectIdentityBreaks([{ id: "o1", state: "lost", reserveCny: 110, settledCny: 150, vendorOrderNid: "1" }], sums), []);
});

test("the transition table and the vendor mapping only name real states", () => {
  for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
    assert.ok(ORDER_STATES.includes(from), from);
    for (const to of targets) assert.ok(ORDER_STATES.includes(to), `${from} → ${to}`);
  }
  assert.deepEqual(Object.keys(ORDER_TRANSITIONS).sort(), [...ORDER_STATES].sort());
  assert.deepEqual(ORDER_TRANSITIONS.refunded, []);
  assert.deepEqual(ORDER_TRANSITIONS.lost, []);
  assert.ok(!ORDER_TRANSITIONS.unknown.includes("reserved"), "an unknown order is never sent again");
  assert.deepEqual({ ...VENDOR_STATUS_MAP.map }, { 0: "submitted", 1: "accepted", 2: "published", 4: "rejected", 9: "problem" });
});

test("checkpoints fall due at +1 h, +24 h and +48 h, the latest one only", () => {
  const publishedAt = "2026-09-25T00:00:00.000Z";
  const order = { publishedAt, publishedUrl: "https://x.cn/1", checks: [] };
  const at = (/** @type {number} */ hours) => new Date(Date.parse(publishedAt) + hours * 3_600_000);
  assert.equal(dueCheckpoint(order, at(0.5)), null);
  assert.equal(dueCheckpoint(order, at(1)), "1h");
  assert.equal(dueCheckpoint(order, at(30)), "24h", "a missed +1 h is not run late");
  assert.equal(dueCheckpoint({ ...order, checks: [{ checkpoint: "24h" }] }, at(30)), null);
  assert.equal(dueCheckpoint({ ...order, checks: [{ checkpoint: "1h" }, { checkpoint: "24h" }] }, at(49)), "48h");
  assert.equal(dueCheckpoint({ ...order, checks: [{ checkpoint: "48h" }] }, at(100)), null);
  assert.equal(dueCheckpoint({ ...order, publishedUrl: null }, at(5)), null);
});

test("days are Asia/Shanghai days", () => {
  const late = new Date("2026-09-25T16:30:00.000Z");
  assert.equal(zonedDay(late, "Asia/Shanghai"), "2026-09-26");
  assert.equal(zonedDayStart(late, "Asia/Shanghai").toISOString(), "2026-09-25T16:00:00.000Z");
  assert.equal(zonedDay(late, "UTC"), "2026-09-25");
});

test("a budget needs sane numbers and the owner's project", async () => {
  const store = new GeoMarketStoreDouble();
  await store.seedProject({ id: "g1", userId: "u1" });
  const deps = { store, now: () => new Date("2026-09-25T00:00:00Z") };
  for (const [totalCny, dailyCny] of [[-1, 10], [100, 200], ["abc", 10], [100, 0], [1e8, 10]]) {
    await assert.rejects(setBudget(deps, { userId: "u1", geoProjectId: "g1", totalCny, dailyCny }), { code: "geo_budget_invalid" }, `${totalCny}/${dailyCny}`);
  }
  await assert.rejects(setBudget(deps, { userId: "u2", geoProjectId: "g1", totalCny: 100, dailyCny: 50 }), { code: "geo_project_not_found" });
  assert.deepEqual(await setBudget(deps, { userId: "u1", geoProjectId: "g1", totalCny: "300", dailyCny: 100 }), { budget: { totalCny: 300, dailyCny: 100 } });
  assert.deepEqual(await setBudget(deps, { userId: "u1", geoProjectId: "g1", totalCny: 0, dailyCny: 0 }), { budget: { totalCny: 0, dailyCny: 0 } }, "zero stops spending");
  assert.deepEqual((await store.ledgerSums({ geoProjectId: "g1" })).map((row) => [row.kind, row.count]), [["budget_set", 2]]);
});

test("the double refuses what the database refuses", async () => {
  const store = new GeoMarketStoreDouble();
  await assert.rejects(store.listOrders({ limit: 501 }), { code: "geo_market_store_invalid" });
  await assert.rejects(store.listOrders({ limit: 0 }), { code: "geo_market_store_invalid" });
  await assert.rejects(store.listOrders({ limit: 10, offset: -1 }), { code: "geo_market_store_invalid" });
  await assert.rejects(store.listOrders({ limit: 10, states: ["shipped"] }), { code: "geo_market_store_invalid" });
  await assert.rejects(store.listCandidateMedia({ maxPriceCny: 100, limit: 5001 }), { code: "geo_market_store_invalid" });
  await assert.rejects(store.upsertMediaRows(Array.from({ length: 501 }, () => ({}))), { code: "geo_market_store_invalid" });
  await assert.rejects(store.insertOrders(Array.from({ length: 101 }, () => ({})), new Date().toISOString()), { code: "geo_market_store_invalid" });
  assert.throws(() => assertLedgerRow({ kind: "gift", amountCny: 1 }, new Date().toISOString()), { code: "geo_market_store_invalid" });
  assert.throws(() => assertLedgerRow({ kind: "reserve", amountCny: 1e11 }, new Date().toISOString()), { code: "geo_market_store_invalid" });
});

/** A fresh double with the scenarios' seeding hooks. */
async function doubleFixture() {
  const store = new GeoMarketStoreDouble();
  return {
    store,
    seed: {
      project: (row) => store.seedProject(row),
      group: (row) => store.seedGroup(row),
      article: (row) => store.seedArticle(row),
      source: (row) => store.seedSource(row),
      target: (row) => store.seedTarget(row),
    },
    async tamperLedger(row) {
      store.ledger.push(assertLedgerRow({ ...row, userId: null }, new Date().toISOString()));
    },
    async close() {},
  };
}

defineGeoMarketScenarios(test, doubleFixture);
defineGeoMarketMoneyPathScenarios(test, doubleFixture);
