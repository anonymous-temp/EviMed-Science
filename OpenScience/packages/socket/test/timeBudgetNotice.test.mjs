// The clock a turn with a wall-clock budget is told (`timeBudgetNotice`): which moments, and what the sentence says. Pure, so the
// moments are asserted on numbers and no clock at all; that the plugin reaches them, once per turn, and says nothing without a budget is
// `consistency.test.mjs`'s ("the wall-clock budget").
import assert from 'node:assert/strict'
import test from 'node:test'

import { RUN_TIME_BUDGET_MINUTES, runTimeBudgetMinutes } from '@evimed/domain'

import { TIME_BUDGET_NOTICE_STEP_PERCENT, timeBudgetNotice } from '../src/runPolicy.mjs'

const MINUTE = 60_000

/** Walk a turn's steps at these elapsed minutes the way the plugin does, and say which of them were told something. */
function told(/** @type {number} */ budget, /** @type {number[]} */ minutes) {
  let said = -1
  /** @type {{ at: number, level: number, text: string }[]} */
  const lines = []
  for (const at of minutes) {
    const notice = timeBudgetNotice(budget, at * MINUTE, said)
    if (!notice) continue
    said = notice.level
    lines.push({ at, ...notice })
  }
  return lines
}

test('the moments are the first step and every 5% of the budget after it, at the next step', () => {
  assert.equal(TIME_BUDGET_NOTICE_STEP_PERCENT, 5)
  const lines = told(60, [0, 0, 2, 3, 4, 5, 6, 9, 10, 59, 60, 90, 600])
  assert.deepEqual(lines.map((line) => [line.at, line.level]), [[0, 0], [3, 1], [6, 2], [9, 3], [59, 19], [60, 20]],
    'a line per 5% crossed, once each, none after the budget is spent')
  assert.deepEqual(told(20, [0, 1, 2, 3]).map((line) => line.level), [0, 1, 2, 3], 'on a 20 minute budget that is every minute')
})

test('the sentence names the budget, what is used, what is left, and that a complete deliverable should exist before the time is out', () => {
  assert.equal(timeBudgetNotice(60, 0, -1)?.text, '本轮时间预算 60 分钟，已用 0 分钟，剩余 60 分钟。时间用完之前，要有一份完整的可交付成果。')
  assert.equal(timeBudgetNotice(60, 30 * MINUTE, 0)?.text, '本轮时间预算 60 分钟，已用 30 分钟，剩余 30 分钟。时间用完之前，要有一份完整的可交付成果。')
  assert.equal(timeBudgetNotice(60, 54 * MINUTE, 17)?.text, '本轮时间预算 60 分钟，已用 54 分钟，剩余 6 分钟。时间用完之前，要有一份完整的可交付成果。')
  assert.equal(timeBudgetNotice(1, 0, -1)?.text, '本轮时间预算 1 分钟，已用 0 分钟，剩余 1 分钟。时间用完之前，要有一份完整的可交付成果。')
})

test('a boundary is exact, whatever the budget: the share is compared in whole percents', () => {
  for (const budget of [1, 3, 7, 11, 59, 61, 1440]) {
    for (const level of [1, 10, 18, 20]) {
      const exact = level * 5 * budget * 600 // level x 5% of the budget in ms
      assert.equal(timeBudgetNotice(budget, exact, level - 1)?.level, level, `${level * 5}% of ${budget} minutes is the moment`)
      assert.equal(timeBudgetNotice(budget, exact - 1, level - 1), null, 'a millisecond before it is not')
    }
  }
})

test('a step that finds several moments crossed is told once, the latest', () => {
  // A first step that comes late (the brief was read after the turn began) or one long step.
  const late = told(60, [48, 49, 54])
  assert.deepEqual(late.map((line) => [line.at, line.level]), [[48, 16], [54, 18]], 'at 80% the 80% line only, then 90%; the moments between are not told')
  assert.match(late[0].text, /已用 48 分钟，剩余 12 分钟/)
  const jump = told(60, [0, 59])
  assert.deepEqual(jump.map((line) => [line.at, line.level]), [[0, 0], [59, 19]])
  assert.match(jump[1].text, /已用 59 分钟，剩余 1 分钟/)
})

test('past the budget the remaining time is zero and it is never negative', () => {
  assert.match(timeBudgetNotice(10, 25 * MINUTE, -1)?.text ?? '', /已用 25 分钟，剩余 0 分钟/)
})

test('no budget, no sentence; a clock that is wrong says nothing odd', () => {
  for (const budget of [0, -1, Number.NaN, undefined, null]) {
    assert.equal(timeBudgetNotice(/** @type {any} */ (budget), 30 * MINUTE, -1), null, `budget ${String(budget)}`)
  }
  assert.equal(timeBudgetNotice(60, -5 * MINUTE, -1)?.text.includes('已用 0 分钟'), true, 'a clock that ran backwards is the start')
  assert.equal(timeBudgetNotice(60, Number.NaN, -1)?.text.includes('已用 0 分钟'), true)
})

test('a budget is a whole number of minutes from 1 to 1440, and anything else is no budget', () => {
  assert.deepEqual({ ...RUN_TIME_BUDGET_MINUTES }, { min: 1, max: 1440 })
  for (const good of [1, 60, 1440]) assert.equal(runTimeBudgetMinutes(good), good)
  for (const bad of [0, -1, 1441, 1.5, '60', null, undefined, Number.NaN, Infinity, true, [60], {}]) assert.equal(runTimeBudgetMinutes(bad), 0, String(bad))
})
