import test from 'node:test';
import assert from 'node:assert/strict';
import { availableRunActions, runIsStalled } from '../src/runActions.mjs';

test('actions describe only supported operations and their actual targets', () => {
  const run = { id: 'r', sessionId: 's', status: 'running', connectorNeeds: ['umls'] };
  assert.deepEqual(availableRunActions(run), [{ kind: 'stop', scope: 'run', targetId: 'r' }]);
  assert.deepEqual(availableRunActions({ ...run, status: 'succeeded' }), []);
  assert.deepEqual(availableRunActions({ ...run, status: 'succeeded' }, true), [{ kind: 'continue', scope: 'session', targetId: 's' }]);
  for (const status of ['failed', 'canceled']) assert.deepEqual(availableRunActions({ ...run, status }, true), []);
});

test('only authenticated activity newer than the stall clears its present-tense notice', () => {
  const stalled = { status: 'running', lastStallAt: '2026-10-09T01:00:00Z' };
  assert.equal(runIsStalled(stalled), true);
  assert.equal(runIsStalled({ ...stalled, lastTrustedProgressAt: '2026-10-09T01:01:00Z' }), false);
  assert.equal(runIsStalled({ ...stalled, status: 'succeeded' }), false);
});
