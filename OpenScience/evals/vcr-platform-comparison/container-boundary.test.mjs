import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { closedCorpusFetch, installClosedCorpusFence, runtimeSocketFence } from './container-boundary.mjs';

test('VCR provider transport permits only the exact DeepSeek completion route and refuses redirects', async () => {
  const dispatched = [];
  let blocked = 0;
  const fetch = closedCorpusFetch(async (...args) => dispatched.push(args), () => { blocked += 1; });
  for (const url of ['https://clinicaltrials.gov/api/v2/studies/NCT00000000',
    'https://api.deepseek.com.attacker.invalid/chat/completions', 'https://api.deepseek.com/chat/completions?redirect=1',
    'https://api.deepseek.com/v1/files', 'http://api.deepseek.com/chat/completions']) {
    const denied = await fetch(url, { method: 'POST' });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { code: 'benchmark_closed_corpus' });
  }
  assert.equal((await fetch('https://api.deepseek.com/chat/completions')).status, 403);
  assert.equal(blocked, 6);
  assert.deepEqual(dispatched, []);
  await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', redirect: 'follow' });
  assert.deepEqual(dispatched, [['https://api.deepseek.com/chat/completions', { method: 'POST', redirect: 'error' }]]);
});

test('socket subnet fence preserves authorized internal gateways and rejects browser and search routes', () => {
  const onRuntimeNetwork = runtimeSocketFence('172.25.16.0/20');
  assert.equal(onRuntimeNetwork({ remoteAddress: '::ffff:172.25.31.254' }), true);
  assert.equal(onRuntimeNetwork({ remoteAddress: '172.25.32.1' }), false);
  assert.equal(onRuntimeNetwork({ localAddress: '172.25.16.2', remoteAddress: '127.0.0.1' }), true);
  assert.throws(() => runtimeSocketFence('0.0.0.0/0'));
  const server = new EventEmitter();
  const admitted = [];
  server.on('request', req => admitted.push(req.url));
  installClosedCorpusFence(server, { onRuntimeNetwork, instance: 'test-instance' });
  const simulate = (url, socket, forwarded = '') => {
    const result = {};
    const response = {
      setHeader(key, value) { result[key] = value; },
      writeHead(status) { result.status = status; return this; },
      end(body) { if (body) result.code = JSON.parse(body).code; },
    };
    server.emit('request', { url, socket, headers: { 'x-forwarded-for': forwarded } }, response);
    return result;
  };
  const runtime = { remoteAddress: '172.25.20.8' };
  assert.equal(simulate('/api/auth/register', runtime, '127.0.0.1').code, 'benchmark_runtime_route_forbidden');
  assert.equal(simulate('/api/admin', { localAddress: '172.25.16.2' }).status, 403);
  assert.equal(simulate('/internal/tooluniverse/v1/rpc', runtime).code, 'benchmark_runtime_route_forbidden');
  assert.equal(simulate('/internal/sources/v1/fetch', runtime).code, 'benchmark_closed_corpus');
  assert.equal(simulate('/internal/search/v1/query', { remoteAddress: '127.0.0.1' }).code, 'benchmark_closed_corpus');
  simulate('/internal/vcr/v1/read', runtime);
  simulate('/internal/model/v1/chat/completions', runtime);
  simulate('/internal/results/v1/inspect', runtime);
  simulate('/api/auth/register', { remoteAddress: '127.0.0.1' }, '172.25.20.8');
  assert.deepEqual(admitted, ['/internal/vcr/v1/read', '/internal/model/v1/chat/completions',
    '/internal/results/v1/inspect', '/api/auth/register']);
});
