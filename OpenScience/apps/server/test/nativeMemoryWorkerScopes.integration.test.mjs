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
import { NativeMemoryWorker } from '../src/nativeMemoryWorker.mjs';
import { OpenVikingSessions } from '../src/openVikingSessions.mjs';
import { OpenVikingClient } from '../src/openVikingClient.mjs';
import { loadConfig } from '../src/config.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { startOpenVikingStub } from './helpers/openVikingStub.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
async function fixture(t, { type = 'entities', after = 'A scoped project fact. doi:10.1000/example' } = {}) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'nativeworkerscopes');
  let accounts, dataDir;
  t.after(async () => { await accounts?.database.close(); await isolated.drop(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'native-worker-scopes-'));
  accounts = new PostgresStore(loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', databasePoolMax: 2 }));
  await accounts.createUser('owner', 'fixture-password', 'Owner'); const owner = await accounts.userById('owner');
  await accounts.createProject(owner, 'project-b', 'B');
  const aProject = await accounts.requireProject(owner, 'default'), bProject = await accounts.requireProject(owner, 'project-b');
  const geo = new GeoStore({ database: accounts.database }); await geo.ready();
  for (const project of [aProject, bProject]) await geo.createProject({ userId: owner.id, projectId: project.id, engines: ['deepseek'], coverageDays: 30 });
  let failExtraction = false;
  const stub = await startOpenVikingStub(t, { extract: ({ user }) => failExtraction ? 'fail' : { adds: [{ uri: `viking://user/${user}/memories/${type}/fact.md`, memory_type: type, after }] } });
  const sessions = new OpenVikingSessions(new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: 'evimed' }));
  const documents = new ProductDocuments(accounts.database), policies = new GeoSharedContext({ database: accounts.database, documents });
  const contexts = new GeoNativeMemoryContext({ database: accounts.database, documents, policies, sessions });
  const a = await contexts.forProject(aProject), b = await contexts.forProject(bProject);
  const personal = (await contexts.all(owner.id))[0], overlay = new NativeMemoryOverlay({ database: accounts.database });
  await overlay.migrate(); await overlay.noteSession(owner.id, 'dsh-root', 'ordinary');
  const reports = [];
  const researchMemory = { configured: true, memoryEngine: async () => 'native', accountsOnEngine: async () => [{ userId: owner.id }], settings: async () => ({ learningPaused: false, pausedProjects: [] }) };
  const worker = new NativeMemoryWorker({ config: { ovNativeMemoryEnabled: true }, researchMemory, sessions, overlay, memoryContexts: contexts, report: value => reports.push(value) });
  const archive = async (context, text = 'A user statement unrelated to the extracted line.') => {
    if (context.kind === 'geo-project') await contexts.configure(context); else await sessions.register(owner.id);
    await context.sessions.createSession(owner.id, 'dsh-root');
    await context.sessions.addMessage(owner.id, 'dsh-root', { role: 'user', content: text });
    return (await context.sessions.commit(owner.id, 'dsh-root')).result.archive_uri;
  };
  return { owner, accounts, contexts, geo, a, b, personal, overlay, worker, stub, reports, archive,
    fail: value => { failExtraction = value; }, file: context => `${context.userRoot}/memories/${type}/fact.md` };
}

test('archive scan and ingestion keep personal plus two equal-session project namespaces independent', options, async t => {
  const f = await fixture(t);
  for (const context of [f.personal, f.a, f.b]) await f.archive(context);
  assert.equal(await f.worker.scanArchives(f.owner.id), 3);
  assert.equal(await f.worker.processCommits({ userId: f.owner.id }), 3);
  for (const context of [f.a, f.b]) {
    const file = await f.overlay.file(f.owner.id, f.file(context));
    assert.equal(file.projectId, context.projectId, 'shared entities are project owned too');
    const commits = await f.overlay.commitsOfSession(f.owner.id, 'dsh-root', { userRoot: context.userRoot });
    assert.equal(commits[0].projectId, context.projectId); assert.equal(commits[0].state, 'completed');
    assert.equal(await f.contexts.session(context, 'dsh-root'), null, 'an orphan scan must not grant fresh capture permission');
  }
  assert.equal((await f.overlay.file(f.owner.id, f.file(f.personal))).projectId, null);
  for (const request of f.stub.sent('GET', '/api/v1/content/read')) assert.ok(request.query.uri.startsWith(`viking://user/${request.user}/`));
});

test('failed extraction replay and completion retain the original namespace and register only the internal replay', options, async t => {
  const f = await fixture(t); f.fail(true);
  const oldA = await f.archive(f.a), oldB = await f.archive(f.b);
  await f.worker.scanArchives(f.owner.id); f.fail(false);
  assert.equal(await f.worker.processCommits({ userId: f.owner.id }), 2);
  for (const [context, original] of [[f.a, oldA], [f.b, oldB]]) {
    const old = await f.overlay.commit(f.owner.id, original);
    assert.equal(old.state, 'replayed'); assert.ok(old.replayedAs.startsWith(`${context.userRoot}/sessions/evimed-replay-`));
    const replay = await f.overlay.commit(f.owner.id, old.replayedAs);
    const binding = await f.contexts.session(context, replay.engineSession);
    assert.deepEqual(binding.payload.source, { kind: 'replay', sourceArchiveUri: original });
  }
  assert.equal(await f.worker.processCommits({ userId: f.owner.id }), 2);
  assert.equal(f.stub.sessions.has(`${f.personal.namespaceId}/dsh-root`), false);
});

test('project rejection keys do not erase equal facts in another namespace or clear personal rejection history', options, async t => {
  const text = 'The project uses plain abstracts.';
  const f = await fixture(t, { type: 'project_facts', after: text });
  await f.overlay.reject(f.owner.id, 'project_facts', f.file(f.personal), [text]);
  await f.overlay.reject(f.owner.id, `${f.a.namespaceId}:project_facts`, f.file(f.a), [text]);
  for (const context of [f.a, f.b]) await f.archive(context);
  await f.worker.scanArchives(f.owner.id); await f.worker.processCommits({ userId: f.owner.id });
  assert.equal(await f.a.sessions.read(f.owner.id, f.file(f.a)), null);
  assert.equal(await f.b.sessions.read(f.owner.id, f.file(f.b)), text);
  assert.equal((await f.overlay.rejectedFingerprints(f.owner.id, 'project_facts')).size, 1);
  await f.archive(f.a, text); await f.worker.scanArchives(f.owner.id); await f.worker.processCommits({ userId: f.owner.id });
  assert.equal(await f.a.sessions.read(f.owner.id, f.file(f.a)), text);
  assert.equal((await f.overlay.rejectedFingerprints(f.owner.id, `${f.a.namespaceId}:project_facts`)).size, 0);
  assert.equal((await f.overlay.rejectedFingerprints(f.owner.id, 'project_facts')).size, 1);
});

test('source labels use the file namespace and a failed write can be retried without losing the source change', options, async t => {
  const f = await fixture(t);
  for (const context of [f.a, f.b]) await f.archive(context);
  await f.worker.scanArchives(f.owner.id); await f.worker.processCommits({ userId: f.owner.id });
  await f.overlay.markSource(f.owner.id, f.file(f.a), { type: 'doi', id: '10.1000/example' }, 'retracted');
  f.stub.failWith = 503;
  await assert.rejects(f.worker.labelSource(f.owner.id, { type: 'doi', id: '10.1000/example' }, 'retracted'));
  f.stub.failWith = 0;
  assert.equal(await f.worker.labelSource(f.owner.id, { type: 'doi', id: '10.1000/example' }, 'retracted'), 2);
  for (const context of [f.a, f.b]) {
    assert.match(await context.sessions.read(f.owner.id, f.file(context)), /已撤稿/);
    assert.equal((await f.overlay.file(f.owner.id, f.file(context))).projectId, context.projectId);
    const revisions = await f.overlay.recentRevisions(f.owner.id, { userRoot: context.userRoot, actors: ['platform'] });
    assert.equal(revisions[0].projectId, context.projectId);
  }
});

test('a scoped diff is validated before any revision and mismatched commit identity is never read as another context', options, async t => {
  const f = await fixture(t), archive = await f.archive(f.a);
  await f.worker.scanArchives(f.owner.id);
  const commit = await f.overlay.commit(f.owner.id, archive);
  const requests = f.stub.requests.length;
  await assert.rejects(f.worker.ingest({ ...commit, projectId: f.b.projectId }, { archive_uri: archive, operations: {} }), error => error.code === 'memory_scope_denied');
  await assert.rejects(f.worker.ingest({ ...commit, engineSession: 'other-session' }, { archive_uri: archive, operations: {} }), error => error.code === 'memory_scope_denied');
  assert.equal(f.stub.requests.length, requests);
  await assert.rejects(f.worker.ingest(commit, { archive_uri: archive, operations: { adds: [
    { uri: f.file(f.a), after: 'A valid project fact.' }, { uri: f.file(f.b), after: 'A foreign project fact.' },
  ] } }), error => error.code === 'memory_scope_denied');
  assert.equal(await f.overlay.file(f.owner.id, f.file(f.a)), null);
  assert.equal((await f.overlay.recentRevisions(f.owner.id, { userRoot: f.a.userRoot })).length, 0);
  await assert.rejects(f.worker.ingest(commit, { archive_uri: archive, operations: { adds: [{ uri: `${f.a.userRoot}/memories/profile.md`, after: 'A profile' }] } }), error => error.code === 'memory_scope_denied');
  await assert.rejects(f.worker.ingest(commit, { operations: {} }), error => error.code === 'memory_scope_denied');
});

test('a failed accepted archive replays in the historical namespace after its project incarnation changes', options, async t => {
  const f = await fixture(t); f.fail(true);
  const archive = await f.archive(f.a); await f.worker.scanArchives(f.owner.id);
  await f.accounts.database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id=$2", [f.owner.id, f.a.projectId]);
  const replacement = await f.contexts.forProject({ userId: f.owner.id, id: f.a.projectId });
  assert.notEqual(replacement.namespaceId, f.a.namespaceId); f.fail(false);
  assert.equal(await f.worker.processCommits({ userId: f.owner.id }), 1);
  const original = await f.overlay.commit(f.owner.id, archive);
  assert.ok(original.replayedAs.startsWith(`${f.a.userRoot}/`));
  assert.equal(await f.worker.processCommits({ userId: f.owner.id }), 1);
  assert.ok(await f.overlay.file(f.owner.id, f.file(f.a)));
  assert.equal(await replacement.sessions.read(f.owner.id, f.file(replacement)), null);
});

test('bounded namespace scans rotate and a scan failure cannot strand an already recorded commit in another namespace', options, async t => {
  const f = await fixture(t);
  for (let index = 0; index < 8; index++) {
    const id = `extra-${index}`; await f.accounts.createProject(f.owner, id, id);
    const project = await f.accounts.requireProject(f.owner, id);
    await f.geo.createProject({ userId: f.owner.id, projectId: id, engines: ['deepseek'], coverageDays: 30 });
    await f.contexts.forProject(project);
  }
  const views = await f.contexts.all(f.owner.id), last = views.at(-1);
  const archive = await f.archive(last);
  const before = f.stub.sent('GET', '/api/v1/fs/tree').length;
  assert.equal(await f.worker.scanArchives(f.owner.id), 0);
  assert.equal(f.stub.sent('GET', '/api/v1/fs/tree').length - before, 8);
  assert.equal(await f.worker.scanArchives(f.owner.id), 1);
  const request = f.personal.sessions.rootClient.request.bind(f.personal.sessions.rootClient);
  f.personal.sessions.rootClient.request = async input => {
    if (input.path === '/api/v1/fs/tree' && input.openVikingUser === last.namespaceId) throw new Error('One namespace scan unavailable');
    return request(input);
  };
  // Start immediately before the failed view so this pass must encounter it.
  f.worker.scanCursors.set(f.owner.id, views.at(-2).namespaceId);
  const pass = await f.worker.pass();
  assert.equal(pass.commits, 1);
  assert.equal((await f.overlay.commit(f.owner.id, archive)).state, 'completed');
  assert.ok(f.reports.some(line => line.includes('namespace scans')));
});
