import assert from 'node:assert/strict';
import test from 'node:test';
import { researchMoneyUnits, researchMoneyDecimal, researchTaskCharge } from '../src/researchBilling.mjs';
test('money retains fractional precision without binary rounding', () => {
  assert.equal(researchMoneyDecimal(researchMoneyUnits('0.00000001')), '0.00000001');
  assert.throws(() => researchMoneyUnits('0.000000001'));
  assert.throws(() => researchMoneyUnits(-1));
});
test('confirmed requests are deduplicated, overhead and uncertain money excluded', () => {
  const request = { id: 'a', status: 'settled', priced: true, currency: 'CNY', purpose: 'kernel', actual_cost: '1.90000001', price_version: 'p1' };
  const result = researchTaskCharge([request, request, { ...request, id: 'b', purpose: 'routing' }, { ...request, id: 'c', status: 'uncertain' }]);
  assert.equal(result.actualCny, '3.80000002');
  assert.equal(result.billableCny, '1.90000001');
  assert.equal(result.chargedCny, '1.00000000');
  assert.equal(result.waivedCny, '0.90000001');
  assert.equal(result.evidence.length, 3);
  assert.equal(researchTaskCharge([request], { mode: 'precision-v1' }).creditsAmount, '1.90000001');
  assert.equal(researchTaskCharge([request], { owned: false }).billableCny, '0.00000000');
});

test('waivers exclude background overhead and pre-policy requests', () => {
  const research = { id: 'a', status: 'settled', priced: true, currency: 'CNY', purpose: 'kernel', actual_cost: '2.75000000' };
  const result = researchTaskCharge([research, { ...research, id: 'b', purpose: 'title', actual_cost: '3.00000000' }], { owned: false });
  assert.equal(result.actualCny, '5.75000000');
  assert.equal(result.platformCostCny, '3.00000000');
  assert.equal(result.eligibleCny, '2.75000000');
  assert.equal(result.waivedCny, '2.75000000');
  const past = researchTaskCharge([{ ...research, billing_eligible: false, not_billable_reason: 'before_policy_activation' }]);
  assert.equal(past.waivedCny, '0.00000000');
  assert.equal(past.chargedCny, '0.00000000');
  const platform = researchTaskCharge([{ ...research, billing_eligible: false, not_billable_reason: 'platform_task' }]);
  assert.equal(platform.waivedCny, '0.00000000');
  assert.equal(platform.platformCostCny, '2.75000000');
});
