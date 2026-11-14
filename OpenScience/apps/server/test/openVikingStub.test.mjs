import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { OpenVikingStub } from './helpers/openVikingStub.mjs';

test('closing the engine fixture cancels pending deletion timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stub = await new OpenVikingStub().start();
  t.after(() => stub.close());
  stub.users.set('u', { learning: true, memoryTypes: [] });
  const uri = stub.seedMemory('u', 'notes/a.md', 'Retained until deletion completes.');
  const req = request(`${stub.url}/api/v1/admin/accounts/evimed/users/u`, {
    method: 'DELETE', headers: { 'x-api-key': stub.apiKey, 'x-openviking-user': 'u' },
  });
  req.end();
  const [res] = await once(req, 'response');
  res.resume();
  await once(res, 'end');
  assert.equal(res.statusCode, 202);
  await stub.close();
  t.mock.timers.tick(30);
  assert.ok(stub.files.has(uri), 'a closed fixture must not execute its deferred mutation');
});

test('closing the engine fixture clears a delayed response timer and settles its waiter', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stub = await new OpenVikingStub().start();
  t.after(() => stub.close());
  stub.delayMs = 60_000;
  const req = request(`${stub.url}/health`);
  const ended = new Promise(resolve => { req.on('error', resolve); req.on('close', resolve); });
  req.end();
  await once(stub.server, 'request');
  await setImmediate();
  assert.equal(stub.timers.size, 1);
  await stub.close();
  await ended;
  assert.equal(stub.timers.size, 0, 'no delayed response remains after fixture shutdown');
});
