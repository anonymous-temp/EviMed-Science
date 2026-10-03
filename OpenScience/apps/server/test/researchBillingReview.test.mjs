import assert from 'node:assert/strict';
import test from 'node:test';
import { EvimedCreditsService } from '../src/evimedCreditsService.mjs';

// A legacy run already charged the shared dispatch request. The new task
// attribution table is empty because it did not exist at that time.
test('a billing-mode switch must not charge a previously paid dispatch on its retry', async () => {
  const calls = [];
  const request = { id: 'request_old', status: 'settled', priced: true, currency: 'CNY', purpose: 'kernel', actual_cost: '2.00000000', price_version: 'provider-v1' };
  const old = { run_id: 'run_old', user_id: 'review_user', credits: 2, status: 'settled' };
  const database = {
    async transaction(callback) { return callback(this); },
    async query(sql, values = []) {
      if (sql.includes('SELECT * FROM evimed_credits.settlements')) return { rows: values[0] === old.run_id ? [old] : [] };
      if (sql.includes('FROM evimed_usage.model_requests')) {
        assert.ok(values[1].includes('shared_dispatch'));
        // With no new attribution row, the implemented NOT EXISTS accepts
        // this old request; a legacy-settlement exclusion would reject it.
        return { rows: sql.includes('FROM evimed_credits.settlements') ? [] : [request] };
      }
      if (sql.includes('INSERT INTO evimed_credits.settlements')) return { rows: [{ run_id: values[0], user_id: values[1], project_id: values[2], capability_id: values[3], memo: values[4], cost_cny: values[5], credits: values[6], credits_per_cny: 1, status: values[7], attempts: values[8], created_at: '2026-10-03T00:00:00Z', next_attempt_at: values[9] }] };
      return { rows: [] };
    },
  };
  const service = new EvimedCreditsService({ config: { researchBillingEnabled: true, evimedCreditsEnabled: true, evimedCreditsPerCny: 1 }, database,
    client: { configured: true, async deduct(row) { calls.push(row); return { receiptId: 'receipt' }; } }, evimedUserIdOf: async () => 'upstream_user' });
  await service.settleRun({ runId: 'run_retry', userId: 'review_user', dispatchId: 'shared_dispatch', status: 'completed' });
  assert.equal(calls.length, 0, 'already-paid logical dispatch was charged again under its retry run id');
});
