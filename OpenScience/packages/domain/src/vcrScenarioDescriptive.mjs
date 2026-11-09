/**
 * Scenario keys that describe what the engine does anyway.
 *
 * A key the engine does not read is refused, because an ignored parameter is a silent change of the computation
 * (`vcrScenarioSchemas.mjs`: `dropoutAnual` must keep failing). Two kinds of key are not that, and on 2026-11-01 a design comparison
 * paid several refused calls for each of them:
 *
 * - **A key that names what the method already is.** `design.analytic` sizes a time-to-event design with the log-rank test and spreads
 *   accrual evenly; `analysis.method: "logrank"` and `accrual.kind: "uniform"` say so and change nothing. They are harmless only when
 *   their value agrees with what the engine does: `analysis.method: "maxcombo"` on `design.analytic` asks for a computation it does not
 *   make, so it stays refused, with the sentence that says why.
 * - **A word for a person to read.** The entries of a grid's `designs[]` and `truths[]` carry the `label` a page shows them by; the
 *   engine reads none of it.
 *
 * Both lists are closed, per method, and are data. They are removed from the scenario before it is validated, hashed and frozen (so
 * the same request is the same job with or without them), and the call says what it did. Nothing else is ever dropped.
 *
 * @module @evimed/domain/vcrScenarioDescriptive
 */

import { whenHolds } from './vcrScenarioSchemas.mjs'
import { vcrDeriveAccrualDuration } from './vcrAccrualRate.mjs'

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const TWO_ARM_TIME_TO_EVENT = Object.freeze([
  Object.freeze({ path: 'endpoint.type', in: Object.freeze(['time_to_event']) }),
  Object.freeze({ path: 'design.kind', in: Object.freeze(['two_arm_fixed', 'group_sequential']) }),
])

/**
 * The keys a method's scenario may carry as a description, and the value at which each is harmless. `when` is the schema language's
 * own condition: the key is only descriptive where it holds.
 * @type {Readonly<Record<string, ReadonlyArray<{ path: string, equals: string, when: readonly any[], says: string }>>>}
 */
export const VCR_DESCRIPTIVE_SCENARIO_KEYS = Object.freeze({
  'design.analytic': Object.freeze([
    Object.freeze({ path: 'analysis.method', equals: 'logrank', when: TWO_ARM_TIME_TO_EVENT,
      says: 'design_analytic sizes a time-to-event design with the log-rank test; for another analysis use design_simulation' }),
    Object.freeze({ path: 'accrual.kind', equals: 'uniform', when: TWO_ARM_TIME_TO_EVENT,
      says: 'design_analytic spreads accrual evenly over accrual.duration' }),
  ]),
})

/** The lists of a method's scenario whose entries may carry a `label` for display. @type {Readonly<Record<string, readonly string[]>>} */
export const VCR_LABELLED_SCENARIO_LISTS = Object.freeze({
  'design.grid': Object.freeze(['designs', 'truths']),
})

/**
 * @typedef {{ field: string, value: unknown, took: string }} VcrNormalizedKey
 *   `took`: what the platform did with the key, in a sentence the run can pass on
 */

/**
 * The scenario without its descriptive keys, what was left out, and the descriptive keys that disagree with the engine.
 *
 * @param {string} method @param {unknown} scenario
 * @returns {{ scenario: any, applied: VcrNormalizedKey[], conflicts: Array<{ field: string, value: unknown, detail: string }> }}
 */
export function vcrNormalizeScenarioKeys(method, scenario) {
  /** @type {VcrNormalizedKey[]} */
  const applied = []
  /** @type {Array<{ field: string, value: unknown, detail: string }>} */
  const conflicts = []
  if (!isObject(scenario)) return { scenario, applied, conflicts }
  let out = scenario
  for (const rule of VCR_DESCRIPTIVE_SCENARIO_KEYS[method] ?? []) {
    const [outer, key] = rule.path.split('.')
    const block = out[outer]
    if (!isObject(block) || !Object.hasOwn(block, key)) continue
    if (!whenHolds(rule.when, scenario)) continue
    if (block[key] === rule.equals) {
      const { [key]: _described, ...rest } = block
      out = { ...out, [outer]: rest }
      applied.push({ field: rule.path, value: block[key], took: `left out: ${rule.says}; it changes nothing` })
    } else {
      conflicts.push({ field: `scenario.${rule.path}`, value: block[key],
        detail: `${rule.says}, so ${rule.path} is not a choice here (you wrote ${JSON.stringify(String(block[key]).slice(0, 40))}).` })
    }
  }
  for (const listKey of VCR_LABELLED_SCENARIO_LISTS[method] ?? []) {
    const entries = out[listKey]
    if (!Array.isArray(entries) || !entries.some((entry) => isObject(entry) && typeof entry.label === 'string')) continue
    out = { ...out, [listKey]: entries.map((entry) => {
      if (!isObject(entry) || typeof entry.label !== 'string') return entry
      const { label: _label, ...rest } = entry
      return rest
    }) }
    applied.push({ field: `${listKey}[].label`, value: entries.filter((entry) => isObject(entry) && typeof entry.label === 'string').map((entry) => entry.label),
      took: 'left out: a label is for the page that shows the entry; the engine reads none of it' })
  }
  // an accrual stated by its rate gets its duration here, by code (`vcrAccrualRate.mjs`)
  const rated = vcrDeriveAccrualDuration(method, out)
  return { scenario: rated.scenario, applied: [...applied, ...rated.applied], conflicts: [...conflicts, ...rated.conflicts] }
}
