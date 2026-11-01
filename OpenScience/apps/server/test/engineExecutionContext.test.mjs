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

test('model selection accessor uses the native projection envelope without waking a runtime', async () => {
  const { RuntimeManager } = await import('../src/runtimeManager.mjs');
  const project = { id: 'p', userId: 'u' };
  const manager = new RuntimeManager({});
  assert.equal(await manager.sessionModelSelection(project, 's-low'), null);
  manager.runtimes.set('u:p', { modelGatewayTokenJti: 'test-generation' });
  const expected = { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
    next: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } };
  manager.callKernel = async (_runtime, actualProject, method, args) => {
    assert.equal(actualProject, project);
    assert.equal(method, 'session/projections');
    assert.deepEqual(args, { request: { sessionId: 's-low' } });
    return { asOfSeq: 15, values: { modelSelection: expected } };
  };
  assert.deepEqual(await manager.sessionModelSelection(project, 's-low'), expected);
});

test('a fresh native child is bound by its real catalogue id before event tracking catches up', async () => {
  const project = { id: 'p', userId: 'u' };
  const resolve = createEngineExecutionContextResolver({
    config: { deepseekModel: 'deepseek-flash' },
    store: { userById: async () => ({ id: 'u' }), requireProject: async () => project },
    agentRuns: { activeRuns: async () => [{ id: 'run-root', sessionId: 'root-1' }], runIdForSession: () => null },
    runtimeManager: {
      subagentCatalogue: async (actualProject, rootId) => {
        assert.equal(actualProject, project);
        assert.equal(rootId, 'root-1');
        return [{ id: 'child-1', createdAt: 1790564989642, mode: 'one-shot', label: 'Research' }];
      },
      sessionModelSelection: async (_project, id) => {
        assert.equal(id, 'child-1');
        return { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' } };
      },
    },
  });
  assert.deepEqual(await resolve({ userId: 'u', projectId: 'p' }, ctx('child-1', 'off')),
    { runId: 'run-root', sessionId: 'child-1', reasoningEffort: 'off' });
});

test('a just-submitted native turn waits for its exact run to be adopted without accepting another session', async () => {
  const project = { id: 'p', userId: 'u' };
  let reads = 0;
  let selections = 0;
  const resolve = createEngineExecutionContextResolver({
    config: { deepseekModel: 'deepseek-flash' },
    store: { userById: async () => ({ id: 'u' }), requireProject: async () => project },
    agentRuns: {
      activeRuns: async () => (++reads < 4 ? [{ id: 'other-run', sessionId: 'other' }] : [{ id: 'own-run', sessionId: 'mine', nativeTurn: { startSeq: 10 } }]),
      runIdForSession: (id, list) => list.find((run) => run.sessionId === id)?.id ?? null,
    },
    runtimeManager: { sessionTranscript: async () => ({ sessionId: 'mine', turns: [{ startSeq: 10, end: null }],
      messages: [{ turnStartSeq: 10, parts: [{ type: 'tool', callId: 'call-mine' }] }] }),
      sessionModelSelection: async (_project, id) => {
      selections++;
      assert.equal(id, 'mine');
      return { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } };
    } },
    adoptionPollAttempts: 4, adoptionPollDelayMs: 1, wait: async () => {},
  });
  assert.deepEqual(await resolve({ userId: 'u', projectId: 'p' }, ctx('mine', 'high')),
    { runId: 'own-run', sessionId: 'mine', reasoningEffort: 'high' });
  assert.equal(selections, 1, 'model policy is read only after the exact session is owned');
});

test('waiting never turns an unowned session into the only active run', async () => {
  const project = { id: 'p', userId: 'u' };
  let reads = 0;
  const resolve = createEngineExecutionContextResolver({
    config: { deepseekModel: 'deepseek-flash' },
    store: { userById: async () => ({ id: 'u' }), requireProject: async () => project },
    agentRuns: { activeRuns: async () => { reads++; return [{ id: 'other-run', sessionId: 'other' }]; }, runIdForSession: () => null },
    runtimeManager: { sessionModelSelection: async () => { throw new Error('must not read'); } },
    adoptionPollAttempts: 2, adoptionPollDelayMs: 1, wait: async () => {},
  });
  await assert.rejects(resolve({ userId: 'u', projectId: 'p' }, ctx('foreign', 'high')), { code: 'engine_model_session_unowned' });
  assert.equal(reads, 3, 'one initial check and two bounded retries');
});


test('an older tool call cannot attach to a newer turn of the same session while waiting', async () => {
  const project = { id: 'p', userId: 'u' };
  let reads = 0;
  const resolve = createEngineExecutionContextResolver({
    config: { deepseekModel: 'deepseek-flash' },
    store: { userById: async () => ({ id: 'u' }), requireProject: async () => project },
    agentRuns: { activeRuns: async () => (++reads === 1 ? [] : [{ id: 'new-run', sessionId: 'mine', nativeTurn: { startSeq: 20 } }]),
      runIdForSession: (id, runs) => runs.find((run) => run.sessionId === id)?.id ?? null },
    runtimeManager: { sessionTranscript: async () => ({ sessionId: 'mine', turns: [{ startSeq: 10, end: null }],
      messages: [{ turnStartSeq: 10, parts: [{ type: 'tool', callId: 'call-mine' }] }] }),
      sessionModelSelection: async () => { throw new Error('must not read'); } },
    adoptionPollAttempts: 2, adoptionPollDelayMs: 1, wait: async () => {},
  });
  await assert.rejects(resolve({ userId: 'u', projectId: 'p' }, ctx('mine', 'high')), { code: 'engine_model_session_unowned' });
});
