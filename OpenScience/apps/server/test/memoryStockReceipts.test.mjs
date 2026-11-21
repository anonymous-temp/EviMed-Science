import assert from 'node:assert/strict';
import test from 'node:test';
import { stockCounts, validateInventory } from '../../../scripts/ops/memory-stock-receipts.mjs';

const item = { kind: 'native', uri: 'viking://user/stock/memories/profile.md', owner: 'owner', hash: 'a'.repeat(64), fingerprint: 'b'.repeat(64) };
test('no inventory is unverified and needs no database or secrets', async () => {
  assert.deepEqual(await stockCounts(null, []), { status: 'unverified', cleaned: 0, unverified: 0, present: 0 });
  assert.throws(() => validateInventory([{ ...item, text: 'anything' }]));
  assert.throws(() => validateInventory([item, item]));
});
test('stock metadata checks require exact positive receipts; current fingerprints win conflicts', async () => {
  for (const [row, status] of [[{}, 'unverified'], [{ same_file: true, removed_file: true }, 'present'],
    [{ live_line: true }, 'present'], [{ exact_sweep: true }, 'cleaned'], [{ removed_file: true }, 'cleaned']]) {
    const client = { query: async (sql, args) => {
      assert.deepEqual(args, [item.owner, item.uri, item.hash, item.fingerprint]);
      assert.doesNotMatch(sql, /\b(?:body|text|before|after|salt)\b/i);
      return { rows: [row] };
    } };
    assert.equal((await stockCounts(client, [item]))[status], 1);
  }
});
test('a derived digest needs a physical cleanup timestamp; pending and missing receipts are unknown', async () => {
  const { fingerprint, ...address } = item;
  for (const [row, expected] of [[null, 'unverified'], [{ state: 'withdrawn', cleaned: false }, 'unverified'],
    [{ state: 'ready' }, 'present'], [{ state: 'withdrawn', cleaned: true }, 'cleaned']]) {
    assert.equal((await stockCounts({ query: async () => ({ rows: [row] }) }, [{ ...address, kind: 'chunk' }])).status, expected);
  }
});
