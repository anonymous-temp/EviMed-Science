import assert from 'node:assert/strict';
import test from 'node:test';
import { cancelAutopilotVerification } from '../src/autopilotService.mjs';

test('verification cancellation uses its exact generation and stale callbacks cannot stop the next runtime', async () => {
  const episodeId = `episode-${'a'.repeat(32)}`;
  const verificationId = `${episodeId}-v0`;
  const target = { episodeId, verificationId, dispatchId: verificationId, runId: 'run-one', sessionId: 'session-one', runtimeGeneration: 'old-generation' };
  const calls = [];
  let generation = 'old-generation';
  const runtimeManager = {
    boundedRuntimeCleanupTarget: () => ({ generation, runId: verificationId }),
    endBoundedRuntime: async (_project, id, expected) => { calls.push(['stop', id, expected]); return expected === generation; },
  };
  const agentRuns = { list: async () => [{ id: target.runId, sessionId: target.sessionId, dispatchId: target.dispatchId }],
    cancelRun: async (_project, id) => { calls.push(['cancel', id]); } };
  await cancelAutopilotVerification({ runtimeManager, agentRuns }, {}, target);
  assert.deepEqual(calls[0], ['stop', verificationId, 'old-generation']);
  calls.length = 0;
  generation = 'new-generation';
  await cancelAutopilotVerification({ runtimeManager, agentRuns }, {}, target);
  assert.deepEqual(calls, [['cancel', 'run-one']]);
  await assert.rejects(cancelAutopilotVerification({ runtimeManager, agentRuns }, {}, { ...target, sessionId: 'other-session' }), { code: 'autopilot_cancellation_conflict' });
});
