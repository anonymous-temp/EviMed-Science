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
import { NativeMemoryStore, nativeFileId, nativeConversationTitleKey } from '../src/nativeMemoryStore.mjs';
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
  await accounts.createUser('editor', 'fixture-password', 'Editor');
  await accounts.createProject(owner, 'project-b', 'B'); await accounts.createProject(owner, 'solo', 'Solo');
  const projects = [await accounts.requireProject(owner, 'default'), await accounts.requireProject(owner, 'project-b')];
  const geo = new GeoStore({ database: accounts.database }); await geo.ready();
  // Two shared GEO projects (a member each) and one the owner works in alone.
  for (const project of projects) {
    const row = await geo.createProject({ userId: owner.id, projectId: project.id, engines: ['deepseek'], coverageDays: 30 });
    await geo.addMember({ geoId: row.id, userId: 'editor', role: 'editor', invitedBy: owner.id });
  }
  const solo = await accounts.requireProject(owner, 'solo');
  const soloGeo = await geo.createProject({ userId: owner.id, projectId: solo.id, engines: ['deepseek'], coverageDays: 30 });
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
  return { accounts, owner, projects, contexts, a, b, personal, overlay, sessions, store, stub, seed, geo, solo, soloGeo, documents, policies };
}

test('a one-person GEO project keeps the owner\'s own memory: its card, records, rejections and resident profile are the account\'s', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  const context = await f.contexts.forProject(f.solo);
  assert.equal(context.kind, 'owned'); assert.equal(context.namespaceId, f.personal.namespaceId);
  assert.equal(context.projectId, f.solo.id, 'the project is a label on the owner\'s own memory');
  // Written before v3 in the person's own memory with the project's tag: still the project's card and records.
  f.seed(f.personal, 'projects/solo.md', '# Solo\n## Goal\n- Owner goal', [`project=${f.solo.id}`]);
  const uri = f.seed(f.personal, 'project_facts/item.md', 'Owner statement', [`project=${f.solo.id}`]);
  f.seed(f.personal, 'profile.md', 'Owner profile');
  assert.equal((await f.store.projectCard(user, f.solo.id))[0].text, 'Owner goal');
  assert.equal((await f.store.listRecords(user, { scopes: ['project'], scopeId: f.solo.id })).length, 2);
  // A correction there is the account's own rejection, as in any project of theirs.
  const id = nativeFileId(uri), original = await f.store.getRecord(user, id);
  await f.store.update(user, id, { value: 'Edited statement', expectedVersion: original.version });
  assert.equal((await f.overlay.rejectedFingerprints(user, 'project_facts')).size, 1);
  for (const namespace of [f.a.namespaceId, f.b.namespaceId]) assert.equal((await f.overlay.rejectedFingerprints(user, `${namespace}:project_facts`)).size, 0);
  // The resident block carries the capsule's profile facts and the card, as for an owned project.
  const { ResidentProfiles } = await import('../src/residentProfile.mjs');
  const profiles = new ResidentProfiles({ config: { memoryResidentCardTimeoutMs: 30_000 }, store: { memoryEngine: async () => 'native' }, contextPolicies: f.policies,
    capsules: { profileFacts: async () => [{ id: 'f1', factKind: 'profile', content: 'Owner capsule profile', updatedAt: '2026-10-01T00:00:00Z', origin: 'explicit' }] },
    projectCard: (owner, projectId) => f.store.projectCard(owner, projectId) });
  const block = await profiles.forDispatch(user, { projectId: f.solo.id, attended: true });
  assert.match(block.text, /Owner capsule profile/); assert.match(block.text, /Owner goal/);
  // The first member makes it a shared project; the owner's earlier memory stays theirs and is not the project's.
  await f.geo.addMember({ geoId: f.soloGeo.id, userId: 'editor', role: 'editor', invitedBy: user });
  const shared = await f.contexts.forProject(f.solo);
  assert.equal(shared.kind, 'geo-project'); assert.notEqual(shared.namespaceId, f.personal.namespaceId);
  assert.doesNotMatch((await profiles.forDispatch(user, { projectId: f.solo.id, attended: true })).text, /Owner capsule profile/);
  await f.geo.removeMember({ geoId: f.soloGeo.id, userId: 'editor', role: 'editor' });
  assert.equal((await f.contexts.forProject(f.solo)).namespaceId, f.personal.namespaceId);
  assert.ok((await f.contexts.all(user)).some(item => item.namespaceId === shared.namespaceId), 'what the shared project kept stays on the owner\'s page');
});

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

test('the forgotten page restores a project file through its namespace and preserves equal rejections elsewhere', options, async t => {
  const f = await fixture(t), user = f.owner.id, text = 'A project-specific fact';
  const a = f.seed(f.a, 'entities/item.md', text), b = f.seed(f.b, 'entities/item.md', text);
  await f.store.remove(user, nativeFileId(a), { keepText: true });
  await f.overlay.reject(user, `${f.b.namespaceId}:entities`, b, [text]);
  const [forgotten] = await f.store.forgotten(user);
  assert.equal(forgotten.uri, a); assert.equal(forgotten.scope, 'project'); assert.equal(forgotten.scopeId, f.a.projectId);
  const restored = await f.store.update(user, forgotten.id, { status: 'active', expectedVersion: forgotten.version });
  assert.equal(restored.uri, a); assert.equal(restored.scopeId, f.a.projectId);
  assert.equal(await f.a.sessions.read(user, a), text); assert.equal(await f.b.sessions.read(user, b), text);
  assert.equal((await f.overlay.rejectedFingerprints(user, `${f.a.namespaceId}:entities`)).size, 0);
  assert.equal((await f.overlay.rejectedFingerprints(user, `${f.b.namespaceId}:entities`)).size, 1);
  for (const request of f.stub.sent('POST', '/api/v1/content/write')) assert.ok(request.body.uri.startsWith(`viking://user/${request.user}/`));
});

test('equal session ids in personal and project namespaces retain their own conversation project identity', options, async t => {
  const f = await fixture(t), user = f.owner.id;
  await f.overlay.noteSession(user, 'dsh-same', 'personal-project');
  for (const context of [f.personal, f.a, f.b]) {
    const uri = f.seed(context, 'entities/provenance.md', context.namespaceId);
    await f.overlay.addRevision({ userId: user, uri, memoryType: 'entities', actor: 'engine', change: 'added', before: null, after: context.namespaceId,
      engineSession: 'dsh-same', projectId: 'wrong-tag', archiveUri: `${context.userRoot}/sessions/dsh-same/history/archive_001` });
  }
  const records = await f.store.records(user);
  for (const context of [f.a, f.b]) assert.equal(records.find(row => row.uri.startsWith(`${context.userRoot}/`)).evidence[0].projectId, context.projectId);
  assert.equal(records.find(row => row.uri.startsWith(`${f.personal.userRoot}/`)).evidence[0].projectId, 'personal-project');
});

async function seedConversationSource(f, context, text) {
  const uri = f.seed(context, 'project_facts/provenance.md', text);
  await f.overlay.addRevision({ userId: f.owner.id, uri, memoryType: 'project_facts', actor: 'engine', change: 'added', before: null, after: text,
    engineSession: 'dsh-shared', projectId: context.projectId, archiveUri: `${context.userRoot}/sessions/dsh-shared/history/archive_001` });
  return uri;
}

test('a bare resolver deletion for an ambiguous or isolated cache-miss session cannot remove another project source', options, async t => {
  const f = await fixture(t), user = f.owner.id, calls = [];
  const a = await seedConversationSource(f, f.a, 'Source A');
  f.store.conversationTitles = async (_user, refs) => {
    calls.push(refs);
    return Object.fromEntries(refs.map(ref => [ref.sessionId, ref.projectId === f.b.projectId ? null : 'A is live']));
  };
  const first = await f.store.profile(user);
  assert.deepEqual(first.conversations, { shared: 'A is live',
    [first.records.find(record => record.uri === a).evidence[0].conversationTitleKey]: 'A is live' }, 'the ordinary unambiguous callback remains supported');
  const b = await seedConversationSource(f, f.b, 'Source B');
  const page = await f.store.profile(user);
  assert.equal(calls[1].length, 1, 'only B missed the cache, but the complete request is ambiguous');
  assert.equal(page.records.find(record => record.uri === a).evidenceCount, 1);
  assert.equal(page.records.find(record => record.uri === b).evidenceCount, 1, 'an ambiguous bare answer is unknown, not proof of deletion');
  assert.equal(page.conversations.shared, undefined);
  const found = await f.store.search(user, '');
  assert.equal(found.items.find(record => record.uri === a).evidenceCount, 1);
  assert.equal(found.items.find(record => record.uri === b).evidenceCount, 1);
});

test('qualified title results keep equal project sessions distinct through profile search cache and deletion', options, async t => {
  const f = await fixture(t), user = f.owner.id, calls = [];
  const a = await seedConversationSource(f, f.a, 'Source A'), b = await seedConversationSource(f, f.b, 'Source B');
  let deleted = false;
  f.store.conversationTitles = async (_user, refs) => {
    calls.push(refs);
    return Object.fromEntries(refs.map(ref => [nativeConversationTitleKey(ref), ref.projectId === f.b.projectId ? deleted ? null : 'B title' : 'A title']));
  };
  const page = await f.store.profile(user);
  for (const [uri, title] of [[a, 'A title'], [b, 'B title']]) {
    const source = page.records.find(record => record.uri === uri).evidence[0];
    assert.equal(page.conversations[source.conversationTitleKey], title);
  }
  assert.equal(page.conversations.shared, undefined);
  for (const context of [f.a, f.b]) {
    const ref = calls[0].find(item => item.projectId === context.projectId);
    assert.equal(ref.namespaceId, context.namespaceId); assert.equal(ref.projectCreatedAt, context.policy.projectCreatedAt);
  }
  const found = await f.store.search(user, '');
  assert.equal(calls.length, 1, 'profile and both search enrichment passes reuse qualified cache entries');
  assert.equal(found.conversations[found.items.find(record => record.uri === a).evidence[0].conversationTitleKey], 'A title');
  deleted = true; f.store.now = () => new Date(Date.now() + 61_000);
  const after = await f.store.profile(user);
  assert.equal(after.records.find(record => record.uri === a).evidenceCount, 1);
  assert.equal(after.records.find(record => record.uri === b).evidenceCount, 0);
  const search = await f.store.search(user, '');
  assert.equal(search.items.find(record => record.uri === a).evidenceCount, 1);
  assert.equal(search.items.find(record => record.uri === b).evidenceCount, 0);
});

for (const mode of ['unknown', 'failed']) test(`a ${mode} title resolver preserves equal-id provenance without borrowing another title`, options, async t => {
  const f = await fixture(t), user = f.owner.id;
  const a = await seedConversationSource(f, f.a, 'Source A'), b = await seedConversationSource(f, f.b, 'Source B');
  f.store.conversationTitles = async () => { if (mode === 'failed') throw new Error('Resolver unavailable'); return {}; };
  for (const result of [await f.store.profile(user), await f.store.search(user, '')]) {
    const records = result.records ?? result.items;
    assert.equal(records.find(record => record.uri === a).evidenceCount, 1);
    assert.equal(records.find(record => record.uri === b).evidenceCount, 1);
    assert.deepEqual(result.conversations, {});
  }
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
  const row = await geo.createProject({ userId: user, projectId: 'new-project', engines: ['deepseek'], coverageDays: 30 });
  await geo.addMember({ geoId: row.id, userId: 'editor', role: 'editor', invitedBy: user });
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
