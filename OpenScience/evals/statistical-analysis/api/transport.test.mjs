import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithRetry } from './transport.mjs';

test('safe retries preserve the original mutation identity and record the transport fault', async () => {
  const bodies = [], failures = [];
  const result = await fetchWithRetry('http://localhost/turns', { method: 'POST', body: '{"requestId":"same"}' }, {
    retryable: true, pause: async () => {}, onRetry: value => failures.push(value),
    fetchImpl: async (url, options) => { bodies.push(options.body); if (bodies.length === 1) throw new TypeError('fetch failed'); return { status: 202 }; },
  });
  assert.equal(result.status, 202);
  assert.deepEqual(bodies, ['{"requestId":"same"}', '{"requestId":"same"}']);
  assert.equal(failures.length, 1);
});

test('non-idempotent imports, HTTP refusals and repeated transport failures are not hidden', async () => {
  let count = 0;
  await assert.rejects(fetchWithRetry('http://localhost/inputs', { method: 'POST' }, { pause: async () => {}, fetchImpl: async () => { count++; throw new TypeError('fetch failed'); } }));
  assert.equal(count, 1);
  count = 0;
  const response = await fetchWithRetry('http://localhost/analysis', {}, { fetchImpl: async () => { count++; return { status: 401 }; } });
  assert.equal(response.status, 401);
  assert.equal(count, 1);
  count = 0;
  await assert.rejects(fetchWithRetry('http://localhost/analysis', {}, { pause: async () => {}, fetchImpl: async () => { count++; throw new TypeError('fetch failed'); } }));
  assert.equal(count, 3);
});
