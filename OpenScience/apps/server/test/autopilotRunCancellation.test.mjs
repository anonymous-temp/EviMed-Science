import assert from 'node:assert/strict';
import test from 'node:test';
import { cancelScheduledRun } from '../src/autopilotRunCancellation.mjs';

test('a delayed cancellation never stops a later attended run in the persistent session', async () => {
  const stopped = [];
  await cancelScheduledRun({ agentRuns: { list: async () => [
    { id: 'old', sessionId: 'session', status: 'succeeded' },
    { id: 'human', sessionId: 'session', status: 'running' },
  ] }, runtimeManager: { boundedRuntimeScope: () => null }, stopRun: async (_project, run) => stopped.push(run.id) }, {},
  { runId: 'old', sessionId: 'session', episodeId: 'episode' });
  assert.deepEqual(stopped, []);
});

test('a live scheduled cancellation stops exactly its owned run and bounds cleanup to its generation', async () => {
  const stopped = []; const ended = [];
  await cancelScheduledRun({ agentRuns: { list: async () => [{ id: 'old', sessionId: 'session', status: 'running' }] },
    runtimeManager: { boundedRuntimeScope: () => ({ runId: 'episode' }), endBoundedRuntime: async (...args) => { ended.push(args); return true; } },
    stopRun: async (_project, run) => stopped.push(run.id) }, { id: 'project' },
  { runId: 'old', sessionId: 'session', episodeId: 'episode', runtimeGeneration: 'original-generation' });
  assert.deepEqual(stopped, ['old']);
  assert.deepEqual(ended, [[{ id: 'project' }, 'episode', 'original-generation']]);
});

test('a mismatched session cannot redirect cancellation', async () => {
  await assert.rejects(cancelScheduledRun({ agentRuns: { list: async () => [{ id: 'old', sessionId: 'owned', status: 'running' }] },
    runtimeManager: {}, stopRun: async () => { throw new Error('must not call'); } }, {},
  { runId: 'old', sessionId: 'other', episodeId: 'episode' }), { code: 'autopilot_cancellation_conflict' });
});

test('an unconfirmed shared-runtime stop stays retryable instead of declaring cancellation complete', async () => {
  await assert.rejects(cancelScheduledRun({ agentRuns: { list: async () => [{ id: 'old', sessionId: 'session', status: 'running' }] },
    runtimeManager: { boundedRuntimeScope: () => null }, stopRun: async () => { throw Object.assign(new Error('unavailable'), { code: 'runtime_unavailable' }); } }, {},
  { runId: 'old', sessionId: 'session', episodeId: 'episode' }), { code: 'runtime_unavailable' });
});

test('a run the ledger read does not show is retried, not recorded as cancelled, until the last attempt', async () => {
  const stopped = [];
  const dependencies = { agentRuns: { list: async () => [{ id: 'another', sessionId: 'session', status: 'running' }] },
    runtimeManager: { boundedRuntimeScope: () => null }, stopRun: async (_project, run) => stopped.push(run.id) };
  await assert.rejects(cancelScheduledRun(dependencies, {}, { runId: 'not-yet-visible', sessionId: 'session', episodeId: 'episode' }),
    { code: 'autopilot_cancellation_unconfirmed' });
  assert.deepEqual(stopped, [], 'the turn now in the conversation is never stopped in its place');
  // After every retry a run no read showed running is taken as gone, so the job ends instead of retrying for ever.
  await cancelScheduledRun(dependencies, {}, { runId: 'not-yet-visible', sessionId: 'session', episodeId: 'episode', finalAttempt: true });
  // A bounded runtime of its own that is ended is a confirmed stop, seen in the ledger or not.
  await cancelScheduledRun({ ...dependencies, runtimeManager: { boundedRuntimeScope: () => ({ runId: 'episode' }), endBoundedRuntime: async () => true } }, {},
    { runId: 'not-yet-visible', sessionId: 'session', episodeId: 'episode' });
});
