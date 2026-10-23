import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoSourceOwnership } from '../src/geoSourceOwnership.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { seedGeoProject } from './helpers/geoMeasureFixtures.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost PostgreSQL database is required' };
let isolated, database, ownership;
const project = { id: 'ownership_geo', userId: 'ownership_owner', projectId: 'ownership_project', actorId: 'reviewer' };
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'ownership');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 3000 });
  await new GeoMeasureStore(database).ready();
  await seedGeoProject(database, { ...project, engines: ['deepseek'], groups: [], questions: [] });
  ownership = new GeoSourceOwnership({ documents: new ProductDocuments(database) });
});
after(async () => { await database?.close(); await isolated?.drop(); });
const target = (kind, value) => ({ kind, value });

test('reviewed page relationships override the exact domain and keep query-named pages distinct', options, async () => {
  await ownership.set(project, { target: target('domain', 'EXAMPLE.com'), relation: 'own', expectedRevision: 0 });
  const own = await ownership.set(project, { target: target('page', 'https://example.com/article?id=one#intro'), relation: 'competitor', expectedRevision: 0 });
  const rows = await ownership.resolve(project, ['https://example.com/article?id=one', 'https://example.com/article?id=two', 'https://child.example.com/article']);
  assert.deepEqual(rows.map(row => row.relation), ['competitor', 'own', 'unknown']);
  assert.equal(rows[0].reference.revision, own.revision); assert.equal(rows[0].origin, 'page');
  await ownership.set(project, { target: target('page', 'https://baijiahao.baidu.com/s?id=1'), relation: 'own', expectedRevision: 0 });
  const platform = await ownership.resolve(project, ['https://baijiahao.baidu.com/s?id=1', 'https://baijiahao.baidu.com/s?id=2']);
  assert.deepEqual(platform.map(row => row.relation), ['own', 'unknown']);
  assert.equal((await ownership.resolve({ ...project, userId: 'another_owner' }, ['https://example.com/article?id=one']))[0].relation, 'unknown');
});

test('a relationship correction uses CAS, preserves history, and retirement restores domain fallback', options, async () => {
  const selected = target('page', 'https://example.com/article?id=one');
  const initial = await ownership.read(project, selected);
  await assert.rejects(ownership.set(project, { target: selected, relation: 'partner', expectedRevision: 0 }), { code: 'product_revision_conflict' });
  const changed = await ownership.set(project, { target: selected, relation: 'unknown', expectedRevision: initial.revision, reason: 'Ownership is not established.' });
  assert.equal((await ownership.resolve(project, [selected.value]))[0].relation, 'unknown', 'an explicit unknown page annotation overrides the domain');
  const retired = await ownership.set(project, { target: selected, relation: 'unknown', expectedRevision: changed.revision, active: false });
  assert.equal(retired.active, false);
  assert.equal((await ownership.resolve(project, [selected.value]))[0].relation, 'own');
  const history = await ownership.history(project, selected);
  assert.deepEqual(history.items.map(row => row.relation), ['unknown', 'unknown', 'competitor']);
  assert.ok(history.items.every(row => !Object.hasOwn(row, 'actorId')));
});

test('ownership reads are project-bound; unsafe addresses and unsupported assertions are rejected', options, async () => {
  assert.equal(await ownership.read({ ...project, id: 'other_geo' }, target('domain', 'example.com')), null);
  for (const value of ['javascript:alert(1)', 'https://user:password@example.com/page']) {
    await assert.rejects(ownership.set(project, { target: target('page', value), relation: 'own', expectedRevision: 0 }), { code: 'geo_payload_invalid' });
  }
  await assert.rejects(ownership.set(project, { target: target('domain', 'example.com/path'), relation: 'own', expectedRevision: 0 }), { code: 'geo_payload_invalid' });
  await assert.rejects(ownership.set(project, { target: target('domain', 'example.net'), relation: 'platform_verified', expectedRevision: 0 }), { code: 'geo_payload_invalid' });
  assert.equal((await ownership.resolve(project, ['https://example.net/page']))[0].relation, 'unknown');
});

test('ordinary members may read annotations and execution, but only editors may change relationships', options, async () => {
  const { GeoStore } = await import('../src/geoStore.mjs');
  const { GeoService } = await import('../src/geoService.mjs');
  const { GeoMembers } = await import('../src/geoMembers.mjs');
  const store = new GeoStore({ database }); await store.ready();
  const members = new GeoMembers({ store });
  for (const role of ['viewer', 'editor']) {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$1,'development')", [`ownership_${role}`]);
    await members.add({ project, actorId: project.userId, userId: `ownership_${role}`, role });
  }
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: 'all' }, documents: new ProductDocuments(database) });
  const viewer = { id: 'ownership_viewer' }, editor = { id: 'ownership_editor' };
  const input = { target: target('domain', 'member.example'), relation: 'partner', expectedRevision: 0 };
  await assert.rejects(service.sourceOwnershipWrite(viewer, project.id, input), { status: 403 });
  const written = await service.sourceOwnershipWrite(editor, project.id, input); assert.equal(written.relation, 'partner');
  const read = await service.sourceOwnershipRead(viewer, project.id, { target: input.target }); assert.equal(read.current.revision, written.revision);
  assert.equal((await service.distributionOrders(viewer, project.id)).total, 0);
  assert.equal((await service.distributionLedger(viewer, project.id)).total, 0);
  await assert.rejects(service.sourceOwnershipRead({ id: 'outsider' }, project.id, { target: input.target }), { status: 404 });
  await assert.rejects(service.distributionLedger({ id: 'outsider' }, project.id), { status: 404 });
});
