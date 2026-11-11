import assert from 'node:assert/strict';
import test from 'node:test';
import { control } from '../control.mjs';

const owner = 'cl-s1a-01234567';
function app({ busyJob = false, liveRun = false } = {}) {
  const stopped = [];
  return { stopped,
    store: { database: { query: async () => ({ rows: busyJob ? [{}] : [] }) }, userById: async id => ({ id }),
      requireProject: async (user, id) => ({ userId: user.id, id }) },
    agentRuns: { list: async () => [{ status: liveRun ? 'running' : 'succeeded' }] },
    runtimeManager: { stop: async project => { stopped.push(project); } } };
}
test('a queued due or running learning job is allowed to finish', async () => {
  const subject = app({ busyJob: true });
  assert.deepEqual(await control(subject, 'lxEGIdleLearning', { userIds: [owner] }), { busy: true });
  assert.equal(subject.stopped.length, 0);
});
test('a live internal run is preserved even after the job ledger goes quiet', async () => {
  const subject = app({ liveRun: true });
  assert.deepEqual(await control(subject, 'lxEGIdleLearning', { userIds: [owner] }), { busy: true });
  assert.equal(subject.stopped.length, 0);
});
test('only a completed internal learning kernel is reclaimed', async () => {
  const subject = app();
  assert.deepEqual(await control(subject, 'lxEGIdleLearning', { userIds: [owner] }), { busy: false, stopped: [owner] });
  assert.deepEqual(subject.stopped, [{ userId: owner, id: 'evimed-learning' }]);
});
test('ordinary identities cannot be stopped through the lab hook', async () => {
  const subject = app();
  await assert.rejects(control(subject, 'lxEGIdleLearning', { userIds: ['real-researcher'] }), /throwaway identity/);
  assert.equal(subject.stopped.length, 0);
});
