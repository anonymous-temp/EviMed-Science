import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentMemoryRoutes } from '../src/agentMemoryRoutes.mjs';
import { createMemoryAdmission } from '../src/memoryAdmission.mjs';
const id = `nm_${'a'.repeat(24)}`;
function fixture() {
  const state = { scopes: ['memory.read', 'memory.manage'], bound: null, shared: false, trial: false, paused: false, allowed: true,
    record: { id, uri: 'viking://user/u/memories/preferences/units.md', value: 'Use metric units.', kind: 'preference', scope: 'user', scopeId: '', version: 9 },
    forgotten: [], calls: [], outcome: { removed: false, historyRejected: true } };
  const config = { agentMemoryApiEnabled: false, agentMemoryApiInternalUsers: ['u'], memoryForgetTargetsEnabled: true };
  const user = { id: 'u' };
  const settings = { configured: true, settings: async () => ({ recallPaused: state.paused, learningPaused: state.paused, pausedProjects: [] }),
    sessionState: async () => ({ trialCapsuleId: state.trial ? 'pack' : null }) };
  const admission = createMemoryAdmission({ config, memorySettings: settings,
    conversations: { running: async () => [{ sessionId: 'session' }], runsOf: async () => [] } });
  const contexts = { forProject: async project => ({ kind: state.shared ? 'geo-project' : 'owned', ownerId: 'u', projectId: project.id }),
    forUri: async (_user, uri) => ({ kind: uri.includes('/shared/') ? 'geo-project' : 'owned' }), assertLive: async () => {} };
  const native = { configured: true, forgetTargetsEnabled: true, memoryContexts: contexts,
    getRecord: async () => { if (!state.record) throw Object.assign(new Error('missing'), { code: 'memory_not_found' }); return state.record; },
    forgotten: async () => state.forgotten,
    forget: async (...args) => { state.calls.push(args); return state.outcome; },
    update: async (...args) => { state.calls.push(args); return { ...state.forgotten[0], status: 'active' }; },
  };
  const routes = createAgentMemoryRoutes({ config,
    apiKeys: { resolve: async () => ({ userId: 'u', keyId: 'key', scopes: state.scopes, projectId: state.bound }) },
    store: { userById: async () => state.allowed ? user : { id: 'excluded' }, requireProject: async (_user, projectId) => {
      if (projectId === 'foreign') throw Object.assign(new Error('not found'), { status: 404 });
      return { id: projectId, userId: 'u' };
    } }, memorySettings: settings, capsules: {}, nativeMemory: native, admission });
  const call = async (path, body) => {
    const req = { url: `/api/agent-memory/v1${path}`, method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer fixture' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
    const res = { data: null, writeHead() {}, end(text) { this.data = JSON.parse(text).data; } };
    await routes(req, res); return res.data;
  };
  return { state, config, call, native };
}

test('statement forgetting reports only the native confirmation, including a pending history scan', async () => {
  const { state, call } = fixture();
  assert.deepEqual(await call('/forget', { statement: 'Use metric units.' }), { removed: false, historyRejected: true });
  assert.equal(state.calls[0][2], null);
  assert.deepEqual(state.calls[0][3], { statement: 'Use metric units.', context: { kind: 'owned', ownerId: 'u', projectId: 'default' } });
  state.outcome = { removed: false, historyRejected: true, historyScanPending: true };
  assert.deepEqual(await call('/forget', { statement: 'Use metric units.' }), state.outcome);
  state.outcome = { removed: false };
  assert.deepEqual(await call('/forget', { recordId: id }), { removed: false });
});
test('record forgetting resolves the owned record and preserves exact line selection', async () => {
  const { state, call } = fixture();
  await call('/forget', { recordId: id, lines: ['Use metric units.'] });
  assert.equal(state.calls[0][2], state.record.uri);
  assert.deepEqual(state.calls[0][3], { lines: ['Use metric units.'], context: { kind: 'owned', ownerId: 'u', projectId: 'default' } });
  state.record.document = { uri: state.record.uri };
  await call('/forget', { recordId: id });
  assert.deepEqual(state.calls[1][3], { lines: [state.record.value], context: { kind: 'owned', ownerId: 'u', projectId: 'default' } });
});
test('scope, ownership, shared namespace, private record, trial and disabled audience refuse before forgetting', async () => {
  for (const [mutate, code] of [[f => f.state.scopes = ['memory.read'], 'agent_key_scope_denied'],
    [f => f.state.bound = 'default', 'agent_key_project_denied'], [f => f.state.shared = true, 'memory_scope_denied'],
    [f => f.state.record.sensitive = true, 'memory_not_found'], [f => f.state.trial = true, 'memory_scope_denied'],
    [f => f.state.allowed = false, 'agent_memory_disabled'], [f => f.config.memoryForgetTargetsEnabled = false, 'memory_engine_unavailable']]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.call('/forget', { recordId: id, lines: ['Use metric units.'] }), error => error.code === code);
    assert.equal(f.state.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.call('/forget', { statement: 'Use metric units.', projectId: 'foreign' }), error => error.status === 404);
  assert.equal(f.state.calls.length, 0);
  f.state.paused = true;
  assert.equal((await f.call('/forget', { statement: 'Use metric units.' })).historyRejected, true, 'pausing must not prevent withdrawal');
});
test('invalid targets and raw URIs cannot silently become whole-file deletions', async () => {
  const f = fixture();
  for (const body of [{}, { statement: 'x', recordId: id }, { uri: f.state.record.uri }, { recordId: id, lines: [] },
    { recordId: id, lines: ['two\nlines'] }, { recordId: id, lines: [null] }, { statement: '' }, { statement: 'x', lines: ['x'] }]) {
    await assert.rejects(f.call('/forget', body), error => error.code === 'agent_memory_payload_invalid');
  }
  assert.equal(f.state.calls.length, 0);
});
test('forgotten list contains original text and the page restore action, excludes private and shared entries', async () => {
  const f = fixture();
  f.state.forgotten = [f.state.record, { ...f.state.record, id: 'private', sensitive: true },
    { ...f.state.record, id: 'shared', uri: 'viking://user/shared/memories/notes/x.md' }];
  const result = await f.call('/forgotten');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].text, 'Use metric units.');
  assert.deepEqual(result.items[0].restore, { path: `/api/agent-memory/v1/records/${id}/restore`, expectedVersion: 9 });
  assert.doesNotMatch(JSON.stringify(result), /viking:|private|shared/);
  f.state.record = null;
  assert.equal((await f.call(`/records/${id}/restore`, { expectedVersion: 9 })).status, 'active');
  assert.deepEqual(f.state.calls[0], ['u', id, { status: 'active', expectedVersion: 9 }]);
  f.state.scopes = ['memory.read'];
  assert.equal((await f.call('/forgotten')).items[0].restore, undefined);
  await assert.rejects(f.call(`/records/${id}/restore`, { expectedVersion: 9 }), error => error.code === 'agent_key_scope_denied');
});
test('capabilities disclose incomplete opening and writing, and exact forgetting availability', async () => {
  const f = fixture();
  const caps = (await f.call('')).capabilities;
  assert.equal(caps.openingContext.available, false);
  assert.equal(caps.explicitRemember.available, false); assert.ok(caps.explicitRemember.reason);
  assert.equal(caps.statementForget.available, true); assert.equal(caps.forgottenList.path, '/forgotten');
  f.state.bound = 'default';
  assert.equal((await f.call('')).capabilities.statementForget.available, false);
});

test('a profile-line selector cannot expose or remove neighbouring lines', async () => {
  const f = fixture();
  f.state.record.document = { uri: f.state.record.uri };
  await assert.rejects(f.call('/forget', { recordId: id, lines: ['Some other private line.'] }), error => error.code === 'agent_memory_payload_invalid');
  assert.equal(f.state.calls.length, 0);
  f.state.outcome = { removed: false, missingLines: ['Use metric units.'], availableLines: ['Private neighbour.'] };
  const answer = await f.call('/forget', { recordId: id });
  assert.doesNotMatch(JSON.stringify(answer), /Private neighbour/);
  assert.deepEqual(answer.missingLines, ['Use metric units.']);
});


test('closed opening and remember endpoints cannot act even with all scopes', async () => {
  const f = fixture(); f.state.scopes.push('memory.write');
  await assert.rejects(f.call('/context'), error => error.code === 'memory_engine_unavailable');
  await assert.rejects(f.call('/remember', { statement: 'Use metric units.', source: { client: 'Fixture', sessionId: 'one', saidAt: '2026-11-17T00:00:00Z' } }), error => error.code === 'not_found');
  assert.equal(f.state.calls.length, 0);
  assert.equal((await f.call('/forget', { statement: 'Use metric units.' })).historyRejected, true);
});

test('restore refuses project-bound, shared and private targets before writing', async () => {
  for (const mutate of [f => f.state.bound = 'default', f => f.state.record.sensitive = true,
    f => f.state.record.uri = 'viking://user/shared/memories/notes/x.md']) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.call(`/records/${id}/restore`, { expectedVersion: 9 }), error => ['agent_key_project_denied', 'memory_not_found'].includes(error.code));
    assert.equal(f.state.calls.length, 0);
  }
});
