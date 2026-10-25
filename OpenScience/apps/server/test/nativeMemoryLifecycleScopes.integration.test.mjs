import test from 'node:test';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PostgresStore } from '../src/store.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoSharedContext } from '../src/geoSharedContext.mjs';
import { GeoNativeMemoryContext } from '../src/geoNativeMemoryContext.mjs';
import { NativeMemoryOverlay } from '../src/nativeMemoryOverlay.mjs';
import { NativeMemoryStore } from '../src/nativeMemoryStore.mjs';
import { OpenVikingSessions } from '../src/openVikingSessions.mjs';
import { OpenVikingClient } from '../src/openVikingClient.mjs';
import { loadConfig } from '../src/config.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { startOpenVikingStub } from './helpers/openVikingStub.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
async function fixture(t) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'nativelifecycle');
  let accounts, dataDir;
  t.after(async () => { await accounts?.database.close(); await isolated.drop(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'native-lifecycle-'));
  accounts = new PostgresStore(loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', databasePoolMax: 2 }));
  await accounts.createUser('owner', 'fixture-password', 'Owner'); const owner = await accounts.userById('owner');
  await accounts.createProject(owner, 'project-b', 'B');
  const projects = [await accounts.requireProject(owner, 'default'), await accounts.requireProject(owner, 'project-b')];
  const geo = new GeoStore({ database: accounts.database }); await geo.ready();
  // A shared GEO project: one with a member (a one-person GEO project is an owned project, owner ruling 2026-10-25).
  for (const project of projects) await geo.addMember({ geoId: (await geo.createProject({ userId: owner.id, projectId: project.id, engines: ['deepseek'], coverageDays: 30 })).id, userId: 'member', role: 'editor', invitedBy: owner.id });
  const stub = await startOpenVikingStub(t);
  const sessions = new OpenVikingSessions(new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: 'evimed' }));
  const documents = new ProductDocuments(accounts.database), policies = new GeoSharedContext({ database: accounts.database, documents });
  const contexts = new GeoNativeMemoryContext({ database: accounts.database, documents, policies, sessions });
  const a = await contexts.forProject(projects[0]), b = await contexts.forProject(projects[1]);
  const personal = (await contexts.all(owner.id))[0], overlay = new NativeMemoryOverlay({ database: accounts.database });
  await overlay.migrate();
  for (const context of [a, b]) await contexts.configure(context);
  await sessions.register(owner.id);
  const store = new NativeMemoryStore({ sessions, overlay, memoryContexts: contexts });
  const seed = (context, relPath, body, tags = []) => stub.seedMemory(context.namespaceId, relPath, body, { tags });
  return { accounts, owner, projects, contexts, a, b, personal, overlay, sessions, store, stub, seed };
}

async function seedScope(f, context, text) {
  const user = f.owner.id, uri = f.seed(context, 'project_facts/item.md', text);
  await f.overlay.upsertFile({ userId: user, uri, memoryType: 'project_facts', projectId: context.projectId, body: text });
  await context.sessions.createSession(user, 'dsh-shared');
  await context.sessions.addMessage(user, 'dsh-shared', { role: 'user', content: text });
  const archive = (await context.sessions.commit(user, 'dsh-shared')).result.archive_uri;
  await f.overlay.recordCommit({ userId: user, archiveUri: archive, engineSession: 'dsh-shared', projectId: context.projectId, origin: 'page' });
  return { uri, archive };
}

test('reset deletes files and equal session names in all registered views before purging shared overlay', options, async t => {
  const f = await fixture(t), rows = [];
  for (const context of [f.personal, f.a, f.b]) rows.push(await seedScope(f, context, context.namespaceId));
  await f.store.reset(f.owner.id);
  for (const [index, context] of [f.personal, f.a, f.b].entries()) {
    assert.equal(await context.sessions.read(f.owner.id, rows[index].uri), null);
    await assert.rejects(context.sessions.readSession(f.owner.id, 'dsh-shared'), error => error.code === 'memory_index_not_found');
  }
  assert.equal((await f.overlay.files(f.owner.id)).size, 0);
  assert.equal((await f.overlay.pendingCommits(f.owner.id)).length, 0);
  assert.equal((await f.contexts.all(f.owner.id)).length, 3, 'reset keeps the project context floor');
});

test('a failed session deletion keeps overlay discovery and retry completes the reset', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  const row = await seedScope(f, f.a, 'Remember this');
  const request = f.sessions.rootClient.request.bind(f.sessions.rootClient);
  let fail = true;
  f.sessions.rootClient.request = async input => {
    if (fail && input.method === 'DELETE' && input.path === '/api/v1/sessions/dsh-shared' && input.openVikingUser === f.a.namespaceId) throw new Error('Session deletion interrupted');
    return request(input);
  };
  await assert.rejects(f.store.reset(user), /Session deletion interrupted/);
  assert.ok(await f.overlay.commit(user, row.archive));
  fail = false; await f.store.reset(user);
  assert.equal(await f.overlay.commit(user, row.archive), null);
});

test('project deletion snapshots exact registered incarnations and does not touch another project with an equal session id', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  const old = await seedScope(f, f.a, 'Historical A'), other = await seedScope(f, f.b, 'B');
  const personal = await seedScope(f, f.personal, 'Personal');
  await f.accounts.database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id=$2", [user, f.a.projectId]);
  const current = await f.contexts.forProject({ userId: user, id: f.a.projectId });
  await f.contexts.configure(current);
  const next = await seedScope(f, current, 'Current A');
  await f.store.deleteProject(user, f.a.projectId);
  for (const [context, row] of [[f.a, old], [current, next]]) {
    assert.equal(await context.sessions.read(user, row.uri), null);
    assert.equal(await f.overlay.commit(user, row.archive), null);
  }
  assert.equal(await f.b.sessions.read(user, other.uri), 'B');
  assert.equal(await f.personal.sessions.read(user, personal.uri), 'Personal');
  assert.ok(await f.overlay.commit(user, other.archive));
  assert.ok(await f.overlay.commit(user, personal.archive));
  assert.ok((await f.contexts.all(user)).some(view => view.namespaceId === current.namespaceId), 'control-project cascade happens after native cleanup');
});

test('account export includes byte-exact upstream packs with exact registered namespace identities and refuses partial success', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  for (const context of [f.personal, f.a, f.b]) await seedScope(f, context, context.namespaceId);
  const request = f.sessions.rootClient.request.bind(f.sessions.rootClient), bytes = new Map();
  let fail = false;
  f.sessions.rootClient.request = async input => {
    if (input.path === '/api/v1/pack/export') {
      if (fail && input.openVikingUser === f.b.namespaceId) throw new Error('Project pack unavailable');
      const body = Buffer.from(`Original upstream pack: ${input.openVikingUser ?? f.personal.namespaceId}`);
      bytes.set(input.openVikingUser ?? f.personal.namespaceId, body);
      return { bytes: body };
    }
    return request(input);
  };
  const pack = unzipSync(await f.store.exportPack(user));
  const manifest = JSON.parse(Buffer.from(pack['manifest.json']).toString('utf8'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.packs.length, 3);
  for (const row of manifest.packs) {
    assert.deepEqual(Buffer.from(pack[row.path]), bytes.get(row.namespaceId));
    assert.equal(row.sha256, createHash('sha256').update(pack[row.path]).digest('hex'));
    assert.equal(row.bytes, pack[row.path].length);
  }
  const a = manifest.packs.find(row => row.namespaceId === f.a.namespaceId);
  assert.equal(a.projectId, f.a.projectId); assert.equal(a.policyRef, f.a.policyRef);
  fail = true; await assert.rejects(f.store.exportPack(user), /Project pack unavailable/);
});

test('pending account erasure blocks metadata deletion and retries all snapshotted namespaces', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  const row = await seedScope(f, f.a, 'A');
  const views = await f.contexts.all(user), erased = [];
  let pending = true;
  for (const view of views) view.sessions.eraseUser = async () => { erased.push(view.namespaceId); return { deleted: true, pending: pending && view.namespaceId === f.a.namespaceId }; };
  f.contexts.all = async () => views;
  await assert.rejects(f.store.eraseAccount(user), error => error.code === 'memory_engine_unavailable');
  assert.ok(await f.overlay.commit(user, row.archive));
  pending = false;
  assert.deepEqual(await f.store.eraseAccount(user), { deleted: true, pending: false });
  assert.equal(await f.overlay.commit(user, row.archive), null);
  assert.ok(erased.includes(f.b.namespaceId));
});

test('personal-only export retains exact bytes but still checks account incarnation and the same byte budget', options, async t => {
  const f = await fixture(t), user = f.owner.id, original = Buffer.from('PK-personal-original');
  f.contexts.all = async () => [f.personal];
  f.personal.sessions.exportPack = async () => original;
  assert.equal(await f.store.exportPack(user), original);
  f.personal.sessions.exportPack = async () => Buffer.alloc(128 * 1024 * 1024 + 1);
  await assert.rejects(f.store.exportPack(user), error => error.code === 'memory_export_too_large');
  let requested = false;
  f.personal.sessions.exportPack = async () => { requested = true; return original; };
  await f.accounts.database.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id=$1", [user]);
  await assert.rejects(f.store.exportPack(user), error => error.code === 'memory_scope_denied');
  assert.equal(requested, false);
});

test('project cleanup refuses a stale personal account view before touching its tagged memory or overlay', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  const uri = f.seed(f.personal, 'projects/card.md', 'Replacement-sensitive content', [`project=${f.a.projectId}`]);
  await f.overlay.upsertFile({ userId: user, uri, memoryType: 'project_context', projectId: f.a.projectId, body: 'Replacement-sensitive content' });
  f.contexts.all = async () => [f.personal];
  await f.accounts.database.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id=$1", [user]);
  const before = f.stub.requests.length;
  await assert.rejects(f.store.deleteProject(user, f.a.projectId), error => error.code === 'memory_scope_denied');
  assert.equal(f.stub.requests.length, before);
  assert.ok(await f.overlay.file(user, uri));
});

