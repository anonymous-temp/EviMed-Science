import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngineExecutionContextResolver } from '../src/engineExecutionContext.mjs';

const ctx = (sessionId, reasoningEffort) => ({ v: 1, sessionId, callId: `call-${sessionId}`, rootCallId: `call-${sessionId}`, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort });

test('engine policy resolves the exact owned session and used header, not a later pending choice or another active run', async () => {
  const project = { id: 'p', userId: 'u' };
  const runs = [{ id: 'r-low', sessionId: 's-low' }, { id: 'r-max', sessionId: 's-max' }];
  const resolve = createEngineExecutionContextResolver({
    config: { deepseekModel: 'deepseek-flash', deepseekReasoningEffort: 'high' },
    store: { userById: async () => ({ id: 'u' }), requireProject: async () => project },
    agentRuns: { activeRuns: async () => runs, runIdForSession: (id, list) => list.find(r => r.sessionId === id)?.id ?? null },
    runtimeManager: { sessionModelSelection: async (_project, id) => ({ lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: id === 's-low' ? 'low' : 'max' }, next: { reasoningEffort: 'off' } }) },
  });
  const policies = await Promise.all(['low', 'max'].map(level => resolve({ userId: 'u', projectId: 'p' }, ctx(`s-${level}`, level))));
  assert.deepEqual(policies.map(p => [p.runId, p.reasoningEffort]), [['r-low','low'], ['r-max','max']]);
  await assert.rejects(resolve({ userId: 'u', projectId: 'p' }, ctx('foreign-session', 'low')), { code: 'engine_model_session_unowned' });
  await assert.rejects(resolve({ userId: 'u', projectId: 'p' }, ctx('s-low', 'max')), { code: 'engine_model_policy_mismatch' });
});
