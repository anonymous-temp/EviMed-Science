// Real HTTP gateway argument validation -> NativeMemoryStore -> PostgreSQL overlay/history -> engine HTTP client.
// Only the external engine and the runtime/account identity boundary are fixtures; no forget layer is replaced.
import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { NativeMemoryStore, nativeFileId } from '../src/nativeMemoryStore.mjs';
import { removalText } from '../src/nativeMemoryRejections.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
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
