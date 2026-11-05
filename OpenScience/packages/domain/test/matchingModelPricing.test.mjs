import assert from 'node:assert/strict'
import test from 'node:test'
import { priceListFor, priceUsage } from '../index.mjs'

test('matching Qwen3.7 online models have explicit Beijing input rates without an off-peak discount', () => {
  for (const model of ['qwen3.7-text-rerank', 'qwen3.7-text-embedding']) {
    for (const peak of [true, false]) assert.deepEqual(priceUsage({ resourceType: 'model', model, cacheMiss: 1_000_000, output: 0, peak }), { cost: 0.5, priced: true, currency: 'CNY' })
    assert.equal(priceUsage({ resourceType: 'model', model, cacheMiss: 1000, peak: true }, priceListFor('evimed-reference-2026-11-04')).priced, false)
  }
})

test('matching Jev 1.14 is priced at the verified input-only USD rate',()=>{
  assert.deepEqual(priceUsage({resourceType:'model',model:'jev-1.14.0',cacheMiss:1_000_000,output:100,peak:false}),priceUsage({resourceType:'model',model:'jev-1.13.0',cacheMiss:1_000_000,output:0,peak:false}));
  assert.equal(priceUsage({resourceType:'model',model:'jev-1.14.0',cacheMiss:1000,peak:true},priceListFor('evimed-reference-2026-11-04')).priced,false);
})
