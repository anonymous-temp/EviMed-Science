import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geoStrategyDraft } from '../src/geoWrites.mjs';

test('malformed optional price references retain useful action text with unknown cost', () => {
  for (const reference of [null, false, 12, 'not-a-reference', {}, { kind: 'source_price', id: null }]) {
    const result = geoStrategyDraft({ actions: [{ gapId: 'gap-one', kind: 'fill_gap', what: { layer: 'popular', title: 'A useful content action' },
      estimate: { currency: 'CNY', low: 1, high: 2, basis: [reference] } }] });
    assert.equal(result.strategy.actions[0].what.title, 'A useful content action');
    assert.equal(result.strategy.actions[0].estimate ?? null, null);
    assert.ok(result.issues.some(issue => issue.field === 'actions[0].estimate'));
  }
});
