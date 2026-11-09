/**
 * A bounded, auditable design search ("campaign"): a frozen manifest, its candidates in a fixed order, and the decision functions
 * that move it from a cheap screen to an independent full-precision check of a few finalists and say why it stopped.
 *
 * Hidden knowledge:
 *
 * - **The evaluator is frozen with the manifest.** The objective, the constraints (with their bounds and confidence), the truths the
 *   designs are judged under and the stage sizes are part of the canonical bytes the campaign's identity is the hash of; a changed
 *   manifest is a new campaign. A variable may never move the truth, the endpoint, the nominal alpha or sidedness, the hypothesis,
 *   what is measured, the precision block or the costs: those are the evaluator (`VCR_CAMPAIGN_FROZEN_PATHS`). A dose design may not
 *   move its target toxicity either, because that number defines what a correct dose is.
 * - **A constraint passes on a predeclared conservative bound, never on a point estimate.** A simulated proportion is judged by the
 *   exact one-sided Clopper–Pearson bound at the frozen confidence (0.975 unless stated): `<=` passes only when the upper bound is
 *   at or below the fixed bound, fails only when the lower bound is above it, and is inconclusive between. A mean uses its MCSE and the
 *   normal quantile; an exact (calculated) value is compared as it is. Near the boundary the answer is "inconclusive", never "pass".
 * - **A screening number is never a result.** A measure the engine labelled `precision: 'screening'` can rank and can eliminate a
 *   candidate whose most favourable bound already violates a design or safety constraint; it cannot pass anything. Error-control
 *   constraints are judged only on final evaluations, which run at the method's normal floor on seeds no screening unit used.
 * - **Seeds are derived, not chosen.** A unit's seed is a 31-bit FNV-1a of (campaign identity, stage, truth, draw key). Candidates whose
 *   scenarios consume random numbers identically (`vcrCampaignDrawKey`: the scenario without the fields that only analyse or judge
 *   the draws) share a seed per stage and truth, so their comparison can be paired; the engine's draw signature confirms it, and a
 *   mismatch ("same seed, different draws") is detected and reported, never assumed away. Everything else gets its own seed.
 * - **This package cannot hash** (it is browser-safe): the caller hashes `vcrCampaignCanonical(manifest)` and hands the hex digest in.
 * - **The model proposes; code decides.** Nothing here reads language. A dose design has no superiority alpha: an error-control
 *   constraint is admitted only on an error-rate measure the method produces.
 * - **Undecided is not infeasible** (review stats P1-1). When no finalist fails and at least one is only inconclusive at its bound, the
 *   campaign stops `inconclusive_at_precision`, never "nothing feasible", and each inconclusive verdict says how many replicates
 *   would decide it (`needed`), or that none would (the estimate sits on the bound). An improvement over the reference is decided on
 *   the bound of the two runs' contrast, not on two point estimates (stats P2-1).
 * - **A nominal level is a guarantee only where it is exact** (review stats P1-2). `analyticSupport` lets an error-control constraint
 *   rest on the test's own level only for a test whose size is exact under the simulated model (`VCR_EXACT_CALIBRATIONS`: the pooled
 *   two-sample t-test of a fixed two-arm design with a normal, equal-SD outcome, the engine's continuous model). The score z of a
 *   binary design, Farrington–Manning, the log-rank and a group-sequential log-rank are asymptotic: their size at these sample sizes
 *   can exceed alpha (2.7% at 30 per arm and p = 0.10), so their type I error is held to the simulation's conservative bound.
 *
 * @module @evimed/domain/vcrExperimentSearch
 */

import { canonicalScenarioJson, vcrIsNullScenario, vcrReplicateFloorFor, VCR_MAX_REPLICATES } from './vcrEngineJob.mjs'
import { VCR_JOB_METHODS, VCR_ENGINE_METHODS } from './vcrEngineJob.mjs'
import { VCR_REPLICATES_ALT_MIN } from './vcrVocabulary.mjs'
import { vcrDiseaseHypothesis } from './vcrExperiment.mjs'
import { vcrEvaluationAllowed, vcrNullTruth } from './vcrScenarioSchemas.mjs'

/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {})
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : [])
/** @param {any} value */
const clone = (value) => JSON.parse(JSON.stringify(value))

export const VCR_CAMPAIGN_SCHEMA_VERSION = 1
/** Why a campaign stopped (plan section 9). Exactly one is recorded. */
export const VCR_CAMPAIGN_STOP_REASONS = Object.freeze([
  'budget_exhausted', 'acceptable_precision', 'no_useful_improvement', 'unsupported_candidate', 'persistent_model_failure',
  'user_cancellation', 'no_feasible_beneficial_candidate', 'inconclusive_at_precision', 'study_unavailable',
])
/**
 * The tests whose size is exact under the simulated model, by the name a final evaluation records (`nominalControl`). Only these may
 * carry an error-control constraint on their nominal level (`analyticSupport`).
 */
export const VCR_EXACT_CALIBRATIONS = Object.freeze(['pooled_t_equal_sd_normal'])
export const VCR_CONSTRAINT_KINDS = Object.freeze(['error_control', 'design', 'safety'])
export const VCR_CONSTRAINT_OPS = Object.freeze(['<=', '>='])
export const VCR_EVALUATION_PURPOSES = Object.freeze(['screening', 'final'])
/** The verdict of one constraint on one evaluation. */
export const VCR_CONSTRAINT_STATUSES = Object.freeze(['pass', 'fail', 'inconclusive', 'not_judged'])

/**
 * The screening precision purpose, version 1. `minReplicates` is the smallest screening run; a screening run must stay below the
 * method's normal count (`finalFloor`): design.simulate's smallest floor is the alternative-case floor, design.dose's is its default
 * number of trials (`VCR_DOSE_DEFAULT_TRIALS` in the engine).
 */
export const VCR_SCREENING = Object.freeze({
  version: 1,
  minReplicates: 200,
  methods: Object.freeze({
    'design.simulate': Object.freeze({ finalFloor: VCR_REPLICATES_ALT_MIN }),
    'design.dose': Object.freeze({ finalFloor: 10_000 }),
  }),
})

/**
 * What a campaign may search and judge, by method: the measures and their kind. `proportion` and `error_rate` are simulated
 * rejection/selection probabilities (exact bounds); `mean` is a simulated mean with its MCSE; `exact` is a calculated value.
 * Only an `error_rate` may carry an error-control constraint.
 */
export const VCR_CAMPAIGN_METHODS = Object.freeze({
  'design.simulate': Object.freeze({ exact: false, measures: Object.freeze({
    power: 'proportion', type_one_error: 'error_rate', power_logrank: 'proportion', type_one_error_logrank: 'error_rate',
    coverage: 'proportion', early_stop_probability: 'proportion', expected_sample_size: 'mean', expected_events: 'mean',
    expected_analyses: 'mean', duration_months: 'mean', cost: 'mean', bias: 'mean', mse: 'mean', empirical_se: 'mean',
  }) }),
  'design.dose': Object.freeze({ exact: false, measures: Object.freeze({
    correct_dose_probability: 'proportion', select_none_probability: 'proportion', patients_above_mtd: 'mean',
    expected_sample_size: 'mean', expected_dlt: 'mean',
  }) }),
  // The disease-response trial (plan T09): the Alzheimer `beta_logit` family of patients.progression. Its "truth" is the drug hypothesis
  // (`treatment`), its candidates move the design (sample size, duration), it has no screening precision (every unit runs at the engine's
  // floor), and its sample size and last visit are calculated from the scenario itself, so a search can minimize the first under a power bound.
  'patients.progression': Object.freeze({ exact: false, precisionBlock: false, truthField: 'treatment', defaultAlpha: 0.05, finalFloor: VCR_REPLICATES_ALT_MIN,
    measures: Object.freeze({
      power: 'proportion', type_one_error: 'error_rate', expected_difference: 'exact', expected_control_change: 'exact', expected_treated_change: 'exact',
      simulated_difference: 'mean', total_sample_size: 'exact', last_visit_weeks: 'exact',
      // 1.2.0: the assurance of an effect stated as a distribution, and the paired mode's contrast over one record of people (R23, R25)
      assurance: 'proportion', paired_mean_contrast: 'mean', paired_latent_mean_contrast: 'mean', paired_latent_sd: 'mean', paired_latent_q10: 'mean',
      paired_latent_q50: 'mean', paired_latent_q90: 'mean', paired_share_improved: 'proportion', paired_observed_share: 'proportion',
    }) }),
  'design.analytic': Object.freeze({ exact: true, measures: Object.freeze({
    required_events: 'exact', required_events_exact: 'exact', required_patients: 'exact', sample_size: 'exact', max_events: 'exact',
    expected_events_h0: 'exact', expected_events_h1: 'exact', power: 'exact', type_one_error: 'exact',
  }) }),
})

/**
 * The methods whose analysis level (`analysis.alpha`) a campaign may search (F4). The frozen error-control constraint stays what it is;
 * a lower analysis level is a design the campaign tries to give the simulated rate margin under that constraint, never a relaxation:
 * every searched level is at or below the smallest error-control bound, and a campaign that searches it states such a constraint.
 */
export const VCR_CAMPAIGN_ALPHA_SEARCH_METHODS = Object.freeze(['design.simulate', 'patients.progression'])
export const VCR_CAMPAIGN_ALPHA_PATH = 'analysis.alpha'

/** The measure scenarios are compared on, and the defaults a robust reading writes into its manifest (R34). */
export const VCR_ROBUST_MEASURE = 'power'
export const VCR_ROBUST_DEFAULTS = Object.freeze({ floor: 0.8, tolerance: Object.freeze({ power: 0.02, relative: 0.1 }) })

/** Paths no variable may move: the evaluator. A path equal to or below one of these is refused. */
export const VCR_CAMPAIGN_FROZEN_PATHS = Object.freeze({
  common: Object.freeze(['truth', 'endpoint', 'evaluation', 'performance', 'targetMcse', 'hypothesis', 'costs', 'timeUnit',
    'analysis.alpha', 'analysis.sided', 'analysis.power', 'external']),
  // the patients' dropout is the world the designs are judged in, not a design choice: a search for power would "choose" none (stats P2-2)
  'design.simulate': Object.freeze(['accrual.dropoutAnnual']),
  'design.dose': Object.freeze(['design.targetToxicity']),
  // the drug hypothesis is the evaluator's world, as are the model, its population and what the analysis estimates
  'patients.progression': Object.freeze(['treatment', 'model', 'population', 'placebo', 'dropoutModel', 'analysis.kind']),
})

/** The fields of a design.simulate scenario that only analyse or judge the draws: candidates differing only here share their draws. */
const DRAW_NEUTRAL = Object.freeze(['truth', 'analysis', 'performance', 'targetMcse', 'costs', 'hypothesis', 'evaluation',
  'design.informationRates', 'design.spending'])

export const VCR_CAMPAIGN_LIMITS = Object.freeze({
  maxSpace: 10_000, maxCandidates: 200, maxVariables: 6, maxValues: 50, maxTruths: 4, maxConstraints: 8,
  finalCountMax: 5, replicatesMax: 500_000_000, cpuSecondsMax: 7 * 24 * 3600, modelCallsMax: 1000, questionMax: 500,
})

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PATH = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*){0,5}$/

/** @param {Record<string, any>} target @param {string} path @param {unknown} value */
function setPath(target, path, value) {
  const parts = path.split('.')
  let node = target
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {}
    node = node[part]
  }
  node[/** @type {string} */ (parts.at(-1))] = clone(value)
}

/** @param {Record<string, any>} source @param {string} path */
function getPath(source, path) {
  let node = /** @type {any} */ (source)
  for (const part of path.split('.')) { if (!node || typeof node !== 'object') return undefined; node = node[part] }
  return node
}

/** @param {Record<string, any>} source @param {string} path */
function deletePath(source, path) {
  const parts = path.split('.')
  let node = /** @type {any} */ (source)
  for (const part of parts.slice(0, -1)) { if (!node || typeof node !== 'object') return; node = node[part] }
  if (node && typeof node === 'object') delete node[/** @type {string} */ (parts.at(-1))]
}

/** @param {string} method @param {string} path */
function frozenPath(method, path) {
  const frozen = [...VCR_CAMPAIGN_FROZEN_PATHS.common, ...(/** @type {Record<string, readonly string[]>} */ (VCR_CAMPAIGN_FROZEN_PATHS)[method] ?? [])]
  return frozen.some((root) => path === root || path.startsWith(`${root}.`) || root.startsWith(`${path}.`))
}

/**
 * Paths a scenario's world may not re-state: the evaluator's (the common list and the method's own truth field). The method's other
 * frozen paths (dropout, placebo, population, model) are exactly what a world is for, so they are allowed here.
 * @param {string | undefined} truthField @param {string} path
 */
function worldFrozenPath(truthField, path) {
  const roots = [...VCR_CAMPAIGN_FROZEN_PATHS.common, ...(truthField ? [truthField] : [])]
  return roots.some((root) => path === root || path.startsWith(`${root}.`) || root.startsWith(`${path}.`))
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/**
 * Normalise a campaign manifest and say what is wrong with it. The returned manifest is what is frozen (only known fields, defaults
 * written in), so two requests that mean the same campaign have the same canonical bytes.
 * @param {unknown} input
 * @returns {{ manifest: Record<string, any> | null, issues: Array<{ code: string, field: string, detail: string }> }}
 */
export function vcrCampaignManifest(input) {
  /** @type {Array<{ code: string, field: string, detail: string }>} */
  const issues = []
  const bad = (/** @type {string} */ code, /** @type {string} */ field, /** @type {string} */ detail) => { issues.push({ code, field, detail }) }
  const src = object(input)
  const L = VCR_CAMPAIGN_LIMITS
  const space = object(src.space)
  const method = typeof space.method === 'string' ? space.method : ''
  const info = /** @type {Record<string, any>} */ (VCR_CAMPAIGN_METHODS)[method]
  if (!info) bad('campaign_method_unsupported', 'space.method', `A campaign searches ${Object.keys(VCR_CAMPAIGN_METHODS).join(', ')}.`)
  const registered = /** @type {Record<string, any>} */ (VCR_ENGINE_METHODS)[method]
  const version = space.version ?? registered?.version ?? null
  if (registered && version !== registered.version) bad('campaign_method_version', 'space.version', `${method} is ${registered.version} in this build; a campaign runs the current release.`)
  const base = object(space.scenario)
  if (!Object.keys(base).length) bad('campaign_scenario_missing', 'space.scenario', 'A campaign states the base scenario every candidate starts from.')
  if (base.evaluation !== undefined) bad('campaign_value_frozen', 'space.scenario.evaluation', 'The precision of each stage is the campaign\'s, not the scenario\'s.')

  // truths: the evaluator's worlds, by name
  const rawTruths = list(space.truths)
  // a method whose truth is a block of its own scenario (`truthField`, the disease trial's drug hypothesis) may state "no effect" as an empty block
  const truthField = info?.truthField ?? 'truth'
  const emptyTruthOk = Boolean(info?.truthField)
  if (emptyTruthOk && rawTruths.length && base[truthField] !== undefined) bad('campaign_value_frozen', `space.scenario.${truthField}`, `The ${truthField} of each world is stated in space.truths, not in the base scenario.`)
  // A scenario (R34) is a truth plus, optionally, the world around it: `world` re-states dotted paths of the base scenario for this scenario only
  // (the control course, the population, the dropout mechanism: whatever the method's schema takes there) and `weight` says how much the person
  // cares about it. Both are written only when stated, so a campaign that states neither keeps the canonical bytes it always had.
  const truths = rawTruths.length ? rawTruths.map((entry) => {
    const raw = object(entry)
    return { name: String(raw.name ?? ''), truth: object(raw.truth), ...(raw.world == null ? {} : { world: object(raw.world) }), ...(raw.weight == null ? {} : { weight: raw.weight }) }
  }) : [{ name: 'base', truth: object(base[truthField]) }]
  if (truths.length > L.maxTruths) bad('campaign_value_invalid', 'space.truths', `At most ${L.maxTruths} truth scenarios.`)
  truths.forEach((entry, i) => {
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(entry.name)) bad('campaign_value_invalid', `space.truths[${i}].name`, 'A truth is named with a short lower-case word.')
    if (!emptyTruthOk && !Object.keys(entry.truth).length) bad('campaign_value_invalid', `space.truths[${i}].truth`, 'A truth scenario states its truth.')
    if (entry.world !== undefined) {
      const world = /** @type {Record<string, any>} */ (entry.world)
      if (!Object.keys(world).length) bad('campaign_value_invalid', `space.truths[${i}].world`, 'A scenario\'s world states at least one path, or is left out.')
      for (const path of Object.keys(world)) {
        if (!PATH.test(path)) bad('campaign_value_invalid', `space.truths[${i}].world`, `"${path}" is not a dotted scenario path.`)
        else if (worldFrozenPath(info?.truthField, path)) bad('campaign_value_frozen', `space.truths[${i}].world.${path}`, `${path} belongs to the evaluator (truth, endpoint, nominal alpha, what is measured, precision) and no scenario's world can move it.`)
      }
    }
    if (entry.weight !== undefined && !(typeof entry.weight === 'number' && Number.isFinite(entry.weight) && entry.weight > 0)) bad('campaign_value_invalid', `space.truths[${i}].weight`, 'A scenario weight is a positive number.')
  })
  if (new Set(truths.map((entry) => entry.name)).size !== truths.length) bad('campaign_value_invalid', 'space.truths', 'Truth names are unique.')
  const truthNames = truths.map((entry) => entry.name)

  // variables or explicit candidates
  const variables = list(space.variables).map((entry) => ({ path: String(object(entry).path ?? ''), values: list(object(entry).values) }))
  const explicit = list(space.candidates).map((entry) => ({ name: object(entry).name == null ? null : String(object(entry).name).slice(0, 60), set: object(object(entry).set) }))
  if (variables.length && explicit.length) bad('campaign_value_invalid', 'space', 'A space lists variables or explicit candidates, not both.')
  if (!variables.length && !explicit.length) bad('campaign_space_empty', 'space', 'A campaign lists the variables it searches or its candidates.')
  if (variables.length > L.maxVariables) bad('campaign_value_invalid', 'space.variables', `At most ${L.maxVariables} variables.`)
  const checkPath = (/** @type {string} */ path, /** @type {string} */ field) => {
    if (!PATH.test(path)) { bad('campaign_value_invalid', field, 'A variable is a dotted scenario path.'); return }
    if (path === VCR_CAMPAIGN_ALPHA_PATH && VCR_CAMPAIGN_ALPHA_SEARCH_METHODS.includes(method)) return
    if (frozenPath(method, path)) bad('campaign_value_frozen', field, `${path} belongs to the evaluator (truth, endpoint, nominal alpha, what is measured, precision) and cannot be searched.`)
  }
  variables.forEach((entry, i) => {
    checkPath(entry.path, `space.variables[${i}].path`)
    if (!entry.values.length || entry.values.length > L.maxValues) bad('campaign_value_invalid', `space.variables[${i}].values`, `A variable has 1 to ${L.maxValues} values.`)
  })
  if (new Set(variables.map((entry) => entry.path)).size !== variables.length) bad('campaign_value_invalid', 'space.variables', 'A path is searched once.')
  explicit.forEach((entry, i) => {
    if (!Object.keys(entry.set).length) bad('campaign_value_invalid', `space.candidates[${i}].set`, 'A candidate sets at least one path.')
    for (const path of Object.keys(entry.set)) checkPath(path, `space.candidates[${i}].set.${path}`)
  })
  // a scenario's world is the evaluator's, a variable is the search's: one path cannot be both
  const searchedPaths = new Set([...variables.map((entry) => entry.path), ...explicit.flatMap((entry) => Object.keys(entry.set))])
  truths.forEach((entry, i) => {
    for (const path of Object.keys(object(entry.world))) {
      if ([...searchedPaths].some((searched) => searched === path || searched.startsWith(`${path}.`) || path.startsWith(`${searched}.`))) {
        bad('campaign_world_clash', `space.truths[${i}].world.${path}`, `${path} is searched by a candidate; a scenario's world cannot re-state a path the search moves.`)
      }
    }
  })
  const spaceSize = variables.length ? variables.reduce((n, entry) => n * Math.max(1, entry.values.length), 1) : explicit.length
  if (spaceSize > L.maxSpace) bad('campaign_value_invalid', 'space', `A space has at most ${L.maxSpace} candidates.`)
  const sample = space.sample == null ? null : { count: object(space.sample).count, seed: object(space.sample).seed }
  if (sample && !(Number.isInteger(sample.count) && sample.count >= 1 && sample.count <= L.maxCandidates && Number.isInteger(sample.seed) && sample.seed >= 0 && sample.seed <= 2_147_483_647)) {
    bad('campaign_value_invalid', 'space.sample', 'A random subset states its count and an integer seed.')
  }

  // objective and constraints: measures the method produces, on named truths
  const measures = info?.measures ?? {}
  const objectiveIn = object(src.objective)
  const objective = { measure: String(objectiveIn.measure ?? ''), direction: String(objectiveIn.direction ?? ''), truth: String(objectiveIn.truth ?? truthNames[0] ?? '') }
  if (!Object.hasOwn(measures, objective.measure)) bad('campaign_measure_unknown', 'objective.measure', `${method || 'This method'} does not produce ${JSON.stringify(objective.measure)}; the evaluator would read nothing.`)
  if (!['minimize', 'maximize'].includes(objective.direction)) bad('campaign_value_invalid', 'objective.direction', 'An objective is minimized or maximized.')
  if (!truthNames.includes(objective.truth)) bad('campaign_truth_unknown', 'objective.truth', 'The objective names one of the truth scenarios.')
  const constraintsIn = list(src.constraints)
  if (constraintsIn.length > L.maxConstraints) bad('campaign_value_invalid', 'constraints', `At most ${L.maxConstraints} constraints.`)
  const constraints = constraintsIn.map((raw, i) => {
    const c = object(raw)
    /** @type {Record<string, any>} */
    const out = { measure: String(c.measure ?? ''), op: String(c.op ?? ''), bound: c.bound, kind: String(c.kind ?? ''), truth: String(c.truth ?? truthNames[0] ?? ''),
      confidence: c.confidence ?? 0.975 }
    const at = `constraints[${i}]`
    if (!Object.hasOwn(measures, out.measure)) bad('campaign_measure_unknown', `${at}.measure`, `${method || 'This method'} does not produce ${JSON.stringify(out.measure)}.`)
    if (!VCR_CONSTRAINT_OPS.includes(out.op)) bad('campaign_value_invalid', `${at}.op`, 'A constraint is <= or >=.')
    if (typeof out.bound !== 'number' || !Number.isFinite(out.bound)) bad('campaign_value_invalid', `${at}.bound`, 'A constraint has a finite numeric bound.')
    if (!VCR_CONSTRAINT_KINDS.includes(out.kind)) bad('campaign_value_invalid', `${at}.kind`, `A constraint is ${VCR_CONSTRAINT_KINDS.join(', ')}.`)
    if (!truthNames.includes(out.truth)) bad('campaign_truth_unknown', `${at}.truth`, 'A constraint names one of the truth scenarios.')
    if (!(typeof out.confidence === 'number' && out.confidence >= 0.9 && out.confidence <= 0.999)) bad('campaign_value_invalid', `${at}.confidence`, 'A bound\'s confidence is from 0.90 to 0.999.')
    const type = measures[out.measure]
    if (out.kind === 'error_control') {
      if (type !== 'error_rate') bad('campaign_error_control_measure', `${at}.measure`, method === 'design.dose'
        ? 'A dose-finding design has no superiority type I error: judge it by its toxicity and selection constraints.'
        : 'An error-control constraint judges a type I error the method measures under a null truth.')
      if (out.op !== '<=') bad('campaign_value_invalid', `${at}.op`, 'An error rate is held at or below its bound.')
      const truth = truths.find((entry) => entry.name === out.truth)
      const nullTruth = info?.truthField ? vcrDiseaseHypothesis(truth?.truth) === 'none' : vcrIsNullScenario({ ...base, truth: truth?.truth })
      if (truth && type === 'error_rate' && !nullTruth) {
        bad('campaign_error_control_truth', `${at}.truth`, 'A type I error is measured under a null truth; this truth states an effect, so the evaluator would measure power instead.')
      }
      const alpha = typeof getPath(base, 'analysis.alpha') === 'number' ? getPath(base, 'analysis.alpha') : (info?.defaultAlpha ?? 0.025)
      if (typeof out.bound === 'number' && out.bound > alpha + 1e-12) {
        bad('campaign_alpha_relaxed', `${at}.bound`, `The nominal alpha is ${alpha}; an error-control bound above it would relax it to let a candidate win.`)
      }
      if (c.analyticSupport != null && typeof c.analyticSupport !== 'boolean') bad('campaign_value_invalid', `${at}.analyticSupport`, 'analyticSupport is true or false.')
      if (c.analyticSupport === true && typeof out.bound === 'number' && Math.abs(out.bound - alpha) > 1e-12) {
        bad('campaign_value_invalid', `${at}.analyticSupport`, 'A test calibrated at the nominal alpha supports a bound equal to that alpha, not a stricter one.')
      }
      if (c.analyticSupport === true) out.analyticSupport = true
    } else if (c.analyticSupport != null) {
      bad('campaign_value_invalid', `${at}.analyticSupport`, 'Only an error-control constraint can rest on a test\'s nominal level.')
    }
    return out
  })

  // The robust reading (R34): two or more scenarios that state an effect are judged side by side, never one of them alone. It is on when the
  // manifest has such scenarios (or states `robust`) and the method measures a power; every default it takes is written into the manifest.
  const effectNames = truths.filter((entry) => (info?.truthField ? vcrDiseaseHypothesis(entry.truth) !== 'none' : !vcrIsNullScenario({ ...base, truth: entry.truth }))).map((entry) => entry.name)
  const robustIn = src.robust == null ? null : object(src.robust)
  /** @type {Record<string, any> | null} */
  let robust = null
  if (robustIn || (effectNames.length >= 2 && Object.hasOwn(measures, VCR_ROBUST_MEASURE))) {
    const r = robustIn ?? {}
    const scenarios = list(r.scenarios).length ? list(r.scenarios).map(String) : effectNames
    const powerBound = constraints.find((c) => c.measure === VCR_ROBUST_MEASURE && c.op === '>=' && c.truth === objective.truth)?.bound
    const tolerance = { power: object(r.tolerance).power ?? VCR_ROBUST_DEFAULTS.tolerance.power, relative: object(r.tolerance).relative ?? VCR_ROBUST_DEFAULTS.tolerance.relative }
    robust = { measure: VCR_ROBUST_MEASURE, scenarios, floor: r.floor ?? (typeof powerBound === 'number' ? powerBound : VCR_ROBUST_DEFAULTS.floor),
      confidence: r.confidence ?? constraints[0]?.confidence ?? 0.975, tolerance, cost: r.cost ?? null }
    if (!Object.hasOwn(measures, VCR_ROBUST_MEASURE)) bad('campaign_robust_unsupported', 'robust', `${method || 'This method'} measures no ${VCR_ROBUST_MEASURE}: scenarios cannot be compared on it.`)
    if (r.measure != null && r.measure !== VCR_ROBUST_MEASURE) bad('campaign_value_invalid', 'robust.measure', `Scenarios are compared on ${VCR_ROBUST_MEASURE}.`)
    if (scenarios.length < 2 || new Set(scenarios).size !== scenarios.length || scenarios.some((name) => !effectNames.includes(name))) {
      bad('campaign_robust_scenarios', 'robust.scenarios', 'A robust reading compares two or more distinct scenarios that each state an effect.')
    }
    if (!(typeof robust.floor === 'number' && robust.floor > 0 && robust.floor < 1)) bad('campaign_value_invalid', 'robust.floor', 'The power every scenario must reach is a number between 0 and 1.')
    if (!(typeof robust.confidence === 'number' && robust.confidence >= 0.9 && robust.confidence <= 0.999)) bad('campaign_value_invalid', 'robust.confidence', 'A bound\'s confidence is from 0.90 to 0.999.')
    if (!(typeof tolerance.power === 'number' && tolerance.power >= 0 && tolerance.power <= 0.2)) bad('campaign_value_invalid', 'robust.tolerance.power', 'A power tolerance is from 0 to 0.2.')
    if (!(typeof tolerance.relative === 'number' && tolerance.relative >= 0 && tolerance.relative <= 0.5)) bad('campaign_value_invalid', 'robust.tolerance.relative', 'A relative tolerance is from 0 to 0.5.')
    if (robust.cost != null && !(Object.hasOwn(measures, robust.cost) && ['mean', 'exact'].includes(measures[robust.cost]))) bad('campaign_value_invalid', 'robust.cost', 'The cost is a mean or calculated measure the method produces.')
    // weights are the person's: stated for every compared scenario or for none
    const weighted = truths.filter((entry) => entry.weight !== undefined).map((entry) => entry.name)
    if (weighted.length && (scenarios.some((name) => !weighted.includes(name)) || weighted.some((name) => !scenarios.includes(name)))) {
      bad('campaign_weights_incomplete', 'space.truths', 'Scenario weights are stated for every compared scenario or for none.')
    }
  } else if (truths.some((entry) => entry.weight !== undefined)) bad('campaign_weights_incomplete', 'space.truths', 'Scenario weights belong to a robust reading of two or more effect scenarios.')

  // the analysis level may be searched only downward from the frozen constraint: each level at or below the smallest error-control bound
  const searchedLevels = [
    ...variables.filter((entry) => entry.path === VCR_CAMPAIGN_ALPHA_PATH).flatMap((entry, _i) => entry.values.map((value) => ({ field: `space.variables[${variables.indexOf(entry)}].values`, value }))),
    ...explicit.flatMap((entry, i) => (Object.hasOwn(entry.set, VCR_CAMPAIGN_ALPHA_PATH) ? [{ field: `space.candidates[${i}].set.${VCR_CAMPAIGN_ALPHA_PATH}`, value: entry.set[VCR_CAMPAIGN_ALPHA_PATH] }] : [])),
  ]
  if (searchedLevels.length) {
    const errorBounds = constraints.filter((c) => c.kind === 'error_control' && typeof c.bound === 'number').map((c) => c.bound)
    if (!errorBounds.length) bad('campaign_alpha_search_unbounded', 'constraints', 'Searching the analysis level needs an error-control constraint it must stay under: without one, a larger level would simply win on power.')
    const ceiling = Math.min(...errorBounds)
    for (const level of searchedLevels) {
      if (!(typeof level.value === 'number' && level.value > 0 && level.value <= ceiling + 1e-12)) {
        bad('campaign_alpha_relaxed', level.field, `An analysis level searched here is a number above 0 and at most the error-control bound ${ceiling}; a higher one would relax the constraint to let a candidate win.`)
      }
    }
  }

  // stages
  const stagesIn = object(src.stages)
  const screeningIn = stagesIn.screening == null ? null : object(stagesIn.screening)
  const exact = info?.exact === true
  const neededTruths = [...new Set([objective.truth, ...constraints.filter((c) => c.kind !== 'error_control').map((c) => c.truth), ...(robust ? robust.scenarios : [])])]
  const screening = screeningIn && !exact && info?.precisionBlock !== false ? { replicates: screeningIn.replicates, truths: list(screeningIn.truths).length ? list(screeningIn.truths).map(String) : neededTruths } : null
  if (screeningIn && info?.precisionBlock === false) bad('campaign_value_invalid', 'stages.screening', `${method} runs every unit at the engine's own number of trials: it has no screening precision.`)
  if (screeningIn && exact) bad('campaign_value_invalid', 'stages.screening', 'An exact method has no screening stage: every value is final.')
  if (screening) {
    const floor = /** @type {Record<string, any>} */ (VCR_SCREENING.methods)[method]?.finalFloor ?? 0
    if (!Number.isInteger(screening.replicates) || screening.replicates < VCR_SCREENING.minReplicates || screening.replicates >= floor) {
      bad('campaign_screening_replicates', 'stages.screening.replicates', `A screening stage runs ${VCR_SCREENING.minReplicates} to ${floor - 1} replicates: below the method's floor, never in place of it.`)
    }
    screening.truths.forEach((name, i) => { if (!truthNames.includes(name)) bad('campaign_truth_unknown', `stages.screening.truths[${i}]`, 'A screening truth is one of the truth scenarios.') })
  }
  const finalIn = object(stagesIn.final)
  const final = { count: finalIn.count ?? 3, replicates: finalIn.replicates ?? 'floor' }
  if (!(Number.isInteger(final.count) && final.count >= 1 && final.count <= L.finalCountMax)) bad('campaign_value_invalid', 'stages.final.count', `1 to ${L.finalCountMax} finalists.`)
  if (final.replicates !== 'floor' && !(Number.isInteger(final.replicates) && final.replicates >= (/** @type {Record<string, any>} */ (VCR_SCREENING.methods)[method]?.finalFloor ?? info?.finalFloor ?? 1))) {
    bad('campaign_final_below_floor', 'stages.final.replicates', 'Finalists run at the method\'s normal floor ("floor") or more, never below it.')
  }
  if (exact && final.replicates !== 'floor') bad('campaign_value_invalid', 'stages.final.replicates', 'An exact method has no replicates.')
  const analyticIn = stagesIn.analytic == null ? null : object(stagesIn.analytic)
  const analytic = analyticIn ? {
    method: String(analyticIn.method ?? 'design.analytic'),
    scenario: object(analyticIn.scenario),
    apply: list(analyticIn.apply).map(String),
    eliminate: list(analyticIn.eliminate).map((raw) => ({ measure: String(object(raw).measure ?? ''), exceeds: list(object(raw).exceeds).map(String), tolerance: object(raw).tolerance ?? 0.05 })),
  } : null
  if (analytic) {
    if (analytic.method !== 'design.analytic' || exact) bad('campaign_value_invalid', 'stages.analytic.method', 'An analytic pre-check of a simulated design is design.analytic.')
    if (!Object.keys(analytic.scenario).length) bad('campaign_value_invalid', 'stages.analytic.scenario', 'The analytic pre-check states its scenario.')
    if (!analytic.eliminate.length) bad('campaign_value_invalid', 'stages.analytic.eliminate', 'The analytic pre-check states what it eliminates.')
    analytic.apply.forEach((path, i) => { if (!PATH.test(path) || frozenPath('design.analytic', path)) bad('campaign_value_invalid', `stages.analytic.apply[${i}]`, 'Only searched design paths are carried into the analytic check.') })
    // the pre-check eliminates in the world the objective is judged in, never one of its own: a smaller effect there would remove designs
    // the simulation finds feasible, and they would never be simulated (review stats P2-4)
    const world = object(truths.find((entry) => entry.name === objective.truth)?.truth)
    for (const [key, value] of Object.entries(object(analytic.scenario.truth))) {
      if (Object.hasOwn(world, key) && canonicalScenarioJson(world[key]) !== canonicalScenarioJson(value)) {
        bad('campaign_analytic_truth_mismatch', `stages.analytic.scenario.truth.${key}`, `The analytic pre-check states ${key} = ${JSON.stringify(value)}; the objective's truth "${objective.truth}" states ${JSON.stringify(world[key])}.`)
      }
    }
    analytic.eliminate.forEach((rule, i) => {
      if (!Object.hasOwn(VCR_CAMPAIGN_METHODS['design.analytic'].measures, rule.measure)) bad('campaign_measure_unknown', `stages.analytic.eliminate[${i}].measure`, 'An analytic rule reads a measure design.analytic produces.')
      if (!rule.exceeds.length || rule.exceeds.some((path) => !PATH.test(path))) bad('campaign_value_invalid', `stages.analytic.eliminate[${i}].exceeds`, 'A rule names the candidate paths whose sum must reach the analytic value.')
      // a path no candidate has would count as 0 and eliminate every candidate, reported as "nothing feasible" (review P2): refuse it here
      const held = (/** @type {string} */ path) => Number.isFinite(Number(getPath(base, path))) || variables.some((entry) => entry.path === path) || explicit.some((entry) => Object.hasOwn(entry.set, path))
      rule.exceeds.forEach((path, j) => { if (PATH.test(path) && !held(path)) bad('campaign_value_invalid', `stages.analytic.eliminate[${i}].exceeds[${j}]`, `"${path}" is in neither the base scenario nor the candidates.`) })
      if (!(typeof rule.tolerance === 'number' && rule.tolerance >= 0 && rule.tolerance < 0.5)) bad('campaign_value_invalid', `stages.analytic.eliminate[${i}].tolerance`, 'A tolerance is from 0 to 0.5.')
    })
  }

  // budget and stop rules
  const budgetIn = object(src.budget)
  const budget = { maxCandidates: budgetIn.maxCandidates ?? null, cpuSeconds: budgetIn.cpuSeconds ?? null, modelCalls: budgetIn.modelCalls ?? 0 }
  if (!(Number.isInteger(budget.maxCandidates) && budget.maxCandidates >= 1 && budget.maxCandidates <= L.maxCandidates)) bad('campaign_budget_invalid', 'budget.maxCandidates', `A campaign evaluates 1 to ${L.maxCandidates} candidates.`)
  if (!(typeof budget.cpuSeconds === 'number' && budget.cpuSeconds > 0 && budget.cpuSeconds <= L.cpuSecondsMax)) bad('campaign_budget_invalid', 'budget.cpuSeconds', 'A campaign states its CPU-second budget.')
  if (!(Number.isInteger(budget.modelCalls) && budget.modelCalls >= 0 && budget.modelCalls <= L.modelCallsMax)) bad('campaign_budget_invalid', 'budget.modelCalls', `Model calls are 0 to ${L.modelCallsMax}.`)
  // A replicate budget turns the campaign's allocation sequential (`vcrCampaignAdvance`, "budgeted"): it is opt-in, and a manifest without it
  // keeps its canonical bytes and its fixed stage sizes.
  if (budgetIn.replicates != null) {
    if (!(Number.isInteger(budgetIn.replicates) && budgetIn.replicates >= 1 && budgetIn.replicates <= L.replicatesMax)) bad('campaign_budget_invalid', 'budget.replicates', `A replicate budget is 1 to ${L.replicatesMax}.`)
    else if (exact || !screening || robust) bad('campaign_budget_invalid', 'budget.replicates', 'A replicate budget needs a simulated search with a screening stage and no robust reading.')
    else /** @type {Record<string, any>} */ (budget).replicates = budgetIn.replicates
  }
  const evaluated = sample ? Math.min(sample.count, spaceSize) : spaceSize
  if (Number.isInteger(budget.maxCandidates) && evaluated > budget.maxCandidates) {
    bad('campaign_space_exceeds_budget', 'budget.maxCandidates', `The space has ${evaluated} candidates and the budget ${budget.maxCandidates}: narrow the space or sample it (space.sample).`)
  }
  const stopIn = object(src.stopRules)
  const stopRules = { maxConsecutiveFailures: stopIn.maxConsecutiveFailures ?? 3, minImprovement: stopIn.minImprovement == null ? null : stopIn.minImprovement }
  if (!(Number.isInteger(stopRules.maxConsecutiveFailures) && stopRules.maxConsecutiveFailures >= 1 && stopRules.maxConsecutiveFailures <= 10)) bad('campaign_value_invalid', 'stopRules.maxConsecutiveFailures', '1 to 10.')
  const referenceIn = src.reference ?? null
  if (referenceIn != null && !(Number.isInteger(referenceIn) && referenceIn >= 0 && referenceIn < spaceSize)) bad('campaign_value_invalid', 'reference', 'The reference is the index of a candidate in the space.')
  if (stopRules.minImprovement != null && !(typeof stopRules.minImprovement === 'number' && stopRules.minImprovement > 0 && referenceIn != null)) {
    bad('campaign_value_invalid', 'stopRules.minImprovement', 'A minimum improvement is a positive number over a declared reference candidate.')
  }
  const question = typeof src.question === 'string' ? src.question.slice(0, L.questionMax) : ''

  if (issues.length) return { manifest: null, issues }
  return { manifest: {
    schemaVersion: VCR_CAMPAIGN_SCHEMA_VERSION, question,
    objective, constraints,
    space: { method, version, scenario: base, truths, ...(variables.length ? { variables } : { candidates: explicit }), ...(sample ? { sample } : {}) },
    stages: { ...(analytic ? { analytic } : {}), screening, final },
    budget, stopRules, reference: referenceIn, ...(robust ? { robust } : {}),
  }, issues }
}

// ---------------------------------------------------------------------------
// The short form (R10)
// ---------------------------------------------------------------------------

/**
 * The short form of a design search, the one a conversation writes: the method, the base scenario (with the effect it is designed for),
 * what varies and the goal. `vcrSearchFromForm` compiles it into the full manifest input; the evaluator the manifest freezes (the null
 * world, the error-control constraint at the scenario's own alpha, the stage sizes, the budget) is written by code here and never by the
 * form, so a form can no more loosen the alpha than a manifest can. A manifest and a form are told apart by `space`.
 */
export const VCR_SEARCH_FORM_KEYS = Object.freeze(['question', 'method', 'scenario', 'scenarios', 'vary', 'goal', 'nullTruth', 'budget'])
const FORM_SCENARIO_KEYS = Object.freeze(['name', 'effect', 'world', 'weight'])
const FORM_GOAL_KEYS = Object.freeze(['minimize', 'maximize', 'power', 'atLeast', 'atMost'])
/** CPU seconds a candidate is budgeted by method (screening on both worlds, or one unit at the engine's floor), and a finalist's check. */
const FORM_COST = Object.freeze({
  'design.simulate': Object.freeze({ candidate: 4, finalist: 80 }),
  'design.dose': Object.freeze({ candidate: 20, finalist: 60 }),
  'patients.progression': Object.freeze({ candidate: 40, finalist: 0 }),
  'design.analytic': Object.freeze({ candidate: 1, finalist: 0 }),
})
export const VCR_SEARCH_FORM_DEFAULTS = Object.freeze({ power: 0.8, screeningReplicates: 500, finalCount: 3 })

/**
 * The values of one varied path: a list as written, or {from, to, step} expanded by code.
 * @param {unknown} spec @param {(code: string, field: string, detail: string) => void} bad @param {string} field
 */
function formValues(spec, bad, field) {
  if (Array.isArray(spec)) return spec
  const range = object(spec)
  const { from, to, step } = range
  if (![from, to, step].every((x) => typeof x === 'number' && Number.isFinite(x)) || step <= 0 || to < from) {
    bad('search_form_vary', field, 'A varied path is a list of values or {from, to, step} with a positive step and to at least from.')
    return []
  }
  const count = Math.floor((to - from) / step + 1e-9) + 1
  if (count > VCR_CAMPAIGN_LIMITS.maxValues) { bad('search_form_vary', field, `A range gives at most ${VCR_CAMPAIGN_LIMITS.maxValues} values; this one gives ${count}.`); return [] }
  return Array.from({ length: count }, (_, i) => Math.round((from + i * step) * 1e9) / 1e9)
}

/**
 * Compile the short form of a design search into the full manifest input, ready for `vcrCampaignManifest`. Pure and deterministic.
 * @param {unknown} input
 * @returns {{ input: Record<string, any> | null, issues: Array<{ code: string, field: string, detail: string }> }}
 */
export function vcrSearchFromForm(input) {
  /** @type {Array<{ code: string, field: string, detail: string }>} */
  const issues = []
  const bad = (/** @type {string} */ code, /** @type {string} */ field, /** @type {string} */ detail) => { issues.push({ code, field, detail }) }
  const form = object(input)
  for (const key of Object.keys(form)) {
    if (!VCR_SEARCH_FORM_KEYS.includes(key)) bad('search_form_field_unknown', key, `The short form takes ${VCR_SEARCH_FORM_KEYS.join(', ')}; "${key}" is read by nothing (a full manifest states space).`)
  }
  const method = typeof form.method === 'string' ? form.method : 'design.simulate'
  const info = /** @type {Record<string, any>} */ (VCR_CAMPAIGN_METHODS)[method]
  if (!info) bad('campaign_method_unsupported', 'method', `A search covers ${Object.keys(VCR_CAMPAIGN_METHODS).join(', ')}.`)
  const base = clone(object(form.scenario))
  if (!Object.keys(base).length) bad('search_form_scenario', 'scenario', 'The form states the base scenario every design starts from, with the effect it is designed for.')

  // the worlds: the effect the design is for, and the world without it (which holds the type I error)
  const goalIn = object(form.goal)
  for (const key of Object.keys(goalIn)) if (!FORM_GOAL_KEYS.includes(key)) bad('search_form_field_unknown', `goal.${key}`, `A goal takes ${FORM_GOAL_KEYS.join(', ')}.`)
  const directions = ['minimize', 'maximize'].filter((key) => goalIn[key] !== undefined)
  if (directions.length !== 1 || typeof goalIn[directions[0]] !== 'string') bad('search_form_goal', 'goal', 'A goal minimizes or maximizes exactly one measure: {minimize: "expected_sample_size"}.')
  const errorControlled = method === 'design.simulate' || method === 'patients.progression'
  /** @type {Array<{ name: string, truth: Record<string, any> }>} */
  let truths = []
  /** @type {string} */
  let effectName = 'alternative'
  if (info && Object.keys(base).length) {
    if (method === 'patients.progression') {
      effectName = 'drug'
      truths = [{ name: 'drug', truth: object(base.treatment) }, { name: 'none', truth: {} }]
      if (vcrDiseaseHypothesis(base.treatment) === 'none') bad('search_form_scenario', 'scenario.treatment', 'State the drug hypothesis the trial is designed to detect in scenario.treatment.')
      delete base.treatment
    } else if (errorControlled) {
      const nullTruth = form.nullTruth != null ? object(form.nullTruth) : vcrNullTruth(base)
      if (vcrIsNullScenario(base)) bad('search_form_scenario', 'scenario.truth', 'The base scenario states no effect; a search designs for the effect it must detect.')
      else if (!nullTruth) bad('search_form_null_truth', 'nullTruth', 'The world without an effect cannot be derived for this design: state it in nullTruth (the same truth keys with no effect).')
      else truths = [{ name: 'alternative', truth: object(base.truth) }, { name: 'null', truth: nullTruth }]
    } else {
      effectName = method === 'design.analytic' ? 'planned' : 'curve'
      truths = [{ name: effectName, truth: object(base.truth) }]
    }
  }
  // Several effect scenarios (R34): each names the effect it assumes (the truth keys that differ from the base scenario's, or for patients.progression
  // the drug hypothesis), optionally the world around it and a weight; one is named `base` and is the one the objective is judged under. The scenario
  // list replaces the single effect world; the world without an effect stays what code derived.
  if (form.scenarios !== undefined && truths.length) {
    const scenariosIn = list(form.scenarios)
    const nullEntry = truths.find((entry) => entry.name === 'null' || entry.name === 'none')
    const baseEffect = truths.find((entry) => entry !== nullEntry)?.truth ?? {}
    if (!Array.isArray(form.scenarios) || scenariosIn.length < 2) bad('search_form_scenarios', 'scenarios', 'Scenarios are a list of two or more effect assumptions, each {name, effect, world?, weight?}, one of them named "base".')
    else if (!scenariosIn.some((entry) => object(entry).name === 'base')) bad('search_form_scenarios', 'scenarios', 'One scenario is named "base": the assumption the objective is judged under.')
    else if (!info?.measures || !Object.hasOwn(info.measures, 'power')) bad('search_form_scenarios', 'scenarios', `${method} measures no power, so its scenarios cannot be compared.`)
    else {
      const built = scenariosIn.map((raw, i) => {
        const entry = object(raw)
        for (const key of Object.keys(entry)) if (!FORM_SCENARIO_KEYS.includes(key)) bad('search_form_field_unknown', `scenarios[${i}].${key}`, `A scenario takes ${FORM_SCENARIO_KEYS.join(', ')}.`)
        // a drug hypothesis replaces the base one; a truth states only what differs from the base truth
        const truth = method === 'patients.progression' ? object(entry.effect ?? baseEffect) : { ...baseEffect, ...object(entry.effect) }
        return { name: String(entry.name ?? ''), truth, ...(entry.world == null ? {} : { world: entry.world }), ...(entry.weight == null ? {} : { weight: entry.weight }) }
      })
      effectName = 'base'
      truths = [...built, ...(nullEntry ? [nullEntry] : [])]
    }
  }
  const nullName = truths.find((entry) => entry.name === 'null' || entry.name === 'none')?.name

  // what varies: one path each, or several that move together ("design.nTreat+design.nControl")
  const varyIn = object(form.vary)
  const entries = Object.entries(varyIn)
  if (!entries.length) bad('search_form_vary', 'vary', 'The form states what varies: {"design.nTreat": [80, 120, 160]} or a range {from, to, step}.')
  const together = entries.some(([key]) => key.includes('+'))
  /** @type {Array<{ paths: string[], values: any[] }>} */
  const varied = entries.map(([key, spec]) => ({ paths: key.split('+'), values: formValues(spec, bad, `vary.${key}`) }))
  for (const entry of varied) {
    if (entry.paths.length > 1 && !entry.values.every((row) => Array.isArray(row) && row.length === entry.paths.length)) {
      bad('search_form_vary', `vary.${entry.paths.join('+')}`, `Paths that move together take one list of rows, each with ${entry.paths.length} values.`)
    }
  }
  const size = varied.reduce((n, entry) => n * Math.max(1, entry.values.length), 1)
  if (size > VCR_CAMPAIGN_LIMITS.maxCandidates) bad('campaign_space_exceeds_budget', 'vary', `The ranges make ${size} designs and a search evaluates at most ${VCR_CAMPAIGN_LIMITS.maxCandidates}: narrow a range or take a coarser step.`)

  // the goal: the measure, and what a design must still meet
  /** @type {Array<Record<string, any>>} */
  const constraints = []
  const design = method === 'design.dose' ? 'safety' : 'design'
  if (goalIn.power !== undefined && !errorControlled) bad('search_form_goal', 'goal.power', 'goal.power is for a simulated comparison; state a requirement of this design in atLeast.')
  if (errorControlled) {
    const power = goalIn.power ?? (goalIn.minimize === 'power' || goalIn.maximize === 'power' || goalIn.atLeast?.power !== undefined ? null : VCR_SEARCH_FORM_DEFAULTS.power)
    if (power !== null) {
      if (!(typeof power === 'number' && power > 0 && power < 1)) bad('search_form_goal', 'goal.power', 'The power a design must reach is a number between 0 and 1.')
      else constraints.push({ measure: 'power', op: '>=', bound: power, kind: 'design', truth: effectName })
    }
  }
  for (const [key, op] of [['atLeast', '>='], ['atMost', '<=']]) {
    for (const [measure, bound] of Object.entries(object(goalIn[key]))) constraints.push({ measure, op, bound, kind: design, truth: effectName })
  }
  if (errorControlled && nullName) {
    // the frozen constraint: the nominal level of the analysis, never a number the form chooses
    const alpha = typeof base.analysis?.alpha === 'number' ? base.analysis.alpha : info.defaultAlpha ?? 0.025
    constraints.push({ measure: 'type_one_error', op: '<=', bound: alpha, kind: 'error_control', truth: nullName })
  }

  // stages and budget: sized by code from the space
  const exact = info?.exact === true
  const candidates = Math.min(size, VCR_CAMPAIGN_LIMITS.maxCandidates)
  const finalCount = Math.min(VCR_SEARCH_FORM_DEFAULTS.finalCount, Math.max(1, candidates))
  const budgetIn = object(form.budget)
  // a stated replicate budget sizes the first stages by one rule (`vcrCampaignBudgetPlan`) and lets the allocation spend the rest
  const plan = Number.isInteger(budgetIn.replicates) && !exact ? vcrCampaignBudgetPlan({ candidates, replicates: budgetIn.replicates, method }) : null
  const stages = { screening: exact || info?.precisionBlock === false ? null : { replicates: plan?.screeningReplicates ?? VCR_SEARCH_FORM_DEFAULTS.screeningReplicates }, final: { count: plan ? Math.min(plan.finalCount, finalCount) : finalCount } }
  const cost = /** @type {Record<string, any>} */ (FORM_COST)[method] ?? { candidate: 20, finalist: 60 }
  for (const key of Object.keys(budgetIn)) if (!['maxCandidates', 'cpuSeconds', 'replicates'].includes(key)) bad('search_form_field_unknown', `budget.${key}`, 'A budget takes maxCandidates, cpuSeconds and replicates.')
  const budget = { maxCandidates: budgetIn.maxCandidates ?? candidates, cpuSeconds: budgetIn.cpuSeconds ?? Math.ceil(candidates * cost.candidate + finalCount * cost.finalist + 60), modelCalls: 0,
    ...(budgetIn.replicates != null ? { replicates: budgetIn.replicates } : {}) }

  if (issues.length) return { input: null, issues }
  const space = { method, scenario: base, truths,
    ...(together
      ? { candidates: varied.reduce((rows, entry) => rows.flatMap((row) => entry.values.map((value) => ({ ...row, ...Object.fromEntries(entry.paths.map((path, i) => [path, entry.paths.length > 1 ? value[i] : value])) }))), [{}]).map((set) => ({ set })) }
      : { variables: varied.map((entry) => ({ path: entry.paths[0], values: entry.values })) }) }
  return { input: { question: typeof form.question === 'string' ? form.question : '', objective: { measure: goalIn[directions[0]], direction: directions[0], truth: effectName },
    constraints, space, stages, budget }, issues }
}

/**
 * The one entry a campaign is started from: a full manifest is frozen as it is, a short form is compiled first. Either way the result is
 * `vcrCampaignManifest`'s, so the evaluator's rules are the same for both.
 * @param {unknown} input
 * @returns {{ manifest: Record<string, any> | null, issues: Array<{ code: string, field: string, detail: string }>, compiled: boolean }}
 */
export function vcrCampaignFromInput(input) {
  if (Object.hasOwn(object(input), 'space')) return { ...vcrCampaignManifest(input), compiled: false }
  const { input: full, issues } = vcrSearchFromForm(input)
  if (!full) return { manifest: null, issues, compiled: true }
  return { ...vcrCampaignManifest(full), compiled: true }
}

/** The canonical bytes a campaign's identity is the sha256 of. @param {Record<string, any>} manifest */
export function vcrCampaignCanonical(manifest) {
  return canonicalScenarioJson({ campaign: VCR_CAMPAIGN_SCHEMA_VERSION, manifest })
}

// ---------------------------------------------------------------------------
// Candidates, units and seeds
// ---------------------------------------------------------------------------

/** A seeded uniform generator (mulberry32): the random subset of a space is a pure function of its seed. @param {number} seed */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The candidates in the order they are evaluated: the cartesian product of the variables (the first varies slowest) or the explicit
 * list, optionally a seeded random subset kept in space order. Each has a stable key (`c007`), its index in the space and what it sets.
 * @param {Record<string, any>} manifest
 * @returns {Array<{ key: string, index: number, name: string | null, set: Record<string, any> }>}
 */
export function vcrCampaignCandidates(manifest) {
  const space = object(manifest.space)
  /** @type {Array<{ index: number, name: string | null, set: Record<string, any> }>} */
  let all = []
  if (list(space.variables).length) {
    const vars = list(space.variables)
    const total = vars.reduce((n, entry) => n * entry.values.length, 1)
    for (let index = 0; index < total; index++) {
      /** @type {Record<string, any>} */
      const set = {}
      let rest = index
      for (let v = vars.length - 1; v >= 0; v--) {
        const size = vars[v].values.length
        set[vars[v].path] = vars[v].values[rest % size]
        rest = Math.floor(rest / size)
      }
      all.push({ index, name: null, set: Object.fromEntries(vars.map((entry) => [entry.path, set[entry.path]])) })
    }
  } else {
    all = list(space.candidates).map((entry, index) => ({ index, name: entry.name ?? null, set: object(entry.set) }))
  }
  if (space.sample) {
    const random = mulberry32(space.sample.seed)
    const keys = all.map((entry) => ({ entry, u: random() }))
    keys.sort((a, b) => a.u - b.u || a.entry.index - b.entry.index)
    const kept = new Set(keys.slice(0, space.sample.count).map((item) => item.entry.index))
    if (manifest.reference != null) kept.add(manifest.reference)
    all = all.filter((entry) => kept.has(entry.index))
  }
  const width = Math.max(3, String(Math.max(0, ...all.map((entry) => entry.index))).length)
  return all.map((entry) => ({ key: `c${String(entry.index).padStart(width, '0')}`, ...entry }))
}

/**
 * The scenario a unit runs: the base, the candidate's settings, the named truth and, for a simulated method, the precision block.
 * @param {Record<string, any>} manifest @param {{ set: Record<string, any> }} candidate @param {string} truthName @param {'screening' | 'final'} stage
 */
export function vcrCandidateScenario(manifest, candidate, truthName, stage) {
  const scenario = clone(object(manifest.space?.scenario))
  for (const [path, value] of Object.entries(object(candidate.set))) setPath(scenario, path, value)
  const truth = list(manifest.space?.truths).find((entry) => entry.name === truthName)
  const info = /** @type {Record<string, any>} */ (VCR_CAMPAIGN_METHODS)[manifest.space.method]
  if (truth) for (const [path, value] of Object.entries(object(truth.world))) setPath(scenario, path, value)
  if (truth) scenario[info?.truthField ?? 'truth'] = clone(truth.truth)
  if (!info?.exact && info?.precisionBlock !== false && vcrEvaluationAllowed(manifest.space.method, scenario)) {
    scenario.evaluation = stage === 'screening'
      ? { version: VCR_SCREENING.version, screeningReplicates: manifest.stages.screening.replicates }
      : { version: VCR_SCREENING.version }
  }
  return scenario
}

/**
 * The key of the draws a scenario consumes: candidates with the same key may share a seed and be compared pairwise. Only
 * design.simulate has one (its generator draws a fixed number of uniforms per subject whatever the truth or the analysis); any other
 * method's candidates each draw on their own.
 * @param {Record<string, any>} manifest @param {{ key: string, set: Record<string, any> }} candidate
 */
export function vcrCampaignDrawKey(manifest, candidate) {
  if (manifest.space?.method !== 'design.simulate') return `own:${candidate.key}`
  const scenario = clone(object(manifest.space.scenario))
  for (const [path, value] of Object.entries(object(candidate.set))) setPath(scenario, path, value)
  for (const path of DRAW_NEUTRAL) deletePath(scenario, path)
  return `draws:${canonicalScenarioJson(scenario)}`
}

/** 32-bit FNV-1a of a string. @param {string} text */
function fnv1a(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

/**
 * The seed of a unit: a function of the campaign's identity, the stage, the truth and the draw key, inside the protocol's range.
 * Screening and final seeds differ for every candidate (the finalists' check uses streams no screening unit used).
 * @param {string} identity @param {string} stage @param {string} truth @param {string} drawKey
 */
export function vcrCampaignSeed(identity, stage, truth, drawKey) {
  return fnv1a(`vcr-campaign-seed-v1|${identity}|${stage}|${truth}|${drawKey}`) % 2_147_483_647
}

/**
 * Every unit of work a candidate may need, keyed `<candidate>:<stage>:<truth>`; an analytic pre-check unit is keyed `analytic:<n>`
 * and shared by every candidate whose applied paths agree.
 * @param {Record<string, any>} manifest @param {string} identity @param {{ key: string, index: number, set: Record<string, any> }} candidate
 * @param {'screening' | 'final'} stage @param {string} truth
 * @param {{ round?: number, replicates?: number }} [escalation] a budgeted campaign's fresh re-run of a final evaluation, on a stream of its own
 */
export function vcrCampaignUnit(manifest, identity, candidate, stage, truth, escalation = {}) {
  const round = Number.isInteger(escalation.round) && /** @type {number} */ (escalation.round) > 0 ? /** @type {number} */ (escalation.round) : 0
  const method = manifest.space.method
  const kind = Object.keys(VCR_JOB_METHODS).find((key) => /** @type {Record<string, string>} */ (VCR_JOB_METHODS)[key] === method)
  const drawKey = vcrCampaignDrawKey(manifest, candidate)
  return {
    key: `${candidate.key}:${stage}:${truth}${round ? `:r${round}` : ''}`, candidate: candidate.key, stage, truth, method, version: manifest.space.version, kind,
    ...(round ? { round } : {}),
    scenario: vcrCandidateScenario(manifest, candidate, truth, stage),
    // scenarios of a robust reading draw on one stream (common random numbers): they differ by what is assumed, never by luck
    seed: vcrCampaignSeed(identity, round ? `${stage}-r${round}` : stage, manifest.robust ? '*' : truth, drawKey),
    replicates: Number.isInteger(escalation.replicates) ? /** @type {number} */ (escalation.replicates)
      : stage === 'final' && Number.isInteger(manifest.stages.final.replicates) ? manifest.stages.final.replicates : null,
    idempotencyKey: `vcr-campaign:${identity.slice(0, 24)}:${candidate.key}:${stage}:${truth}${round ? `:r${round}` : ''}`,
  }
}

/** The analytic pre-check scenario of a candidate, and the key of the unit it shares. @param {Record<string, any>} manifest @param {{ set: Record<string, any> }} candidate */
export function vcrCampaignAnalyticScenario(manifest, candidate) {
  const analytic = object(manifest.stages?.analytic)
  const scenario = clone(object(analytic.scenario))
  for (const path of list(analytic.apply)) if (Object.hasOwn(object(candidate.set), path)) setPath(scenario, path, candidate.set[path])
  return { scenario, key: `analytic:${fnv1a(canonicalScenarioJson(scenario)).toString(16).padStart(8, '0')}` }
}

/**
 * The measures a scenario states about itself, which the engine does not report: for the disease trial the number of people enrolled and
 * the week of the last visit. They are arithmetic on the frozen scenario (never estimated), so a search can minimize the first under a
 * power bound; a unit that failed still carries them, and a method with none returns nothing.
 * @param {string} method @param {Record<string, any>} scenario
 */
export function vcrScenarioDerivedMeasures(method, scenario) {
  if (method !== 'patients.progression') return []
  const n = Number(object(scenario.design).nTreat) + Number(object(scenario.design).nControl)
  const visits = list(scenario.visits).map(Number).filter(Number.isFinite)
  return [
    ...(Number.isFinite(n) ? [{ name: 'total_sample_size', value: n, mcse: null, simulated: false, source: 'calculated' }] : []),
    ...(visits.length ? [{ name: 'last_visit_weeks', value: Math.max(...visits), mcse: null, simulated: false, source: 'calculated' }] : []),
  ]
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** ln Γ(x) by Lanczos (g = 7, nine terms), x > 0. @param {number} x @returns {number} */
function lgamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** The continued fraction of the incomplete beta (modified Lentz). @param {number} x @param {number} a @param {number} b */
function betacf(x, a, b) {
  const tiny = 1e-300
  let c = 1, d = 1 - (a + b) * x / (a + 1)
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 10_000; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2))
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny
    d = 1 / d; h *= d * c
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1))
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-16) break
  }
  return h
}

/** The regularized incomplete beta I_x(a, b). @param {number} x @param {number} a @param {number} b */
export function vcrRegularizedBeta(x, a, b) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log1p(-x))
  return x < (a + 1) / (a + b + 2) ? front * betacf(x, a, b) / a : 1 - front * betacf(1 - x, b, a) / b
}

/** The p-quantile of Beta(a, b) by bisection on the regularized incomplete beta (deterministic, ~1e-15). @param {number} p @param {number} a @param {number} b */
export function vcrBetaQuantile(p, a, b) {
  let lo = 0, hi = 1
  for (let i = 0; i < 200 && hi - lo > 1e-16; i++) {
    const mid = (lo + hi) / 2
    if (vcrRegularizedBeta(mid, a, b) < p) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * The exact one-sided Clopper–Pearson bounds of a binomial proportion at `confidence`: the lower bound is a one-sided lower bound at
 * that confidence and the upper bound a one-sided upper bound at that confidence (each, not jointly).
 * @param {number} k @param {number} n @param {number} confidence
 */
export function vcrClopperPearson(k, n, confidence) {
  const tail = 1 - confidence
  return {
    lower: k <= 0 ? 0 : vcrBetaQuantile(tail, k, n - k + 1),
    upper: k >= n ? 1 : vcrBetaQuantile(confidence, k + 1, n - k),
  }
}

/** The standard normal quantile (Wichura's AS 241, PPND16). @param {number} p */
export function vcrNormalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new RangeError('vcrNormalQuantile: p is in (0, 1)')
  const q = p - 0.5
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q
    return q * (((((((2509.0809287301227 * r + 33430.57558358813) * r + 67265.7709270087) * r + 45921.95393154987) * r
      + 13731.69376550946) * r + 1971.5909503065513) * r + 133.14166789178438) * r + 3.3871328727963665)
      / (((((((5226.495278852546 * r + 28729.085735721943) * r + 39307.89580009271) * r + 21213.794301586597) * r
      + 5394.196021424751) * r + 687.1870074920579) * r + 42.31333070160091) * r + 1)
  }
  let r = q < 0 ? p : 1 - p
  r = Math.sqrt(-Math.log(r))
  let value
  if (r <= 5) {
    r -= 1.6
    value = (((((((7.745450142783414e-4 * r + 0.022723844989269184) * r + 0.2417807251774506) * r + 1.2704582524523684) * r
      + 3.6478483247632045) * r + 5.769497221460691) * r + 4.630337846156546) * r + 1.4234371107496835)
      / (((((((1.0507500716444169e-9 * r + 5.475938084995345e-4) * r + 0.015198666563616457) * r + 0.14810397642748008) * r
      + 0.6897673349851) * r + 1.6763848301838038) * r + 2.053191626637759) * r + 1)
  } else {
    r -= 5
    value = (((((((2.0103343992922881e-7 * r + 2.7115555687434876e-5) * r + 0.0012426609473880784) * r + 0.026532189526576124) * r
      + 0.29656057182850487) * r + 1.7848265399172913) * r + 5.463784911164114) * r + 6.657904643501103)
      / (((((((2.0442631033899397e-15 * r + 1.421511758316446e-7) * r + 1.8463183175100548e-5) * r + 7.868691311456133e-4) * r
      + 0.014875361290850615) * r + 0.1369298809227358) * r + 0.599832206555888) * r + 1)
  }
  return q < 0 ? -value : value
}

// ---------------------------------------------------------------------------
// Judging an evaluation
// ---------------------------------------------------------------------------

/**
 * The measure of an evaluation, by name: `{ value, mcse, simulated, source, precision }` or null.
 * @param {Record<string, any> | null | undefined} evaluation @param {string} name
 */
export function vcrEvaluationMeasure(evaluation, name) {
  const found = list(evaluation?.measures).find((measure) => object(measure).name === name)
  return found ? object(found) : null
}

/**
 * The verdict of one constraint on one evaluation. `stage` is the stage the verdict is for: a measure at screening precision is
 * never judged for the final stage (`screening_result_not_final`), and a verdict at screening stage is provisional.
 * @param {Record<string, any>} manifest @param {Record<string, any>} constraint
 * @param {Record<string, any> | null | undefined} evaluation the unit's outcome (`measures`, `replicates`, `precision`, `state`)
 * @param {{ stage: 'screening' | 'final' }} options
 * @returns {Record<string, any>} `{ status, final, reason?, estimate?, mcse?, bound? }`
 */
export function vcrJudgeConstraint(manifest, constraint, evaluation, { stage }) {
  if (!evaluation || evaluation.state !== 'succeeded') return { status: 'not_judged', final: false, reason: evaluation ? 'evaluation_failed' : 'not_evaluated' }
  const screeningMeasure = (/** @type {any} */ m) => object(m).precision === 'screening'
  const measure = vcrEvaluationMeasure(evaluation, constraint.measure)
  if (!measure) return { status: 'not_judged', final: false, reason: 'measure_missing' }
  if (stage === 'final' && (evaluation.precision === 'screening' || screeningMeasure(measure))) {
    return { status: 'not_judged', final: false, reason: 'screening_result_not_final' }
  }
  if (stage !== 'final' && constraint.kind === 'error_control') return { status: 'not_judged', final: false, reason: 'error_control_judged_at_final' }
  const type = /** @type {Record<string, any>} */ (VCR_CAMPAIGN_METHODS)[manifest.space.method]?.measures?.[constraint.measure]
  const value = Number(measure.value)
  const le = constraint.op === '<='
  const finalVerdict = stage === 'final'
  const verdict = (/** @type {number} */ lower, /** @type {number} */ upper, /** @type {Record<string, any>} */ bound) => {
    const passes = le ? upper <= constraint.bound : lower >= constraint.bound
    const fails = le ? lower > constraint.bound : upper < constraint.bound
    const status = passes ? 'pass' : fails ? 'fail' : 'inconclusive'
    return { status, final: finalVerdict, estimate: value, mcse: measure.mcse ?? null, bound: { ...bound, lower, upper },
      ...(status === 'inconclusive' ? { needed: neededPrecision(value, measure, constraint, type, Number(evaluation.replicates)) } : {}) }
  }
  if (type === 'exact' || (measure.simulated !== true && measure.mcse == null)) {
    return verdict(value, value, { kind: 'exact', confidence: null })
  }
  if (type === 'proportion' || type === 'error_rate') {
    const n = Number(evaluation.replicates)
    const k = Math.round(value * n)
    if (Number.isInteger(n) && n >= 1 && Math.abs(k / n - value) <= 1e-9) {
      const cp = vcrClopperPearson(k, n, constraint.confidence)
      // A test whose size is exact under the simulated model (`VCR_EXACT_CALIBRATIONS`, `vcrNominalErrorControl`) controls its type I
      // error by construction; the simulation can then only contradict it: a lower bound above the bound is a fail, anything else rests
      // on the test's nominal level. Any other test asked to rest on its level is held to the simulation's bound, and says why.
      const calibration = typeof evaluation.nominalControl === 'string' && VCR_EXACT_CALIBRATIONS.includes(evaluation.nominalControl) ? evaluation.nominalControl : null
      if (constraint.kind === 'error_control' && constraint.analyticSupport === true && calibration) {
        return { status: cp.lower > constraint.bound ? 'fail' : 'pass', final: finalVerdict, estimate: value, mcse: measure.mcse ?? null,
          bound: { kind: 'nominal_level', calibration, confidence: constraint.confidence, events: k, trials: n, lower: cp.lower, upper: cp.upper } }
      }
      return verdict(cp.lower, cp.upper, { kind: 'clopper_pearson', confidence: constraint.confidence, events: k, trials: n,
        ...(constraint.kind === 'error_control' && constraint.analyticSupport === true ? { nominalNotExact: true } : {}) })
    }
  }
  const mcse = Number(measure.mcse)
  if (!(mcse >= 0)) return { status: 'not_judged', final: false, reason: 'mcse_missing' }
  if (mcse === 0) return verdict(value, value, { kind: 'degenerate', confidence: null })
  const z = vcrNormalQuantile(constraint.confidence)
  return verdict(value - z * mcse, value + z * mcse, { kind: 'normal', confidence: constraint.confidence })
}

/**
 * Which exact calibration a design.simulate scenario's test has under the engine's model, or null: the pooled two-sample t-test of a
 * fixed two-arm design on a continuous endpoint, whose outcome the engine draws normal with one SD in both arms (`truth.sd`), has size
 * exactly alpha (a non-inferiority margin shifts its null and keeps that). Every other test (the score z of a risk difference,
 * Farrington–Manning, the log-rank, a group-sequential log-rank, a weighted test, an RMST analysis, a single-arm or external-control
 * design) is asymptotic or simulated, and its type I error is held to the simulation's bound alone (review stats P1-2).
 * @param {Record<string, any>} scenario
 * @returns {string | null}
 */
export function vcrNominalErrorControl(scenario) {
  const kind = scenario?.design?.kind ?? 'two_arm_fixed'
  const endpoint = scenario?.endpoint?.type
  const method = scenario?.analysis?.method ?? ({ continuous: 'ttest', binary: 'risk_difference', time_to_event: 'logrank' })[/** @type {string} */ (endpoint)]
  return kind === 'two_arm_fixed' && endpoint === 'continuous' && method === 'ttest' ? 'pooled_t_equal_sd_normal' : null
}

/**
 * How much precision would decide an inconclusive verdict: the replicates at which the same estimate's bound would clear the constraint
 * (the Monte-Carlo error falls with the square root of the replicates), or `null` with the reason when no number of replicates would
 * (the estimate sits on the bound, or the measure is exact). For a proportion the normal approximation of its binomial error is used;
 * the Clopper–Pearson bound needs a few more, so this is a lower guide, never a promise.
 * @param {number} value @param {Record<string, any>} measure @param {Record<string, any>} constraint @param {string | undefined} type
 * @param {number} replicates
 */
function neededPrecision(value, measure, constraint, type, replicates) {
  const gap = Math.abs(value - Number(constraint.bound))
  if (!(gap > 1e-12)) return { replicates: null, reason: 'estimate_at_bound' }
  const z = vcrNormalQuantile(Number(constraint.confidence ?? 0.975))
  if (type === 'proportion' || type === 'error_rate') {
    const variance = value * (1 - value)
    if (!(variance > 0)) return { replicates: null, reason: 'estimate_at_bound' }
    return { replicates: Math.ceil(z * z * variance / (gap * gap)), reason: null }
  }
  const mcse = Number(measure.mcse)
  if (!(mcse > 0) || !(replicates >= 1)) return { replicates: null, reason: 'precision_unknown' }
  return { replicates: Math.ceil(replicates * (z * mcse / gap) ** 2), reason: null }
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/** A fresh campaign state. @param {Record<string, any>} manifest @returns {Record<string, any>} */
export function vcrCampaignInitialState(manifest) {
  const candidates = vcrCampaignCandidates(manifest)
  return {
    schemaVersion: VCR_CAMPAIGN_SCHEMA_VERSION,
    candidates: Object.fromEntries(candidates.map((candidate) => [candidate.key, { status: 'pending', reason: null, evaluations: {} }])),
    analytic: {}, inFlight: null, finalists: null, consecutiveFailures: 0, unitsEvaluated: 0,
    usage: { cpuSeconds: 0, queueSeconds: 0, wallSeconds: 0, replicatesCompleted: 0, modelCalls: 0 },
    cancelRequested: false, stop: null,
  }
}

/** The truths the final stage evaluates: every truth the objective or a constraint names (every named truth when the reading is robust). @param {Record<string, any>} manifest */
function finalTruths(manifest) {
  // a robust reading reports the operating characteristics of every named world, the null one's type I error included
  return [...new Set([manifest.objective.truth, ...list(manifest.constraints).map((c) => c.truth), ...(manifest.robust ? list(manifest.space?.truths).map((t) => t.name) : [])])]
}

/** @param {Record<string, any>} manifest @param {string} stage */
function stageTruths(manifest, stage) {
  return stage === 'screening' ? list(manifest.stages.screening?.truths) : finalTruths(manifest)
}

/**
 * The objective estimate of a candidate at a stage, or null.
 * @param {Record<string, any>} manifest @param {Record<string, any>} entry @param {string} stage
 */
function objectiveOf(manifest, entry, stage) {
  const evaluation = object(entry.evaluations)[`${stage}:${manifest.objective.truth}`]
  const measure = vcrEvaluationMeasure(evaluation, manifest.objective.measure)
  // a measure with no finite value ranks nowhere: NaN would compare false both ways and could sort first as the best
  return evaluation?.state === 'succeeded' && measure && measure.value != null && Number.isFinite(Number(measure.value)) ? { value: Number(measure.value), mcse: measure.mcse ?? null } : null
}

/** Better first, then the space order. @param {Record<string, any>} manifest */
const byObjective = (manifest) => (/** @type {any} */ a, /** @type {any} */ b) =>
  (manifest.objective.direction === 'minimize' ? a.value - b.value : b.value - a.value) || a.index - b.index

/**
 * Every constraint's verdict for a candidate at a stage.
 * @param {Record<string, any>} manifest @param {Record<string, any>} entry @param {'screening' | 'final'} stage
 * @returns {Array<Record<string, any>>}
 */
export function vcrCandidateVerdicts(manifest, entry, stage) {
  return list(manifest.constraints).map((constraint, index) => ({ index, measure: constraint.measure, kind: constraint.kind, op: constraint.op,
    bound: constraint.bound, truth: constraint.truth,
    ...vcrJudgeConstraint(manifest, constraint, object(entry.evaluations)[`${stage}:${constraint.truth}`], { stage }) }))
}

/**
 * Record a finished unit and return the next state (pure). A failed unit counts towards the consecutive-failure stop; an unsupported
 * one (refused by validation before it ran) marks its candidate unsupported and does not. A cancelled unit is neither: whoever
 * cancelled it, the campaign is being stopped (`cancelRequested`), so the next decision is `user_cancellation`, never the next
 * candidate (review eng P1-2).
 * @param {Record<string, any>} manifest @param {Record<string, any>} state
 * @param {{ key: string, candidate?: string, stage: string, truth?: string }} unit
 * @param {Record<string, any>} outcome `{ jobId, state, measures, replicates, precision, cpuSeconds, queueSeconds, wallSeconds, issues, unsupported?, drawSignature?, rejects?, resultId? }`
 */
export function vcrCampaignRecord(manifest, state, unit, outcome) {
  const next = clone(state)
  const evaluation = {
    jobId: outcome.jobId ?? null, resultId: outcome.resultId ?? null, state: outcome.state, seed: outcome.seed ?? null,
    replicates: outcome.replicates ?? null, precision: outcome.precision ?? (unit.stage === 'screening' ? 'screening' : unit.stage === 'analytic' ? 'exact' : 'final'),
    measures: [...list(outcome.measures), ...vcrScenarioDerivedMeasures(manifest.space.method, object(/** @type {any} */ (unit).scenario))].map((m) => ({ name: m.name, value: m.value, mcse: m.mcse ?? null, simulated: m.simulated === true, source: m.source ?? null,
      ...(m.precision ? { precision: m.precision } : {}) })),
    cpuSeconds: Number(outcome.cpuSeconds ?? 0) || 0, queueSeconds: Number(outcome.queueSeconds ?? 0) || 0, wallSeconds: Number(outcome.wallSeconds ?? 0) || 0,
    issues: list(outcome.issues).slice(0, 5).map(String), drawSignature: outcome.drawSignature ?? null, rejects: outcome.rejects ?? null,
    nominalControl: unit.stage === 'final' && manifest.space.method === 'design.simulate' ? vcrNominalErrorControl(object(/** @type {any} */ (unit).scenario)) : null,
  }
  next.inFlight = null
  next.unitsEvaluated += 1
  next.usage.cpuSeconds += evaluation.cpuSeconds
  next.usage.queueSeconds += evaluation.queueSeconds
  next.usage.wallSeconds += evaluation.wallSeconds
  next.usage.replicatesCompleted += Number.isInteger(evaluation.replicates) ? evaluation.replicates : 0
  const canceled = outcome.state === 'canceled'
  if (canceled) next.cancelRequested = true
  if (unit.stage === 'analytic') {
    next.analytic[unit.key] = evaluation
    next.consecutiveFailures = outcome.state === 'succeeded' ? 0 : outcome.unsupported || canceled ? next.consecutiveFailures : next.consecutiveFailures + 1
    return next
  }
  const entry = next.candidates[/** @type {string} */ (unit.candidate)]
  if (!entry) return next
  // a fresh re-run (budgeted campaign) replaces the evaluation a verdict reads; the one it replaces stays on the record
  const evaluationKey = `${unit.stage}:${unit.truth}`
  if (Number(/** @type {any} */ (unit).round) > 0 && entry.evaluations[evaluationKey]) {
    const old = entry.evaluations[evaluationKey]
    entry.superseded = [...list(entry.superseded), { truth: unit.truth, replicates: old.replicates, seed: old.seed, measures: old.measures }]
  }
  entry.evaluations[evaluationKey] = evaluation
  if (outcome.unsupported) {
    entry.status = 'unsupported'; entry.reason = evaluation.issues[0] ?? 'candidate_unsupported'
  } else if (canceled) {
    // not a failure of the model, and not a verdict on the candidate: the campaign stops here
  } else if (outcome.state !== 'succeeded') {
    next.consecutiveFailures += 1
    entry.status = 'failed'; entry.reason = evaluation.issues[0] ?? 'evaluation_failed'
  } else {
    next.consecutiveFailures = 0
    if (unit.stage === 'screening') {
      // eliminated only when the most favourable bound already violates a design or safety constraint
      const failed = vcrCandidateVerdicts(manifest, entry, 'screening').find((v) => v.status === 'fail')
      if (failed) { entry.status = 'eliminated'; entry.reason = `screening_violates:${failed.measure}` }
      else if (stageTruths(manifest, 'screening').every((t) => entry.evaluations[`screening:${t}`]?.state === 'succeeded')) entry.status = 'screened'
    } else if (finalTruths(manifest).every((t) => entry.evaluations[`final:${t}`]?.state === 'succeeded')) {
      entry.status = 'evaluated'
    }
  }
  return next
}

/**
 * The verdict of a campaign whose finalists are evaluated: the feasible ones (every constraint passes on its final evaluation), the
 * best of them by the final objective estimate, the inconclusive ones, and the improvement over the reference when one is declared.
 * @param {Record<string, any>} manifest @param {Record<string, any>} state
 */
export function vcrCampaignVerdict(manifest, state) {
  const candidates = vcrCampaignCandidates(manifest)
  const keys = list(state.finalists)
  const rows = keys.map((key) => {
    const candidate = candidates.find((c) => c.key === key)
    const entry = object(state.candidates[key])
    const verdicts = vcrCandidateVerdicts(manifest, entry, 'final')
    const objective = objectiveOf(manifest, entry, 'final')
    return { key, index: candidate?.index ?? -1, objective, verdicts,
      feasible: entry.status === 'evaluated' && objective != null && verdicts.every((v) => v.status === 'pass'),
      inconclusive: entry.status === 'evaluated' && entry.role !== 'reference_only' && verdicts.some((v) => v.status === 'inconclusive') && !verdicts.some((v) => v.status === 'fail') }
  })
  const referenceKey = manifest.reference == null ? null : candidates.find((c) => c.index === manifest.reference)?.key ?? null
  // a reference kept only for the contrast (screened out, so it never competes) is not a design the search may return
  const feasible = rows.filter((row) => row.feasible && object(state.candidates[row.key]).role !== 'reference_only')
  const ranked = feasible.map((row) => ({ ...row, value: /** @type {any} */ (row.objective).value })).sort(byObjective(manifest))
  const best = ranked[0] ?? null
  const reference = referenceKey ? rows.find((row) => row.key === referenceKey) ?? null : null
  let improvement = null
  /** @type {Record<string, any> | null} */
  let improvementBound = null
  if (best?.objective && reference?.objective) {
    const sign = manifest.objective.direction === 'minimize' ? -1 : 1
    improvement = sign * (best.objective.value - reference.objective.value)
    // the improvement is decided on the bound of the two final runs' contrast: with the error their coupling allows; where the coupling
    // leaves it unknown, the worst case the marginal errors allow (Cauchy–Schwarz); and where even that is unknown, not decided at all
    const finalOf = (/** @type {string} */ key) => object(object(state.candidates[key]).evaluations)[`final:${manifest.objective.truth}`]
    const contrast = vcrEvaluationContrast(finalOf(best.key), finalOf(reference.key), manifest.objective.measure)
    const confidence = Number(list(manifest.constraints)[0]?.confidence ?? 0.975)
    const mcse = contrast.mcse ?? contrast.worstCaseMcse
    if (mcse == null) improvementBound = { lower: null, upper: null, mcse: null, confidence, coupling: contrast.coupling, basis: 'unassessed' }
    else {
      const z = vcrNormalQuantile(confidence)
      improvementBound = { lower: improvement - z * mcse, upper: improvement + z * mcse, mcse, confidence, coupling: contrast.coupling,
        basis: contrast.mcse == null ? 'worst_case' : contrast.coupling === 'independent' ? 'independent_error' : contrast.coupling }
    }
  }
  // Undecided is an answer too (F4): the finalists no constraint failed, the undecided constraint of each named with the simulated value and its
  // error, and the best of them by the objective when no finalist passed everything. The frozen constraint is never touched: this only
  // reports how close the closest design came and what would decide it.
  const undecided = rows.filter((row) => row.inconclusive).map((row) => ({ key: row.key, index: row.index, objective: row.objective,
    constraints: row.verdicts.filter((v) => v.status === 'inconclusive').map((v) => ({ index: v.index, measure: v.measure, op: v.op, bound: list(manifest.constraints)[v.index]?.bound ?? null,
      estimate: v.estimate ?? null, mcse: v.mcse ?? null, upper: v.bound?.upper ?? null, lower: v.bound?.lower ?? null, needed: v.needed ?? null })) }))
  const bestUndecided = best ? null : undecided.filter((row) => row.objective).map((row) => ({ ...row, value: /** @type {any} */ (row.objective).value })).sort(byObjective(manifest))[0]?.key ?? null
  const robust = manifest.robust ? vcrCampaignRobust(manifest, state, feasible.map((row) => row.key)) : null
  return { rows, feasible: feasible.map((row) => row.key), best: best?.key ?? null, robust, inconclusive: rows.filter((row) => row.inconclusive).map((row) => row.key),
    undecided, bestUndecided,
    reference: referenceKey, improvement, improvementBound,
    // each finalist is judged on its own at the constraints' confidence; the best is then picked among them (stats P2-1)
    selection: { finalists: keys.length, confidences: [...new Set(list(manifest.constraints).map((c) => Number(c.confidence)))] } }
}

// ---------------------------------------------------------------------------
// The robust reading (R34): scenarios side by side, no single optimum
// ---------------------------------------------------------------------------

/** The operating characteristics a scenario's table row reports, when the evaluation carries them (name, then the key it is shown under). */
export const VCR_ROBUST_OC_MEASURES = Object.freeze(['power', 'type_one_error', 'expected_sample_size', 'total_sample_size', 'duration_months',
  'last_visit_weeks', 'expected_events', 'early_stop_probability'])
/** The measure each cost dimension is read from, first the method has. */
const ROBUST_N_MEASURES = Object.freeze(['total_sample_size', 'expected_sample_size'])
const ROBUST_DURATION_MEASURES = Object.freeze(['duration_months', 'last_visit_weeks'])

/** @param {unknown} value */
const finite = (value) => value != null && Number.isFinite(Number(value))

/**
 * The robust choice over a table of designs evaluated in every scenario (pure; the numbers are the caller's, so a hand-built table decides
 * it exactly as a campaign's evaluations do). For each design: the worst-case power over the scenarios (maximin) and its error, the regret
 * in each scenario against the best design there and the largest of them, the expected power over the weights only when every scenario
 * has one, and whether power reaches the floor in all of them. Then the Pareto set over (N, duration, worst-case power), the near-optimal
 * set, and the cheapest design acceptable in every scenario beside the cheapest under the base case. Nothing here picks "the" best design:
 * the criterion leaders (`maximin`, `minimaxRegret`) are named as such, and the choice rule is written down in the result.
 *
 * Hidden knowledge:
 * - **Eligible** designs are complete (every scenario evaluated), not kept only as a reference, and not failing an error-control or safety
 *   constraint (`guard: 'fail'`); an ineligible design still gets its row and its numbers, and never enters a set or defines a best.
 * - **Worst case is a minimum of noisy numbers**, so it leans optimistic for the design that wins it; its error is the error of the
 *   scenario that was the minimum, and acceptability is judged on the Clopper-Pearson bound of every scenario instead.
 * - **Regret is against the best design of the table in that scenario** on power. Its error is the contrast's own (`contrast`, paired when
 *   the two runs shared draws), or the sum of the two marginal errors when the dependence is unknown.
 * - **Near-optimal** is "within tolerance of a Pareto design on every criterion": the criterion may be worse by at most the stated
 *   tolerance (absolute for power, relative for N and duration) plus z times the combined MCSE. Pareto designs are in it by definition.
 *   It is a practical-equivalence set, not a second ranking.
 * @param {{
 *   rows: Array<Record<string, any>>, scenarios: Array<{ name: string, weight?: number | null }>, tolerance: { power: number, relative: number },
 *   confidence: number, baseFeasible?: string[], contrast?: (a: string, b: string, scenario: string) => number | null
 * }} table each row: `{ key, index, complete, referenceOnly?, guard?, scenarios: { [name]: { power: { value, mcse, status } } }, n?, duration?, cost?, costBase? }` (a value is `{ value, mcse }`)
 */
export function vcrRobustChoice(table) {
  const { scenarios, tolerance } = table
  const names = scenarios.map((entry) => entry.name)
  const z = vcrNormalQuantile(table.confidence)
  const weighted = scenarios.length > 0 && scenarios.every((entry) => finite(entry.weight) && Number(entry.weight) > 0)
  const weightSum = weighted ? scenarios.reduce((sum, entry) => sum + Number(entry.weight), 0) : 0
  const weights = Object.fromEntries(scenarios.map((entry) => [entry.name, weighted ? Number(entry.weight) / weightSum : null]))
  const eligibleRow = (/** @type {Record<string, any>} */ row) => row.complete === true && row.referenceOnly !== true && row.guard !== 'fail'
  const eligible = table.rows.filter(eligibleRow)
  const powerOf = (/** @type {Record<string, any>} */ row, /** @type {string} */ name) => object(object(row.scenarios)[name]).power
  // the best design in each scenario, on power; the lower index decides a tie
  /** @type {Record<string, Record<string, any> | null>} */
  const bestIn = {}
  for (const name of names) {
    bestIn[name] = eligible.filter((row) => finite(powerOf(row, name)?.value))
      .reduce((best, row) => (!best || Number(powerOf(row, name).value) > Number(powerOf(best, name).value) + 1e-12
        || (Math.abs(Number(powerOf(row, name).value) - Number(powerOf(best, name).value)) <= 1e-12 && row.index < best.index) ? row : best), /** @type {Record<string, any> | null} */ (null))
  }
  const marginalError = (/** @type {Record<string, any>} */ row, /** @type {string} */ name) => (finite(powerOf(row, name)?.mcse) ? Number(powerOf(row, name).mcse) : null)
  const rows = table.rows.map((row) => {
    const base = { key: row.key, index: row.index, complete: row.complete === true, referenceOnly: row.referenceOnly === true, guard: row.guard ?? 'none', eligible: eligibleRow(row) }
    if (row.complete !== true || names.some((name) => !finite(powerOf(row, name)?.value))) return { ...base, complete: false, worstCase: null, regret: null, expectedPower: null, acceptable: 'unknown' }
    // maximin: the scenario with the lowest power, and that scenario's own error
    const worst = names.reduce((low, name) => (Number(powerOf(row, name).value) < Number(powerOf(row, low).value) ? name : low), names[0])
    const regretIn = Object.fromEntries(names.map((name) => {
      const best = bestIn[name]
      if (!best || best.key === row.key) return [name, { value: 0, mcse: 0, against: best?.key ?? null }]
      const value = Math.max(0, Number(powerOf(best, name).value) - Number(powerOf(row, name).value))
      const own = table.contrast ? table.contrast(best.key, row.key, name) : null
      const sa = marginalError(best, name), sb = marginalError(row, name)
      return [name, { value, mcse: finite(own) ? Number(own) : sa == null || sb == null ? null : sa + sb, against: best.key }]
    }))
    const maxName = names.reduce((high, name) => (regretIn[name].value > regretIn[high].value ? name : high), names[0])
    const statuses = names.map((name) => powerOf(row, name).status)
    return { ...base,
      worstCase: { value: Number(powerOf(row, worst).value), mcse: marginalError(row, worst), scenario: worst },
      regret: { byScenario: regretIn, max: { ...regretIn[maxName], scenario: maxName } },
      expectedPower: weighted ? { value: names.reduce((sum, name) => sum + weights[name] * Number(powerOf(row, name).value), 0),
        // the scenarios' runs may be positively correlated: the worst case the marginal errors allow, never their independent combination
        mcse: names.some((name) => marginalError(row, name) == null) ? null : names.reduce((sum, name) => sum + weights[name] * Number(marginalError(row, name)), 0) } : null,
      acceptable: statuses.every((status) => status === 'pass') ? 'pass' : statuses.some((status) => status === 'fail') ? 'fail' : 'inconclusive' }
  })
  const input = new Map(table.rows.map((row) => [row.key, row]))
  const pool = rows.filter((row) => row.eligible && row.worstCase)
  // the criteria of the Pareto and near-optimal sets: those every eligible design has a number for
  /** @type {Array<{ name: string, sense: 'min' | 'max', value: (row: any) => number | null, mcse: (row: any) => number, relative: boolean }>} */
  const dims = []
  const dim = (/** @type {string} */ name, /** @type {'min' | 'max'} */ sense, /** @type {(row: any) => any} */ read, /** @type {boolean} */ relative) => {
    if (pool.length && pool.every((row) => finite(read(row)?.value))) dims.push({ name, sense, value: (row) => Number(read(row).value), mcse: (row) => (finite(read(row)?.mcse) ? Number(read(row).mcse) : 0), relative })
  }
  dim('n', 'min', (row) => input.get(row.key)?.n, true)
  dim('duration', 'min', (row) => input.get(row.key)?.duration, true)
  dim('worst_case_power', 'max', (row) => row.worstCase, false)
  const better = (/** @type {any} */ a, /** @type {any} */ b, /** @type {typeof dims[number]} */ d) => (d.sense === 'min' ? d.value(a) < d.value(b) - 1e-12 : d.value(a) > d.value(b) + 1e-12)
  const notWorse = (/** @type {any} */ a, /** @type {any} */ b, /** @type {typeof dims[number]} */ d) => (d.sense === 'min' ? d.value(a) <= d.value(b) + 1e-12 : d.value(a) >= d.value(b) - 1e-12)
  const pareto = dims.length ? pool.filter((row) => !pool.some((other) => other !== row && dims.every((d) => notWorse(other, row, d)) && dims.some((d) => better(other, row, d)))) : []
  const near = dims.length ? pool.filter((row) => pareto.some((p) => p === row || dims.every((d) => {
    const worseBy = d.sense === 'min' ? d.value(row) - d.value(p) : d.value(p) - d.value(row)
    const allowed = (d.relative ? tolerance.relative * Math.abs(d.value(p)) : tolerance.power) + z * Math.sqrt(d.mcse(row) ** 2 + d.mcse(p) ** 2)
    return worseBy <= allowed + 1e-12
  }))) : []
  const cheapest = (/** @type {Array<Record<string, any>>} */ among, /** @type {'cost' | 'costBase'} */ field) => among
    .filter((row) => finite(input.get(row.key)?.[field]?.value))
    .sort((a, b) => Number(input.get(a.key)[field].value) - Number(input.get(b.key)[field].value) || a.index - b.index)[0] ?? null
  const acceptable = pool.filter((row) => row.acceptable === 'pass')
  const feasibleBase = new Set(table.baseFeasible ?? [])
  const cheapestAcceptable = cheapest(acceptable, 'cost')
  const cheapestUnderBase = cheapest(pool.filter((row) => feasibleBase.has(row.key)), 'costBase')
  const leader = (/** @type {(row: any) => number} */ read, /** @type {1 | -1} */ sign) => pool.reduce((best, row) => (!best || sign * (read(row) - read(best)) > 1e-12 ? row : best), /** @type {any} */ (null))
  for (const row of rows) {
    const mark = /** @type {Record<string, any>} */ (row)
    mark.pareto = pareto.some((p) => p.key === row.key)
    mark.nearOptimal = near.some((p) => p.key === row.key)
  }
  return {
    scenarios: scenarios.map((entry) => ({ name: entry.name, weight: weights[entry.name] })),
    weighted, rows, criteria: dims.map((d) => ({ name: d.name, sense: d.sense })),
    bestIn: Object.fromEntries(names.map((name) => [name, bestIn[name]?.key ?? null])),
    pareto: pareto.map((row) => row.key), nearOptimal: near.map((row) => row.key), acceptable: acceptable.map((row) => row.key),
    inconclusive: pool.filter((row) => row.acceptable === 'inconclusive').map((row) => row.key),
    maximin: leader((row) => row.worstCase.value, 1)?.key ?? null,
    minimaxRegret: leader((row) => row.regret.max.value, -1)?.key ?? null,
    cheapestAcceptable: cheapestAcceptable?.key ?? null, cheapestUnderBase: cheapestUnderBase?.key ?? null,
    sameDesign: cheapestAcceptable && cheapestUnderBase ? cheapestAcceptable.key === cheapestUnderBase.key : null,
    rule: { floor: null, tolerance, confidence: table.confidence },
  }
}

/**
 * The robust reading of a campaign whose finalists are evaluated: the table of its finalists' final evaluations in every scenario of
 * `manifest.robust`, through `vcrRobustChoice`. Operating characteristics are listed for every scenario the finalists were evaluated in
 * (the null one included), each with its MCSE; N and duration are the largest over the compared scenarios, the cost the same unless
 * the objective minimizes a cost measure itself.
 * @param {Record<string, any>} manifest @param {Record<string, any>} state @param {string[]} baseFeasible the finalists feasible under the base case
 */
export function vcrCampaignRobust(manifest, state, baseFeasible) {
  const robust = object(manifest.robust)
  const method = String(manifest.space?.method ?? '')
  const measures = object(object(/** @type {Record<string, any>} */ (VCR_CAMPAIGN_METHODS)[method]).measures)
  const nMeasure = ROBUST_N_MEASURES.find((name) => Object.hasOwn(measures, name)) ?? null
  const durationMeasure = ROBUST_DURATION_MEASURES.find((name) => Object.hasOwn(measures, name)) ?? null
  const costMeasure = robust.cost ?? (manifest.objective?.direction === 'minimize' && ['mean', 'exact'].includes(measures[manifest.objective.measure]) ? manifest.objective.measure : nMeasure)
  const candidates = vcrCampaignCandidates(manifest)
  const truths = [...new Set([...list(robust.scenarios), ...finalTruths(manifest)])]
  const scenarioDefs = list(robust.scenarios).map((name) => ({ name, weight: list(manifest.space?.truths).find((entry) => entry.name === name)?.weight ?? null }))
  const evaluationOf = (/** @type {Record<string, any>} */ entry, /** @type {string} */ name) => object(entry.evaluations)[`final:${name}`]
  const read = (/** @type {Record<string, any> | undefined} */ evaluation, /** @type {string | null} */ name) => {
    const measure = name && evaluation?.state === 'succeeded' ? vcrEvaluationMeasure(evaluation, name) : null
    return measure && finite(measure.value) ? { value: Number(measure.value), mcse: finite(measure.mcse) ? Number(measure.mcse) : null } : null
  }
  /** The largest value of a measure over the compared scenarios, with the error of the scenario it came from. */
  const worstOver = (/** @type {Record<string, any>} */ entry, /** @type {string | null} */ name) => {
    const found = list(robust.scenarios).map((scenario) => read(evaluationOf(entry, scenario), name))
    return name && found.length && found.every(Boolean) ? found.reduce((high, one) => (Number(one?.value) > Number(high?.value) ? one : high)) : null
  }
  const baseTruth = manifest.objective.truth
  const rows = list(state.finalists).map((key) => {
    const candidate = candidates.find((c) => c.key === key)
    const entry = object(object(state.candidates)[key])
    const verdicts = vcrCandidateVerdicts(manifest, entry, 'final')
    const guarded = verdicts.filter((v) => ['error_control', 'safety'].includes(String(v.kind)))
    const guard = guarded.some((v) => v.status === 'fail') ? 'fail' : guarded.some((v) => v.status === 'inconclusive') ? 'inconclusive' : guarded.length ? 'pass' : 'none'
    /** @type {Record<string, any>} */
    const byScenario = {}
    /** @type {Record<string, any>} */
    const oc = {}
    for (const name of truths) {
      const evaluation = evaluationOf(entry, name)
      if (!evaluation) continue
      oc[name] = Object.fromEntries(VCR_ROBUST_OC_MEASURES.map((measure) => [measure, read(evaluation, measure)]).filter(([, value]) => value))
      const n = oc[name].expected_sample_size ?? oc[name].total_sample_size, d = oc[name].duration_months ?? oc[name].last_visit_weeks
      // exposure is a safety proxy: people times the time they are followed, each error carried through the product
      if (n && d) oc[name].exposure = { value: n.value * d.value, mcse: n.mcse == null && d.mcse == null ? null : Math.sqrt(((n.mcse ?? 0) * d.value) ** 2 + ((d.mcse ?? 0) * n.value) ** 2) }
    }
    for (const name of list(robust.scenarios)) {
      const evaluation = evaluationOf(entry, name)
      const judged = evaluation ? vcrJudgeConstraint(manifest, { measure: robust.measure, op: '>=', bound: robust.floor, kind: 'design', truth: name, confidence: robust.confidence }, evaluation, { stage: 'final' }) : null
      const power = read(evaluation, robust.measure)
      if (power) byScenario[name] = { power: { ...power, status: judged?.status ?? 'not_judged', lower: judged?.bound?.lower ?? null, upper: judged?.bound?.upper ?? null } }
    }
    return { key, index: candidate?.index ?? -1, referenceOnly: entry.role === 'reference_only',
      complete: entry.status === 'evaluated' && list(robust.scenarios).every((name) => byScenario[name]), guard,
      scenarios: byScenario, oc, n: worstOver(entry, nMeasure), duration: worstOver(entry, durationMeasure),
      cost: worstOver(entry, costMeasure), costBase: read(evaluationOf(entry, baseTruth), costMeasure) }
  })
  const finalOf = (/** @type {string} */ key) => object(object(object(state.candidates)[key]).evaluations)
  const choice = vcrRobustChoice({ rows, scenarios: scenarioDefs, tolerance: robust.tolerance, confidence: robust.confidence, baseFeasible,
    contrast: (a, b, name) => {
      const c = vcrEvaluationContrast(finalOf(a)[`final:${name}`], finalOf(b)[`final:${name}`], robust.measure)
      return c.mcse ?? c.worstCaseMcse
    } })
  const inputByKey = new Map(rows.map((row) => [row.key, row]))
  return { ...choice, rule: { ...choice.rule, floor: robust.floor, measure: robust.measure }, measures: { n: nMeasure, duration: durationMeasure, cost: costMeasure },
    // each row keeps the numbers it was judged on: its power by scenario (with the verdict against the floor), every operating characteristic, N, duration and cost
    rows: choice.rows.map((row) => { const given = /** @type {Record<string, any>} */ (inputByKey.get(row.key) ?? {}); return { ...row, scenarios: given.scenarios ?? {}, oc: given.oc ?? {}, n: given.n ?? null, duration: given.duration ?? null, cost: given.cost ?? null, costBase: given.costBase ?? null } }) }
}

// ---------------------------------------------------------------------------
// The budgeted allocation (R36 root fix)
// ---------------------------------------------------------------------------

/**
 * Why the staged campaign used to flatten whatever its budget: `budget.cpuSeconds` was only a ceiling, never an input of the allocation.
 * The stage sizes were fixed (screening below the floor, at most `finalCountMax` finalists, one final run each), the finalists were chosen
 * once from the screening rank, and after that single round the verdict stopped the campaign with most of the budget unspent; when all
 * finalists failed there was no recourse, and a design the first run left undecided never got more replicates.
 *
 * With `budget.replicates` the campaign spends what it is given, and only on what can still change the answer, one unit at a time:
 * - the screening stage is unchanged (ranking and elimination only, never a pass);
 * - the first wave of finalists is the `stages.final.count` best by the screening rank, as before; every later design enters one at a time;
 * - the next design to be judged is the cheapest by the objective (the MCSE-aware one: a design is in play only when its estimate, less
 *   `z` times its own error, could beat the best feasible design so far, z from the constraints' confidence) among those the screening says may
 *   meet the design constraints first, then the rest; a design already judged "inconclusive" is run again, fresh, with the replicates its
 *   estimate says it needs (OCBA's rule of thumb: the gap to the bound sets the cost, and a gap that would take more than `maxGrowth` times the
 *   run to settle is inside the indifference zone of what the budget can resolve, so the design is neither passed nor chased), at most
 *   `maxRounds` times;
 * - a finalist whose first constraint already fails on its final evaluation is not run on its other truths (the verdict could not change);
 * - the campaign stops when nothing in play can still beat the best, or when nothing in play fits the remaining budget.
 * Error control is untouched: a verdict still reads only a final evaluation at the method's floor or more, on a stream no screening unit and no
 * earlier run of that design used, at the constraints' own confidence. A re-run is judged on its own fresh data alone (the earlier run decided
 * only whether to run it; its data are kept as `superseded`, never pooled), which keeps each design's bound exact. More designs judged means more
 * chances for one to pass by luck, as it always has with more finalists (`verdict.selection`); the benchmark measures it.
 */
export const VCR_ALLOCATION = Object.freeze({ maxRounds: 2, maxGrowth: 4, screeningShare: 0.2, firstWave: 1 })

/**
 * The stage sizes a replicate budget implies, by one stated rule: screening takes a fifth of the budget (alternative case only, below the
 * method's floor, at least the screening minimum), and the first wave holds one finalist plus the reference when there is one.
 * @param {{ candidates: number, replicates: number, method?: string }} input
 */
export function vcrCampaignBudgetPlan({ candidates, replicates, method = 'design.simulate' }) {
  const finalFloor = /** @type {Record<string, any>} */ (VCR_SCREENING.methods)[method]?.finalFloor ?? VCR_SCREENING.minReplicates + 1
  const each = Math.floor((VCR_ALLOCATION.screeningShare * replicates) / Math.max(1, candidates) / 100) * 100
  return { screeningReplicates: Math.min(finalFloor - 1, Math.max(VCR_SCREENING.minReplicates, each)), finalCount: VCR_ALLOCATION.firstWave }
}

/** The replicates a unit will use: its own, the screening stage's, or the floor of its scenario. @param {Record<string, any>} manifest @param {Record<string, any>} unit */
function unitReplicates(manifest, unit) {
  if (Number.isInteger(unit.replicates)) return unit.replicates
  return unit.stage === 'screening' ? Number(manifest.stages.screening.replicates) : vcrReplicateFloorFor(unit.scenario)
}

/** Whether a unit fits what is left of the replicate budget. @param {Record<string, any>} manifest @param {Record<string, any>} state @param {Record<string, any>} unit */
function affordable(manifest, state, unit) {
  return state.usage.replicatesCompleted + unitReplicates(manifest, unit) <= manifest.budget.replicates
}

/**
 * Record, once the campaign stops, what became of every design and of the budget: nothing is left without a reason.
 * @param {Record<string, any>} manifest @param {Record<string, any>} state @param {string} stopReason
 */
function finalizeAllocation(manifest, state, stopReason) {
  const unevaluated = []
  for (const [key, entry] of Object.entries(state.candidates)) {
    if (entry.status !== 'screened' && entry.status !== 'pending') continue
    entry.reason = state.allocation?.blocked?.includes(key) ? 'not_evaluated:budget' : entry.status === 'pending' ? 'not_screened:budget' : 'not_needed:cannot_beat_best'
    unevaluated.push(key)
  }
  const spent = state.usage.replicatesCompleted
  state.allocation = { ...object(state.allocation), budget: manifest.budget.replicates, spent, unspent: Math.max(0, manifest.budget.replicates - spent),
    unspentReason: stopReason === 'budget_exhausted' ? 'next_unit_does_not_fit' : stopReason === 'user_cancellation' || stopReason === 'persistent_model_failure' ? stopReason
      : state.allocation?.precisionLimited ? 'precision_not_reachable' : 'decided', unevaluated }
}

/**
 * The next final unit of a budgeted campaign, `{ unit }`, `{ blocked: true }` (something in play cannot be afforded) or null (nothing left
 * to run: the verdict decides). Pure over `state` (it records the wave and round it opens).
 * @param {Record<string, any>} manifest @param {Record<string, any>} state @param {any[]} candidates @param {string} identity
 */
function allocateFinals(manifest, state, candidates, identity) {
  const byKey = new Map(candidates.map((c) => [c.key, c]))
  // design and safety constraints are judged on their truths first: a failure there ends the design's run before its error-control truth is paid for
  const judged = list(manifest.constraints)
  const order = [...new Set([...judged.filter((c) => c.kind !== 'error_control').map((c) => c.truth), ...finalTruths(manifest)])]
  state.allocation = { ...object(state.allocation), blocked: list(state.allocation?.blocked) }
  // 1. finish a finalist that is started
  for (const key of state.finalists) {
    const entry = state.candidates[key]
    if (entry.status !== 'finalist') continue
    const failed = vcrCandidateVerdicts(manifest, entry, 'final').find((v) => v.status === 'fail')
    if (failed) { entry.status = 'evaluated'; entry.reason = `final_failed:${failed.measure}`; continue }
    const truth = order.find((t) => !entry.evaluations[`final:${t}`])
    if (truth == null) { entry.status = 'evaluated'; continue }
    const unit = vcrCampaignUnit(manifest, identity, /** @type {any} */ (byKey.get(key)), 'final', truth)
    return affordable(manifest, state, unit) ? { unit } : { blocked: true }
  }
  // 2. what is still in play: it must be able to beat the best feasible design so far
  const verdict = vcrCampaignVerdict(manifest, state)
  const z = vcrNormalQuantile(Number(list(manifest.constraints)[0]?.confidence ?? 0.975))
  const minimize = manifest.objective.direction === 'minimize'
  const best = verdict.best ? objectiveOf(manifest, state.candidates[verdict.best], 'final') : null
  const couldBeat = (/** @type {{ value: number, mcse: number | null } | null} */ o) => {
    if (!o) return false
    if (!best) return true
    const slack = z * Number(o.mcse ?? 0)
    return minimize ? o.value - slack < best.value : o.value + slack > best.value
  }
  const meetsScreening = (/** @type {string} */ key) => list(judged).filter((c) => c.kind !== 'error_control').every((c) => {
    const measure = vcrEvaluationMeasure(state.candidates[key].evaluations[`screening:${c.truth}`], c.measure)
    return measure != null && (c.op === '<=' ? Number(measure.value) <= c.bound : Number(measure.value) >= c.bound)
  })
  /** @type {Array<{ key: string, index: number, value: number, meets: boolean, escalate: { truth: string, replicates: number, round: number } | null }>} */
  const inPlay = []
  for (const c of candidates) {
    const entry = state.candidates[c.key]
    if (entry.status === 'screened') {
      const o = objectiveOf(manifest, entry, 'screening')
      if (couldBeat(o)) inPlay.push({ key: c.key, index: c.index, value: /** @type {any} */ (o).value, meets: meetsScreening(c.key), escalate: null })
    } else if (entry.status === 'evaluated' && entry.role !== 'reference_only' && verdict.inconclusive.includes(c.key)) {
      const o = objectiveOf(manifest, entry, 'final')
      const round = Number(entry.round ?? 0)
      const row = verdict.undecided.find((/** @type {any} */ u) => u.key === c.key)
      if (!couldBeat(o) || round >= VCR_ALLOCATION.maxRounds || !row) continue
      // the undecided constraint with the largest need decides the size of the fresh run
      let need = 0; let truth = null
      for (const u of row.constraints) {
        const constraint = judged[u.index]
        const given = Number(u.needed?.replicates)
        const sized = Number.isFinite(given) ? given : NaN // an estimate exactly on the bound names no number of replicates that settles it
        const current = Number(entry.evaluations[`final:${constraint.truth}`]?.replicates ?? 0)
        // a design whose gap to the bound would take more than `maxGrowth` times its own run to settle is within the indifference of what the
        // budget can resolve: it is neither passed nor chased
        const target = Number.isFinite(sized) && sized <= current * VCR_ALLOCATION.maxGrowth ? Math.max(Math.ceil(sized / 1000) * 1000, Math.ceil(current * 1.5)) : NaN
        if (Number.isFinite(target) && target > need) { need = Math.min(target, VCR_MAX_REPLICATES); truth = constraint.truth }
      }
      if (truth == null) { state.allocation.precisionLimited = true; continue }
      inPlay.push({ key: c.key, index: c.index, value: /** @type {any} */ (o).value, meets: true, escalate: { truth, replicates: need, round: round + 1 } })
    }
  }
  if (!inPlay.length) return null
  // 3. the cheapest by the objective first; designs the screening says may meet the design constraints before the rest; a re-run before a new design on a tie
  inPlay.sort((a, b) => Number(b.meets) - Number(a.meets) || (minimize ? a.value - b.value : b.value - a.value) || Number(Boolean(b.escalate)) - Number(Boolean(a.escalate)) || a.index - b.index)
  for (const item of inPlay) {
    const candidate = /** @type {any} */ (byKey.get(item.key))
    const entry = state.candidates[item.key]
    let unit
    if (item.escalate) unit = vcrCampaignUnit(manifest, identity, candidate, 'final', item.escalate.truth, { round: item.escalate.round, replicates: item.escalate.replicates })
    else unit = vcrCampaignUnit(manifest, identity, candidate, 'final', /** @type {string} */ (order[0]))
    if (!affordable(manifest, state, unit)) { if (!state.allocation.blocked.includes(item.key)) state.allocation.blocked.push(item.key); continue }
    if (item.escalate) entry.round = item.escalate.round
    else { entry.status = 'finalist'; entry.wave = list(state.finalists).length; state.finalists = [...state.finalists, item.key] }
    state.allocation.opened = Number(state.allocation.opened ?? 0) + 1
    return { unit }
  }
  return { blocked: true }
}

/**
 * Decide what a campaign does next (pure): evaluate one unit, wait for the unit in flight, or stop with one reason. Finalists are
 * chosen here, once, from the screening ranking (or every survivor of an exact method), and written into the returned state.
 * @param {Record<string, any>} manifest @param {Record<string, any>} state @param {{ identity: string }} context
 * @returns {{ state: Record<string, any>, action: { type: 'evaluate' | 'wait' | 'stop' | 'none', unit?: Record<string, any>, reason?: string } }}
 */
export function vcrCampaignAdvance(manifest, state, { identity }) {
  const next = clone(state)
  if (next.stop) return { state: next, action: { type: 'none' } }
  if (next.inFlight) return { state: next, action: { type: 'wait' } }
  const budgeted = Number.isInteger(manifest.budget.replicates)
  const stop = (/** @type {string} */ reason) => {
    if (budgeted) finalizeAllocation(manifest, next, reason)
    next.stop = { reason, verdict: next.finalists ? vcrCampaignVerdict(manifest, next) : null }
    return { state: next, action: /** @type {const} */ ({ type: 'stop', reason }) }
  }
  if (next.cancelRequested) return stop('user_cancellation')
  if (next.consecutiveFailures >= manifest.stopRules.maxConsecutiveFailures) return stop('persistent_model_failure')
  const candidates = vcrCampaignCandidates(manifest)
  const open = (/** @type {string} */ key) => ['pending', 'screened', 'finalist'].includes(next.candidates[key]?.status)
  // a spent budget stops the next unit, never a verdict that needs none: the engine checks its CPU between batches, so the last final
  // unit can end a little over the ceiling (stats P2-3)
  const evaluate = (/** @type {any} */ unit) => (next.usage.cpuSeconds >= manifest.budget.cpuSeconds ? stop('budget_exhausted')
    : budgeted && !affordable(manifest, next, unit) ? stop('budget_exhausted')
      : { state: next, action: /** @type {const} */ ({ type: 'evaluate', unit }) })

  // 1. the analytic pre-check: one unit per distinct analytic scenario, then elimination by its rules
  if (manifest.stages.analytic) {
    for (const candidate of candidates) {
      if (!open(candidate.key) || next.candidates[candidate.key].status !== 'pending' || next.candidates[candidate.key].analytic === 'kept') continue
      const { scenario, key } = vcrCampaignAnalyticScenario(manifest, candidate)
      const done = next.analytic[key]
      if (!done) {
        return evaluate({ key, stage: 'analytic', method: 'design.analytic', version: VCR_ENGINE_METHODS['design.analytic'].version, kind: 'design_analytic',
          scenario, seed: vcrCampaignSeed(identity, 'analytic', key, key), replicates: null, idempotencyKey: `vcr-campaign:${identity.slice(0, 24)}:${key}` })
      }
      const entry = next.candidates[candidate.key]
      if (done.state !== 'succeeded') { entry.status = 'eliminated'; entry.reason = 'analytic_check_failed'; continue }
      for (const rule of manifest.stages.analytic.eliminate) {
        const needed = vcrEvaluationMeasure(done, rule.measure)
        const final = vcrCandidateScenario(manifest, candidate, manifest.objective.truth, 'final')
        const parts = rule.exceeds.map((/** @type {string} */ path) => getPath(final, path))
        // a part the candidate does not have decides nothing: the rule keeps the candidate rather than counting the part as 0
        const total = parts.every((/** @type {any} */ part) => part != null && Number.isFinite(Number(part))) ? parts.reduce((/** @type {number} */ sum, /** @type {any} */ part) => sum + Number(part), 0) : NaN
        if (needed && Number.isFinite(total) && total < Number(needed.value) * (1 - rule.tolerance)) {
          entry.status = 'eliminated'; entry.reason = `analytic_below:${rule.measure}`; break
        }
      }
      if (entry.status === 'pending') entry.analytic = 'kept'
    }
  }

  // 2. screening, in space order
  const exact = VCR_CAMPAIGN_METHODS[/** @type {keyof typeof VCR_CAMPAIGN_METHODS} */ (manifest.space.method)].exact
  if (manifest.stages.screening && !next.finalists) {
    for (const candidate of candidates) {
      if (!open(candidate.key)) continue
      for (const truth of stageTruths(manifest, 'screening')) {
        if (!next.candidates[candidate.key].evaluations[`screening:${truth}`]) return evaluate(vcrCampaignUnit(manifest, identity, candidate, 'screening', truth))
      }
    }
  }

  // 3. finalists, chosen once
  if (!next.finalists) {
    const survivors = candidates.filter((c) => open(c.key) && (exact || !manifest.stages.screening || next.candidates[c.key].status === 'screened'))
    if (!survivors.length) {
      const all = candidates.map((c) => next.candidates[c.key].status)
      return stop(all.length && all.every((status) => status === 'unsupported') ? 'unsupported_candidate' : 'no_feasible_beneficial_candidate')
    }
    let chosen
    if (exact || !manifest.stages.screening) chosen = survivors
    else {
      // Ranking only, never a pass: a survivor whose screening point estimates meet every screened constraint comes before one whose
      // estimates do not, then the objective decides. Without the first key the cheapest designs on the edge of the power constraint
      // took every finalist place and all failed their final check.
      const meets = (/** @type {string} */ key) => list(manifest.constraints).filter((c) => c.kind !== 'error_control').every((c) => {
        const measure = vcrEvaluationMeasure(next.candidates[key].evaluations[`screening:${c.truth}`], c.measure)
        return measure != null && (c.op === '<=' ? Number(measure.value) <= c.bound : Number(measure.value) >= c.bound)
      }) && list(manifest.robust?.scenarios).every((name) => {
        // a robust reading ranks first the designs whose screened power reaches the floor in every scenario it compares
        if (!stageTruths(manifest, 'screening').includes(name)) return true
        const measure = vcrEvaluationMeasure(next.candidates[key].evaluations[`screening:${name}`], manifest.robust.measure)
        return measure != null && Number(measure.value) >= manifest.robust.floor
      })
      const ranked = survivors.map((c) => ({ key: c.key, index: c.index, meets: meets(c.key), ...(objectiveOf(manifest, next.candidates[c.key], 'screening') ?? { value: NaN, mcse: null }) }))
        .filter((row) => Number.isFinite(row.value)).sort((a, b) => Number(b.meets) - Number(a.meets) || byObjective(manifest)(a, b))
      chosen = ranked.slice(0, manifest.stages.final.count).map((row) => candidates.find((c) => c.key === row.key))
    }
    const reference = manifest.reference == null ? null : candidates.find((c) => c.index === manifest.reference)
    if (reference && !chosen.some((c) => c?.key === reference.key) && !['unsupported', 'failed'].includes(next.candidates[reference.key]?.status)) chosen.push(reference)
    next.finalists = chosen.filter(Boolean).map((c) => /** @type {any} */ (c).key)
    for (const key of next.finalists) {
      const entry = next.candidates[key]
      // a reference screened out (or analytically set aside) is still evaluated finally, for the contrast, and never competes to win (F06)
      if (entry.status === 'eliminated') entry.role = 'reference_only'
      entry.status = 'finalist'
    }
  }

  // 4. final evaluations on independent streams (a budgeted campaign: sequentially, by the allocation rule below)
  if (budgeted) {
    const decided = allocateFinals(manifest, next, candidates, identity)
    if (decided?.unit) return evaluate(decided.unit)
    if (decided?.blocked) return stop('budget_exhausted')
  } else for (const key of next.finalists) {
    const entry = next.candidates[key]
    if (!['finalist'].includes(entry.status)) continue
    const candidate = /** @type {any} */ (candidates.find((c) => c.key === key))
    for (const truth of finalTruths(manifest)) {
      if (!entry.evaluations[`final:${truth}`]) return evaluate(vcrCampaignUnit(manifest, identity, candidate, 'final', truth))
    }
  }

  // 5. the verdict: undecided at this precision is its own stop, never "nothing feasible" (stats P1-1)
  const verdict = vcrCampaignVerdict(manifest, next)
  if (!verdict.best) {
    if (candidates.every((c) => next.candidates[c.key].status === 'unsupported')) return stop('unsupported_candidate')
    return stop(verdict.inconclusive.length ? 'inconclusive_at_precision' : 'no_feasible_beneficial_candidate')
  }
  const bound = verdict.improvementBound
  const least = manifest.stopRules.minImprovement
  // a requested improvement that could not be assessed (the reference has no final evaluation, or the error of the contrast is unknown) is not satisfied
  if (verdict.reference && verdict.best !== verdict.reference && least != null && (!bound || bound.basis === 'unassessed')) return stop('inconclusive_at_precision')
  if (verdict.reference && verdict.improvement != null && bound && bound.basis !== 'unassessed') {
    if (verdict.best === verdict.reference || bound.upper <= 0) return stop('no_feasible_beneficial_candidate')
    if (bound.lower <= 0) return stop('inconclusive_at_precision')
    if (least != null && bound.upper < least) return stop('no_useful_improvement')
    if (least != null && bound.lower < least) return stop('inconclusive_at_precision')
  }
  return stop('acceptable_precision')
}

// ---------------------------------------------------------------------------
// Contrasts between two evaluations
// ---------------------------------------------------------------------------

/** Decode a lower-case hex bitset into its set-bit count and length check. @param {string} hex */
function bitsOf(hex) {
  const bytes = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16))
  return bytes
}

/** @param {number} byte */
const popcount = (byte) => { let n = 0; for (let b = byte; b; b >>= 1) n += b & 1; return n }

/**
 * The difference `a − b` of one measure between two evaluations, with its Monte-Carlo error by the coupling the runs actually had:
 * `paired` when both runs drew the same random numbers (same seed and the engine's same draw signature) and carry their per-replicate
 * rejection bitsets (the paired error from the discordant replicates); `independent` when their seeds differ (the errors add in
 * quadrature); `same_seed_different_draws` when the seeds agree but the draws do not, which leaves the dependence unknown and gives no
 * interval; `exact` when both values are calculated.
 * @param {Record<string, any>} a @param {Record<string, any>} b @param {string} name
 */
export function vcrEvaluationContrast(a, b, name) {
  const ma = vcrEvaluationMeasure(a, name), mb = vcrEvaluationMeasure(b, name)
  if (!ma || !mb) return { measure: name, coupling: 'unavailable', difference: null, mcse: null, worstCaseMcse: null }
  const difference = Number(ma.value) - Number(mb.value)
  if (ma.simulated !== true && mb.simulated !== true) return { measure: name, coupling: 'exact', difference, mcse: 0, worstCaseMcse: 0 }
  // A calculated measure has no Monte-Carlo error (0); a simulated one without its error has an unknown one, never 0. When the
  // dependence of the two runs is unknown, Cauchy–Schwarz still bounds the contrast's error by the sum of the marginal errors
  // (sd(A − B) <= sd(A) + sd(B)), which holds whatever the covariance is; without both marginal errors there is no bound.
  const marginal = (/** @type {Record<string, any>} */ m) => (m.simulated !== true ? 0 : m.mcse != null && Number.isFinite(Number(m.mcse)) ? Number(m.mcse) : null)
  const sa = marginal(ma), sb = marginal(mb)
  const worstCaseMcse = sa == null || sb == null ? null : sa + sb
  // The two runs are independent only on streams that were drawn apart: two known, different seeds. A run with no recorded seed says
  // nothing about its stream, so its dependence is as unknown as that of two runs that drew the same seed differently.
  const seeded = a.seed != null && b.seed != null
  if (!seeded) return { measure: name, coupling: 'unknown_dependence', difference, mcse: null, worstCaseMcse }
  if (a.seed === b.seed) {
    if (!a.drawSignature || a.drawSignature !== b.drawSignature) return { measure: name, coupling: 'same_seed_different_draws', difference, mcse: null, worstCaseMcse }
    const bitsA = typeof a.rejects === 'string' ? bitsOf(a.rejects) : null, bitsB = typeof b.rejects === 'string' ? bitsOf(b.rejects) : null
    const n = Number(a.replicates)
    // the bitset is the primary test's rejection indicator, so it pairs `power` or `type_one_error` and nothing else
    const rejection = name === 'power' || name === 'type_one_error'
    if (rejection && bitsA && bitsB && bitsA.length === bitsB.length && n === Number(b.replicates) && n >= 2 && bitsA.length === Math.ceil(n / 8)) {
      let onlyA = 0, onlyB = 0
      for (let i = 0; i < bitsA.length; i++) { onlyA += popcount(bitsA[i] & ~bitsB[i] & 0xff); onlyB += popcount(bitsB[i] & ~bitsA[i] & 0xff) }
      const mean = (onlyA - onlyB) / n
      const variance = ((onlyA + onlyB) / n - mean * mean) * n / (n - 1)
      return { measure: name, coupling: 'paired', difference, mcse: Math.sqrt(Math.max(0, variance) / n), worstCaseMcse, discordant: { onlyA, onlyB } }
    }
    return { measure: name, coupling: 'paired_without_replicates', difference, mcse: null, worstCaseMcse }
  }
  return { measure: name, coupling: 'independent', difference, mcse: sa == null || sb == null ? null : Math.sqrt(sa * sa + sb * sb), worstCaseMcse }
}
