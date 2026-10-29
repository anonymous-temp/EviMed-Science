import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geoLedgerBalances } from '../src/geoDistributionMoney.mjs';

const entry = (id, kind, amountCny, orderId = 'order-a') => ({ id, kind, amountCny, orderId, createdAt: `2026-10-24T00:00:${id.padStart(2, '0')}Z` });
test('project statement separates reservations, settlement, refunds and a replacement budget', () => {
  const result = geoLedgerBalances([
    entry('1', 'budget_set', 500, null), entry('2', 'reserve', 100), entry('3', 'settle', 80), entry('4', 'release', 20),
    entry('5', 'refund', 30), entry('6', 'budget_set', 700, null),
  ]);
  const rows = result.entries;
  assert.equal(rows[1].balance.availableCny, 400);
  assert.equal(rows[2].balance.reservedCny, 20);
  assert.equal(rows[3].balance.reservedCny, 0);
  assert.deepEqual(rows[4].balance, { budgetCny: 500, dailyCny: null, reservedCny: 0, settledCny: 80, refundedCny: 30, spentCny: 50, availableCny: 450 });
  assert.equal(rows[5].balance.spentCny, 50);
  assert.equal(rows[5].balance.availableCny, 650);
});
test('a later statement page carries prior per-order reserve and settlement instead of restarting at zero', () => {
  const result = geoLedgerBalances([entry('3', 'settle', 80), entry('4', 'release', 20), entry('5', 'refund', 30)], {
    openingBudgetCny: 500, openingSums: [{ orderId: 'order-a', kind: 'reserve', amountCny: 100 }],
  });
  assert.equal(result.opening.availableCny, 400);
  assert.equal(result.entries.at(-1).balance.availableCny, 450);
  const overReserve = geoLedgerBalances([entry('1', 'settle', 120)], { openingBudgetCny: 500, openingSums: [{ orderId: 'order-a', kind: 'reserve', amountCny: 100 }] });
  assert.equal(overReserve.entries[0].balance.reservedCny, 0);
  assert.equal(overReserve.entries[0].balance.spentCny, 120);
});
test('missing historical budget is unknown; top-ups and cancelled-order state cannot fabricate money movement', () => {
  const result = geoLedgerBalances([entry('1', 'topup_confirmed', 999, null), entry('2', 'reserve', 100)]);
  assert.equal(result.opening.availableCny, null);
  assert.equal(result.entries[1].balance.availableCny, null);
  assert.equal(result.entries[1].balance.spentCny, 0);
  assert.equal(result.entries[1].balance.reservedCny, 100);
});
