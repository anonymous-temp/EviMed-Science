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
import { cancelOrder, confirmTopup, tickOrders, tickPoll, tickReconcile, tickVerify } from "../src/geoMarket.mjs";
import { GEO_MARKET_DECISION_ORDERS_MAX, GeoMarketStore, assertLedgerRow } from "../src/geoMarketStore.mjs";
import { GEO_TABLES } from "../src/geoPersistence.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoWorker } from "../src/geoWorker.mjs";
import { GeoOrchestrator } from "../src/geoOrchestrator.mjs";
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
        await db.query(`INSERT INTO evimed_geo.articles (id, user_id, geo_project_id, layer, title, group_id, gate, safety, content_sha256, status, created_at, updated_at, channel)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12)`,
        [row.id, row.userId, row.geoProjectId, row.layer ?? "popular", row.title ?? "", row.groupId ?? null, row.gate ?? "passed", row.safety ?? "clear",
          row.contentSha256 ?? null, row.status ?? "publishable", row.createdAt ?? now(), row.channel ?? null]);
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
      placementPlan: async (/** @type {string} */ geoProjectId, /** @type {Record<string, any>} */ data) => {
        const version = Number((await db.query(`SELECT coalesce(max(version), 0) + 1 AS next FROM evimed_geo.placement_plans WHERE geo_project_id = $1`, [geoProjectId])).rows[0].next);
        await db.query(`INSERT INTO evimed_geo.placement_plans (geo_project_id, version, user_id, data) VALUES ($1, $2, 'seed', $3::jsonb)`, [geoProjectId, version, JSON.stringify(data)]);
      },
    },
    async tamperLedger(/** @type {any} */ row) {
      const checked = assertLedgerRow({ ...row, userId: null }, new Date().toISOString());
      await db.query(`INSERT INTO evimed_geo.ledger (id, user_id, geo_project_id, order_id, kind, amount_cny, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [checked.id, null, checked.geoProjectId, checked.orderId, checked.kind, checked.amountCny, checked.createdAt]);
    },
    // What another writer does to a row while the market is working on it (a finding that opens, a pause).
    alter: {
      article: async (/** @type {string} */ id, /** @type {Record<string, any>} */ patch) => {
        const columns = { status: "status", safety: "safety", gate: "gate", contentSha256: "content_sha256" };
        for (const [key, value] of Object.entries(patch)) {
          await db.query(`UPDATE evimed_geo.articles SET ${/** @type {Record<string, string>} */ (columns)[key]} = $2, updated_at = now() WHERE id = $1`, [id, value]);
        }
      },
      project: async (/** @type {string} */ id, /** @type {Record<string, any>} */ patch) => {
        if (patch.status !== undefined) await db.query(`UPDATE evimed_geo.projects SET status = $2, updated_at = now() WHERE id = $1`, [id, patch.status]);
        if (patch.budget !== undefined) await db.query(`UPDATE evimed_geo.projects SET budget = $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(patch.budget)]);
      },
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

test('the complete order decision read includes more than 5000 and refuses overflow',options,async()=>{
  const {store}=await fixture(),db=open();
  await db.query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state,created_at)
    SELECT 'decision-' || n,'u','g','planned',now()+n*interval '1 second' FROM generate_series(1,5501) n`);
  const rows=await store.listDecisionOrders({geoProjectId:'g',states:['planned']});
  assert.equal(rows.length,5501);assert.ok(rows.some(row=>row.id==='decision-5501'));
  await db.query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state)
    SELECT 'overflow-' || n,'u','g','planned' FROM generate_series(1,$1) n`,[GEO_MARKET_DECISION_ORDERS_MAX-5500]);
  await assert.rejects(store.listDecisionOrders({geoProjectId:'g',states:['planned']}),{code:'geo_spine_incomplete'});
});

test('an unknown order beyond 500 blocks its outlet during a real market tick',options,async()=>{
  const w=await world(fixture);
  try {
    const p=await w.project();
    await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,state,created_at)
      SELECT 'unknown-' || n,'u', $1,'website','other-' || n,'unknown','2020-01-01'::timestamptz+n*interval '1 second'
      FROM generate_series(1,500) n`,[p.id]);
    await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,state,created_at)
      VALUES('unknown-target','u',$1,'website','101','unknown','2030-01-01')`,[p.id]);
    await tickOrders(w.deps);
    const selected=await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:p.articleIds,limit:10});
    assert.equal(selected.length,1);assert.notEqual(selected[0].resourceId,'101');
  } finally {await w.close();}
});

test('a planned reserve beyond 2000 prevents a new budget commitment',options,async t=>{
  const w=await world(fixture);
  try {
    const p=await w.project({totalCny:220110,dailyCny:220110});
    await open().query(`INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,layer,title,group_id,gate,safety,content_sha256,status)
      SELECT 'budget-article-' || n,$2,$1,'qa','Existing',$3,'passed','clear',repeat('b',64),'publishable'
      FROM generate_series(1,2001) n`,[p.id,p.userId,`${p.id}_g1`]);
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny)
      SELECT 'budget-media-' || n,'website','budget' || n || '.example.org',true,true,100 FROM generate_series(1,2001) n`);
    await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,article_id,media_type,resource_id,state,price_cny,reserve_cny)
      SELECT 'budget-order-' || n,$2,$1,'budget-article-' || n,'website','budget-media-' || n,'planned',100,110
      FROM generate_series(1,2001) n`,[p.id,p.userId]);
    const batch=w.fixture.store.getOrderArticles.bind(w.fixture.store);let batches=0;
    w.fixture.store.getOrderArticles=async input=>{batches+=1;return batch(input);};
    const started=performance.now(),result=await tickOrders(w.deps);
    t.diagnostic(`2001 planned orders: ${Math.round(performance.now()-started)} ms on isolated local PostgreSQL; ${batches} batch lookups`);
    assert.ok(result.skipped.budget_exhausted>0,'the final reserve leaves no room for another placement');
    assert.equal((await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:p.articleIds,limit:10})).length,0);
    assert.equal((await w.fixture.store.listDecisionOrders({geoProjectId:p.id})).length,2001);
    assert.equal(batches,5);
  } finally {await w.close();}
});

test('a valid planned outlet past the 5000-row catalogue is checked by exact key',options,async()=>{
  const w=await world(fixture,{configured:false});
  try {
    const p=await w.project({articles:[{},{}]}),at=w.clock.now().toISOString();
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny)
      SELECT 'a' || lpad(n::text,5,'0'),'website','bulk' || n || '.example.org',true,true,10 FROM generate_series(1,5001) n`);
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny)
      VALUES('zz-valid','website','last.example.org',true,true,10),('zz-disabled','website','disabled.example.org',true,false,10)`);
    await w.fixture.store.insertOrders([
      {id:'catalog-valid',userId:p.userId,geoProjectId:p.id,articleId:p.articleIds[0],mediaType:'website',resourceId:'zz-valid',priceCny:10,reserveCny:11},
      {id:'catalog-disabled',userId:p.userId,geoProjectId:p.id,articleId:p.articleIds[1],mediaType:'website',resourceId:'zz-disabled',priceCny:10,reserveCny:11},
    ],at);
    await tickOrders(w.deps);
    assert.equal((await w.fixture.store.getOrder('catalog-valid')).state,'planned');
    assert.equal((await w.fixture.store.getOrder('catalog-disabled')).state,'cancelled');
  } finally {await w.close();}
});

test('batched planned-order reads retain the exact reviewed version and reject mismatches',options,async()=>{
  const w=await world(fixture);
  try {
    const p=await w.project(),article=p.articleIds[0],oldDigest='a'.repeat(64),newDigest='b'.repeat(64);
    await open().query("UPDATE evimed_geo.articles SET current_result_version_id='v2',content_sha256=$2 WHERE id=$1",[article,newDigest]);
    await open().query(`INSERT INTO evimed_geo.article_versions(geo_project_id,article_id,user_id,result_version_id,digest,path,association)
      VALUES($1,$2,$3,'v1',$4,'old.md',$5::jsonb),($1,$2,$3,'v2',$6,'new.md',$5::jsonb)`,
    [p.id,article,p.userId,oldDigest,JSON.stringify({status:'publishable',safety:'clear',gate:'passed'}),newDigest]);
    const old={geoProjectId:p.id,articleId:article,articleResultVersionId:'v1',articleDigest:oldDigest};
    const [resolved,mismatch,unpinned,foreign]=await w.fixture.store.getOrderArticles([old,{...old,articleDigest:newDigest},
      {...old,articleResultVersionId:null}, {...old,geoProjectId:'foreign'}]);
    assert.deepEqual(resolved,await w.fixture.store.getOrderArticle(old));
    assert.equal(resolved.currentResultVersionId,'v1');assert.equal(resolved.path,'old.md');assert.equal(resolved.contentSha256,oldDigest);
    assert.deepEqual([mismatch,unpinned,foreign],[null,null,null]);
    await assert.rejects(w.fixture.store.getOrderArticles(Array.from({length:501},()=>old)),{code:'geo_market_store_invalid'});
  } finally {await w.close();}
});

test('order-input overflow stops new sends after restoring an already-sending order',options,async()=>{
  const w=await world(fixture);
  try {
    const p=await w.project();
    await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,state)
      SELECT 'unknown-' || n,'u',$1,'website','other-' || n,'unknown' FROM generate_series(1,$2) n`,[p.id,GEO_MARKET_DECISION_ORDERS_MAX+1]);
    await open().query("INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state) VALUES('recover-me','u',$1,'reserved')",[p.id]);
    await open().query(`INSERT INTO evimed_geo.order_events(id,order_id,at,from_state,to_state,detail)
      VALUES('recover-event','recover-me','2020-01-01','planned','reserved','{"phase":"send_started"}')`);
    await assert.rejects(tickOrders(w.deps),{code:'geo_spine_incomplete'});
    assert.equal((await w.fixture.store.getOrder('recover-me')).state,'unknown');
    assert.equal((await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:p.articleIds,limit:10})).length,0);
  } finally {await w.close();}
});

test('project planned and domain quota overflow report the affected project',options,async t=>{
  for(const state of ['planned','submitted'])await t.test(state,async()=>{
    const w=await world(fixture);
    try {
      const p=await w.project();
      await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,state,created_at)
        SELECT 'project-limit-' || n,'u',$1,'website','other-' || n,$2,'2030-01-01' FROM generate_series(1,$3) n`,
      [p.id,state,GEO_MARKET_DECISION_ORDERS_MAX+1]);
      const result=await tickOrders(w.deps);
      assert.equal(result.skipped.decision_input_incomplete,1);assert.deepEqual(result.incompleteProjectIds,[p.id]);
      assert.equal((await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:p.articleIds,limit:10})).length,0);
    } finally {await w.close();}
  });
});

test('a due reservation behind 500 recent sends is recovered',options,async()=>{
  const w=await world(fixture);
  try {
    const p=await w.project(),recent=w.clock.now().toISOString();
    await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state,created_at)
      SELECT 'recent-' || n,'u',$1,'reserved','2020-01-01'::timestamptz+n*interval '1 second' FROM generate_series(1,500) n`,[p.id]);
    await open().query(`INSERT INTO evimed_geo.order_events(id,order_id,at,from_state,to_state,detail)
      SELECT 'recent-event-' || n,'recent-' || n,$1::timestamptz,'planned','reserved','{"phase":"send_started"}' FROM generate_series(1,500) n`,[recent]);
    await open().query("INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state,created_at) VALUES('due','u',$1,'reserved','2021-01-01')",[p.id]);
    await open().query(`INSERT INTO evimed_geo.order_events(id,order_id,at,from_state,to_state,detail)
      VALUES('due-event','due','2020-01-01','planned','reserved','{"phase":"send_started"}')`);
    const result=await tickOrders(w.deps);
    assert.ok(result.recovered>=1);assert.equal((await w.fixture.store.getOrder('due')).state,'unknown');
    assert.equal((await w.fixture.store.getOrder('recent-1')).state,'reserved');
  } finally {await w.close();}
});

test('the scheduled poll recovers an in-flight reservation without any active budget project',options,async()=>{
  const w=await world(fixture);
  try {
    const p=await w.project({totalCny:null});
    assert.equal((await w.fixture.store.listProjectsInTurn(1)).length,0);
    await open().query("INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state) VALUES('no-budget-reserved','u',$1,'reserved')",[p.id]);
    await open().query(`INSERT INTO evimed_geo.order_events(id,order_id,at,from_state,to_state,detail)
      VALUES('no-budget-event','no-budget-reserved','2020-01-01','planned','reserved','{"phase":"send_started"}')`);
    const orchestrator=new GeoOrchestrator({store:new GeoStore({database:open()})});
    const worker=new GeoWorker({lease:(name,work)=>orchestrator.leaseLoop(name,work),loops:{poll:()=>tickPoll(w.deps)}});
    try {
      assert.equal(worker.table.find(loop=>loop.name==='poll').every,600000);
      await worker.tick();
      assert.equal(worker.status().loops.poll.last.recovered,1);
      assert.equal((await w.fixture.store.getOrder('no-budget-reserved')).state,'unknown');
    } finally {await worker.close();}
  } finally {await w.close();}
});

test('a refund beyond 5000 prevents attributing the same balance change to a top-up',options,async()=>{
  const w=await world(fixture,{balance:100});
  try {
    const p=await w.project(),at=w.clock.now().toISOString();
    await w.fixture.store.upsertReconciliation({day:'2026-09-24',ours:0,vendor:0,balance:0,diff:0,status:'ok',
      details:{anchorBalance:0,observedAt:'2020-01-01T00:00:00.000Z'},at});
    const topup=await w.fixture.store.insertTopup({id:'ambiguous-topup',amountCny:100,balanceBefore:0,at});
    await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,vendor_order_nid,state,price_cny,created_at)
      SELECT 'poll-' || n,'u',$1,'website','other-' || n,'nid-' || n,'submitted',100,'2020-01-01'::timestamptz+n*interval '1 second'
      FROM generate_series(1,5000) n`,[p.id]);
    await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,vendor_order_nid,state,price_cny,created_at)
      VALUES('late-refund','u',$1,'website','later','late-nid','rejected',100,'2021-01-01')`,[p.id]);
    const result=await confirmTopup(w.deps,{topupId:topup.id,operatorId:'operator'});
    assert.equal(result.status,'awaiting_balance');assert.equal((await w.fixture.store.getTopup(topup.id)).status,'requested');
  } finally {await w.close();}
});

test('a pending top-up beyond 50 prevents attributing an incomplete balance set',options,async()=>{
  const w=await world(fixture,{balance:50});
  try {
    await w.project();const at=w.clock.now().toISOString();
    await w.fixture.store.upsertReconciliation({day:'2026-09-24',ours:0,vendor:0,balance:0,diff:0,status:'ok',
      details:{anchorBalance:0,observedAt:'2020-01-01T00:00:00.000Z'},at});
    await open().query(`INSERT INTO evimed_geo.topups(id,amount_cny,status,balance_before,requested_at)
      SELECT 'recent-topup-' || n,1,'requested',0,'2026-01-01'::timestamptz+n*interval '1 second' FROM generate_series(1,50) n`);
    await open().query("INSERT INTO evimed_geo.topups(id,amount_cny,status,balance_before,requested_at) VALUES('old-topup',50,'requested',0,'2020-01-01')");
    const result=await confirmTopup(w.deps,{topupId:'recent-topup-1',operatorId:'operator'});
    assert.equal(result.status,'awaiting_balance');assert.equal((await w.fixture.store.getTopup('recent-topup-1')).status,'requested');
  } finally {await w.close();}
});

test('an overflowing balance flow is explicitly refused rather than truncated',options,async()=>{
  const {store}=await fixture();
  await open().query(`INSERT INTO evimed_geo.ledger(id,kind,amount_cny,created_at)
    SELECT 'flow-' || n,'adjustment',1,'2026-01-01' FROM generate_series(1,10001) n`);
  await assert.rejects(store.platformFlowsSince('2020-01-01T00:00:00.000Z'),{code:'geo_spine_incomplete'});
});

test('global pending and balance overflow stops new sends before a partial financial decision',options,async t=>{
  for(const input of ['vendor-orders','topups','flows'])await t.test(input,async()=>{
    const w=await world(fixture);
    try {
      const p=await w.project(),at=w.clock.now().toISOString();
      if(input==='vendor-orders') await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,vendor_order_nid,state)
        SELECT 'global-order-' || n,'u',$1,'website','resource-' || n,'global-nid-' || n,'submitted' FROM generate_series(1,10001) n`,[p.id]);
      if(input==='topups') await open().query(`INSERT INTO evimed_geo.topups(id,amount_cny,status,balance_before,requested_at)
        SELECT 'global-topup-' || n,1,'requested',0,now() FROM generate_series(1,10001) n`);
      if(input==='flows') {
        await w.fixture.store.upsertReconciliation({day:'2026-09-24',ours:0,vendor:0,balance:0,diff:0,status:'ok',
          details:{anchorBalance:0,observedAt:'2020-01-01T00:00:00.000Z'},at});
        await open().query(`INSERT INTO evimed_geo.ledger(id,kind,amount_cny,created_at)
          SELECT 'global-flow-' || n,'adjustment',1,'2026-01-01' FROM generate_series(1,10001) n`);
      }
      await assert.rejects(tickOrders(w.deps),{code:'geo_spine_incomplete'});
      assert.equal((await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:p.articleIds,limit:10})).length,0);
    } finally {await w.close();}
  });
});

test('poll and worker retain the capacity error for oversized top-ups or balance flows',options,async t=>{
  for(const input of ['topups','flows'])await t.test(input,async()=>{
    const w=await world(fixture);
    try {
      await w.project();const at=w.clock.now().toISOString();
      await w.fixture.store.upsertReconciliation({day:'2026-09-24',ours:0,vendor:0,balance:0,diff:0,status:'ok',
        details:{anchorBalance:0,observedAt:'2020-01-01T00:00:00.000Z'},at});
      if(input==='topups') await open().query(`INSERT INTO evimed_geo.topups(id,amount_cny,status,balance_before,requested_at)
        SELECT 'poll-topup-' || n,1,'requested',0,now() FROM generate_series(1,10001) n`);
      else await open().query(`INSERT INTO evimed_geo.ledger(id,kind,amount_cny,created_at)
        SELECT 'poll-flow-' || n,'adjustment',1,'2026-01-01' FROM generate_series(1,10001) n`);
      await assert.rejects(tickPoll(w.deps),{code:'geo_spine_incomplete'});
      const worker=new GeoWorker({loops:{poll:()=>tickPoll(w.deps)}});
      try {
        await worker.runNow('poll');const state=worker.status().loops.poll;
        assert.equal(state.lastError,'geo_spine_incomplete');assert.equal(state.failures,1);assert.equal(state.lastOkAt,null);
      } finally {await worker.close();}
    } finally {await w.close();}
  });
});

test('reconciliation can confirm an arrival before a later project-input overflow',options,async()=>{
  const w=await world(fixture,{balance:100});
  try {
    const p=await w.project(),at=w.clock.now().toISOString();
    await w.fixture.store.upsertReconciliation({day:'2026-09-24',ours:0,vendor:0,balance:0,diff:0,status:'ok',
      details:{anchorBalance:0,observedAt:'2020-01-01T00:00:00.000Z'},at});
    await w.fixture.store.insertTopup({id:'confirmed-before-overflow',amountCny:100,balanceBefore:0,at});
    await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state)
      SELECT 'reconcile-overflow-' || n,'u',$1,'unknown' FROM generate_series(1,10001) n`,[p.id]);
    await assert.rejects(tickReconcile(w.deps),{code:'geo_spine_incomplete'});
    assert.equal((await w.fixture.store.getTopup('confirmed-before-overflow')).status,'confirmed');
  } finally {await w.close();}
});

test('poll reaches the 5001st eligible order',options,async()=>{
  const w=await world(fixture);
  try {
    const p=await w.project();w.market.orderInfo=async()=>[];
    await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,vendor_order_nid,state,price_cny,created_at)
      SELECT 'poll-all-' || n,'u',$1,'website','resource-' || n,'poll-nid-' || n,'submitted',1,'2020-01-01'::timestamptz+n*interval '1 second'
      FROM generate_series(1,5001) n`,[p.id]);
    const result=await tickPoll(w.deps);assert.equal(result.polled,5001);assert.equal(result.missing,5001);
  } finally {await w.close();}
});

test('settlement reaches an unsettled verified order behind 5000 settled records',options,async()=>{
  const w=await world(fixture);
  try {
    const p=await w.project();
    await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,vendor_order_nid,state,price_cny,reserve_cny,settled_cny,created_at)
      SELECT 'settle-old-' || n,'u',$1,'website','resource-' || n,'settle-nid-' || n,'verified',0,0,0,'2020-01-01'::timestamptz+n*interval '1 second'
      FROM generate_series(1,5000) n`,[p.id]);
    await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,vendor_order_nid,state,price_cny,reserve_cny,created_at)
      VALUES('settle-late','u',$1,'website','late','settle-late-nid','verified',0,0,'2021-01-01')`,[p.id]);
    const result=await tickVerify({...w.deps,webReader:null});assert.equal(result.recovered,1);
    assert.equal((await w.fixture.store.getOrder('settle-late')).state,'settled');
  } finally {await w.close();}
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

test("投放 tab: 撤单 is offered only where the market takes it, and the price shown is the settled one (M-7)", options, async () => {
  // The page offered 撤单 for every reserved order, and one whose send is in flight answers 409; and it showed the plan's price after the
  // outlet's final price was known.
  const { store, seed } = await fixture();
  await seed.project({ id: "g7", userId: "u7" });
  const at = new Date().toISOString();
  const path = ["reserved", "submitted", "accepted", "published", "verified", "settled"];
  /** An order of its own article, moved along the market's states to `state`. @param {number} n @param {string} [state] */
  const order = async (n, state = "planned") => {
    await seed.article({ id: `a7${n}`, userId: "u7", geoProjectId: "g7", contentSha256: "a".repeat(64) });
    const [made] = await store.insertOrders([{ userId: "u7", geoProjectId: "g7", articleId: `a7${n}`, mediaType: "website", resourceId: `70${n}`, priceCny: 100, reserveCny: 110 }], at);
    let from = "planned";
    for (const to of state === "planned" ? [] : path.slice(0, path.indexOf(state) + 1)) {
      await store.transitionOrder(made.id, { from: [from], to, at, ...(to === "settled" ? { patch: { settledCny: 94 } } : {}),
        ...(to === "reserved" ? { ledger: [{ kind: "reserve", amountCny: 110, userId: "u7", geoProjectId: "g7" }] } : {}) });
      from = to;
    }
    return made.id;
  };
  const planned = await order(1);
  const reservedIdle = await order(2, "reserved");
  const reservedSending = await order(3, "reserved");
  await store.annotateOrder(reservedSending, { at: new Date(Date.parse(at) + 1_000).toISOString(), detail: { phase: "send_started" } });
  const submitted = await order(4, "submitted");
  const accepted = await order(5, "accepted");
  const settled = await order(6, "settled");
  const view = await service().distribution({ id: "u7" }, "g7");
  const byId = new Map(view.orders.map((/** @type {any} */ row) => [row.id, row]));
  assert.deepEqual([planned, reservedIdle, reservedSending, submitted, accepted, settled].map((id) => byId.get(id).cancellable), [true, true, false, true, false, false],
    "a plan, a reserve not yet sent and a sent order the outlet has not taken; not a send in flight, not an order the outlet has taken");
  assert.equal(byId.get(settled).priceCny, 94, "the outlet's final price, once there is one");
  assert.equal(byId.get(planned).priceCny, 100, "the plan's price before");
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
