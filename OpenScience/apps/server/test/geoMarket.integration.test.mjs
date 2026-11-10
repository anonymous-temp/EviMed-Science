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
import { cancelOrder, confirmTopup, previewOutlets, recheckSelectedDomain, tickCatalogue, tickOrders, tickPoll, tickReconcile, tickVerify } from "../src/geoMarket.mjs";
import { GEO_MARKET_DECISION_ORDERS_MAX, GeoMarketStore, assertLedgerRow } from "../src/geoMarketStore.mjs";
import { GEO_TABLES } from "../src/geoPersistence.mjs";
import { GeoService, compactAction } from "../src/geoService.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoSpine } from "../src/geoSpine.mjs";
import { geoRuntimeWrite } from "../src/geoWrites.mjs";
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

async function syntheticDomainProof(resourceId, domain, host) {
  await open().query(`UPDATE evimed_geo.media SET domain=$2,case_link=$3,
    flags=coalesce(flags,'{}'::jsonb) || jsonb_build_object('host',$4::text,'domainCheck','ok','domainFinalHost',$4::text,
      'domainCheckedAt',coalesce(flags->>'domainCheckedAt','2026-09-24T00:00:00.000Z')) WHERE resource_id=$1`,
  [resourceId,domain,`https://${host}/case`,host]);
}


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

test('new orders consider an exact preferred outlet beyond the 5000-row catalogue without relaxing gates',options,async t=>{
  for(const mode of ['allowed','multi','host-alias','name-spoof','base-name-spoof','stale-host','base-stale-host','invalid-host-domain','base-invalid-host-domain','near-proof','stale-proof','base-stale-proof','missing-proof','future-proof','budget','quota','blacklisted','source-blacklisted','unqualified','unverified','medical-refused','avoid','unknown','excluded','skipped'])await t.test(mode,async()=>{
    const w=await world(fixture,{configured:false});
    try {
      const p=await w.project({totalCny:mode==='budget'?110:1000,dailyCny:mode==='budget'?110:1000});
      await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny)
        SELECT 'a' || lpad(n::text,5,'0'),'website','bulk' || n || '.example.org',true,true,100 FROM generate_series(1,5001) n`);
      const spoof=mode==='name-spoof' || mode==='base-name-spoof',invalidHost=['invalid-host-domain','base-invalid-host-domain'].includes(mode);
      const hostAlias=['host-alias','stale-host','base-stale-host'].includes(mode) || invalidHost;
      const resource=mode.startsWith('base-')?'000-spoof':'zz-preferred';
      const checkedAt=['stale-proof','base-stale-proof'].includes(mode)?'2026-08-01T00:00:00.000Z':mode==='near-proof'?'2026-08-27T00:00:00.000Z':mode==='future-proof'?'2026-10-01T00:00:00.000Z':'2026-09-24T00:00:00.000Z';
      const flags={medicalRefused:mode==='medical-refused',domainCheck:'ok',...(mode==='missing-proof'?{}:{domainCheckedAt:checkedAt}),...(hostAlias?{host:'zz-preferred.example.org',
        domainFinalHost:mode==='host-alias' || invalidHost?'zz-preferred.example.org':'stale.example.org'}:{})};
      await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,name,domain_verified,available,blacklisted,price_cny,flags)
        VALUES($1,'website',$2,$3,$4,true,$5,$6,$7::jsonb)`,
      [resource,spoof?'evil.example.org':invalidHost?'unrelated.example.net':hostAlias?'example.org':'zz-preferred.example.org',spoof?'zz-preferred.example.org':'Preferred',
        mode!=='unverified',mode==='blacklisted',mode==='budget'?120:100,JSON.stringify(flags)]);
      if(!spoof && !invalidHost) await open().query(`UPDATE evimed_geo.media SET domain='example.org',case_link='https://zz-preferred.example.org/case',
        flags=flags || jsonb_build_object('host','zz-preferred.example.org','domainFinalHost',coalesce(flags->>'domainFinalHost','zz-preferred.example.org')) WHERE resource_id=$1`,[resource]);
      await w.fixture.seed.source({geoProjectId:p.id,domain:'zz-preferred.example.org',layer:'coverage',icpMatches:true,newsIndexed:mode!=='unqualified',medicalVertical:true,
        blacklistReason:mode==='source-blacklisted'?'blocked':null});
      if(spoof)await w.fixture.seed.source({geoProjectId:p.id,domain:'evil.example.org',layer:'coverage',icpMatches:true,newsIndexed:true,medicalVertical:true});
      if(mode==='avoid')await w.fixture.seed.placementPlan(p.id,{avoid:['zz-preferred.example.org']});
      if(mode==='unknown')await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,state)
        VALUES('other-unknown','u',$1,'website','zz-preferred','unknown')`,[p.id]);
      if(mode==='quota')await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,state,created_at)
        VALUES('quota-one','u',$1,'website','zz-preferred','submitted','2030-01-01'),('quota-two','u',$1,'website','zz-preferred','submitted','2030-01-01')`,[p.id]);
      if(mode==='excluded')await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,article_id,media_type,resource_id,state,body_sha256)
        VALUES('previous-attempt','u',$1,$2,'website','zz-preferred','cancelled',$3)`,[p.id,p.articleIds[0],'c'.repeat(64)]);
      const digest='d'.repeat(64),article=p.articleIds[0];
      await open().query("UPDATE evimed_geo.articles SET current_result_version_id='rv_fixture',content_sha256=$2 WHERE id=$1",[article,digest]);
      await open().query(`INSERT INTO evimed_geo.article_versions(geo_project_id,article_id,user_id,result_version_id,digest,path,association)
        VALUES($1,$2,$3,'rv_fixture',$4,'frozen.md',$5::jsonb)`,[p.id,article,p.userId,digest,JSON.stringify({status:'publishable',gate:'passed',safety:'clear'})]);
      const chosen=mode==='multi'?['unlisted.example.org','WWW.ZZ-PREFERRED.EXAMPLE.ORG']:['zz-preferred.example.org'];
      const deps={...w.deps,placementChoices:async()=>({skippedArticleIds:new Set(mode==='skipped'?[article]:[]),preferredByArticle:new Map([[article,chosen]])})};
      await tickOrders(deps);await tickOrders(deps);
      const rows=await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:[article],limit:10});
      const planned=rows.filter(row=>row.state==='planned');
      if(mode==='skipped')assert.equal(planned.length,0);
      else {
        assert.equal(planned.length,1,'repeated ticks must not create duplicate plans');
        assert.equal(planned[0].resourceId,mode==='base-stale-proof'?'000-spoof':['allowed','multi','host-alias','near-proof'].includes(mode)?'zz-preferred':'101');
        assert.equal(planned[0].articleResultVersionId,'rv_fixture');assert.equal(planned[0].articleDigest,digest);
      }
      if(mode==='excluded')assert.equal(rows.find(row=>row.id==='previous-attempt').state,'cancelled');
    } finally {await w.close();}
  });
});

test('supplemental media affect only the selected new article and leave an existing plan untouched',options,async()=>{
  const w=await world(fixture,{configured:false});
  try {
    const p=await w.project({articles:[{},{},{}]}),at=w.clock.now().toISOString();
    const [existing]=await w.fixture.store.insertOrders([{id:'existing-plan',userId:p.userId,geoProjectId:p.id,articleId:p.articleIds[0],mediaType:'website',resourceId:'102',priceCny:120,reserveCny:132}],at);
    const before=await w.fixture.store.getOrder(existing.id);
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny)
      SELECT 'a' || lpad(n::text,5,'0'),'website','bulk' || n || '.example.org',true,true,100 FROM generate_series(1,5001) n`);
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny,flags)
      VALUES('zz-preferred','website','zz-preferred.example.org',true,true,100,'{"domainCheck":"ok","domainCheckedAt":"2026-09-24T00:00:00.000Z"}')`);
    await syntheticDomainProof('zz-preferred','example.org','zz-preferred.example.org');
    await w.fixture.seed.source({geoProjectId:p.id,domain:'zz-preferred.example.org',layer:'coverage',icpMatches:true,newsIndexed:true,medicalVertical:true,cited:{deepseek:{P2:50}}});
    const result=await tickOrders({...w.deps,placementChoices:async()=>({skippedArticleIds:new Set(),preferredByArticle:new Map([[p.articleIds[1],['zz-preferred.example.org']]])})});
    assert.equal(result.planned,2);assert.deepEqual(await w.fixture.store.getOrder(existing.id),before);
    const rows=await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:p.articleIds,limit:10});
    assert.equal(rows.find(row=>row.articleId===p.articleIds[1]).resourceId,'zz-preferred');
    assert.notEqual(rows.find(row=>row.articleId===p.articleIds[2]).resourceId,'zz-preferred');
  } finally {await w.close();}
});

test('the supplemental outlet reaches the actual send with its exact article version',options,async()=>{
  const w=await world(fixture);
  try {
    const p=await w.project(),article=p.articleIds[0];
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny)
      SELECT 'a' || lpad(n::text,5,'0'),'website','bulk' || n || '.example.org',true,true,100 FROM generate_series(1,5001) n`);
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny,flags)
      VALUES('zz-preferred','website','zz-preferred.example.org',true,true,100,'{"domainCheck":"ok","domainCheckedAt":"2026-09-24T00:00:00.000Z"}')`);
    await syntheticDomainProof('zz-preferred','example.org','zz-preferred.example.org');
    await w.fixture.seed.source({geoProjectId:p.id,domain:'zz-preferred.example.org',layer:'coverage',icpMatches:true,newsIndexed:true,medicalVertical:true});
    const digest=(await open().query('SELECT content_sha256 FROM evimed_geo.articles WHERE id=$1',[article])).rows[0].content_sha256;
    await open().query("UPDATE evimed_geo.articles SET current_result_version_id='rv_send' WHERE id=$1",[article]);
    await open().query(`INSERT INTO evimed_geo.article_versions(geo_project_id,article_id,user_id,result_version_id,digest,path,association)
      VALUES($1,$2,$3,'rv_send',$4,'frozen.md',$5::jsonb)`,[p.id,article,p.userId,digest,JSON.stringify({status:'publishable',gate:'passed',safety:'clear'})]);
    let sent=null;w.market.send=async(_type,request)=>{sent=request.resourceId;return {orderNid:'preferred-vendor'};};
    const result=await tickOrders({...w.deps,placementChoices:async()=>({skippedArticleIds:new Set(),preferredByArticle:new Map([[article,['zz-preferred.example.org']]])})});
    assert.equal(result.submitted,1);assert.equal(String(sent),'zz-preferred');
    const [order]=await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:[article],limit:10});
    assert.equal(order.articleResultVersionId,'rv_send');assert.equal(order.articleDigest,digest);
  } finally {await w.close();}
});

test('a supplemental plan keeps its fresh-check requirement: it is withdrawn, not sent, once the proof is old; an ordinary plan has none',options,async()=>{
  const w=await world(fixture,{configured:false});
  try {
    const p=await w.project({articles:[{},{}]}),preferred=p.articleIds[0],ordinary=p.articleIds[1];
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny)
      SELECT 'a' || lpad(n::text,5,'0'),'website','bulk' || n || '.example.org',true,true,100 FROM generate_series(1,5001) n`);
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny,flags)
      VALUES('zz-preferred','website','zz-preferred.example.org',true,true,100,'{"domainCheck":"ok","domainCheckedAt":"2026-09-24T00:00:00.000Z"}')`);
    await syntheticDomainProof('zz-preferred','example.org','zz-preferred.example.org');
    await w.fixture.seed.source({geoProjectId:p.id,domain:'zz-preferred.example.org',layer:'coverage',icpMatches:true,newsIndexed:true,medicalVertical:true});
    const deps={...w.deps,placementChoices:async()=>({skippedArticleIds:new Set(),preferredByArticle:new Map([[preferred,['zz-preferred.example.org']]])})};
    await tickOrders(deps);
    const rows=await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:p.articleIds,limit:10});
    const supplemental=rows.find(row=>row.articleId===preferred),plain=rows.find(row=>row.articleId===ordinary);
    assert.equal(supplemental.resourceId,'zz-preferred');assert.equal(supplemental.domainFreshRequired,true);
    assert.equal(plain.domainFreshRequired,false,'a ranked-catalogue plan has no extra requirement');
    // The proof ages while the plan waits (a later send, a restart): the requirement still holds and the plan is withdrawn.
    await open().query(`UPDATE evimed_geo.media SET flags=flags || '{"domainCheckedAt":"2026-08-01T00:00:00.000Z"}'::jsonb WHERE resource_id='zz-preferred'`);
    const after=await tickOrders({...w.deps,placementChoices:async()=>({skippedArticleIds:new Set(),preferredByArticle:new Map()})});
    assert.ok(after.withdrawn>=1);
    const later=await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:p.articleIds,limit:10});
    assert.equal(later.find(row=>row.id===supplemental.id).state,'cancelled');
    assert.equal(later.find(row=>row.id===plain.id).state,'planned');
  } finally {await w.close();}
});

test('preferred lookup overflow fails closed without creating an order',options,async()=>{
  const w=await world(fixture,{configured:false});
  try {
    const p=await w.project(),article=p.articleIds[0];
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny)
      SELECT 'overflow-' || n,'website','preferred.example.org',true,true,100 FROM generate_series(1,10001) n`);
    const result=await tickOrders({...w.deps,placementChoices:async()=>({skippedArticleIds:new Set(),preferredByArticle:new Map([[article,['preferred.example.org']]])})});
    assert.equal(result.skipped.decision_input_incomplete,1);assert.deepEqual(result.incompleteProjectIds,[p.id]);
    assert.equal((await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:[article],limit:10})).length,0);
  } finally {await w.close();}
});

test('ambiguous host candidates beyond the bound fail closed rather than appearing absent',options,async()=>{
  const {store}=await fixture();
  await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny,flags)
    SELECT 'ambiguous-' || n,'website','org',true,true,100,$1::jsonb FROM generate_series(1,10001) n`,
  [JSON.stringify({host:'sub.victim.org',domainCheck:'ok',domainFinalHost:'sub.victim.org'})]);
  await assert.rejects(store.listPreferredMedia({names:['sub.victim.org'],maxPriceCny:100}),{code:'geo_spine_incomplete'});
});

test('display-name matches cannot impersonate a user-selected domain or exhaust its lookup',options,async()=>{
  const w=await world(fixture,{configured:false});
  try {
    const p=await w.project(),article=p.articleIds[0];
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,name,domain_verified,available,price_cny)
      SELECT 'spoof-' || n,'website','evil.example.org','victim.example.org',true,true,100 FROM generate_series(1,10001) n`);
    await w.fixture.seed.source({geoProjectId:p.id,domain:'evil.example.org',layer:'coverage',icpMatches:true,newsIndexed:true,medicalVertical:true});
    await assert.rejects(w.fixture.store.listPreferredMedia({names:['victim.example.org'],maxPriceCny:1000}),{code:'geo_spine_incomplete'});
    await tickOrders({...w.deps,placementChoices:async()=>({skippedArticleIds:new Set(),preferredByArticle:new Map([[article,['victim.example.org']]])})});
    assert.equal((await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:[article],limit:10})).length,0);
  } finally {await w.close();}
});

test('placement-plan display-name preferences keep their existing meaning',options,async()=>{
  const w=await world(fixture,{configured:false});
  try {
    const p=await w.project(),article=p.articleIds[0];
    await open().query("INSERT INTO evimed_geo.media(resource_id,media_type,domain,name,domain_verified,available,price_cny) VALUES('000-plan','website','plan.example.org','Plan Outlet',true,true,100)");
    await syntheticDomainProof('000-plan','example.org','plan.example.org');
    await w.fixture.seed.source({geoProjectId:p.id,domain:'plan.example.org',layer:'coverage',icpMatches:true,newsIndexed:true,medicalVertical:true});
    await w.fixture.seed.placementPlan(p.id,{preferred:[{articleIds:[article],outlets:['Plan Outlet']}]});
    await tickOrders(w.deps);
    const [order]=await w.fixture.store.listOrders({geoProjectId:p.id,articleIds:[article],limit:10});assert.equal(order.resourceId,'000-plan');
  } finally {await w.close();}
});

test('the action preview does not promote a display-name impersonating the selected domain',options,async()=>{
  const w=await world(fixture);
  try {
    const p=await w.project(),groupId=`${p.id}_g1`;
    await open().query("INSERT INTO evimed_geo.media(resource_id,media_type,domain,name,domain_verified,available,price_cny) VALUES('000-spoof','website','evil.example.org','victim.example.org',true,true,100)");
    await w.fixture.seed.source({geoProjectId:p.id,domain:'evil.example.org',layer:'coverage',icpMatches:true,newsIndexed:true,medicalVertical:true});
    const shown=await previewOutlets(w.deps,{project:await w.fixture.store.getProject({geoProjectId:p.id}),groups:[{id:groupId}],
      candidates:new Map([[groupId,[]]]),articles:await w.fixture.store.getArticles(p.articleIds),
      choices:[{key:`fill_gap:${groupId}:dropped_condition`,skipped:false,sourceDomain:'victim.example.org'}]});
    const rows=shown.get(groupId),selected=rows.find(row=>row.domain==='victim.example.org');
    assert.equal(selected.available,false);assert.ok(selected.unavailableBecause.includes('not_in_catalogue'));
    assert.equal(rows.find(row=>!row.actionKey && row.origin==='market').domain,'jksb.com.cn');
  } finally {await w.close();}
});

test('action-scoped tail host previews match the actual preferred plan without leaking to another action',options,async()=>{
  const w=await world(fixture);
  try {
    const p=await w.project(),groupId=`${p.id}_g1`,geoStore=new GeoStore({database:open()});
    await open().query("INSERT INTO evimed_geo.question_sets(geo_project_id,user_id,version) VALUES($1,$2,1)",[p.id,p.userId]);
    await geoStore.writeStrategy(p.userId,p.id,{gaps:[{gapId:'G1',groupId,class:'dropped_condition',handoff:'content'},
      {gapId:'G2',groupId,class:'missing_evidence',handoff:'content'}]});
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny)
      SELECT 'a' || lpad(n::text,5,'0'),'website','bulk' || n || '.example.org',true,true,100 FROM generate_series(1,5001) n`);
    for(const label of ['a','b']){
      const canonical=`tail-${label}.com`,host=`sub.${canonical}`;
      await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny,flags)
        VALUES($1,'website',$2,true,true,100,$3::jsonb)`,[`zz-tail-${label}`,canonical,JSON.stringify({host,domainCheck:'ok',domainFinalHost:host,domainCheckedAt:'2026-09-24T00:00:00.000Z'})]);
      await syntheticDomainProof(`zz-tail-${label}`,canonical,host);
      await w.fixture.seed.source({geoProjectId:p.id,domain:canonical,layer:'coverage',icpMatches:true,newsIndexed:true,medicalVertical:true});
    }
    const first=`fill_gap:${groupId}:dropped_condition`,second=`fill_gap:${groupId}:missing_evidence`;
    await geoStore.setActionChoice({geoId:p.id,ownerId:p.userId,key:first,decidedBy:p.userId,sourceDomain:'sub.tail-a.com'});
    await geoStore.setActionChoice({geoId:p.id,ownerId:p.userId,key:second,decidedBy:p.userId,sourceDomain:'sub.tail-b.com'});
    const project=await geoStore.getProject(p.userId,p.id),spine=new GeoSpine({store:geoStore,now:w.clock.now,marketConfigured:()=>true,
      placementPreview:input=>previewOutlets(w.deps,input)});
    const actions=(await spine.actions(await spine.load(project))).actions;
    const a=actions.find(action=>action.key===first),b=actions.find(action=>action.key===second);
    const chosenA=a.sources.find(source=>source.domain==='sub.tail-a.com'),chosenB=b.sources.find(source=>source.domain==='sub.tail-b.com');
    assert.equal(chosenA.available,true);assert.equal(chosenA.canonicalDomain,'tail-a.com');
    assert.equal(compactAction(a).sources.find(source=>source.domain==='sub.tail-a.com').canonicalDomain,'tail-a.com');
    assert.equal(chosenB.available,true);assert.equal(chosenB.canonicalDomain,'tail-b.com');
    assert.equal(a.sources.some(source=>source.domain==='sub.tail-b.com'),false);
    assert.equal(b.sources.some(source=>source.domain==='sub.tail-a.com'),false);
    await open().query("UPDATE evimed_geo.media SET flags=jsonb_set(flags,'{domainCheckedAt}',to_jsonb('2026-08-01T00:00:00.000Z'::text)) WHERE resource_id='zz-tail-a'");
    const stale=(await spine.actions(await spine.load(project))).actions.find(action=>action.key===first).sources.find(source=>source.domain==='sub.tail-a.com');
    assert.equal(stale.available,false);assert.ok(stale.unavailableBecause.includes('domain_check_stale'));assert.equal(stale.unavailableBecause.includes('not_in_catalogue'),false);
    await open().query("UPDATE evimed_geo.media SET flags=jsonb_set(flags,'{domainCheckedAt}',to_jsonb('2026-09-24T00:00:00.000Z'::text)) WHERE resource_id='zz-tail-a'");
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny,flags)
      VALUES('000-base-host','website','base-choice.com',true,true,100,$1::jsonb)`,
    [JSON.stringify({host:'sub.base-choice.com',domainCheck:'ok',domainFinalHost:'sub.base-choice.com',domainCheckedAt:'2026-09-24T00:00:00.000Z'})]);
    await syntheticDomainProof('000-base-host','base-choice.com','sub.base-choice.com');
    await w.fixture.seed.source({geoProjectId:p.id,domain:'base-choice.com',layer:'coverage',icpMatches:true,newsIndexed:true,medicalVertical:true});
    await geoStore.setActionChoice({geoId:p.id,ownerId:p.userId,key:first,decidedBy:p.userId,sourceDomain:'sub.base-choice.com'});
    const freshMarket=new GeoMarketStore(open());
    spine.placementPreview=input=>previewOutlets({...w.deps,store:freshMarket},input);
    const baseHost=(await spine.actions(await spine.load(project))).actions.find(action=>action.key===first).sources.find(source=>source.domain==='sub.base-choice.com');
    assert.equal(baseHost.available,true);assert.equal(baseHost.canonicalDomain,'base-choice.com');assert.equal(baseHost.unavailableBecause.includes('not_in_catalogue'),false);
    await geoStore.setActionChoice({geoId:p.id,ownerId:p.userId,key:first,decidedBy:p.userId,sourceDomain:'sub.tail-a.com'});
    await open().query("UPDATE evimed_geo.projects SET budget=$2::jsonb WHERE id=$1",[p.id,JSON.stringify({totalCny:50,dailyCny:50})]);
    const lowBudgetProject=await geoStore.getProject(p.userId,p.id);
    const lowBudget=(await spine.actions(await spine.load(lowBudgetProject))).actions.find(action=>action.key===first).sources.find(source=>source.domain==='sub.tail-a.com');
    assert.equal(lowBudget.available,false);assert.ok(lowBudget.unavailableBecause.includes('placement_not_ready'));
    await open().query("UPDATE evimed_geo.projects SET budget=$2::jsonb WHERE id=$1",[p.id,JSON.stringify({totalCny:1000,dailyCny:1000})]);
    await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,media_type,resource_id,state,created_at)
      VALUES('preview-quota-1',$2,$1,'website','zz-tail-a','submitted','2030-01-01'),('preview-quota-2',$2,$1,'website','zz-tail-a','submitted','2030-01-01')`,[p.id,p.userId]);
    const quotaProject=await geoStore.getProject(p.userId,p.id);
    const quota=(await spine.actions(await spine.load(quotaProject))).actions.find(action=>action.key===first).sources.find(source=>source.domain==='sub.tail-a.com');
    assert.equal(quota.available,false);assert.ok(quota.unavailableBecause.includes('domain_cap_reached'));
    await open().query("DELETE FROM evimed_geo.orders WHERE id IN ('preview-quota-1','preview-quota-2')");
    await geoStore.setActionChoice({geoId:p.id,ownerId:p.userId,key:second,decidedBy:p.userId,skipped:true});
    let sent=null;w.market.send=async(_type,request)=>{sent=request.resourceId;return {orderNid:'tail-host-vendor'};};
    const result=await tickOrders({...w.deps,placementChoices:()=>spine.choiceEffects(project)});
    assert.equal(result.submitted,1);assert.equal(sent,'zz-tail-a');
    const other=await w.project({id:'geo_other_preview',userId:'other',totalCny:null}),otherGroup=`${other.id}_g1`;
    const otherPreview=await previewOutlets(w.deps,{project:await w.fixture.store.getProject({geoProjectId:other.id}),groups:[{id:otherGroup}],
      candidates:new Map([[otherGroup,[]]]),articles:await w.fixture.store.getArticles(other.articleIds),choices:[]});
    assert.equal((otherPreview.get(otherGroup) ?? []).some(row=>String(row.domain).includes('tail-a.com') || String(row.domain).includes('tail-b.com')),false);
  } finally {await w.close();}
});

test('a correction without a question group receives its own tail-source preview',options,async()=>{
  const w=await world(fixture);
  try {
    const p=await w.project(),article=p.articleIds[0],geoStore=new GeoStore({database:open()});
    await open().query("UPDATE evimed_geo.articles SET layer='correction',group_id=NULL WHERE id=$1",[article]);
    await open().query(`INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,status,materials)
      VALUES('ungrouped-error',$1,$2,'ungrouped','deepseek','open',$3::jsonb)`,[p.userId,p.id,JSON.stringify([{kind:'article',articleId:article}])]);
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny)
      SELECT 'a' || lpad(n::text,5,'0'),'website','bulk' || n || '.example.org',true,true,100 FROM generate_series(1,5001) n`);
    const host='sub.ungrouped.com';
    await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny,flags)
      VALUES('zz-ungrouped','website','ungrouped.com',true,true,100,$1::jsonb)`,
    [JSON.stringify({host,domainCheck:'ok',domainFinalHost:host,domainCheckedAt:'2026-09-24T00:00:00.000Z'})]);
    await syntheticDomainProof('zz-ungrouped','ungrouped.com',host);
    await w.fixture.seed.source({geoProjectId:p.id,domain:'ungrouped.com',layer:'coverage',icpMatches:true,newsIndexed:true,medicalVertical:true});
    const key='correct_error:-:ungrouped-error';
    await geoStore.setActionChoice({geoId:p.id,ownerId:p.userId,key,decidedBy:p.userId,sourceDomain:host});
    const project=await geoStore.getProject(p.userId,p.id),spine=new GeoSpine({store:geoStore,now:w.clock.now,marketConfigured:()=>true,
      placementPreview:input=>previewOutlets(w.deps,input)});
    const action=(await spine.actions(await spine.load(project))).actions.find(row=>row.key===key);
    assert.equal(action.group,null);
    const source=action.sources.find(row=>row.domain===host);assert.equal(source.available,true);assert.equal(source.canonicalDomain,'ungrouped.com');
  } finally {await w.close();}
});

test('a blocked preferred lookup returns a typed capacity error rather than waiting indefinitely',options,async()=>{
  const {store}=await fixture();
  await open().withClient(async client=>{
    await client.query('BEGIN');await client.query('LOCK TABLE evimed_geo.media IN ACCESS EXCLUSIVE MODE');
    try { await assert.rejects(store.listPreferredMedia({names:['preferred.example.org'],maxPriceCny:100}),{code:'geo_spine_incomplete'}); }
    finally {await client.query('ROLLBACK');}
  });
});

test('a cancelled preferred-media query preserves its original database cause',options,async()=>{
  const {store}=await fixture(),db=open();
  await db.withClient(async locker=>{
    await locker.query('BEGIN');await locker.query('LOCK TABLE evimed_geo.media IN ACCESS EXCLUSIVE MODE');
    try {
      const pending=store.listPreferredMedia({names:['preferred.example.org'],maxPriceCny:100});
      const checked=assert.rejects(pending,error=>error?.code==='geo_source_preview_interrupted' && error.status===503
        && error.cause?.code==='57014' && /user request/i.test(error.cause.message));
      let pid=null;
      for(let attempt=0;attempt<100;attempt++){
        const result=await db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT * FROM evimed_geo.media WHERE%' LIMIT 1");
        if(result.rows.length){pid=result.rows[0].pid;break;}await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.ok(pid,'the real query must be waiting before cancellation');
      await db.query('SELECT pg_cancel_backend($1)',[pid]);await checked;
    } finally {await locker.query('ROLLBACK');}
  });
});

test('a localized PostgreSQL timeout is reported as an interruption with its original cause',options,async t=>{
  const {store}=await fixture(),db=open();
  try {await db.transaction(client=>client.query("SET LOCAL lc_messages='zh_CN.UTF-8'"));}
  catch {t.skip('PostgreSQL Chinese messages are unavailable for this test role');return;}
  await db.withClient(async locker=>{
    await locker.query('BEGIN');await locker.query('LOCK TABLE evimed_geo.media IN ACCESS EXCLUSIVE MODE');
    try {
      const attempt=db.transaction(client=>db.withTransactionClient(client,async()=>{
        await client.query("SET LOCAL lc_messages='zh_CN.UTF-8'");
        return store.listPreferredMedia({names:['preferred.example.org'],maxPriceCny:100});
      }));
      await assert.rejects(attempt,error=>error?.code==='geo_source_preview_interrupted' && error.status===503
        && error.cause?.code==='57014' && /超时/.test(error.cause.message));
    } finally {await locker.query('ROLLBACK');}
  });
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


test("selected catalogue recheck is bounded, deduplicated and retryable across workers", options, async () => {
  const { store } = await fixture();
  await open().query(`INSERT INTO evimed_geo.media (media_type,resource_id,domain,available,price_cny)
    SELECT 'website','a-'||lpad(n::text,5,'0'),'base'||n||'.org',true,100 FROM generate_series(1,5000) n`);
  await open().query(`INSERT INTO evimed_geo.media (media_type,resource_id,domain,case_link,available,price_cny,domain_verified,flags)
    VALUES ('website','zz-tail','example.org','https://example.org/case',true,100,false,'{}')`);
  assert.ok(!(await store.listCandidateMedia({maxPriceCny:100,limit:5000})).some(media=>media.resourceId==='zz-tail'));
  let reads = 0;
  let fail = true;
  let clock = new Date('2026-11-04T00:00:00.000Z');
  const deps = { store, market: { configured: true }, now: () => clock,
    webReader: { read: async () => { reads += 1; if (fail) throw new Error('private failure');
      return { receipt: { finalUrl: 'https://example.org/case' }, text: '' }; } } };
  const [one, two] = await Promise.all([recheckSelectedDomain(deps, 'example.org'), recheckSelectedDomain(deps, 'example.org')]);
  assert.equal(one.checked + two.checked, 1);
  assert.equal(one.coolingDown + two.coolingDown, 1);
  assert.equal(reads, 1);
  assert.equal((await store.listPreferredMedia({ names: ['example.org'], maxPriceCny: 100 }))[0].domainVerified, false);
  fail = false; clock = new Date(clock.getTime() + 61_000);
  assert.equal((await recheckSelectedDomain(deps, 'example.org')).verified, 1);
  assert.equal((await store.listPreferredMedia({ names: ['example.org'], maxPriceCny: 100 }))[0].domainVerified, true);
  await open().query("UPDATE evimed_geo.media SET flags=jsonb_set(flags,'{domainCheckedAt}',to_jsonb('2020-01-01T00:00:00.000Z'::text)) WHERE resource_id='zz-tail'");
  clock = new Date(clock.getTime() + 61_000);
  assert.equal((await recheckSelectedDomain(deps, 'example.org')).verified, 1, 'expired proof is rechecked');
  await open().query(`INSERT INTO evimed_geo.media (media_type,resource_id,domain,case_link,available,price_cny)
    SELECT 'website','duplicate-'||n,'example.org','https://example.org/case',true,100 FROM generate_series(1,4) n`);
  const first = await recheckSelectedDomain(deps, 'example.org');
  assert.deepEqual([first.checked, first.verified, first.remaining], [3, 3, 1]);
  const next = await recheckSelectedDomain(deps, 'example.org');
  assert.deepEqual([next.checked, next.verified, next.remaining], [1, 1, 0]);
  assert.equal(reads, 7);
  await open().query(`INSERT INTO evimed_geo.media (media_type,resource_id,domain,case_link,available,price_cny)
    VALUES ('website','zz-crash','crashsample.org','https://crashsample.org/case',true,100)`);
  const crashMedia = (await store.listPreferredMedia({names:['crashsample.org'],maxPriceCny:100}))[0];
  assert.equal(await store.claimDomainRecheck(crashMedia,'old-token',clock.toISOString(),new Date(clock.getTime()-60_000).toISOString()),true);
  assert.equal((await recheckSelectedDomain(deps,'crashsample.org')).coolingDown,1);
  clock = new Date(clock.getTime()+61_000);
  assert.equal(await store.claimDomainRecheck(crashMedia,'new-token',clock.toISOString(),new Date(clock.getTime()-60_000).toISOString()),true);
  assert.equal(await store.finishDomainRecheck(crashMedia,'old-token',{domainVerified:true,flags:{}}),false);
});

test('domain check claim preserves shared proof and resync invalidates an old check', options, async () => {
  const {store, seed} = await fixture();
  await seed.project({id:'shared-g1',userId:'u1'});
  await seed.project({id:'shared-g2',userId:'u2'});
  await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state,media_type,resource_id) VALUES
    ('shared-order-1','u1','shared-g1','planned','website','shared'),('shared-order-2','u2','shared-g2','planned','website','shared')`);
  await open().query(`INSERT INTO evimed_geo.media(media_type,resource_id,domain,case_link,available,price_cny,domain_verified,flags)
    VALUES('website','shared','example.org','https://www.example.org/old',true,100,true,'{"domainCheck":"ok","domainCheckedAt":"2026-01-01T00:00:00.000Z"}')`);
  const media=(await store.listPreferredMedia({names:['example.org'],maxPriceCny:100}))[0];
  assert.equal(await store.claimDomainRecheck(media,'in-flight','2026-11-04T00:00:00.000Z','2026-11-03T23:59:00.000Z'),true);
  assert.equal((await store.listPreferredMedia({names:['example.org'],maxPriceCny:100}))[0].domainVerified,true);
  assert.equal((await open().query("SELECT count(*)::int AS n FROM evimed_geo.orders WHERE state='planned' AND resource_id='shared'")).rows[0].n,2);
  const updated={...media,caseLink:'https://www.example.org/new',syncedAt:'2026-11-04T00:00:00.000Z'};
  await store.upsertMediaRows([updated]);
  assert.equal(await store.finishDomainRecheck(media,'in-flight',{domainVerified:true,flags:{domainCheck:'ok'}}),false);
  const current=(await store.listPreferredMedia({names:['example.org'],maxPriceCny:100}))[0];
  assert.equal(current.domainVerified,null);
  assert.equal(current.flags.domainCheck,undefined);
  let reads=0;
  const result=await recheckSelectedDomain({store,market:{configured:true},now:()=>new Date('2026-11-04T00:02:00.000Z'),webReader:{read:async()=>{reads++;return {receipt:{finalUrl:'https://www.example.org/new'},text:''};}}},'www.example.org');
  assert.equal(result.verified,1); assert.equal(reads,1);
  const negative=await recheckSelectedDomain({store,market:{configured:true},webReader:{read:async()=>{throw new Error('must not read');}}},'evil-example.org');
  assert.equal(negative.checked,0);
});

test('a revoked selection stops the next external read and stores no later verdict', options, async () => {
  const {store}=await fixture();
  await open().query(`INSERT INTO evimed_geo.media(media_type,resource_id,domain,case_link,available,price_cny)
    SELECT 'website','stop-'||n,'example.org','https://example.org/'||n,true,100 FROM generate_series(1,3) n`);
  let reads=0;
  const deps={store,market:{configured:true},webReader:{read:async()=>{reads++;return {receipt:{finalUrl:'https://example.org/'},text:''};}}};
  await assert.rejects(recheckSelectedDomain(deps,'example.org',async()=>{if(reads) throw new Error('revoked');}),/revoked/);
  assert.equal(reads,1);
  const rows=await store.listPreferredMedia({names:['example.org'],maxPriceCny:100});
  assert.equal(rows.filter(row=>row.domainVerified===true).length,0);
});


test('catalogue tick and manual recheck share a cross-worker claim', options, async () => {
  const {store}=await fixture();
  await open().query(`INSERT INTO evimed_geo.media(media_type,resource_id,domain,case_link,available,price_cny)
    VALUES('website','shared','example.org','https://example.org/case',true,100)`);
  let reads=0, entered; const started=new Promise(resolve=>{entered=resolve;});
  let release; const held=new Promise(resolve=>{release=resolve;});
  const deps={store,market:{configured:true,fields:async()=>[],mediaList:async()=>{throw new Error('offline');}},
    webReader:{read:async()=>{reads++;entered();await held;return {receipt:{finalUrl:'https://example.org/case'},text:''};}}};
  const tick=tickCatalogue(deps);
  await started;
  const manual=await recheckSelectedDomain(deps,'example.org');
  assert.equal(manual.coolingDown,1);assert.equal(reads,1);
  release();await tick;
  assert.equal((await store.listPreferredMedia({names:['example.org'],maxPriceCny:100}))[0].domainVerified,true);
});

test('cancelled in-flight recheck aborts the reader and preserves the prior proof', options, async () => {
  const {store}=await fixture();
  await open().query(`INSERT INTO evimed_geo.media(media_type,resource_id,domain,case_link,available,price_cny,domain_verified,flags)
    VALUES('website','abort','example.org','https://example.org/case',true,100,true,'{"domainCheck":"ok","domainCheckedAt":"2020-01-01T00:00:00.000Z"}')`);
  const controller=new AbortController();let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const deps={store,market:{configured:true},webReader:{read:async (_url,{signal})=>{entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw new Error('internal');}}};
  const pending=recheckSelectedDomain(deps,'example.org',async()=>{},controller.signal);
  const rejected=assert.rejects(pending,{code:'geo_source_preview_interrupted'});
  await started;controller.abort();await rejected;
  const row=(await store.listPreferredMedia({names:['example.org'],maxPriceCny:100}))[0];
  assert.equal(row.domainVerified,true);assert.equal(row.flags.domainCheckedAt,'2020-01-01T00:00:00.000Z');
});

test('temporary reader failure preserves shared evidence and in-flight revocation prevents write', options, async () => {
  const {store,seed}=await fixture();
  await seed.project({id:'g-fail1',userId:'u1'});await seed.project({id:'g-fail2',userId:'u2'});
  await open().query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state,media_type,resource_id) VALUES
    ('fail-order1','u1','g-fail1','planned','website','shared'),('fail-order2','u2','g-fail2','planned','website','shared')`);
  await open().query(`INSERT INTO evimed_geo.media(media_type,resource_id,domain,case_link,available,price_cny,domain_verified,flags)
    VALUES('website','shared','example.org','https://example.org/case',true,100,true,'{"domainCheck":"ok","domainCheckedAt":"2020-01-01T00:00:00.000Z"}')`);
  let clock=new Date('2026-11-04T00:00:00Z');
  const deps={store,market:{configured:true},now:()=>clock,webReader:{read:async()=>{throw new Error('temporary');}}};
  assert.equal((await recheckSelectedDomain(deps,'example.org')).verified,0);
  let row=(await store.listPreferredMedia({names:['example.org'],maxPriceCny:100}))[0];
  assert.equal(row.domainVerified,true);assert.equal(row.flags.domainCheckedAt,'2020-01-01T00:00:00.000Z');
  assert.equal((await open().query("SELECT count(*)::int AS n FROM evimed_geo.orders WHERE state='planned'")).rows[0].n,2);
  clock=new Date(clock.getTime()+61_000);let calls=0;
  deps.webReader.read=async()=>({receipt:{finalUrl:'https://elsewhere.org'},text:''});
  await assert.rejects(recheckSelectedDomain(deps,'example.org',async()=>{if(++calls===3)throw new Error('revoked');}),/revoked/);
  row=(await store.listPreferredMedia({names:['example.org'],maxPriceCny:100}))[0];
  assert.equal(row.domainVerified,true);assert.equal(row.flags.domainCheckedAt,'2020-01-01T00:00:00.000Z');
});

test('canonical and host source conflicts veto both preview and real sending',options,async t=>{
  for(const mode of ['blacklist','impostor','icp','news','medical','unknown','canonical-blacklist','approved']) await t.test(mode,async()=>{
    const w=await world(fixture);
    try {
      const p=await w.project(),groupId=`${p.id}_g1`;
      await open().query("UPDATE evimed_geo.media SET available=false WHERE resource_id <> '101'");
      await w.fixture.seed.source({geoProjectId:p.id,domain:'www.jksb.com.cn',icpMatches:mode==='icp'?false:mode==='unknown'?null:true,
        newsIndexed:mode==='news'?false:true,medicalVertical:mode==='medical'?false:true,
        impostor:mode==='impostor',blacklistReason:mode==='blacklist'?'blocked':null});
      if(mode==='canonical-blacklist') await open().query("UPDATE evimed_geo.sources SET blacklist_reason='blocked' WHERE geo_project_id=$1 AND domain='jksb.com.cn'",[p.id]);
      const project=await w.fixture.store.getProject({geoProjectId:p.id});
      const key=`fill_gap:${groupId}:dropped_condition`;
      const shown=await previewOutlets(w.deps,{project,groups:[{id:groupId}],candidates:new Map([[groupId,[]]]),
        articles:await w.fixture.store.getArticles(p.articleIds),choices:[{key,skipped:false,sourceDomain:'www.jksb.com.cn'}]});
      const preferred=(shown.get(groupId)??[]).find(item=>item.actionKey===key);
      assert.ok(preferred);assert.equal(preferred.available,['approved','multi-approved'].includes(mode));
      await w.fixture.store.insertOrders([{id:`conflict-${mode}`,userId:p.userId,geoProjectId:p.id,articleId:p.articleIds[0],mediaType:'website',resourceId:'101',priceCny:100,reserveCny:110}],w.clock.now().toISOString());
      await tickOrders(w.deps);
      assert.equal(w.fake.requestsTo('/api/media/send').length,['approved','multi-approved'].includes(mode)?1:0,'only an admitted source can be sent');
    } finally {await w.close();}
  });
});


test('real source writes veto normalized case and verified redirect hosts before sending', options, async t=>{
  for(const mode of ['www','trailing-dot','redirect','historical','multi-case','multi-redirect','multi-approved','approved']) await t.test(mode,async()=>{
    const w=await world(fixture);
    try {
      const p=await w.project(), geoStore=new GeoStore({database:open()}),groupId=`${p.id}_g1`;
      const host=mode==='multi-case'||mode==='multi-approved'?'WWW.WWW.Sub.Jksb.com.cn.':mode==='www' || mode==='historical'?'www.sub.jksb.com.cn':mode==='trailing-dot'?'sub.jksb.com.cn.':'www.jksb.com.cn';
      const finalHost=mode==='multi-redirect'?'WWW.WWW.Sub.Jksb.com.cn.':mode==='redirect'?'sub.jksb.com.cn':host;
      await open().query("UPDATE evimed_geo.media SET available=false WHERE resource_id <> '101'");
      await open().query("UPDATE evimed_geo.media SET flags=flags || $1::jsonb WHERE resource_id='101'",[JSON.stringify({host,domainFinalHost:finalHost,domainCheck:'ok',domainCheckedAt:w.clock.now().toISOString()})]);
      const project=await geoStore.getProject(p.userId,p.id);
      const result=await geoRuntimeWrite({store:geoStore,project,what:'sources',body:{items:[{domain:mode.startsWith('multi-')?'www.www.sub.jksb.com.cn':'www.sub.jksb.com.cn',icpMatches:true,newsIndexed:true,medicalVertical:true,...(['approved','historical','multi-approved'].includes(mode)?{}:{blacklistReason:'blocked'})}]}});
      assert.equal(result.written?.length ?? result.ids?.length ?? 1,1);
      assert.equal((await open().query("SELECT count(*)::int AS n FROM evimed_geo.sources WHERE geo_project_id=$1 AND domain=$2",[p.id,'sub.jksb.com.cn'])).rows[0].n,1);
      if(mode==='historical') await w.fixture.seed.source({geoProjectId:p.id,domain:'WWW.SUB.JKSB.COM.CN.',icpMatches:true,newsIndexed:true,medicalVertical:true,blacklistReason:'blocked'});
      const marketProject=await w.fixture.store.getProject({geoProjectId:p.id}),key=`fill_gap:${groupId}:dropped_condition`;
      const shown=await previewOutlets(w.deps,{project:marketProject,groups:[{id:groupId}],candidates:new Map([[groupId,[]]]),articles:await w.fixture.store.getArticles(p.articleIds),choices:[{key,skipped:false,sourceDomain:'jksb.com.cn'}]});
      const preferred=(shown.get(groupId)??[]).find(item=>item.actionKey===key);
      assert.ok(preferred);assert.equal(preferred.available,['approved','multi-approved'].includes(mode));
      await w.fixture.store.insertOrders([{id:`dns-${mode}`,userId:p.userId,geoProjectId:p.id,articleId:p.articleIds[0],mediaType:'website',resourceId:'101',priceCny:100,reserveCny:110}],w.clock.now().toISOString());
      await tickOrders(w.deps);
      assert.equal(w.fake.requestsTo('/api/media/send').length,['approved','multi-approved'].includes(mode)?1:0);
    } finally {await w.close();}
  });
});

test('registered www.com.cn is not confused with pseudo-root com.cn',options,async t=>{
  for(const mode of ['blocked','approved','root-only'])await t.test(mode,async()=>{
    const w=await world(fixture);
    try {
      const p=await w.project(),geoStore=new GeoStore({database:open()}),groupId=`${p.id}_g1`,project=await geoStore.getProject(p.userId,p.id);
      await open().query("UPDATE evimed_geo.media SET available=false WHERE resource_id <> '101'");
      await open().query("UPDATE evimed_geo.media SET domain='www.com.cn',flags=flags || $1::jsonb WHERE resource_id='101'",[JSON.stringify({host:'www.www.com.cn',domainFinalHost:'www.www.com.cn',domainCheck:'ok',domainCheckedAt:w.clock.now().toISOString()})]);
      await syntheticDomainProof('101','www.com.cn','www.www.com.cn');
      await w.fixture.seed.source({geoProjectId:p.id,domain:'com.cn',icpMatches:true,newsIndexed:true,medicalVertical:true});
      if(mode!=='root-only')await geoRuntimeWrite({store:geoStore,project,what:'sources',body:{items:[{domain:'www.com.cn',icpMatches:true,newsIndexed:true,medicalVertical:true,...(mode==='blocked'?{blacklistReason:'blocked'}:{})}]}});
      const marketProject=await w.fixture.store.getProject({geoProjectId:p.id});
      const preview=await previewOutlets(w.deps,{project:marketProject,groups:[{id:groupId}],candidates:new Map([[groupId,[]]]),articles:await w.fixture.store.getArticles(p.articleIds),choices:[]});
      const item=(preview.get(groupId)??[]).find(source=>source.domain==='www.com.cn');
      assert.equal(Boolean(item),mode==='approved');
      await w.fixture.store.insertOrders([{id:`root-${mode}`,userId:p.userId,geoProjectId:p.id,articleId:p.articleIds[0],mediaType:'website',resourceId:'101',priceCny:100,reserveCny:110}],w.clock.now().toISOString());
      await tickOrders(w.deps);assert.equal(w.fake.requestsTo('/api/media/send').length,mode==='approved'?1:0);
    } finally {await w.close();}
  });
});

test('public suffix rules reject a redirect between independent co.za sites',options,async()=>{
  const {store}=await fixture();
  await open().query(`INSERT INTO evimed_geo.media(media_type,resource_id,domain,case_link,available,price_cny)
    VALUES('website','za','one.co.za','https://one.co.za/case',true,100)`);
  const deps={store,market:{configured:true,fields:async()=>[],mediaList:async()=>{throw new Error('offline');}},
    webReader:{read:async()=>({receipt:{finalUrl:'https://two.co.za/case'},text:''})}};
  await tickCatalogue(deps);
  const media=(await store.listPreferredMedia({names:['one.co.za'],maxPriceCny:100}))[0];
  assert.equal(media.domainVerified,false);assert.equal(media.flags.domainCheck,'left_domain');
});

test('spine choices preserve registrable www through reservation and sending',options,async t=>{
  for(const choice of ['www.com.cn','www.www.com.cn','WWW.WWW.WWW.com.cn.','www.jksb.com.cn','pseudo-root']) await t.test(choice,async()=>{
    const w=await world(fixture);
    try {
      const p=await w.project(),groupId=`${p.id}_g1`,geoStore=new GeoStore({database:open()});
      await open().query('INSERT INTO evimed_geo.question_sets(geo_project_id,user_id,version) VALUES($1,$2,1)',[p.id,p.userId]);
      await geoStore.writeStrategy(p.userId,p.id,{gaps:[{gapId:'G1',groupId,class:'dropped_condition',handoff:'content'}]});
      const root=choice==='www.jksb.com.cn'?'jksb.com.cn':'www.com.cn';
      if(root==='www.com.cn'){
        await open().query(`INSERT INTO evimed_geo.media(resource_id,media_type,domain,domain_verified,available,price_cny,flags)
          VALUES('002-root','website','www.com.cn',true,true,100,$1::jsonb)`,[JSON.stringify({host:'www.www.com.cn',domainFinalHost:'www.www.com.cn',domainCheck:'ok',domainCheckedAt:w.clock.now().toISOString()})]);
        await open().query("UPDATE evimed_geo.media SET case_link='https://www.www.com.cn/case' WHERE resource_id='002-root'");
        await w.fixture.seed.source({geoProjectId:p.id,domain:choice==='pseudo-root'?'com.cn':'www.com.cn',icpMatches:true,newsIndexed:true,medicalVertical:true});
      }
      const service=new GeoService({store:geoStore,config:{geoEnabled:true,geoAudience:'all',operatorUsers:[],geoPreviewUsers:[]},now:w.clock.now});
      const key=`fill_gap:${groupId}:dropped_condition`;
      const requested=choice==='pseudo-root'?'www.com.cn':choice;
      await service.chooseAction({id:p.userId},p.id,key,{sourceDomain:requested});
      const project=await geoStore.getProject(p.userId,p.id),spine=new GeoSpine({store:geoStore,now:w.clock.now,marketConfigured:()=>true});
      const effects=await spine.choiceEffects(project);
      assert.deepEqual(effects.preferredByArticle.get(p.articleIds[0]),[root]);
      let sent=null;w.market.send=async(_type,request)=>{sent=request.resourceId;return {orderNid:'domain-choice-vendor'};};
      await tickOrders({...w.deps,placementChoices:()=>spine.choiceEffects(project)});
      assert.equal(sent,choice==='pseudo-root'?'101':root==='www.com.cn'?'002-root':'101');
    } finally {await w.close();}
  });
});

test('historical PSL proof is revalidated before preview or sending',options,async t=>{
  for(const mode of ['coza','private','missing-case','missing-final','missing-time','same-domain'])await t.test(mode,async()=>{
    const w=await world(fixture);
    try {
      const p=await w.project(),groupId=`${p.id}_g1`;
      const domain=mode==='coza'?'co.za':mode==='private'?'github.io':'example.org';
      const caseUrl=mode==='coza'?'https://one.co.za/page':mode==='private'?'https://a.github.io/page':mode==='missing-case'?null:'https://one.example.org/page';
      const finalHost=mode==='coza'?'two.co.za':mode==='private'?'b.github.io':mode==='missing-final'?null:'two.example.org';
      await open().query('UPDATE evimed_geo.media SET available=false');
      await open().query(`INSERT INTO evimed_geo.media(media_type,resource_id,domain,case_link,available,price_cny,domain_verified,flags)
        VALUES('website','000-proof',$1,$2,true,100,true,$3::jsonb)`,[domain,caseUrl,JSON.stringify({domainCheck:'ok',domainFinalHost:finalHost,...(mode==='missing-time'?{}:{domainCheckedAt:w.clock.now().toISOString()})})]);
      await w.fixture.seed.source({geoProjectId:p.id,domain,icpMatches:true,newsIndexed:true,medicalVertical:true});
      const key=`fill_gap:${groupId}:dropped_condition`,project=await w.fixture.store.getProject({geoProjectId:p.id});
      const preview=await previewOutlets(w.deps,{project,groups:[{id:groupId}],candidates:new Map([[groupId,[]]]),articles:await w.fixture.store.getArticles(p.articleIds),choices:[{key,sourceDomain:domain,skipped:false}]});
      const selected=(preview.get(groupId)??[]).find(item=>item.actionKey===key);
      assert.ok(selected);assert.equal(selected.available,mode==='same-domain');
      await w.fixture.store.insertOrders([{id:`proof-${mode}`,userId:p.userId,geoProjectId:p.id,articleId:p.articleIds[0],mediaType:'website',resourceId:'000-proof',priceCny:100,reserveCny:110}],w.clock.now().toISOString());
      await tickOrders(w.deps);
      assert.equal(w.fake.requestsTo('/api/media/send').length,mode==='same-domain'?1:0);
      if(mode!=='same-domain')assert.equal((await w.fixture.store.getOrder(`proof-${mode}`)).state,'planned');
      if(mode==='missing-final') {
        w.reader.pages.set(caseUrl,{finalUrl:'https://two.example.org/page'});
        assert.equal((await recheckSelectedDomain(w.deps,domain)).verified,1);
        await tickOrders(w.deps);
        assert.equal(w.fake.requestsTo('/api/media/send').length,1,'a real recheck restores the held plan');
      }
    } finally {await w.close();}
  });
});

test('preferred media lookup normalizes Unicode and historic host keys, or explicitly refuses oversized catalogue',options,async()=>{
  const {store}=await fixture();
  await open().query(`INSERT INTO evimed_geo.media(media_type,resource_id,domain,available,price_cny,domain_verified,flags)
    SELECT 'website','a'||lpad(n::text,5,'0'),'example.org',true,100,true,'{}' FROM generate_series(1,5001) n`);
  await open().query(`INSERT INTO evimed_geo.media(media_type,resource_id,domain,available,price_cny,domain_verified,flags)
    VALUES('website','zz-host','xn--85x722f.xn--55qx5d.cn',true,100,true,$1::jsonb)`,
  [JSON.stringify({host:'WWW.WWW.食狮.公司.cn.',domainFinalHost:'www.xn--85x722f.xn--55qx5d.cn',domainCheck:'ok'})]);
  const found=await store.listPreferredMedia({names:['食狮.公司.cn'],maxPriceCny:100});
  assert.ok(found.some(row=>row.resourceId==='zz-host'));
  await open().query(`INSERT INTO evimed_geo.media(media_type,resource_id,domain,available,price_cny)
    SELECT 'website','b'||lpad(n::text,5,'0'),'example.org',true,100 FROM generate_series(1,5000) n`);
  await assert.rejects(store.listPreferredMedia({names:['not-present.org'],maxPriceCny:100}),{code:'geo_spine_incomplete'});
});

test('invalid proof plans do not starve a later valid plan across ticks',options,async()=>{
  const w=await world(fixture);
  try {
    const p=await w.project({totalCny:10000,dailyCny:10000,articles:Array.from({length:11},()=>({}))});
    await open().query("INSERT INTO evimed_geo.media(media_type,resource_id,domain,available,price_cny,domain_verified,flags) VALUES('website','invalid-proof','example.org',true,100,true,'{}')");
    await w.fixture.store.insertOrders(p.articleIds.map((articleId,index)=>({id:`fair-${String(index).padStart(2,'0')}`,userId:p.userId,geoProjectId:p.id,articleId,mediaType:'website',resourceId:index===10?'101':'invalid-proof',priceCny:100,reserveCny:110})),w.clock.now().toISOString());
    let sends=0;w.market.send=async()=>{sends++;return {orderNid:'fair-vendor'};};
    const first=await tickOrders(w.deps);await tickOrders(w.deps);
    assert.equal(sends,1);assert.equal(first.submitted,1);
    const rows=await w.fixture.store.listDecisionOrders({geoProjectId:p.id});
    assert.equal(rows.filter(row=>row.state==='planned').length,10);
    assert.equal(rows.find(row=>row.id==='fair-10').state,'submitted');
  } finally {await w.close();}
});

test('catalogue skips missing URLs and rotates failed reads to reach healthy media',options,async()=>{
  const {store}=await fixture();let instant=new Date('2026-11-04T00:00:00.000Z');const clock=()=>instant;
  await open().query(`INSERT INTO evimed_geo.media(media_type,resource_id,domain,case_link,available,price_cny)
    SELECT 'website','a-missing-'||lpad(n::text,5,'0'),'missing'||n||'.org',null,true,100 FROM generate_series(1,5001) n
    UNION ALL SELECT 'website','b-fail-'||lpad(n::text,3,'0'),'fail'||n||'.org','https://fail'||n||'.org/case',true,100 FROM generate_series(1,60) n
    UNION ALL SELECT 'website','z-healthy','healthy.org','https://healthy.org/case',true,100`);
  const calls=[];
  const deps={store,now:clock,market:{configured:true,fields:async()=>[],mediaList:async()=>{throw new Error('offline');}},webReader:{read:async url=>{
    calls.push(url);if(!url.includes('healthy.org'))throw new Error('temporary');return {receipt:{finalUrl:url},text:''};}}};
  const first=await tickCatalogue(deps);const second=await tickCatalogue(deps);
  assert.equal(first.domainChecks,60);assert.equal(second.domainChecks,1);assert.equal(calls.length,61);
  const media=(await store.getMediaRows('website',['z-healthy']))[0];assert.equal(media.domainVerified,true);
  const failed=(await store.getMediaRows('website',['b-fail-001']))[0];assert.equal(failed.domainVerified,null);assert.ok(failed.flags.manualDomainCheckAt);
  instant=new Date(instant.getTime()+61_000);const third=await tickCatalogue(deps);assert.equal(third.domainChecks,60);assert.equal(calls.length,121);
});
