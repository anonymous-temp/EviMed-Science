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
 * - **The credibility record is computed where it can be and stated where it cannot** (plan R28, ICH M15 Step 5, section 2.1 and 3): the question of
 *   interest and the context of use are the person's, the model's influence on the decision and the consequence of a wrong one are the person's judgement
 *   (never defaulted: the stored model assessment record of `vcrModelAssessment.mjs` supplies them and its `vcrModelRisk` derives the risk, M15 section 2.1.5), verification is what the engine's own result records (the tables of the published
 *   opinion it reproduces, the simulation error of its numbers), validation is the external validation of the placebo progression read from
 *   `vcr-external-validation.json` (made from the committed result by `evals/vcr-in-silico/external-validation/summarise.mjs`, never typed), and applicability
 *   is range checks of the run's population and horizon against what that validation covered. M15 prescribes no method for model-form uncertainty,
 *   averaging or transportability: the second published structure is shown beside the first and nothing is averaged.
 *
 * @module @evimed/domain/vcrModelUse
 */

import externalValidation from './vcr-external-validation.json' with { type: 'json' }
import { normalizeVcrAssessment } from './vcrModelAssessment.mjs'

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
      // Coverage is one validation entry's, never a field of one entry and a field of another (review stats P2-12): (adults, heart
      // rate, 24 h) and (children, blood pressure, 1 y) do not validate (children, heart rate, 1 y). The entries are narrowed by what is
      // predicted first, then for whom, then for how long; each dimension no remaining entry covers is a premise. An entry that states
      // no horizon validated none, so it does not cover a stated one.
      let covering = sameMode
      const narrow = (/** @type {(entry: Record<string, any>) => boolean} */ holds, /** @type {() => void} */ otherwise) => {
        const kept = covering.filter(holds)
        if (kept.length) covering = kept
        else otherwise()
      }
      if (text(asked.endpoint)) narrow((entry) => entry.endpoint === asked.endpoint, () => premise('endpoint_outside_validation', 'endpoint', 'the endpoint is not one the model was validated on'))
      if (text(asked.population)) narrow((entry) => entry.population === asked.population, () => premise('population_outside_validation', 'population', 'the population is not one the model was validated on'))
      if (Number.isFinite(asked.horizonHours)) {
        narrow((entry) => Number.isFinite(entry.horizonHours) && entry.horizonHours >= asked.horizonHours, () => premise('horizon_beyond_validation', 'horizonHours', 'the horizon is longer than any validated horizon'))
      }
      if (covering.every((entry) => entry.independent === false)) premise('no_independent_data', 'validation', 'the validation used no independent data')
    }
  }
  return { executionIssues, premises }
}

/** The eight fields of the credibility record, in M15's order. */
export const VCR_CREDIBILITY_FIELDS = frozen(['question_of_interest', 'context_of_use', 'model_influence', 'decision_consequence', 'model_risk', 'verification', 'validation', 'applicability'])
/** The external validation of the placebo progression, as made from the committed result (see the header). */
export function vcrExternalValidation() {
  return externalValidation
}

/**
 * The ICH M15 credibility record of one Alzheimer result: eight entries, each `computed` (read from the result and the validation), `stated` (the person's) or
 * `not_stated` (nothing was said and nothing is assumed). The applicability checks compare the run with what the validation covered.
 * @param {Record<string, any>} [input] `{ assessment?: a stored model assessment record (the person's or the AI's own: question, context, the two ratings), population?: { mmseRange?: [number, number] }, lastVisitWeeks?, reproduced?: string[], replicates?, hasDrugEffect? }`
 * @returns {{ items: Array<{ field: string, basis: 'computed' | 'stated' | 'not_stated', decisive: boolean, data: Record<string, any> }>, risk: { risk: string, rule: string } | null, applicability: Array<{ check: string, inside: boolean, value: any, range: any }> }}
 */
export function vcrCredibilityRecord(input = {}) {
  const asked = object(input)
  const validation = externalValidation
  const checks = []
  const mmse = Array.isArray(asked.population?.mmseRange) ? asked.population.mmseRange.map(Number) : null
  if (mmse && mmse.length === 2 && mmse.every(Number.isFinite)) {
    const hull = validation.domain.mmseHull
    checks.push({ check: 'mmse_range', inside: mmse[0] >= hull[0] && mmse[1] <= hull[1], value: mmse, range: hull })
  }
  if (Number.isFinite(asked.lastVisitWeeks)) {
    const longest = Math.max(...validation.domain.horizonsWeeks)
    checks.push({ check: 'horizon_weeks', inside: asked.lastVisitWeeks <= longest, value: asked.lastVisitWeeks, range: [0, longest] })
  }
  if (asked.hasDrugEffect === true) checks.push({ check: 'drug_effect_validated', inside: false, value: 'drug effect', range: 'placebo arms only' })
  const given = asked.assessment ? normalizeVcrAssessment(asked.assessment) : null
  const risk = given && given.risk ? { risk: given.risk, rule: String(given.riskRule) } : null
  const stated = (/** @type {unknown} */ x) => (typeof x === 'string' && x.trim() ? x.trim() : null)
  /** @type {Array<{ field: string, basis: 'computed' | 'stated' | 'not_stated', decisive: boolean, data: Record<string, any> }>} */
  const items = [
    { field: 'question_of_interest', basis: stated(given?.questionOfInterest) ? 'stated' : 'not_stated', decisive: false, data: { text: stated(given?.questionOfInterest) } },
    { field: 'context_of_use', basis: stated(given?.contextOfUse) ? 'stated' : 'not_stated', decisive: false, data: { text: stated(given?.contextOfUse) } },
    { field: 'model_influence', basis: given?.influence ? 'stated' : 'not_stated', decisive: false, data: { level: given?.influence || null } },
    { field: 'decision_consequence', basis: given?.consequence ? 'stated' : 'not_stated', decisive: false, data: { level: given?.consequence || null } },
    { field: 'model_risk', basis: risk ? 'computed' : 'not_stated', decisive: risk?.risk === 'high', data: { level: risk?.risk ?? null, rule: risk?.rule ?? null } },
    { field: 'verification', basis: Array.isArray(asked.reproduced) && asked.reproduced.length ? 'computed' : 'not_stated', decisive: false, data: { reproduced: Array.isArray(asked.reproduced) ? asked.reproduced : [], replicates: Number.isFinite(asked.replicates) ? asked.replicates : null } },
    { field: 'validation', basis: 'computed', decisive: true, data: { arms: validation.arms, long: validation.primary.long, short: validation.primary.short, secondStructure: validation.secondStructure.meanAbsoluteDifferenceFromPrimary, onlyPlacebo: validation.domain.onlyPlacebo } },
    { field: 'applicability', basis: checks.length ? 'computed' : 'not_stated', decisive: checks.some((c) => !c.inside), data: { checks } },
  ]
  return { items, risk, applicability: checks }
}
