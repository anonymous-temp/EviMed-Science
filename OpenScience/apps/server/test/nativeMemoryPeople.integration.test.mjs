// PostgreSQL + real gateway/admission/store/overlay and native HTTP client. Only the external kernel and engine are fixtures.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { NativeMemoryStore, nativeFileId } from '../src/nativeMemoryStore.mjs';
import { NativeMemoryWorker } from '../src/nativeMemoryWorker.mjs';
import { createMemoryGatewayHandler, personDecisionMessages, MEMORY_GATEWAY_PATH, parseEventStream } from '../src/memoryGateway.mjs';
import { createMemoryAdmission } from '../src/memoryAdmission.mjs';
import { GeoNativeMemoryContext } from '../src/geoNativeMemoryContext.mjs';
import { normalizeTranscript } from '../src/dshRuntimeAdapter.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { personPairId } from '../src/nativeMemoryPeople.mjs';
const { fixture, options } = nativeIntegration();

test('AL9 real gateway and PostgreSQL: distinct, confirmation, merge, inherited-line forget, undo, redirect and erasure', options, async t => {
  const f = await fixture(t);
  await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Test',1048576)", [f.userId]);
  const project = { id: 'default', userId: f.userId }, user = { id: f.userId };
  const config = { ...f.config, memoryEnabled: true, memoryRecallEnabled: true, memoryPersonMergeEnabled: true,
    memoryPersonAliasHintEnabled: true, memoryForgetTargetsEnabled: true };
  const contexts = new GeoNativeMemoryContext({ database: f.database, documents: null, sessions: f.sessions,
    policies: { forProject: async () => ({ kind: 'owned' }), policiesForOwner: async () => [] }, settingsForOwner: id => f.memorySettings.settings(id) });
  const context = await contexts.forProject(project);
  const store = new NativeMemoryStore({ sessions: f.sessions, overlay: f.overlay, memoryContexts: contexts, personMergeEnabled: true, forgetTargetsEnabled: true });
  const keepBody = '# 王阿姨\n## 2026-10-01\n- Weight: 50 kg\n- Likes tea.';
  const otherBody = '# 小王阿姨\n## 2026-11-01\n- Weight: 55 kg\n- Likes tea.';
  const keep = f.seed('people/王阿姨.md', keepBody, { type: 'people' }), merge = f.seed('people/小王阿姨.md', otherBody, { type: 'people' });
  for (const [uri, body, engineSession] of [[keep, keepBody, 'dsh-original-a'], [merge, otherBody, 'dsh-original-b']]) {
    await f.overlay.upsertFile({ userId: f.userId, uri, body, memoryType: 'people' });
    await f.overlay.syncOrigins(f.userId, uri, { after: body, origin: { engineSession, projectId: project.id, projectCreatedAt: context.projectCreatedAt } });
  }
  let sessionId = 'session_0123456789abcdef0123456789abcdef';
  const token = 'person-test-token';
  const events = [];
  const say = text => events.push({ type: 'user/message', seq: events.length, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
  const admission = createMemoryAdmission({ config, memorySettings: f.memorySettings,
    conversations: { running: async () => [{ id: 'run', sessionId }], runsOf: async () => [] } });
  const handler = createMemoryGatewayHandler({ config, sessions: f.sessions, overlay: f.overlay, memoryTool: store, memoryContexts: contexts, admission,
    runtimeManager: { assertActiveEviMedWorkloadToken: async value => { assert.equal(value, token); return { userId: user.id, projectId: project.id }; } },
    store: { userById: async () => user, requireProject: async () => project },
    personMessages: async () => personDecisionMessages(normalizeTranscript(sessionId, events)) });
  const server = createServer((req, res) => { void handler(req, res, () => {}); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}${MEMORY_GATEWAY_PATH}`;
  const call = async (name, args) => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-evimed-memory-session': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return response.headers.get('content-type').includes('event-stream') ? parseEventStream(text)[0] : JSON.parse(text);
  };
  const read = async uri => (await call('read', { uris: [uri] })).result.content.map(part => part.text).join('\n');
  assert.match(await read(keep), /Related people files/);
  const no = '王阿姨和小王阿姨不是同一个人。'; say(no);
  assert.ok((await call('merge_people', { keep, merge, confirmation: no })).error);
  assert.equal(await f.sessions.read(f.userId, merge), otherBody);
  assert.ok((await call('distinct_people', { a: keep, b: merge, confirmation: no })).result);
  assert.ok((await store.personEdges.dismissed(f.userId)).has(personPairId(keep, merge)));
  assert.doesNotMatch(await read(keep), /Related people files/);
  config.memoryPersonMergeEnabled = false;
  assert.match(await read(keep), /Related people files/, 'switch off leaves the original alias hint unchanged');
  config.memoryPersonMergeEnabled = true;
  const yes = '更正一下，王阿姨和小王阿姨是同一个人，请合并。';
  assert.ok((await call('merge_people', { keep, merge, confirmation: yes })).error, 'a model-authored claim is not confirmation');
  say(yes);
  assert.ok((await call('merge_people', { keep, merge, confirmation: yes })).result);
  const after = await f.sessions.read(f.userId, keep);
  assert.match(after, /2026-10-01\n- Weight: 50/); assert.match(after, /2026-11-01\n- Weight: 55/);
  assert.equal(after.split('- Likes tea.').length, 2); assert.equal(after.split('又称：小王阿姨').length, 2);
  assert.equal(await f.sessions.read(f.userId, merge), null);
  assert.match(await read(merge), /Weight: 55/);
  assert.equal((await f.overlay.revisionsOf(f.userId, keep)).length, 1, 'one page revision owns the two-file operation');
  assert.equal((await f.overlay.originsOf(f.userId, [keep])).get(keep).get(lineFingerprint('Weight: 55 kg')).engineSession, 'dsh-original-b');
  assert.ok((await call('forget', { uri: keep, lines: ['- Weight: 55 kg'] })).result);
  assert.doesNotMatch(await f.sessions.read(f.userId, keep), /Weight: 55/);
  await store.undo(f.userId, nativeFileId(keep)); // Undo the later forget first, as on the memory page.
  await store.undo(f.userId, nativeFileId(keep)); // Then undo the single merge revision.
  assert.equal(await f.sessions.read(f.userId, keep), keepBody); assert.equal(await f.sessions.read(f.userId, merge), otherBody);
  assert.equal((await f.overlay.personMerges(f.userId)).length, 0);
  const event = (type, data) => events.push({ type, seq: events.length, time: Date.now(), data });
  event('turn/start', { turn: 1 });
  say('请核实这两张人物卡。');
  const hinted = await call('read', { uris: [keep] });
  assert.match(hinted.result.content.at(-1).text, /People confirmation pairs: /);
  event('tool/call', { turn: 1, name: 'mcp__openviking__read', callId: 'hint', arguments: { uris: [keep] } });
  event('tool/result', { message: { toolCallId: 'hint', content: hinted.result.content } });
  event('assistant/message', { turn: 1, message: { content: '「王阿姨」和「小王阿姨」是同一个人吗？回复是/不是' } });
  event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  event('turn/start', { turn: 2 });
  say('是');
  assert.ok((await call('merge_people', { keep, merge, confirmation: '是' })).result);
  assert.equal((await f.overlay.personMerges(f.userId)).length, 1);
  const later = '# 小王阿姨\n## 2026-11-14\n- Likes walking.';
  f.stub.extract = () => ({ adds: [{ uri: merge, memory_type: 'people', after: later }] });
  await f.commitConversation('person_later', [{ role: 'user', text: '小王阿姨喜欢散步。' }], { projectId: project.id });
  const worker = new NativeMemoryWorker({ ...f, config, nativeMemory: store, memoryContexts: contexts });
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, merge), null);
  assert.match(await f.sessions.read(f.userId, keep), /Likes walking/);
  const consolidated = (await f.sessions.read(f.userId, keep)).split('\n').filter(line => !['# 小王阿姨', '- 又称：小王阿姨'].includes(line.trim())).join('\n');
  await f.sessions.replace(f.userId, keep, consolidated);
  await worker.ingestConsolidation(f.userId, { taskId: 'person-alias-cleanup', updates: [keep] }, { context });
  assert.doesNotMatch(await f.sessions.read(f.userId, keep), /小王阿姨/, 'ordinary cleanup may remove the visible alias line');
  sessionId = 'session_abcdef0123456789abcdef0123456789';
  events.length = 0;
  say('小王阿姨喜欢什么？');
  const recalled = await call('search', { query: '小王阿姨喜欢什么？' });
  const hits = JSON.parse(recalled.result.content[0].text);
  assert.equal(hits.memories[0].uri, keep, 'the durable confirmed merge still resolves its alias in the next conversation');
  assert.match(hits.memories[0].abstract, /Likes walking/);
  await f.overlay.scrubLines(f.userId, keep, ['Weight: 50 kg'], { sourceDeleted: true });
  assert.equal((await f.overlay.personMerges(f.userId))[0].snapshot, null, 'privacy deletion invalidates both undo before-images');
  await f.database.query('DELETE FROM evimed_control.users WHERE id=$1', [f.userId]);
  for (const table of ['native_person_merges', 'map_edge_dismissals']) {
    assert.equal((await f.database.query(`SELECT count(*)::int AS n FROM evimed_memory.${table} WHERE user_id=$1`, [f.userId])).rows[0].n, 0);
  }
});
