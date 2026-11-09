/**
 * An accrual stated by its rate: 「每月入组 20 人」 is a rate, not a duration.
 *
 * The schema's engine key is `accrual.duration` (how long people are enrolled). A person who says how many are enrolled per month used to
 * have the model divide the number of people by it and write the quotient: the number the person said never reached the scenario, and the
 * quotient read as an assumption (live D4, 2026-11-07). The rate is now accepted as stated (`accrual.rate`, with the unit it is stated in,
 * `accrual.rateUnit`, else the scenario's own time unit) and the duration is derived here, by code, before the scenario is validated,
 * hashed and frozen: duration = people / rate, in the scenario's time unit. The engine reads the duration and never the rate, so no
 * engine output moves; the rate stays in the frozen scenario so the page can say which number the duration came from.
 *
 * Hidden knowledge:
 *
 * - **Only a method whose scenario states the people can derive.** `design.simulate` states `design.nTreat` (and `nControl`, which
 *   defaults to the treatment arm); `design.analytic` and the confirmatory designs compute the people from the duration, so a duration
 *   derived from the people would be circular. Those refuse a rate by name with the reason, and keep every other key.
 * - **Both stated must agree.** A duration written beside a rate is kept when it is the rate's quotient (to rounding) and refused
 *   otherwise: one of the two would be silently ignored.
 *
 * @module @evimed/domain/vcrAccrualRate
 */

import { VCR_DEFAULT_TIME_UNIT, vcrConvertTime, vcrTimeUnitOf } from './vcrTimeUnits.mjs'

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The methods whose scenario states the number of people and whose accrual is the uniform one: where a rate can give the duration. */
const PEOPLE_FROM_DESIGN = new Set(['design.simulate'])

/**
 * The people a scenario enrols, as the engine counts them, or null when the scenario does not state them.
 * @param {string} method @param {Record<string, any>} scenario @returns {number | null}
 */
function statedPeople(method, scenario) {
  if (!PEOPLE_FROM_DESIGN.has(method)) return null
  const design = isObject(scenario.design) ? scenario.design : {}
  if (!['two_arm_fixed', 'group_sequential'].includes(String(design.kind))) return null
  const treat = design.nTreat
  if (!Number.isInteger(treat) || treat < 1) return null
  const control = design.nControl === undefined ? treat : design.nControl
  return Number.isInteger(control) && control >= 0 ? treat + control : null
}

/**
 * The scenario with its accrual duration derived from a stated rate, what was done, and a rate that cannot give one.
 *
 * @param {string} method @param {unknown} scenario
 * @returns {{ scenario: any, applied: Array<{ field: string, value: unknown, took: string }>, conflicts: Array<{ field: string, value: unknown, detail: string }> }}
 */
export function vcrDeriveAccrualDuration(method, scenario) {
  /** @type {Array<{ field: string, value: unknown, took: string }>} */
  const applied = []
  /** @type {Array<{ field: string, value: unknown, detail: string }>} */
  const conflicts = []
  if (!isObject(scenario) || !isObject(scenario.accrual) || !Object.hasOwn(scenario.accrual, 'rate')) return { scenario, applied, conflicts }
  const accrual = scenario.accrual
  const refuse = (/** @type {string} */ field, /** @type {unknown} */ value, /** @type {string} */ detail) => { conflicts.push({ field: `scenario.${field}`, value, detail }); return { scenario, applied, conflicts } }
  if (typeof accrual.rate !== 'number' || !Number.isFinite(accrual.rate) || accrual.rate <= 0) {
    return refuse('accrual.rate', accrual.rate, 'accrual.rate is the number of people enrolled per time unit and is above 0.')
  }
  const unit = vcrTimeUnitOf(scenario.timeUnit) ?? VCR_DEFAULT_TIME_UNIT
  const rateUnit = accrual.rateUnit === undefined ? unit : vcrTimeUnitOf(accrual.rateUnit)
  if (!rateUnit) return refuse('accrual.rateUnit', accrual.rateUnit, 'accrual.rateUnit is one of days, weeks, months, years: the time the rate is per.')
  const people = statedPeople(method, scenario)
  if (people === null) {
    return refuse('accrual.rate', accrual.rate, PEOPLE_FROM_DESIGN.has(method)
      ? 'A rate gives the duration only for a fixed two-arm or group-sequential design that states its sizes (design.nTreat): state them, or state accrual.duration instead.'
      : 'This method computes the number of people from the accrual duration, so a rate cannot give the duration: state accrual.duration, or size the design with design.simulate, which takes the people and the rate.')
  }
  const duration = vcrConvertTime(people / accrual.rate, rateUnit, unit)
  if (duration === null) return refuse('accrual.rateUnit', accrual.rateUnit, 'The rate\'s unit cannot be converted to the scenario\'s time unit.')
  if (accrual.duration !== undefined && accrual.duration !== null) {
    if (typeof accrual.duration === 'number' && Math.abs(accrual.duration - duration) <= 1e-6 * Math.max(1, duration)) return { scenario, applied, conflicts }
    return refuse('accrual.duration', accrual.duration,
      `accrual.duration is ${accrual.duration} but ${people} people at ${accrual.rate} per ${rateUnit} take ${Number(duration.toPrecision(6))} ${unit}: state the rate or the duration, not both.`)
  }
  applied.push({ field: 'accrual.duration', value: duration, took: `derived: ${people} people at ${accrual.rate} per ${rateUnit} take ${Number(duration.toPrecision(6))} ${unit}` })
  return { scenario: { ...scenario, accrual: { ...accrual, duration } }, applied, conflicts }
}
