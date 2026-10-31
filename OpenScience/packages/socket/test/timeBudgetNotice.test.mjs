// The clock a turn with a wall-clock budget is told (`timeBudgetNotice`): which moments, and what the sentence says. Pure, so the
// moments are asserted on numbers and no clock at all; that the plugin reaches them, once per turn, and says nothing without a budget is
// `consistency.test.mjs`'s ("the wall-clock budget").
import assert from 'node:assert/strict'
import test from 'node:test'

import { RUN_TIME_BUDGET_MINUTES, runTimeBudgetMinutes } from '@evimed/domain'

import { TIME_BUDGET_NOTICE_PERCENTS, timeBudgetNotice } from '../src/runPolicy.mjs'

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

test('the moments are the first step and 50%, 75% and 90%', () => {
  assert.deepEqual([...TIME_BUDGET_NOTICE_PERCENTS], [0, 50, 75, 90])
  const lines = told(60, [0, 0, 10, 29, 30, 31, 44, 45, 46, 53, 54, 55, 59, 60, 90, 600])
  assert.deepEqual(lines.map((line) => [line.at, line.level]), [[0, 0], [30, 1], [45, 2], [54, 3]], 'four lines, each once, and none once the last has been said')
})

test('the sentence names the budget, what is used, what is left, and that a complete deliverable should exist before the time is out', () => {
  assert.equal(timeBudgetNotice(60, 0, -1)?.text, '本轮时间预算 60 分钟，已用 0 分钟，剩余 60 分钟。时间用完之前，要有一份完整的可交付成果。')
  assert.equal(timeBudgetNotice(60, 30 * MINUTE, 0)?.text, '本轮时间预算 60 分钟，已用 30 分钟，剩余 30 分钟。时间用完之前，要有一份完整的可交付成果。')
  assert.equal(timeBudgetNotice(60, 54 * MINUTE, 2)?.text, '本轮时间预算 60 分钟，已用 54 分钟，剩余 6 分钟。时间用完之前，要有一份完整的可交付成果。')
  assert.equal(timeBudgetNotice(1, 0, -1)?.text, '本轮时间预算 1 分钟，已用 0 分钟，剩余 1 分钟。时间用完之前，要有一份完整的可交付成果。')
})

test('a boundary is exact, whatever the budget: the share is compared in whole percents', () => {
  for (const budget of [1, 3, 7, 11, 59, 61, 1440]) {
    for (const [percent, level] of [[50, 1], [75, 2], [90, 3]]) {
      const exact = percent * budget * 600 // percent% of the budget in ms: percent/100 * budget * 60000
      assert.equal(timeBudgetNotice(budget, exact, level - 1)?.level, level, `${percent}% of ${budget} minutes is the moment`)
      assert.equal(timeBudgetNotice(budget, exact - 1, level - 1), null, `a millisecond before it is not`)
    }
  }
})

test('a step that finds several moments crossed is told once, the latest, and the earlier ones are then said', () => {
  // A first step that comes late (the brief was read after the turn began) or one long step.
  const late = told(60, [48, 49, 54])
  assert.deepEqual(late.map((line) => [line.at, line.level]), [[48, 2], [54, 3]], 'at 80% the 75% line only, then 90%; the first-step and 50% lines are not said after it')
  assert.match(late[0].text, /已用 48 分钟，剩余 12 分钟/)
  const jump = told(60, [0, 59])
  assert.deepEqual(jump.map((line) => [line.at, line.level]), [[0, 0], [59, 3]])
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
