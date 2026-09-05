/* global EventTarget, Event, MessageEvent, Response, AbortController, setImmediate */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installRuntimeUiTransport } from '../src/runtimeUiTransport.mjs';

const frame = { version: 1, frameId: 'frame-a', projectId: 'project-a', shellOrigin: 'https://app.example', prefix: '/__evimed/f/frame-a/' };
function browser() {
  /** @type {any[]} */ const sockets = [];
  /** @type {any[]} */ const calls = [];
  class Socket extends EventTarget {
    readyState = 0;
    bufferedAmount = 0;
    /** @type {any[]} */ sent = [];
    constructor(/** @type {string} */ url) { super(); this.url = url; sockets.push(this); }
    send(/** @type {string} */ value) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    message(/** @type {any} */ value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  /** @type {any} */ const target = {
    location: { origin: 'https://app.example:8443' }, WebSocket: Socket,
    crypto: { randomUUID: () => `id-${Math.random()}` },
    fetch: async (/** @type {any[]} */ ...args) => { calls.push(args); return new Response('{}'); },
    setTimeout, clearTimeout, addEventListener() {},
    document: { createElement: () => ({}), head: { appendChild(/** @type {any} */ script) { calls.push(script); script.onload(); } } },
  };
  return { target, sockets, calls };
}

test('official hooks rebase only the owned frame without replacing browser fetch or claiming Host ownership', async () => {
  const { target, calls } = browser(); const original = target.fetch;
  const hooks = installRuntimeUiTransport(frame, target);
  assert.equal(target.fetch, original);
  assert.equal(target.__DSH_TRANSPORT__, hooks);
  assert.notEqual(Object.hasOwn(hooks, 'ownsHost') && Reflect.get(hooks, 'ownsHost'), true);
  await hooks.fetch(new URL('https://app.example:8443/api/remote/session/list'), { method: 'POST' });
  assert.equal(calls[0][0], 'https://app.example:8443/__evimed/f/frame-a/api/remote/session/list');
  await hooks.loadBundle('/plugins/??one/client.js,two/client.js&rev=a');
  assert.equal(calls[1].src, 'https://app.example:8443/__evimed/f/frame-a/plugins/??one/client.js,two/client.js&rev=a');
  await assert.rejects(hooks.fetch(new URL('https://evil.example/api/test'), {}));
  await assert.rejects(hooks.loadBundle('/__evimed/f/frame-b/plugins/one.js'));
});

test('the synchronous bootstrap is self-contained after function serialization', () => {
  const { target } = browser();
  const install = vm.runInNewContext(`(${installRuntimeUiTransport.toString()})`, { URL, Error, Map, Set, Promise, Object, JSON });
  assert.equal(typeof install(frame, target).openStream, 'function');
});

test('logical streams share one carrier, cancel independently and retain upstream failure markers', async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const firstAbort = new AbortController(); const secondAbort = new AbortController();
  const first = hooks.openStream('workspace/follow', { args: {} }, firstAbort.signal)[Symbol.asyncIterator]();
  const second = hooks.openStream('session/follow', { args: { id: 'session-b' } }, secondAbort.signal)[Symbol.asyncIterator]();
  const pendingA = first.next(); const pendingB = second.next();
  assert.equal(sockets.length, 1); const socket = sockets[0]; socket.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.url, 'wss://app.example:8443/__evimed/f/frame-a/api/remote.mux');
  const [openA, openB] = socket.sent;
  socket.message({ type: 'item', streamId: openA.streamId, value: { type: 'ready' } });
  assert.deepEqual(await pendingA, { done: false, value: { type: 'ready' } });
  firstAbort.abort(); await first.return();
  assert.ok(socket.sent.some((/** @type {any} */ item) => item.type === 'cancel' && item.streamId === openA.streamId));
  socket.message({ type: 'error', streamId: openB.streamId, error: { code: 'gateway/forbidden', message: 'Denied', details: {} } });
  await assert.rejects(pendingB, (/** @type {any} */ error) => error.dshRemoteStreamFailure?.kind === 'remote' && error.dshRemoteStreamFailure.code === 'gateway/forbidden');
  hooks.dispose();
});

test('carrier closure fails every active stream and the next generation can open one fresh carrier', async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const stream = hooks.openStream('$events', {}, new AbortController().signal)[Symbol.asyncIterator]();
  const next = stream.next(); sockets[0].open(); await new Promise(resolve => setImmediate(resolve));
  sockets[0].close();
  await assert.rejects(next, (/** @type {any} */ error) => error.dshRemoteStreamFailure?.kind === 'carrier');
  const fresh = hooks.openStream('$events', {}, new AbortController().signal)[Symbol.asyncIterator]();
  const freshNext = fresh.next(); assert.equal(sockets.length, 2); sockets[1].open();
  await new Promise(resolve => setImmediate(resolve)); sockets[1].close();
  await assert.rejects(freshNext); hooks.dispose();
});

test('a slow reader cannot buffer unbounded stream items', async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const stream = hooks.openStream('$events', {}, new AbortController().signal)[Symbol.asyncIterator]();
  const next = stream.next(); sockets[0].open(); await new Promise(resolve => setImmediate(resolve));
  const id = sockets[0].sent[0].streamId;
  sockets[0].message({ type: 'item', streamId: id, value: 0 }); await next;
  for (let index = 0; index < 300; index++) sockets[0].message({ type: 'item', streamId: id, value: index });
  await assert.rejects(stream.next(), (/** @type {any} */ error) => error.dshRemoteStreamFailure?.kind === 'carrier'); hooks.dispose();
});

test('ending the event generation closes its carrier and fails sibling streams', async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const events = hooks.openStream('$events', {}, new AbortController().signal)[Symbol.asyncIterator]();
  const sibling = hooks.openStream('workspace/follow', {}, new AbortController().signal)[Symbol.asyncIterator]();
  const eventNext = events.next(); const siblingNext = sibling.next();
  sockets[0].open(); await new Promise(resolve => setImmediate(resolve));
  sockets[0].message({ type: 'end', streamId: sockets[0].sent[0].streamId });
  assert.equal((await eventNext).done, true);
  assert.equal(sockets[0].readyState, 3);
  await assert.rejects(siblingNext, (/** @type {any} */ error) => error.dshRemoteStreamFailure?.kind === 'carrier');
  hooks.dispose();
});

test('only the native HMR EventSource URL is rebased and native class semantics survive', () => {
  const { target } = browser();
  class NativeEventSource {
    static CLOSED = 2;
    constructor(/** @type {any} */ url, /** @type {any} */ options) { this.url = url; this.options = options; }
  }
  target.EventSource = NativeEventSource; installRuntimeUiTransport(frame, target);
  const events = new target.EventSource('/plugins/events', { withCredentials: true });
  assert.equal(events.url, 'https://app.example:8443/__evimed/f/frame-a/plugins/events');
  assert.deepEqual(events.options, { withCredentials: true });
  assert.ok(events instanceof NativeEventSource); assert.equal(target.EventSource.CLOSED, 2);
  assert.equal(new target.EventSource('https://other.example/plugins/events').url, 'https://other.example/plugins/events');
  assert.equal(new target.EventSource('/other/events').url, '/other/events');
});

test('malformed frames fail with carrier markers and aborted event streams end their generation', async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const controller = new AbortController();
  const events = hooks.openStream('$events', {}, controller.signal)[Symbol.asyncIterator]();
  const next = events.next(); sockets[0].open(); await new Promise(resolve => setImmediate(resolve));
  sockets[0].dispatchEvent(new MessageEvent('message', { data: '{broken' }));
  await assert.rejects(next, (/** @type {any} */ error) => error.dshRemoteStreamFailure?.kind === 'carrier');
  const generation = hooks.openStream('$events', {}, controller.signal)[Symbol.asyncIterator]();
  const nextGeneration = generation.next(); sockets[1].open(); await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await assert.rejects(nextGeneration); assert.equal(sockets[1].readyState, 3);
  hooks.dispose();
});

test('aborting an event generation while connecting releases its candidate carrier', async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const abort = new AbortController();
  const events = hooks.openStream('$events', {}, abort.signal)[Symbol.asyncIterator]();
  const next = events.next(); abort.abort(); await assert.rejects(next);
  assert.equal(sockets[0].readyState, 3);
  const fresh = hooks.openStream('$events', {}, new AbortController().signal)[Symbol.asyncIterator]();
  const nextFresh = fresh.next(); assert.equal(sockets.length, 2); sockets[1].open();
  await new Promise(resolve => setImmediate(resolve)); sockets[1].close(); await assert.rejects(nextFresh);
  hooks.dispose();
});

test('native wire corruption rejects extra keys, empty identities and non-record failure details', { timeout: 1000 }, async () => {
  const corruptions = [
    { type: 'item', streamId: '', value: 1 },
    { type: 'item', streamId: 'unknown', value: 1, extra: true },
    { type: 'end', streamId: 'unknown', value: 1 },
    { type: 'error', streamId: 'unknown', error: { code: 'gateway/denied', message: 'Denied', details: [] } },
    { type: 'error', streamId: 'unknown', error: { code: 'gateway/denied', message: 'Denied', details: {}, extra: true } },
  ];
  for (const corruption of corruptions) {
    const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
    const stream = hooks.openStream('$events', {}, new AbortController().signal)[Symbol.asyncIterator]();
    const next = stream.next(); sockets[0].open(); await new Promise(resolve => setImmediate(resolve));
    sockets[0].message(corruption);
    await assert.rejects(next, (/** @type {any} */ error) => error.dshRemoteStreamFailure?.kind === 'carrier');
    hooks.dispose();
  }
});
