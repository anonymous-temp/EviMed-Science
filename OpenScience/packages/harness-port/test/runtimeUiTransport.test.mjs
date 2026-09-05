import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installRuntimeUiTransport } from '../src/runtimeUiTransport.mjs';

const frame = { version: 1, frameId: 'frame-a', projectId: 'project-a', shellOrigin: 'https://app.example', prefix: '/frames/frame-a/' };
function browser() {
  const sockets = [];
  const calls = [];
  class Socket extends EventTarget {
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    constructor(url) { super(); this.url = url; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const target = {
    location: { origin: 'https://app.example:8443' }, WebSocket: Socket,
    crypto: { randomUUID: () => `id-${Math.random()}` },
    fetch: async (...args) => { calls.push(args); return new Response('{}'); },
    setTimeout, clearTimeout, addEventListener() {},
    document: { createElement: () => ({}), head: { appendChild(script) { calls.push(script); script.onload(); } } },
  };
  return { target, sockets, calls };
}

test('official hooks rebase only the owned frame without replacing browser fetch or claiming Host ownership', async () => {
  const { target, calls } = browser(); const original = target.fetch;
  const hooks = installRuntimeUiTransport(frame, target);
  assert.equal(target.fetch, original);
  assert.equal(target.__DSH_TRANSPORT__, hooks);
  assert.notEqual(hooks.ownsHost, true);
  await hooks.fetch(new URL('https://app.example:8443/api/remote/session/list'), { method: 'POST' });
  assert.equal(calls[0][0], 'https://app.example:8443/frames/frame-a/api/remote/session/list');
  await hooks.loadBundle('/plugins/??one/client.js,two/client.js&rev=a');
  assert.equal(calls[1].src, 'https://app.example:8443/frames/frame-a/plugins/??one/client.js,two/client.js&rev=a');
  await assert.rejects(hooks.fetch(new URL('https://evil.example/api/test'), {}));
  await assert.rejects(hooks.loadBundle('/frames/frame-b/plugins/one.js'));
});

test('the synchronous bootstrap is self-contained after function serialization', () => {
  const { target } = browser();
  const install = vm.runInNewContext(`(${installRuntimeUiTransport.toString()})`, { URL, Error, Map, Set, Promise, Object, JSON });
  assert.equal(typeof install(frame, target).openStream, 'function');
});

test('logical streams share one carrier, cancel independently and retain upstream failure markers', async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const firstAbort = new AbortController(); const secondAbort = new AbortController();
  const first = hooks.openStream('$events', { args: {} }, firstAbort.signal)[Symbol.asyncIterator]();
  const second = hooks.openStream('session/follow', { args: { id: 'session-b' } }, secondAbort.signal)[Symbol.asyncIterator]();
  const pendingA = first.next(); const pendingB = second.next();
  assert.equal(sockets.length, 1); const socket = sockets[0]; socket.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.url, 'wss://app.example:8443/frames/frame-a/api/remote.mux');
  const [openA, openB] = socket.sent;
  socket.message({ type: 'item', streamId: openA.streamId, value: { type: 'ready' } });
  assert.deepEqual(await pendingA, { done: false, value: { type: 'ready' } });
  firstAbort.abort(); await first.return();
  assert.ok(socket.sent.some(item => item.type === 'cancel' && item.streamId === openA.streamId));
  socket.message({ type: 'error', streamId: openB.streamId, error: { code: 'gateway/forbidden', message: 'Denied', details: {} } });
  await assert.rejects(pendingB, error => error.dshRemoteStreamFailure?.kind === 'remote' && error.dshRemoteStreamFailure.code === 'gateway/forbidden');
  hooks.dispose();
});

test('carrier closure fails every active stream and the next generation can open one fresh carrier', async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const stream = hooks.openStream('$events', {}, new AbortController().signal)[Symbol.asyncIterator]();
  const next = stream.next(); sockets[0].open(); await new Promise(resolve => setImmediate(resolve));
  sockets[0].close();
  await assert.rejects(next, error => error.dshRemoteStreamFailure?.kind === 'carrier');
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
  await assert.rejects(stream.next(), error => error.dshRemoteStreamFailure?.kind === 'carrier'); hooks.dispose();
});
