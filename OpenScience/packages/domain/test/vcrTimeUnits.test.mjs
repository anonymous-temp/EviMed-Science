import assert from 'node:assert/strict'
import test from 'node:test'

import {
  VCR_DEFAULT_TIME_UNIT, VCR_HORIZON_UNIT_DAYS, VCR_TIME_UNITS,
  validateScenario, vcrCommonTimeUnit, vcrConvertTime, vcrScenarioRows, vcrTimeUnitOf, vcrTimeUnitPeriodsPerYear,
} from '../index.mjs'

test('one closed table of time units: the horizon table the model cards already use, and months when nothing is said (D1, E4)', () => {
  assert.deepEqual([...VCR_TIME_UNITS], Object.keys(VCR_HORIZON_UNIT_DAYS), 'the units are the keys of the one table, not a second list')
  assert.equal(VCR_DEFAULT_TIME_UNIT, 'months')
  assert.equal(Object.isFrozen(VCR_TIME_UNITS), true)
})

test('a source writes a unit many ways; the closed spellings read as the four units and anything else as none', () => {
  for (const [spelling, unit] of /** @type {[string, string][]} */ ([
    ['Months', 'months'], ['month', 'months'], [' months ', 'months'], ['mo', 'months'], ['个月', 'months'], ['月', 'months'], ['MONTHS', 'months'],
    ['Weeks', 'weeks'], ['week', 'weeks'], ['wk', 'weeks'], ['周', 'weeks'],
    ['Years', 'years'], ['year', 'years'], ['yr', 'years'], ['年', 'years'],
    ['Days', 'days'], ['day', 'days'], ['天', 'days'], ['日', 'days'],
  ])) assert.equal(vcrTimeUnitOf(spelling), unit, spelling)
  for (const other of ['', '   ', null, undefined, 'cycles', 'visits', 'months (median)', '%', 'm', 'kg', 'time units', 42]) assert.equal(vcrTimeUnitOf(other), null, String(other))
})

test('a time is converted through the days each unit stands for, and a unit outside the table converts nothing', () => {
  assert.equal(vcrConvertTime(12, 'months', 'months'), 12)
  assert.equal(vcrConvertTime(1, 'years', 'months'), 12, 'a year is 365.25 days and a month 30.4375: twelve months exactly')
  assert.equal(vcrConvertTime(52, 'weeks', 'days'), 364)
  assert.ok(Math.abs(/** @type {number} */ (vcrConvertTime(52, 'weeks', 'months')) - 11.9589) < 1e-3)
  assert.ok(Math.abs(/** @type {number} */ (vcrConvertTime(6, 'months', 'years')) - 0.5) < 1e-12)
  assert.equal(vcrConvertTime(3, 'fortnights', 'months'), null)
  assert.equal(vcrConvertTime(3, 'months', 'quarters'), null)
  assert.equal(vcrConvertTime(Number.NaN, 'months', 'years'), null)
  assert.equal(vcrConvertTime(null, 'months', 'years'), null)
})

test('the periods in a year are what a "per year" proportion is spread over', () => {
  assert.equal(vcrTimeUnitPeriodsPerYear('months'), 12)
  assert.equal(vcrTimeUnitPeriodsPerYear('years'), 1)
  assert.equal(vcrTimeUnitPeriodsPerYear('days'), 365.25)
  assert.ok(Math.abs(/** @type {number} */ (vcrTimeUnitPeriodsPerYear('weeks')) - 365.25 / 7) < 1e-12)
  assert.equal(vcrTimeUnitPeriodsPerYear('quarters'), null)
})

test('evidence in several units agrees on one only when every one that names a unit names the same', () => {
  assert.deepEqual(vcrCommonTimeUnit(['Weeks', 'weeks', 'week']), { unit: 'weeks', agree: true, named: 3 })
  assert.deepEqual(vcrCommonTimeUnit(['weeks', 'months']), { unit: null, agree: false, named: 2 }, 'two units are no unit')
  assert.deepEqual(vcrCommonTimeUnit(['weeks', '', null, 'weeks']), { unit: 'weeks', agree: true, named: 2 }, 'a card that names none disagrees with nobody')
  assert.deepEqual(vcrCommonTimeUnit(['weeks', 'cycles']), { unit: null, agree: false, named: 2 }, 'a unit outside the table is not agreement')
  assert.deepEqual(vcrCommonTimeUnit([]), { unit: null, agree: false, named: 0 })
  assert.deepEqual(vcrCommonTimeUnit(['', null]), { unit: null, agree: false, named: 0 })
})

test('a time-to-event scenario states its unit from the one table, and months when it says nothing (E4, OI-1)', () => {
  const simulate = (/** @type {Record<string, any>} */ extra = {}) => ({ design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'time_to_event' },
    truth: { hazardRatio: 0.7, controlMedian: 1 }, analysis: { method: 'logrank', alpha: 0.025, sided: 1 }, accrual: { duration: 2, followup: 1, dropoutAnnual: 0.1 }, ...extra });
  const analytic = (/** @type {Record<string, any>} */ extra = {}) => ({ design: { kind: 'two_arm_fixed' }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 1 },
    analysis: { alpha: 0.025, power: 0.9, sided: 1 }, accrual: { duration: 2, followup: 1, dropoutAnnual: 0.1 }, ...extra });
  const patients = (/** @type {Record<string, any>} */ extra = {}) => ({ design: { nTreat: 50, nControl: 50 }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 1 }, ...extra });
  for (const [method, build] of /** @type {[string, (extra?: object) => object][]} */ ([['design.simulate', simulate], ['design.analytic', analytic], ['patients.time_to_event', patients]])) {
    assert.deepEqual(validateScenario(method, build()), [], `${method}: no unit is months, as it always was`);
    for (const unit of VCR_TIME_UNITS) assert.deepEqual(validateScenario(method, build({ timeUnit: unit })), [], `${method}: ${unit}`);
    const refused = validateScenario(method, build({ timeUnit: 'fortnights' }));
    assert.ok(refused.some((issue) => issue.field.endsWith('timeUnit')), `${method}: a unit outside the table is refused by name: ${JSON.stringify(refused)}`);
  }
  // The grid takes it once, for every cell it runs.
  const grid = { ...simulate({ timeUnit: 'years' }), designs: [{ kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }], truths: [{ hazardRatio: 0.7, controlMedian: 1 }] };
  assert.deepEqual(validateScenario('design.grid', grid), []);
  // It means something only for a time-to-event endpoint: another endpoint has no time to state the unit of.
  const binary = { ...simulate(), endpoint: { type: 'binary' }, truth: { controlRate: 0.3, treatmentRate: 0.2 }, analysis: { method: 'risk_difference', alpha: 0.025, sided: 1 }, accrual: undefined };
  delete binary.accrual;
  assert.ok(validateScenario('design.simulate', { ...binary, timeUnit: 'years' }).some((issue) => issue.field.endsWith('timeUnit')));
});

test('what the help says of the unit: one key, the four units, months by default, and the dropout is a proportion per year', () => {
  const rows = vcrScenarioRows('design.simulate').rows
  const unit = rows.find((row) => row.path === 'timeUnit')
  assert.ok(unit, 'the help names the key')
  assert.deepEqual(unit.values, [...VCR_TIME_UNITS])
  assert.equal(unit.default, 'months')
  assert.equal(rows.find((row) => row.path === 'accrual.dropoutAnnual')?.unit, 'proportion per year')
});
