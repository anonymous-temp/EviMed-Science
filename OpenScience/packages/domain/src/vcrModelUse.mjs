/**
 * Can this model be run for this question, and what must the reader be told about the answer? Two lists, never one verdict.
 *
 * Hidden knowledge:
 *
 * - **Execution and evidence are different decisions** (in silico plan section 6). `executionIssues` are the things that make
 *   one calculation impossible: no adapter or function behind the model, an intervention the model has no input for, an output it
 *   does not produce, parameters that are mathematically invalid, units that cannot be converted, an authorization that was lost,
 *   a declared runtime limit. `premises` are everything else the check found: the use was never validated, the population, the
 *   endpoint or the horizon lies outside what was validated, the validation had no independent data, the evidence has no
 *   provenance. A premise changes what the result may be called; it never stops the run.
 * - **Missing provenance is never validation.** A validation entry without an evidence reference does not count as one, so a model
 *   whose only record is an unsourced claim reads as `use_not_validated` and `provenance_missing`, not as validated.
 * - **A card from before these fields is not asked for them.** A pack that declares no `executable`, no `executableModes`, no
 *   `validation` list and no `limits` has nothing to fail and nothing to say: old cards keep their behaviour.
 * - **A conditional forecast is model-conditional, not causal.** The three modes are a closed vocabulary; the check gives a mode
 *   no causal meaning, and `intervention_comparison` needs an executable action input, not a validated one.
 * - **Pure and closed.** Units are converted only inside one dimension of a closed table (data, not language); nothing is read
 *   from a store and nothing is parsed from prose.
 *
 * @module @evimed/domain/vcrModelUse
 */

/** @param {readonly string[]} list */
const frozen = (list) => Object.freeze([...list])

/** The closed mode vocabulary; an experiment's `predictionMode` is the request's `mode`. */
export const VCR_PREDICTION_MODES = frozen(['factual_forecast', 'conditional_forecast', 'intervention_comparison'])

/** What makes one calculation impossible. */
export const VCR_EXECUTION_ISSUE_CODES = frozen([
  'adapter_unavailable', 'mode_unknown', 'mode_not_executable', 'intervention_input_unavailable', 'output_not_produced',
  'invalid_parameters', 'units_not_convertible', 'authorization_lost', 'runtime_limit_exceeded', 'runtime_unavailable',
])

/** What the reader is told about the answer, without stopping it. */
export const VCR_PREMISE_CODES = frozen([
  'use_not_validated', 'population_outside_validation', 'endpoint_outside_validation', 'horizon_beyond_validation',
  'no_independent_data', 'provenance_missing',
])

/** The dimensions units convert within (the factor is to the dimension's base unit). Two units of different dimensions never convert. */
export const VCR_UNIT_DIMENSIONS = Object.freeze({
  time: Object.freeze({ hours: 1, days: 24, weeks: 168, months: 730.5, years: 8766 }),
  mass: Object.freeze({ ng: 1e-9, ug: 1e-6, mg: 1e-3, g: 1, kg: 1e3 }),
  concentration: Object.freeze({ 'ng/mL': 1, 'ug/mL': 1e3, 'mg/L': 1e3, 'mg/mL': 1e6 }),
  dose_per_weight: Object.freeze({ 'ug/kg': 1e-3, 'mg/kg': 1 }),
})

/** @param {unknown} value */
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {})
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : [])
/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * Whether a unit converts to another: both are in one dimension of the closed table (or are the same string).
 * @param {string} from @param {string} to
 */
export function vcrUnitsConvertible(from, to) {
  if (!from || !to) return false
  if (from === to) return true
  return Object.values(VCR_UNIT_DIMENSIONS).some((dimension) => Object.hasOwn(dimension, from) && Object.hasOwn(dimension, to))
}

/**
 * @typedef {{ code: string, field: string, detail: string }} VcrUseFinding
 * @param {Record<string, any> | null | undefined} pack what a model declares (see the module header for the fields read)
 * @param {Record<string, any>} request `{ mode, population?, endpoint?, horizonHours?, outputs?, parameters?, units?, authorized?, subjects? }`
 * @returns {{ executionIssues: VcrUseFinding[], premises: VcrUseFinding[] }}
 */
export function assessModelUse(pack, request) {
  /** @type {VcrUseFinding[]} */ const executionIssues = []
  /** @type {VcrUseFinding[]} */ const premises = []
  const model = object(pack)
  const asked = object(request)
  const issue = (/** @type {string} */ code, /** @type {string} */ field, /** @type {string} */ detail) => executionIssues.push({ code, field, detail })
  const premise = (/** @type {string} */ code, /** @type {string} */ field, /** @type {string} */ detail) => premises.push({ code, field, detail })

  // --- execution -----------------------------------------------------------
  if (pack == null || model.executable === false) issue('adapter_unavailable', 'executable', 'no executable adapter or function stands behind this model')
  const mode = text(asked.mode)
  if (!VCR_PREDICTION_MODES.includes(mode)) {
    issue('mode_unknown', 'mode', `mode must be one of ${VCR_PREDICTION_MODES.join(', ')}`)
  } else if (Array.isArray(model.executableModes) && !model.executableModes.includes(mode)) {
    if (mode === 'intervention_comparison') issue('intervention_input_unavailable', 'mode', 'the model has no action input an intervention could be mapped to')
    else issue('mode_not_executable', 'mode', `the model cannot execute ${mode}`)
  }
  if (Array.isArray(model.outputs) && Array.isArray(asked.outputs)) {
    for (const output of asked.outputs.map(String)) {
      if (!model.outputs.map(String).includes(output)) issue('output_not_produced', `outputs.${output}`, `the model does not produce ${output}`)
    }
  }
  if (asked.horizonHours !== undefined && !(Number.isFinite(asked.horizonHours) && asked.horizonHours > 0)) {
    issue('invalid_parameters', 'horizonHours', 'a horizon is a positive finite time')
  }
  for (const parameter of list(asked.parameters).map(object)) {
    const value = parameter.value
    const bad = typeof value !== 'number' || !Number.isFinite(value)
      || (Number.isFinite(parameter.min) && value < parameter.min) || (Number.isFinite(parameter.max) && value > parameter.max)
    if (bad) issue('invalid_parameters', `parameters.${text(parameter.name) || '?'}`, 'the value is not finite or lies outside its mathematical bounds')
  }
  for (const unit of list(asked.units).map(object)) {
    if (!vcrUnitsConvertible(text(unit.from), text(unit.to))) {
      issue('units_not_convertible', `units.${text(unit.name) || '?'}`, `${text(unit.from) || '?'} cannot be converted to ${text(unit.to) || '?'}`)
    }
  }
  if (asked.authorized === false) issue('authorization_lost', 'authorization', 'access to the model, its source or the data was revoked')
  const limits = object(model.limits)
  if (Number.isFinite(limits.maxHorizonHours) && Number.isFinite(asked.horizonHours) && asked.horizonHours > limits.maxHorizonHours) {
    issue('runtime_limit_exceeded', 'horizonHours', `the runtime computes at most ${limits.maxHorizonHours} hours`)
  }
  if (Number.isFinite(limits.maxSubjects) && Number.isFinite(asked.subjects) && asked.subjects > limits.maxSubjects) {
    issue('runtime_limit_exceeded', 'subjects', `the runtime computes at most ${limits.maxSubjects} subjects`)
  }

  // --- premises: only a pack that declares a validation list is held to it ---
  if (Array.isArray(model.validation)) {
    const entries = model.validation.map(object)
    if (entries.some((entry) => !text(entry.evidenceRef))) premise('provenance_missing', 'validation', 'a validation entry names no evidence; it is not read as validation')
    const sourced = entries.filter((entry) => text(entry.evidenceRef))
    const sameMode = sourced.filter((entry) => entry.mode === mode)
    if (!sameMode.length) {
      premise('use_not_validated', 'mode', `no sourced validation covers ${mode || 'this use'}`)
    } else {
      if (text(asked.population) && !sameMode.some((entry) => entry.population === asked.population)) {
        premise('population_outside_validation', 'population', 'the population is not one the model was validated on')
      }
      if (text(asked.endpoint) && !sameMode.some((entry) => entry.endpoint === asked.endpoint)) {
        premise('endpoint_outside_validation', 'endpoint', 'the endpoint is not one the model was validated on')
      }
      if (Number.isFinite(asked.horizonHours) && !sameMode.some((entry) => !Number.isFinite(entry.horizonHours) || entry.horizonHours >= asked.horizonHours)) {
        premise('horizon_beyond_validation', 'horizonHours', 'the horizon is longer than any validated horizon')
      }
      if (sameMode.every((entry) => entry.independent === false)) premise('no_independent_data', 'validation', 'the validation used no independent data')
    }
  }
  return { executionIssues, premises }
}
