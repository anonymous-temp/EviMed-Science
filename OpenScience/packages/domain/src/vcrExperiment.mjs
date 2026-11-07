/**
 * The immutable experiment version: what a researcher asked, frozen, and the identity of it.
 *
 * Hidden knowledge:
 *
 * - **An identity is the canonical bytes of what was frozen.** The record holds the question, the population and model
 *   references (id and version), the arms, the action times, the observation schedule, the endpoints, the horizon, the analysis,
 *   the seeds, the budget, the source bindings and the purpose; its `experimentHash` is the sha256 of the canonical JSON (the
 *   engine's `canonicalScenarioJson`: sorted keys, no `undefined`). Key order never changes it; a seed, an action time or a
 *   model version always does.
 * - **`predictionMode` is the applicability check's `request.mode`**, one of `VCR_PREDICTION_MODES`; they are not two settings.
 * - **This package cannot hash** (it is browser-safe), so it returns the canonical bytes and the caller hashes them, the way
 *   `vcrResultOutputPayload` does. A record is a value: nothing here is stored.
 *
 * @module @evimed/domain/vcrExperiment
 */

import { canonicalScenarioJson } from './vcrEngineJob.mjs'
import { VCR_PREDICTION_MODES } from './vcrModelUse.mjs'

/** The fields a version freezes, in the order the record is written. */
export const VCR_EXPERIMENT_FIELDS = Object.freeze([
  'question', 'populationRef', 'modelRef', 'predictionMode', 'arms', 'actionTimes', 'observationSchedule', 'endpoints', 'horizon',
  'analysis', 'seeds', 'budget', 'sourceBindings', 'purpose',
])

/** @param {unknown} value */
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {})

/**
 * The frozen record of an experiment version: only the known fields, each as given (`null` when absent), plus the schema version.
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
export function vcrExperimentRecord(input) {
  const source = object(input)
  /** @type {Record<string, any>} */
  const record = { schemaVersion: 1 }
  for (const field of VCR_EXPERIMENT_FIELDS) record[field] = source[field] ?? null
  return record
}

/**
 * What is wrong with a record as a frozen question: a mode outside the vocabulary, a reference without an id and a version.
 * @param {Record<string, any>} record
 * @returns {Array<{ code: string, field: string }>}
 */
export function vcrExperimentIssues(record) {
  const issues = []
  if (!VCR_PREDICTION_MODES.includes(record?.predictionMode)) issues.push({ code: 'prediction_mode_unknown', field: 'predictionMode' })
  for (const field of ['populationRef', 'modelRef']) {
    const ref = object(record?.[field])
    if (record?.[field] != null && !(typeof ref.id === 'string' && ref.id && ref.version != null && ref.version !== '')) {
      issues.push({ code: 'reference_incomplete', field })
    }
  }
  return issues
}

/**
 * The canonical bytes an experiment version's hash is the sha256 of.
 * @param {Record<string, any>} input
 * @returns {string}
 */
export function vcrExperimentCanonical(input) {
  return canonicalScenarioJson(vcrExperimentRecord(input))
}
