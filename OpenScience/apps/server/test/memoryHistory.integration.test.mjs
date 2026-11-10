import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryHistory, MemoryHistoryLedger } from '../src/memoryHistory.mjs';
import { projectNativeMemoryNamespace } from '../src/openVikingLayout.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMemoryGatewayHandler, parseEventStream } from '../src/memoryGateway.mjs';
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

test('an index failure never holds the native commit: it settles first and the backfill retries the archive', options, async t => {
  const f = await setup(t); f.worker.history = f.service; f.worker.memoryContexts = { forUri: async () => f.context, assertKnown: async () => {} }; f.failWrites(true);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.openCommits({ userId: f.userId })).length, 0, 'the commit is completed although the index failed');
  const state = async () => (await f.database.query('SELECT state,attempts,next_attempt_at>clock_timestamp() AS waiting FROM evimed_memory.history_archives WHERE archive_uri=$1', [f.commit.archiveUri])).rows[0];
  assert.equal((await state()).state, 'unavailable'); assert.equal((await state()).waiting, true, 'a failure waits out a backoff');
  f.failWrites(false); f.service.contexts.forUri = async () => f.context;
  await f.database.query("UPDATE evimed_memory.history_archives SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE archive_uri=$1", [f.commit.archiveUri]);
  await f.service.backfill(); assert.equal((await search(f)).length, 1);
});

test('an unproven source is terminal for history, and repeated failures back off to a long pause', options, async t => {
  const f = await setup(t); f.service.resolveSource = async () => null;
  await f.service.ingestArchive(f.commit, f.context);
  const row = async () => (await f.database.query('SELECT state,reason FROM evimed_memory.history_archives WHERE archive_uri=$1', [f.commit.archiveUri])).rows[0];
  assert.deepEqual(await row(), { state: 'excluded', reason: 'memory_history_source_unproven' });
  await f.database.query("UPDATE evimed_memory.history_archives SET state='unavailable',attempts=8 WHERE archive_uri=$1", [f.commit.archiveUri]);
  await f.ledger.finishArchive(f.commit, f.context, 'unavailable', { reason: 'memory_history_index_unavailable' });
  const paused = (await f.database.query("SELECT next_attempt_at>clock_timestamp()+interval '6 days' AS long FROM evimed_memory.history_archives WHERE archive_uri=$1", [f.commit.archiveUri])).rows[0];
  assert.equal(paused.long, true);
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
  assert.equal((await search(f)).length, 1);
  // A shared GEO namespace is never raw-indexed (it would admit every member's words as the owner's).
  assert.deepEqual(await sharedSearch(), []);
  assert.equal((await f.database.query('SELECT state FROM evimed_memory.history_archives WHERE archive_uri=$1', [accepted.archive_uri])).rows[0].state, 'excluded');
  await f.overlay.reject(f.userId, `${namespace.engineUser}:notes`, `${shared.userRoot}/memories/notes/a.md`, ['青霉素过敏'], { origin: 'edit' });
  assert.equal((await search(f)).length, 1);
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


async function gateway(t, f) {
  const handler = createMemoryGatewayHandler({ config: { memoryEngineEnabled: true, memoryEnabled: true, memoryHistorySearchEnabled: true },
    sessions: f.sessions, overlay: f.overlay, historySearch: input => f.service.search(input),
    runtimeManager: { assertActiveEviMedWorkloadToken: async () => ({ userId: f.userId, projectId: 'default' }) },
    store: { userById: async () => ({ id: f.userId }), requireProject: async () => ({ id: 'default', userId: f.userId }) },
    admission: { admit: async () => ({ learn: true, recall: true }) } });
  const server = createServer((req,res) => { void handler(req,res); }); server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (mcp = false) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/internal/memory/v1/${mcp ? 'mcp' : 'api/v1/search/search'}`, {
      method: 'POST', headers: { authorization: 'Bearer history-test', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(mcp ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'trial' } } } : { query: 'trial' }),
    });
    const text = await response.text(); assert.equal(response.status,200); return { text, json: response.headers.get('content-type').includes('event-stream') ? parseEventStream(text) : JSON.parse(text) };
  };
}

test('REST and MCP sanitize current/legacy title metadata and forget title-only words without losing unrelated body', options, async t => {
  const f = await setup(t); const resolve = f.service.resolveSource;
  f.service.resolveSource = async (...args) => ({ ...await resolve(...args), conversationTitle: 'Password: ordinary-fake-P4ssword! trial discussion' });
  await f.service.ingestArchive(f.commit,f.context); const call = await gateway(t,f);
  for (const mcp of [false,true]) assert.doesNotMatch((await call(mcp)).text,/ordinary-fake-P4ssword/);
  f.service.resolveSource = async (...args) => ({ ...await resolve(...args), conversationTitle: 'Clean title', projectTitle: 'Password: fake-only-project-secret!' });
  for (const mcp of [false,true]) assert.doesNotMatch((await call(mcp)).text,/fake-only-project-secret/);
  f.service.resolveSource = async (...args) => ({ ...await resolve(...args), conversationTitle: 'Legacy title says 青霉素过敏 only', projectTitle: 'Legacy project label says 青霉素过敏' });
  await f.overlay.reject(f.userId,'notes',`${f.root}/notes/title.md`,['青霉素过敏']);
  for (const mcp of [false,true]) { const text = (await call(mcp)).text; assert.doesNotMatch(text,/青霉素过敏/); assert.match(text,/trial tables/); }
});

test('fragment-boundary removals suppress the entire original message at ingest and on legacy reads', options, async t => {
  for (const legacy of [false,true]) {
    const f = await setup(t); const record = await f.commitConversation('boundary',[{ role: 'user', text: `${'普通'.repeat(899)}青霉素过敏，请记住。` }], { projectId: 'default' });
    const c = { ...f.commit,engineSession: record.session,archiveUri:record.archive_uri };
    if (legacy) await f.service.ingestArchive(c,f.context);
    await f.overlay.reject(f.userId,'notes',`${f.root}/notes/a.md`,['青霉素过敏']);
    if (!legacy) await f.service.ingestArchive(c,f.context);
    const hits = await search(f); assert.ok(!hits.some(hit => hit.sessionId === record.session.slice(4)));
  }
});

test('shared JS normalization covers legacy Cf-containing removals without suppressing unrelated facts', options, async t => {
  const f = await setup(t);
  const record = await f.commitConversation('unicode',[{ role: 'user', text: '平时我\u200b吃素，需要准备蔬菜。' }], { projectId: 'default' });
  await f.service.ingestArchive({ ...f.commit,engineSession:record.session,archiveUri:record.archive_uri },f.context);
  await f.service.ingestArchive(f.commit,f.context);
  await f.overlay.reject(f.userId,'notes',`${f.root}/notes/a.md`,['我\u200b吃素']);
  const hits = await search(f); assert.equal(hits.length,1); assert.equal(hits[0].sessionId,'session_a');
});

test('hydration preserves stored order/length without repeating overlapping assistant context', options, async t => {
  const f = await setup(t); const record = await f.commitConversation('long',[
    { role:'user',text:'甲'.repeat(1700) },{ role:'assistant',text:'乙'.repeat(1678) },{ role:'user',text:'丙'.repeat(1700) },
  ],{ projectId:'default' });
  await f.service.ingestArchive({ ...f.commit,engineSession:record.session,archiveUri:record.archive_uri },f.context);
  const hits = await search(f);
  for (const hit of hits) { assert.ok(hit.messages.reduce((n,m)=>n+m.text.length+80,0)<=6000); }
  const carried = hits.find(hit=>hit.messages.some(m=>m.text.startsWith('丙')));
  assert.deepEqual(carried.messages.map(m=>m.text[0]),['乙','丙']);
});

test('default searches owned ordinary project history while named projects keep exact scope and provenance', options, async t => {
  const f = await setup(t); const base = f.service.resolveSource; const stamps = { default:'2026-01-01T00:00:00Z',a:'2026-01-01T00:00:00Z',b:'2026-01-01T00:00:00Z' };
  f.service.resolveSource = async (c,ctx) => stamps[c.projectId] ? { ...await base(c,ctx),projectCreatedAt:stamps[c.projectId],projectTitle:`Project ${c.projectId}` } : null;
  for (const id of ['a','b']) { const record = await f.commitConversation(id,[{ role:'user',text:`${id} project trial facts` }],{projectId:id}); await f.service.ingestArchive({...f.commit,projectId:id,engineSession:record.session,archiveUri:record.archive_uri},f.context); }
  const global = await search(f); assert.deepEqual(new Set(global.map(h=>h.projectId)),new Set(['a','b'])); assert.ok(global.every(h=>h.scope==='project'&&h.projectTitle));
  const named = await f.service.search({user:{id:f.userId},project:{id:'a',userId:f.userId},query:'trial',scope:'account',owner:'someone-else'});
  assert.deepEqual(named.map(h=>h.projectId),['a']);
  stamps.b = '2027-01-01T00:00:00Z'; assert.deepEqual((await search(f)).map(h=>h.projectId),['a']);
  delete stamps.a; assert.deepEqual(await search(f),[]);
});

test('pausing learning does not disable recall or change an original message provenance index', options, async t => {
  const f = await setup(t);
  const record = await f.commitConversation('admission',[
    {role:'user',text:'Old message withheld at capture.'},
    {role:'user',text:'Keep the retained trial result.'},
    {role:'assistant',text:'Assistant proposed a weekly summary.'},
  ],{projectId:'default'});
  f.service.admitMessage = async (_ctx,_source,message)=>!String(message.parts?.[0]?.text??message.content).startsWith('Old');
  await f.service.ingestArchive({...f.commit,engineSession:record.session,archiveUri:record.archive_uri},f.context);
  f.service.admitMessage = async ()=>false;
  const hits=await search(f); assert.equal(hits.length,1);
  assert.deepEqual(hits[0].messages.map(m=>m.index),[1,2]); assert.deepEqual(hits[0].messages.map(m=>m.sourceRole),['user','assistant']);
});

test('unavailable rejection metadata never returns an unfiltered raw hit', options, async t => {
  const f=await setup(t); await f.service.ingestArchive(f.commit,f.context);
  f.ledger.rejected=async()=>{throw new Error('privacy metadata unavailable');};
  await assert.rejects(search(f),/privacy metadata unavailable/);
});

test('deterministic history capacity settles native extraction and cannot starve the next commit over two bounded passes', options, async t => {
  const f=await setup(t); f.worker.history=f.service;
  f.worker.memoryContexts={forUri:async()=>f.context,assertKnown:async()=>{}};
  const next=await f.commitConversation('after-capacity',[{role:'user',text:'A later ordinary trial update.'}],{projectId:'default'});
  await f.database.query("UPDATE evimed_memory.native_commits SET created_at=created_at-interval '1 minute' WHERE user_id=$1 AND archive_uri=$2",[f.userId,f.commit.archiveUri]);
  const read=f.context.sessions.read.bind(f.context.sessions); let oversizedReads=0;
  const oversized=JSON.stringify({role:'user',content:'界'.repeat(666668)});
  f.context.sessions.read=async(owner,uri,options)=>{
    if(uri===`${f.commit.archiveUri}/messages.jsonl`){oversizedReads++;return oversized;}
    return read(owner,uri,options);
  };
  const passes=[await f.worker.processCommits({userId:f.userId,limit:1}),await f.worker.processCommits({userId:f.userId,limit:1})];
  assert.deepEqual(passes,[1,1]); assert.equal(oversizedReads,1);
  assert.equal((await f.overlay.commit(f.userId,f.commit.archiveUri)).state,'completed');
  assert.equal((await f.overlay.commit(f.userId,next.archive_uri)).state,'completed');
  const coverage=await f.service.coverage(f.userId); assert.equal(coverage.partial,1);assert.equal(coverage.complete,1);
  assert.equal((await f.overlay.openCommits({userId:f.userId})).length,0);
});

test('an untyped resource error resembling a capacity reason remains a retryable unavailable history failure', options, async t => {
  const f=await setup(t); f.worker.history=f.service;
  f.worker.memoryContexts={forUri:async()=>f.context,assertKnown:async()=>{}};
  f.resources.writeHistory=async()=>{throw Object.assign(new Error('provider unavailable'),{code:'memory_history_archive_too_large'});};
  await f.worker.processCommits({userId:f.userId});
  assert.equal((await f.overlay.commit(f.userId,f.commit.archiveUri)).state,'completed','the commit settles before the optional index');
  const coverage=await f.service.coverage(f.userId);assert.equal(coverage.unavailable,1);assert.equal(coverage.partial,0);
});

test('a withdrawn chunk whose removal was proven is re-checked a few times, not hourly forever', options, async t => {
  const f = await setup(t); await f.service.ingestArchive(f.commit, f.context);
  await f.service.removeConversation(f.context, 'session_a');
  for (let pass = 0; pass < 6; pass++) {
    await f.database.query("UPDATE evimed_memory.history_chunks SET cleaned_at=cleaned_at-interval '2 hours',lease_until=NULL WHERE state='withdrawn' AND cleaned_at IS NOT NULL");
    await f.service.drainDeletes();
  }
  const row = (await f.database.query("SELECT max(sweeps)::int AS sweeps FROM evimed_memory.history_chunks WHERE state='withdrawn'")).rows[0];
  assert.ok(row.sweeps >= 1 && row.sweeps <= 3, `sweeps stop at the cap (${row.sweeps})`);
});

test('a shared GEO namespace is never indexed as raw history, and nothing is returned for it', options, async t => {
  const f = await setup(t); const shared = { ...f.context, kind: 'geo-project' };
  await f.service.ingestArchive(f.commit, shared);
  assert.equal(f.files.size, 0);
  assert.deepEqual((await f.database.query('SELECT state,reason FROM evimed_memory.history_archives WHERE archive_uri=$1', [f.commit.archiveUri])).rows, [{ state: 'excluded', reason: 'shared_namespace' }], 'terminal, so the backfill never claims it again');
  f.service.contexts = { async forProject() { return shared; } };
  assert.deepEqual(await search(f), []);
});

test('existing-line verification recovers a planted corruption through product raw-history search and original archive roles', options, async t => {
  const f = await setup(t);
  await f.service.ingestArchive(f.commit, f.context);
  f.config.nativeMemoryConsolidationEnabled = true;
  f.config.nativeMemoryConsolidationMode = 'verify';
  f.worker.verification.history = f.service;
  const uri = f.seed('profile.md', 'I prefer trial charts.');
  let calls = 0;
  f.worker.verification.judge = { judge: async ({ lines }) => {
    calls++;
    assert.equal(lines[0].sources[0].role, 'user');
    assert.equal(lines[0].sources[0].text, 'I prefer trial tables.');
    assert.equal(lines[0].sources[1].role, 'assistant');
    return { calls: 1, results: new Map([[0, { index: 0, verdict: 'corrected', corrected: lines[0].sources[0].text }]]) };
  } };
  const result = await f.consolidation.verifyExisting(f.userId, { limit: 10 });
  assert.deepEqual(result, { checked: 1, supported: 0, corrected: 1, unsupported: 0, unverifiable: 0, calls: 1 });
  assert.equal(calls, 1);
  assert.equal(await f.sessions.read(f.userId, uri), 'I prefer trial tables.');
  assert.ok(f.calls.some(call => call[0] === 'vector+keyword'));
  const [revision] = await f.overlay.revisionsOf(f.userId, uri);
  assert.equal(revision.reason, 'verification_corrected');
  assert.equal(revision.before, 'I prefer trial charts.');
  // A deleted source cannot support a later plant, even if its old index bytes remain.
  await f.service.removeConversation(f.context, 'session_a');
  await f.sessions.replace(f.userId, uri, 'I prefer trial charts.');
  const fenced = await f.consolidation.verifyExisting(f.userId, { limit: 10 });
  assert.equal(fenced.unverifiable, 1);
  assert.equal(calls, 1);
});
