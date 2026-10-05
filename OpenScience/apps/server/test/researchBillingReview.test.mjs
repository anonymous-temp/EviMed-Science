import assert from 'node:assert/strict';
import test from 'node:test';
import { EvimedCreditsService } from '../src/evimedCreditsService.mjs';

// A legacy run already charged the shared dispatch request. The new task
// attribution table is empty because it did not exist at that time.
test('a billing-mode switch must not charge a previously paid dispatch on its retry', async () => {
  const calls = [];
  let evidence = null;
  const epoch = '2026-10-02 00:00:00.123456+00';
  const request = { id: 'request_old', status: 'settled', priced: true, currency: 'CNY', purpose: 'kernel', actual_cost: '2.00000000', price_version: 'provider-v1', created_at: '2026-10-02T01:00:00Z' };
  const old = { run_id: 'run_old', user_id: 'review_user', credits: 2, status: 'settled' };
  const database = {
    async transaction(callback) { return callback(this); },
    async query(sql, values = []) {
      if (sql.startsWith('SELECT u.auth_type')) return { rows: [{ auth_type: 'evimed', evimed_user_id: 'upstream_user', owner_created_at: epoch }] };
      if (sql.includes('SELECT * FROM evimed_credits.settlements')) return { rows: values[0] === old.run_id ? [old] : [] };
      if (sql.includes('FROM evimed_usage.model_requests')) {
        assert.ok(values[1].includes('shared_dispatch'));
        // Request attribution did not exist at the time of the old charge.
        // The activation cutoff must exclude this otherwise unclaimed usage.
        return { rows: [request] };
      }
      if (sql.includes('INSERT INTO evimed_credits.research_tasks(')) evidence = JSON.parse(values[3]);
      if (sql.includes('INSERT INTO evimed_credits.settlements')) return { rows: [{ run_id: values[0], user_id: values[1], project_id: values[2], capability_id: values[3], memo: values[4], cost_cny: values[5], credits: values[6], credits_per_cny: 1, status: values[7], attempts: values[8], created_at: '2026-10-03T00:00:00Z', next_attempt_at: values[9] }] };
      return { rows: [] };
    },
  };
  const service = new EvimedCreditsService({ config: { researchBillingEnabled: true, evimedCreditsEnabled: true, evimedCreditsPerCny: 1 }, database,
    client: { configured: true, async deduct(row) { calls.push(row); return { receiptId: 'receipt' }; } }, evimedUserIdOf: async () => 'upstream_user' });
  const result = await service.settleTask({ runId: 'run_retry', userId: 'review_user', dispatchId: 'shared_dispatch', status: 'completed', accountCreatedAt: epoch },
    { pricing_version: 'research-allowance-v1-20261003', activated_at: '2026-10-03T00:00:00Z' });
  assert.deepEqual(result, { status: 'settled', credits: 0, reason: 'waived' });
  assert.equal(evidence?.actualCny, '2.00000000');
  assert.equal(evidence?.billableCny, '0.00000000');
  assert.equal(evidence?.evidence[0].notBillableReason, 'before_policy_activation');
  assert.equal(calls.length, 0, 'already-paid logical dispatch was charged again under its retry run id');
});

// A study's own second opinions are queued by the module when a computation settles, so no run asked for them
// (`vcrUsageScope.mjs`): they carry the study's scope, and the module's runs settle that scope with their own rows.
test('a module run settles the usage its study booked under its scope, and nothing else does', async () => {
  const epoch = '2026-10-02 00:00:00.123456+00';
  const asked = [];
  const database = {
    async transaction(callback) { return callback(this); },
    async query(sql, values = []) {
      if (sql.startsWith('SELECT u.auth_type')) return { rows: [{ auth_type: 'evimed', evimed_user_id: 'upstream_user', owner_created_at: epoch }] };
      if (sql.includes('FROM evimed_usage.model_requests')) { asked.push(values[1]); return { rows: [] }; }
      if (sql.includes('INSERT INTO evimed_credits.settlements')) return { rows: [{ run_id: values[0], user_id: values[1], project_id: values[2], capability_id: values[3], memo: values[4], cost_cny: values[5], credits: values[6], credits_per_cny: 1, status: values[7], attempts: values[8], created_at: '2026-10-03T00:00:00Z', next_attempt_at: values[9] }] };
      return { rows: [] };
    },
  };
  const service = new EvimedCreditsService({ config: { researchBillingEnabled: true, evimedCreditsEnabled: true, evimedCreditsPerCny: 1 }, database,
    client: { configured: true, async deduct() { return { receiptId: 'receipt' }; } }, evimedUserIdOf: async () => 'upstream_user' });
  const policy = { pricing_version: 'research-allowance-v1-20261003', activated_at: '2026-10-03T00:00:00Z' };
  const settle = (run) => service.settleTask({ userId: 'review_user', accountCreatedAt: epoch, ...run }, policy);
  await settle({ runId: 'run_vcr_ok', dispatchId: 'vcr-run-definition-1', projectId: 'pfs', status: 'completed' });
  assert.deepEqual(asked.at(-1), ['run_vcr_ok', 'vcr-run-definition-1', 'vcr-project-pfs'], 'the module run sums its own rows and its study\'s scope');
  await settle({ runId: 'run_vcr_failed', dispatchId: 'vcr-run-definition-2', projectId: 'pfs', status: 'failed' });
  assert.deepEqual(asked.at(-1), ['run_vcr_failed'], 'failed work settles only itself');
  await settle({ runId: 'run_other', dispatchId: 'dispatch-1', projectId: 'pfs', status: 'completed' });
  assert.deepEqual(asked.at(-1), ['run_other', 'dispatch-1'], 'a run that is not the module\'s never sums a study\'s scope');
});
