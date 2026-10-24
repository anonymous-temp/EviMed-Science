import test from 'node:test';
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
import { NativeMemoryStore, nativeFileId } from '../src/nativeMemoryStore.mjs';
import { OpenVikingSessions } from '../src/openVikingSessions.mjs';
import { OpenVikingClient } from '../src/openVikingClient.mjs';
import { loadConfig } from '../src/config.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { startOpenVikingStub } from './helpers/openVikingStub.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
async function fixture(t) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'nativestorescopes');
  let accounts, dataDir;
  t.after(async () => { await accounts?.database.close(); await isolated.drop(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'native-store-scopes-'));
  accounts = new PostgresStore(loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', databasePoolMax: 2 }));
  await accounts.createUser('owner', 'fixture-password', 'Owner'); const owner = await accounts.userById('owner');
  await accounts.createProject(owner, 'project-b', 'B');
  const projects = [await accounts.requireProject(owner, 'default'), await accounts.requireProject(owner, 'project-b')];
  const geo = new GeoStore({ database: accounts.database }); await geo.ready();
  for (const project of projects) await geo.createProject({ userId: owner.id, projectId: project.id, engines: ['deepseek'], coverageDays: 30 });
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

test('the owner page includes registered namespaces while project views use their real namespace rather than tags', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  f.seed(f.personal, 'preferences/tone.md', 'Personal tone');
  f.seed(f.personal, 'projects/mixed.md', '# Mixed\n## Goal\n- Private merged context', [`project=${f.a.projectId}`]);
  const aUri = f.seed(f.a, 'entities/product.md', 'A product', [`project=${f.b.projectId}`]);
  f.seed(f.a, 'projects/card.md', '# A\n## Goal\n- Scoped goal');
  f.seed(f.a, 'preferences/illegal.md', 'Never shared');
  f.seed(f.b, 'entities/product.md', 'B product');
  const records = await f.store.records(user);
  assert.equal(records.length, 5);
  assert.equal(records.find(row => row.uri === aUri).scope, 'project');
  assert.equal(records.find(row => row.uri === aUri).scopeId, f.a.projectId);
  assert.equal((await f.store.projectCard(user, f.a.projectId))[0].text, 'Scoped goal');
  const timeline = await f.store.timelineRecords(user, { projectId: f.a.projectId });
  assert.deepEqual(timeline.map(row => row.value).sort(), ['# A\n## Goal\n- Scoped goal', 'A product'].sort());
  assert.equal((await f.store.listRecords(user, { scopes: ['project'], scopeId: f.a.projectId })).length, 2);
  for (const request of f.stub.sent('GET', '/api/v1/content/read')) assert.ok(request.query.uri.startsWith(`viking://user/${request.user}/`));
});

test('edit forget undo and rejection history use the file namespace even with equal text in other projects', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  const text = 'Original project statement';
  const uri = f.seed(f.a, 'entities/item.md', text), other = f.seed(f.b, 'entities/item.md', text);
  const id = nativeFileId(uri), original = await f.store.getRecord(user, id);
  await f.store.update(user, id, { value: 'Edited statement', expectedVersion: original.version });
  assert.equal(await f.a.sessions.read(user, uri), 'Edited statement');
  assert.equal(await f.b.sessions.read(user, other), text);
  assert.equal((await f.overlay.rejectedFingerprints(user, `${f.a.namespaceId}:entities`)).size, 1);
  assert.equal((await f.overlay.rejectedFingerprints(user, 'entities')).size, 0);
  const edited = await f.store.getRecord(user, id);
  await f.store.remove(user, id, { keepText: true });
  assert.equal(await f.a.sessions.read(user, uri), null);
  await f.store.undo(user, id, { expectedVersion: edited.version });
  assert.equal(await f.a.sessions.read(user, uri), 'Edited statement');
  assert.equal((await f.store.getRecord(user, id)).scopeId, f.a.projectId);
  assert.equal((await f.overlay.rejectedFingerprints(user, `${f.b.namespaceId}:entities`)).size, 0);
  assert.equal((await f.overlay.file(user, uri)).projectId, f.a.projectId);
});

test('conversation forget checks its supplied namespace before any account file lookup or engine request', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  const a = f.seed(f.a, 'project_facts/item.md', 'A'), b = f.seed(f.b, 'project_facts/item.md', 'B');
  const personal = f.seed(f.personal, 'project_facts/item.md', 'Private');
  const count = f.stub.requests.length;
  for (const uri of [b, personal]) await assert.rejects(f.store.forget(f.owner, f.projects[0], uri, { context: f.a }), error => error.code === 'memory_scope_denied');
  assert.equal(f.stub.requests.length, count);
  assert.deepEqual(await f.store.forget(f.owner, f.projects[0], a, { context: f.a }), { removed: true });
  assert.equal(await f.b.sessions.read(user, b), 'B');
  assert.equal(await f.personal.sessions.read(user, personal), 'Private');
});

test('page remember registers an internal session in the selected namespace and never the legacy session table', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  const result = await f.store.remember(user, { text: 'Use concise project summaries.', projectId: f.a.projectId });
  assert.ok(result.pending.id.startsWith(`${f.a.userRoot}/sessions/evimed-page-`));
  const commit = await f.overlay.commit(user, result.pending.id);
  assert.equal(commit.projectId, f.a.projectId);
  assert.deepEqual((await f.contexts.session(f.a, commit.engineSession)).payload.source, { kind: 'page', operationRef: commit.engineSession });
  assert.equal(await f.overlay.projectOfSession(user, commit.engineSession), null);
  for (const request of f.stub.sent('POST', '/api/v1/sessions')) assert.equal(request.user, f.a.namespaceId);
});

test('session changes are root-filtered before limit and project identity is namespace-derived', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  for (const context of [f.a, f.b, f.personal]) {
    const uri = f.seed(context, 'entities/item.md', context.namespaceId);
    await f.overlay.upsertFile({ userId: user, uri, memoryType: 'entities', body: context.namespaceId, projectId: 'wrong-tag' });
    await f.overlay.addRevision({ userId: user, uri, memoryType: 'entities', actor: 'engine', change: 'added', before: null, after: context.namespaceId,
      engineSession: 'dsh-same', projectId: 'wrong-tag' });
  }
  const scoped = await f.store.changes(user, { projectId: f.a.projectId, sessionId: 'same', limit: 1 });
  assert.equal(scoped.length, 1); assert.equal(scoped[0].summary, f.a.namespaceId); assert.equal(scoped[0].scopeId, f.a.projectId);
  assert.equal((await f.store.changes(user, { sessionId: 'same' }))[0].summary, f.personal.namespaceId);
  assert.equal((await f.store.changes(user)).length, 3);
});

test('wrong namespace commit responses are refused before entering the page ledger', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  const original = f.a.sessions.rootClient.request.bind(f.a.sessions.rootClient);
  f.a.sessions.rootClient.request = async input => input.path.endsWith('/commit')
    ? { result: { status: 'accepted', archive_uri: `${f.b.userRoot}/sessions/evimed-page-foreign/history/archive_001` } } : original(input);
  await assert.rejects(f.store.remember(user, { text: 'A fact', projectId: f.a.projectId }), error => error.code === 'memory_scope_denied');
  assert.equal((await f.overlay.pendingCommits(user)).length, 0);
});

test('pause and resume cover registered historical namespaces without restoring excluded memory types', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  await f.store.setLearning(user, false);
  for (const context of [f.personal, f.a, f.b]) assert.equal((await context.sessions.settings(user)).learning, false);
  await f.store.setLearning(user, true);
  for (const context of [f.a, f.b]) {
    const settings = await context.sessions.settings(user);
    assert.equal(settings.learning, true); assert.equal(settings.memoryTypes.length, 6);
    assert.equal(settings.memoryTypes.includes('profile'), false);
  }
});

test('a registered but unused namespace has an empty readable page and initialization preserves an existing pause', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  await f.accounts.createProject(f.owner, 'new-project', 'New');
  const geo = new GeoStore({ database: f.accounts.database });
  await geo.createProject({ userId: user, projectId: 'new-project', engines: ['deepseek'], coverageDays: 30 });
  const context = await f.contexts.forProject({ userId: user, id: 'new-project' });
  assert.deepEqual(await f.store.files(user, { context }), []);
  await f.contexts.configure(context, { learning: false });
  assert.deepEqual(await f.store.files(user, { context }), []);
  assert.equal((await context.sessions.settings(user)).learning, false);
});

test('a noncanonical accepted archive never becomes a permanently pending page record', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  const request = f.sessions.rootClient.request.bind(f.sessions.rootClient);
  f.sessions.rootClient.request = async input => {
    const answer = await request(input);
    if (input.path.endsWith('/commit') && answer.result?.archive_uri) answer.result.archive_uri += '/';
    return answer;
  };
  await assert.rejects(f.store.remember(user, { text: 'A fact', projectId: f.a.projectId }), error => error.code === 'memory_scope_denied');
  assert.equal((await f.overlay.pendingCommits(user)).length, 0);
});
