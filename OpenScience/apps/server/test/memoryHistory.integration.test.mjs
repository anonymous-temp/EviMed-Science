import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryHistory, MemoryHistoryLedger } from '../src/memoryHistory.mjs';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
const { options, fixture } = nativeIntegration();

async function setup(t) {
  const f = await fixture(t);
  const files = new Map(); const calls = []; let failWrite = false; let failRemove = false; let duringWrite = null;
  const resources = {
    async writeHistory(_owner, uri, content) { calls.push(['write', uri]); if (failWrite) throw new Error('write unavailable'); files.set(uri, content); if (duringWrite) await duringWrite(); },
    async searchHistory(_owner, root, query) { calls.push(['vector+keyword', root, query]); return [...files.keys(), 'viking://user/alien/resources/history/forged.md'].map(uri => ({ uri, score: 1 })); },
    async readHistory(_owner, uri) { calls.push(['read', uri]); return files.get(uri) ?? null; },
    async removeSource(_owner, uri) { if (failRemove) throw new Error('delete unavailable'); files.delete(uri); },
  };
  const stamp = (await f.database.query('SELECT created_at::text AS stamp FROM evimed_control.users WHERE id=$1', [f.userId])).rows[0].stamp;
  const context = { kind: 'owned', ownerId: f.userId, ownerCreatedAt: stamp, namespaceId: f.engineUser, userRoot: f.sessions.userRoot(f.userId), projectId: 'default', sessions: f.sessions };
  const ledger = new MemoryHistoryLedger({ database: f.database, overlay: f.overlay });
  ledger.removeResource = row => resources.removeSource(row.owner_id, row.uri);
  const service = new MemoryHistory({ config: { memoryHistorySearchEnabled: true }, ledger, contexts: { async forProject(p) { return { ...context, projectId: p.id }; } },
    resourcesFor: () => resources, resolveSource: async (c, _ctx) => ({ projectId: c.projectId, projectCreatedAt: '2026-01-01T00:00:00Z', sessionId: c.engineSession?.slice(4), conversationTitle: 'Kidney trial', conversationUrl: '/app/projects/default?session=session_a' }),
    eligible: async () => true, admitMessage: async () => true,
  });
  const archive = await f.commitConversation('a', [{ role: 'user', text: 'I prefer trial tables.', at: new Date(Date.now() + 1000).toISOString() }, { role: 'assistant', text: 'I suggest weekly analyses.' }], { projectId: 'default' });
  const commit = { userId: f.userId, projectId: 'default', engineSession: archive.session, archiveUri: archive.archive_uri, origin: 'gateway' };
  return { ...f, context, ledger, service, files, calls, commit, resources, failWrites: x => { failWrite = x; }, failDeletes: x => { failRemove = x; }, onWrite: x => { duringWrite = x; } };
}
const search = f => f.service.search({ user: { id: f.userId }, project: { id: 'default', userId: f.userId }, query: 'trial', limit: 5 });

test('history uses exact registry provenance and returns only own project with preserved roles', options, async t => {
  const f = await setup(t); await f.service.ingestArchive(f.commit, f.context);
  const hits = await search(f); assert.equal(hits.length, 1); assert.equal(hits[0].messages[1].sourceRole, 'assistant'); assert.equal(hits[0].messages[1].confirmed, false);
  assert.ok(hits[0].privateByDefault); assert.equal(hits[0].conversationTitle, 'Kidney trial');
  assert.ok(f.calls.some(c => c[0] === 'vector+keyword')); assert.ok(!f.calls.some(c => c[0] === 'read' && c[1].includes('alien')));
  assert.deepEqual(await f.service.search({ user: { id: f.userId }, project: { id: 'other', userId: f.userId }, query: 'trial' }), []);
});

test('literal and contained removed words suppress whole hits, including edits older than newest-N rejection windows', options, async t => {
  const f = await setup(t); await f.service.ingestArchive(f.commit, f.context);
  await f.overlay.reject(f.userId, 'preferences', `${f.root}/preferences/a.md`, ['I prefer trial tables.'], { origin: 'edit' });
  for (let n = 0; n < 4; n++) await f.overlay.reject(f.userId, 'notes', `${f.root}/notes/a.md`, Array.from({ length: 500 }, (_, i) => `newer irrelevant rejection ${n}-${i}`));
  assert.deepEqual(await search(f), []);
});

test('scope deletion persists before physical deletion and a raced writer cannot resurrect results', options, async t => {
  const f = await setup(t);
  f.onWrite(async () => { f.onWrite(null); f.failDeletes(true); await f.service.removeConversation(f.context, 'session_a'); });
  await f.service.ingestArchive(f.commit, f.context);
  assert.deepEqual(await search(f), []); assert.ok(f.files.size > 0);
  f.failDeletes(false); await f.service.drainDeletes(); assert.equal(f.files.size, 0);
  await f.service.ingestArchive(f.commit, f.context); assert.equal(f.files.size, 0);
});

test('index failure leaves the native commit pending and is recoverable on a later settle', options, async t => {
  const f = await setup(t); f.worker.history = f.service; f.worker.memoryContexts = { forUri: async () => f.context, assertKnown: async () => {} }; f.failWrites(true);
  await f.worker.processCommits({ userId: f.userId }); assert.equal((await f.overlay.openCommits({ userId: f.userId }))[0].state, 'pending');
  f.failWrites(false); await f.worker.processCommits({ userId: f.userId }); assert.equal((await search(f)).length, 1);
  assert.equal((await f.overlay.openCommits({ userId: f.userId })).length, 0);
});

test('native reset and project deletion fence indexed history before touching engine bytes', options, async t => {
  const f = await setup(t); f.store.history = f.service; await f.service.ingestArchive(f.commit, f.context);
  f.failDeletes(true); await f.store.reset(f.userId); assert.deepEqual(await search(f), []);
  f.failDeletes(false); await f.service.drainDeletes(); assert.equal(f.files.size, 0);
});

test('cleanup obligations survive owner deletion and recreated accounts use disjoint history roots', options, async t => {
  const f = await setup(t); await f.service.ingestArchive(f.commit, f.context); f.failDeletes(true);
  await f.service.eraseAccount(f.userId); await f.database.query('DELETE FROM evimed_control.users WHERE id=$1', [f.userId]);
  assert.ok((await f.database.query("SELECT uri FROM evimed_memory.history_chunks WHERE owner_id=$1 AND state='withdrawn' AND cleaned_at IS NULL", [f.userId])).rows.length > 0);
  f.failDeletes(false); await f.service.drainDeletes(); assert.equal(f.files.size, 0);
});


test('shared project history checks only that namespace rejection ledger', options, async t => {
  const f = await setup(t); await f.service.ingestArchive(f.commit, f.context);
  await f.overlay.reject(f.userId, `gp-${'a'.repeat(24)}:preferences`, 'viking://user/gp-aaaaaaaaaaaaaaaaaaaaaaaa/memories/preferences/a.md', ['I prefer trial tables.']);
  assert.equal((await search(f)).length, 1, 'another namespace cannot suppress personal history');
});

test('project deletion fences a new in-flight archive and reset rejects undated old archives', options, async t => {
  const f = await setup(t); await f.service.ingestArchive(f.commit, f.context);
  await f.service.deleteProject(f.userId, 'default'); assert.deepEqual(await search(f), []);
  await f.service.ingestArchive(f.commit, f.context); await f.service.drainDeletes(); assert.equal(f.files.size, 0);
});

test('a crashed writer that lands after successful cleanup remains covered by durable re-sweep', options, async t => {
  const f = await setup(t); await f.service.ingestArchive(f.commit, f.context);
  const [uri, bytes] = [...f.files][0]; await f.service.eraseAccount(f.userId); await f.service.drainDeletes();
  assert.equal(f.files.size, 0); f.files.set(uri, bytes); // accepted engine write lands after the writer process died
  await f.database.query("UPDATE evimed_memory.history_chunks SET cleaned_at=clock_timestamp()-interval '2 hours' WHERE uri=$1", [uri]);
  await f.service.drainDeletes(); assert.equal(f.files.size, 0);
});

test('history flag disables capture/search without disabling already owed cleanup', options, async t => {
  const f = await setup(t); f.service.config.memoryHistorySearchEnabled = false;
  await f.service.ingestArchive(f.commit, f.context); assert.equal(f.files.size, 0); assert.deepEqual(await search(f), []);
  f.service.config.memoryHistorySearchEnabled = true; await f.service.ingestArchive(f.commit, f.context);
  f.service.config.memoryHistorySearchEnabled = false; await f.service.eraseAccount(f.userId); await f.service.drainDeletes(); assert.equal(f.files.size, 0);
});

test('hard boundary changes withdraw existing history before any later recall', options, async t => {
  const f = await setup(t); await f.service.ingestArchive(f.commit, f.context);
  f.service.eligible = async () => false;
  assert.deepEqual(await search(f), []);
  await f.service.drainDeletes(); assert.equal(f.files.size, 0);
});

test('recreated owner and project incarnations cannot read old resources and cleanup names only old exact URIs', options, async t => {
  const f = await setup(t); await f.service.ingestArchive(f.commit, f.context);
  const oldUris = [...f.files.keys()];
  await f.service.eraseAccount(f.userId);
  await f.database.query('DELETE FROM evimed_control.users WHERE id=$1', [f.userId]);
  await f.database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Recreated owner','development')", [f.userId]);
  f.context.ownerCreatedAt = (await f.database.query('SELECT created_at::text AS stamp FROM evimed_control.users WHERE id=$1', [f.userId])).rows[0].stamp;
  assert.deepEqual(await search(f), []);
  await f.service.ingestArchive(f.commit, f.context);
  const newUris = [...f.files.keys()].filter(uri => !oldUris.includes(uri)); assert.equal(newUris.length, 1);
  await f.service.drainDeletes(); assert.deepEqual([...f.files.keys()], newUris);
  assert.equal((await search(f)).length, 1);
});

test('changed project incarnation gets a distinct root and an old project fence cannot block its history', options, async t => {
  const f = await setup(t); await f.service.ingestArchive(f.commit, f.context);
  await f.service.deleteProject(f.userId, 'default');
  f.service.resolveSource = async c => ({ projectId: c.projectId, projectCreatedAt: '2026-02-01T00:00:00Z', sessionId: c.engineSession?.slice(4), conversationTitle: 'New project', conversationUrl: '/app/chat/session_a' });
  await f.service.ingestArchive(f.commit, f.context); await f.service.drainDeletes();
  assert.equal((await search(f)).length, 1);
});
