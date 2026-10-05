import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CREDIT_EXPIRY_REMINDER_DAYS, CREDIT_GIFT_SOURCES, CREDIT_LOT_KINDS, CREDIT_LOT_SOURCES, CREDIT_OPERATOR_GRANT_SOURCES,
  CREDIT_SOURCE_LABELS, accountMonthStart, expiryDateOf, expiryInstantAfterDays, expiryInstantOfDate, expiryReminderDue, expiryWords,
  monthlyCycleAt, monthlyDateOf,
} from '../src/creditLots.mjs'

test('there are two kinds of 灵豆 and every source is one of the platform\'s own or an operator\'s', () => {
  assert.deepEqual([...CREDIT_LOT_KINDS], ['purchased', 'gifted'])
  assert.deepEqual([...CREDIT_GIFT_SOURCES], ['signup', 'monthly', 'compensation', 'campaign'])
  assert.deepEqual([...CREDIT_OPERATOR_GRANT_SOURCES], ['compensation', 'campaign'], 'no daily check-in, no invitation')
  assert.deepEqual([...CREDIT_LOT_SOURCES], ['topup', ...CREDIT_GIFT_SOURCES])
  for (const source of CREDIT_LOT_SOURCES) assert.ok(/** @type {Record<string, string>} */ (CREDIT_SOURCE_LABELS)[source], source)
  assert.deepEqual([...CREDIT_EXPIRY_REMINDER_DAYS], [7, 1])
})

test('a gifted lot expires at 24:00 Asia/Shanghai on its date, and the date shown is the last day it can be spent', () => {
  assert.equal(expiryInstantOfDate('2026-10-31').toISOString(), '2026-10-31T16:00:00.000Z')
  assert.equal(expiryDateOf('2026-10-31T16:00:00.000Z'), '2026-10-31', 'the last moment of 31 October')
  assert.equal(expiryDateOf('2026-10-31T16:00:00.001Z'), '2026-11-01')
  assert.equal(expiryWords('2026-10-31T16:00:00.000Z'), '10 月 31 日')
  assert.equal(expiryWords(expiryInstantOfDate('2026-12-01')), '12 月 1 日')
  // A real calendar date or nothing: a typo is refused, never rolled into the next month.
  for (const bad of ['2026-02-30', '2026-13-01', '2026-10-5', 'tomorrow', '']) assert.throws(() => expiryInstantOfDate(bad), RangeError, bad)
})

test('a lot that lasts N days is valid through the date N days after today in Shanghai', () => {
  // 03:00Z on 5 October is 11:00 on 5 October in Shanghai: 30 days is through 4 November.
  assert.equal(expiryInstantAfterDays('2026-10-05T03:00:00Z', 30).toISOString(), '2026-11-04T16:00:00.000Z')
  // 23:30Z on 5 October is already 6 October in Shanghai.
  assert.equal(expiryDateOf(expiryInstantAfterDays('2026-10-05T23:30:00Z', 30)), '2026-11-05')
  for (const bad of [0, -1, 1.5, 4000, Number.NaN]) assert.throws(() => expiryInstantAfterDays('2026-10-05T03:00:00Z', bad), RangeError, String(bad))
})

test('the month a person reads begins at 00:00 on its first day in Shanghai, and agrees with a gift\'s expiry', () => {
  // 2026-10-31T16:30Z is 1 November 00:30 in Shanghai: the month is November already.
  assert.equal(accountMonthStart('2026-10-31T16:30:00Z').toISOString(), '2026-10-31T16:00:00.000Z')
  assert.equal(accountMonthStart('2026-10-31T15:59:59Z').toISOString(), '2026-09-30T16:00:00.000Z')
  assert.equal(accountMonthStart(new Date('2026-11-15T00:00:00Z')).toISOString(), '2026-10-31T16:00:00.000Z')
  // A lot that expires at the end of 31 October lapses at the very instant November's month begins.
  assert.equal(expiryInstantOfDate('2026-10-31').getTime(), accountMonthStart('2026-10-31T16:30:00Z').getTime())
  assert.equal(accountMonthStart('2026-12-31T16:00:00Z').toISOString(), '2026-12-31T16:00:00.000Z', 'a year boundary')
})

test('an account\'s monthly date is the day of its creation, clamped to the length of the month', () => {
  const created = '2026-01-31T10:00:00Z'
  assert.deepEqual([0, 1, 2, 3, 12].map((index) => monthlyDateOf(created, index).toISOString()), [
    '2026-01-30T16:00:00.000Z', '2026-02-27T16:00:00.000Z', '2026-03-30T16:00:00.000Z', '2026-04-29T16:00:00.000Z', '2027-01-30T16:00:00.000Z',
  ])
  // Created at 00:30 on the 1st in Shanghai (16:30Z on the 31st): the account's day is the 1st.
  assert.equal(monthlyDateOf('2026-01-31T16:30:00Z', 1).toISOString(), '2026-02-28T16:00:00.000Z')
})

test('only the current monthly cycle exists, and none before the first monthly date', () => {
  const created = '2026-01-31T10:00:00Z'
  assert.equal(monthlyCycleAt(created, '2026-02-10T00:00:00Z'), null)
  assert.equal(monthlyCycleAt(created, '2026-02-27T15:59:00Z'), null, 'the first date is 28 February in Shanghai')
  const first = monthlyCycleAt(created, '2026-02-28T00:00:00Z')
  assert.equal(first?.index, 1)
  assert.equal(first?.startsAt.toISOString(), '2026-02-27T16:00:00.000Z')
  assert.equal(first?.endsAt.toISOString(), '2026-03-30T16:00:00.000Z', 'one lot expires exactly where the next begins: no carry-over, no overlap')
  // A gap of months does not backfill: the cycle is the one now.
  assert.equal(monthlyCycleAt(created, '2026-06-20T00:00:00Z')?.index, 4, 'the cycle that began on 31 May')
  assert.equal(monthlyCycleAt(created, '2025-12-01T00:00:00Z'), null)
})

test('a lot is reminded 7 days and 1 day before it ends — the nearest due one, and never for an empty or ended lot', () => {
  const lot = { createdAt: '2026-10-05T00:00:00Z', expiresAt: '2026-11-04T16:00:00Z', remaining: '3.20000000' }
  assert.equal(expiryReminderDue(lot, '2026-10-20T00:00:00Z'), null)
  assert.equal(expiryReminderDue(lot, '2026-10-28T16:00:00Z'), 7, 'exactly seven days before')
  assert.equal(expiryReminderDue(lot, '2026-11-02T00:00:00Z'), 7)
  assert.equal(expiryReminderDue(lot, '2026-11-03T16:00:00Z'), 1)
  assert.equal(expiryReminderDue(lot, '2026-11-04T15:59:59Z'), 1)
  assert.equal(expiryReminderDue(lot, '2026-11-04T16:00:00Z'), null, 'over')
  assert.equal(expiryReminderDue({ ...lot, remaining: '0.00000000' }, '2026-11-03T16:00:00Z'), null)
  assert.equal(expiryReminderDue({ ...lot, remaining: 0n }, '2026-11-03T16:00:00Z'), null)
  assert.equal(expiryReminderDue({ ...lot, remaining: 5n }, '2026-11-03T16:00:00Z'), 1)
  // A sweep that was down across both marks sends the 1-day one alone, not a stack.
  assert.equal(expiryReminderDue(lot, '2026-11-04T10:00:00Z'), 1)
  // A lot granted with three days to run never had a 7-day mark.
  const short = { createdAt: '2026-11-01T16:00:00Z', expiresAt: '2026-11-04T16:00:00Z', remaining: '1.00000000' }
  assert.equal(expiryReminderDue(short, '2026-11-01T17:00:00Z'), null)
  assert.equal(expiryReminderDue(short, '2026-11-03T17:00:00Z'), 1)
})
