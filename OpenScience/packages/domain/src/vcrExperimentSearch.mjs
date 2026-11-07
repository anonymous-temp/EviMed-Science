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

import { canonicalScenarioJson, vcrIsNullScenario } from './vcrEngineJob.mjs'
import { VCR_JOB_METHODS, VCR_ENGINE_METHODS } from './vcrEngineJob.mjs'
import { VCR_REPLICATES_ALT_MIN } from './vcrVocabulary.mjs'
import { vcrDiseaseHypothesis } from './vcrExperiment.mjs'

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
  'user_cancellation', 'no_feasible_beneficial_candidate', 'inconclusive_at_precision',
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
    }) }),
  'design.analytic': Object.freeze({ exact: true, measures: Object.freeze({
    required_events: 'exact', required_events_exact: 'exact', required_patients: 'exact', sample_size: 'exact', max_events: 'exact',
    expected_events_h0: 'exact', expected_events_h1: 'exact', power: 'exact', type_one_error: 'exact',
  }) }),
})

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
  finalCountMax: 5, cpuSecondsMax: 7 * 24 * 3600, modelCallsMax: 1000, questionMax: 500,
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
  const truths = rawTruths.length ? rawTruths.map((entry) => ({ name: String(object(entry).name ?? ''), truth: object(object(entry).truth) })) : [{ name: 'base', truth: object(base[truthField]) }]
  if (truths.length > L.maxTruths) bad('campaign_value_invalid', 'space.truths', `At most ${L.maxTruths} truth scenarios.`)
  truths.forEach((entry, i) => {
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(entry.name)) bad('campaign_value_invalid', `space.truths[${i}].name`, 'A truth is named with a short lower-case word.')
    if (!emptyTruthOk && !Object.keys(entry.truth).length) bad('campaign_value_invalid', `space.truths[${i}].truth`, 'A truth scenario states its truth.')
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

  // stages
  const stagesIn = object(src.stages)
  const screeningIn = stagesIn.screening == null ? null : object(stagesIn.screening)
  const exact = info?.exact === true
  const neededTruths = [...new Set([objective.truth, ...constraints.filter((c) => c.kind !== 'error_control').map((c) => c.truth)])]
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
    analytic.eliminate.forEach((rule, i) => {
      if (!Object.hasOwn(VCR_CAMPAIGN_METHODS['design.analytic'].measures, rule.measure)) bad('campaign_measure_unknown', `stages.analytic.eliminate[${i}].measure`, 'An analytic rule reads a measure design.analytic produces.')
      if (!rule.exceeds.length || rule.exceeds.some((path) => !PATH.test(path))) bad('campaign_value_invalid', `stages.analytic.eliminate[${i}].exceeds`, 'A rule names the candidate paths whose sum must reach the analytic value.')
      if (!(typeof rule.tolerance === 'number' && rule.tolerance >= 0 && rule.tolerance < 0.5)) bad('campaign_value_invalid', `stages.analytic.eliminate[${i}].tolerance`, 'A tolerance is from 0 to 0.5.')
    })
  }

  // budget and stop rules
  const budgetIn = object(src.budget)
  const budget = { maxCandidates: budgetIn.maxCandidates ?? null, cpuSeconds: budgetIn.cpuSeconds ?? null, modelCalls: budgetIn.modelCalls ?? 0 }
  if (!(Number.isInteger(budget.maxCandidates) && budget.maxCandidates >= 1 && budget.maxCandidates <= L.maxCandidates)) bad('campaign_budget_invalid', 'budget.maxCandidates', `A campaign evaluates 1 to ${L.maxCandidates} candidates.`)
  if (!(typeof budget.cpuSeconds === 'number' && budget.cpuSeconds > 0 && budget.cpuSeconds <= L.cpuSecondsMax)) bad('campaign_budget_invalid', 'budget.cpuSeconds', 'A campaign states its CPU-second budget.')
  if (!(Number.isInteger(budget.modelCalls) && budget.modelCalls >= 0 && budget.modelCalls <= L.modelCallsMax)) bad('campaign_budget_invalid', 'budget.modelCalls', `Model calls are 0 to ${L.modelCallsMax}.`)
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
    budget, stopRules, reference: referenceIn,
  }, issues }
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
  if (truth) scenario[info?.truthField ?? 'truth'] = clone(truth.truth)
  if (!info?.exact && info?.precisionBlock !== false) {
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
 */
export function vcrCampaignUnit(manifest, identity, candidate, stage, truth) {
  const method = manifest.space.method
  const kind = Object.keys(VCR_JOB_METHODS).find((key) => /** @type {Record<string, string>} */ (VCR_JOB_METHODS)[key] === method)
  const drawKey = vcrCampaignDrawKey(manifest, candidate)
  return {
    key: `${candidate.key}:${stage}:${truth}`, candidate: candidate.key, stage, truth, method, version: manifest.space.version, kind,
    scenario: vcrCandidateScenario(manifest, candidate, truth, stage),
    seed: vcrCampaignSeed(identity, stage, truth, drawKey),
    replicates: stage === 'final' && Number.isInteger(manifest.stages.final.replicates) ? manifest.stages.final.replicates : null,
    idempotencyKey: `vcr-campaign:${identity.slice(0, 24)}:${candidate.key}:${stage}:${truth}`,
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

/** The truths the final stage evaluates: every truth the objective or a constraint names. @param {Record<string, any>} manifest */
function finalTruths(manifest) {
  return [...new Set([manifest.objective.truth, ...list(manifest.constraints).map((c) => c.truth)])]
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
  return evaluation?.state === 'succeeded' && measure ? { value: Number(measure.value), mcse: measure.mcse ?? null } : null
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
  entry.evaluations[`${unit.stage}:${unit.truth}`] = evaluation
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
      inconclusive: entry.status === 'evaluated' && verdicts.some((v) => v.status === 'inconclusive') && !verdicts.some((v) => v.status === 'fail') }
  })
  const referenceKey = manifest.reference == null ? null : candidates.find((c) => c.index === manifest.reference)?.key ?? null
  const feasible = rows.filter((row) => row.feasible)
  const ranked = feasible.map((row) => ({ ...row, value: /** @type {any} */ (row.objective).value })).sort(byObjective(manifest))
  const best = ranked[0] ?? null
  const reference = referenceKey ? rows.find((row) => row.key === referenceKey) ?? null : null
  let improvement = null
  /** @type {Record<string, any> | null} */
  let improvementBound = null
  if (best?.objective && reference?.objective) {
    const sign = manifest.objective.direction === 'minimize' ? -1 : 1
    improvement = sign * (best.objective.value - reference.objective.value)
    // the improvement is decided on the bound of the two final runs' contrast: with the error their coupling allows, or, where the coupling
    // leaves it unknown, the independent error (common random numbers only make it smaller)
    const finalOf = (/** @type {string} */ key) => object(object(state.candidates[key]).evaluations)[`final:${manifest.objective.truth}`]
    const contrast = vcrEvaluationContrast(finalOf(best.key), finalOf(reference.key), manifest.objective.measure)
    const confidence = Number(list(manifest.constraints)[0]?.confidence ?? 0.975)
    const mcse = contrast.mcse ?? Math.hypot(Number(best.objective.mcse ?? 0), Number(reference.objective.mcse ?? 0))
    const z = vcrNormalQuantile(confidence)
    improvementBound = { lower: improvement - z * mcse, upper: improvement + z * mcse, mcse, confidence, coupling: contrast.coupling,
      basis: contrast.mcse == null ? 'independent_error' : contrast.coupling }
  }
  return { rows, feasible: feasible.map((row) => row.key), best: best?.key ?? null, inconclusive: rows.filter((row) => row.inconclusive).map((row) => row.key),
    reference: referenceKey, improvement, improvementBound,
    // each finalist is judged on its own at the constraints' confidence; the best is then picked among them (stats P2-1)
    selection: { finalists: keys.length, confidences: [...new Set(list(manifest.constraints).map((c) => Number(c.confidence)))] } }
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
  const stop = (/** @type {string} */ reason) => { next.stop = { reason, verdict: next.finalists ? vcrCampaignVerdict(manifest, next) : null }; return { state: next, action: /** @type {const} */ ({ type: 'stop', reason }) } }
  if (next.cancelRequested) return stop('user_cancellation')
  if (next.consecutiveFailures >= manifest.stopRules.maxConsecutiveFailures) return stop('persistent_model_failure')
  const candidates = vcrCampaignCandidates(manifest)
  const open = (/** @type {string} */ key) => ['pending', 'screened', 'finalist'].includes(next.candidates[key]?.status)
  // a spent budget stops the next unit, never a verdict that needs none: the engine checks its CPU between batches, so the last final
  // unit can end a little over the ceiling (stats P2-3)
  const evaluate = (/** @type {any} */ unit) => (next.usage.cpuSeconds >= manifest.budget.cpuSeconds ? stop('budget_exhausted')
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
        const total = rule.exceeds.reduce((/** @type {number} */ sum, /** @type {string} */ path) => sum + Number(getPath(vcrCandidateScenario(manifest, candidate, manifest.objective.truth, 'final'), path) ?? 0), 0)
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
      })
      const ranked = survivors.map((c) => ({ key: c.key, index: c.index, meets: meets(c.key), ...(objectiveOf(manifest, next.candidates[c.key], 'screening') ?? { value: NaN, mcse: null }) }))
        .filter((row) => Number.isFinite(row.value)).sort((a, b) => Number(b.meets) - Number(a.meets) || byObjective(manifest)(a, b))
      chosen = ranked.slice(0, manifest.stages.final.count).map((row) => candidates.find((c) => c.key === row.key))
    }
    const reference = manifest.reference == null ? null : candidates.find((c) => c.index === manifest.reference)
    if (reference && !chosen.some((c) => c?.key === reference.key) && !['unsupported', 'failed'].includes(next.candidates[reference.key]?.status)) chosen.push(reference)
    next.finalists = chosen.filter(Boolean).map((c) => /** @type {any} */ (c).key)
    for (const key of next.finalists) if (next.candidates[key].status !== 'eliminated') next.candidates[key].status = 'finalist'
  }

  // 4. final evaluations on independent streams
  for (const key of next.finalists) {
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
  if (verdict.reference && verdict.improvement != null && bound) {
    if (verdict.best === verdict.reference || bound.upper <= 0) return stop('no_feasible_beneficial_candidate')
    if (bound.lower <= 0) return stop('inconclusive_at_precision')
    const least = manifest.stopRules.minImprovement
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
  if (!ma || !mb) return { measure: name, coupling: 'unavailable', difference: null, mcse: null }
  const difference = Number(ma.value) - Number(mb.value)
  if (ma.simulated !== true && mb.simulated !== true) return { measure: name, coupling: 'exact', difference, mcse: 0 }
  const sameSeed = a.seed != null && a.seed === b.seed
  if (sameSeed) {
    if (!a.drawSignature || a.drawSignature !== b.drawSignature) return { measure: name, coupling: 'same_seed_different_draws', difference, mcse: null }
    const bitsA = typeof a.rejects === 'string' ? bitsOf(a.rejects) : null, bitsB = typeof b.rejects === 'string' ? bitsOf(b.rejects) : null
    const n = Number(a.replicates)
    // the bitset is the primary test's rejection indicator, so it pairs `power` or `type_one_error` and nothing else
    const rejection = name === 'power' || name === 'type_one_error'
    if (rejection && bitsA && bitsB && bitsA.length === bitsB.length && n === Number(b.replicates) && n >= 2 && bitsA.length === Math.ceil(n / 8)) {
      let onlyA = 0, onlyB = 0
      for (let i = 0; i < bitsA.length; i++) { onlyA += popcount(bitsA[i] & ~bitsB[i] & 0xff); onlyB += popcount(bitsB[i] & ~bitsA[i] & 0xff) }
      const mean = (onlyA - onlyB) / n
      const variance = ((onlyA + onlyB) / n - mean * mean) * n / (n - 1)
      return { measure: name, coupling: 'paired', difference, mcse: Math.sqrt(Math.max(0, variance) / n), discordant: { onlyA, onlyB } }
    }
    return { measure: name, coupling: 'paired_without_replicates', difference, mcse: null }
  }
  const sa = Number(ma.mcse ?? 0), sb = Number(mb.mcse ?? 0)
  return { measure: name, coupling: 'independent', difference, mcse: Math.sqrt(sa * sa + sb * sb) }
}
