import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { PostgresStore } from '../src/store.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { GeoNativeAuthority } from '../src/geoNativeAuthority.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };

async function setup(t) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'geonativeauth');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geo-native-authority-'));
  const config = loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', devAuth: true, geoEnabled: true, geoAudience: 'all' });
  const accounts = new PostgresStore(config);
  t.after(async () => { await accounts.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  for (const id of ['owner', 'editor', 'viewer', 'reviewer']) await accounts.createUser(id, 'local-fixture-password', id);
  const users = Object.fromEntries(await Promise.all(['owner', 'editor', 'viewer', 'reviewer'].map(async id => [id, await accounts.userById(id)])));
  const control = await accounts.requireProject(users.owner, 'default'), personal = await accounts.requireProject(users.editor, 'default');
  const store = new GeoStore({ database: accounts.database }); await store.ready();
  const geo = await store.createProject({ userId: users.owner.id, projectId: control.id, engines: ['deepseek'], coverageDays: 90 });
  for (const [id, role] of [['editor', 'editor'], ['viewer', 'viewer'], ['reviewer', 'medical_reviewer']]) await store.addMember({ geoId: geo.id, userId: id, role, invitedBy: users.owner.id });
  const documents = new ProductDocuments(accounts.database), service = new GeoService({ store, config });
  const calls = [], runs = [];
  const authority = new GeoNativeAuthority({ store, accounts, service, documents,
    results: { scope: async () => { throw Object.assign(new Error('No bound proof'), { status: 404 }); } },
    runs: async () => runs,
    createSession: async project => { calls.push(['create', project.userId, project.id]); return { id: 'server-created-session' }; },
    ensureSession: async (project, sessionId) => { calls.push(['ensure', project.userId, project.id, sessionId]); },
  });
  return { accounts, store, documents, service, users, control, personal, geo, authority, calls, runs };
}

test('shared native authority derives the owner despite an equal personal project id and rejects non-run roles', options, async t => {
  const f = await setup(t);
  await f.authority.registerPrimary(f.geo, 'shared-root');
  const scope = { kind: 'geo', geoProjectId: f.geo.id, sessionId: 'shared-root' };
  const resolved = await f.authority.resolve(f.users.editor, scope);
  assert.equal(resolved.project.id, f.personal.id); assert.notEqual(resolved.project.userId, f.personal.userId);
  assert.equal(resolved.project.userId, f.users.owner.id); assert.equal(resolved.principal.actorId, f.users.editor.id);
  assert.ok(resolved.principal.membershipEpoch);
  assert.equal((await f.authority.resolve(f.users.owner, scope)).principal.membershipEpoch, null);
  for (const user of [f.users.viewer, f.users.reviewer]) await assert.rejects(f.authority.resolve(user, scope), error => error.status === 403);
  await assert.rejects(f.authority.resolve({ id: 'stranger' }, scope), error => error.status === 404);
  await assert.rejects(f.authority.resolve(f.users.editor, { ...scope, ownerId: 'editor' }), error => error.status === 404);
  const readOnly = await f.authority.identity(f.users.viewer, f.geo.id, { ability: 'read' });
  assert.equal(await f.authority.primary(readOnly), 'shared-root'); assert.equal(f.calls.length, 0);
  await assert.rejects(f.authority.resolve(f.users.editor, { ...scope, sessionId: 'ordinary-owner-chat' }), error => error.status === 404);
  f.runs.push({ id: 'background', sessionId: 'background-step' });
  f.authority.results.scope = async () => ({ context: null });
  await assert.rejects(f.authority.resolve(f.users.editor, { ...scope, sessionId: 'background-step' }), error => error.status === 404);
});

test('membership revoke and re-add never revive old authority; other scope or account incarnation also fails', options, async t => {
  const f = await setup(t); await f.authority.registerPrimary(f.geo, 'shared-root');
  const scope = { kind: 'geo', geoProjectId: f.geo.id, sessionId: 'shared-root' };
  const first = await f.authority.resolve(f.users.editor, scope);
  await f.store.removeMember({ geoId: f.geo.id, userId: f.users.editor.id, role: 'editor' });
  await assert.rejects(f.authority.resolve(f.users.editor, scope, { claims: first.principal }), error => [403, 404].includes(error.status));
  await f.store.addMember({ geoId: f.geo.id, userId: f.users.editor.id, role: 'editor', invitedBy: f.users.owner.id });
  const fresh = await f.authority.resolve(f.users.editor, scope);
  assert.notEqual(fresh.principal.membershipEpoch, first.principal.membershipEpoch);
  await assert.rejects(f.authority.resolve(f.users.editor, scope, { claims: first.principal }), error => error.status === 403);
  await assert.rejects(f.authority.resolve(f.users.editor, scope, { claims: { ...fresh.principal, actorCreatedAt: 'recreated' } }), error => error.status === 403);
  f.service.config.geoEnabled = false;
  await assert.rejects(f.authority.resolve(f.users.editor, scope), error => error.status === 404);
});

test('opening a legacy primary initializes once without adopting an arbitrary owner conversation', options, async t => {
  const f = await setup(t);
  assert.equal(await f.authority.primary(await f.authority.identity(f.users.editor, f.geo.id)), null);
  await assert.rejects(f.authority.descriptor(f.users.editor, f.geo.id, { kind: 'session', sessionId: 'ordinary-chat' }), error => error.status === 404);
  const values = await Promise.all([f.authority.descriptor(f.users.editor, f.geo.id, { kind: 'primary' }), f.authority.descriptor(f.users.editor, f.geo.id, { kind: 'primary' })]);
  assert.deepEqual(values[0], values[1]); assert.equal(values[0].scope.geoProjectId, f.geo.id);
  assert.equal(values[0].sessionId, 'server-created-session');
  assert.equal(f.calls.filter(([kind]) => kind === 'create').length, 1);
  assert.ok(f.calls.every(([, owner, project]) => owner === f.users.owner.id && project === f.control.id));
  assert.equal((await f.documents.list(f.users.owner.id, 'geo-plan-context', { projectId: f.control.id })).items.length, 2);
});

test('an admitted frame holds current membership through its existing transaction', options, async t => {
  const f = await setup(t); await f.authority.registerPrimary(f.geo, 'shared-root');
  const { principal } = await f.authority.resolve(f.users.editor, { kind: 'geo', geoProjectId: f.geo.id, sessionId: 'shared-root' });
  await f.authority.withFrame(f.users.editor, principal, async resolved => {
    assert.equal(resolved.project.userId, f.users.owner.id);
    const client = await f.accounts.database.pool.connect();
    try {
      await client.query("SET statement_timeout='50ms'");
      await assert.rejects(client.query("DELETE FROM evimed_geo.members WHERE geo_project_id=$1 AND user_id='editor'", [f.geo.id]), error => error.code === '57014');
    } finally { await client.query('RESET statement_timeout'); client.release(); }
  });
  assert.equal(await f.store.removeMember({ geoId: f.geo.id, userId: f.users.editor.id, role: 'editor' }), true);
  await assert.rejects(f.authority.withFrame(f.users.editor, principal, () => { throw new Error('Must not enter'); }), error => [403, 404].includes(error.status));
});
