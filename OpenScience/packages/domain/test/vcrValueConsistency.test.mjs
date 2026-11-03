/**
 * `extractedValueConsistency` (algorithm round E2). Every case has two sides: numbers a paper prints with its own rounding, which must pass in
 * silence, and a real contradiction, which must be named with its numbers. The printed examples are the ones the checks were written
 * against, worked by hand in the comments.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { extractedValueConsistency, printedHalfUnit } from '../index.mjs'

/** @typedef {import('../src/vcrValueConsistency.mjs').ExtractedValue} ExtractedValue */
/** @param {Record<string, any>} fields @returns {ExtractedValue} */
const ratio = (fields) => ({ id: 'h', label: '风险比', scale: 'log', nullValue: 1, ...fields })

test('printed rounding passes: the half unit of the last printed place is the whole tolerance', () => {
  assert.equal(printedHalfUnit(0.62), 0.005)
  assert.equal(printedHalfUnit(12), 0.5)
  assert.equal(printedHalfUnit(0.124), 0.0005)
  assert.equal(printedHalfUnit(1e-7), 5e-8)
  // HR 0.62 (0.48 to 0.80): the geometric midpoint is exp((ln 0.48 + ln 0.80)/2) = 0.6197, inside 0.615 to 0.625.
  assert.deepEqual(extractedValueConsistency([ratio({ value: 0.62, ciLow: 0.48, ciHigh: 0.8 })]), [])
  // HR 0.75 (0.60 to 0.94): midpoint 0.7510, a rounding away. 1.10 (0.87 to 1.39): 1.0996.
  assert.deepEqual(extractedValueConsistency([ratio({ value: 0.75, ciLow: 0.6, ciHigh: 0.94 }), ratio({ id: 'g', value: 1.1, ciLow: 0.87, ciHigh: 1.39 })]), [])
  // A difference is symmetric on the plain scale: 4.2 (1.1 to 7.3) has the midpoint 4.2.
  assert.deepEqual(extractedValueConsistency([{ id: 'd', label: '均值差', scale: 'identity', nullValue: 0, value: 4.2, ciLow: 1.1, ciHigh: 7.3 }]), [])
})

test('an interval that is not symmetric on the log scale is named with the midpoint and the range the rounding allows', () => {
  // HR 0.62 (0.48 to 0.95): the midpoint is exp((ln 0.48 + ln 0.95)/2) = 0.675; 0.62 is far outside 0.67 to 0.68.
  const [finding, ...rest] = extractedValueConsistency([ratio({ value: 0.62, ciLow: 0.48, ciHigh: 0.95 })])
  assert.equal(rest.length, 0)
  assert.equal(finding.code, 'interval_not_symmetric')
  assert.deepEqual(finding.ids, ['h'])
  assert.ok(Math.abs(Number(finding.numbers.midpoint) - 0.6753) < 1e-3)
  assert.match(finding.message, /风险比：估计值 0\.62、区间 0\.48–0\.95/)
  assert.match(finding.message, /几何中点是 0\.675/)
  // The same on the plain scale: 4.2 (1.1 to 9.3) has the midpoint 5.2.
  const [plain] = extractedValueConsistency([{ id: 'd', label: '均值差', scale: 'identity', value: 4.2, ciLow: 1.1, ciHigh: 9.3 }])
  assert.equal(plain.code, 'interval_not_symmetric')
  assert.match(plain.message, /算术中点是 5\.2/)
})

test('a quantity whose interval is not Wald-shaped is held to containing its estimate and nothing more', () => {
  // A proportion's Wilson interval is lopsided by design: 0.12 (0.07 to 0.19) is fine; 0.30 (0.07 to 0.19) is not.
  assert.deepEqual(extractedValueConsistency([{ id: 'r', label: '事件率', value: 0.12, ciLow: 0.07, ciHigh: 0.19 }]), [])
  const [outside] = extractedValueConsistency([{ id: 'r', label: '事件率', value: 0.3, ciLow: 0.07, ciHigh: 0.19 }])
  assert.equal(outside.code, 'value_outside_interval')
  // An estimate that equals a printed limit after rounding is inside: 1.00 (1.00 to 1.50) on a ratio.
  assert.deepEqual(extractedValueConsistency([ratio({ value: 1.0, ciLow: 1.0, ciHigh: 1.5, scale: null })]), [])
  const [reversed] = extractedValueConsistency([{ id: 'x', value: 0.5, ciLow: 0.9, ciHigh: 0.2 }])
  assert.equal(reversed.code, 'interval_reversed')
})

test('a ratio that is not positive is named and not run through the log', () => {
  const [bad] = extractedValueConsistency([ratio({ value: -0.4, ciLow: 0.2, ciHigh: 0.9 })])
  assert.equal(bad.code, 'ratio_not_positive')
  assert.match(bad.message, /估计值 -0\.4/)
})

test('a p-value is held to the interval by verdict: it may differ slightly, it may not point the other way', () => {
  // HR 0.62 (0.48 to 0.80), p < 0.001: the interval excludes 1 and p is far below any level.
  assert.deepEqual(extractedValueConsistency([ratio({ value: 0.62, ciLow: 0.48, ciHigh: 0.8, pValue: 0.001, pRelation: '<' })]), [])
  // HR 0.80 (0.64 to 1.00), p = 0.05 (log-rank against a Cox interval): the limit 1.00 is a rounding away from the null, nothing to say.
  assert.deepEqual(extractedValueConsistency([ratio({ value: 0.8, ciLow: 0.64, ciHigh: 1.0, pValue: 0.05 })]), [])
  // HR 0.82 (0.62 to 1.09) against p = 0.0004: the interval holds 1 and p is below every level.
  const [insignificantInterval] = extractedValueConsistency([ratio({ value: 0.82, ciLow: 0.62, ciHigh: 1.09, pValue: 0.0004 })])
  assert.equal(insignificantInterval.code, 'p_contradicts_interval')
  assert.match(insignificantInterval.message, /区间 0\.62–1\.09包含 1（不显著）/)
  assert.match(insignificantInterval.message, /p = 0\.0004/)
  // HR 0.62 (0.48 to 0.80) against p = 0.40: the interval excludes 1 by a mile and p is above every level.
  const [significantInterval] = extractedValueConsistency([ratio({ value: 0.62, ciLow: 0.48, ciHigh: 0.8, pValue: 0.4 })])
  assert.equal(significantInterval.code, 'p_contradicts_interval')
  assert.match(significantInterval.message, /不包含 1（显著）/)
  assert.match(significantInterval.message, /没有达到常用的显著性水平/)
})

test('the interval\'s level, when stated, decides; when it is not, every level has to disagree', () => {
  // A 90% interval 0.70 to 0.97 with p = 0.07: significant at 0.10, not at 0.05. Level unknown: no finding.
  assert.deepEqual(extractedValueConsistency([ratio({ value: 0.82, ciLow: 0.7, ciHigh: 0.97, pValue: 0.07 })]), [])
  // With the level stated as 95% the interval excludes 1 and p = 0.07 is not significant: the two disagree.
  const [stated] = extractedValueConsistency([ratio({ value: 0.82, ciLow: 0.7, ciHigh: 0.97, pValue: 0.07, ciLevel: 0.95 })])
  assert.equal(stated.code, 'p_contradicts_interval')
  assert.match(stated.message, /没有达到95% 的显著性水平/)
  // A printed bound touches the level: p < 0.05 with a 95% interval holding 1 is a contradiction; p = 0.05 itself is not.
  assert.equal(extractedValueConsistency([ratio({ value: 0.85, ciLow: 0.7, ciHigh: 1.03, pValue: 0.05, pRelation: '<', ciLevel: 0.95 })])[0].code, 'p_contradicts_interval')
  assert.deepEqual(extractedValueConsistency([ratio({ value: 0.85, ciLow: 0.7, ciHigh: 1.03, pValue: 0.05, ciLevel: 0.95 })]), [])
  // A quantity with no null (a mean) is not asked about its p.
  assert.deepEqual(extractedValueConsistency([{ id: 'm', value: 4.2, ciLow: 1.1, ciHigh: 7.3, scale: 'identity', pValue: 0.9 }]), [])
})

test('events against the rate and the sample size, in either spelling of the rate', () => {
  // 31 of 250 is 12.4%: stored as 12.4 with a percent unit, as 0.124, or as 12.4 with no unit.
  for (const row of [{ value: 12.4, unit: '%' }, { value: 0.124, unit: '' }, { value: 12.4, unit: 'percent' }, { value: 12.4 }]) {
    assert.deepEqual(extractedValueConsistency([{ id: 'e', label: '事件率', rate: true, events: 31, sampleSize: 250, ...row }]), [], JSON.stringify(row))
  }
  // Printed to the unit: 31/250 = 12.4%, written 12%: inside the half unit of 12. 13% is not.
  assert.deepEqual(extractedValueConsistency([{ id: 'e', rate: true, events: 31, sampleSize: 250, value: 12, unit: '%' }]), [])
  const [mismatch] = extractedValueConsistency([{ id: 'e', label: '事件率', rate: true, events: 31, sampleSize: 250, value: 21.4, unit: '%' }])
  assert.equal(mismatch.code, 'events_rate_mismatch')
  assert.match(mismatch.message, /31 例 \/ 250 人是 12\.4%，与写出的 21\.4% 对不上/)
  const [over] = extractedValueConsistency([{ id: 'e', label: '事件率', rate: true, events: 300, sampleSize: 250, value: 12.4, unit: '%' }])
  assert.equal(over.code, 'events_exceed_n')
  assert.match(over.message, /事件数 300 多于样本量 250/)
  // A value that is not a rate (a median) is not held to its counts, and a row without counts has nothing to compare.
  assert.deepEqual(extractedValueConsistency([{ id: 'x', value: 14.2, events: 31, sampleSize: 250 }, { id: 'y', rate: true, value: 12.4 }]), [])
})

test('the arms of a comparison may add up to less than the total, never to more; a plan is not a total', () => {
  const arm = (/** @type {string} */ id, /** @type {string} */ role, /** @type {string} */ name, /** @type {number} */ n, /** @type {string} */ set = 'os') =>
    ({ id, trial: 'NCT1', set, armRole: role, arm: name, sampleSize: n })
  const total = { id: 't', trial: 'NCT1', armRole: 'overall', sampleSize: 500 }
  assert.deepEqual(extractedValueConsistency([total, arm('a', 'control', 'Placebo', 250), arm('b', 'treatment', 'Drug', 250)]), [])
  assert.deepEqual(extractedValueConsistency([total, arm('a', 'control', 'Placebo', 240), arm('b', 'treatment', 'Drug', 230)]), [])
  const [over] = extractedValueConsistency([total, arm('a', 'control', 'Placebo', 260), arm('b', 'treatment', 'Drug', 250)])
  assert.equal(over.code, 'arms_exceed_total')
  assert.deepEqual(over.ids, ['a', 'b'])
  assert.match(over.message, /260 \+ 250 = 510，比同一试验写出的总人数 500 还多/)
  // Planned enrolment of 400 is not a total; another trial's total is not this trial's.
  assert.deepEqual(extractedValueConsistency([{ ...total, planned: true, sampleSize: 400 }, arm('a', 'control', 'Placebo', 260), arm('b', 'treatment', 'Drug', 250)]), [])
  assert.deepEqual(extractedValueConsistency([{ ...total, trial: 'NCT2' }, arm('a', 'control', 'Placebo', 260), arm('b', 'treatment', 'Drug', 250)]), [])
  // One arm of a set repeated (two categories of one outcome) is one arm; the sets are summed apart.
  assert.deepEqual(extractedValueConsistency([total, arm('a', 'control', 'Placebo', 250), arm('a2', 'control', 'Placebo', 250), arm('b', 'treatment', 'Drug', 250),
    arm('c', 'control', 'Placebo', 240, 'pfs'), arm('d', 'treatment', 'Drug', 235, 'pfs')]), [])
})

test('the function is deterministic, tolerates rows with nothing to check, and does not touch its input', () => {
  const rows = Object.freeze([Object.freeze(ratio({ value: 0.62, ciLow: 0.48, ciHigh: 0.95 })), Object.freeze({ id: 'n' }), null, 'x'])
  // @ts-expect-error a frozen list with junk in it is the point
  const first = extractedValueConsistency(rows)
  // @ts-expect-error
  assert.deepEqual(extractedValueConsistency(rows), first)
  assert.equal(first.length, 1)
  assert.deepEqual(extractedValueConsistency([]), [])
  // @ts-expect-error not a list
  assert.deepEqual(extractedValueConsistency(null), [])
})
