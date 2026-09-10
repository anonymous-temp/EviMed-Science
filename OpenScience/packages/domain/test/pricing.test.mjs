import assert from 'node:assert/strict'
import test from 'node:test'
import { priceUsage, priceListFor, REFERENCE_PRICE_LIST } from '../index.mjs'

// Verified against https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ on 2026-09-10.
test('the versioned model reference prices match the current CNY table', () => {
  assert.equal(REFERENCE_PRICE_LIST.version, 'evimed-reference-2026-09-10')
  /** @type {[string, number, number][]} */
  const cases = [['deepseek-flash', 10, 5], ['deepseek-v4-flash', 10, 5], ['deepseek-v4-flash-vision-exp', 10, 5], ['deepseek-v4-pro', 36, 18]]
  for (const [model, peak, off] of cases) {
    assert.equal(priceUsage({ resourceType: 'model', model, cacheMiss: 1_000_000, output: 1_000_000, peak: true }).cost, peak)
    assert.equal(priceUsage({ resourceType: 'model', model, cacheMiss: 1_000_000, output: 1_000_000, peak: false }).cost, off)
  }
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
