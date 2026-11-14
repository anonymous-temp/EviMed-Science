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
    memoryTool: store, historySearch: request => history.search(request), admission: createMemoryAdmission({ config, memorySettings: f.memorySettings }),
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
  return { ...f, store, context, contexts, config, history, ledger, memory, user, project, base: server.base, token };
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
    assert.match(recorded.blocks.join('\n'), /Recorded.*Earlier conversations are still being checked; paraphrases may still be recalled/);
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
  if (state === 'running') { work = f.history.drainForgetScans(); await started; }
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
  const fresh = await f.commitConversation('later-authorized', [{ role: 'user', text: examinationStatement, at: '2099-01-01T00:00:00Z' }], { projectId: f.project.id });
  await ingest(fresh);
  assert.equal(await f.ledger.forgetArchivePending(f.context, fresh.archive_uri), false);
  assert.equal((await f.history.search({ user: f.user, project: f.project, query: examinationStatement })).length, 1);
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
  await started;
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
