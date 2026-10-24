import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeUiScope } from '../src/runtimeUiScope.mjs';

const child = { kind: 'subagent', parentSessionId: 'root', childSessionId: 'child', mode: 'continuable' };
const scope = () => new NativeUiScope({ rootSessionId: 'root', workspacePath: '/workspace', provider: 'deepseek-official', model: 'certified' });
const call = (/** @type {any} */ request) => ({ args: { request } });
const row = (/** @type {string} */ sessionId, extra = {}) => ({ sessionId, agentAvailable: true, updatedAt: 1, running: false, blank: false, ...extra });
const workspace = (/** @type {string} */ id, /** @type {string} */ path, /** @type {string[]} */ ids) => ({ workspaceId: id, path, title: id, sessionIds: ids, createdAt: '2026-01-01', updatedAt: '2026-01-01' });

test('only externally proven child addresses expand native read authority', () => {
  const s = scope();
  assert.equal(s.permits('session/page', call({ address: child })), false);
  s.setChildren([child]);
  assert.equal(s.permits('session/page', call({ address: child })), true);
  assert.equal(s.permits('session/page', call({ address: { ...child, mode: 'one-shot' } })), false);
  assert.equal(s.permits('session/page', call({ address: { kind: 'session', sessionId: 'child' } })), false);
  assert.equal(s.permits('session/prompt', call({ sessionId: 'child' })), false);
  assert.equal(s.permits('session/prompt', call({ sessionId: 'root' })), true);
  assert.equal(s.permits('session/selectModel', call({ sessionId: 'root' })), false);
  s.setChildren([]);
  assert.equal(s.permits('session/page', call({ address: child })), false);
});

test('list and control cannot grant authority from native parent labels or leak unrelated projections', () => {
  const s = scope(); s.setChildren([child]);
  const list = s.project('session/list', { args: { _request: {} } }, { items: [row('root'), row('child'), row('foreign', { parentSessionId: 'root', secret: 'private' })] });
  assert.deepEqual(list.value.items.map((/** @type {any} */ r) => r.sessionId), ['root', 'child']);
  const p = { asOfSeq: 2, values: { title: 'allowed' } };
  assert.deepEqual(s.project('session/control', { args: {} }, { type: 'baseline', value: { projections: { root: p, foreign: { values: { title: 'private' } } } } }),
    { forward: true, value: { type: 'baseline', value: { projections: { root: p } } } });
  assert.equal(s.project('session/control', { args: {} }, { type: 'projection', sessionId: 'foreign', key: 'inbox', value: 'private', seq: 3 }).forward, false);
});

test('all workspace frame variants retain exact bound workspace and clear narrowed lists', () => {
  const s = scope(); const own = workspace('w', '/workspace', ['root', 'foreign']);
  const base = s.project('workspace/follow', { args: {} }, { type: 'baseline', value: { items: [own, workspace('x', '/private', ['foreign'])], archivedSessionIds: ['foreign'], pinnedSessionIds: ['root', 'foreign'] } });
  assert.deepEqual(base.value.value, { items: [{ ...own, sessionIds: ['root'] }], archivedSessionIds: [], pinnedSessionIds: ['root'] });
  assert.deepEqual(s.project('workspace/follow', { args: {} }, { type: 'pinned', pinnedSessionIds: ['foreign'] }).value, { type: 'pinned', pinnedSessionIds: [] });
  assert.deepEqual(s.project('workspace/follow', { args: {} }, { type: 'order', workspaceIds: ['x', 'w'] }).value, { type: 'order', workspaceIds: ['w'] });
  assert.equal(s.project('workspace/follow', { args: {} }, { type: 'remove', workspaceId: 'x' }).forward, false);
  assert.deepEqual(s.project('workspace/create', call({ path: '/workspace' }), { workspace: own, created: false }).value.workspace.sessionIds, ['root']);
  assert.equal(s.permits('workspace/create', call({ path: '/private' })), false);
});

test('authorized transcript keeps native event sequence and assistant frames intact', () => {
  const s = scope(); const request = call({ address: { kind: 'session', sessionId: 'root' }, assistantStream: true });
  const snapshot = { type: 'snapshot', cursor: 9, records: [{ type: 'event', event: { seq: 8, data: 'kept' } }], assistantStream: { revision: 7 } };
  assert.equal(s.project('session/follow', request, snapshot).value, snapshot);
  assert.equal(s.project('session/follow', call({ address: { kind: 'session', sessionId: 'foreign' } }), snapshot).forward, false);
});

test('upload and file reference target fields are not confused with session request fields', () => {
  const s = scope();
  assert.equal(s.permits('fileUploads/upload', { args: { agentId: 'root', request: { data: 'eA==' } } }), true);
  assert.equal(s.permits('fileUploads/upload', call({ sessionId: 'root', data: 'eA==' })), false);
  assert.equal(s.permits('fileReferences/list', { args: { agentId: 'root', query: 'file' } }), true);
  assert.equal(s.permits('fileReferences/list', { args: { agentId: 'foreign', request: { sessionId: 'root' } } }), false);
});

test('event interactions require delivery in the current native client generation', () => {
  const s = scope();
  const ready = s.project('$events', { args: {} }, { type: 'ready', clientId: 'client', host: { home: '/private/home' } });
  assert.deepEqual(ready.value, { type: 'ready', clientId: 'client', host: { home: '/workspace' } });
  const event = { type: 'waterfall', event: 'user-questions/request', eventId: 'question', agentId: 'root', request: { wait: { callId: 'call' }, questions: [] } };
  const result = { args: { clientId: 'client', eventId: 'question', outcome: { kind: 'result', value: 'answer' } } };
  assert.equal(s.permits('$events/result', result), false);
  assert.equal(s.project('$events', { args: {} }, { ...event, agentId: 'foreign' }).forward, false);
  assert.equal(s.project('$events', { args: {} }, event).forward, true);
  assert.equal(s.permits('$events/result', result), true);
  assert.equal(s.permits('$events/result', { args: { ...result.args, clientId: 'forged' } }), false);
  s.project('$events', { args: {} }, { type: 'ready', clientId: 'next-client', host: { home: '/private' } });
  assert.equal(s.permits('$events/result', result), false);
  assert.equal(s.project('$events', { args: {} }, { type: 'cancel', eventId: 'question' }).forward, false);
});

test('known cancellation clears interaction authority and global emits are never forwarded', () => {
  const s = scope(); s.project('$events', { args: {} }, { type: 'ready', clientId: 'c', host: { home: '/' } });
  s.project('$events', { args: {} }, { type: 'waterfall', event: 'user-questions/request', eventId: 'q', agentId: 'root', request: { wait: { callId: 'call' } } });
  assert.equal(s.project('$events', { args: {} }, { type: 'cancel', eventId: 'q' }).forward, true);
  assert.equal(s.permits('userQuestions/answer', { args: { agentId: 'root', callId: 'call', answer: {} } }), false);
  assert.equal(s.project('$events', { args: {} }, { type: 'emit', event: 'credentials/changed', args: ['secret'] }).forward, false);
  assert.equal(s.project('$events', { args: {} }, { type: 'emit', event: 'api-session/status', args: ['root', true] }).forward, true);
});

test('the answering peer clears a settled question without expecting the kernel to echo cancel', () => {
  const s = scope(); s.project('$events', { args: {} }, { type: 'ready', clientId: 'c', host: { home: '/' } });
  for (let index = 0; index < 300; index++) {
    const eventId = `q-${index}`;
    s.project('$events', { args: {} }, { type: 'waterfall', event: 'user-questions/request', eventId, agentId: 'root', request: { questions: [] } });
    const payload = { args: { clientId: 'c', eventId, outcome: { kind: 'result', value: { answers: [] } } } };
    assert.equal(s.permits('$events/result', payload), true);
    s.complete('$events/result', payload);
    assert.equal(s.permits('$events/result', payload), false);
  }
  assert.equal(s.interactions.size, 0);
});

test('job list excludes unowned jobs and strips spill paths; actions require its proven roster', () => {
  const s = scope(); const request = call({ sessionId: 'root' });
  const job = { id: 'j', owner: 'root', status: 'running', output: { total: 3, earliest: 0, spillPaths: ['/private'] } };
  const value = s.project('job/list', request, { type: 'rows', jobs: [job, { ...job, id: 'unowned', owner: undefined }, { ...job, id: 'other', owner: 'foreign' }] }).value;
  assert.deepEqual(value.jobs, [{ ...job, output: { total: 3, earliest: 0 } }]);
  assert.equal(s.permits('job/kill', call({ sessionId: 'root', jobId: 'j' })), true);
  assert.equal(s.permits('job/kill', call({ sessionId: 'root', jobId: 'unowned' })), false);
  s.project('job/list', request, { type: 'rows', jobs: [] });
  assert.equal(s.permits('job/kill', call({ sessionId: 'root', jobId: 'j' })), false);
});

test('remote capability hints and model catalogue match scoped actions without owner state', () => {
  const s = scope(); const baseline = s.project('remoteAccess/follow', { args: {} }, { type: 'baseline', owner: true }).value;
  assert.equal(baseline.owner, false);
  assert.equal(JSON.stringify(baseline).includes('session/selectModel'), false);
  const catalog = { default: { provider: 'deepseek-official', model: 'certified' }, groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'certified', name: 'Model', description: 'private config' }, { id: 'private', name: 'private' }] }], routableProviders: ['deepseek-official', 'private'], failures: [{ message: 'secret' }] };
  assert.deepEqual(s.project('session/modelCatalog', { args: {} }, catalog).value, { default: catalog.default, groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'certified', name: 'Model' }] }], routableProviders: ['deepseek-official'], failures: [] });
  assert.throws(() => s.project('session/modelCatalog', { args: {} }, { ...catalog, default: { provider: 'other', model: 'private' } }));
  assert.equal(s.permits('unknown/read', { args: {} }), false);
});
