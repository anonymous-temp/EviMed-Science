import test from 'node:test';
import assert from 'node:assert/strict';
import { driveTurns } from './driver.mjs';

test('natural turns preserve session, upload additions at the right turn and capture before continuing', async () => {
  const events = [];
  const api = async (method, route, body) => {
    if (route.endsWith('/dispatch')) { events.push(['dispatch', body]); return { id: `r${events.length}`, status: 'succeeded' }; }
    throw new Error('unexpected request');
  };
  const turns = [{ text: 'Compare the groups.' }, { text: 'Include these additional patients.', inputs: ['additional.csv'] }];
  const records = await driveTurns({ api, sessionId: 'same-session', turns,
    upload: async (files) => events.push(['upload', files]),
    capture: async (run) => { events.push(['capture', run.id]); return { complete: true }; },
  });
  assert.equal(records.length, 2);
  assert.deepEqual(events.map((e) => e[0]), ['upload', 'dispatch', 'capture', 'upload', 'dispatch', 'capture']);
  const bodies = events.filter((e) => e[0] === 'dispatch').map((e) => e[1]);
  assert.ok(bodies.every((b) => b.sessionId === 'same-session' && b.automated === true));
  assert.ok(bodies.every((b) => !('agentId' in b) && !('capabilityId' in b)));
  assert.notEqual(bodies[0].dispatchId, bodies[1].dispatchId);
  assert.deepEqual(bodies.map((b) => b.text), turns.map((t) => t.text));
});

test('incomplete capture or failed execution stops follow-ups', async () => {
  for (const status of ['failed', 'succeeded']) {
    let dispatched = 0;
    const records = await driveTurns({ sessionId: 's', turns: [{ text: 'one' }, { text: 'two' }],
      api: async () => { dispatched += 1; return { id: 'r', status }; },
      upload: async () => {}, capture: async () => ({ complete: status !== 'succeeded' }),
    });
    assert.equal(dispatched, 1);
    assert.equal(records.length, 1);
  }
});

test('timeout cancels the actual run and does not start another turn', async () => {
  const routes = [];
  await driveTurns({ sessionId: 's', turns: [{ text: 'one' }, { text: 'two' }], timeoutMs: 0,
    api: async (method, route) => { routes.push(route); return { id: 'r', status: 'running' }; },
    upload: async () => {}, capture: async () => ({ complete: true }),
  });
  assert.deepEqual(routes, ['/api/agent-runs/dispatch', '/api/agent-runs/r/cancel']);
});
