import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentMemoryRoutes } from '../src/agentMemoryRoutes.mjs';
import { createMemoryAdmission } from '../src/memoryAdmission.mjs';

function fixture() {
  const state = { scopes: ['memory.remember'], calls: [], reason: null, shared: false, allowed: true, bound: null };
  const user = { id: 'owner' }, project = { id: 'default', userId: 'owner', name: 'My project' };
  const config = { agentMemoryApiInternalUsers: ['owner'] };
  const memorySettings = { configured: true, settings: async () => ({ learningPaused: state.reason === 'paused', pausedProjects: [] }),
    sessionState: async () => ({ trialCapsuleId: state.reason === 'trial' ? 'pack' : null }),
    resetInstant: async () => state.reason === 'before_reset' ? '2026-11-17T02:00:00Z' : null };
  const admission = createMemoryAdmission({ config, memorySettings,
    conversations: { running: async () => [{ sessionId: 's', id: 'r' }], runsOf: async () => [{ id: 'r', sessionId: 's', status: 'running', automated: state.reason === 'automated_run' }] },
    clinicalContext: async () => state.reason === 'clinical_context', engineReady: () => ({ ok: state.reason !== 'engine_unavailable', code: null }) });
  const routes = createAgentMemoryRoutes({ config, memorySettings, admission, capsules: {},
    apiKeys: { resolve: async () => ({ userId: 'owner', keyId: 'k', scopes: state.scopes, projectId: state.bound }) },
    store: { userById: async () => state.allowed ? user : { id: 'excluded' }, requireProject: async (_user, id) => {
      if (id === 'foreign') throw Object.assign(new Error('not found'), { status: 404 }); return { ...project, id };
    } }, nativeMemory: { configured: true, externalRememberEnabled: true,
      memoryContexts: { forProject: async () => ({ kind: state.shared ? 'geo-project' : 'owned' }), assertLive: async () => {} },
      remember: async (...args) => { state.calls.push(args); return { pending: { id: 'receipt', state: 'pending' } }; } } });
  const call = async (body) => {
    const res = { data: null, writeHead() {}, end(text) { this.data = JSON.parse(text).data; } };
    await routes({ url: '/api/agent-memory/v1/remember', method: 'POST', headers: { authorization: 'Bearer test' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } }, res); return res.data;
  };
  return { state, call };
}
const input = { statement: '  Use metric units.  ', source: { client: 'Editor', sessionId: 'chat-1', messageId: 'msg-1', saidAt: '2026-11-17T01:00:00Z' } };

test('explicit remember calls the page store with verbatim words and an external source', async () => {
  const f = fixture(); assert.equal((await f.call(input)).pending.state, 'pending');
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.calls[0][0], 'owner');
  assert.equal(f.state.calls[0][1].text, input.statement);
  assert.deepEqual(f.state.calls[0][1].externalSource, input.source);
});

test('existing write scope cannot directly remember; every admission refusal prevents the page write', async () => {
  const f = fixture(); f.state.scopes = ['memory.write'];
  await assert.rejects(f.call(input), error => error.code === 'agent_key_scope_denied'); assert.equal(f.state.calls.length, 0);
  for (const reason of ['paused', 'trial', 'automated_run', 'clinical_context', 'engine_unavailable', 'before_reset']) {
    const f = fixture(); f.state.reason = reason;
    await assert.rejects(f.call(input), error => error.details?.reason === reason);
    assert.equal(f.state.calls.length, 0);
    f.state.reason = null; assert.equal((await f.call(input)).pending.state, 'pending');
  }
});

test('invalid source, project binding, shared namespace and removed audience are refused', async () => {
  for (const body of [{ statement: 'x' }, { ...input, source: { ...input.source, saidAt: 'bad' } }, { ...input, source: { ...input.source, client: '' } },
    { ...input, source: { ...input.source, authority: 'human' } }, { ...input, statement: '' }, { ...input, statement: 1 }, { ...input, attended: true }]) {
    const f = fixture(); await assert.rejects(f.call(body), error => error.code === 'agent_memory_payload_invalid'); assert.equal(f.state.calls.length, 0);
  }
  for (const [mutate, code] of [[s => s.shared = true, 'memory_scope_denied'], [s => s.allowed = false, 'agent_memory_disabled'], [s => s.bound = 'p1', 'agent_key_project_denied']]) {
    const f = fixture(); mutate(f.state);
    await assert.rejects(f.call({ ...input, projectId: 'default' }), error => error.code === code); assert.equal(f.state.calls.length, 0);
  }
  const f = fixture(); await assert.rejects(f.call({ ...input, projectId: 'foreign' }), error => error.status === 404);
});
