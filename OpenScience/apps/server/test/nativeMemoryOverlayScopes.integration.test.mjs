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
