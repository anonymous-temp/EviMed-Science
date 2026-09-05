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
  const frame = { version: 1, frameId: 'frame-a', projectId: 'project-a', shellOrigin: 'https://app.example' };
  const target = { __EVIMED_FRAME__: frame, parent, setTimeout, clearTimeout,
    addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => listeners.set(type, fn), removeEventListener: (/** @type {string} */ type) => listeners.delete(type) };
  /** @type {any} */ const ctx = {
    loader: { await: async () => {} },
    connection: { generation: { getSnapshot: () => generation, subscribe: (/** @type {() => void} */ listener) => { generationListener = listener; return () => {}; } } },
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
