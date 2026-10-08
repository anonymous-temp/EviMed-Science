import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESEARCH_BILLING_VERSION, RESEARCH_BILLING_VERSION_WHOLE_CREDIT, estimateRunCostUnits, formatCredits,
  researchMoneyUnits, researchMoneyDecimal, researchTaskCharge,
  SIMULATED_LOW_CREDITS, SIMULATED_START_CREDITS, SIMULATED_TOPUP_PACKAGES, SIMULATED_WALLET_LABEL, SIMULATED_WALLET_PAGES,
} from '../src/researchBilling.mjs';
import {
  ALL_ERROR_CODES, BALANCE_REFUSAL_CODES, CREDIT_ERROR_CODES, STEP_WAITING_ALLOWANCE, allowanceRefusalSentence, allowanceWaitingNote, allowanceWaitingSentence,
  errorCodeMessage, errorCodeOutcome, stepWaitingFor,
} from '../index.mjs';
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
  // Each rule is its own version, recorded on the charge.
  assert.equal(result.pricingVersion, RESEARCH_BILLING_VERSION_WHOLE_CREDIT);
  assert.equal(researchTaskCharge([request], { mode: 'precision-v1' }).pricingVersion, RESEARCH_BILLING_VERSION);
  assert.notEqual(RESEARCH_BILLING_VERSION, RESEARCH_BILLING_VERSION_WHOLE_CREDIT);
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
  // What a simulated wallet does is take a top-up and list the orders. Membership and refunds had nothing behind them.
  assert.deepEqual(Object.keys(SIMULATED_WALLET_PAGES), ['recharge', 'orders']);
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
    '模拟额度不足，这次没有开始：可用模拟额度 3.50 灵豆，这件事预计至少需要 6.00 灵豆。到“设置 → 科研额度”做一次模拟充值后即可继续。');
  assert.equal(allowanceRefusalSentence({ balanceCny: 0, estimateCny: 12.345 }),
    '科研额度不足，这次没有开始：可用 0.00 灵豆，这件事预计至少需要 12.35 灵豆。到“设置 → 科研额度”充值后即可继续。');
  // No estimate (a free conversation against an empty allowance): the balance alone.
  assert.equal(allowanceRefusalSentence({ balanceCny: 0 }), '科研额度不足，这次没有开始：可用 0.00 灵豆。到“设置 → 科研额度”充值后即可继续。');
  // Nothing known: the sentence still says what happened and where to go, and invents no amount.
  assert.equal(allowanceRefusalSentence(), '科研额度不足，这次没有开始。到“设置 → 科研额度”充值后即可继续。');
  assert.equal(allowanceRefusalSentence({ simulated: true, balanceCny: Number.NaN, estimateCny: -1 }),
    '模拟额度不足，这次没有开始。到“设置 → 科研额度”做一次模拟充值后即可继续。');
  // The dictionary's sentence for the same codes sends the reader to the same place.
  for (const code of ['credits_exhausted', 'simulated_credits_exhausted']) assert.match(errorCodeMessage(code), /设置 → 科研额度|充值/);
});

test('a step the allowance would not start waits for one of two reasons, named by the refusal that stopped it', () => {
  assert.deepEqual([...STEP_WAITING_ALLOWANCE], ['allowance', 'simulated_allowance']);
  assert.equal(stepWaitingFor('credits_exhausted'), 'allowance');
  assert.equal(stepWaitingFor('simulated_credits_exhausted'), 'simulated_allowance');
  // Every refusal that waits on the balance names a wait, and nothing else does.
  for (const code of BALANCE_REFUSAL_CODES) assert.ok(STEP_WAITING_ALLOWANCE.includes(String(stepWaitingFor(code))), code);
  for (const code of ['runtime_limit_exceeded', 'credits_daily_limit_reached', 'usage_budget_exceeded', '', null, undefined]) assert.equal(stepWaitingFor(code), null, String(code));
  assert.equal(allowanceWaitingNote('allowance'), '等科研额度');
  assert.equal(allowanceWaitingNote('simulated_allowance'), '等模拟额度');
  assert.ok([...allowanceWaitingNote('simulated_allowance')].length <= 12, 'short enough for a rail');
  assert.equal(allowanceWaitingSentence('定义', 'allowance'), '「定义」这一步在等科研额度，充值后会自动开始。');
  assert.equal(allowanceWaitingSentence('定义', 'simulated_allowance'), '「定义」这一步在等模拟额度，模拟充值后会自动开始。');
});

test('an exact charge is the sum of the billable calls to the last 1e-8, and says what it is made of', () => {
  /** @param {string} id @param {string} cost @param {Record<string, any>} [extra] */
  const call = (id, cost, extra = {}) => ({ id, status: 'settled', priced: true, currency: 'CNY', purpose: 'kernel', actual_cost: cost, price_version: 'p1',
    cache_hit_tokens: '1000', cache_miss_tokens: '200', output_tokens: '50', ...extra });
  const result = researchTaskCharge([call('a', '0.01230000'), call('b', '0.03080000', { price_version: 'p2' }),
    call('c', '5.00000000', { purpose: 'title' }), call('d', '9.00000000', { status: 'reserved' })], { mode: 'precision-v1' });
  assert.equal(result.chargedCny, '0.04310000', 'a run costing 0.0431 is charged exactly 0.0431');
  assert.equal(result.waivedCny, '0.00000000');
  assert.deepEqual(result.usage, { calls: 2, cacheHitTokens: '2000', cacheMissTokens: '400', outputTokens: '100', priceVersions: ['p1', 'p2'] });
  // The same calls under the whole-credit rule are free.
  assert.equal(researchTaskCharge([call('a', '0.01230000'), call('b', '0.03080000')]).chargedCny, '0.00000000');
});

test('an amount is drawn with two decimals, and a small one with its first two significant digits, never as 0.00', () => {
  assert.equal(formatCredits('12.30000000'), '12.30');
  assert.equal(formatCredits('7.3'), '7.30');
  assert.equal(formatCredits('0.04310000'), '0.04');
  assert.equal(formatCredits('0.00430000'), '0.0043');
  assert.equal(formatCredits('0.00439999'), '0.0043', 'cut, not rounded: it can never read as the next digit');
  assert.equal(formatCredits('0.00600000'), '0.006');
  assert.equal(formatCredits('0.00999999'), '0.0099', 'never reads as 0.01');
  assert.equal(formatCredits('0.00000003'), '0.00000003');
  assert.equal(formatCredits('0'), '0.00');
  assert.equal(formatCredits(0), '0.00');
  assert.equal(formatCredits(0.0043), '0.0043', 'a number is accepted for drawing');
  assert.equal(formatCredits(12345678901n), '123.46', 'bigint units of 1e-8');
  // Rounding: a charge to the nearest, a balance down, a need up.
  assert.equal(formatCredits('1.23500000'), '1.24');
  assert.equal(formatCredits('1.23999999', { rounding: 'down' }), '1.23');
  assert.equal(formatCredits('1.23000001', { rounding: 'up' }), '1.24');
  assert.equal(formatCredits('1.23000000', { rounding: 'up' }), '1.23');
  assert.equal(formatCredits('0.009', { rounding: 'down' }), '0.009', 'a balance above zero is never drawn as 0.00');
  // A need is carried up, so a refusal never shows a balance and a need that read the same (review F10).
  assert.equal(formatCredits('0.00999999', { rounding: 'up' }), '0.01', 'the next step is 0.01');
  assert.equal(formatCredits('0.00999999', { rounding: 'down' }), '0.0099');
  assert.equal(formatCredits('0.00431000', { rounding: 'up' }), '0.0044');
  assert.equal(formatCredits('0.00430000', { rounding: 'up' }), '0.0043', 'an exact amount is not carried');
  assert.equal(formatCredits('0.00000003', { rounding: 'up' }), '0.00000003');
  assert.equal(formatCredits('0.00000001', { rounding: 'up' }), '0.00000001');
  assert.equal(formatCredits('0.00600001', { rounding: 'up' }), '0.0061');
  assert.equal(formatCredits('99.99999999', { rounding: 'down' }), '99.99');
  assert.equal(formatCredits('99.99999999'), '100.00');
  assert.equal(formatCredits('-0.0043'), '-0.0043');
  for (const bad of ['', 'abc', '1.123456789', null, undefined, Number.NaN, {}]) assert.equal(formatCredits(bad), '', String(bad));
});

test('the exact estimate is P50 and P90 of the history in integer units, and a 0.40 estimate is not 0', () => {
  /** @param {string} value */
  const sample = (value) => researchMoneyUnits(value);
  const history = estimateRunCostUnits({ samples: ['0.30', '0.40', '0.40', '0.50', '1.00'].map(sample) });
  assert.equal(history.basis, 'history');
  assert.equal(researchMoneyDecimal(history.p50), '0.40000000');
  assert.equal(researchMoneyDecimal(history.p90), '0.80000000', 'interpolated between 0.50 and 1.00');
  // Too little history falls back to the manifest's minutes at the reference rate; none at all is no basis.
  const manifest = estimateRunCostUnits({ samples: [sample('9')], estimatedMinutes: [2, 5] });
  assert.deepEqual([manifest.basis, researchMoneyDecimal(manifest.p50), researchMoneyDecimal(manifest.p90)], ['manifest', '0.40000000', '1.00000000']);
  assert.deepEqual(estimateRunCostUnits({}), { p50: 0n, p90: 0n, basis: 'none' });
});
