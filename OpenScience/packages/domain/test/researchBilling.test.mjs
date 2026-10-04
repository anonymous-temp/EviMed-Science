import assert from 'node:assert/strict';
import test from 'node:test';
import {
  researchMoneyUnits, researchMoneyDecimal, researchTaskCharge,
  SIMULATED_LOW_CREDITS, SIMULATED_START_CREDITS, SIMULATED_TOPUP_PACKAGES, SIMULATED_WALLET_LABEL, SIMULATED_WALLET_PAGES,
} from '../src/researchBilling.mjs';
import { ALL_ERROR_CODES, CREDIT_ERROR_CODES, allowanceRefusalSentence, errorCodeMessage, errorCodeOutcome } from '../index.mjs';
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

test('the simulated wallet vocabulary is closed, whole-credit and labelled', () => {
  assert.equal(SIMULATED_WALLET_LABEL, '模拟');
  assert.ok(Number.isSafeInteger(SIMULATED_START_CREDITS) && SIMULATED_START_CREDITS > SIMULATED_LOW_CREDITS);
  const ids = SIMULATED_TOPUP_PACKAGES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(SIMULATED_TOPUP_PACKAGES.map((entry) => entry.credits), [...SIMULATED_TOPUP_PACKAGES.map((entry) => entry.credits)].sort((a, b) => a - b));
  for (const entry of SIMULATED_TOPUP_PACKAGES) {
    assert.match(entry.id, /^topup-[1-9]\d*$/);
    assert.ok(Number.isSafeInteger(entry.credits) && entry.credits > 0, 'a package is a whole number of credits');
    assert.equal(entry.id, `topup-${entry.credits}`);
  }
  assert.deepEqual(Object.keys(SIMULATED_WALLET_PAGES), ['recharge', 'membership', 'orders', 'refunds']);
  for (const path of Object.values(SIMULATED_WALLET_PAGES)) assert.match(path, /^\/app\/account\/simulated\/[a-z]+$/);
  assert.ok(Object.isFrozen(SIMULATED_TOPUP_PACKAGES) && Object.isFrozen(SIMULATED_TOPUP_PACKAGES[0]) && Object.isFrozen(SIMULATED_WALLET_PAGES));
});

test('a refusal on a simulated allowance says 模拟 and is a ceiling', () => {
  assert.ok(CREDIT_ERROR_CODES.includes('simulated_credits_exhausted'));
  assert.equal(errorCodeOutcome('simulated_credits_exhausted'), 'capped');
  assert.match(errorCodeMessage('simulated_credits_exhausted'), /模拟/);
  assert.doesNotMatch(errorCodeMessage('simulated_credits_exhausted'), /^额度已用尽/);
  for (const code of ['simulated_wallet_not_enabled', 'simulated_wallet_request_invalid']) {
    assert.ok(ALL_ERROR_CODES.includes(code), code);
    assert.match(errorCodeMessage(code), /模拟/, code);
    assert.equal(errorCodeOutcome(code), 'upstream', code);
  }
});

test('the refusal a window prints says the allowance is low, by how much when known, and where it is topped up', () => {
  assert.equal(allowanceRefusalSentence({ simulated: true, balanceCny: 3.5, estimateCny: 6 }),
    '模拟额度不足，这次没有开始：可用模拟额度 ¥3.50，这件事预计至少需要 ¥6.00。到“设置 → 科研额度”做一次模拟充值后即可继续。');
  assert.equal(allowanceRefusalSentence({ balanceCny: 0, estimateCny: 12.345 }),
    '科研额度不足，这次没有开始：可用 ¥0.00，这件事预计至少需要 ¥12.35。到“设置 → 科研额度”充值后即可继续。');
  // No estimate (a free conversation against an empty allowance): the balance alone.
  assert.equal(allowanceRefusalSentence({ balanceCny: 0 }), '科研额度不足，这次没有开始：可用 ¥0.00。到“设置 → 科研额度”充值后即可继续。');
  // Nothing known: the sentence still says what happened and where to go, and invents no amount.
  assert.equal(allowanceRefusalSentence(), '科研额度不足，这次没有开始。到“设置 → 科研额度”充值后即可继续。');
  assert.equal(allowanceRefusalSentence({ simulated: true, balanceCny: Number.NaN, estimateCny: -1 }),
    '模拟额度不足，这次没有开始。到“设置 → 科研额度”做一次模拟充值后即可继续。');
  // The dictionary's sentence for the same codes sends the reader to the same place.
  for (const code of ['credits_exhausted', 'simulated_credits_exhausted']) assert.match(errorCodeMessage(code), /设置 → 科研额度|充值/);
});
