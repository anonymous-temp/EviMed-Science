// The market against PostgreSQL on the evimed_geo DDL: every scenario the
// double runs (geoMarket.test.mjs), plus what only a database can show —
// compare-and-set under two writers at once, CHECK constraints, and the same
// bounds refused before a query is sent.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoMarketStore, assertLedgerRow } from "../src/geoMarketStore.mjs";
import { defineGeoMarketScenarios } from "./helpers/geoMarketScenarios.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {ControlPlaneDatabase | null} */
let database = null;
const open = () => {
  database ??= new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  return database;
};

after(async () => {
  await database?.close();
});

const TABLES = ["projects", "question_groups", "targets", "sources", "articles", "media", "media_outcomes", "order_events", "orders",
  "ledger", "topups", "reconciliations"];

async function fixture() {
  const db = open();
  const store = new GeoMarketStore(db);
  await store.ready();
  await db.query(`TRUNCATE ${TABLES.map((table) => `evimed_geo.${table}`).join(", ")}`);
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
        await db.query(`INSERT INTO evimed_geo.question_groups (id, user_id, geo_project_id, pool, name, is_control) VALUES ($1, $2, $3, $4, $5, $6)`,
          [row.id, row.userId, row.geoProjectId, row.pool ?? "P2", row.name ?? "", Boolean(row.isControl)]);
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
  await assert.rejects(db.query(`INSERT INTO evimed_geo.orders (id, user_id, state) VALUES ('bad', 'u', 'shipped')`), /violates check constraint/);
  await assert.rejects(db.query(`INSERT INTO evimed_geo.ledger (id, kind, amount_cny) VALUES ('bad', 'gift', 1)`), /violates check constraint/);
  assert.equal(await store.transitionOrder("missing", { from: ["planned"], to: "reserved", at: new Date().toISOString() }), null);
});
