import test from 'node:test';
import assert from 'node:assert/strict';
import { productCall, waitDeleteSettled, runnerOutcome, projectRunName } from '../run/productLifecycle.mjs';

test('dispatch waits for delete-settled; cleanup_busy retries are bounded and recorded', async () => {
  const events = [], receipts = [{ state: 'pending' }, { state: 'settled' }];
  let attempts = 0;
  const result = await productCall({ call: async () => { events.push('dispatch'); attempts++; return attempts === 1 ? { status: 409, json: { error: { code: 'cleanup_busy' } } } : { status: 202 }; },
    beforeDispatch: () => waitDeleteSettled({ read: async () => { events.push('receipt'); return receipts.shift(); }, sleep: async () => {}, attempts: 3 }),
    sleep: async () => {}, retries: 2 });
  assert.deepEqual(events, ['receipt', 'receipt', 'dispatch', 'dispatch']); assert.equal(result.response.status, 202);
  assert.equal(result.attempts, 2);
  const busy = await productCall({ call: async () => ({ status: 409, json: { code: 'cleanup_busy' } }), sleep: async () => {}, retries: 2 });
  assert.equal(busy.outcome, 'resource-refused'); assert.equal(busy.attempts, 3);
  const unsettled = await waitDeleteSettled({ read: async () => ({ state: 'pending' }), attempts: 2, sleep: async () => {} });
  assert.equal(unsettled.outcome, 'timeout');
  let dispatches = 0;
  const held = await productCall({ call: async () => { dispatches++; }, beforeDispatch: async () => unsettled });
  assert.equal(dispatches, 0); assert.equal(held.outcome, 'timeout');
});
test('404 triggers ownership verification and never adopts another project', async () => {
  let calls = 0, verifies = 0;
  const result = await productCall({ call: async () => ({ status: ++calls === 1 ? 404 : 202 }), verifyOwnedProject: async () => { verifies++; return false; }, sleep: async () => {} });
  assert.equal(verifies, 1); assert.equal(calls, 1); assert.equal(result.outcome, 'unobserved');
  const ok = await productCall({ call: async () => ({ status: ++calls === 2 ? 404 : 202 }), verifyOwnedProject: async () => true, sleep: async () => {} });
  assert.equal(ok.response.status, 202);
});
test('infrastructure outcomes remain separate from incorrect completed tasks', () => {
  assert.equal(runnerOutcome({ timedOut: true }), 'timeout');
  assert.equal(runnerOutcome({ status: 429 }), 'resource-refused');
  assert.equal(runnerOutcome({ code: 'runtime_capacity_exceeded' }), 'resource-refused');
  assert.equal(runnerOutcome({ status: 200, correct: false }), 'task-failed');
  assert.notEqual(projectRunName('P7', 'run-a'), projectRunName('P7', 'run-b'));
});
