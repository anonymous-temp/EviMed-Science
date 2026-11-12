// Real HTTP gateway argument validation -> NativeMemoryStore -> PostgreSQL overlay/history -> engine HTTP client.
// Only the external engine and the runtime/account identity boundary are fixtures; no forget layer is replaced.
import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { NativeMemoryWorker } from '../src/nativeMemoryWorker.mjs';
import { NativeMemoryStore, nativeFileId } from '../src/nativeMemoryStore.mjs';
import { checkForgetRequests } from '../src/nativeMemoryForgetRequests.mjs';
import { createRejectionJudge } from '../src/nativeMemoryRejections.mjs';
import { removalText } from '../src/nativeMemoryRejections.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { hardTokens } from '../src/nativeMemoryHardTokens.mjs';
import { GeoNativeMemoryContext } from '../src/geoNativeMemoryContext.mjs';
import { MemoryHistory, MemoryHistoryLedger } from '../src/memoryHistory.mjs';
import { createMemoryAdmission } from '../src/memoryAdmission.mjs';
import { createMemoryGatewayHandler, parseEventStream } from '../src/memoryGateway.mjs';
import { createMemoryClient, memoryTools, startGatewayServer } from '../../../evals/capsule-proving/run/lab.mjs';

const { options, fixture } = nativeIntegration();
const removed = '- 用户父亲这段时间住在其哥哥家（2026-06-20）。';
const retained = '- 用户周末会和家人一起吃饭。';

async function setup(t) {
  const f = await fixture(t);
  const config = { ...f.config, memoryEnabled: true, memoryRecallEnabled: true,
    memoryHistorySearchEnabled: true, memoryForgetTargetsEnabled: true, memoryForgetRequestCheckEnabled: true };
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Test',1048576)", [f.userId]);
  const project = { id: 'default', userId: f.userId, name: 'Test' }, user = { id: f.userId };
  const contexts = new GeoNativeMemoryContext({ database: f.database, documents: null, sessions: f.sessions,
    policies: { forProject: async () => ({ kind: 'owned' }), policiesForOwner: async () => [] },
    settingsForOwner: id => f.memorySettings.settings(id) });
  const context = await contexts.forProject(project);
  const ledger = new MemoryHistoryLedger({ database: f.database, overlay: f.overlay, client: f.sessions.client });
  const history = new MemoryHistory({ config, ledger, contexts,
    resolveSource: async commit => ({ projectId: project.id, projectCreatedAt: context.projectCreatedAt,
      sessionId: commit.engineSession?.slice(4), conversationTitle: 'Test conversation', conversationUrl: '/app/chat/test' }),
    eligible: async () => true, admitMessage: async () => true });
  const store = new NativeMemoryStore({ sessions: f.sessions, overlay: f.overlay, memoryContexts: contexts,
    forgetTargetsEnabled: config.memoryForgetTargetsEnabled });
  store.history = history;
  const token = 'forget-gateway-integration-token';
  const handler = createMemoryGatewayHandler({ config, sessions: f.sessions, overlay: f.overlay, memoryContexts: contexts,
    memoryTool: store, admission: createMemoryAdmission({ config, memorySettings: f.memorySettings }),
    runtimeManager: { assertActiveEviMedWorkloadToken: async value => {
      assert.equal(value, token); return { userId: user.id, projectId: project.id };
    } }, store: { userById: async () => user, requireProject: async () => project } });
  const server = await startGatewayServer(handler);
  t.after(() => server.close());
  const memory = createMemoryClient({ base: server.base, token, executeForget: true, config });
  const response = await fetch(`${server.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const text = await response.text();
  const listed = response.headers.get('content-type').includes('event-stream') ? parseEventStream(text)[0] : JSON.parse(text);
  assert.deepEqual(listed.result.tools.find(tool => tool.name === 'forget'), memoryTools(config).find(tool => tool.name === 'forget'),
    'the real gateway and runner advertise the same model arguments');
  return { ...f, store, context, history, ledger, memory, user, project };
}

test('P04 exact model arguments cross HTTP and store validation; one line leaves, rejection persists, undo restores', options, async t => {
  const f = await setup(t);
  const body = `${removed}\n${retained}`;
  const uri = f.seed('notes/周末安排与家人.md', body, { type: 'notes' });
  const args = { uri, lines: [removed] };
  // Reproduce the original composition mismatch through the real store, including the model-visible reason.
  f.store.forgetTargetsEnabled = false;
  const refused = await f.memory.callTool('forget', args);
  assert.equal(refused.isError, true);
  assert.match(refused.blocks.join('\n'), /memory_payload_invalid:.*lines.*enabled/);
  assert.equal(await f.sessions.read(f.userId, uri), body);
  assert.equal((await f.overlay.removals(f.userId)).length, 0);
  f.store.forgetTargetsEnabled = true;
  const answer = await f.memory.callTool('forget', args);
  assert.equal(answer.isError, false, answer.blocks.join('\n'));
  assert.match(answer.blocks.join('\n'), /Removed 1 line.*Other lines were kept/s);
  assert.equal(await f.sessions.read(f.userId, uri), retained);
  const rejected = await f.overlay.rejectedFingerprints(f.userId, 'notes');
  assert.ok(rejected.has(lineFingerprint(removalText(removed))));
  assert.equal(rejected.has(lineFingerprint(removalText(retained))), false);
  const revisions = await f.overlay.revisionsOf(f.userId, uri);
  assert.equal(revisions[0].before, body);
  assert.equal(revisions[0].after, retained);
  await f.store.undo(f.userId, nativeFileId(uri));
  assert.equal(await f.sessions.read(f.userId, uri), body);
  assert.equal((await f.overlay.rejectedFingerprints(f.userId, 'notes')).has(lineFingerprint(removalText(removed))), false);
});

test('statement without uri crosses HTTP and store validation; history recall is rejected and undo restores recall', options, async t => {
  const f = await setup(t), statement = 'My old project is M-41633.';
  const uri = f.seed('notes/unrelated.md', retained, { type: 'notes' });
  const archive = await f.commitConversation('history_only', [{ role: 'user', text: statement }], { projectId: f.project.id });
  await f.history.ingestArchive({ userId: f.userId, projectId: f.project.id, engineSession: archive.session, archiveUri: archive.archive_uri }, f.context);
  const search = () => f.history.search({ user: f.user, project: f.project, query: 'M-41633', limit: 5 });
  assert.match(JSON.stringify(await search()), /M-41633/);
  const answer = await f.memory.callTool('forget', { statement });
  assert.equal(answer.isError, false, answer.blocks.join('\n'));
  assert.match(answer.blocks.join('\n'), /history recall rejection/);
  assert.equal(await f.sessions.read(f.userId, uri), retained);
  assert.match(await f.sessions.read(f.userId, `${archive.archive_uri}/messages.jsonl`), /M-41633/);
  assert.doesNotMatch(JSON.stringify(await search()), /M-41633/);
  assert.ok((await f.overlay.rejectedFingerprints(f.userId, 'notes')).has(lineFingerprint(statement)));
  const hashes = await f.database.query('SELECT * FROM evimed_memory.history_message_rejections WHERE owner_id=$1', [f.userId]);
  assert.ok(hashes.rows.length > 0, 'history hashes have their real PostgreSQL rejection parent');
  const forgotten = await f.store.forgotten(f.userId);
  assert.equal(forgotten.length, 1);
  await f.store.undo(f.userId, forgotten[0].id);
  assert.match(JSON.stringify(await search()), /M-41633/);
  assert.equal((await f.overlay.rejectedFingerprints(f.userId, 'notes')).has(lineFingerprint(statement)), false);
});

// Pass the fact, without a withdrawal instruction, as the targeted tool contract requires.
const examinationStatement = 'The earlier examination result was benign.';

// The lab's optional rejection judge has a per-day budget shared with extraction.
// Exhausting that budget must not refuse a person's explicit privacy operation.
test('P07 token-free statement crosses HTTP with an exhausted maintenance judge budget', options, async t => {
  const f = await setup(t);
  const original = 'The previous examination was benign.';
  const archive = await f.commitConversation('p07', [{ role: 'user', text: original }], { projectId: f.project.id });
  await f.history.ingestArchive({ userId: f.userId, projectId: f.project.id, engineSession: archive.session, archiveUri: archive.archive_uri }, f.context);
  const search = () => f.history.search({ user: f.user, project: f.project, query: examinationStatement });
  const before = await search();
  assert.equal(before.length, 1, 'the real registry and engine search must supply a candidate before forgetting');
  assert.equal(before[0].messages[0].text, original);
  assert.deepEqual(hardTokens(examinationStatement), []);
  assert.deepEqual(hardTokens(original), []);
  let calls = 0;
  f.store.rejectionJudge = createRejectionJudge({ config: { deepseekProviderEnabled: true, deepseekApiKey: 'fixture',
    deepseekModel: 'fixture', nativeMemoryRejectionJudgeDailyCalls: 0 }, callModel: async (_deps, call) => {
      calls++;
      const shown = JSON.parse(call.body.messages[1].content);
      assert.deepEqual(shown.candidates.map(candidate => candidate.text), [original]);
      assert.deepEqual(shown.removed, [examinationStatement]);
      return { choices: [{ message: { content: JSON.stringify({ same: [{ candidate: 0, removed: 0 }], stated: [] }) } }] };
    } });
  const maintenance = () => f.store.rejectionJudge.same({ userId: f.userId,
    candidates: [{ text: original, removed: [{ text: examinationStatement, fingerprint: lineFingerprint(examinationStatement) }] }] });
  assert.equal((await maintenance()).same.size, 0);
  assert.equal(calls, 0, 'the maintenance allowance is already exhausted');
  const answer = await f.memory.callTool('forget', { statement: examinationStatement });
  assert.equal(answer.isError, false, answer.blocks.join('\n'));
  assert.equal(calls, 1);
  assert.match(answer.blocks.join('\n'), /Recorded a history recall rejection.*conversation text is unchanged/s);
  const removals = await f.overlay.removals(f.userId);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].fingerprint, lineFingerprint(examinationStatement));
  const hashes = await f.database.query('SELECT message_hash FROM evimed_memory.history_message_rejections WHERE owner_id=$1', [f.userId]);
  assert.deepEqual(hashes.rows.map(row => row.message_hash), [lineFingerprint(original)]);
  assert.deepEqual(await search(), []);
  assert.deepEqual(await f.history.search({ user: f.user, project: f.project, query: original }), []);
  assert.match(await f.sessions.read(f.userId, `${archive.archive_uri}/messages.jsonl`), /previous examination/);
  assert.equal((await maintenance()).same.size, 0, 'privacy work does not replenish the maintenance allowance');
  assert.equal(calls, 1);
  await f.store.undo(f.userId, (await f.store.forgotten(f.userId))[0].id);
  assert.equal((await search()).length, 1, 'undo restores the semantically matched original');
});

for (const visibility of ['delayed indexing', 'later search']) test(`an empty history search still records a statement rejection before ${visibility}`, options, async t => {
  const f = await setup(t), statement = 'The previous examination was benign.';
  // Exercise both an archive not indexed yet and an indexed resource absent from search.
  const archive = await f.commitConversation('delayed-index', [{ role: 'user', text: statement, at: '2026-01-01T00:00:00Z' }], { projectId: f.project.id });
  const commit = { userId: f.userId, projectId: f.project.id, engineSession: archive.session, archiveUri: archive.archive_uri };
  const search = () => f.history.search({ user: f.user, project: f.project, query: statement });
  let hiddenResource;
  if (visibility === 'later search') {
    await f.history.ingestArchive(commit, f.context);
    assert.equal((await search()).length, 1);
    hiddenResource = [...f.stub.files].find(([uri]) => uri.includes('/resources/history/'));
    assert.ok(hiddenResource);
    f.stub.files.delete(hiddenResource[0]);
  }
  assert.deepEqual(await search(), []);
  f.store.rejectionJudge = { same: async () => { assert.fail('no original candidate needs semantic matching'); } };
  const answer = await f.memory.callTool('forget', { statement });
  assert.equal(answer.isError, false, answer.blocks.join('\n'));
  assert.match(answer.blocks.join('\n'), /Recorded a history recall rejection.*No memory file was deleted; the conversation text is unchanged/s);
  const removals = await f.overlay.removals(f.userId);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].fingerprint, lineFingerprint(statement));
  const hashes = await f.database.query('SELECT message_hash FROM evimed_memory.history_message_rejections WHERE owner_id=$1', [f.userId]);
  assert.deepEqual(hashes.rows, [], 'the statement fence does not fabricate an original-message match');
  if (hiddenResource) f.stub.files.set(hiddenResource[0], hiddenResource[1]);
  else {
    await f.history.ingestArchive(commit, f.context);
    const progress = await f.database.query('SELECT state,reason,indexed_chunks FROM evimed_memory.history_archives WHERE owner_id=$1 AND archive_uri=$2', [f.userId, archive.archive_uri]);
    assert.deepEqual(progress.rows, [{ state: 'partial', reason: 'removed_content', indexed_chunks: 0 }]);
  }
  assert.deepEqual(await search(), []);
  assert.match(await f.sessions.read(f.userId, `${archive.archive_uri}/messages.jsonl`), /previous examination/);
  await f.store.undo(f.userId, (await f.store.forgotten(f.userId))[0].id);
  await f.history.ingestArchive(commit, f.context);
  assert.equal((await search()).length, 1, 'the same archive is indexable after undo, proving it was fenced by the statement');
});

for (const order of ['tool-first', 'settle-first', 'overlap']) test(`statement and request settlement are idempotent (${order})`, options, async t => {
  const f = await setup(t), statement = 'My old project is M-41633.';
  const archive = await f.commitConversation('intent-order', [{ role: 'user', text: statement }], { projectId: f.project.id });
  const commit = { userId: f.userId, projectId: f.project.id, engineSession: archive.session, archiveUri: archive.archive_uri };
  await f.history.ingestArchive(commit, f.context);
  const search = () => f.history.search({ user: f.user, project: f.project, query: statement });
  assert.equal((await search()).length, 1, 'the ordering case starts with recallable history');
  // Persist the already-reviewed plan exactly as checkForgetRequests does before mutation.
  await f.overlay.setForgetRequests(f.userId, commit.archiveUri, { state: 'applying', sourceArchive: commit.archiveUri,
    requests: [{ key: 'a'.repeat(64), message: 0, status: 'applying', decision: 'remove', candidates: [], intents: [statement], removed: 0, requestMessage: { role: 'user', text: statement } }], claims: [] });
  const settle = () => checkForgetRequests({ commit, context: f.context, overlay: f.overlay, store: f.store, judge: null });
  const tool = async () => {
    const answer = await f.memory.callTool('forget', { statement });
    assert.equal(answer.isError, false, answer.blocks.join('\n'));
  };
  if (order === 'tool-first') { await tool(); await settle(); }
  if (order === 'settle-first') { await settle(); await tool(); }
  if (order === 'overlap') await Promise.all([tool(), settle()]);
  const first = await f.overlay.removals(f.userId);
  await tool();
  assert.deepEqual(await f.overlay.removals(f.userId), first, 'a retry does not move the rejection date');
  const revisions = await f.database.query("SELECT * FROM evimed_memory.native_revisions WHERE user_id=$1 AND change='deleted'", [f.userId]);
  assert.equal(revisions.rows.length, 1, 'one undoable intent, independent of order and retry');
  const forgotten = await f.store.forgotten(f.userId);
  assert.equal(forgotten.length, 1);
  assert.deepEqual(await search(), []);
  await f.store.undo(f.userId, forgotten[0].id);
  assert.equal((await f.overlay.removals(f.userId)).length, 0);
  assert.equal((await search()).length, 1);
});

test('two forget calls during a pending commit retain both independent removals', options, async t => {
  const f = await setup(t), first = 'Project M-41633.', second = 'Project N-49223.';
  const uri = f.seed('notes/two-calls.md', `${first}\n${retained}`, { type: 'notes' });
  const archive = await f.commitConversation('pending-forget', [{ role: 'user', text: `${first} ${second}`, at: '2026-01-01T00:00:00Z' }], { projectId: f.project.id });
  const commit = { userId: f.userId, projectId: f.project.id, engineSession: archive.session, archiveUri: archive.archive_uri };
  assert.equal((await f.overlay.commit(f.userId, commit.archiveUri)).state, 'pending');
  assert.deepEqual(await f.history.search({ user: f.user, project: f.project, query: second }), [], 'pending history is intentionally not indexed');
  assert.equal((await f.memory.callTool('forget', { uri, lines: [first] })).isError, false);
  assert.equal((await f.memory.callTool('forget', { statement: second })).isError, false);
  // The external engine finishes its already-pending extraction after both calls.
  const resurrected = `${first}\n${second}\n${retained}`;
  f.stub.files.set(uri, resurrected);
  f.stub.files.set(`${commit.archiveUri}/memory_diff.json`, JSON.stringify({ archive_uri: commit.archiveUri,
    operations: { adds: [], updates: [{ uri, memory_type: 'notes', before: retained, after: resurrected }], deletes: [] } }));
  await f.overlay.setForgetRequests(f.userId, commit.archiveUri, { state: 'applying', sourceArchive: commit.archiveUri,
    requests: [{ key: 'b'.repeat(64), message: 0, status: 'applying', decision: 'remove', candidates: [], intents: [first, second], removed: 0 }], claims: [] });
  const worker = new NativeMemoryWorker({ config: { ...f.config, memoryForgetRequestCheckEnabled: true },
    sessions: f.sessions, overlay: f.overlay, memorySettings: f.memorySettings, nativeMemory: f.store, memoryContexts: f.store.memoryContexts });
  worker.history = f.history;
  worker.verification.history = f.history;
  await worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.commit(f.userId, commit.archiveUri)).state, 'completed');
  await f.history.ingestArchive(commit, f.context);
  const progress = await f.database.query('SELECT state,reason,indexed_chunks FROM evimed_memory.history_archives WHERE owner_id=$1 AND archive_uri=$2', [f.userId, archive.archive_uri]);
  assert.deepEqual(progress.rows, [{ state: 'partial', reason: 'removed_content', indexed_chunks: 0 }], 'the pending archive is suppressed by the removals, not an unrelated indexing failure');
  const prints = new Set((await f.overlay.removals(f.userId)).map(row => row.fingerprint));
  assert.ok(prints.has(lineFingerprint(first))); assert.ok(prints.has(lineFingerprint(second)));
  assert.equal(await f.sessions.read(f.userId, uri), retained);
  assert.doesNotMatch(JSON.stringify(await f.history.search({ user: f.user, project: f.project, query: second })), /N-49223|M-41633/);
});


test('a statement upgrades an edit rejection to undoable forgetting exactly once', options, async t => {
  const f = await setup(t), statement = 'My old project is M-41633.';
  await f.overlay.reject(f.userId, 'notes', `${f.context.userRoot}/memories/notes/edit.md`, [statement], { origin: 'edit' });
  for (let repeat = 0; repeat < 2; repeat++) assert.equal((await f.memory.callTool('forget', { statement })).isError, false);
  assert.equal((await f.overlay.rejectedLines(f.userId, 'notes'))[0].origin, 'forget');
  assert.equal((await f.store.forgotten(f.userId)).length, 1);
});
