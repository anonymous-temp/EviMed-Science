import assert from 'node:assert/strict'
import test from 'node:test'
import { priceUsage, priceListFor, REFERENCE_PRICE_LIST } from '../index.mjs'

// Verified against https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ on 2026-09-10.
test('the versioned model reference prices match the current CNY table', () => {
  assert.equal(REFERENCE_PRICE_LIST.version, 'evimed-reference-2026-09-24')
  /** @type {[string, number, number][]} */
  const cases = [['deepseek-flash', 10, 5], ['deepseek-v4-flash', 10, 5], ['deepseek-v4-flash-vision-exp', 10, 5], ['deepseek-v4-pro', 36, 18]]
  for (const [model, peak, off] of cases) {
    assert.equal(priceUsage({ resourceType: 'model', model, cacheMiss: 1_000_000, output: 1_000_000, peak: true }).cost, peak)
    assert.equal(priceUsage({ resourceType: 'model', model, cacheMiss: 1_000_000, output: 1_000_000, peak: false }).cost, off)
  }
})

// Verified against https://help.aliyun.com/zh/model-studio/qwen3-8-max on 2026-09-23.
test('the reviewer model is priced at DashScope\'s one rate, day and night', () => {
  for (const model of ['qwen3.8-max-0902', 'qwen3.8-max']) {
    const at = (/** @type {boolean} */ peak) => priceUsage({ resourceType: 'model', model, cacheHit: 1_000_000, cacheMiss: 1_000_000, output: 1_000_000, peak })
    assert.equal(at(true).cost, 49.5, `${model}: ¥1.5 cached + ¥12 input + ¥36 output per million`)
    assert.equal(at(false).cost, 49.5, `${model}: DeepSeek's night rate is not DashScope's`)
    assert.equal(at(true).priced, true)
  }
  // The DeepSeek rows the new list carries over are the 2026-09-10 ones, discount and all.
  const september10 = priceListFor('evimed-reference-2026-09-10')
  assert.ok(september10)
  assert.deepEqual(REFERENCE_PRICE_LIST.model['deepseek-flash'], september10.model['deepseek-flash'])
  assert.equal(priceUsage({ resourceType: 'model', model: 'qwen3.8-max-0902', cacheMiss: 1, peak: true }, september10).priced, false,
    'a list from before the reviewer existed cannot price it')
})

test('small cache charges remain nonzero before aggregation', () => {
  assert.equal(priceUsage({ resourceType: 'model', model: 'deepseek-flash', cacheHit: 1, peak: false }).cost, 0.00000002)
  assert.equal(priceUsage({ resourceType: 'model', model: 'deepseek-v4-pro', cacheHit: 1, peak: false }).cost, 0.00000015)
})

test('DeepSeek off-peak discounts do not invent discounts on other resources', () => {
  for (const input of [
    { resourceType: 'asr', minutes: 1 },
    { resourceType: 'embedding', tokens: 1_000_000 },
    { resourceType: 'specialist-job', jobType: 'meta-analysis' },
  ]) assert.equal(priceUsage({ ...input, peak: false }).cost, priceUsage({ ...input, peak: true }).cost)
})


test('a Flash price change preserves the historical billed price list', () => {
  const prior = priceListFor('evimed-reference-2026-09-05')
  assert.ok(prior)
  assert.deepEqual(prior.model['deepseek-v4-flash'], { cacheHit: 0.1, cacheMiss: 3, output: 9 })
  assert.equal(priceUsage({ resourceType: 'model', model: 'deepseek-v4-flash', cacheMiss: 1_000_000, output: 1_000_000, peak: true }, prior).cost, 12)
  assert.equal(priceUsage({ resourceType: 'model', model: 'deepseek-flash', cacheMiss: 1, peak: true }, prior).priced, false)
  assert.equal(priceUsage({ resourceType: 'model', model: 'deepseek-v4.1-flash', cacheMiss: 1, peak: true }).priced, false)
})

// Verified against https://docs.typesafe.ai/models on 2026-09-24: $0.042 per
// million input tokens, output free. The rate is the CFETS central parity the
// list names, fixed with the list.
test('Jev is billed in dollars per input token, converted to yuan at the rate its list fixed', () => {
  const usd = REFERENCE_PRICE_LIST.exchangeRates?.USD
  assert.ok(usd, 'the list that prices a dollar row fixes a dollar rate')
  assert.ok(usd.rate > 6 && usd.rate < 8, `a USD/CNY central parity, not ${usd.rate}`)
  assert.match(usd.date, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(usd.source, /chinamoney\.com\.cn/, 'the rate names the official source it was read from')
  const at = (/** @type {boolean} */ peak) => priceUsage({ resourceType: 'model', model: 'jev-1.13.0', cacheMiss: 1_000_000, output: 5_000_000, peak })
  const expected = Math.round(0.042 * usd.rate * 100_000_000) / 100_000_000
  assert.deepEqual(at(true), { cost: expected, priced: true, currency: 'CNY' }, 'input at $0.042/M in yuan; output free')
  assert.deepEqual(at(false), at(true), 'no night rate: DeepSeek\'s discount is not TypeSafe\'s')
  // A reply check's typical request, 6,000 input tokens: a fraction of a fen.
  assert.equal(priceUsage({ resourceType: 'model', model: 'jev-1.13.0', cacheMiss: 6_000, output: 40, peak: true }).cost,
    Math.round(6_000 / 1_000_000 * 0.042 * usd.rate * 100_000_000) / 100_000_000)
})

test('a dollar row is never billed as yuan: a list with no rate for its currency cannot price it', () => {
  const noRate = /** @type {any} */ ({ ...REFERENCE_PRICE_LIST, exchangeRates: {} })
  assert.deepEqual(priceUsage({ resourceType: 'model', model: 'jev-1.13.0', cacheMiss: 1_000_000, peak: true }, noRate), { cost: 0, priced: false, currency: 'CNY' })
  const badRate = /** @type {any} */ ({ ...REFERENCE_PRICE_LIST, exchangeRates: { USD: { rate: 0, date: '2026-09-24', source: 'x' } } })
  assert.equal(priceUsage({ resourceType: 'model', model: 'jev-1.13.0', cacheMiss: 1_000_000, peak: true }, badRate).priced, false)
  // A row in the list's own currency needs no rate at all.
  assert.equal(priceUsage({ resourceType: 'model', model: 'deepseek-flash', cacheMiss: 1_000_000, peak: true }, noRate).cost, 2)
})

test('the lists that priced rows before Jev are untouched', () => {
  const september23 = priceListFor('evimed-reference-2026-09-23')
  assert.ok(september23)
  assert.equal(september23.effectiveFrom, '2026-09-23T00:00:00.000Z')
  assert.equal('jev-1.13.0' in september23.model, false)
  assert.equal(september23.exchangeRates, undefined)
  assert.deepEqual(september23.model['qwen3.8-max-0902'], { cacheHit: 1.5, cacheMiss: 12, output: 36, offPeak: false })
  assert.equal(priceUsage({ resourceType: 'model', model: 'jev-1.13.0', cacheMiss: 1, peak: true }, september23).priced, false,
    'a list from before Jev cannot price it')
  // Every rate the new list carries over is the old one's.
  for (const [model, rate] of Object.entries(september23.model)) assert.deepEqual(REFERENCE_PRICE_LIST.model[model], rate, model)
})

