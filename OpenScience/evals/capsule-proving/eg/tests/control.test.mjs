import assert from 'node:assert/strict';
import test from 'node:test';
import { control } from '../control.mjs';

const owner = 'cl-s1a-01234567';
function app({ busyJob = false, busyJobAfter = Infinity, liveRun = false, liveWire = false, unknownWire = false, attached = true } = {}) {
  const stopped = [];
  let queries = 0;
  return { stopped,
    store: { database: { query: async () => ({ rows: busyJob || ++queries >= busyJobAfter ? [{}] : [] }) }, userById: async id => ({ id }),
      requireProject: async (user, id) => ({ userId: user.id, id }) },
    agentRuns: { list: async () => [{ status: liveRun ? 'running' : 'succeeded' }] },
    runtimeManager: { runtimeBusy: async () => { if (unknownWire) throw new Error('unreadable kernel'); return liveWire; },
      stopIdleRuntime: async (project, { guard }) => { if (!attached || !await guard()) return false; stopped.push(project); return true; },
      hasAttachedOrStartingRuntime: () => attached && !stopped.length } };
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
test('a job that starts during idle release is preserved by the final stop guard', async () => {
  const subject = app({ busyJobAfter: 3 });
  assert.deepEqual(await control(subject, 'lxEGIdleLearning', { userIds: [owner] }), { busy: true });
  assert.equal(subject.stopped.length, 0);
});
test('live kernel work is preserved even before the run ledger observes it', async () => {
  const subject = app({ liveWire: true });
  assert.deepEqual(await control(subject, 'lxEGIdleLearning', { userIds: [owner] }), { busy: true });
  assert.equal(subject.stopped.length, 0);
});
test('an unreadable kernel is never assumed idle', async () => {
  const subject = app({ unknownWire: true });
  assert.deepEqual(await control(subject, 'lxEGIdleLearning', { userIds: [owner] }), { busy: true });
  assert.equal(subject.stopped.length, 0);
});
test('an absent runtime needs no release and does not hold the browser', async () => {
  const subject = app({ attached: false });
  assert.deepEqual(await control(subject, 'lxEGIdleLearning', { userIds: [owner] }), { busy: false, stopped: [] });
});
