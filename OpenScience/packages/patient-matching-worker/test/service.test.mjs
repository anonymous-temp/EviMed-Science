import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createWorkerServer } from '../src/service.mjs';

test('contained worker authorizes fixed operations and executes the packaged calculator', async t => {
  const token = 'a'.repeat(64);
  const server = createWorkerServer({ readToken: async () => token });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/execute`;
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
  const call = body => fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const forbidden = await call({ operation: 'shell', input: { command: 'anything' } });
  assert.equal(forbidden.status, 400);
  assert.equal((await forbidden.json()).code, 'matching_worker_operation_invalid');
  const response = await call({ operation: 'clinical-score', input: { action: 'compute', id: 'bmi', inputs: { weight: { value: 80, unit: 'kg' }, height: { value: 2, unit: 'm' } } } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.result.value, 20);
});
