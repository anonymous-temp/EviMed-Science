// The market against PostgreSQL on the evimed_geo DDL: every scenario the
// double runs (geoMarket.test.mjs), plus what only a database can show —
// compare-and-set under two writers at once, CHECK and unique constraints,
// the same bounds refused before a query is sent — and the GEO service's
// own reads of the market's money.
//
// Its own database: the media catalogue, the reconciliations and the top-ups
// are platform tables every scenario starts empty, and node runs test files in
// parallel — sharing a database with the other GEO suites would let each
// truncate the other's rows.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { cancelOrder, tickOrders, tickPoll } from "../src/geoMarket.mjs";
import { GeoMarketStore, assertLedgerRow } from "../src/geoMarketStore.mjs";
import { GEO_TABLES } from "../src/geoPersistence.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { defineGeoMarketMoneyPathScenarios, defineGeoMarketScenarios, orders, world } from "./helpers/geoMarketScenarios.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {ControlPlaneDatabase | null} */
let database = null;
/** @type {pg.Client | null} */
let admin = null;
let isolatedName = "";

before(async () => {
  if (!databaseUrl) return;
  const source = new URL(databaseUrl);
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_geomarket_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedName, /^evimed_test_[a-z0-9_]+$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  database = new ControlPlaneDatabase({ databaseUrl: source.href, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
});

after(async () => {
  await database?.close();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`);
    await admin.end();
  }
});

const open = () => /** @type {ControlPlaneDatabase} */ (database);

async function fixture() {
  const db = open();
  const store = new GeoMarketStore(db);
  await store.ready();
  await db.query(`TRUNCATE ${GEO_TABLES.map((table) => `evimed_geo.${table}`).join(", ")} CASCADE`);
  const now = () => new Date().toISOString();
  return {
    store,
    seed: {
      project: async (/** @type {any} */ row) => {
        await db.query(`INSERT INTO evimed_geo.projects (id, user_id, project_id, product, competitors, engines, tier, budget, status, created_at, updated_at)
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[], $7, $8::jsonb, $9, $10, $10)`,
        [row.id, row.userId, row.projectId ?? `p_${row.id}`, JSON.stringify(row.product ?? {}), JSON.stringify(row.competitors ?? []),
          row.engines ?? ["deepseek", "doubao"], row.tier ?? "2", row.budget ? JSON.stringify(row.budget) : null, row.status ?? "active", row.createdAt ?? now()]);
      },
      group: async (/** @type {any} */ row) => {
        await db.query(`INSERT INTO evimed_geo.question_groups (id, user_id, geo_project_id, set_version, pool, name, is_control) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [row.id, row.userId, row.geoProjectId, row.setVersion ?? 1, row.pool ?? "P2", row.name ?? "", Boolean(row.isControl)]);
      },
      article: async (/** @type {any} */ row) => {
        await db.query(`INSERT INTO evimed_geo.articles (id, user_id, geo_project_id, layer, title, group_id, gate, safety, content_sha256, status, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
        [row.id, row.userId, row.geoProjectId, row.layer ?? "popular", row.title ?? "", row.groupId ?? null, row.gate ?? "passed", row.safety ?? "clear",
          row.contentSha256 ?? null, row.status ?? "publishable", row.createdAt ?? now()]);
      },
      source: async (/** @type {any} */ row) => {
        await db.query(`INSERT INTO evimed_geo.sources (id, user_id, geo_project_id, domain, name, layer, icp_matches, news_indexed, medical_vertical,
            impostor, blacklist_reason, cited) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
        [`src_${row.geoProjectId}_${row.domain}`, row.userId ?? "seed", row.geoProjectId, row.domain, row.name ?? "", row.layer ?? null,
          row.icpMatches ?? null, row.newsIndexed ?? null, row.medicalVertical ?? null, Boolean(row.impostor), row.blacklistReason ?? null,
          JSON.stringify(row.cited ?? {})]);
      },
      target: async (/** @type {any} */ row) => {
        await db.query(`INSERT INTO evimed_geo.targets (geo_project_id, version, tier, metric_id, pool, budget_cny) VALUES ($1, $2, $3, $4, $5, $6)`,
          [row.geoProjectId, row.version, row.tier, row.metricId ?? "M-01", row.pool ?? "P2", row.budgetCny ?? null]);
      },
    },
    async tamperLedger(/** @type {any} */ row) {
      const checked = assertLedgerRow({ ...row, userId: null }, new Date().toISOString());
      await db.query(`INSERT INTO evimed_geo.ledger (id, user_id, geo_project_id, order_id, kind, amount_cny, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [checked.id, null, checked.geoProjectId, checked.orderId, checked.kind, checked.amountCny, checked.createdAt]);
    },
    async close() {},
  };
}

defineGeoMarketScenarios(test, fixture, options);
defineGeoMarketMoneyPathScenarios(test, fixture, options);

test("two writers moving one order: exactly one wins, and one event is written", options, async () => {
  const { store, seed } = await fixture();
  await seed.project({ id: "g1", userId: "u1" });
  const at = new Date().toISOString();
  const [order] = await store.insertOrders([{ userId: "u1", geoProjectId: "g1", articleId: "a1", mediaType: "website", resourceId: "101", priceCny: 100, reserveCny: 110 }], at);
  const moves = await Promise.all([
    store.transitionOrder(order.id, { from: ["planned"], to: "reserved", at, ledger: [{ kind: "reserve", amountCny: 110, userId: "u1", geoProjectId: "g1" }] }),
    store.transitionOrder(order.id, { from: ["planned"], to: "cancelled", at }),
  ]);
  assert.equal(moves.filter(Boolean).length, 1);
  const events = await store.listOrderEvents(order.id, 10);
  assert.equal(events.length, 2, "the first event and one move");
  const sums = await store.ledgerSums({ geoProjectId: "g1" });
  const reserved = moves[0] ? 110 : 0;
  assert.equal(sums.filter((row) => row.kind === "reserve").reduce((total, row) => total + row.amountCny, 0), reserved, "the ledger moved with the winner only");
});

test("the database refuses what the store refuses, and more", options, async () => {
  const { store } = await fixture();
  await assert.rejects(store.listOrders({ limit: 501 }), { code: "geo_market_store_invalid" });
  await assert.rejects(store.listOrders({ limit: 10, offset: 100_001 }), { code: "geo_market_store_invalid" });
  await assert.rejects(store.listCandidateMedia({ maxPriceCny: 100, limit: 5_001 }), { code: "geo_market_store_invalid" });
  await assert.rejects(store.insertOrders(Array.from({ length: 101 }, () => ({})), new Date().toISOString()), { code: "geo_market_store_invalid" });
  await assert.rejects(store.transitionOrder("nope", { from: ["planned"], to: "shipped", at: new Date().toISOString() }), { code: "geo_market_store_invalid" });
  await assert.rejects(store.annotateOrder("nope", { at: new Date().toISOString(), detail: { big: "x".repeat(70_000) } }), { code: "geo_market_store_invalid" });
  const db = open();
  await assert.rejects(db.query(`INSERT INTO evimed_geo.orders (id, user_id, geo_project_id, state) VALUES ('bad', 'u', 'g', 'shipped')`), /violates check constraint/);
  await assert.rejects(db.query(`INSERT INTO evimed_geo.ledger (id, kind, amount_cny) VALUES ('bad', 'gift', 1)`), /violates check constraint/);
  assert.equal(await store.transitionOrder("missing", { from: ["planned"], to: "reserved", at: new Date().toISOString() }), null);
  // One live order per article, whoever writes it.
  await db.query(`INSERT INTO evimed_geo.orders (id, user_id, geo_project_id, article_id, state) VALUES ('live1', 'u', 'g', 'art', 'submitted')`);
  await assert.rejects(db.query(`INSERT INTO evimed_geo.orders (id, user_id, geo_project_id, article_id, state) VALUES ('live2', 'u', 'g', 'art', 'planned')`),
    /geo_orders_live_article_key/);
  await db.query(`INSERT INTO evimed_geo.orders (id, user_id, geo_project_id, article_id, state) VALUES ('done1', 'u', 'g', 'art', 'refunded')`);
});

/** The GEO service over the same database, as the 投放 tab reads it. */
const service = () => new GeoService({ store: new GeoStore({ database: open() }), config: { geoEnabled: true, geoAudience: "all" } });

test("投放 tab: the money shown is the ledger's, including reserves held by a rejected order awaiting its refund", options, async () => {
  const w = await world(fixture);
  try {
    const p = await w.project();
    await tickOrders(w.deps);
    const [order] = await orders(w.fixture.store, p.id);
    w.fake.setOrder(order.vendorOrderNid, { status: 4 });
    await tickPoll(w.deps);
    assert.equal((await w.fixture.store.getOrder(order.id)).state, "rejected");
    const view = await service().distribution({ id: p.userId }, p.id);
    assert.equal(view.reservedCny, 110, "the reserve stays held until the refund is in the balance");
    assert.equal(view.spentCny, 0);
  } finally { await w.close(); }
});

test("撤单 then 撤回: a placed article whose order the user cancelled can be withdrawn, and is not placed again", options, async () => {
  const w = await world(fixture);
  try {
    const p = await w.project();
    await tickOrders(w.deps);
    const [order] = await orders(w.fixture.store, p.id);
    assert.equal((await w.fixture.store.getArticles([p.articleIds[0]]))[0].status, "placed");
    await cancelOrder(w.deps, { userId: p.userId, geoProjectId: p.id, orderId: order.id });
    const withdrawn = await service().withdrawArticle({ id: p.userId }, p.id, p.articleIds[0]);
    assert.equal(withdrawn.status, "withdrawn");
    await tickOrders(w.deps);
    assert.equal((await orders(w.fixture.store, p.id)).length, 1, "nothing new is placed for a withdrawn article");

    // An article with a live order is still refused.
    const q = await w.project({ id: "geo_live", userId: "u5" });
    await tickOrders(w.deps);
    await assert.rejects(service().withdrawArticle({ id: q.userId }, q.id, q.articleIds[0]), { code: "geo_article_state_invalid" });
  } finally { await w.close(); }
});
