import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PostgresStore } from '../src/store.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoSharedContext } from '../src/geoSharedContext.mjs';
import { loadConfig } from '../src/config.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
async function setup(t) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'geocontext');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geo-context-'));
  const accounts = new PostgresStore(loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', databasePoolMax: 1 }));
  t.after(async () => { await accounts.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  for (const id of ['owner', 'editor']) await accounts.createUser(id, 'local-fixture-password', id);
  const owner = await accounts.userById('owner'), editor = await accounts.userById('editor');
  const project = await accounts.requireProject(owner, 'default'), personal = await accounts.requireProject(editor, 'default');
  const geoStore = new GeoStore({ database: accounts.database }); await geoStore.ready();
  const geo = await geoStore.createProject({ userId: owner.id, projectId: project.id, engines: ['deepseek'], coverageDays: 30 });
  const documents = new ProductDocuments(accounts.database), policies = new GeoSharedContext({ database: accounts.database, documents });
  return { accounts, documents, policies, geoStore, owner, editor, project, personal, geo };
}

test('GEO context registers one persistent project floor before an editor or input exists', options, async t => {
  const f = await setup(t);
  const [first, parallel] = await Promise.all([f.policies.forProject(f.project), f.policies.forWorkload({ userId: f.owner.id, projectId: f.project.id })]);
  assert.deepEqual(first, parallel);
  assert.equal(first.kind, 'geo-project'); assert.equal(first.geoProjectId, f.geo.id);
  assert.equal(first.namespace.ownerId, f.owner.id);
  assert.deepEqual(await f.policies.namespacesForOwner(f.owner.id), [first.namespace]);
  const normal = await f.policies.forProject(f.personal);
  assert.deepEqual(normal, { kind: 'owned', ownerId: f.editor.id, controlProjectId: f.personal.id });
  assert.equal((await f.documents.list(f.owner.id, 'geo-plan-context', { filter: { recordType: 'geo-native-context-policy' } })).items.length, 1);
  await f.geoStore.addMember({ geoId: f.geo.id, userId: f.editor.id, role: 'editor', invitedBy: f.owner.id });
  assert.deepEqual(await f.policies.forProject(f.project), first);
  await f.geoStore.removeMember({ geoId: f.geo.id, userId: f.editor.id, role: 'editor' });
  await f.accounts.database.query('UPDATE evimed_geo.projects SET deleted_at=clock_timestamp() WHERE id=$1', [f.geo.id]);
  assert.deepEqual(await f.policies.forProject(f.project), first, 'deleting the GEO row or last editor cannot expose personal context to an old workspace');
});

test('invalid durable project policy fails closed and cannot be treated as an ordinary owner project', options, async t => {
  const f = await setup(t); const policy = await f.policies.forProject(f.project);
  const saved = await f.documents.get(f.owner.id, 'geo-plan-context', policy.referenceId);
  await f.documents.put(f.owner.id, 'geo-plan-context', saved.id, { ...saved.payload, namespace: { ...saved.payload.namespace, engineUser: 'foreign' } }, { expectedRevision: saved.revision, projectId: f.project.id });
  await assert.rejects(f.policies.forProject(f.project), error => error.code === 'memory_scope_denied');
  await assert.rejects(f.policies.namespacesForOwner(f.owner.id), error => error.code === 'memory_scope_denied');
});

test('namespace selection uses exact current database incarnations and supports a single connection admission', options, async t => {
  const f = await setup(t); const first = await f.policies.forProject(f.project);
  await f.accounts.database.transaction(client => f.accounts.database.withTransactionClient(client, async () => {
    assert.deepEqual(await f.policies.forWorkload({ userId: f.owner.id, projectId: f.project.id }), first);
  }));
  await f.accounts.database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id=$2", [f.owner.id, f.project.id]);
  const replacement = await f.policies.forProject(f.project);
  assert.notEqual(replacement.namespace.id, first.namespace.id);
  assert.notEqual(replacement.referenceId, first.referenceId);
  const namespaces = await f.policies.namespacesForOwner(f.owner.id);
  assert.equal(namespaces.length, 2, 'historical namespaces remain enumerable for owner export and lifecycle cleanup');
  await assert.rejects(f.policies.forWorkload({ userId: 'unknown', projectId: f.project.id }), error => error.code === 'memory_scope_denied');
});

test('a removed policy cannot silently restore personal context, and account reuse cannot enumerate previous memory', options, async t => {
  const f = await setup(t); const first = await f.policies.forProject(f.project);
  await f.documents.remove(f.owner.id, 'geo-plan-context', first.referenceId, first.revision);
  await f.accounts.database.query('DELETE FROM evimed_geo.projects WHERE id=$1', [f.geo.id]);
  await assert.rejects(f.policies.forProject(f.project), error => error.code === 'memory_scope_denied');
  await f.documents.restore(f.owner.id, 'geo-plan-context', first.referenceId, first.revision + 1);
  await f.accounts.database.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id=$1", [f.owner.id]);
  assert.deepEqual(await f.policies.namespacesForOwner(f.owner.id), []);
});
