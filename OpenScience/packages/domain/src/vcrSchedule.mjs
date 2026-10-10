/**
 * A protocol's schedule of activities (SoA): the exact operations the platform does on it.
 *
 * A schedule is the visits a protocol plans — each with the day it falls on, the window around that day and what is done at it.
 * What it adds up to, which of its visits a virtual patient's trajectory may take as times and how a day and a window read are
 * counted and converted here, by code, so that no run types a converted number (principle 1: the language is the model's, the
 * arithmetic is not). The words — which visit, which assessment — are the run's or the researcher's.
 *
 * @module @evimed/domain/vcrSchedule
 */

import { VCR_HORIZON_UNIT_DAYS } from './vcrModelInterfaces.mjs'

/**
 * How big a schedule may be and how long its words may run. These bound what one study's rows and one page table hold; a protocol's
 * schedule is dozens of visits, and the engine's trajectory takes at most {@link VCR_SOA_TRAJECTORY_MAX_VISITS} of them as times.
 */
export const VCR_SOA_LIMITS = Object.freeze({
  visits: 80, activitiesPerVisit: 80, visitName: 80, activityName: 120, note: 300, day: 36_500, windowDays: 3_650,
})

/** The most visit times the longitudinal virtual-patient generator takes (its scenario's `visits`). */
export const VCR_SOA_TRAJECTORY_MAX_VISITS = 50

/** The units a schedule's days are converted to when a trajectory asks for its visit times: the platform's horizon units. */
export const VCR_SOA_TIME_UNITS = Object.freeze(Object.keys(VCR_HORIZON_UNIT_DAYS))

/** @typedef {{ name: string, note: string }} SoaActivity */
/** @typedef {{ visit: string, day: number | null, windowDays: number | null, note: string, procedures: readonly SoaActivity[] }} SoaVisit */

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : [])
/** @param {unknown} value @returns {value is number} */
const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * What a schedule adds up to: its visits, the distinct activities (one activity under two spellings of case is one), the entries
 * (an activity at a visit is one entry — the count of times a patient is asked for something) and the first and last day it reaches.
 * @param {readonly SoaVisit[]} visits
 * @returns {{ visits: number, activities: number, entries: number, firstDay: number | null, lastDay: number | null }}
 */
export function soaSummary(visits) {
  const rows = list(visits)
  const names = new Set()
  let entries = 0
  for (const row of rows) {
    for (const activity of list(row?.procedures)) {
      entries += 1
      names.add(String(activity?.name ?? '').trim().toLowerCase())
    }
  }
  const days = rows.map((row) => row?.day).filter(finite)
  return {
    visits: rows.length, activities: names.size, entries,
    firstDay: days.length ? Math.min(...days) : null, lastDay: days.length ? Math.max(...days) : null,
  }
}

/**
 * The visit times a longitudinal virtual-patient scenario takes (`visits`), read off a schedule: elapsed time from the baseline —
 * the first visit on or after day 0; a screening visit before it is not a time of the trajectory — in the unit asked, distinct and
 * increasing, rounded to four decimals. A protocol that counts from "Day 1" and one that counts from "Week 0" give the same times,
 * because they are differences from the baseline visit. Refused by name rather than guessed at: fewer than two visits to place, a
 * unit the platform has no days for, more visits than the generator takes, a unit so coarse that two visits would become one time.
 * @param {readonly SoaVisit[]} visits @param {string} unit one of {@link VCR_SOA_TIME_UNITS}
 * @returns {{ ok: true, unit: string, baselineDay: number, times: number[] } | { ok: false, reason: 'unit_unknown' | 'too_few_visits' | 'too_many_visits' | 'unit_too_coarse' }}
 */
export function soaVisitTimes(visits, unit) {
  if (!Object.hasOwn(VCR_HORIZON_UNIT_DAYS, unit)) return { ok: false, reason: 'unit_unknown' }
  const days = [...new Set(list(visits).map((row) => row?.day).filter((day) => finite(day) && day >= 0))].sort((a, b) => a - b)
  if (days.length < 2) return { ok: false, reason: 'too_few_visits' }
  if (days.length > VCR_SOA_TRAJECTORY_MAX_VISITS) return { ok: false, reason: 'too_many_visits' }
  const per = /** @type {Record<string, number>} */ (VCR_HORIZON_UNIT_DAYS)[unit]
  const baselineDay = days[0]
  const times = days.map((day) => Math.round(((day - baselineDay) / per) * 1e4) / 1e4)
  if (times.some((time, index) => index > 0 && time <= times[index - 1])) return { ok: false, reason: 'unit_too_coarse' }
  return { ok: true, unit, baselineDay, times }
}

/** A number as a person reads it in a table: no trailing zeros, no float noise. @param {number} value */
const plain = (value) => String(Math.round(value * 1e4) / 1e4)

/** The day a visit falls on, as a protocol's table prints it; a visit with no planned day (an end-of-treatment visit) is 「—」. @param {number | null | undefined} day */
export function soaDayText(day) {
  return finite(day) ? `第 ${plain(day)} 天` : '—'
}

/** The window around a visit's day, in days either side. @param {number | null | undefined} windowDays */
export function soaWindowText(windowDays) {
  return finite(windowDays) ? `±${plain(windowDays)} 天` : '—'
}
