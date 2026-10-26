import test from 'node:test';
import assert from 'node:assert/strict';
import { driveTurns, analysisEvidence } from './driver.mjs';

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

test('timeout waits for cancellation to settle before capturing and does not start another turn', async () => {
  const routes = [];
  let captures = 0;
  await driveTurns({ sessionId: 's', turns: [{ text: 'one' }, { text: 'two' }], timeoutMs: 0,
    api: async (method, route) => { routes.push(route); return route === '/api/agent-runs' ? [{ id: 'r', status: 'canceled' }] : { id: 'r', status: 'running' }; },
    pause: async () => {}, upload: async () => {}, capture: async (run) => { captures += 1; assert.equal(run.status, 'canceled'); return { complete: true }; },
  });
  assert.deepEqual(routes, ['/api/agent-runs/dispatch', '/api/agent-runs/r/cancel', '/api/agent-runs']);
  assert.equal(captures, 1);
});

test('unsettled cancellation retains run identity for cleanup and refuses mutable capture', async () => {
  let captured = false;
  const records = await driveTurns({ sessionId: 's', turns: [{ text: 'one' }], timeoutMs: 0, cancelTimeoutMs: 0,
    api: async () => ({ id: 'still-live', status: 'running' }), upload: async () => {},
    capture: async () => { captured = true; return { complete: true }; },
  });
  assert.equal(captured, false);
  assert.equal(records[0].run.id, 'still-live');
  assert.equal(records[0].artifacts.complete, false);
});

test('successful prose or a wrong route is not analysis execution evidence', () => {
  const run = { status: 'succeeded', effectiveAgentId: 'statistical-analysis' };
  const input = { path: 'data/cohort.csv', sha256: 'data' };
  assert.equal(analysisEvidence({ run, artifacts: { manifest: [input], tools: [] } }, [], 'analysis').complete, false);
  const artifacts = { manifest: [input, { path: 'analysis.py', sha256: 'code' }, { path: 'analysis-results.json', sha256: 'values' }, { path: 'statistical-report.md', sha256: 'report' }], tools: [{ name: 'bash', status: 'completed', error: false }] };
  assert.equal(analysisEvidence({ run, artifacts }, [], 'analysis').complete, true);
  assert.equal(analysisEvidence({ run: { ...run, effectiveAgentId: 'open-domain-answer' }, artifacts }, [], 'analysis').complete, false);
  assert.equal(analysisEvidence({ run, artifacts: { ...artifacts, tools: [] } }, [], 'analysis').complete, false);
});

test('reuse evidence requires an earlier executed result and unchanged numerical files', () => {
  const manifest = [{ path: 'analysis-results.json', sha256: 'values' }, { path: 'statistical-report.md', sha256: 'report' }, { path: 'analysis.py', sha256: 'code' }];
  const record = { run: { effectiveAgentId: 'statistical-analysis' }, artifacts: { manifest, tools: [] } };
  assert.equal(analysisEvidence(record, manifest, 'reuse').complete, true);
  assert.equal(analysisEvidence(record, [], 'reuse').complete, false);
  assert.equal(analysisEvidence({ ...record, artifacts: { manifest: [{ path: 'analysis-results.json', sha256: 'changed' }], tools: [] } }, manifest, 'reuse').complete, false);
});
