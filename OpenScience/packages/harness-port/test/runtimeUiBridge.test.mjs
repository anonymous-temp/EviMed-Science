/* global setImmediate */
import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../src/runtimeUiBridge.mjs';

function fixture() {
  /** @type {any[]} */ const sent = [];
  /** @type {any[]} */ const calls = [];
  const listeners = new Map();
  let generation = {}; let current = "session-a";
  /** @type {() => void} */ let generationListener = () => {};
  const parent = { postMessage: (/** @type {any} */ message, /** @type {string} */ origin) => sent.push({ message, origin }) };
  /** @type {{version:number, frameId:string, projectId:string, shellOrigin:string, cwd:unknown}} */
  const frame = { version: 1, frameId: 'frame-a', projectId: 'project-a', shellOrigin: 'https://app.example', cwd: '/workspace/project-a' };
  const target = { __EVIMED_FRAME__: frame, parent, setTimeout, clearTimeout,
    addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => listeners.set(type, fn), removeEventListener: (/** @type {string} */ type) => listeners.delete(type) };
  /** @type {any} */ const ctx = {
    loader: { await: async () => {} },
    connection: { generation: { getSnapshot: () => generation, subscribe: (/** @type {() => void} */ listener) => { generationListener = listener; return () => {}; } } },
    workspaces: {
      create: async () => ({ workspaceId: 'workspace-a', path: '/workspace/project-a', sessionIds: ['session-new', 'session-canonical'] }),
      list: { getSnapshot: () => ({ items: [] }) },
    },
    sessions: {
      refresh: async () => {}, create: async (/** @type {{sessionId:string}} */ { sessionId }) => { calls.push(['create', sessionId]); return sessionId; },
      open: (/** @type {string} */ id) => { current = id; calls.push(['open', id]); }, scope: (/** @type {string} */ id) => ({ id }),
      list: { getSnapshot: () => ({ current }), subscribe: () => () => {} },
    },
    conversation: { input: { for: (/** @type {any} */ scope) => ({ setDraft: (/** @type {string} */ text) => calls.push(['draft', scope.id, text]) }) } },
    effect: (/** @type {any} */ setup) => { ctx.dispose = setup(); },
  };
  const navigate = (overrides = {}, event = {}) => listeners.get('message')({ origin: frame.shellOrigin, source: parent,
    data: { type: 'evimed.runtime-ui.navigate', version: 1, frameId: frame.frameId, projectId: frame.projectId,
      requestId: 'request-a', seq: 1, intent: { kind: 'create', sessionId: 'session-new', draft: 'Review this evidence' }, ...overrides }, ...event });
  return { ctx, target, sent, calls, navigate, replaceGeneration() { generation = {}; generationListener(); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('plugin apply returns synchronously before loader readiness and navigates with native sessions and scoped input', async () => {
  const f = fixture();
  /** @type {any} */ let ready;
  f.ctx.loader.await = () => new Promise(resolve => { ready = resolve; });
  assert.equal(apply(f.ctx, {}, f.target), undefined); assert.equal(f.sent.length, 0);
  ready(); await settle(); assert.equal(f.sent[0].message.type, 'evimed.runtime-ui.ready');
  f.navigate(); await settle();
  assert.deepEqual(f.calls, [['create', 'session-new'], ['open', 'session-new'], ['draft', 'session-new', 'Review this evidence']]);
  assert.ok(f.sent.some(row => row.message.type === 'evimed.runtime-ui.ack' && row.message.ok === true));
  assert.ok(f.sent.every(row => row.origin === 'https://app.example'));
  f.ctx.dispose();
});

test('wrong source, origin, frame, project, sequence and replayed request cannot create or overwrite drafts', async () => {
  const f = fixture(); apply(f.ctx, {}, f.target); await settle();
  f.navigate({}, { origin: 'https://evil.example' }); f.navigate({}, { source: {} });
  f.navigate({ frameId: 'frame-b' }); f.navigate({ projectId: 'project-b' }); f.navigate({ seq: 0 });
  await settle(); assert.equal(f.calls.length, 0);
  f.navigate(); await settle(); f.navigate({ seq: 2 }); await settle();
  assert.equal(f.calls.filter((/** @type {any} */ call) => call[0] === 'create').length, 1);
  assert.equal(f.calls.filter((/** @type {any} */ call) => call[0] === 'draft').length, 1);
  f.navigate({ requestId: 'request-b', seq: 1 }); await settle(); assert.equal(f.calls.length, 3);
  f.ctx.dispose();
});

test('native creation errors produce a correlated negative acknowledgement', async () => {
  const f = fixture(); f.ctx.sessions.create = async () => { throw new Error('private upstream details'); };
  apply(f.ctx, {}, f.target); await settle(); f.navigate(); await settle();
  const ack = f.sent.find(row => row.message.type === 'evimed.runtime-ui.ack').message;
  assert.equal(ack.requestId, 'request-a'); assert.equal(ack.ok, false);
  assert.equal(ack.error, 'NAVIGATION_FAILED'); assert.ok(!JSON.stringify(ack).includes('private'));
  f.ctx.dispose();
});

test('a native session creation may return its actual canonical identity', async () => {
  const f = fixture(); f.ctx.sessions.create = async () => 'session-canonical';
  apply(f.ctx, {}, f.target); await settle(); f.navigate(); await settle();
  assert.ok(f.calls.some(row => row[0] === 'open' && row[1] === 'session-canonical'));
  assert.ok(f.calls.some(row => row[0] === 'draft' && row[1] === 'session-canonical'));
  assert.ok(f.sent.some(row => row.message.type === 'evimed.runtime-ui.ack' && row.message.sessionId === 'session-canonical'));
  f.ctx.dispose();
});

test('a generation replaced during refresh becomes ready and restores the chosen native session', async () => {
  const f = fixture();
  /** @type {any} */ let release;
  let calls = 0;
  f.ctx.sessions.refresh = () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  apply(f.ctx, {}, f.target); await settle();
  f.replaceGeneration(); release(); await settle();
  assert.equal(calls, 2);
  assert.equal(f.sent.filter(row => row.message.type === 'evimed.runtime-ui.ready').length, 1);
  assert.equal(f.sent.filter(row => row.message.type === 'evimed.runtime-ui.session').length, 0);
  f.navigate(); await settle(); f.replaceGeneration(); await settle();
  assert.equal(f.calls.filter(row => row[0] === 'create').length, 1);
  assert.equal(f.calls.filter(row => row[0] === 'open' && row[1] === 'session-new').length, 2);
  assert.equal(f.calls.filter(row => row[0] === 'draft').length, 1);
  f.ctx.dispose();
});

test('navigation to an existing session during delayed reconnect is retained until the generation is ready', async () => {
  const f = fixture(); const known = new Set(['session-a', 'session-b']);
  f.ctx.sessions.open = (/** @type {string} */ id) => { assert.ok(known.has(id)); f.calls.push(['open', id]); };
  apply(f.ctx, {}, f.target); await settle();
  f.navigate({ intent: { kind: 'open', sessionId: 'session-a' } }); await settle();
  /** @type {any} */ let release;
  let refreshes = 0;
  f.ctx.sessions.refresh = () => ++refreshes === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  f.replaceGeneration();
  f.navigate({ requestId: 'request-b', seq: 2, intent: { kind: 'open', sessionId: 'session-b' } });
  assert.ok(!f.calls.some(row => row[0] === 'open' && row[1] === 'session-b'));
  release(); await settle();
  assert.ok(f.calls.some(row => row[0] === 'open' && row[1] === 'session-b'));
  assert.ok(f.sent.some(row => row.message.requestId === 'request-b' && row.message.ok));
  f.ctx.dispose();
});

test('the latest reconnect create intent is idempotent across ready-triggered retransmission', async () => {
  const f = fixture(); const created = new Set();
  f.ctx.sessions.create = async (/** @type {{sessionId:string}} */ { sessionId }) => {
    assert.ok(!created.has(sessionId), 'the bridge executed one native create more than once');
    created.add(sessionId); f.calls.push(['create', sessionId]); return sessionId;
  };
  apply(f.ctx, {}, f.target); await settle();
  /** @type {any} */ let release;
  f.ctx.sessions.refresh = () => new Promise(resolve => { release = resolve; });
  f.replaceGeneration();
  f.navigate({ requestId: 'superseded', seq: 1, intent: { kind: 'open', sessionId: 'session-a' } });
  const intent = { kind: 'create', sessionId: 'session-new', draft: 'Review this evidence' };
  f.navigate({ requestId: 'retained', seq: 2, intent });
  release(); await settle();
  f.navigate({ requestId: 'retained', seq: 3, intent }); await settle();
  assert.deepEqual([...created], ['session-new']);
  assert.equal(f.calls.filter(row => row[0] === 'draft').length, 1);
  assert.equal(f.calls.filter(row => row[0] === 'open' && row[1] === 'session-a').length, 0);
  assert.equal(f.sent.filter(row => row.message.requestId === 'retained' && row.message.ok).length, 2);
  f.ctx.dispose();
});

test('retransmission while native create is already in flight joins that request', async () => {
  const f = fixture();
  /** @type {any} */ let releaseCreate;
  let creates = 0;
  f.ctx.sessions.create = (/** @type {{sessionId:string}} */ { sessionId }) => {
    creates++;
    return new Promise(resolve => { releaseCreate = () => resolve(sessionId); });
  };
  apply(f.ctx, {}, f.target); await settle();
  f.navigate(); await settle();
  f.replaceGeneration(); await settle();
  f.navigate({ seq: 2 }); await settle();
  assert.equal(creates, 1);
  releaseCreate(); await settle();
  f.navigate({ seq: 3 }); await settle();
  assert.equal(creates, 1);
  assert.equal(f.calls.filter(row => row[0] === 'draft').length, 1);
  assert.equal(f.sent.filter(row => row.message.requestId === 'request-a' && row.message.ok).length, 2);
  f.ctx.dispose();
});


test('create uses the server-bound working directory and ignores command-provided paths', async () => {
  const f = fixture();
  /** @type {any[]} */ const requests = [];
  f.ctx.sessions.create = async (/** @type {any} */ request) => { requests.push(request); return 'session-canonical'; };
  apply(f.ctx, {}, f.target); await settle();
  f.navigate({ intent: { kind: 'create', sessionId: 'session-new', cwd: '/untrusted/path', draft: 'Review this evidence' } });
  await settle();
  assert.deepEqual(requests, [{ sessionId: 'session-new', workspaceId: 'workspace-a' }]);
  assert.ok(f.calls.some(row => row[0] === 'open' && row[1] === 'session-canonical'));
  assert.ok(f.calls.some(row => row[0] === 'draft' && row[1] === 'session-canonical'));
  assert.ok(f.sent.some(row => row.message.ok && row.message.sessionId === 'session-canonical'));
  f.ctx.dispose();
});

test('missing or invalid bound directories cannot create an unbound native session or acknowledge success', async () => {
  for (const cwd of [undefined, null, '', 'relative/workspace', '/workspace/../other', '//other/workspace', '/workspace\0bad', '/workspace\nbad', 42]) {
    const f = fixture(); f.target.__EVIMED_FRAME__.cwd = cwd;
    apply(f.ctx, {}, f.target); await settle(); f.navigate(); await settle();
    assert.equal(f.calls.length, 0, 'an invalid bound cwd reached native session mutation');
    assert.ok(f.sent.some(row => row.message.type === 'evimed.runtime-ui.ack' && row.message.requestId === 'request-a' && row.message.ok === false));
    assert.ok(!f.sent.some(row => row.message.ok === true));
    f.ctx.dispose();
  }
});

test('opening an existing native session does not require or overwrite its workspace binding', async () => {
  const f = fixture(); f.target.__EVIMED_FRAME__.cwd = undefined;
  apply(f.ctx, {}, f.target); await settle();
  f.navigate({ intent: { kind: 'open', sessionId: 'session-a' } }); await settle();
  assert.deepEqual(f.calls, [['open', 'session-a']]);
  assert.ok(f.sent.some(row => row.message.ok && row.message.sessionId === 'session-a'));
  f.ctx.dispose();
});

test('new sessions join the native workspace registry before composer readiness is acknowledged', async () => {
  const f = fixture();
  /** @type {any[]} */ const registrations = [];
  /** @type {any[]} */ const requests = [];
  let attached = false;
  f.ctx.workspaces = {
    create: async (/** @type {any} */ input) => { registrations.push(input); return { workspaceId: 'workspace-a', path: '/workspace/project-a', title: 'Project A', sessionIds: attached ? ['session-new'] : [] }; },
    list: { getSnapshot: () => ({ items: [] }) },
  };
  f.ctx.sessions.create = async (/** @type {any} */ request) => { requests.push(request); attached = request.workspaceId === 'workspace-a'; return request.sessionId; };
  apply(f.ctx, {}, f.target); await settle(); f.navigate(); await settle();
  assert.deepEqual(requests, [{ sessionId: 'session-new', workspaceId: 'workspace-a' }]);
  assert.ok(registrations.every(value => value.path === '/workspace/project-a'));
  assert.ok(attached);
  assert.ok(f.sent.some(row => row.message.ok === true));
  f.ctx.dispose();
});


test('missing registry membership cannot produce a successful native readiness ack', async () => {
  const f = fixture();
  f.ctx.workspaces.create = async () => ({ workspaceId: 'workspace-a', sessionIds: [] });
  apply(f.ctx, {}, f.target); await settle(); f.navigate(); await settle();
  assert.ok(f.sent.some(row => row.message.type === 'evimed.runtime-ui.ack' && row.message.ok === false));
  assert.ok(!f.calls.some(row => row[0] === 'open' || row[0] === 'draft'));
  f.ctx.dispose();
});

test('a known legacy session is adopted in place without replacing its identity or history', async () => {
  const f = fixture();
  f.ctx.sessions.list.getSnapshot = () => ({ current: 'session-a', byId: { 'session-a': { blank: false, cwd: '/workspace/project-a' } } });
  f.ctx.workspaces.create = async () => ({ workspaceId: 'workspace-a', sessionIds: ['session-a'] });
  apply(f.ctx, {}, f.target); await settle();
  f.navigate({ intent: { kind: 'open', sessionId: 'session-a' } }); await settle();
  assert.deepEqual(f.calls, [['create', 'session-a'], ['open', 'session-a']]);
  assert.ok(f.sent.some(row => row.message.ok && row.message.sessionId === 'session-a'));
  f.ctx.dispose();
});
