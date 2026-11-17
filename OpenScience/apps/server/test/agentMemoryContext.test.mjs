import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentMemoryRoutes } from '../src/agentMemoryRoutes.mjs';
import { createMemoryAdmission } from '../src/memoryAdmission.mjs';
import { ResidentProfiles } from '../src/residentProfile.mjs';

export function contextFixture() {
  const state = { scopes: ['memory.read'], bound: null, paused: false, trial: false, shared: false, allowed: true, reads: 0, version: 0 };
  const user = { id: 'u' }, config = { agentMemoryApiInternalUsers: ['u'], memoryEngineEnabled: true };
  const settings = { configured: true, settings: async () => ({ recallPaused: state.paused, pausedProjects: [] }),
    sessionState: async () => ({ trialCapsuleId: state.trial ? 'pack' : null }) };
  const admission = createMemoryAdmission({ config, memorySettings: settings,
    conversations: { running: async () => [{ sessionId: 'one' }], runsOf: async () => [] } });
  const native = { configured: true, memoryContexts: { forProject: async () => ({ kind: state.shared ? 'geo-project' : 'owned' }), assertLive: async () => {} } };
  const resident = new ResidentProfiles({ config, store: settings, capsules: { profileFacts: async () => [{ id: 'f', factKind: 'preference', content: 'Use metric units.' }] },
    projectCard: async () => [{ slot: 'goal', text: 'Compare sensors.' }] });
  const opening = async () => { state.reads++; return [{ name: 'profile', value: 'Profile text', elided: true }, { name: 'preferences', value: [{ name: 'units.md' }] }, { name: 'entities', value: [] }]; };
  const store = { userById: async () => state.allowed ? user : { id: 'excluded' }, requireProject: async (_user, id) => {
    if (id === 'foreign') throw Object.assign(new Error('Unknown project'), { status: 404 });
    return { id, userId: 'u' };
  } };
  const routes = createAgentMemoryRoutes({ config, store, apiKeys: { resolve: async () => ({ userId: 'u', keyId: 'key', scopes: state.scopes, projectId: state.bound }) },
    memorySettings: settings, nativeMemory: native, admission, capsules: {}, openingContext: { resident, opening, sourceDeletion: { version: async () => state.version } } });
  const call = async (path = '/context') => {
    const res = { data: null, writeHead() {}, end(text) { this.data = JSON.parse(text).data; } };
    await routes({ url: `/api/agent-memory/v1${path}`, method: 'GET', headers: { authorization: 'Bearer fixture' } }, res);
    return res.data;
  };
  return { state, config, call, resident };
}

test('opening composes the existing resident text and native handler results with explicit omissions', async () => {
  const f = contextFixture();
  const result = await f.call('/context?projectId=p1');
  const kernel = await f.resident.forDispatch('u', { projectId: 'p1', sessionId: null, attended: true });
  assert.equal(result.platformText, kernel.text);
  assert.equal(result.layers.find(layer => layer.name === 'profile').text, 'Profile text');
  assert.equal(result.layers.find(layer => layer.name === 'profile').omissionReason, 'elided');
  assert.equal(result.layers.find(layer => layer.name === 'listings').text, JSON.stringify({ preferences: [{ name: 'units.md' }], entities: [] }));
  assert.ok(result.layers.find(layer => layer.name === 'projectCard').text);
  assert.equal(result.layers.find(layer => layer.name === 'standingPreferences').reason, 'switch_off');
  assert.equal((await f.call('')).capabilities.openingContext.available, true);
});

test('paused and trial openings return omissions and never read producers; learning pause alone permits recall', async () => {
  for (const reason of ['paused', 'trial']) {
    const f = contextFixture(); f.state[reason] = true;
    const result = await f.call();
    assert.ok(result.layers.every(layer => !layer.present && layer.reason === reason));
    assert.equal(f.state.reads, 0); assert.equal(result.platformText, '');
    f.state[reason] = false;
    assert.equal((await f.call()).layers[0].text, 'Profile text');
  }
});

test('scope, project, shared namespace and audience never expose opening content', async () => {
  for (const [mutate, code] of [[s => s.scopes = [], 'agent_key_scope_denied'], [s => s.bound = 'p1', 'agent_key_project_denied'],
    [s => s.shared = true, 'memory_scope_denied'], [s => s.allowed = false, 'agent_memory_disabled']]) {
    const f = contextFixture(); mutate(f.state);
    await assert.rejects(f.call('/context?projectId=default'), error => error.code === code);
    assert.equal(f.state.reads, 0);
  }
  const f = contextFixture();
  await assert.rejects(f.call('/context?projectId=foreign'), error => error.status === 404);
  assert.equal(f.state.reads, 0);
  f.state.bound = 'p1'; assert.equal((await f.call()).projectId, 'p1');
});
