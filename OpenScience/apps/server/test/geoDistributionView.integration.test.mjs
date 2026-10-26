import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoDistributionView } from '../src/geoDistributionView.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost PostgreSQL database is required' };
let database, isolated, store, view, project;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'distribution');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 3000 });
  store = new GeoStore({ database }); await store.ready(); view = new GeoDistributionView({ store });
  project = await store.createProject({ userId: 'distribution-owner', projectId: 'distribution-project', engines: ['deepseek'], coverageDays: 90 });
  await database.query('UPDATE evimed_geo.projects SET budget=$2::jsonb WHERE id=$1', [project.id, JSON.stringify({ totalCny: 500, dailyCny: 100 })]);
  for (const [id, kind, amount, order] of [['01', 'budget_set', 500, null], ['02', 'reserve', 100, 'order-a'], ['03', 'settle', 80, 'order-a'], ['04', 'release', 20, 'order-a'], ['05', 'refund', 30, 'order-a']]) {
    await database.query('INSERT INTO evimed_geo.ledger(id,user_id,geo_project_id,order_id,kind,amount_cny,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, project.userId, project.id, order, kind, amount, `2026-10-24T00:00:${id}Z`]);
  }
  await database.query("INSERT INTO evimed_geo.ledger(id,geo_project_id,kind,amount_cny) VALUES('foreign','other-project','settle',999)");
});
after(async () => { await database?.close(); await isolated?.drop(); });

test('project ledger pages preserve complete balances, actual budget history and all older entries', options, async () => {
  const first = await view.ledger(project, { limit: 2 });
  assert.equal(first.total, 5); assert.deepEqual(first.items.map(row => row.id), ['05', '04']);
  assert.equal(first.summary.spentCny, 50); assert.equal(first.summary.availableCny, 450);
  assert.equal(first.items[0].balance.refundedCny, 30);
  assert.equal(first.items[1].balance.availableCny, 420);
  const second = await view.ledger(project, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(row => row.id), ['03', '02']);
  assert.equal(second.items[0].balance.reservedCny, 20);
  assert.equal(second.items[1].balance.availableCny, 400);
  assert.deepEqual(second.summary, first.summary, 'pagination cannot narrow current project totals');
  const third = await view.ledger(project, { limit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.items.map(row => row.id), ['01']); assert.equal(third.nextCursor, null);
  assert.equal(third.items[0].balance.availableCny, 500);
  assert.equal(third.opening.availableCny, null, 'no historical budget is invented before the first setting');
  await assert.rejects(view.ledger({ ...project, id: 'other-project' }, { cursor: first.nextCursor }), { code: 'geo_payload_invalid' });
});

test('project ledger ignores foreign and platform rows and rejects unsupported filters', options, async () => {
  const result = await view.ledger(project);
  assert.equal(result.currency, 'CNY'); assert.equal(result.items.some(row => row.id === 'foreign'), false);
  assert.equal(result.items.some(row => Object.hasOwn(row, 'note')), false);
  await assert.rejects(view.ledger(project, { limit: 201 }), { code: 'geo_payload_invalid' });
  await assert.rejects(view.ledger(project, { month: '2026-10' }), { code: 'geo_payload_invalid' });
});

test('execution reads retain immutable publication pins, real publication time and authoritative cancellation', options, async () => {
  await database.query(`INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,title,status,current_result_version_id,content_sha256)
    VALUES('article-a',$1,$2,'Revised current draft','published','v2',$3)`, [project.userId, project.id, '2'.repeat(64)]);
  for (const [id, state, article, at] of [['order-published', 'settled', 'article-a', '2026-10-03T00:00:00Z'], ['order-sending', 'reserved', null, '2026-10-04T00:00:00Z'], ['order-unknown', 'unknown', null, '2026-10-05T00:00:00Z']]) {
    await database.query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,article_id,state,created_at,updated_at,article_result_version_id,article_digest)
      VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8)`, [id, project.userId, project.id, article, state, at, article ? 'v0' : null, article ? '0'.repeat(64) : null]);
  }
  await database.query(`INSERT INTO evimed_geo.order_events(id,order_id,at,from_state,to_state,detail) VALUES
    ('published-event','order-published','2026-10-01T00:00:00Z','accepted','published','{"private":"private-internal-marker"}'),
    ('settled-event','order-published','2026-10-03T00:00:00Z','verified','settled','{}'),
    ('send-event','order-sending','2026-10-04T00:00:01Z','reserved','reserved','{"phase":"send_started"}')`);
  await database.query("INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state) VALUES('foreign-order','foreign-owner','other-project','planned')");
  const first = await view.orders(project, { limit: 2 });
  assert.equal(first.total, 3); assert.deepEqual(first.items.map(row => row.id), ['order-unknown', 'order-sending']);
  assert.ok(first.items.every(row => row.cancellable === false));
  const second = await view.orders(project, { limit: 2, cursor: first.nextCursor });
  assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
  const row = second.items[0];
  assert.equal(row.articleResultVersionId, 'v0'); assert.equal(row.articleDigest, '0'.repeat(64));
  assert.equal(row.currentResultVersionId, 'v2'); assert.equal(row.versionState, 'update_needed');
  assert.equal(row.publishedAt, '2026-10-01T00:00:00.000Z'); assert.equal(row.updatedAt, '2026-10-03T00:00:00.000Z');
  const detail = await view.order(project, row.id, { limit: 1 });
  assert.equal(detail.events.total, 2); assert.equal(detail.events.items[0].id, 'settled-event');
  const earlier = await view.order(project, row.id, { limit: 1, cursor: detail.events.nextCursor });
  assert.equal(earlier.events.items[0].id, 'published-event');
  assert.doesNotMatch(JSON.stringify(earlier), /private-internal-marker|vendorOrderNid/);
  await assert.rejects(view.order(project, 'foreign-order'), { status: 404 });
  await assert.rejects(view.orders({ ...project, id: 'other-project' }, { cursor: first.nextCursor }), { code: 'geo_payload_invalid' });
});
