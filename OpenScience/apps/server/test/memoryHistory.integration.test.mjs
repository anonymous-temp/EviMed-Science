import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryHistory, MemoryHistoryLedger } from '../src/memoryHistory.mjs';
import { nativeFileId } from '../src/nativeMemoryStore.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { OpenVikingResources } from '../src/openVikingResources.mjs';
import { projectNativeMemoryNamespace } from '../src/openVikingLayout.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMemoryGatewayHandler, parseEventStream } from '../src/memoryGateway.mjs';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
const { options, fixture } = nativeIntegration();

async function setup(t, retrievalV2 = false) {
  const f = await fixture(t);
  // Backfill scans the shared test database. Finished fixtures must not occupy its four-row lease
  // window and be resolved through the next test's separate stub engine.
  t.after(() => f.database.query('DELETE FROM evimed_control.users WHERE id=$1', [f.userId]));
  const files = new Map(); const calls = []; let failWrite = false; let failRemove = false; let duringWrite = null;
  const resources = {
    async writeHistory(_owner, uri, content) { new OpenVikingResources({client:{}}).historyAddress(uri,{file:true}); calls.push(['write', uri]); if (failWrite) throw new Error('write unavailable'); files.set(uri, content); if (duringWrite) await duringWrite(); },
    async searchHistory(_owner, root, query) { calls.push(['vector+keyword', root, query]); return [...files.keys(), 'viking://user/alien/resources/history/forged.md'].map(uri => ({ uri, score: 1 })); },
    async readHistory(_owner, uri) { calls.push(['read', uri]); return files.get(uri) ?? null; },
    async removeSource(_owner, uri) { if (failRemove) throw new Error('delete unavailable'); files.delete(uri); },
  };
  const stamp = (await f.database.query('SELECT created_at::text AS stamp FROM evimed_control.users WHERE id=$1', [f.userId])).rows[0].stamp;
  const context = { kind: 'owned', ownerId: f.userId, ownerCreatedAt: stamp, namespaceId: f.engineUser, userRoot: f.sessions.userRoot(f.userId), projectId: 'default', sessions: f.sessions };
  const ledger = new MemoryHistoryLedger({ database: f.database, overlay: f.overlay });
  ledger.removeResource = row => resources.removeSource(row.owner_id, row.uri);
  const service = new MemoryHistory({ config: { memoryHistorySearchEnabled: true, memoryHistoryRetrievalV2Enabled:retrievalV2 }, ledger, contexts: { async forUri() { return context; }, async forProject(p) { return { ...context, projectId: p.id }; } },
    resourcesFor: () => resources, resolveSource: async (c, _ctx) => ({ projectId: c.projectId, projectCreatedAt: '2026-01-01T00:00:00Z', sessionId: c.engineSession?.slice(4), conversationTitle: 'Kidney trial', conversationUrl: '/app/projects/default?session=session_a' }),
    eligible: async () => true, admitMessage: async () => true,
  });
  const archive = await f.commitConversation('a', [{ role: 'user', text: 'I prefer trial tables.', at: '2026-01-02T00:00:00.000Z' }, { role: 'assistant', text: 'I suggest weekly analyses.' }], { projectId: 'default' });
  const commit = { userId: f.userId, projectId: 'default', engineSession: archive.session, archiveUri: archive.archive_uri, origin: 'gateway' };
  return { ...f, context, ledger, service, files, calls, commit, resources, failWrites: x => { failWrite = x; }, failDeletes: x => { failRemove = x; }, onWrite: x => { duringWrite = x; } };
}
const search = f => f.service.search({ user: { id: f.userId }, project: { id: 'default', userId: f.userId }, query: 'trial', limit: 5 });

test('account erasure drops history matching metadata but retains physical cleanup obligations', options, async t => {
  const f = await setup(t);
  await f.service.ingestArchive(f.commit, f.context);
  const values = [f.userId, f.context.ownerCreatedAt, f.context.namespaceId, f.commit.archiveUri];
  await f.database.query(`INSERT INTO evimed_memory.history_message_rejections
    (owner_id,owner_created_at,namespace_id,memory_type,fingerprint,archive_uri,message_hash)
    VALUES($1,$2,$3,'notes','fingerprint',$4,'message')`, values);
  await f.database.query(`INSERT INTO evimed_memory.history_write_messages
    (owner_id,owner_created_at,namespace_id,archive_uri,message_hash) VALUES($1,$2,$3,$4,'message')`, values);
  await f.database.query(`INSERT INTO evimed_memory.history_secret_salts(owner_id,owner_created_at,salt)
    VALUES($1,$2,'synthetic-test-salt')`, values.slice(0, 2));
  await f.database.query(`INSERT INTO evimed_memory.history_secrets(owner_id,owner_created_at,archive_uri,fingerprint,length)
    VALUES($1,$2,$3,'synthetic-fingerprint',10)`, [f.userId, f.context.ownerCreatedAt, f.commit.archiveUri]);
  await f.ledger.queueWriteSession(f.context, `${f.context.userRoot}/sessions/evimed-page-erased`);
  await f.service.eraseAccount(f.userId);
  await f.database.query('DELETE FROM evimed_control.users WHERE id=$1', [f.userId]);
  for (const table of ['history_message_rejections', 'history_write_messages', 'history_secret_salts', 'history_secrets']) {
    assert.equal((await f.database.query(`SELECT count(*)::int AS n FROM evimed_memory.${table} WHERE owner_id=$1`, [f.userId])).rows[0].n, 0, table);
  }
  for (const table of ['history_fences', 'history_chunks', 'history_archives', 'history_write_session_deletes']) {
    assert.ok((await f.database.query(`SELECT count(*)::int AS n FROM evimed_memory.${table} WHERE owner_id=$1`, [f.userId])).rows[0].n > 0, table);
  }
  await assert.rejects(f.database.query(`INSERT INTO evimed_memory.history_write_messages
    (owner_id,owner_created_at,namespace_id,archive_uri,message_hash) VALUES($1,$2,$3,$4,'late')`, values), { code: '23503' });
});

test('V2 search honors requested limits through the registry, diversifies and removes repeated source messages; off is identical', options, async t => {
  const f=await setup(t);
  const ingest=async (id,messages)=>{
    const archive=await f.commitConversation(id,messages,{projectId:'default'});
    await f.service.ingestArchive({userId:f.userId,projectId:'default',engineSession:archive.session,archiveUri:archive.archive_uri},f.context);
  };
  await ingest('many',Array.from({length:24},(_,i)=>({role:i%2?'assistant':'user',text:`trial exchange ${i}: measured ${i} samples.`})));
  for(let i=0;i<22;i++)await ingest(`other${i}`,[{role:'user',text:`trial observation ${i}`}]);
  const request={user:{id:f.userId},project:{id:'default',userId:f.userId},query:'trial',limit:20};
  const before=await f.service.search(request);
  assert.equal(before.length,8);assert.ok(before.every(h=>h.sessionId==='session_many'));
  f.service.config.memoryHistoryRetrievalV2Enabled=true;
  const after=await f.service.search(request);
  assert.equal(after.length,20);assert.equal(after.filter(h=>h.sessionId==='session_many').length,2);
  const keys=after.flatMap(h=>h.messages.map(m=>`${h.sessionId}:${m.index}:${m.text}`));
  assert.equal(new Set(keys).size,keys.length);
  assert.ok(after.reduce((sum,h)=>sum+h.messages.reduce((n,m)=>n+m.text.length+80,160),0)<=48_000);
  f.service.config.memoryHistoryRetrievalV2Enabled=false;
  assert.deepEqual(await f.service.search(request),before);
});

for (const boundary of ['rejection','fence','changed source','secret review','revoked source']) {
  test(`V2 candidate path preserves ${boundary} boundary`,options,async t=>{
    const f=await setup(t,true);await f.service.ingestArchive(f.commit,f.context);
    assert.equal((await search(f)).length,1);
    if(boundary==='rejection')await f.overlay.reject(f.userId,'preferences',`${f.root}/preferences/a.md`,['I prefer trial tables.']);
    if(boundary==='fence')await f.service.removeConversation(f.context,'session_a');
    if(boundary==='revoked source')f.service.resolveSource=async c=>c.engineSession?null:{projectId:'default',projectCreatedAt:'2026-01-01T00:00:00Z'};
    if(boundary==='secret review')f.service.config.memoryHistorySecretRedactionEnabled=true;
    if(boundary==='changed source'){
      await f.sessions.client.request({method:'POST',path:`/api/v1/content/write`,userId:f.userId,body:{uri:`${f.commit.archiveUri}/messages.jsonl`,content:'changed',mode:'replace'}});
      await assert.rejects(search(f),/privacy_unavailable/);return;
    }
    assert.deepEqual(await search(f),[]);
  });
}

test('V2 clips and ranks only after applying the account secret filter',options,async t=>{
  const f=await setup(t,true);await f.service.ingestArchive(f.commit,f.context);
  f.service.config.memoryHistorySecretRedactionEnabled=true;
  f.ledger.secretReviewed=async()=>true;
  f.service.secrets.filterFor=async()=>text=>text.replaceAll('trial','[redacted]');
  const hits=await search(f);assert.equal(hits.length,1);
  assert.ok(!JSON.stringify(hits).includes('trial'));
  assert.match(hits[0].messages[0].text,/\[redacted\]/);
});

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


async function gateway(t, f, { secrets = false, capsuleSearch = null } = {}) {
  const handler = createMemoryGatewayHandler({ config: { memoryEngineEnabled: true, memoryEnabled: true, memoryHistorySearchEnabled: true, memoryHistorySecretRedactionEnabled: secrets },
    historySecrets: f.service.secrets, capsuleSearch,
    sessions: f.sessions, overlay: f.overlay, historySearch: input => f.service.search(input),
    runtimeManager: { assertActiveEviMedWorkloadToken: async () => ({ userId: f.userId, projectId: 'default' }) },
    store: { userById: async () => ({ id: f.userId }), requireProject: async () => ({ id: 'default', userId: f.userId }) },
    admission: { admit: async () => ({ learn: true, recall: true }) } });
  const server = createServer((req,res) => { void handler(req,res); }); server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (mcp = false, context = false, query = 'trial') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/internal/memory/v1/${mcp ? 'mcp' : 'api/v1/search/search'}`, {
      method: 'POST', headers: { authorization: 'Bearer history-test', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(mcp ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query } } } : { query, ...(context ? {mode:'context'} : {}) }),
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

test('secret redaction settles the native commit, indexes exact masked spans and stores fingerprints only', options, async t => {
  const f=await setup(t), password='paper crane amber 93', code='673921';
  f.service.config.memoryHistorySecretRedactionEnabled=true;
  let judged=0;
  f.service.secrets.judge={identify:async({messages})=>{
    judged++;return messages.some(m=>m.text.includes(password))?[password,code]:[];
  }};
  const record=await f.commitConversation('secrets',[
    {role:'user',text:`我用${password}登录邮箱；登录时输入${code}。普通编号673922，电话13812345678，邮箱a@example.org。`},
    {role:'assistant',text:`You supplied ${password}.`},
    {role:'user',text:`Again ${password}; keep my invoice 673922.`},
  ],{projectId:'default'});
  f.worker.history=f.service;f.worker.memoryContexts={forUri:async()=>f.context,assertKnown:async()=>{}};
  await f.worker.processCommits({userId:f.userId});
  assert.equal((await f.overlay.commit(f.userId,record.archive_uri)).state,'completed');
  const hits=(await search(f)).filter(hit=>hit.sessionId===record.session.slice(4));
  assert.ok(hits.length);const text=JSON.stringify(hits);
  assert.ok(!text.includes(password)&&!text.includes(code));assert.match(text,/已省略/);assert.match(text,/673922|13812345678|a@example.org/);
  assert.ok(![...f.files.values()].some(bytes=>bytes.includes(password)||bytes.includes(code)));
  const rows=(await f.database.query('SELECT * FROM evimed_memory.history_secrets WHERE owner_id=$1',[f.userId])).rows;
  assert.equal(rows.length,2);assert.ok(!JSON.stringify(rows).includes(password));assert.ok(rows.every(row=>row.fingerprint.length===64&&row.count===1));
  assert.equal(judged,2,'one review for each ordinary archive');
});

test('enabling secrets hides old history immediately; bounded backfill retires old chunks and retries failed judgement', options, async t => {
  const f=await setup(t),password='evening violet 82';
  const record=await f.commitConversation('legacy-secret',[{role:'user',text:`My mailbox credential is ${password}. Invoice 558234 remains.`}],{projectId:'default'});
  const c={...f.commit,archiveUri:record.archive_uri,engineSession:record.session};
  await f.worker.processCommits({userId:f.userId});
  await f.service.ingestArchive(c,f.context);assert.ok(JSON.stringify(await search(f)).includes(password));
  await f.database.query("UPDATE evimed_memory.history_archives SET commit_created_at='2026-01-02' WHERE owner_id=$1",[f.userId]);
  f.service.config.memoryHistorySecretRedactionEnabled=true;
  f.service.contexts.forUri=async()=>f.context;
  f.service.secrets.judge={identify:async()=>{throw new Error('model unavailable');}};
  assert.deepEqual(await search(f),[]);
  await f.service.backfill();assert.deepEqual(await search(f),[]);
  const row=(await f.database.query('SELECT state FROM evimed_memory.history_archives WHERE archive_uri=$1',[record.archive_uri])).rows[0];assert.equal(row.state,'unavailable');
  assert.equal((await f.overlay.commit(f.userId,record.archive_uri)).state,'completed');
  f.service.secrets.judge={identify:async({messages})=>messages.some(m=>m.text.includes(password))?[password]:[]};
  await f.database.query("UPDATE evimed_memory.history_archives SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1",[f.userId]);
  await f.service.backfill();await f.service.drainDeletes();
  const text=JSON.stringify(await search(f));assert.ok(!text.includes(password));assert.match(text,/已省略/);assert.match(text,/558234/);
  assert.ok(![...f.files.values()].some(bytes=>bytes.includes(password)));
});

test('switch off preserves original history bytes and never calls the semantic judge', options, async t => {
  const f=await setup(t);let calls=0;f.service.secrets.judge={identify:async()=>{calls++;throw new Error('must not run');}};
  await f.service.ingestArchive(f.commit,f.context);const before=[...f.files.values()];
  f.service.config.memoryHistorySecretRedactionEnabled=false;
  await f.service.ingestArchive(f.commit,f.context);assert.deepEqual([...f.files.values()],before);assert.equal(calls,0);
  assert.equal((await search(f))[0].messages[0].text,'I prefer trial tables.');
});


test('gateway filters listed secrets in memory JSON, capsule prose, raw history and context searches', options, async t => {
  const f=await setup(t),password='amber river 72';
  f.service.config.memoryHistorySecretRedactionEnabled=true;
  f.service.secrets.judge={identify:async({messages})=>messages.some(m=>m.text.includes(password))?[password]:[]};
  const record=await f.commitConversation('gateway-secret',[{role:'user',text:`My mailbox password is ${password}; retain trial tables.`}],{projectId:'default'});
  await f.service.ingestArchive({...f.commit,archiveUri:record.archive_uri,engineSession:record.session},f.context);
  f.seed('notes/legacy.md',`trial memory ${password}`);
  const capsuleSearch=async()=>[{factKind:'note',capsuleTitle:'Shared capsule',content:`capsule value ${password}`}];
  const call=await gateway(t,f,{secrets:true,capsuleSearch});
  const mcp=(await call(true)).text;assert.ok(!mcp.includes(password));assert.match(mcp,/已省略/);assert.match(mcp,/capsule value/);assert.match(mcp,/Original conversation/);
  const rest=(await call(false)).text;assert.ok(!rest.includes(password));assert.match(rest,/已省略/);
  const context=(await call(false,true)).text;assert.ok(!context.includes(password));assert.match(context,/已省略/);
  f.service.secrets.filterValue=async()=>{throw new Error('database unavailable');};
  await assert.rejects(call(true),/200/,'privacy failure never returns an unfiltered result');
});

for (const action of ['forget','edit','delete']) for (const hard of [true,false]) {
  test(`${action} fences original origin messages and neighbour windows (${hard?'hard tokens':'semantic'}), and undo lifts it`,options,async t=>{
    const f=await setup(t);
    const removed=hard?'The locker code is F-25429 (2026-11-10 user supplied).':'Prefers comparisons displayed as tables.';
    const original=hard?'My locker is F-25429, please keep that handy.':'I like seeing comparisons laid out in tables.';
    const archive=await f.commitConversation('removed',[{role:'user',text:original,at:'2026-11-10T08:00:00Z'},{role:'assistant',text:'Independent nearby response.'}],{projectId:'default'});
    const commit={...f.commit,engineSession:archive.session,archiveUri:archive.archive_uri};
    await f.service.ingestArchive(commit,f.context);
    const other=await f.commitConversation('unrelated',[{role:'user',text:hard?'The unrelated invoice is F-25429.':'I prefer walking outside.'}],{projectId:'default'});
    await f.service.ingestArchive({...f.commit,engineSession:other.session,archiveUri:other.archive_uri},f.context);
    const uri=f.seed('notes/removed.md',removed,{type:'notes'});
    await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'notes',body:removed});
    await f.overlay.syncOrigins(f.userId,uri,{after:removed,origin:{archiveUri:commit.archiveUri,engineSession:commit.engineSession,projectId:'default'}});
    f.store.history=f.service;
    f.store.memoryContexts={forUri:async()=>f.context,all:async()=>[f.context],assertUri:()=>{},assertKnown:async()=>{}};
    let judged=0;
    f.store.rejectionJudge={same:async request=>{judged++;assert.equal(request.originMessages,true);assert.equal(request.candidates.length,2);return {same:new Map([[0,lineFingerprint(removed)]]),stated:new Set()};}};
    // Avoid the independent duplicate-memory scan: this test measures history's one origin call.
    const file=(await f.store.files(f.userId)).find(row=>row.uri===uri);
    if(action==='edit') await f.store.update(f.userId,nativeFileId(uri),{value:'The new locker code is K-77777.',expectedVersion:(await f.store.getRecord(f.userId,nativeFileId(uri))).version});
    else await f.store.forgetFile(f.userId,file,{keepText:action==='forget'});
    const hits=await search(f);
    const call=await gateway(t,f);
    for(const mcp of [false,true]) assert.ok(!(await call(mcp)).text.includes(original),'both REST recall and MCP search withhold the original wording');
    if(action==='edit') for(const mcp of [false,true]) assert.match((await call(mcp,false,'K-77777')).text,/K-77777/,'the edited-in value remains searchable');
    assert.ok(hits.some(hit=>hit.sessionId==='session_unrelated'),'an unrelated conversation survives even with the same number');
    assert.ok(!hits.some(hit=>hit.sessionId==='session_removed'),'neighbour windows cannot disclose a withheld message');
    assert.equal(judged,0,'a bound line origin is fenced without guessing its wording');
    const fences=(await f.database.query('SELECT * FROM evimed_memory.history_message_rejections WHERE owner_id=$1',[f.userId])).rows;
    assert.equal(fences.length,2);assert.ok(fences.some(row=>row.message_hash===lineFingerprint(original)));assert.ok(!JSON.stringify(fences).includes(original));
    if(action==='delete') await f.overlay.unreject(f.userId,'notes',[removed]);
    else await f.store.undo(f.userId,nativeFileId(uri));
    assert.ok((await search(f)).some(hit=>hit.sessionId==='session_removed'));
    for(const mcp of [false,true]) assert.ok((await call(mcp)).text.includes(original),'undo lifts both surface fences');
    if(action==='edit') assert.equal(await f.sessions.read(f.userId,uri),removed);
    if(action==='forget') {
      await f.store.forgetFile(f.userId,(await f.store.files(f.userId)).find(row=>row.uri===uri),{keepText:true});
      assert.ok(!(await search(f)).some(hit=>hit.sessionId==='session_removed'),'a repeated forget after undo reinstates the original fence');
    }
  });
}

for(const prefix of ['evimed-page-','mcp-store-']) test(`${prefix} write archives are removed durably when their last memory is deleted`,options,async t=>{
  const f=await setup(t),text='Stored code F-25429.';
  const archive=await f.commitConversation('write',[{role:'user',text}],{projectId:'default',engineSession:`${prefix}testwrite`});
  const uri=f.seed('notes/write.md',text,{type:'notes'});
  await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'notes',body:text});
  await f.overlay.syncOrigins(f.userId,uri,{after:text,origin:{engineSession:archive.session,archiveUri:archive.archive_uri,projectId:'default'}});
  f.store.history=f.service;
  const file=(await f.store.files(f.userId)).find(row=>row.uri===uri);
  f.ledger.removeResource=async()=>{throw new Error('interrupted engine cleanup');};
  await f.store.forgetFile(f.userId,file,{keepText:true});
  const owed=(await f.database.query('SELECT * FROM evimed_memory.history_write_session_deletes WHERE owner_id=$1',[f.userId])).rows;
  assert.equal(owed.length,1);assert.ok(!owed[0].cleaned_at);
  // An interruption after the outbox commit leaves the same retry obligation.
  const ledger=new MemoryHistoryLedger({database:f.database,overlay:f.overlay,client:f.sessions.client});
  f.service.ledger=ledger;
  await f.service.drainDeletes(f.userId);
  assert.equal(await f.sessions.read(f.userId,`${archive.archive_uri}/messages.jsonl`),null);
  assert.ok((await f.database.query('SELECT cleaned_at FROM evimed_memory.history_write_session_deletes WHERE owner_id=$1',[f.userId])).rows[0].cleaned_at);
  await f.store.undo(f.userId,nativeFileId(uri));
  assert.equal(await f.sessions.read(f.userId,uri),text,'undo restores the memory without recreating an obsolete write session');
});

test('a remember-only origin fences the exact captured conversation copy without fencing another message with the same number',options,async t=>{
  const f=await setup(t),original='Please remember my locker is F-25429.',removed='Locker code is F-25429 (2026-11-10 supplied).';
  const stamp='2026-11-10T08:00:00Z';
  const source=await f.commitConversation('copy',[{role:'user',text:original,at:stamp}],{projectId:'default'});
  await f.service.ingestArchive({...f.commit,engineSession:source.session,archiveUri:source.archive_uri},f.context);
  const other=await f.commitConversation('othercopy',[{role:'user',text:'Invoice F-25429 is unrelated.',at:stamp}],{projectId:'default'});
  await f.service.ingestArchive({...f.commit,engineSession:other.session,archiveUri:other.archive_uri},f.context);
  const tool=await f.commitConversation('tool',[{role:'user',text:original,at:stamp}],{projectId:'default',engineSession:'mcp-store-copytest'});
  const uri=f.seed('notes/tool-copy.md',removed,{type:'notes'});
  await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'notes',body:removed});
  await f.overlay.syncOrigins(f.userId,uri,{after:removed,origin:{engineSession:tool.session,archiveUri:tool.archive_uri,projectId:'default'}});
  f.store.history=f.service;
  await f.store.forgetFile(f.userId,(await f.store.files(f.userId)).find(row=>row.uri===uri),{keepText:true});
  const hits=await search(f);assert.deepEqual(hits.map(hit=>hit.sessionId),['session_othercopy']);
  await f.store.undo(f.userId,nativeFileId(uri));assert.equal((await search(f)).length,2);
});

test('an edited-out identifier leaves the filename too, while the new value, undo and unchanged source origins survive',options,async t=>{
  const f=await setup(t),old='Locker code F-25429.',kept='Independent code G-12345.';
  const source=await f.commitConversation('filename',[{role:'user',text:'My locker is F-25429.'},{role:'user',text:'The other code is G-12345.'}],{projectId:'default'});
  const body=`${old}\n${kept}`,uri=f.seed('notes/locker F-25429.md',body,{type:'notes'});
  await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'notes',body});
  await f.overlay.syncOrigins(f.userId,uri,{after:body,origin:{engineSession:source.session,archiveUri:source.archive_uri,projectId:'default'}});
  f.store.history=f.service;
  const record=await f.store.getRecord(f.userId,nativeFileId(uri));
  const updated=await f.store.update(f.userId,record.id,{value:`Locker code K-77777.\n${kept}`,expectedVersion:record.version});
  assert.notEqual(updated.uri,uri);assert.ok(!updated.uri.includes('F-25429'));
  assert.equal(await f.sessions.read(f.userId,uri),null);assert.match(updated.value,/K-77777/);
  assert.ok((await f.overlay.originsOf(f.userId,[updated.uri])).get(updated.uri).has(lineFingerprint(kept)));
  await f.store.undo(f.userId,updated.id);
  assert.equal(await f.sessions.read(f.userId,updated.uri),body);
});

test('deletion also retires a no-op remember archive that repeated a conversation-derived line',options,async t=>{
  const f=await setup(t),text='Please remember my locker code F-25429.';
  const source=await f.commitConversation('noop-source',[{role:'user',text}],{projectId:'default'});
  const tool=await f.commitConversation('noop-tool',[{role:'user',text}],{projectId:'default',engineSession:'mcp-store-noopcopy'});
  // Both commits predate the hash index: deletion fills their provenance on demand.
  const uri=f.seed('notes/noop-source.md',text,{type:'notes'});
  await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'notes',body:text});
  await f.overlay.syncOrigins(f.userId,uri,{after:text,origin:{engineSession:source.session,archiveUri:source.archive_uri,projectId:'default'}});
  f.store.history=f.service;f.ledger.client=f.sessions.client;
  f.ledger.removeResource=MemoryHistoryLedger.prototype.removeResource.bind(f.ledger);
  await f.store.forgetFile(f.userId,(await f.store.files(f.userId)).find(row=>row.uri===uri),{keepText:true});
  assert.equal(await f.sessions.read(f.userId,`${tool.archive_uri}/messages.jsonl`),null);
  assert.ok(await f.sessions.read(f.userId,`${source.archive_uri}/messages.jsonl`),'the original conversation remains');
});

for(const action of ['forget','edit','delete']) for(const hard of [true,false]) for(const linked of [true,false]) {
  test(`remember-only ${action}, ${hard?'hard tokens':'semantic'}, ${linked?'bound conversation':'legacy lookup'} fences original words and undo lifts it`,options,async t=>{
    const f=await setup(t);
    await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Remember fixture',1048576)",[f.userId]);
    const removed=hard?'The cabinet code is Q-83194.':'Prefers study comparisons in adjacent columns.';
    const original=hard?'Please remember: my cabinet uses Q-83194.':'Please remember: I like studies compared side by side.';
    const archive=await f.commitConversation('person',[{role:'user',text:original},{role:'assistant',text:'An independent neighbour.'}],{projectId:'default'});
    await f.service.ingestArchive({...f.commit,archiveUri:archive.archive_uri,engineSession:archive.session},f.context);
    // Only the one-shot tool extraction writes a memory; the conversation's extraction writes none.
    const tool=await f.commitConversation('tool',[{role:'user',text:removed}],{projectId:'default',origin:'tool',engineSession:'mcp-store-rememberonly'});
    if(linked) await f.overlay.recordCommit({userId:f.userId,archiveUri:tool.archive_uri,engineSession:tool.session,projectId:'default',origin:'tool',sourceSession:archive.session});
    const uri=f.seed('notes/rememberonly.md',removed,{type:'notes'});
    await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'notes',body:removed});
    await f.overlay.syncOrigins(f.userId,uri,{after:removed,origin:{engineSession:tool.session,archiveUri:tool.archive_uri,projectId:'default'}});
    if(linked) assert.ok((await f.overlay.originsOf(f.userId,[uri])).get(uri).get(lineFingerprint(removed)).sources.some(source=>source.archiveUri===archive.archive_uri));
    f.store.history=f.service;
    f.store.memoryContexts={forUri:async()=>f.context,all:async()=>[f.context],assertUri:()=>{},assertKnown:async()=>{}};
    f.store.rejectionJudge={same:async request=>({same:new Map(request.candidates.flatMap((candidate,index)=>[removed,original].includes(candidate.text)?[[index,lineFingerprint(removed)]]:[])),stated:new Set()})};
    if(action==='edit') await f.store.update(f.userId,nativeFileId(uri),{value:'A new unrelated memory.',expectedVersion:(await f.store.getRecord(f.userId,nativeFileId(uri))).version});
    else await f.store.forgetFile(f.userId,(await f.store.files(f.userId)).find(row=>row.uri===uri),{keepText:action==='forget'});
    const call=await gateway(t,f);
    for(const mcp of [false,true]) assert.ok(!(await call(mcp)).text.includes(original));
    const fences=(await f.database.query('SELECT * FROM evimed_memory.history_message_rejections WHERE owner_id=$1',[f.userId])).rows;
    assert.ok(fences.some(row=>row.archive_uri===archive.archive_uri&&row.message_hash===lineFingerprint(original)));
    if(action==='delete') await f.overlay.unreject(f.userId,'notes',[removed]);else await f.store.undo(f.userId,nativeFileId(uri));
    for(const mcp of [false,true]) assert.ok((await call(mcp)).text.includes(original));
  });
}

test('remember binds a conversation archived later and repairs a lost copy edge without crossing a project incarnation',options,async t=>{
  const f=await setup(t);
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Later source',1048576)",[f.userId]);
  const tool=await f.commitConversation('earlytool',[{role:'user',text:'Cabinet T-28464.'}],{origin:'scan',engineSession:'mcp-store-early'});
  await f.overlay.recordCommit({userId:f.userId,archiveUri:tool.archive_uri,engineSession:tool.session,projectId:'default',origin:'tool',sourceSession:'dsh-later'});
  const uri=f.seed('notes/later.md','Cabinet T-28464.',{type:'notes'});
  await f.overlay.syncOrigins(f.userId,uri,{after:'Cabinet T-28464.',origin:{engineSession:tool.session,archiveUri:tool.archive_uri,projectId:'default'}});
  const source=await f.commitConversation('later',[{role:'user',text:'Please remember my cabinet T-28464.'}],{projectId:'default',engineSession:'dsh-later'});
  const origins=async()=>[...((await f.overlay.originsOf(f.userId,[uri])).get(uri).values())][0].sources??[];
  assert.ok((await origins()).some(origin=>origin.archiveUri===source.archive_uri));
  const snapshot=await origins();assert.doesNotThrow(()=>JSON.stringify(snapshot),'inherited origins can be persisted by merge and undo');
  await f.database.query('DELETE FROM evimed_memory.native_source_copies WHERE user_id=$1',[f.userId]);
  await f.ledger.registerWriteMessages(f.context,tool.archive_uri,['Cabinet T-28464.']);
  assert.ok((await origins()).some(origin=>origin.archiveUri===source.archive_uri),'archive ingestion repairs a crash between commit and edge registration');
  await f.database.query("UPDATE evimed_control.projects SET created_at=created_at+interval '1 second' WHERE user_id=$1 AND id='default'",[f.userId]);
  const reused=source.archive_uri.replace('archive_001','archive_002');
  await f.overlay.recordCommit({userId:f.userId,archiveUri:reused,engineSession:'dsh-later',projectId:'default',origin:'gateway'});
  assert.ok(!(await origins()).some(origin=>origin.archiveUri===reused),'a reused session in a new project incarnation does not inherit the old binding');
});

for(const hard of [true,false]) test(`forget before the calling conversation archives still fences its later words (${hard?'hard tokens':'semantic'})`,options,async t=>{
  const f=await setup(t);
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Pending conversation',1048576)",[f.userId]);
  const removed=hard?'Cabinet D-54183.':'Prefers study comparisons in adjacent columns.';
  const original=hard?'Please remember my cabinet is D-54183.':'Please remember that I like studies compared side by side.';
  const tool=await f.commitConversation('unarchivedtool',[{role:'user',text:removed}],{projectId:'default',origin:'tool',engineSession:'mcp-store-unarchived'});
  await f.overlay.recordCommit({userId:f.userId,archiveUri:tool.archive_uri,engineSession:tool.session,projectId:'default',origin:'tool',sourceSession:'dsh-delayed'});
  const uri=f.seed('notes/unarchived.md',removed,{type:'notes'});
  await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'notes',body:removed});
  await f.overlay.syncOrigins(f.userId,uri,{after:removed,origin:{engineSession:tool.session,archiveUri:tool.archive_uri,projectId:'default'}});
  f.store.history=f.service;
  const judge={same:async request=>({same:new Map(request.candidates.flatMap((candidate,index)=>[removed,original].includes(candidate.text)?[[index,lineFingerprint(removed)]]:[])),stated:new Set()})};
  f.store.rejectionJudge=judge;f.service.rejectionJudge=judge;
  await f.store.forgetFile(f.userId,(await f.store.files(f.userId)).find(row=>row.uri===uri),{keepText:true});
  assert.equal((await f.ledger.boundRejections(f.context,`${f.context.userRoot}/sessions/dsh-delayed`)).length,1);
  const source=await f.commitConversation('delayed',[{role:'user',text:original}],{projectId:'default',engineSession:'dsh-delayed'});
  const commit={...f.commit,archiveUri:source.archive_uri,engineSession:source.session};
  await f.service.ingestArchive(commit,f.context);
  assert.equal(await f.ledger.rejected(f.context,[original],source.archive_uri),true);
  assert.ok(!(await search(f)).some(hit=>hit.sessionId==='delayed'));
  await f.store.undo(f.userId,nativeFileId(uri));
  assert.equal(await f.ledger.rejected(f.context,[original],source.archive_uri),false);
  await f.service.ingestArchive(commit,f.context);
  assert.ok((await search(f)).some(hit=>hit.sessionId==='delayed'));
});

test('legacy lookup judges redacted text but fences the complete original message hash',options,async t=>{
  const f=await setup(t),password='amber river 72';
  f.service.config.memoryHistorySecretRedactionEnabled=true;
  f.service.secrets.judge={identify:async({messages})=>messages.some(message=>message.text.includes(password))?[password]:[]};
  const original=`Please remember that studies should appear in adjacent columns. My mailbox password is ${password}.`;
  const removed='Prefers studies compared in adjacent columns.';
  const source=await f.commitConversation('redactedsource',[{role:'user',text:original}],{projectId:'default'});
  await f.service.ingestArchive({...f.commit,archiveUri:source.archive_uri,engineSession:source.session},f.context);
  const tool=await f.commitConversation('redactedtool',[{role:'user',text:removed}],{projectId:'default',engineSession:'mcp-store-redacted'});
  const uri=f.seed('notes/redacted-remember.md',removed,{type:'notes'});
  await f.overlay.upsertFile({userId:f.userId,uri,memoryType:'notes',body:removed});
  await f.overlay.syncOrigins(f.userId,uri,{after:removed,origin:{engineSession:tool.session,archiveUri:tool.archive_uri,projectId:'default'}});
  f.store.history=f.service;
  f.store.rejectionJudge={same:async request=>{
    assert.ok(!JSON.stringify(request).includes(password),'history lookup never sends a redacted credential to the removal judge');
    return {same:new Map(request.candidates.flatMap((candidate,index)=>candidate.text.includes('studies')?[[index,lineFingerprint(removed)]]:[])),stated:new Set()};
  }};
  await f.store.forgetFile(f.userId,(await f.store.files(f.userId)).find(row=>row.uri===uri),{keepText:true});
  const fences=(await f.database.query('SELECT message_hash FROM evimed_memory.history_message_rejections WHERE owner_id=$1 AND archive_uri=$2',[f.userId,source.archive_uri])).rows;
  assert.ok(fences.some(row=>row.message_hash===lineFingerprint(original)));
  assert.ok(!(await search(f)).some(hit=>hit.sessionId==='session_redactedsource'));
  await f.store.undo(f.userId,nativeFileId(uri));
  const restored=JSON.stringify(await search(f));assert.match(restored,/studies should appear/);assert.ok(!restored.includes(password));
});

test('a retried remember extraction retains the calling conversation and its deletion fence',options,async t=>{
  const f=await setup(t),text='Cabinet R-48271.',original='Please remember my cabinet R-48271.';
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Replay conversation',1048576)",[f.userId]);
  const source=await f.commitConversation('replaycaller',[{role:'user',text:original}],{projectId:'default'});
  await f.service.ingestArchive({...f.commit,archiveUri:source.archive_uri,engineSession:source.session},f.context);
  const uri=`${f.root}/notes/replayed-remember.md`;
  f.stub.extract=({session})=>session.startsWith('mcp-store-')?'fail':{adds:[{uri,memory_type:'notes',after:text}]};
  const tool=await f.commitConversation('retrytool',[{role:'user',text}],{projectId:'default',origin:'tool',engineSession:'mcp-store-retrytool'});
  await f.overlay.recordCommit({userId:f.userId,archiveUri:tool.archive_uri,engineSession:tool.session,projectId:'default',origin:'tool',sourceSession:source.session});
  await f.worker.processCommits({userId:f.userId});f.advance(3_600_000);
  await f.worker.processCommits({userId:f.userId});await f.worker.processCommits({userId:f.userId});
  const replay=(await f.overlay.commitsOf(f.userId)).find(commit=>commit.origin==='replay');
  assert.equal(replay.sourceSession,source.session);
  const origins=(await f.overlay.originsOf(f.userId,[uri])).get(uri).get(lineFingerprint(text));
  assert.ok(origins.sources.some(origin=>origin.archiveUri===source.archive_uri));
  await f.database.query("UPDATE evimed_memory.native_commits SET origin='scan' WHERE user_id=$1 AND archive_uri=$2",[f.userId,replay.archiveUri]);
  await f.database.query('DELETE FROM evimed_memory.native_source_copies WHERE user_id=$1 AND copy_archive_uri=$2',[f.userId,replay.archiveUri]);
  await f.overlay.linkSourceCopies(f.userId,replay.archiveUri);
  assert.ok((await f.overlay.originsOf(f.userId,[uri])).get(uri).get(lineFingerprint(text)).sources.some(origin=>origin.archiveUri===source.archive_uri));
  f.store.history=f.service;
  await f.store.forgetFile(f.userId,(await f.store.files(f.userId)).find(file=>file.uri===uri),{keepText:true});
  assert.ok(!(await search(f)).some(hit=>hit.sessionId==='session_replaycaller'));
});

for (const spelling of ['M-31025', 'ｍ＿３１０２５', 'm 31025']) {
  test(`page removal fences the original remember conversation with an extraction-added minute (${spelling}), while a new conversation remains recallable`, options, async t => {
    const f = await setup(t); f.store.history = f.service;
    const at = '2026-11-11T03:30:01.687Z', fresh = '2099-01-01T03:30:00.000Z';
    const text = `Please remember: I parked at ${spelling}.`;
    const archive = await f.commitConversation('parked', [{ role: 'user', text, at }], { projectId: 'default' });
    const commit = { userId: f.userId, projectId: 'default', engineSession: archive.session, archiveUri: archive.archive_uri, origin: 'gateway' };
    await f.service.ingestArchive(commit, f.context);
    const tool = await f.commitConversation('tool-parked', [{ role: 'user', text, at }], { projectId: 'default', engineSession: 'mcp-store-parked', origin: 'tool' });
    await f.worker.processCommits({ userId: f.userId });
    const body = '- Parked at M-31025 (2026-11-11 03:30).\n- Bring an umbrella.';
    const uri = f.seed('notes/parking.md', body, { type: 'notes' });
    await f.overlay.syncOrigins(f.userId, uri, { after: body, origin: { archiveUri: tool.archive_uri, engineSession: tool.session, projectId: 'default' } });
    const record = await f.store.getRecord(f.userId, nativeFileId(uri));
    await f.store.update(f.userId, record.id, { value: '- Bring an umbrella.', expectedVersion: record.version });
    const request = { user: { id: f.userId }, project: { id: 'default', userId: f.userId }, query: 'M-31025', limit: 20 };
    assert.deepEqual(await f.service.search(request), [], 'the old conversation is fenced before any restatement');
    const fences = (await f.database.query('SELECT archive_uri FROM evimed_memory.history_message_rejections WHERE owner_id=$1', [f.userId])).rows;
    assert.ok(fences.some(row => row.archive_uri === archive.archive_uri));
    const next = await f.commitConversation('parked-new', [{ role: 'user', text, at: fresh }], { projectId: 'default' });
    await f.service.ingestArchive({ ...commit, engineSession: next.session, archiveUri: next.archive_uri }, f.context);
    const hits = await f.service.search(request);
    assert.ok(hits.length > 0);
    assert.ok(hits.every(hit => hit.sessionId === next.session.slice(4)), 'only the new conversation supplies restated words');
    assert.equal((await f.service.search({ ...request, query: 'umbrella' })).some(hit => hit.sessionId === archive.session.slice(4)), false);
  });
}
test('settling an unstored forget request fences both earlier raw history and its not-yet-indexed current archive', options, async t => {
  const f = await setup(t);
  const { NativeMemoryWorker } = await import('../src/nativeMemoryWorker.mjs');
  f.stub.files.set(`${f.commit.archiveUri}/messages.jsonl`, JSON.stringify({ role: 'user', content: 'My old project is M-41633.', created_at: '2026-01-01T00:00:00Z' }));
  await f.service.ingestArchive(f.commit, f.context);
  assert.ok((await search(f)).some(hit => JSON.stringify(hit).includes('M-41633')));
  f.store.history = f.service;
  const archive = await f.commitConversation('forget-unstored', [{ role: 'user', text: 'Forget M-41633.', at: '2026-01-02T00:00:00Z' }], { projectId: 'default' });
  const worker = new NativeMemoryWorker({ ...f, config: { ...f.config, memoryForgetRequestCheckEnabled: true }, nativeMemory: f.store,
    forgetRequestJudge: { check: async ({ conversation }) => conversation.some(row => row.text === 'Forget M-41633.')
      ? { requests: [{ message: 0, quote: 'Forget M-41633.', decision: 'remove', targets: [], intents: [{ message: 0, quote: 'M-41633' }] }], claims: [] }
      : { requests: [], claims: [] } } });
  await worker.processCommits({ userId: f.userId });
  const commit = await f.overlay.commit(f.userId, archive.archive_uri);
  assert.equal(commit.extraction.forgetRequests.requests[0].status, 'completed');
  await f.service.ingestArchive(commit, f.context);
  const hits = await search(f);
  assert.ok(!JSON.stringify(hits).includes('M-41633'));
  const fences = (await f.database.query('SELECT archive_uri FROM evimed_memory.history_message_rejections WHERE owner_id=$1', [f.userId])).rows;
  assert.ok(fences.some(row => row.archive_uri === archive.archive_uri));
  assert.ok(fences.some(row => row.archive_uri === f.commit.archiveUri));
});

for (const pending of [false, true]) {
  test(`withdrawal wording and its acknowledgement cannot recall a partial detail; confirmation=${pending}, undo restores recall`, options, async t => {
    const f = await setup(t, true);
    const { NativeMemoryWorker } = await import('../src/nativeMemoryWorker.mjs');
    const fact = 'The badminton schedule belongs to project M-41633.';
    const request = 'Forget that badminton arrangement.';
    const uri = f.seed('notes/arrangement.md', fact);
    f.store.history = f.service;
    const archive = await f.commitConversation('partial-request', [
      { role: 'user', text: request }, { role: 'assistant', text: 'The badminton arrangement is forgotten.' },
      { role: 'user', text: 'Keep the independent research plan.' }, { role: 'assistant', text: 'The research plan remains.' },
    ], { projectId: 'default' });
    const worker = new NativeMemoryWorker({ ...f, config: { ...f.config, memoryForgetRequestCheckEnabled: true }, nativeMemory: f.store,
      forgetRequestJudge: { check: async ({ candidates, conversation }) => conversation.some(row => row.text === request)
        ? { requests: [{ message: 0, quote: request, decision: pending ? 'uncertain' : 'remove',
          targets: candidates.flatMap((candidate, index) => candidate.text === fact ? [index] : []), intents: [] }], claims: [] }
        : { requests: [], claims: [] } } });
    await worker.processCommits({ userId: f.userId });
    const commit = await f.overlay.commit(f.userId, archive.archive_uri);
    await f.service.ingestArchive(commit, f.context);
    if (pending) {
      assert.ok(JSON.stringify(await search(f)).includes('badminton'));
      const item = (await f.store.pending(f.userId)).find(row => row.state === 'confirmation');
      await f.store.resolveForgetRequest(f.userId, item.id, { action: 'confirm', choices: [0] });
    }
    assert.equal(await f.sessions.read(f.userId, uri), null);
    const hits = JSON.stringify(await search(f));
    assert.ok(!hits.includes('badminton'));
    assert.equal(await f.ledger.rejected(f.context, ['Keep the independent research plan.'], archive.archive_uri), false);
    assert.ok((await f.sessions.read(f.userId, `${archive.archive_uri}/messages.jsonl`)).includes('independent research plan'));
    const forgotten = (await f.store.profile(f.userId)).records.find(row => row.status === 'archived' && row.value === fact);
    await f.store.update(f.userId, forgotten.id, { status: 'active', expectedVersion: forgotten.version });
    assert.equal(await f.ledger.rejected(f.context, [request], archive.archive_uri), false);
    await f.service.ingestArchive(commit, f.context);
    assert.ok(JSON.stringify(await search(f)).includes('badminton'));
  });
}

for (const restoreIntent of [false, true]) test(`forgetting a dated paraphrase fences the original statement and undo lifts both authorities; intent=${restoreIntent}`, options, async t => {
  const f = await setup(t, true);
  const { NativeMemoryWorker } = await import('../src/nativeMemoryWorker.mjs');
  const original = '我上个月临时替同事值了2次夜班';
  const wrapped = '用户 2026-03-28 提到上个月临时替同事值了 2 次夜班，随后要求忘掉；该条不保留。';
  const uri = f.seed('notes/plan.md', `- ${wrapped}\n- Independent plan.`);
  f.store.history = f.service;
  const archive = await f.commitConversation('wrapped-history', [
    { role: 'user', text: original, at: '2026-03-28T13:52:51.000Z' },
    { role: 'user', text: 'Forget that detail.', at: '2026-03-28T13:52:53.000Z' },
  ], { projectId: 'default' });
  const worker = new NativeMemoryWorker({ ...f, config: { ...f.config, memoryForgetRequestCheckEnabled: true }, nativeMemory: f.store,
    forgetRequestJudge: { check: async ({ candidates, conversation }) => conversation.some(row => row.text === original)
      ? { requests: [{ message: 1, quote: 'Forget that detail.', decision: 'remove',
        targets: candidates.flatMap((row, index) => row.text === wrapped ? [index] : []), intents: [{ message: 0, quote: original }] }], claims: [] }
      : { requests: [], claims: [] } } });
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.ledger.rejected(f.context, [original], archive.archive_uri), true);
  assert.equal(await f.sessions.read(f.userId, uri), '- Independent plan.');
  const restoreUri = restoreIntent ? (await f.store.forgotten(f.userId)).find(row => row.uri.includes('/notes/forget-')).uri : uri;
  await f.store.undo(f.userId, nativeFileId(restoreUri));
  assert.ok((await f.sessions.read(f.userId, uri)).includes(wrapped));
  assert.equal(await f.ledger.rejected(f.context, [original], archive.archive_uri), false);
  assert.equal((await f.overlay.removals(f.userId)).length, 0);
});

test('the tool removes one stored fact while preserving another file line and its independent raw history', options, async t => {
  const f = await setup(t), first = 'My old project is M-41633.', second = 'My other project is N-49223.';
  const archives = [];
  for (const [name, text] of [['forget-line', first], ['keep-line', second]]) {
    const archive = await f.commitConversation(name, [{ role: 'user', text }], { projectId: 'default' });
    await f.service.ingestArchive({ ...f.commit, archiveUri: archive.archive_uri, engineSession: archive.session }, f.context);
    archives.push(archive);
  }
  const uri = f.seed('notes/tool-lines.md', `- ${first}\n- ${second}`);
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'notes', body: `- ${first}\n- ${second}` });
  await f.overlay.syncOrigins(f.userId, uri, { after: first, origin: { archiveUri: archives[0].archive_uri, engineSession: archives[0].session, projectId: 'default' } });
  f.store.history = f.service; f.store.forgetTargetsEnabled = true;
  await f.store.forget({ id: f.userId }, { id: 'default', userId: f.userId }, uri, { lines: [first], engineSession: 'dsh-tool-lines' });
  assert.equal(await f.sessions.read(f.userId, uri), `- ${second}`);
  const removals = await f.overlay.removals(f.userId);
  assert.ok(removals.some(row => row.fingerprint === lineFingerprint(first)));
  assert.ok(!removals.some(row => row.fingerprint === lineFingerprint(second)));
  const hits = JSON.stringify(await search(f));
  assert.ok(!hits.includes('M-41633')); assert.ok(hits.includes('N-49223'));
  const revision = (await f.overlay.revisionsOf(f.userId, uri))[0];
  assert.equal(revision.engineSession, 'dsh-tool-lines');
  await f.store.undo(f.userId, nativeFileId(uri));
  assert.match(await f.sessions.read(f.userId, uri), /M-41633/);
  assert.ok(JSON.stringify(await search(f)).includes('M-41633'));
});

test('the tool can reject an unstored statement from raw history and the page can undo the rejection', options, async t => {
  const f = await setup(t);
  const statement = 'My old project is M-41633.';
  f.stub.files.set(`${f.commit.archiveUri}/messages.jsonl`, JSON.stringify({ role: 'user', content: statement, created_at: '2026-01-01T00:00:00Z' }));
  await f.service.ingestArchive(f.commit, f.context);
  assert.ok(JSON.stringify(await search(f)).includes('M-41633'));
  f.store.history = f.service; f.store.forgetTargetsEnabled = true;
  const result = await f.store.forget({ id: f.userId }, { id: 'default', userId: f.userId }, null,
    { statement, engineSession: 'dsh-tool-history' });
  assert.deepEqual(result, { removed: false, historyRejected: true });
  assert.ok(!JSON.stringify(await search(f)).includes('M-41633'));
  assert.ok((await f.sessions.read(f.userId, `${f.commit.archiveUri}/messages.jsonl`)).includes('M-41633'), 'the archive itself is retained');
  const forgotten = await f.store.forgotten(f.userId);
  assert.equal(forgotten.length, 1);
  await f.store.undo(f.userId, forgotten[0].id);
  assert.ok(JSON.stringify(await search(f)).includes('M-41633'));
});

for (const mode of ['file', 'line', 'statement']) test(`history fence write failure rolls back rejection activation before ${mode} removal and can retry`, options, async t => {
  const f = await setup(t), statement = 'My old project is M-41633.';
  // Give each line a distinct hard token so the file scan needs no semantic judge
  // before it reaches the injected history write failure.
  const independent = 'Independent plan N-49223.';
  const body = `- ${statement}\n- ${independent}`;
  const uri = f.seed('notes/retry.md', body);
  f.stub.files.set(`${f.commit.archiveUri}/messages.jsonl`, JSON.stringify({ role: 'user', content: statement }));
  await f.service.ingestArchive(f.commit, f.context);
  f.store.history = f.service; f.store.forgetTargetsEnabled = true;
  const rejectMessages = f.ledger.rejectMessages.bind(f.ledger);
  let fail = true, injectedFailures = 0;
  f.ledger.rejectMessages = async (...args) => {
    await rejectMessages(...args);
    if (fail && args[3].length) {
      injectedFailures++;
      throw new Error('history write unavailable');
    }
  };
  const forget = () => f.store.forget({ id: f.userId }, { id: 'default', userId: f.userId }, mode === 'statement' ? null : uri,
    mode === 'statement' ? { statement } : mode === 'line' ? { lines: [statement] } : {});
  await assert.rejects(forget(), /history write unavailable/);
  assert.equal(injectedFailures, 1, 'the failure occurs after a history fence write');
  assert.equal(await f.sessions.read(f.userId, uri), body);
  assert.deepEqual(await f.overlay.removals(f.userId), []);
  assert.deepEqual(await f.overlay.revisionsOf(f.userId, uri), []);
  assert.equal((await f.database.query('SELECT * FROM evimed_memory.history_message_rejections WHERE owner_id=$1', [f.userId])).rows.length, 0);
  fail = false;
  const result = await forget();
  assert.ok(result.removed || result.historyRejected);
  assert.ok((await f.overlay.removals(f.userId)).length > 0);
  assert.ok(!JSON.stringify(await search(f)).includes('M-41633'));
  assert.equal(await f.sessions.read(f.userId, uri), mode === 'statement' ? body : mode === 'line' ? `- ${independent}` : null);
});
