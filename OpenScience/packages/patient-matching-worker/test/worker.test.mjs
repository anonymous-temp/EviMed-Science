import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateClinicalScore, fuseCandidates, validatePermutation } from '../index.mjs';

test('clinical calculation executes the existing published formula with exact typed operands', async () => {
  const reply = await calculateClinicalScore({ action: 'compute', id: 'bmi', inputs: { weight: { value: 80, unit: 'kg' }, height: { value: 2, unit: 'm' } } });
  assert.equal(reply.status, 'success');
  assert.equal(reply.data.result.value, 20);
});

test('missing operands decline only the requested calculation and return no invented result', async () => {
  const reply = await calculateClinicalScore({ action: 'compute', id: 'bmi', inputs: { weight: { value: 80, unit: 'kg' } } });
  assert.equal(reply.status, 'unsupported');
  assert.equal(reply.code, 'clinical_score_missing_inputs');
  assert.equal(reply.data.result, undefined);
});

test('untrusted expressions and oversized input never enter the calculator', async () => {
  await assert.rejects(calculateClinicalScore({ action: 'compute', id: 'bmi', expression: 'danger', inputs: {} }), { code: 'matching_compute_input_invalid' });
  await assert.rejects(calculateClinicalScore({ action: 'compute', id: 'bmi', inputs: { raw: 'x'.repeat(300000) } }), { code: 'matching_compute_input_invalid' });
});

test('cancellation settles without leaving a calculation child running', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(calculateClinicalScore({ action: 'list' }, { signal: controller.signal }), { name: 'AbortError' });
});

test('rank fusion preserves trial identities, rejects duplicates per channel and never adds raw provider scores', () => {
  const rows = fuseCandidates([{ ids: ['A', 'B'], weight: 1 }, { ids: ['B', 'C'], weight: 1 }], { limit: 3 });
  assert.deepEqual(rows.map(row => row.id), ['B', 'A', 'C']);
  assert.throws(() => fuseCandidates([{ ids: ['A', 'A'], weight: 1 }]), { code: 'matching_rank_input_invalid' });
});

test('a provider must return a complete permutation of the supplied candidate identities', () => {
  assert.deepEqual(validatePermutation(['B', 'A'], ['A', 'B']), ['B', 'A']);
  for (const output of [['A'], ['A', 'A'], ['A', 'C']]) assert.throws(() => validatePermutation(output, ['A', 'B']), { code: 'matching_rank_identity_invalid' });
});
