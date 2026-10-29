import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebApiApp } from '../src/server.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

test('completion captures durable child ownership and authenticated HTTP reads survive runtime shutdown', {
  skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable local PostgreSQL required', timeout: 30_000,
}, async t => {
  const database = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'runevidence');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'run-evidence-'));
  const app = createWebApiApp({ dataDir, databaseUrl: database.url, stateStore: 'postgres', requireSharedStateStore: true,
    runtimeMode: 'mock', devAuth: false, authMode: 'local', bootstrapUser: '', bootstrapPassword: '',
    learningEnabled: false, evolutionEnabled: false });
  t.after(async () => { await app.close(); await database.drop(); await rm(dataDir, { recursive: true, force: true }); });
  await app.store.createUser('archive_owner', 'test-only-password', 'Owner');
  await app.store.createUser('archive_other', 'test-only-password', 'Other');
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const login = async username => {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'test-only-password' }) });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  const headers = await login('archive_owner');
  const user = await app.store.userById('archive_owner');
  const project = await app.store.requireProject(user, 'default');
  await app.researchSessions.put(project, 'archive_root', { mode: 'open-domain' });
  const { run } = await app.agentRuns.reserveRun(project, { sessionId: 'archive_root', mode: 'open-domain', agentId: null, agentVersion: null, runtimeAgent: null }, {
    automated: true, nativeTurn: { startSeq: 2, userSeq: 3 }, kernelRequestIds: ['archive_request'],
  });
  const msg = (seq, start, role, parts, request = null) => ({ seq, turnStartSeq: start, sourceRequestId: request, role,
    source: role === 'user' ? 'user' : 'system', time: Date.now(), parts });
  const root = { exhausted: true, lastSeq: 7, messages: [
    msg(1, 1, 'user', [{ type: 'text', text: 'Previous private turn' }], 'old_request'),
    msg(3, 2, 'user', [{ type: 'text', text: 'Count distinct patients' }], 'archive_request'),
    msg(4, 2, 'tool', [{ type: 'tool', tool: 'vcr_read', status: 'completed', input: { what: 'population' },
      output: 'ok\n{"patients":78,"authorization":"Basic private-fixture"}' }]),
    msg(5, 2, 'assistant', [{ type: 'text', text: '78 patients' }, { type: 'reasoning', text: 'Private reasoning' }]),
    msg(7, 7, 'user', [{ type: 'text', text: 'Later private turn' }], 'later_request'),
  ] };
  const child = { exhausted: true, lastSeq: 1, messages: [msg(1, 1, 'assistant', [{ type: 'text', text: 'Child verified distinct IDs' }])] };
  // Only the kernel transport is a double. The real completion hook writes the receipt and the real route verifies it.
  let liveReads = 0;
  app.runtimeManager.sessionTranscript = async (_project, sessionId) => { liveReads++; return sessionId === 'archive_root' ? root : child; };
  app.agentRuns.childSessionsOf = async () => [{ sessionId: 'archive_child', parentSessionId: 'archive_root', label: 'Check' }];
  await app.agentRuns.finishInternal(project, run.id, { status: 'succeeded', verification: 'unverified' });
  const captured = (await app.agentRuns.list(project)).find(item => item.id === run.id);
  assert.ok(captured.transcript?.sha256, 'the production completion callback persisted a transcript receipt');
  assert.ok(liveReads >= 2);
  const transcriptPath = path.join(project.rootDir, captured.transcript.path);
  const bytes = await readFile(transcriptPath, 'utf8');
  assert.deepEqual(JSON.parse(bytes.split('\n')[0]).runChildSessionIds, ['archive_child']);
  app.runtimeManager.sessionTranscript = async () => { throw new Error('Runtime stopped: an archive read must not wake it'); };
  app.agentRuns.childSessionsOf = async () => [];
  const route = `/api/research-sessions/archive_root/history?runId=${run.id}&include=tools`;
  const response = await fetch(base + route, { headers });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.available, true); assert.equal(data.partial, false); assert.equal(data.automated, true);
  assert.equal(data.sourceSha256, captured.transcript.sha256);
  assert.ok(data.messages.some(item => item.sessionId === 'archive_child'));
  assert.equal(data.messages.find(item => item.seq === 4).parts[0].tool, 'vcr_read');
  for (const absent of ['Previous private turn', 'Later private turn', 'Private reasoning', 'private-fixture']) assert.ok(!JSON.stringify(data).includes(absent));
  assert.equal((await fetch(base + route)).status, 401);
  assert.equal((await fetch(base + route, { headers: await login('archive_other') })).status, 404);
  assert.equal((await fetch(base + route.replace('archive_root', 'foreign_session'), { headers })).status, 404);
  assert.equal((await fetch(base + '/api/research-sessions/archive_root/history?include=tools', { headers })).status, 400);
  await writeFile(transcriptPath, bytes + ' ');
  const tampered = await fetch(base + route, { headers });
  assert.notEqual(tampered.status, 200);
  assert.equal((await tampered.json()).code, 'run_transcript_changed');
});
