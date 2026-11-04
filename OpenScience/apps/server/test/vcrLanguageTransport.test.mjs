import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { startVcrLanguageTransport } from '../src/vcrLanguageTransport.mjs';

function fake() {
  const req = new EventEmitter();
  let callback, options, target;
  req.end = body => { req.body = body; };
  req.destroy = error => queueMicrotask(() => req.emit('error', error));
  const requestImpl = (url, opts, cb) => { target = url; options = opts; callback = cb; return req; };
  return { req, requestImpl, target: () => target, options: () => options, answer(status, body) {
    const response = new EventEmitter(); response.statusCode = status; response.resume = () => {}; callback(response);
    response.emit('data', Buffer.from(body)); response.emit('end');
  } };
}

test('handoff is the writable finish event, and response does not follow redirects', async () => {
  const f = fake(); const task = startVcrLanguageTransport({ apiKey: 'fixture-key', encodedBody: '{"x":1}', requestImpl: f.requestImpl });
  assert.equal(f.target().href, 'https://api.deepseek.com/chat/completions');
  assert.equal(f.options().method, 'POST'); assert.equal(f.req.body, '{"x":1}');
  let handed = false; task.handoff.then(() => { handed = true; });
  await Promise.resolve(); assert.equal(handed, false);
  f.req.emit('finish'); await task.handoff; assert.equal(handed, true);
  f.answer(302, 'redirect'); const result = await task.response;
  assert.equal(result.status, 302); assert.equal(result.body.toString(), 'redirect');
});

test('abort before handoff rejects both promises and pre-abort sends nothing', async () => {
  const f = fake(); const controller = new AbortController();
  const task = startVcrLanguageTransport({ apiKey: 'fixture', encodedBody: '{}', requestImpl: f.requestImpl, signal: controller.signal });
  controller.abort(); f.req.emit('finish'); await assert.rejects(task.handoff, /aborted/); await assert.rejects(task.response, /aborted/);
  let sent = false; assert.throws(() => startVcrLanguageTransport({ apiKey: 'fixture', encodedBody: '{}', signal: AbortSignal.abort(), requestImpl: () => { sent = true; } }));
  assert.equal(sent, false);
});

test('oversized provider output rejects the response after a completed handoff', async () => {
  const f = fake(); const task = startVcrLanguageTransport({ apiKey: 'fixture', encodedBody: '{}', requestImpl: f.requestImpl, maxResponseBytes: 2 });
  f.req.emit('finish'); await task.handoff;
  f.answer(200, 'too long'); await assert.rejects(task.response, /exceeds/);
});

test('an early response is not mistaken for complete request handoff', async () => {
  const f = fake(); const task = startVcrLanguageTransport({ apiKey: 'fixture', encodedBody: '{}', requestImpl: f.requestImpl });
  f.answer(503, 'unavailable');
  await assert.rejects(task.handoff, /before body handoff/);
  await assert.rejects(task.response, /before body handoff/);
  f.req.emit('finish');
});

test('abort after handoff rejects the response and leaves handoff as completed', async () => {
  const f = fake(); const controller = new AbortController();
  const task = startVcrLanguageTransport({ apiKey: 'fixture', encodedBody: '{}', requestImpl: f.requestImpl, signal: controller.signal });
  f.req.emit('finish'); await task.handoff;
  controller.abort(); await assert.rejects(task.response, /aborted/);
});
