import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { NativeMemoryOverlay } from '../src/nativeMemoryOverlay.mjs';
import { projectNativeMemoryNamespace, userRootUri } from '../src/openVikingLayout.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
async function fixture(t) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'nativememoryscopes');
  let database;
  t.after(async () => { await database?.close(); await isolated.drop(); });
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  const overlay = new NativeMemoryOverlay({ database }); await overlay.migrate();
  const userId = 'memory-scope-owner';
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Memory fixture','development')", [userId]);
  const namespace = id => projectNativeMemoryNamespace({ ownerId: userId, ownerCreatedAt: '2026-10-01 00:00:00+00', projectId: id, projectCreatedAt: '2026-10-01 00:00:00+00' });
  const personal = userRootUri(userId), a = `viking://user/${namespace('a').id}`, b = `viking://user/${namespace('b').id}`;
  const archive = (root, session = 'dsh-root') => `${root}/sessions/${session}/history/archive_001`;
  return { database, overlay, userId, personal, a, b, archive };
}

test('bare personal session lookup never attributes a namespaced project commit to the personal engine', options, async t => {
  const f = await fixture(t);
  await f.overlay.recordCommit({ userId: f.userId, archiveUri: f.archive(f.a), engineSession: 'dsh-root', projectId: 'a', origin: 'gateway' });
  await f.overlay.recordCommit({ userId: f.userId, archiveUri: f.archive(f.b), engineSession: 'dsh-root', projectId: 'b', origin: 'gateway' });
  assert.equal(await f.overlay.projectOfSession(f.userId, 'dsh-root'), null);
  assert.deepEqual(await f.overlay.commitsOfSession(f.userId, 'dsh-root'), []);
  assert.deepEqual(await f.overlay.projectSessions(f.userId, 'a'), []);
  assert.equal((await f.overlay.commitsOfSession(f.userId, 'dsh-root', { userRoot: f.a })).length, 1);
  assert.deepEqual(await f.overlay.projectSessions(f.userId, 'a', { userRoot: f.a }), ['dsh-root']);
  await f.overlay.recordCommit({ userId: f.userId, archiveUri: f.archive(f.personal), engineSession: 'dsh-root', projectId: 'ordinary', origin: 'gateway' });
  assert.equal(await f.overlay.projectOfSession(f.userId, 'dsh-root'), 'ordinary');
  await f.overlay.noteSession(f.userId, 'dsh-root', 'personal-recorded');
  assert.equal(await f.overlay.projectOfSession(f.userId, 'dsh-root'), 'personal-recorded', 'legacy personal registration keeps its precedence');
  assert.equal(await f.overlay.projectOfSession(f.userId, 'dsh-root', { userRoot: f.a }), 'a', 'namespaced lookup never consults the bare legacy row');
});

test('revision and pending-commit roots are filtered before paging and equal session ids remain independent', options, async t => {
  const f = await fixture(t);
  for (const [index, root, project] of [[0, f.personal, 'ordinary'], [1, f.a, 'a'], [2, f.b, 'b']]) {
    await f.overlay.recordCommit({ userId: f.userId, archiveUri: f.archive(root), engineSession: 'dsh-root', projectId: project, origin: 'page' });
    await f.overlay.addRevision({ userId: f.userId, uri: `${root}/memories/project_facts/fact.md`, memoryType: 'project_facts', change: 'added', actor: 'engine',
      after: project, archiveUri: f.archive(root), engineSession: 'dsh-root', projectId: project, changedAt: `2026-10-01T00:00:0${index}Z` });
  }
  const own = await f.overlay.recentRevisions(f.userId, { engineSession: 'dsh-root', limit: 1 });
  assert.equal(own[0].projectId, 'ordinary');
  await assert.rejects(f.overlay.recentRevisions(f.userId, { engineSession: 'dsh-root', userRoot: null, limit: 1 }), error => error.code === 'memory_scope_denied');
  const a = await f.overlay.recentRevisions(f.userId, { engineSession: 'dsh-root', userRoot: f.a, limit: 1 });
  assert.equal(a[0].projectId, 'a');
  const pending = await f.overlay.pendingCommits(f.userId, { userRoot: f.a, limit: 1 });
  assert.equal(pending[0].projectId, 'a');
  const account = await f.overlay.recentRevisions(f.userId, { limit: 10 });
  assert.equal(account.length, 3, 'the explicit account-wide view retains all full-URI histories');
  const known = await f.overlay.knownArchives(f.userId, { userRoot: f.b });
  assert.deepEqual([...known], [f.archive(f.b)]);
});

test('a root predicate is canonical and cannot become a partial-prefix or wildcard match', options, async t => {
  const f = await fixture(t);
  for (const userRoot of [f.a + '-other', f.a + '/sessions', 'viking://~', 'viking://user/%', 'viking://user/../other', null]) {
    await assert.rejects(f.overlay.commitsOfSession(f.userId, 'dsh-root', { userRoot }), error => error.code === 'memory_scope_denied');
  }
});

test('namespace cleanup removes only its exact URI history including forgotten files and leaves equal public project ids alone', options, async t => {
  const f = await fixture(t), roots = [f.personal, f.a, f.b];
  for (const root of roots) {
    const uri = `${root}/memories/entities/fact.md`;
    await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'entities', projectId: 'reused', body: 'Fact' });
    await f.overlay.setSources(f.userId, uri, [{ type: 'doi', id: '10.1000/example' }]);
    await f.overlay.addRevision({ userId: f.userId, uri, memoryType: 'entities', change: 'added', actor: 'engine', after: 'Fact', projectId: 'reused' });
    await f.overlay.recordCommit({ userId: f.userId, archiveUri: f.archive(root), engineSession: 'dsh-root', projectId: 'reused', origin: 'page' });
    await f.overlay.reject(f.userId, root === f.personal ? 'entities' : `${root.split('/').at(-1)}:entities`, uri, ['Forgotten fact']);
  }
  await f.overlay.noteSession(f.userId, 'dsh-root', 'reused');
  const forgotten = `${f.a}/memories/project_facts/forgotten.md`;
  await f.overlay.addRevision({ userId: f.userId, uri: forgotten, memoryType: 'project_facts', change: 'deleted', actor: 'user', before: 'Private old text', projectId: 'reused' });
  const purged = await f.overlay.purgeNamespace(f.userId, f.a);
  assert.deepEqual(purged, { files: 1, revisions: 2, commits: 1 });
  assert.equal(await f.overlay.file(f.userId, `${f.a}/memories/entities/fact.md`), null);
  assert.equal((await f.overlay.revisionsOf(f.userId, forgotten)).length, 0);
  assert.equal((await f.overlay.sources(f.userId)).length, 2);
  assert.equal((await f.overlay.rejectedFingerprints(f.userId, `${f.a.split('/').at(-1)}:entities`)).size, 0);
  assert.equal((await f.overlay.rejectedFingerprints(f.userId, 'entities')).size, 1);
  for (const root of [f.personal, f.b]) assert.ok(await f.overlay.commit(f.userId, f.archive(root)));
  assert.equal(await f.overlay.projectOfSession(f.userId, 'dsh-root'), 'reused');
  assert.deepEqual(await f.overlay.purgeNamespace(f.userId, f.a), { files: 0, revisions: 0, commits: 0 });
  await assert.rejects(f.overlay.purgeNamespace(f.userId, f.personal), error => error.code === 'memory_scope_denied');
});

test('legacy project cleanup stays in the personal root and never erases another registered namespace sharing its project id', options, async t => {
  const f = await fixture(t);
  for (const root of [f.personal, f.a]) {
    const uri = `${root}/memories/project_facts/fact.md`;
    await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'project_facts', projectId: 'reused', body: 'Fact' });
    await f.overlay.addRevision({ userId: f.userId, uri, memoryType: 'project_facts', projectId: 'reused', change: 'added', actor: 'engine', after: 'Fact' });
    await f.overlay.recordCommit({ userId: f.userId, archiveUri: f.archive(root), engineSession: 'dsh-root', projectId: 'reused', origin: 'scan' });
  }
  await f.overlay.purgeProject(f.userId, 'reused');
  assert.equal(await f.overlay.file(f.userId, `${f.personal}/memories/project_facts/fact.md`), null);
  assert.ok(await f.overlay.file(f.userId, `${f.a}/memories/project_facts/fact.md`));
  assert.ok(await f.overlay.commit(f.userId, f.archive(f.a)));
});

test('namespace overlay cleanup is one transaction when a later table delete fails', options, async t => {
  const f = await fixture(t), uri = `${f.a}/memories/entities/fact.md`;
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'entities', body: 'Fact' });
  await f.overlay.setSources(f.userId, uri, [{ type: 'doi', id: '10.1000/example' }]);
  await f.overlay.recordCommit({ userId: f.userId, archiveUri: f.archive(f.a), engineSession: 'dsh-root', origin: 'scan' });
  await f.database.query("CREATE FUNCTION evimed_memory.refuse_fixture_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture deletion interrupted'; END $$");
  await f.database.query('CREATE TRIGGER refuse_fixture_delete BEFORE DELETE ON evimed_memory.native_sources FOR EACH ROW EXECUTE FUNCTION evimed_memory.refuse_fixture_delete()');
  await assert.rejects(f.overlay.purgeNamespace(f.userId, f.a), /fixture deletion interrupted/);
  assert.ok(await f.overlay.file(f.userId, uri));
  assert.ok(await f.overlay.commit(f.userId, f.archive(f.a)));
  await f.database.query('DROP TRIGGER refuse_fixture_delete ON evimed_memory.native_sources');
  await f.overlay.purgeNamespace(f.userId, f.a);
  assert.equal(await f.overlay.file(f.userId, uri), null);
});
