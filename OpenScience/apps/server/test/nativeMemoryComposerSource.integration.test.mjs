// Native composer: no dispatched run, one-shot remember first, original conversation archive later.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { createMemoryAdmission } from '../src/memoryAdmission.mjs';
import { createMemoryGatewayHandler, MEMORY_GATEWAY_PATH } from '../src/memoryGateway.mjs';
import { NativeMemoryWorker } from '../src/nativeMemoryWorker.mjs';
import { createInstructionOriginJudge } from '../src/nativeMemoryInstructionOrigin.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { nativeMemoryCounters } from '../src/nativeMemoryMetrics.mjs';
const { options, fixture } = nativeIntegration();
const own = 'I swim on Wednesday evenings.', remaining = 'I am a community physician.';
const enabled = { memoryPastedInstructionCheckEnabled: true, memoryPastedInstructionRobustEnabled: true,
  memoryForgetTargetsEnabled: true, memoryExtractionModel: 'deepseek-flash', deepseekApiKey: 'synthetic-test-value' };

test('native composer source binding, delayed review, historical repair and held forget cross the real gateway/overlay/worker', options, async t => {
  const f = await fixture(t, { config: enabled });
  f.store.forgetTargetsEnabled = true;
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'named-study','Community follow-up',1048576),($1,'default','Default',1048576)", [f.userId]);
  const user = { id: f.userId }, project = { id: 'named-study', name: 'Community follow-up', userId: f.userId };
  const source = 'native-composer', engineSource = `dsh-${source}`, profile = `${f.root}/profile.md`, card = `${f.root}/projects/community.md`;
  // The historical receipt below covers exactly these two lines, with no unreviewed heading.
  f.stub.extract = ({ session }) => session.startsWith('mcp-store-') ? { adds: [
    { uri: profile, memory_type: 'profile', after: `- ${own}\n- ${remaining}` },
    { uri: card, memory_type: 'project_context', after: '# Community follow-up\n- Measure follow-up attendance.' },
  ] } : {};
  const admission = createMemoryAdmission({ config: f.config, memorySettings: f.memorySettings,
    conversations: { running: async () => [], runsOf: async () => [] } });
  const gateway = createMemoryGatewayHandler({ config: f.config, sessions: f.sessions, admission, overlay: f.overlay, memoryTool: f.store,
    runtimeManager: { assertActiveEviMedWorkloadToken: async token => ({ userId: f.userId, projectId: token === 'default-runtime' ? 'default' : project.id }) },
    store: { userById: async () => user, requireProject: async (_user, id) => ({ ...project, id }) } });
  const server = createServer((req, res) => { void gateway(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const post = (path, body, token = 'named-runtime') => fetch(`http://127.0.0.1:${address.port}${MEMORY_GATEWAY_PATH}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-evimed-memory-session': source }, body: JSON.stringify(body),
  });
  const reviewed = [];
  const judge = createInstructionOriginJudge({ config: f.config, callModel: async (_deps, call) => {
    const input = JSON.parse(call.body.messages[1].content); reviewed.push(input);
    return { choices: [{ message: { content: JSON.stringify({ judgements: input.candidates.map(candidate => ({ candidate: candidate.candidate, decision: 'keep', message: null, quote: '' })) }) } }] };
  } });
  const worker = new NativeMemoryWorker({ config: f.config, sessions: f.sessions, overlay: f.overlay, nativeMemory: f.store, memorySettings: f.memorySettings, pastedInstructionJudge: judge });
  const remember = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'remember', arguments: { messages: [{ role: 'user', content: 'Model-written memory arguments, not the original human message.' }], sessionId: 'victim' } } };
  assert.equal((await post('/mcp', remember)).status, 200);
  const [tool] = (await f.overlay.openCommits({ userId: f.userId })).filter(row => row.origin === 'tool');
  assert.equal(tool.sourceSession, engineSource);
  assert.equal(tool.projectId, project.id);
  assert.equal(await f.overlay.projectOfSession(f.userId, engineSource), project.id, 'tool binding freezes the project before the later capture');
  assert.equal((await post('/mcp', remember, 'default-runtime')).status, 403, 'the same source cannot be relabelled by a default runtime');
  assert.equal(await worker.processCommits({ userId: f.userId }), 0);
  assert.equal((await f.overlay.commit(f.userId, tool.archiveUri)).state, 'pending');
  assert.match(await f.sessions.read(f.userId, profile), /Wednesday/, 'deferring the tool commit preserves the extracted profile');
  assert.equal((await f.store.pending(f.userId)).length, 0);
  assert.equal(reviewed.length, 0, 'no source means defer without a model verdict');
  assert.ok(nativeMemoryCounters().pastedInstructionChecks.source_deferred > 0);

  assert.equal((await post('/api/v1/sessions', { session_id: engineSource })).status, 200);
  assert.equal((await post(`/api/v1/sessions/${engineSource}/messages`, { role: 'user', content: `Please remember: ${own} ${remaining}` })).status, 200);
  const committed = await gateway.commitSession({ user, project, engineSessionId: engineSource });
  assert.equal(committed.commit, 'accepted');
  await worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.commit(f.userId, tool.archiveUri)).state, 'completed');
  assert.ok(reviewed.length > 0);
  assert.ok(reviewed.every(input => !JSON.stringify(input.conversation).includes('Model-written')));
  assert.equal((await f.overlay.file(f.userId, card)).projectId, project.id);
  assert.match(await f.sessions.read(f.userId, profile), /Wednesday/, 'source-backed settlement preserves the extracted profile');

  const before = await f.sessions.read(f.userId, profile);
  const seedHold = async () => {
    await f.sessions.remove(f.userId, profile); await f.overlay.removeFile(f.userId, profile);
    return f.overlay.addRevision({ userId: f.userId, uri: profile, memoryType: 'profile', change: 'deleted', actor: 'platform',
      reason: 'pasted_instruction_pending', before, after: null, engineSession: tool.engineSession, sourceProjectId: project.id });
  };
  const first = await seedHold(), duplicate = await seedHold();
  await f.overlay.recordInstructionCheck(f.userId, 'historical-source-missing', {
    refused: [], pending: [0, 1], pendingKeys: [own, remaining].map(text => ({ uri: profile, fingerprint: lineFingerprint(text) })),
    receipts: [{ sources: [], reviews: [0, 1].map(() => [own, remaining].map((_text, candidate) => ({ candidate, decision: 'keep', message: null, start: null, length: 0 }))) }],
  });
  assert.equal((await f.store.pending(f.userId)).length, 2, 'two revisions show each line once');
  await worker.reviewPendingInstructionWrites(f.userId);
  assert.match(await f.sessions.read(f.userId, profile), /Wednesday/, 'complete historical receipts restore the missing profile');
  assert.ok((await f.overlay.revision(f.userId, first.id)).undoneAt);
  assert.ok((await f.overlay.revision(f.userId, duplicate.id)).undoneAt);
  await worker.reviewPendingInstructionWrites(f.userId);
  assert.equal((await f.overlay.revisionsOf(f.userId, profile)).filter(row => row.reason === 'instruction_source_released').length, 1);

  const forgottenHold = await seedHold();
  const forget = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'forget', arguments: { statement: own } } });
  assert.equal(forget.status, 200);
  assert.deepEqual((await f.store.pending(f.userId)).map(row => row.text), [remaining], 'partial forget retires only matching held text');
  const forgetRest = await post('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'forget', arguments: { uri: profile, lines: [remaining] } } });
  assert.equal(forgetRest.status, 200);
  assert.equal((await f.store.pending(f.userId)).length, 0);
  assert.ok((await f.overlay.revision(f.userId, forgottenHold.id)).undoneAt);
  const forgotten = await f.store.forgotten(f.userId);
  assert.ok(forgotten.some(row => row.value.includes(own)));
  assert.ok((await f.overlay.removals(f.userId)).some(row => row.fingerprint === lineFingerprint(own)));
  await worker.reviewPendingInstructionWrites(f.userId);
  assert.equal(await f.sessions.read(f.userId, profile), null, 'recovery cannot undo the subsequent forget');
});
