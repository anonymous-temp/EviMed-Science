import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoOwnedPublications } from '../src/geoOwnedPublications.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { seedGeoProject } from './helpers/geoMeasureFixtures.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost PostgreSQL database is required' };
let isolated, database, store, documents, publications;
const project = { id: 'publication_geo', userId: 'publication_owner', projectId: 'publication_project' };
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'ownedpublications');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 3000 });
  store = new GeoStore({ database }); await store.ready();
  await seedGeoProject(database, { ...project, engines: ['deepseek'], groups: [], questions: [] });
  documents = new ProductDocuments(database);
  publications = new GeoOwnedPublications({ store, documents, now: () => new Date('2026-10-24T00:00Z') });
  await store.query(`INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,title,current_result_version_id,content_sha256) VALUES('publication-article',$1,$2,'Current article','v2',$3)`, [project.userId, project.id, '2'.repeat(64)]);
  for (const id of ['one', 'two', 'three']) await store.query(`INSERT INTO evimed_geo.owned_links(id,user_id,geo_project_id,url,url_key,platform,title,published_at,article_id,article_result_version_id,article_digest,created_at)
    VALUES($1,$2,$3,$4,$4,'brand_site',$1,'2026-10-01T00:00:00Z','publication-article','v1',$5,'2026-10-01T00:00:00.000123Z')`, [id, project.userId, project.id, `https://example.org/${id}`, '1'.repeat(64)]);
});
after(async () => { await database?.close(); await isolated?.drop(); });
const update = (requestKey, extra = {}) => ({ requestKey, expectedRevision: 0, expectedResultVersionId: 'v1', expectedDigest: '1'.repeat(64), resultVersionId: 'v2', digest: '2'.repeat(64), publishedAt: '2026-10-23T00:00:00Z', ...extra });

test('owned publication pages preserve complete counts, timestamp ties, version state and project ownership', options, async () => {
  const first = await publications.list(project, { limit: 2 }); assert.equal(first.total, 3); assert.equal(first.items.length, 2);
  assert.ok(first.items.every(row => row.versionState === 'update_needed' && row.articleResultVersionId === 'v1'));
  const next = await publications.list(project, { limit: 2, cursor: first.nextCursor });
  assert.equal(new Set([...first.items, ...next.items].map(row => row.id)).size, 3); assert.equal(next.nextCursor, null);
  assert.equal((await publications.list({ ...project, userId: 'other' })).total, 0);
  await assert.rejects(publications.detail({ ...project, userId: 'other' }, 'one'), { status: 404 });
});
test('explicit online update preserves the earlier pin and records one new receipt on duplicate transport retries', options, async () => {
  const before = await publications.detail(project, 'one'); assert.equal(before.revision, 0);
  const input = update('first-update');
  const [saved, retry] = await Promise.all([publications.confirm(project, 'one', input), publications.confirm(project, 'one', input)]);
  assert.deepEqual(retry, saved); assert.equal(saved.basis, 'user_reported_update'); assert.equal(saved.resultVersionId, 'v2');
  const detail = await publications.detail(project, 'one'); assert.equal(detail.link.versionState, 'current');
  assert.deepEqual(detail.history.items.map(row => [row.basis, row.resultVersionId]), [['user_reported_update', 'v2'], ['legacy_record', 'v1']]);
  assert.equal(detail.history.items[1].publishedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(await publications.firstPublishedAt(project), '2026-10-01T00:00:00.000Z', 'the earlier publication is retained after its latest update');
  await assert.rejects(publications.confirm(project, 'one', { ...input, publishedAt: '2026-10-22' }), { status: 409 });
  await assert.rejects(publications.confirm(project, 'one', update('another-stale-update')), { status: 409 });
});

test('pasting a known page again retains its established article and never updates the publication pin', options, async () => {
  const row = { url: 'https://example.org/three', urlKey: 'https://example.org/three', platform: 'brand_site', title: 'Changed page title', publishedAt: '2026-10-23T00:00:00Z', articleId: null, groupId: null };
  await store.upsertOwnedLinks(project.userId, project.id, [row]);
  const detail = await publications.detail(project, 'three');
  assert.equal(detail.link.articleId, 'publication-article'); assert.equal(detail.link.articleResultVersionId, 'v1'); assert.equal(detail.revision, 0);
  assert.equal(detail.link.publishedAt, '2026-10-01T00:00:00.000Z');
  await store.query(`INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,title,current_result_version_id,content_sha256) VALUES('other-article',$1,$2,'Another article','other-version',$3)`, [project.userId, project.id, 'a'.repeat(64)]);
  await assert.rejects(store.upsertOwnedLinks(project.userId, project.id, [{ ...row, articleId: 'other-article' }]), { status: 409, code: 'geo_owned_link_invalid' });
  assert.equal((await publications.detail(project, 'three')).link.articleId, 'publication-article');
});

test('a single page preserves its original publication date through repaste and an explicit later version update', options, async () => {
  const only = { ...project, id: 'single_publication_geo', projectId: 'single_publication_project' };
  await seedGeoProject(database, { ...only, engines: ['deepseek'], groups: [], questions: [] });
  await store.query(`INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,title,current_result_version_id,content_sha256) VALUES('single-article',$1,$2,'Single article','v1',$3)`, [only.userId, only.id, '1'.repeat(64)]);
  const initial = { url: 'https://example.org/only', urlKey: 'example.org/only', platform: 'brand_site', title: 'Only page', publishedAt: '2026-10-01T00:00:00Z', articleId: 'single-article', groupId: null };
  const [id] = await store.upsertOwnedLinks(only.userId, only.id, [initial]);
  await store.query("UPDATE evimed_geo.articles SET current_result_version_id='v2',content_sha256=$1 WHERE id='single-article'", ['2'.repeat(64)]);
  await store.upsertOwnedLinks(only.userId, only.id, [{ ...initial, publishedAt: '2026-10-23T00:00:00Z' }]);
  assert.equal((await publications.detail(only, id)).link.publishedAt, '2026-10-01T00:00:00.000Z');
  await publications.confirm(only, id, update('single-explicit-update'));
  const result = await publications.detail(only, id);
  assert.deepEqual(result.history.items.map(item => [item.resultVersionId, item.publishedAt]), [['v2', '2026-10-23T00:00:00.000Z'], ['v1', '2026-10-01T00:00:00.000Z']]);
  assert.equal(await publications.firstPublishedAt(only), '2026-10-01T00:00:00.000Z');
  const { GeoService } = await import('../src/geoService.mjs');
  const service = new GeoService({ store, documents, config: { geoEnabled: true, geoAudience: 'all' } });
  assert.equal((await service.distribution({ id: only.userId }, only.id)).firstPublishedAt, '2026-10-01T00:00:00.000Z', 'no other page or order masks the original date');
});
test('a newer article and a failed receipt cannot leave an unrecorded online version update', options, async () => {
  await assert.rejects(publications.confirm(project, 'two', update('stale-draft', { resultVersionId: 'v3', digest: '3'.repeat(64) })), { code: 'geo_article_head_changed' });
  const put = documents.put.bind(documents); let calls = 0;
  documents.put = async (...args) => { if (++calls === 2) throw new Error('receipt storage failed'); return put(...args); };
  try { await assert.rejects(publications.confirm(project, 'two', update('failed-receipt')), /receipt storage failed/); }
  finally { documents.put = put; }
  const detail = await publications.detail(project, 'two'); assert.equal(detail.revision, 0); assert.equal(detail.link.articleResultVersionId, 'v1');
  await assert.rejects(publications.confirm(project, 'two', update('future-update', { publishedAt: '2027-01-01' })), { status: 400 });
  assert.equal((await store.query('SELECT count(*)::integer AS n FROM evimed_geo.orders WHERE geo_project_id=$1', [project.id])).rows[0].n, 0, 'recording a publication never places an order');
});
