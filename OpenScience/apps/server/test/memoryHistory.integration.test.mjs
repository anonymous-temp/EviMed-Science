import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryHistory, MemoryHistoryLedger } from '../src/memoryHistory.mjs';
import { projectNativeMemoryNamespace } from '../src/openVikingLayout.mjs';
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
  const next = await f.commitConversation('new', [{ role: 'user', text: 'New project trial table request.' }], { projectId: 'default' });
  f.commit = { ...f.commit, engineSession: next.session, archiveUri: next.archive_uri };
  await f.service.ingestArchive(f.commit, f.context); await f.service.drainDeletes();
  assert.equal((await search(f)).length, 1);
});

test('previously completed retained archives become searchable without another extraction or duplicate resources', options, async t => {
  const f = await setup(t); await f.worker.processCommits({ userId: f.userId });
  const extractions = f.stub.sent('POST', '/api/v1/sessions/dsh-session_a/commit').length;
  f.service.contexts.forUri = async () => f.context;
  assert.deepEqual(await search(f), []);
  await f.service.backfill(); assert.equal((await search(f)).length, 1);
  const writes = f.calls.filter(c => c[0] === 'write').length;
  await f.service.backfill(); assert.equal(f.calls.filter(c => c[0] === 'write').length, writes);
  assert.equal(f.stub.sent('POST', '/api/v1/sessions/dsh-session_a/commit').length, extractions);
  const coverage = await f.service.coverage(f.userId); assert.equal(coverage.complete, 1); assert.equal(coverage.unavailable, 0);
});

test('backfill persists retry/source digest and recovers after a failed write and service restart', options, async t => {
  const f = await setup(t); await f.worker.processCommits({ userId: f.userId }); f.service.contexts.forUri = async () => f.context;
  f.failWrites(true); await f.service.backfill(); assert.equal((await f.service.coverage(f.userId)).unavailable, 1);
  const before = (await f.database.query('SELECT source_hash FROM evimed_memory.history_archives WHERE owner_id=$1', [f.userId])).rows[0].source_hash;
  assert.match(before, /^[a-f0-9]{64}$/);
  const restarted = Object.assign(Object.create(Object.getPrototypeOf(f.service)), f.service);
  await f.database.query("UPDATE evimed_memory.history_archives SET next_attempt_at=clock_timestamp()-interval '1 second',lease_until=NULL WHERE owner_id=$1", [f.userId]);
  f.failWrites(false); await restarted.backfill(); assert.equal((await search(f)).length, 1); assert.equal((await restarted.coverage(f.userId)).complete, 1);
});

test('backfill honors prior reset fences and excluded conversations without reviving history', options, async t => {
  const f = await setup(t); await f.worker.processCommits({ userId: f.userId }); f.service.contexts.forUri = async () => f.context;
  await f.service.reset(f.userId); await f.service.backfill(); assert.equal(f.files.size, 0); assert.deepEqual(await search(f), []);
  assert.equal((await f.service.coverage(f.userId)).withdrawn, 1);
  const g = await setup(t); await g.worker.processCommits({ userId: g.userId }); g.service.contexts.forUri = async () => g.context; g.service.eligible = async () => false;
  await g.service.backfill(); assert.equal(g.files.size, 0); assert.equal((await g.service.coverage(g.userId)).withdrawn, 1);
});

test('backfill reports oversized/unavailable archives honestly rather than calling empty coverage complete', options, async t => {
  const f = await setup(t); await f.worker.processCommits({ userId: f.userId }); f.service.contexts.forUri = async () => f.context;
  const read = f.context.sessions.read.bind(f.context.sessions);
  f.context.sessions.read = async (owner, uri, options) => uri.endsWith('/messages.jsonl') ? 'x'.repeat(2_000_001) : read(owner, uri, options);
  await f.service.backfill(); const coverage = await f.service.coverage(f.userId);
  assert.equal(coverage.partial, 1); assert.equal(coverage.complete, 0); assert.equal(f.files.size, 0);
});


test('backfill keeps equal session names in personal and shared namespaces separate, including short Chinese rejections', options, async t => {
  const f = await setup(t); await f.worker.processCommits({ userId: f.userId });
  const namespace = projectNativeMemoryNamespace({ ownerId: f.userId, ownerCreatedAt: f.context.ownerCreatedAt,
    projectId: 'shared', projectCreatedAt: '2026-01-01T00:00:00Z' });
  const sessions = f.sessions.forNamespace(namespace); await sessions.register(f.userId);
  await sessions.createSession(f.userId, f.commit.engineSession);
  await sessions.addMessage(f.userId, f.commit.engineSession, { role: 'user', content: '对方说青霉素过敏，需要核对药物。' });
  const accepted = (await sessions.commit(f.userId, f.commit.engineSession)).result;
  await f.overlay.recordCommit({ userId: f.userId, engineSession: f.commit.engineSession, projectId: 'shared', archiveUri: accepted.archive_uri, origin: 'gateway', state: 'completed' });
  const shared = { ...f.context, kind: 'geo-project', projectId: 'shared', namespaceId: namespace.engineUser, userRoot: sessions.userRoot(f.userId), sessions };
  f.service.contexts.forUri = async (_owner, uri) => uri.startsWith(shared.userRoot) ? shared : f.context;
  f.service.contexts.forProject = async project => project.id === 'shared' ? shared : f.context;
  await f.service.backfill();
  const sharedSearch = () => f.service.search({ user: { id: f.userId }, project: { id: 'shared', userId: f.userId }, query: '过敏' });
  assert.equal((await search(f)).length, 1); assert.equal((await sharedSearch()).length, 1);
  await f.overlay.reject(f.userId, `${namespace.engineUser}:notes`, `${shared.userRoot}/memories/notes/a.md`, ['青霉素过敏'], { origin: 'edit' });
  assert.deepEqual(await sharedSearch(), []); assert.equal((await search(f)).length, 1);
  await f.overlay.unreject(f.userId, `${namespace.engineUser}:notes`, ['青霉素过敏']);
  assert.equal((await sharedSearch()).length, 1, 'explicit owner restore releases that namespace rejection');
});

test('short removed Chinese text is dropped as a whole history hit while unrelated retained facts remain searchable', options, async t => {
  const f = await setup(t); f.service.contexts.forUri = async () => f.context;
  const second = await f.commitConversation('short', [{ role: 'user', text: '我吃素，希望聚餐时准备蔬菜。' }], { projectId: 'default' });
  await f.worker.processCommits({ userId: f.userId });
  await f.overlay.reject(f.userId, 'notes', `${f.root}/notes/a.md`, ['我吃素']);
  await f.service.backfill();
  const hits = await search(f); assert.equal(hits.length, 1); assert.ok(!hits.some(hit => hit.sessionId === second.session.slice(4)));
  assert.equal((await f.service.coverage(f.userId)).partial, 1);
});

test('backfill source digest rejects changed archive bytes on retry and does not re-extract or publish changed text', options, async t => {
  const f = await setup(t); await f.worker.processCommits({ userId: f.userId }); f.service.contexts.forUri = async () => f.context;
  f.failWrites(true); await f.service.backfill(); f.failWrites(false);
  const read = f.context.sessions.read.bind(f.context.sessions);
  f.context.sessions.read = async (owner, uri, options) => uri.endsWith('/messages.jsonl') ? JSON.stringify({ role: 'user', content: 'Replacement archive bytes must not appear.' }) : read(owner, uri, options);
  await f.database.query("UPDATE evimed_memory.history_archives SET next_attempt_at=clock_timestamp()-interval '1 second',lease_until=NULL WHERE owner_id=$1", [f.userId]);
  await f.service.backfill(); assert.equal(f.files.size, 0);
  const row = (await f.database.query('SELECT state,reason FROM evimed_memory.history_archives WHERE owner_id=$1', [f.userId])).rows[0];
  assert.equal(row.state, 'unavailable'); assert.equal(row.reason, 'memory_history_source_changed');
});

test('backfill leases expire after a crashed process and later archives progress past unavailable ones', options, async t => {
  const f = await setup(t); await f.worker.processCommits({ userId: f.userId }); f.service.contexts.forUri = async () => f.context;
  for (let i = 0; i < 5; i++) await f.commitConversation(`later${i}`, [{ role: 'user', text: `Retained distinct topic ${i}` }], { projectId: 'default' });
  await f.worker.processCommits({ userId: f.userId });
  await f.ledger.discoverArchives(); const claimed = await f.ledger.claimArchives(1); assert.equal(claimed.length, 1);
  await f.database.query("UPDATE evimed_memory.history_archives SET lease_until=clock_timestamp()-interval '1 second' WHERE owner_id=$1", [f.userId]);
  await f.service.backfill(); assert.equal((await f.service.coverage(f.userId)).complete, 4);
  await f.service.backfill(); assert.equal((await f.service.coverage(f.userId)).complete, 6);
  assert.equal(f.files.size, 6);
});

test('a partially indexed archive resumes remaining chunks without rewriting ready resources', options, async t => {
  const f = await setup(t); f.service.contexts.forUri = async () => f.context;
  const archive = await f.commitConversation('many', Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `Exchange ${i}: ${'context '.repeat(80)}` })), { projectId: 'default' });
  await f.worker.processCommits({ userId: f.userId });
  const write = f.resources.writeHistory; let n = 0;
  f.resources.writeHistory = async (...args) => { n++; if (n === 3) throw new Error('interrupted after ready chunks'); return write(...args); };
  await f.service.backfill(); assert.equal((await f.service.coverage(f.userId)).unavailable, 1);
  const existing = [...f.files.keys()];
  const calls = f.calls.length; f.resources.writeHistory = write;
  await f.database.query("UPDATE evimed_memory.history_archives SET next_attempt_at=clock_timestamp()-interval '1 second',lease_until=NULL WHERE owner_id=$1", [f.userId]);
  await f.service.backfill();
  assert.equal((await f.service.coverage(f.userId)).complete, 2);
  assert.ok(!f.calls.slice(calls).some(c => c[0] === 'write' && existing.includes(c[1])));
  assert.ok([...f.files.keys()].some(uri => uri.includes('history'))); assert.ok(archive.archive_uri);
});

test('coverage includes undiscovered completed archives beyond the bounded discovery page', options, async t => {
  const f = await setup(t); await f.worker.processCommits({ userId: f.userId });
  await f.database.query(`INSERT INTO evimed_memory.native_commits(user_id,archive_uri,engine_session,project_id,origin,state)
    SELECT $1,regexp_replace($2,'archive_[0-9]+$','archive_' || i::text),$3,'default','scan','completed' FROM generate_series(2,106) i`,
  [f.userId,f.commit.archiveUri,f.commit.engineSession]);
  assert.equal(await f.ledger.discoverArchives(100), 100);
  const coverage = await f.service.coverage(f.userId); assert.equal(coverage.queued, 100); assert.equal(coverage.undiscovered, 6);
});
