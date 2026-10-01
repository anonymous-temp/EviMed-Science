/* global EventTarget, Event, MessageEvent, Response, AbortController, Blob, setImmediate */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { RUNTIME_UI_MUX_RESPONSE_MAX_BYTES } from '@evimed/domain';
import { installRuntimeUiTransport } from '../src/runtimeUiTransport.mjs';

const frame = { version: 1, frameId: 'frame-a', projectId: 'project-a', shellOrigin: 'https://app.example', prefix: '/__evimed/f/frame-a/', muxResponseMaxBytes: RUNTIME_UI_MUX_RESPONSE_MAX_BYTES };
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

test('a revisioned bundle loads from the path every frame shares; anything else stays with the frame', async () => {
  // The document's preload of the same bundle is rewritten the same way
  // (rebaseRuntimeUiDocument); if the two disagree the browser downloads it twice.
  const { target, calls } = browser();
  const hooks = installRuntimeUiTransport({ ...frame, assets: '/__evimed/k/' }, target);
  await hooks.loadBundle('/plugins/??one/client.js,two/client.js&rev=0123456789ab');
  assert.equal(calls[0].src, 'https://app.example:8443/__evimed/k/plugins/??one/client.js,two/client.js&rev=0123456789ab');
  await hooks.loadBundle('/plugins/??one/client.js');
  assert.equal(calls[1].src, 'https://app.example:8443/__evimed/f/frame-a/plugins/??one/client.js', 'no revision, no shared copy');
  await hooks.fetch(new URL('https://app.example:8443/api/session/list'), {});
  assert.equal(calls[2][0], 'https://app.example:8443/__evimed/f/frame-a/api/session/list', 'methods never leave the frame');
  assert.throws(() => installRuntimeUiTransport({ ...frame, assets: '/elsewhere/' }, browser().target), /Invalid runtime frame/);
});

test('a composer attachment is carried to this frame, and the carrier takes nothing else', async () => {
  // dsh-client-file-upload posts from a Worker of its own to the origin's root
  // unless `__DSH_FILE_UPLOAD__` names a carrier before boot; unscoped, the
  // request reaches no project and the file is lost.
  const { target, calls } = browser();
  const hooks = installRuntimeUiTransport(frame, target);
  const carrier = target.__DSH_FILE_UPLOAD__;
  assert.equal(typeof carrier.fetch, 'function');
  const body = new Blob(['%PDF-1.7']);
  await carrier.fetch(new URL('https://app.example:8443/api/session/uploadFileBinary'), { method: 'POST', body, headers: { 'x-session': 's1' } });
  assert.equal(calls[0][0], 'https://app.example:8443/__evimed/f/frame-a/api/session/uploadFileBinary');
  assert.equal(calls[0][1].body, body, 'the bytes are passed through, not read on the page');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].redirect, 'error');
  await assert.rejects(carrier.fetch(new URL('https://app.example:8443/api/session/list'), {}), /Unscoped runtime URL/);
  await assert.rejects(carrier.fetch(new URL('https://evil.example/api/session/uploadFileBinary'), {}), /Foreign runtime URL/);
  hooks.dispose();
  await assert.rejects(carrier.fetch(new URL('https://app.example:8443/api/session/uploadFileBinary'), {}), /Runtime frame disposed/);
  assert.equal(calls.length, 1);
});

test('a stream asked of a disposed frame says the frame is gone, not that capacity ran out', async () => {
  const { target } = browser();
  const hooks = installRuntimeUiTransport(frame, target);
  hooks.dispose();
  const stream = hooks.openStream('session/follow', { args: {} }, new AbortController().signal)[Symbol.asyncIterator]();
  await assert.rejects(stream.next(), /Runtime frame disposed/);
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


test('a 17 MiB UTF-8 session follow snapshot and subsequent small streams share the serialized carrier', { timeout: 3000 }, async () => {
  const { target, sockets } = browser();
  const install = vm.runInNewContext(`(${installRuntimeUiTransport.toString()})`, { URL, Error, Map, Set, Promise, Object, JSON, TextEncoder });
  const hooks = install(frame, target);
  const follow = hooks.openStream('session/follow', { args: { sessionId: 'large-session', limit: 500, minTurns: 2 } }, new AbortController().signal)[Symbol.asyncIterator]();
  const pending = follow.next(); sockets[0].open(); await new Promise(resolve => setImmediate(resolve));
  const socket = sockets[0];
  const snapshot = { type: 'snapshot', records: Array.from({ length: 2900 }, (_, index) => ({ id: `record-${index}`, content: '研'.repeat(2050) })) };
  const response = { type: 'item', streamId: socket.sent[0].streamId, value: snapshot };
  assert.ok(Buffer.byteLength(JSON.stringify(response)) > 17 * 1024 * 1024);
  socket.message(response);
  assert.equal(JSON.stringify((await pending).value), JSON.stringify(snapshot));
  socket.message({ type: 'item', streamId: response.streamId, value: { type: 'update', sequence: 1 } });
  assert.equal(JSON.stringify((await follow.next()).value), JSON.stringify({ type: 'update', sequence: 1 }));
  socket.message({ type: 'end', streamId: response.streamId });
  assert.equal((await follow.next()).done, true);
  const small = hooks.openStream('workspace/follow', { args: {} }, new AbortController().signal)[Symbol.asyncIterator]();
  const next = small.next(); await new Promise(resolve => setImmediate(resolve));
  socket.message({ type: 'item', streamId: socket.sent.at(-1).streamId, value: 'still connected' });
  assert.equal((await next).value, 'still connected');
  assert.equal(sockets.length, 1); assert.equal(socket.readyState, 1);
  await small.return(); hooks.dispose();
});

test('receive limits count UTF-8 bytes and name an oversized frame', { timeout: 3000 }, async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const stream = hooks.openStream('session/follow', {}, new AbortController().signal)[Symbol.asyncIterator]();
  const pending = stream.next(); sockets[0].open(); await new Promise(resolve => setImmediate(resolve));
  const response = { type: 'item', streamId: sockets[0].sent[0].streamId, value: '研'.repeat(Math.ceil(frame.muxResponseMaxBytes / 3)) };
  assert.ok(JSON.stringify(response).length < frame.muxResponseMaxBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) > frame.muxResponseMaxBytes);
  sockets[0].message(response);
  await assert.rejects(pending, /Runtime carrier frame limit/);
  assert.equal(sockets[0].readyState, 3); hooks.dispose();
});

test('outbound requests retain their 2 MiB bound in UTF-8 bytes', { timeout: 3000 }, async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const request = { content: '研'.repeat(800_000) };
  assert.ok(JSON.stringify(request).length < 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024);
  const stream = hooks.openStream('session/prompt', request, new AbortController().signal)[Symbol.asyncIterator]();
  const pending = stream.next();
  const rejected = assert.rejects(pending, /Runtime carrier send limit/);
  sockets[0].open(); await new Promise(resolve => setImmediate(resolve));
  // Terminate the old implementation so its missing send rejection fails without a hanging test.
  if (sockets[0].sent.length) sockets[0].close();
  await rejected;
  assert.equal(sockets[0].sent.length, 0); hooks.dispose();
});

test('receive queues share a finite byte budget across sibling streams', { timeout: 3000 }, async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const streams = ['session/follow', 'workspace/follow'].map(endpoint => hooks.openStream(endpoint, {}, new AbortController().signal)[Symbol.asyncIterator]());
  const pending = streams.map(stream => stream.next()); sockets[0].open(); await new Promise(resolve => setImmediate(resolve));
  const socket = sockets[0]; const ids = socket.sent.map((/** @type {any} */ item) => item.streamId);
  ids.forEach((/** @type {string} */ streamId) => socket.message({ type: 'item', streamId, value: 0 })); await Promise.all(pending);
  // Each slow reader stays below its own byte and item limits; together they exceed 32 MiB.
  const value = '研'.repeat(1024 * 1024 / 3 | 0);
  for (let index = 0; index < 33; index++) socket.message({ type: 'item', streamId: ids[index % 2], value });
  assert.equal(socket.readyState, 3, 'aggregate queued bytes must close the carrier');
  for (const stream of streams) await assert.rejects(stream.next(), /Runtime stream receive limit/);
  hooks.dispose();
});

test('releasing a slow stream returns its receive budget to sibling streams', { timeout: 3000 }, async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const follow = hooks.openStream('session/follow', {}, new AbortController().signal)[Symbol.asyncIterator]();
  const pending = follow.next(); sockets[0].open(); await new Promise(resolve => setImmediate(resolve));
  const socket = sockets[0]; const id = socket.sent[0].streamId;
  socket.message({ type: 'item', streamId: id, value: 0 }); await pending;
  socket.message({ type: 'item', streamId: id, value: '研'.repeat(6 * 1024 * 1024) });
  assert.equal(socket.readyState, 1, 'the queued response fits the receive budget');
  await follow.return();
  const sibling = hooks.openStream('session/follow', {}, new AbortController().signal)[Symbol.asyncIterator]();
  const next = sibling.next(); await new Promise(resolve => setImmediate(resolve));
  socket.message({ type: 'item', streamId: socket.sent.at(-1).streamId, value: '研'.repeat(6 * 1024 * 1024) });
  assert.equal((await next).value.length, 6 * 1024 * 1024);
  assert.equal(sockets.length, 1); assert.equal(socket.readyState, 1);
  await sibling.return(); hooks.dispose();
});


test('a response at the shared UTF-8 byte ceiling is accepted exactly', async () => {
  const { target, sockets } = browser(); const hooks = installRuntimeUiTransport(frame, target);
  const stream = hooks.openStream('session/follow', {}, new AbortController().signal)[Symbol.asyncIterator]();
  const pending = stream.next(); sockets[0].open(); await new Promise(resolve => setImmediate(resolve));
  const response = { type: 'item', streamId: sockets[0].sent[0].streamId, value: '' };
  const remaining = frame.muxResponseMaxBytes - Buffer.byteLength(JSON.stringify(response));
  response.value = '研'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
  assert.equal(Buffer.byteLength(JSON.stringify(response)), frame.muxResponseMaxBytes);
  sockets[0].message(response);
  assert.equal((await pending).value, response.value);
  assert.equal(sockets[0].readyState, 1);
  await stream.return(); hooks.dispose();
});
