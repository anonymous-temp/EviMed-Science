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

async function setup(t, overrides = {}) {
  const f = await fixture(t);
  const config = { ...f.config, memoryEnabled: true, memoryRecallEnabled: true,
    memoryHistorySearchEnabled: true, memoryForgetTargetsEnabled: true, memoryForgetRequestCheckEnabled: true, ...overrides };
  f.overlay.deferredSummaryRebuildEnabled = config.memoryDeferredSummaryRebuildEnabled === true;
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Test',1048576)", [f.userId]);
  const project = { id: 'default', userId: f.userId, name: 'Test' }, user = { id: f.userId };
  const conversation = { sessionId: null, title: 'Test conversation' };
  const contexts = new GeoNativeMemoryContext({ database: f.database, documents: null, sessions: f.sessions,
    policies: { forProject: async () => ({ kind: 'owned' }), policiesForOwner: async () => [] },
    settingsForOwner: id => f.memorySettings.settings(id) });
  const context = await contexts.forProject(project);
  const ledger = new MemoryHistoryLedger({ database: f.database, overlay: f.overlay, client: f.sessions.client });
  const history = new MemoryHistory({ config, ledger, contexts,
    resolveSource: async commit => ({ projectId: project.id, projectCreatedAt: context.projectCreatedAt,
      sessionId: commit.engineSession?.slice(4), conversationTitle: conversation.title, conversationUrl: '/app/chat/test' }),
    eligible: async () => true, admitMessage: async () => true });
  const store = new NativeMemoryStore({ sessions: f.sessions, overlay: f.overlay, memoryContexts: contexts,
    forgetTargetsEnabled: config.memoryForgetTargetsEnabled });
  store.history = history;
  const token = 'forget-gateway-integration-token';
  const handler = createMemoryGatewayHandler({ config, sessions: f.sessions, overlay: f.overlay, memoryContexts: contexts,
    memoryTool: store, historySearch: request => history.search(request, { includeWithdrawn: true }), admission: createMemoryAdmission({ config, memorySettings: f.memorySettings,
      conversations: { running: async () => conversation.sessionId ? [{id:'run',sessionId:conversation.sessionId}] : [], runsOf: async () => [] } }),
    runtimeManager: { assertActiveEviMedWorkloadToken: async value => {
      assert.equal(value, token); return { userId: user.id, projectId: project.id };
    } }, store: { userById: async () => user, requireProject: async () => project } });
  const server = await startGatewayServer(handler);
  t.after(() => server.close());
  const memory = createMemoryClient({ base: server.base, token, readOnly: false, executeForget: true, config });
  const response = await fetch(`${server.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const text = await response.text();
  const listed = response.headers.get('content-type').includes('event-stream') ? parseEventStream(text)[0] : JSON.parse(text);
  assert.deepEqual(listed.result.tools.find(tool => tool.name === 'forget'), memoryTools(config).find(tool => tool.name === 'forget'),
    'the real gateway and runner advertise the same model arguments');
  return { ...f, store, context, contexts, config, history, ledger, memory, user, project, conversation, base: server.base, token };
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

for (const fileRemoved of [false, true]) test(`AL8d deferred line forget reports physical removal and retains neighbours (fileRemoved=${fileRemoved})`, options, async t => {
  const f = await setup(t, { memoryDeferredSummaryRebuildEnabled: true });
  const body = fileRemoved ? removed : `${removed}\n${retained}`;
  const uri = f.seed('notes/line-forget.md', body, { type: 'notes' });
  const answer = await f.memory.callTool('forget', { uri, lines: [removed] });
  assert.equal(answer.isError, false, answer.blocks.join('\n'));
  // Check engine bytes before the reply so a presentation failure cannot hide the mutation result.
  assert.equal(await f.sessions.read(f.userId, uri), fileRemoved ? null : retained);
  assert.match(answer.blocks.join('\n'), /^Removed 1 line/);
  assert.match(answer.blocks.join('\n'), fileRemoved ? /The empty file was deleted/ : /Other lines were kept/);
  assert.match(answer.blocks.join('\n'), /Earlier conversations and memory copies are still being checked/);
  assert.match(answer.blocks.join('\n'), /New conversations will not use the forgotten memory once these checks finish/);
  assert.equal(await f.ledger.forgetScanPending(f.userId, 'notes', [lineFingerprint(removalText(removed))]), true);
  const rejected = await f.overlay.rejectedFingerprints(f.userId, 'notes');
  assert.ok(rejected.has(lineFingerprint(removalText(removed))));
  assert.equal(rejected.has(lineFingerprint(removalText(retained))), false);
  const revisions = await f.overlay.revisionsOf(f.userId, uri);
  assert.equal(revisions[0].before, body);
  assert.equal(revisions[0].after, fileRemoved ? null : retained);
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
for (const availability of ['available', 'provider off', 'invalid answer', 'provider exception', 'timeout']) test(`P07 token-free statement crosses HTTP with exhausted maintenance budget (${availability})`, options, async t => {
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
  const calls = [];
  let failure = availability;
  const judgeConfig = { deepseekProviderEnabled: availability !== 'provider off', deepseekApiKey: 'fixture',
    deepseekModel: 'fixture', nativeMemoryRejectionJudgeDailyCalls: 0 };
  f.store.rejectionJudge = createRejectionJudge({ config: judgeConfig, callModel: async (_deps, call) => {
    calls.push(JSON.parse(call.body.messages[1].content));
    if (failure === 'provider exception') throw new Error('private provider detail');
    if (failure === 'timeout') throw new DOMException('private deadline detail', 'AbortError');
    if (failure === 'invalid answer') return { choices: [{ message: { content: 'not JSON' } }] };
    return { choices: [{ message: { content: JSON.stringify({ same: [{ candidate: 0, removed: 0 }], stated: [] }) } }] };
  } });
  const maintenance = () => f.store.rejectionJudge.same({ userId: f.userId,
    candidates: [{ text: original, removed: [{ text: examinationStatement, fingerprint: lineFingerprint(examinationStatement) }] }] });
  assert.equal((await maintenance()).same.size, 0);
  assert.equal(calls.length, 0, 'the maintenance allowance is already exhausted');
  if (availability !== 'available') {
    const recorded = await f.memory.callTool('forget', { statement: examinationStatement });
    assert.equal(recorded.isError, false, recorded.blocks.join('\n'));
    assert.equal(recorded.blocks.join('\n'), 'Recorded a history recall rejection for the statement and exact restatements. Earlier conversations and memory copies are still being checked; paraphrases may still be recalled until that check finishes. The current conversation still shows what was said. New conversations will not use the forgotten memory once these checks finish.');
    assert.doesNotMatch(recorded.blocks.join('\n'), /private provider|private deadline/);
    assert.equal((await f.overlay.removals(f.userId)).length, 1);
    assert.equal((await f.store.forgotten(f.userId)).length, 1);
    assert.equal((await search()).length, 1, 'the answer explicitly discloses the unscanned paraphrase gap');
    assert.equal(await f.ledger.rejected(f.context, [examinationStatement]), true);
    const queued = await f.database.query('SELECT * FROM evimed_memory.history_forget_scans WHERE owner_id=$1', [f.userId]);
    assert.equal(queued.rows.length, 1);
    assert.deepEqual(queued.rows[0].archives, [archive.archive_uri]);
    assert.equal((await f.ledger.archiveCoverage(f.userId)).maintenance.forget_scans, 1);
    assert.equal((await f.store.pending(f.userId)).filter(row => row.reason === 'forget_scan_pending').length, 1);
    failure = 'available';
    judgeConfig.deepseekProviderEnabled = true;
    const restarted = new MemoryHistory({ config: f.config, ledger: new MemoryHistoryLedger({ database: f.database, overlay: f.overlay }),
      contexts: f.contexts, rejectionJudge: f.store.rejectionJudge, resolveSource: f.history.resolveSource,
      eligible: f.history.eligible, admitMessage: f.history.admitMessage });
    await restarted.drainForgetScans();
    assert.equal((await f.database.query('SELECT state FROM evimed_memory.history_forget_scans WHERE owner_id=$1', [f.userId])).rows[0].state, 'complete');
    assert.deepEqual(await search(), [], 'restart completion fences the paraphrase without another tool call');
    await restarted.drainForgetScans();
  }
  // Repeating the tool after worker completion preserves its existing undo authority.
  const answer = await f.memory.callTool('forget', { statement: examinationStatement });
  assert.equal(answer.isError, false, answer.blocks.join('\n'));
  assert.equal(calls.length, availability === 'available' ? 1 : availability === 'provider off' ? 2 : 3);
  // Assert outside callModel: an assertion inside that boundary is caught as a provider failure.
  for (const shown of calls) {
    assert.deepEqual(shown.candidates, [{ candidate: 0, text: original, options: [0] }]);
    assert.equal(shown.removed.length, 1); assert.equal(shown.removed[0].removed, 0);
    assert.equal(lineFingerprint(shown.removed[0].text), lineFingerprint(examinationStatement));
  }
  assert.equal(answer.blocks.join('\n'), 'Recorded a memory and history recall rejection for the statement. The current conversation still shows what was said. New conversations will not use the forgotten memory.');
  const removals = await f.overlay.removals(f.userId);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].fingerprint, lineFingerprint(examinationStatement));
  const hashes = await f.database.query('SELECT message_hash FROM evimed_memory.history_message_rejections WHERE owner_id=$1', [f.userId]);
  assert.deepEqual(hashes.rows.map(row => row.message_hash), [lineFingerprint(original)]);
  assert.deepEqual(await search(), []);
  assert.deepEqual(await f.history.search({ user: f.user, project: f.project, query: original }), []);
  assert.match(await f.sessions.read(f.userId, `${archive.archive_uri}/messages.jsonl`), /previous examination/);
  assert.equal((await maintenance()).same.size, 0, 'privacy work does not replenish the maintenance allowance');
  assert.equal(calls.length, availability === 'available' ? 1 : availability === 'provider off' ? 2 : 3);
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
  assert.equal(answer.blocks.join('\n'), 'Recorded a memory and history recall rejection for the statement. The current conversation still shows what was said. New conversations will not use the forgotten memory.');
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

for (const deferred of [false, true]) test(`two forget calls during a pending commit retain both independent removals (deferred=${deferred})`, options, async t => {
  const f = await setup(t, { memoryDeferredSummaryRebuildEnabled: deferred }), first = 'Project M-41633.', second = 'Project N-49223.';
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

async function gatewayRequest(f, path, body) {
  const response = await fetch(`${f.base}${path}`, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}

test('FT8 HTTP line removal answers before rebuild, all readers use current bytes, restarted worker converges', options, async t => {
  const f = await setup(t, { memoryDeferredSummaryRebuildEnabled: true });
  const withdrawn = '- My old booking is R-41633.', kept = '- Keep green folders.';
  const uri = f.seed('notes/arrangements.md', `${withdrawn}\n${kept}`, { type: 'notes' });
  f.seed('profile.md', '- Use metric units.', { type: 'profile' });
  const archive = await f.commitConversation('fast', [{ role: 'user', text: withdrawn.slice(2), at: '2026-01-01T00:00:00Z' }], { projectId: f.project.id });
  await f.history.ingestArchive({ userId: f.userId, projectId: f.project.id, engineSession: archive.session, archiveUri: archive.archive_uri }, f.context);
  for (const directory of [f.root, `${f.root}/notes`]) for (const name of ['.overview.md','.abstract.md']) f.stub.files.set(`${directory}/${name}`, withdrawn);
  f.stub.memorySearchSnapshot = new Map(f.stub.files);
  f.stub.beforeReindex = async () => { throw new Error('rebuild unavailable'); };
  const answer = await f.memory.callTool('forget', { uri, lines: [withdrawn] });
  assert.equal(answer.isError, false, answer.blocks.join('\n'));
  assert.equal(f.stub.sent('POST', '/api/v1/content/reindex').length, 0, 'no slow engine request is on the response path');
  assert.equal((await f.overlay.pendingSummaryInvalidations(f.userId)).length, 2);
  assert.equal(await f.sessions.read(f.userId, uri), kept);
  for (const directory of [f.root, `${f.root}/notes`]) for (const name of ['.overview.md','.abstract.md']) {
    assert.equal(await f.sessions.read(f.userId, `${directory}/${name}`), null);
    assert.equal((await gatewayRequest(f, `/api/v1/content/read?uri=${encodeURIComponent(`${directory}/${name}`)}`)).status, 404);
  }
  for (const query of ['R-41633', 'folders']) {
    const memorySearch = await f.memory.callTool('search', { query });
    assert.doesNotMatch(memorySearch.blocks.join('\n'), /R-41633/);
    assert.match(memorySearch.blocks.join('\n'), /green folders/, 'stale ranking retains the current neighbouring fact');
    for (const mode of ['list','context']) {
      const result = await gatewayRequest(f, '/api/v1/search/search', { query, ...(mode === 'context' ? { mode } : {}) });
      assert.equal(result.status, 200);
      assert.doesNotMatch(JSON.stringify(result.body), /R-41633/);
      assert.match(JSON.stringify(result.body), /green folders/);
    }
  }
  const read = await f.memory.callTool('read', { uris: [uri] });
  assert.doesNotMatch(read.blocks.join('\n'), /R-41633/);
  const opening = await gatewayRequest(f, `/api/v1/fs/ls?uri=${encodeURIComponent(f.root)}&recursive=true`);
  assert.equal(opening.status, 200); assert.doesNotMatch(JSON.stringify(opening.body), /R-41633/);
  assert.match(JSON.stringify(opening.body), /arrangements/);
  const profile = await gatewayRequest(f, `/api/v1/content/read?uri=${encodeURIComponent(`${f.root}/profile.md`)}`);
  assert.match(JSON.stringify(profile.body), /metric/);
  const page = await f.store.profile(f.userId);
  assert.doesNotMatch(JSON.stringify(page.records.filter(item => item.status !== 'archived').map(item => item.value)), /R-41633/);
  assert.doesNotMatch(JSON.stringify(await f.store.search(f.userId, 'R-41633')), /R-41633.*old booking|old booking.*R-41633/);
  assert.deepEqual(await f.history.search({ user: f.user, project: f.project, query: 'R-41633' }), []);
  assert.match(await f.sessions.read(f.userId, `${archive.archive_uri}/messages.jsonl`), /R-41633/);
  // An extraction already accepted by the engine can finish after its HTTP
  // writer lease ended. Recall fences its literal replay until settlement.
  f.stub.files.set(uri, `${withdrawn}\n${kept}\n- New unrelated fact.`);
  for (const tool of ['read', 'search']) {
    const late = await f.memory.callTool(tool, tool === 'read' ? { uris: [uri] } : { query: 'R-41633' });
    assert.doesNotMatch(late.blocks.join('\n'), /R-41633/);
    assert.match(late.blocks.join('\n'), /New unrelated fact/);
  }
  const lateRead = await gatewayRequest(f, `/api/v1/content/read?uri=${encodeURIComponent(uri)}`);
  assert.doesNotMatch(JSON.stringify(lateRead.body), /R-41633/);
  assert.match(JSON.stringify(lateRead.body), /New unrelated fact/);
  assert.doesNotMatch(JSON.stringify((await f.store.records(f.userId)).map(item => item.value)), /R-41633/);
  f.stub.files.set(uri, kept);
  const restarted = new NativeMemoryWorker({ config: f.config, memorySettings: f.memorySettings, sessions: f.sessions, overlay: f.overlay });
  await assert.rejects(restarted.drainSummaryInvalidations(f.userId));
  assert.equal((await f.overlay.pendingSummaryInvalidations(f.userId)).length, 2);
  // A later edit coalesces with the existing tickets; the rebuild reads live children.
  const record = (await f.store.records(f.userId)).find(item => item.uri === uri);
  await f.store.update(f.userId, record.id, { value: `${kept}\n- Use blue binders.`, expectedVersion: record.version });
  assert.equal((await f.overlay.pendingSummaryInvalidations(f.userId)).length, 2);
  f.stub.beforeReindex = null; f.stub.rebuildSummaries = true;
  await restarted.drainSummaryInvalidations(f.userId);
  assert.equal((await f.overlay.pendingSummaryInvalidations(f.userId)).length, 0);
  const overview = await f.sessions.read(f.userId, `${f.root}/.overview.md`);
  assert.match(overview, /blue binders/); assert.doesNotMatch(overview, /R-41633/);
  assert.equal(await restarted.drainSummaryInvalidations(f.userId), 0);
});

for (const state of ['pending','running','complete']) test(`FT8 undo cancels a ${state} paraphrase obligation`, options, async t => {
  const f = await setup(t), original = 'The previous examination was benign.';
  const archive = await f.commitConversation(`undo-${state}`, [{ role: 'user', text: original }], { projectId: f.project.id });
  await f.history.ingestArchive({ userId: f.userId, projectId: f.project.id, engineSession: archive.session, archiveUri: archive.archive_uri }, f.context);
  f.store.rejectionJudge = { same: async () => { throw new Error('offline'); } };
  assert.equal((await f.memory.callTool('forget', { statement: examinationStatement })).isError, false);
  const forgotten = (await f.store.forgotten(f.userId))[0];
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  f.history.rejectionJudge = { same: async ({ candidates }) => {
    if (state === 'running') { entered(); await held; }
    return { same: new Map(candidates.map((_candidate, index) => [index, lineFingerprint(examinationStatement)])) };
  } };
  let work;
  if (state === 'running') {
    work = f.history.drainForgetScans();
    await Promise.race([started, work.then(() => assert.fail('the drain ended before claiming this fixture’s scan'))]);
  }
  if (state === 'complete') await f.history.drainForgetScans();
  await f.store.undo(f.userId, forgotten.id);
  release(); await work;
  assert.equal((await f.database.query('SELECT * FROM evimed_memory.history_forget_scans WHERE owner_id=$1', [f.userId])).rows.length, 0);
  assert.equal((await f.history.search({ user: f.user, project: f.project, query: original })).length, 1);
  assert.equal(await f.ledger.rejected(f.context, [examinationStatement]), false);
});

test('FT8 failed scan backs off, stays visible, coalesces tool retries and is erased with the account', options, async t => {
  const f = await setup(t), original = 'The previous examination was benign.';
  const archive = await f.commitConversation('retry', [{ role: 'user', text: original }], { projectId: f.project.id });
  await f.history.ingestArchive({ userId: f.userId, projectId: f.project.id, engineSession: archive.session, archiveUri: archive.archive_uri }, f.context);
  const judge = { same: async () => { throw new Error('offline'); } };
  f.store.rejectionJudge = judge; f.history.rejectionJudge = judge;
  const call = () => f.memory.callTool('forget', { statement: examinationStatement });
  assert.equal((await call()).isError, false);
  await f.history.drainForgetScans();
  const rows = () => f.database.query('SELECT * FROM evimed_memory.history_forget_scans WHERE owner_id=$1', [f.userId]);
  const failed = (await rows()).rows[0];
  assert.equal(failed.cursor, 0); assert.equal(failed.attempts, 1); assert.equal(failed.state, 'pending');
  assert.equal(failed.error, 'memory_history_privacy_unavailable'); assert.ok(failed.next_attempt_at > new Date());
  await f.history.drainForgetScans();
  assert.equal((await rows()).rows[0].attempts, 1, 'backoff prevents a busy retry');
  assert.equal((await call()).isError, false);
  assert.match((await f.memory.callTool('forget', { statement: examinationStatement.toUpperCase() })).blocks.join('\n'), /still being checked/);
  assert.equal((await rows()).rows.length, 1); assert.equal((await rows()).rows[0].id, failed.id);
  assert.equal((await f.store.forgotten(f.userId)).length, 1);
  await f.history.refreshMaintenance();
  assert.equal(f.history.status().maintenance.forget_scan_retries, 1);
  assert.equal((await f.store.pending(f.userId)).find(row => row.reason === 'forget_scan_pending').state, 'retrying');
  await f.database.query('DELETE FROM evimed_control.users WHERE id=$1', [f.userId]);
  assert.deepEqual((await rows()).rows, []);
});

test('FT8 a pending scan applies literal hard-token fences without a read-time judge', options, async t => {
  const f = await setup(t), statement = 'My withdrawn booking number is T-92516.';
  // A failed source read can require a scan even for a literal-token statement.
  const activate = async () => {
    await f.overlay.claimForgetIntent(f.userId, 'notes', `${f.root}/notes/forget-token.md`, [statement]);
    await f.ledger.queueForgetScan(f.context, 'notes', lineFingerprint(statement));
  };
  await f.ledger.migrate();
  await f.database.transaction(client => f.database.withTransactionClient(client, activate));
  f.history.rejectionJudge = { same: async () => assert.fail('recall must not call a judge') };
  assert.equal(await f.ledger.rejected(f.context, ['The appointment was filed under T-92516.']), true);
  assert.equal(await f.ledger.rejected(f.context, ['The appointment was filed under T-92517.']), false);
});

test('FT8 late discovery reopens the fixed-cutoff scan before indexing, while later restatements stay authorized', options, async t => {
  const f = await setup(t), original = 'The previous examination was benign.';
  const ingest = async archive => f.history.ingestArchive({ userId: f.userId, projectId: f.project.id, engineSession: archive.session, archiveUri: archive.archive_uri }, f.context);
  const first = await f.commitConversation('initial-scan', [{ role: 'user', text: original, at: '2026-01-01T00:00:00Z' }], { projectId: f.project.id });
  await ingest(first);
  f.store.rejectionJudge = { same: async () => { throw new Error('offline'); } };
  assert.equal((await f.memory.callTool('forget', { statement: examinationStatement })).isError, false);
  f.history.rejectionJudge = { same: async ({ candidates }) => ({ same: new Map(candidates.map((_candidate, index) => [index, lineFingerprint(examinationStatement)])) }) };
  await f.history.drainForgetScans();
  const late = await f.commitConversation('late-discovery', [{ role: 'user', text: original, at: '2026-01-02T00:00:00Z' }], { projectId: f.project.id });
  assert.deepEqual(await ingest(late), { state: 'queued', reason: 'forget_scan_pending' });
  assert.equal(await f.ledger.forgetArchivePending(f.context, late.archive_uri), true);
  assert.deepEqual(await f.history.search({ user: f.user, project: f.project, query: original }), []);
  await f.database.query("UPDATE evimed_memory.history_archives SET attempts=8 WHERE owner_id=$1 AND archive_uri=$2", [f.userId,late.archive_uri]);
  await f.history.drainForgetScans();
  const retry = (await f.database.query('SELECT state,attempts FROM evimed_memory.history_archives WHERE owner_id=$1 AND archive_uri=$2', [f.userId,late.archive_uri])).rows[0];
  assert.deepEqual(retry, { state:'queued', attempts:8 }, 'privacy waiting stays queued regardless of the ordinary failure cap');
  await ingest(late);
  assert.equal(await f.ledger.forgetArchivePending(f.context, late.archive_uri), false);
  assert.deepEqual(await f.history.search({ user: f.user, project: f.project, query: original }), []);
  // No extraction output is required to authorize original history: the ingest judge checks
  // this enumerated affirmative statement, and never runs from the history reader.
  f.history.rejectionJudge = createRejectionJudge({ config: { deepseekModel: 'fixture', deepseekApiKey: 'fixture' },
    callModel: async (_deps, call) => {
      const input = JSON.parse(call.body.messages[1].content);
      const source = input.said.indexOf(examinationStatement);
      return { choices: [{ message: { content: JSON.stringify({ same: [{ candidate: 0, removed: 0 }],
        stated: source < 0 ? [] : [0], assertions: source < 0 ? [] : [{ candidate: 0, source, quote: examinationStatement }] }) } }] };
    } });
  const fresh = await f.commitConversation('later-authorized', [{ role: 'user', text: examinationStatement, at: '2099-01-01T00:00:00Z' }], { projectId: f.project.id });
  await ingest(fresh);
  assert.equal(await f.ledger.forgetArchivePending(f.context, fresh.archive_uri), false);
  const question = await f.commitConversation('later-question', [{ role: 'user', text: `Did I say: ${examinationStatement}`, at: '2099-01-02T00:00:00Z' }], { projectId: f.project.id });
  await ingest(question);
  f.history.rejectionJudge = { same: async () => assert.fail('search must consume receipts without model calls') };
  const hits = await f.history.search({ user: f.user, project: f.project, query: examinationStatement });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 'session_later-authorized');
  assert.equal(await f.ledger.rejected(f.context, [original], first.archive_uri), true, 'restatement never opens the old archive');
});

test('FT8 an archive appended during a leased scan survives its older cursor acknowledgement', options, async t => {
  const f = await setup(t), original = 'The previous examination was benign.';
  const ingest = archive => f.history.ingestArchive({ userId:f.userId, projectId:f.project.id, engineSession:archive.session, archiveUri:archive.archive_uri }, f.context);
  const first = await f.commitConversation('leased-first', [{ role:'user', text:original, at:'2026-01-01T00:00:00Z' }], { projectId:f.project.id });
  await ingest(first);
  f.store.rejectionJudge = { same:async () => { throw new Error('offline'); } };
  assert.equal((await f.memory.callTool('forget', { statement:examinationStatement })).isError, false);
  let entered, release, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  f.history.rejectionJudge = { same:async ({ candidates }) => {
    if (++calls === 1) { entered(); await held; }
    return { same:new Map(candidates.map((_candidate,index) => [index,lineFingerprint(examinationStatement)])) };
  } };
  const work = f.history.drainForgetScans();
  await Promise.race([started, work.then(() => assert.fail('the drain ended before claiming this fixture’s scan'))]);
  const late = await f.commitConversation('leased-late', [{ role:'user', text:original, at:'2026-01-02T00:00:00Z' }], { projectId:f.project.id });
  assert.equal((await ingest(late)).state, 'queued');
  release(); await work;
  assert.equal(calls, 2, 'the appended archive is scanned after the original lease settles');
  assert.equal(await f.ledger.forgetArchivePending(f.context, late.archive_uri), false);
  assert.equal(await f.ledger.rejected(f.context, [original], late.archive_uri), true);
});

test('FT8 undo releases a late archive waiting for a scan without spending the indexing retry budget', options, async t => {
  const f = await setup(t), original = 'The previous examination was benign.';
  const ingest = archive => f.history.ingestArchive({ userId:f.userId, projectId:f.project.id, engineSession:archive.session, archiveUri:archive.archive_uri }, f.context);
  const first = await f.commitConversation('undo-wait-first', [{ role:'user', text:original }], { projectId:f.project.id });
  await ingest(first);
  f.store.rejectionJudge = { same:async () => { throw new Error('offline'); } };
  assert.equal((await f.memory.callTool('forget', { statement:examinationStatement })).isError, false);
  const late = await f.commitConversation('undo-wait-late', [{ role:'user', text:original, at:'2026-01-02T00:00:00Z' }], { projectId:f.project.id });
  assert.equal((await ingest(late)).state, 'queued');
  await f.store.undo(f.userId, (await f.store.forgotten(f.userId))[0].id);
  assert.equal(await f.ledger.forgetArchivePending(f.context, late.archive_uri), false);
  await ingest(late);
  assert.equal((await f.history.search({ user:f.user, project:f.project, query:original })).length, 2);
});

// FT10: exact p6b conversation, with the misleading truncated title and a separate context chunk.
const p6bMessage = '帮我记一下几件个人的事，放进我的个人笔记里：每周三晚上我去游泳；我早上习惯喝黑咖啡；家里的备用钥匙放在蓝色鞋柜第二层；我对青霉素过敏。另外顺便帮我把这句话润色得通顺些，不用保存：“上个月我临时顶了几个星期的夜班，所以最近作息有点乱，周报也晚交了”。';
const p6bRemember = p6bMessage.split('另外')[0];
const swimming = '- 每周三晚上去游泳 (as of 2026-11-14)';
const nightShift = '- 上个月临时顶了几个星期的夜班，最近作息有点乱，周报也交晚了 (as of 2026-11-14)';
const allergy = '- 对青霉素过敏 (as of 2026-11-14)';
const coffee = '- 早上习惯喝黑咖啡 (as of 2026-11-14)';
const keys = '- 家里备用钥匙放在蓝色鞋柜第二层 (as of 2026-11-14)';

for (const target of [swimming, nightShift]) test(`FT10 remember -> line forget -> question cannot resurrect ${target}`, options, async t => {
  const f = await setup(t, { memoryDeferredSummaryRebuildEnabled: true });
  const uri = `${f.root}/profile.md`;
  const body = ['# 用户',allergy,swimming,coffee,keys,nightShift].join('\n');
  f.conversation.sessionId = 'session_p6b';
  f.conversation.title = '帮我记一下几件个人的事，放进我的个人笔记里：每周三晚上我去游泳；我早上习惯喝黑…';
  const rememberedBody = ['# 用户',allergy,swimming,coffee,keys].join('\n');
  f.stub.extract = () => ({ adds: [{uri,memory_type:'profile',after:rememberedBody}] });
  const remember = await f.memory.callTool('remember', { messages: [{role:'user',content:p6bRemember},
    {role:'assistant',content:'已记入个人笔记：每周三晚上去游泳。'}] });
  assert.equal(remember.isError, false, remember.blocks.join('\n'));
  const toolCommit = (await f.overlay.openCommits({userId:f.userId})).find(commit => commit.origin === 'tool');
  assert.equal(toolCommit.sourceSession, 'dsh-session_p6b', 'the real handler binds remember to its human conversation');
  f.stub.extract = () => ({updates:[{uri,memory_type:'profile',before:rememberedBody,after:body}]});
  const original = await f.commitConversation('p6b', [
    {role:'assistant',text:'（平台信息，不是用户说的话）这段对话在用户的项目「日常笔记」里进行。',at:'2026-11-14T09:52:39.046Z'},
    {role:'user',text:p6bMessage,at:'2026-11-14T09:52:40.000Z'},
  ], {projectId:f.project.id});
  // The external model is a fixed oracle. The gateway, judge parser, worker, store and ledger stay real.
  const judge = createRejectionJudge({config:{deepseekModel:'fixture',deepseekApiKey:'fixture'},callModel:async (_deps, call) => {
    const input = JSON.parse(call.body.messages[1].content);
    const affirmative = target === swimming ? '每周三晚上我去游泳。请重新记住。' : '上个月我临时顶了几个星期的夜班，最近作息有点乱，周报也交晚了。请重新记住。';
    const same = [], stated = [], assertions = [];
    for (const candidate of input.candidates) {
      // Enumerated fixture facts, not a production language rule.
      if (lineFingerprint(candidate.text) === lineFingerprint(removalText(target))) same.push({candidate:candidate.candidate,removed:0});
      // An unsupported stated index used to authorize a write. Deliberately return that
      // bad model verdict for a question: the real parser must demand its missing witness.
      if (input.said.includes(target === swimming ? '我每周哪天去游泳？' : '我上个月上过夜班吗？')) stated.push(candidate.candidate);
      const source = input.said.indexOf(affirmative);
      if (source >= 0 && lineFingerprint(candidate.text) === lineFingerprint(removalText(target))) {
        stated.push(candidate.candidate); assertions.push({candidate:candidate.candidate,source,quote:affirmative});
      }
    }
    return {choices:[{message:{content:JSON.stringify({same,stated,assertions})}}]};
  }});
  f.store.rejectionJudge = judge; f.history.rejectionJudge = judge;
  const forgetMessage = target === swimming ? '我每周三晚上去游泳这条，帮我从记忆里忘掉吧，别的都别动。' : '还有我之前提过的上个月临时顶夜班那件事，也请忘掉，不要再记着。';
  const forgetRequestJudge = { check: async ({conversation: turns,candidates}) => {
    const message = turns.findIndex(turn => turn.role === 'user' && turn.text === forgetMessage);
    const selected = candidates.findIndex(candidate => lineFingerprint(candidate.text) === lineFingerprint(removalText(target)));
    return {requests:message < 0 ? [] : [{message,decision:'remove',targets:[selected],intents:[]}],claims:[]};
  }};
  const worker = new NativeMemoryWorker({config:f.config,sessions:f.sessions,overlay:f.overlay,memorySettings:f.memorySettings,
    memoryContexts:f.contexts,nativeMemory:f.store,rejectionJudge:judge,forgetRequestJudge});
  worker.history = f.history; worker.verification.history = f.history;
  await worker.processCommits({userId:f.userId});
  assert.equal((await f.overlay.commit(f.userId,toolCommit.archiveUri)).state, 'completed');
  const origins = (await f.overlay.originsOf(f.userId,[uri])).get(uri);
  assert.ok(origins.get(lineFingerprint(removalText(swimming))), 'the remembered line has durable origin authority');
  const search = async () => (await f.memory.callTool('search',{query:target === swimming ? '游泳 每周 安排 习惯' : '上个月 夜班'})).blocks.join('\n');
  assert.match(await search(), /每周三晚上我去游泳/);
  f.history.nativeRemovalSources = (owner,sources,context) => worker.verification.readRemovalSources(owner,sources,context);
  f.overlay.memoryForgetBody = (owner,fileUri,text) => f.history.fenceNativeBody(f.context,fileUri,text);
  f.conversation.sessionId = 'session_p6b-forget';
  const answer = await f.memory.callTool('forget',{uri,lines:[target]});
  assert.equal(answer.isError,false,answer.blocks.join('\n'));
  assert.match(answer.blocks.join('\n'),/Removed 1 line/);
  f.stub.extract = () => ({});
  await f.commitConversation('p6b-forget',[{role:'user',text:forgetMessage,at:'2026-11-14T09:53:44Z'},
    {role:'assistant',text:'已经删掉了，其余几条原样保留。',at:'2026-11-14T09:53:55Z'}],{projectId:f.project.id});
  await worker.processCommits({userId:f.userId});
  const hashes = await f.database.query('SELECT archive_uri,message_hash FROM evimed_memory.history_message_rejections WHERE owner_id=$1 AND fingerprint=$2',
    [f.userId,lineFingerprint(removalText(target))]);
  assert.ok(hashes.rows.some(row => row.archive_uri === original.archive_uri && row.message_hash === lineFingerprint(p6bMessage)));
  assert.match(await search(),/withdrawn/);
  assert.doesNotMatch(await search(),/每周三晚上我去游泳|上个月我临时顶了几个星期/);
  assert.match((await f.memory.callTool('read',{uris:[uri]})).blocks.join('\n'),/对青霉素过敏/);
  const after = body.split('\n').filter(line => line !== target).join('\n');
  const question = target === swimming ? '我每周哪天去游泳？' : '我上个月上过夜班吗？';
  const reply = target === swimming ? '每周三晚上。这条来自你在早前对话里说过的话（当时让记进个人笔记：“每周三晚上我去游泳”）。需要我把它补进个人笔记吗？' : '早前对话说你上个月临时顶了几个星期的夜班。需要我补进笔记吗？';
  f.stub.extract = () => ({updates:[{uri,memory_type:'profile',before:after,after:body}]});
  const later = await f.commitConversation('p6b-question',[{role:'user',text:question,at:'2099-01-01T00:00:00Z'},
    {role:'assistant',text:reply,at:'2099-01-01T00:00:01Z'}],{projectId:f.project.id});
  await worker.processCommits({userId:f.userId});
  assert.equal((await f.overlay.commit(f.userId,later.archive_uri)).state,'completed');
  assert.equal(await f.sessions.read(f.userId,uri),after, 'after-write refusal removes the assistant-derived resurrection');
  assert.equal(await f.ledger.rejected(f.context,[reply],later.archive_uri),true,'the assistant retelling cannot become a new history source');
  const affirmative = target === swimming ? '每周三晚上我去游泳。请重新记住。' : '上个月我临时顶了几个星期的夜班，最近作息有点乱，周报也交晚了。请重新记住。';
  await f.commitConversation('p6b-restated',[{role:'user',text:affirmative,at:'2099-01-02T00:00:00Z'}],{projectId:f.project.id});
  await worker.processCommits({userId:f.userId});
  assert.equal(await f.sessions.read(f.userId,uri),body,'a new affirmative human statement can authorize the fact');
  assert.match(await f.history.fenceNativeBody(f.context,uri,body),new RegExp(target === swimming ? '每周三晚上去游泳' : '临时顶了几个星期'));
  assert.equal(await f.ledger.rejected(f.context,[p6bMessage],original.archive_uri),true,'relearning never reopens the old archive');
});

for (const aliases of [false, true]) test(`MG6 withdrawal readers compose HTTP, history ancestry and alias identity (aliases=${aliases})`, options, async t => {
  const f = await setup(t, { memoryPersonAliasHintEnabled: aliases, memoryDeferredSummaryRebuildEnabled: aliases });
  f.overlay.memoryForgetBody = (owner, fileUri, body) => {
    assert.equal(owner, f.userId);
    return f.history.fenceNativeBody(f.context, fileUri, body);
  };
  const withdrawn = 'Project M-41633.', print = lineFingerprint(withdrawn);
  const person = f.seed('people/王阿姨.md', '# 王阿姨\n- Likes walking.', { type: 'people' });
  const sibling = f.seed('people/小王阿姨.md', '# 小王阿姨\n- Independent surviving fact.', { type: 'people' });
  const note = f.seed('notes/project.md', `- ${withdrawn}\n- Independent surviving fact.`, { type: 'notes' });
  const archive = await f.commitConversation('mg6-withdrawn', [{ role: 'user', text: withdrawn }], { projectId: f.project.id });
  await f.overlay.reject(f.userId, 'notes', note, [withdrawn]);
  await f.ledger.rejectMessages(f.context, 'notes', print, [{ archiveUri: archive.archive_uri, text: withdrawn }]);
  await f.overlay.inheritOrigins(f.userId, sibling, new Map([[lineFingerprint('小王阿姨'), [{ archiveUri: archive.archive_uri }]]]));
  const read = await f.memory.callTool('read', { uris: [note, person] });
  assert.equal(read.isError, false);
  assert.match(read.blocks.join('\n'), /Independent surviving fact/);
  assert.doesNotMatch(read.blocks.join('\n'), /M-41633|小王阿姨|possibly the same person/);
  const search = await f.memory.callTool('search', { query: 'walking' });
  assert.equal(search.isError, false);
  assert.doesNotMatch(search.blocks.join('\n'), /小王阿姨|possibly the same person/);
  await f.overlay.unreject(f.userId, 'notes', [withdrawn]);
  const restored = await f.memory.callTool('read', { uris: [note, person] });
  assert.match(restored.blocks.join('\n'), /M-41633/);
  assert.equal(restored.blocks.join('\n').includes('小王阿姨'), aliases, 'undo restores an alias title through the same authority');
});

// FT12: the recorded p6c product path (.lane/p6c). One human message stated four facts and two passing remarks; one
// `remember` call stored the four facts. A lines forget took the swimming line; two statement forgets withdrew the two
// unstored remarks. Every reader must still show the three kept lines, the penicillin allergy among them, and none of
// the three forgotten things. Only the external engine, the model oracle and the runtime identity are fixtures.
const p6cMessage = `${p6bMessage}对了，我是在上周航班延误了四个小时的候机室里写下这句话的，不过这个不用管。`;
// p6c's model passed "上个月临时顶夜班这件事" and the engine's semantic search found the message. The fixture engine
// searches by substring, so the statement uses the person's own words; the stored rows are the same.
const nightStatement = '上个月我临时顶了几个星期的夜班', flightStatement = '上周航班延误了四个小时';
const forgottenWords = /游泳|夜班|航班/;

test('FT12 statement forgets of unstored remarks never mask kept lines from the same conversation, in any reader', options, async t => {
  const f = await setup(t);
  const uri = `${f.root}/profile.md`, safety = `${f.root}/safety_notes/allergy.md`;
  const rememberedBody = ['# 用户', allergy, swimming, coffee, keys].join('\n'), keptBody = ['# 用户', allergy, coffee, keys].join('\n');
  f.conversation.sessionId = 'session_p6c';
  f.stub.extract = () => ({ adds: [{ uri, memory_type: 'profile', after: rememberedBody },
    { uri: safety, memory_type: 'safety_notes', after: '对青霉素过敏。' }] });
  const remember = await f.memory.callTool('remember', { messages: [{ role: 'user', content: p6bRemember }] });
  assert.equal(remember.isError, false, remember.blocks.join('\n'));
  const toolCommit = (await f.overlay.openCommits({ userId: f.userId })).find(commit => commit.origin === 'tool');
  assert.equal(toolCommit.sourceSession, 'dsh-session_p6c', 'all four lines are bound to the one remember call of this conversation');
  f.stub.extract = () => ({});
  const original = await f.commitConversation('p6c', [
    { role: 'assistant', text: '（平台信息，不是用户说的话）这段对话在用户的项目「日常笔记」里进行。', at: '2026-11-14T11:40:13.000Z' },
    { role: 'user', text: p6cMessage, at: '2026-11-14T11:40:14.170Z' },
    { role: 'assistant', text: '你让我记的四件事都已写进个人笔记。润色后的句子只作交流使用，没有保存。', at: '2026-11-14T11:40:44.471Z' },
  ], { projectId: f.project.id });
  // A fixed model oracle over enumerated fixture facts, not a production language rule.
  const topics = [['游泳', '游泳'], ['夜班', '夜班'], ['航班', '航班延误']];
  /** @param {{candidates:{text:string,removed:{fingerprint:string,text:string|null}[]}[]}} request */
  const same = async ({ candidates }) => ({ stated: new Set(), same: new Map(candidates.flatMap((candidate, index) => {
    const removal = candidate.removed[0];
    const hit = topics.some(([removed, said]) => String(removal?.text ?? '').includes(removed) && candidate.text.includes(said));
    return hit ? [[index, removal.fingerprint]] : [];
  })) });
  const judge = { same };
  f.store.rejectionJudge = judge; f.history.rejectionJudge = judge;
  const worker = new NativeMemoryWorker({ config: f.config, sessions: f.sessions, overlay: f.overlay, memorySettings: f.memorySettings,
    memoryContexts: f.contexts, nativeMemory: f.store, rejectionJudge: judge });
  worker.history = f.history; worker.verification.history = f.history;
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), rememberedBody);
  // The production wiring (server.mjs) of every native reader.
  f.history.nativeRemovalSources = (owner, sources, context) => worker.verification.readRemovalSources(owner, sources, context);
  f.overlay.memoryForgetBody = (owner, fileUri, text) => f.history.fenceNativeBody(f.context, fileUri, text);

  f.conversation.sessionId = 'session_p6c-2';
  const lines = await f.memory.callTool('forget', { uri, lines: [swimming] });
  assert.match(lines.blocks.join('\n'), /Removed 1 line/);
  for (const [session, statement] of [['session_p6c-3', nightStatement], ['session_p6c-3b', flightStatement]]) {
    f.conversation.sessionId = session;
    const answer = await f.memory.callTool('forget', { statement });
    assert.equal(answer.isError, false, answer.blocks.join('\n'));
    assert.match(answer.blocks.join('\n'), /history recall rejection/);
  }
  assert.equal(await f.sessions.read(f.userId, uri), keptBody, 'the engine file keeps the three lines');
  // The rows that used to mask them: the remember archive fenced for swimming, the conversation message fenced for each remark.
  const rows = (await f.database.query('SELECT fingerprint,archive_uri,message_hash FROM evimed_memory.history_message_rejections WHERE owner_id=$1', [f.userId])).rows;
  assert.ok(rows.some(row => row.archive_uri === toolCommit.archiveUri && row.fingerprint === lineFingerprint(removalText(swimming))));
  for (const statement of [nightStatement, flightStatement]) assert.ok(rows.some(row => row.archive_uri === original.archive_uri
    && row.fingerprint === lineFingerprint(statement) && row.message_hash === lineFingerprint(p6cMessage)), statement);

  // conversation 4: read, search, list, the opening block and the safety block.
  f.conversation.sessionId = 'session_p6c-4';
  const read = (await f.memory.callTool('read', { uris: [uri] })).blocks.join('\n');
  const search = (await f.memory.callTool('search', { query: '青霉素' })).blocks.join('\n');
  const listed = (await f.memory.callTool('list', {})).blocks.join('\n');
  const opening = await (await fetch(`${f.base}/api/v1/content/read?uri=${encodeURIComponent(uri)}`, { headers: { authorization: `Bearer ${f.token}` } })).text();
  const safetyBlock = JSON.stringify(await f.store.safetyNotes(f.userId, f.project.id));
  for (const [reader, output] of Object.entries({ read, search, opening })) {
    for (const line of [allergy, coffee, keys]) assert.ok(output.includes(removalText(line).replace(/ \(as of .*\)$/, '')), `${reader} shows ${line}`);
  }
  assert.match(listed, /profile\.md/);
  assert.match(safetyBlock, /对青霉素过敏/, 'the safety block keeps the allergy');
  for (const [reader, output] of Object.entries({ read, search, listed, opening, safetyBlock })) assert.doesNotMatch(output, forgottenWords, reader);
  assert.doesNotMatch(JSON.stringify(await f.store.files(f.userId)), forgottenWords);

  // An assistant restatement after a question cannot re-learn a forgotten remark; the kept lines are untouched by that refusal.
  f.stub.extract = () => ({ updates: [{ uri, memory_type: 'profile', before: keptBody, after: `${keptBody}\n- ${flightStatement} (as of 2026-11-14)` }] });
  await f.commitConversation('p6c-question', [{ role: 'user', text: '我上周的航班是不是延误了？', at: '2099-01-01T00:00:00Z' },
    { role: 'assistant', text: `是的，你说过${flightStatement}。`, at: '2099-01-01T00:00:01Z' }], { projectId: f.project.id });
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), keptBody, 'the assistant-derived line was refused');
  const after = (await f.memory.callTool('read', { uris: [uri] })).blocks.join('\n');
  assert.match(after, /对青霉素过敏/);
  assert.doesNotMatch(after, forgottenWords);
  // The person saying it again, as a whole message in a new conversation, re-admits it without any model verdict.
  f.stub.extract = () => ({ updates: [{ uri, memory_type: 'profile', before: keptBody, after: `${keptBody}\n- ${flightStatement} (as of 2099-01-02)` }] });
  await f.commitConversation('p6c-restated', [{ role: 'user', text: flightStatement, at: '2099-01-02T00:00:00Z' }], { projectId: f.project.id });
  await worker.processCommits({ userId: f.userId });
  const restated = (await f.memory.callTool('read', { uris: [uri] })).blocks.join('\n');
  assert.match(restated, new RegExp(flightStatement));
  assert.match(restated, /对青霉素过敏/);
});
