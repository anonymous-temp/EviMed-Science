import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeMemoryEngineDeferred } from '../src/nativeMemoryEngineDeferred.mjs';
import { createMemoryAdmission } from '../src/memoryAdmission.mjs';
import { createMemoryGatewayHandler } from '../src/memoryGateway.mjs';
import { NativeTurnCommit } from '../src/nativeTurnCommit.mjs';
import { nativeMemoryCounters, nativeMemoryMetricFamilies, resetNativeMemoryMetrics } from '../src/nativeMemoryMetrics.mjs';
import { OpenVikingClient } from '../src/openVikingClient.mjs';
import { OpenVikingSessions } from '../src/openVikingSessions.mjs';
import { startOpenVikingStub } from './helpers/openVikingStub.mjs';

async function fixture(t, { shared = false } = {}) {
  resetNativeMemoryMetrics();
  const userId = 'startup-user', project = { id: 'startup-project', userId };
  const run = { id: 'startup-run', sessionId: 'startup-session', startedAt: '2026-11-15T10:00:00Z', finishedAt: '2026-11-15T10:01:00Z', status: 'succeeded', agentId: 'ordinary' };
  const rows = new Map(); let ready = false, refused = null, time = Date.parse(run.finishedAt);
  const memorySettings = { configured: true, accountExists: async () => true, resetInstant: async () => refused === 'before_reset' ? new Date(Date.parse(run.finishedAt) + 60_000).toISOString() : null,
    settings: async () => ({ learningPaused: refused === 'paused', recallPaused: false, pausedProjects: [] }),
    sessionState: async () => ({ trialCapsuleId: refused === 'trial' ? 'trial' : null }) };
  const conversations = { running: async () => [], runsOf: async () => [run] };
  const admission = createMemoryAdmission({ config: {}, memorySettings, conversations,
    engineReady: () => ({ ok: ready, code: null }), internalAgent: async () => refused === 'internal_project', clinicalContext: async () => refused === 'clinical_context', sourceDeleted: async () => refused === 'source_deleted' });
  const overlay = { configured: false,
    recordCommit: async input => {
      const held = rows.get(input.archiveUri);
      if (held) { Object.assign(held, { taskId: held.taskId ?? input.taskId, sourceSession: held.sourceSession ?? input.sourceSession }); return { ...held, inserted: false }; }
      const row = { ...input, state: input.state ?? 'pending', createdAt: new Date(time).toISOString(), extraction: input.extraction ?? {} };
      rows.set(input.archiveUri, row); return { ...row, inserted: true };
    },
    commit: async (_id, uri) => rows.get(uri),
    abandonCommit: async (_id, uri, error) => Object.assign(rows.get(uri), { state: 'abandoned', error }),
    noteReplayAttempt: async () => {},
    markReplayed: async (_id, uri, replayedAs) => Object.assign(rows.get(uri), { state: 'replayed', replayedAs }),
  };
  const stub = await startOpenVikingStub(t);
  const sessions = new OpenVikingSessions(new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: 'evimed' }));
  const context = { kind: 'geo-project', ownerId: userId, projectId: project.id, namespaceId: sessions.engineUser(userId), sessions, userRoot: sessions.userRoot(userId) };
  const memoryContexts = shared ? { forProject: async () => context, assertLive: async () => {}, configure: async () => {},
    noteCapture: async (_context, sessionId) => sessionId === `dsh-${run.sessionId}` ? { verified: true } : null,
    noteInternal: async (_context, _session, source) => { assert.equal(source.kind, 'page'); assert.match(source.operationRef, /^engine-startup:[a-f0-9]{32}$/); } } : null;
  const config = { memoryEngineEnabled: true, memoryEnabled: true, memorySharedCaptureProofEnabled: shared };
  const gateway = createMemoryGatewayHandler({ config, sessions, admission, overlay, memoryContexts, runtimeManager: {}, store: {} });
  const deferred = new NativeMemoryEngineDeferred({ config, overlay, sessions, admission, memorySettings, memoryContexts, commit: gateway.commitSession,
    project: async () => project, now: () => new Date(time), transcript: async () => ({ exhausted: true, messages: [
      { role: 'user', source: 'user', time: Date.parse(run.startedAt) + 1, parts: [{ type: 'text', text: 'Prefer short answers.' }] },
      { role: 'user', source: 'schedule', time: Date.parse(run.startedAt) + 2, parts: [{ type: 'text', text: 'Do not learn this platform text.' }] },
      { role: 'user', source: 'user', time: Date.parse(run.finishedAt) + 1, parts: [{ type: 'text', text: 'Do not learn this later turn.' }] },
    ] }) });
  const entry = { userId, project, sessionId: run.sessionId, engineSessionId: `dsh-${run.sessionId}`, run };
  const committer = new NativeTurnCommit({ config, memorySettings, sessions, admission, conversations, memoryContexts, commit: gateway.commitSession, deferEngine: value => deferred.defer(value) });
  t.after(() => committer.close());
  return { deferred, entry, rows, stub, committer, overlay, ready: () => { ready = true; }, refuse: reason => { refused = reason; }, advance: ms => { time += ms; } };
}

test('startup defers before debounce and recovers just the original human turn through the real gateway', async t => {
  const f = await fixture(t);
  await f.committer.noteRunFinished(f.entry.project, f.entry.run);
  assert.equal(f.rows.size, 1); assert.equal(f.committer.armed.size, 0);
  const row = [...f.rows.values()][0];
  assert.equal(nativeMemoryCounters().turnCommits.engine_deferred, 1);
  assert.equal(await f.deferred.process(row), false);
  f.ready(); assert.equal(await f.deferred.process(row), true);
  assert.equal(row.state, 'replayed');
  const posted = f.stub.sent('POST', `/api/v1/sessions/evimed-replay-${f.deferred.key(row.archiveUri)}/messages`);
  assert.equal(posted.length, 1); assert.match(JSON.stringify(posted), /Prefer short answers/);
  assert.equal(nativeMemoryCounters().turnCommits.engine_committed, 1);
  assert.equal(await f.deferred.process(row), false, 'a settled obligation cannot duplicate a commit');
});

for (const reason of ['paused', 'trial', 'clinical_context', 'source_deleted', 'internal_project', 'before_reset']) test(`startup recovery refuses ${reason} without sending messages`, async t => {
  const f = await fixture(t); await f.deferred.defer(f.entry);
  const row = [...f.rows.values()][0]; f.refuse(reason); f.ready();
  assert.equal(await f.deferred.process(row), true);
  assert.equal(row.state, 'abandoned');
  assert.equal(f.stub.sent('POST', '/api/v1/sessions').length, 0);
  assert.equal(nativeMemoryCounters().turnCommits.engine_given_up, 1);
});

test('startup waiting expires at thirty minutes without touching the engine', async t => {
  const f = await fixture(t); await f.deferred.defer(f.entry); const row = [...f.rows.values()][0];
  f.advance(30 * 60_000); assert.equal(await f.deferred.process(row), true);
  assert.equal(row.error, 'engine_startup_wait_expired'); assert.equal(f.stub.sent('POST', '/api/v1/sessions').length, 0);
});

test('startup metric outcomes exist at zero, including engine refusals', () => {
  resetNativeMemoryMetrics();
  for (const outcome of ['engine_unavailable', 'engine_deferred', 'engine_committed', 'engine_given_up']) {
    assert.equal(nativeMemoryCounters().turnCommits[outcome], 0);
    assert.ok(nativeMemoryMetricFamilies().find(family => family.name === 'open_science_native_memory_turn_commits_total').series.some(series => series.labels.outcome === outcome && series.value === 0));
  }
  assert.equal(nativeMemoryCounters().withheld.engine_unavailable, 0);
});


test('a crash after accepted commit reconciles its archive without repeating extraction', async t => {
  const f = await fixture(t); await f.deferred.defer(f.entry); const row = [...f.rows.values()][0]; f.ready();
  const mark = f.overlay.markReplayed;
  let crash = true;
  f.overlay.markReplayed = async (...args) => { if (crash) { crash = false; throw new Error('process stopped after engine commit'); } return mark(...args); };
  await assert.rejects(() => f.deferred.process(row), /process stopped/);
  assert.equal(await f.deferred.process(row), true);
  const path = `/api/v1/sessions/evimed-replay-${f.deferred.key(row.archiveUri)}`;
  assert.equal(f.stub.sent('POST', `${path}/messages`).length, 1);
  assert.equal(f.stub.sent('POST', `${path}/commit`).length, 1);
});


test('shared startup materialization proves the original captured session through the gateway', async t => {
  const f = await fixture(t, { shared: true }); await f.committer.noteRunFinished(f.entry.project, f.entry.run);
  const row = [...f.rows.values()][0]; assert.ok(row); f.ready();
  assert.equal(await f.deferred.process(row), true);
  assert.equal(row.state, 'replayed');
  assert.equal(nativeMemoryCounters().turnCommits.engine_committed, 1);
});


for (const reason of ['paused', 'trial', 'clinical_context', 'source_deleted', 'internal_project', 'before_reset']) test(`startup refuses to defer when ${reason} also applies`, async t => {
  const f = await fixture(t); f.refuse(reason);
  assert.equal(await f.deferred.defer(f.entry), false);
  assert.equal(f.rows.size, 0);
});
