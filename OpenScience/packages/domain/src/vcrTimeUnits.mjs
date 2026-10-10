/**
 * The one closed table of time units 「虚拟临床研究」 reads and writes: the days each stands for (the table the model cards'
 * horizons already use), the spellings a registry, a card or a run writes them in, and the conversions between them.
 *
 * Hidden knowledge:
 *
 * - **Months is what nothing says.** A scenario that states no unit, a card that names none, evidence that disagrees: the unit is
 *   months, the unit the engine's dropout period (12 per year), its `_months` measures and the registry's own parameter names
 *   (`median_survival_months`) always assumed. Defaulting is never a refusal: the job goes on, and its result says the unit was
 *   assumed (`diagnostics.timeUnit.basis`).
 * - **A unit outside the table converts nothing.** `weeks`, `Weeks` and `周` are one unit; `cycles`, `visits` and `time units` are
 *   none, and a value in them is taken as written (and said to be) — never guessed into months, never dropped for it.
 * - **Evidence agrees only when every card that names a unit names the same one.** A card that names none disagrees with nobody;
 *   a card whose unit is outside the table is not agreement.
 *
 * @module @evimed/domain/vcrTimeUnits
 */

import { VCR_HORIZON_UNIT_DAYS } from './vcrModelInterfaces.mjs'

/** The units a time is stated in: the keys of the horizon table, so there is one list. */
export const VCR_TIME_UNITS = Object.freeze(Object.keys(VCR_HORIZON_UNIT_DAYS))
/** The unit nothing says. */
export const VCR_DEFAULT_TIME_UNIT = 'months'

/** Every spelling of each unit, lower case. */
const SPELLINGS = Object.freeze(/** @type {Record<string, readonly string[]>} */ ({
  days: ['day', 'days', 'd', '天', '日'],
  weeks: ['week', 'weeks', 'wk', 'wks', 'w', '周', '星期'],
  months: ['month', 'months', 'mo', 'mos', 'mth', 'mths', '月', '个月'],
  years: ['year', 'years', 'yr', 'yrs', 'y', '年'],
}))
/** @type {Map<string, string>} */
const UNIT_OF_SPELLING = new Map(Object.entries(SPELLINGS).flatMap(([unit, spellings]) => spellings.map((spelling) => [spelling, unit])))

/**
 * The unit a text names, or null: the closed spellings only, whatever their case and the space around them.
 * @param {unknown} text @returns {string | null}
 */
export function vcrTimeUnitOf(text) {
  if (typeof text !== 'string') return null
  return UNIT_OF_SPELLING.get(text.trim().toLowerCase()) ?? null
}

/**
 * A time converted from one unit to another through the days each stands for; null when either unit is outside the table or the
 * value is not a finite number.
 * @param {unknown} value @param {string} from @param {string} to @returns {number | null}
 */
export function vcrConvertTime(value, from, to) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const days = /** @type {Record<string, number>} */ (VCR_HORIZON_UNIT_DAYS)
  if (!Object.hasOwn(days, from) || !Object.hasOwn(days, to)) return null
  return value * days[from] / days[to]
}

/**
 * How many of a unit are in a year: what a proportion lost "per year" is spread over. Null for a unit outside the table.
 * @param {string} unit @returns {number | null}
 */
export function vcrTimeUnitPeriodsPerYear(unit) {
  const days = /** @type {Record<string, number>} */ (VCR_HORIZON_UNIT_DAYS)
  return Object.hasOwn(days, unit) ? 365.25 / days[unit] : null
}

/**
 * Whether the units that evidence names agree on one. `named` counts the ones that name something (a unit outside the table
 * included); one that names nothing is not counted and disagrees with nobody.
 * @param {readonly unknown[]} units
 * @returns {{ unit: string | null, agree: boolean, named: number }}
 */
export function vcrCommonTimeUnit(units) {
  const named = (units ?? []).filter((unit) => typeof unit === 'string' && unit.trim() !== '')
  const read = new Set(named.map((unit) => vcrTimeUnitOf(unit)))
  const agree = named.length > 0 && read.size === 1 && !read.has(null)
  return { unit: agree ? /** @type {string} */ ([...read][0]) : null, agree, named: named.length }
}
