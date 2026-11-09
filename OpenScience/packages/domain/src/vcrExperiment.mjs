/**
 * The frozen record of an experiment: what a researcher asked, frozen, and the identity of it (`vcrDesignExperimentCanonical`).
 *
 * Hidden knowledge:
 *
 * - **There is one launch record, and it is the design experiment's.** An earlier `vcrExperimentRecord` (a population reference, a model
 *   reference, a prediction mode, an observation schedule ...) was declared in round 1 and never read by any server code: every arm job was
 *   enqueued with no inputs and a seed of its own, so the "same people" it promised were only the same definitions. It was deleted in round 2
 *   (plan R23, "build to delete") and the one thing it stood for became real here: a disease experiment may name `people`, a record of virtual
 *   patients made once by the engine (`patients.progression` 1.2.0, `instantiate`) and how every arm uses it. The record is an input of every
 *   arm's job, with its hash, so the same people stand in every arm by construction, and the experiment's identity follows it.
 * - **An identity is the canonical bytes of what was frozen.** `vcrDesignExperimentCanonical` is the engine's `canonicalScenarioJson` of the
 *   record (sorted keys, no `undefined`); key order never changes it; a seed, an arm, a comparison or the record of people always does.
 * - **This package cannot hash** (it is browser-safe), so it returns the canonical bytes and the caller hashes them, the way
 *   `vcrResultOutputPayload` does. A record is a value: nothing here is stored.
 *
 * @module @evimed/domain/vcrExperiment
 */

import { canonicalScenarioJson } from './vcrEngineJob.mjs'
import { VCR_PEOPLE_MODES } from './vcrScenarioSchemas.mjs'
import { VCR_PEOPLE_COUNT_MEASURES } from './vcrVocabulary.mjs'

/** @param {unknown} value */
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {})

// ---------------------------------------------------------------------------
// Design experiments (plan T09): named arms of existing design methods over one frozen endpoint and analysis
// ---------------------------------------------------------------------------

/** The methods whose arms are disease-response hypotheses: a run arm of one experiment is a design method or one of these, never both. */
export const VCR_DISEASE_EXPERIMENT_METHODS = Object.freeze(['patients.progression'])
export const VCR_DESIGN_EXPERIMENT_LIMITS = Object.freeze({ minArms: 2, maxArms: 8, maxMeasures: 8, nameMax: 40, questionMax: 500 })
/** The fields every arm of a design experiment must agree on: the frozen endpoint and analysis definitions. */
export const VCR_EXPERIMENT_ALIGNED_FIELDS = Object.freeze(['endpoint', 'analysis.alpha', 'analysis.sided', 'hypothesis', 'timeUnit'])
/**
 * The fields the arms of a disease experiment must agree on: the same people, the same model, the same visits and the same analysis. Only
 * the drug hypothesis (`treatment`) differs between arms, and that is the comparison.
 */
export const VCR_DISEASE_EXPERIMENT_ALIGNED_FIELDS = Object.freeze(['endpoint', 'timeUnit', 'visits', 'design', 'model', 'population', 'placebo', 'dropoutModel',
  'analysis.kind', 'analysis.visit', 'analysis.alpha'])
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/

/** @param {Record<string, any>} source @param {string} path */
const pathValue = (source, path) => path.split('.').reduce((/** @type {any} */ node, part) => (node && typeof node === 'object' ? node[part] : undefined), source)

/**
 * A design experiment as it is frozen: the question, the arms (each either an existing saved result by id, or a design method,
 * its version and its scenario to run), the comparison (which measures, against which arm) and, for a disease experiment, the record of
 * virtual people every arm runs on and the mode (`VCR_PEOPLE_MODES`). Only known fields; a changed arm, a
 * changed scenario or a changed comparison is a new experiment.
 *
 * The comparison reads only what a design states about itself (review eng P0-1): a measure that counts a study's people
 * (`VCR_PEOPLE_COUNT_MEASURES`) is refused by name, and when the run arms' methods declare what they measure (`registry.measures`, the
 * campaign table `VCR_CAMPAIGN_METHODS`), a compared measure is one of those. Which saved results may be attached is the caller's check:
 * it holds the store.
 * @param {unknown} input
 * @param {{ methods: Record<string, { version: string }>, measures?: Record<string, { measures: Record<string, string> }> }} registry the
 *   engine's method registry (`VCR_ENGINE_METHODS`) and, optionally, the measures each method declares
 * @returns {{ record: Record<string, any> | null, issues: Array<{ code: string, field: string, detail: string }> }}
 */
export function vcrDesignExperiment(input, { methods, measures: declared = {} }) {
  const L = VCR_DESIGN_EXPERIMENT_LIMITS
  /** @type {Array<{ code: string, field: string, detail: string }>} */
  const issues = []
  const bad = (/** @type {string} */ code, /** @type {string} */ field, /** @type {string} */ detail) => { issues.push({ code, field, detail }) }
  const src = object(input)
  const armsIn = Array.isArray(src.arms) ? src.arms : []
  if (armsIn.length < L.minArms || armsIn.length > L.maxArms) bad('experiment_arms_invalid', 'arms', `An experiment compares ${L.minArms} to ${L.maxArms} named arms.`)
  const arms = armsIn.map((raw, i) => {
    const arm = object(raw)
    const name = typeof arm.name === 'string' ? arm.name.trim().slice(0, L.nameMax) : ''
    if (!name) bad('experiment_value_invalid', `arms[${i}].name`, 'Every arm is named.')
    if (arm.resultId != null) {
      if (typeof arm.resultId !== 'string' || !ID.test(arm.resultId)) bad('experiment_value_invalid', `arms[${i}].resultId`, 'A saved result is named by its id.')
      if (arm.method != null || arm.scenario != null) bad('experiment_value_invalid', `arms[${i}]`, 'An arm attaches a saved result or runs a method, not both.')
      return { name, resultId: String(arm.resultId) }
    }
    const method = typeof arm.method === 'string' ? arm.method : ''
    const spec = methods[method]
    if (!(method.startsWith('design.') || VCR_DISEASE_EXPERIMENT_METHODS.includes(method)) || !spec) bad('experiment_method_unsupported', `arms[${i}].method`, 'An experiment runs a registered design method (design.*), the disease-response trial (patients.progression) or attaches a saved result.')
    const version = arm.version ?? spec?.version ?? null
    if (spec && version !== spec.version) bad('experiment_method_version', `arms[${i}].version`, `${method} is ${spec.version} in this build.`)
    const scenario = object(arm.scenario)
    if (!Object.keys(scenario).length) bad('experiment_value_invalid', `arms[${i}].scenario`, 'An arm that runs states its scenario.')
    if (scenario.evaluation !== undefined) bad('experiment_value_invalid', `arms[${i}].scenario.evaluation`, 'An experiment arm runs at the method\'s normal precision.')
    return { name, method, version, scenario }
  })
  if (new Set(arms.map((arm) => arm.name)).size !== arms.length) bad('experiment_value_invalid', 'arms', 'Arm names are unique.')
  const running = arms.filter((arm) => 'method' in arm)
  const disease = running.some((arm) => VCR_DISEASE_EXPERIMENT_METHODS.includes(/** @type {any} */ (arm).method))
  if (disease && running.some((arm) => !VCR_DISEASE_EXPERIMENT_METHODS.includes(/** @type {any} */ (arm).method))) {
    bad('experiment_arms_mixed', 'arms', 'An experiment compares disease-response hypotheses or trial designs, not both: a design arm and a disease arm answer different questions.')
  }
  // R23: a disease experiment may run every arm on one record of virtual people (an id of a result of this study, never a path or a hash)
  /** @type {{ recordId: string, mode: string } | null} */
  let people = null
  if (src.people !== undefined && src.people !== null) {
    const asked = object(src.people)
    const recordId = typeof asked.recordId === 'string' ? asked.recordId : ''
    if (!disease) bad('experiment_people_unsupported', 'people', 'Virtual people belong to a comparison of disease-response hypotheses (patients.progression); a design comparison has no people.')
    else if (!ID.test(recordId)) bad('experiment_value_invalid', 'people.recordId', 'The record of people is named by the id of its result in this study.')
    else if (!VCR_PEOPLE_MODES.includes(asked.mode)) bad('experiment_value_invalid', 'people.mode', `A run on a record is ${VCR_PEOPLE_MODES.join(' or ')}.`)
    else {
      people = { recordId, mode: String(asked.mode) }
      running.forEach((arm) => {
        const scenario = object(/** @type {any} */ (arm).scenario)
        // the record is the covariates and the study; an arm that states them too would be silently overruled
        for (const key of ['population', 'people', 'instantiate']) {
          if (scenario[key] !== undefined) bad('experiment_people_conflict', `arms[${arms.indexOf(arm)}].scenario.${key}`, 'An experiment on a record of people takes the people from the record: an arm does not state them.')
        }
        if (scenario.model?.uncertainty !== undefined) bad('experiment_people_conflict', `arms[${arms.indexOf(arm)}].scenario.model.uncertainty`, 'A run on a record is on the study the record was made in; the study is not drawn again.')
      })
    }
  }
  const comparisonIn = object(src.comparison)
  const measures = Array.isArray(comparisonIn.measures) ? comparisonIn.measures.map(String) : []
  if (!measures.length || measures.length > L.maxMeasures || measures.some((name) => !/^[a-z][a-z0-9_]{0,63}$/.test(name))) {
    bad('experiment_value_invalid', 'comparison.measures', `A comparison names 1 to ${L.maxMeasures} measures.`)
  }
  measures.forEach((name, i) => {
    if (VCR_PEOPLE_COUNT_MEASURES.includes(name)) bad('experiment_measure_unsupported', `comparison.measures[${i}]`, `${name} counts a study's people: an experiment compares what designs state, never who is in a study.`)
  })
  const stated = running.map((arm) => declared[/** @type {any} */ (arm).method]?.measures).filter(Boolean)
  if (stated.length) {
    const known = new Set(stated.flatMap((table) => Object.keys(/** @type {Record<string, string>} */ (table))))
    measures.forEach((name, i) => {
      if (!known.has(name) && !VCR_PEOPLE_COUNT_MEASURES.includes(name)) bad('experiment_measure_unsupported', `comparison.measures[${i}]`, `No arm's method measures ${name}.`)
    })
  }
  const reference = typeof comparisonIn.reference === 'string' ? comparisonIn.reference : arms[0]?.name ?? null
  if (!arms.some((arm) => arm.name === reference)) bad('experiment_value_invalid', 'comparison.reference', 'The contrast is against one of the arms.')
  if (issues.length) return { record: null, issues }
  return { record: { schemaVersion: 1, kind: disease ? 'disease' : 'design', question: typeof src.question === 'string' ? src.question.slice(0, L.questionMax) : '',
    purpose: typeof src.purpose === 'string' ? src.purpose.slice(0, 200) : '', arms, comparison: { measures, reference }, ...(people ? { people } : {}) }, issues }
}

/** The canonical bytes a design experiment's identity is the sha256 of. @param {Record<string, any>} record */
export function vcrDesignExperimentCanonical(record) {
  return canonicalScenarioJson({ designExperiment: 1, record })
}

/**
 * Whether the arms stand on the same frozen endpoint and analysis: one row per aligned field with every arm's value, and whether
 * they agree. An arm whose scenario is not known (a saved result whose configuration is withheld) is listed as unknown, never as agreeing.
 * @param {Array<{ name: string, scenario: Record<string, any> | null }>} arms
 * @param {readonly string[]} [fields] the fields to agree on; a disease experiment passes `VCR_DISEASE_EXPERIMENT_ALIGNED_FIELDS`
 */
export function vcrExperimentAlignment(arms, fields = VCR_EXPERIMENT_ALIGNED_FIELDS) {
  return fields.map((field) => {
    const values = arms.map((arm) => ({ name: arm.name, known: arm.scenario != null, value: arm.scenario ? pathValue(arm.scenario, field) ?? null : null }))
    const known = values.filter((entry) => entry.known)
    const texts = new Set(known.map((entry) => canonicalScenarioJson(entry.value)))
    return { field, aligned: known.length === values.length && texts.size <= 1, unknown: values.filter((entry) => !entry.known).map((entry) => entry.name), values }
  })
}

/**
 * Which drug hypothesis a disease arm states, read from its `treatment` block (a scenario's, or the block itself): `none` (no effect
 * stated, so the arm measures the test's type I error), `symptomatic` (a change in points), `disease_modifying` (a share of the decline
 * removed) or `both`. Values are the scenario's `{ value, basis }` or a bare number. It is what the engine calls a null scenario, written
 * once here so the arm's label and a campaign's error-control check agree with the run.
 * @param {unknown} input
 * @returns {'none' | 'symptomatic' | 'disease_modifying' | 'both'}
 */
export function vcrDiseaseHypothesis(input) {
  const source = object(input)
  const treatment = object(source.treatment !== undefined || source.design !== undefined ? source.treatment : source)
  /** @param {unknown} x */
  const num = (x) => { const v = x && typeof x === 'object' ? /** @type {any} */ (x).value : x; return typeof v === 'number' && Number.isFinite(v) ? v : 0 }
  const sym = object(treatment.symptomatic)
  const symptomatic = Object.keys(sym).length > 0 && (num(sym.pointsAt) !== 0 || num(sym.logitEmax) !== 0)
  const modifying = num(object(treatment.diseaseModifying).fraction) > 0
  return symptomatic && modifying ? 'both' : symptomatic ? 'symptomatic' : modifying ? 'disease_modifying' : 'none'
}
