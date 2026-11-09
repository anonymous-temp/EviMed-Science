/**
 * One scenario schema per engine method (integration contract 2026-09-29 §3.1).
 *
 * Hidden knowledge:
 *
 * - **A scenario key the engine does not read is a defect, not a comment.** The
 *   first build validated only `design.kind` and `endpoint.type` and let every
 *   other key through; the orchestrator sent `dropoutRate` where the engine read
 *   `dropoutAnnual`, and the engine ran with no dropout at all and said
 *   nothing. These schemas list, per method, exactly the keys its handler reads
 *   (derived from `vcr-engine/R/engine.R` and the files it calls), with type,
 *   range, whether it is required and its default. An unknown key is refused by
 *   its path (`scenario_field_unknown`), because an ignored field is a silent
 *   parameter change.
 * - **The schema is data, in a small closed language, so both sides can run
 *   it.** `R/domain-snapshot.json` carries these objects and `vcr_validate_job`
 *   walks them with the same rules as `validateScenario` below; case N00 holds
 *   the two verdicts equal on a fixture set of jobs. Nothing here is a
 *   function: a `when` is `{ path, in | notIn | present }`, a value list can
 *   depend on another field (`valuesBy`), and the cross-field rules are named
 *   options (`exactlyOne`, `atLeastOne`, `requires`, `lengthRules`).
 * - **Design × endpoint is a table.** The engine implements fixed two-arm
 *   designs for all three endpoint families and group-sequential only for
 *   time-to-event. Binary exact single-arm, frozen Simon and the explicit
 *   stratified external-control generator have separate branches and inputs.
 *   A combination outside `VCR_DESIGN_SUPPORT` is
 *   refused (`design_not_supported`) instead of being run as something else.
 * - **Thresholds are not scenario keys.** The ESS floor, the common-support
 *   ceiling, the MAP conflict bound, the reconstruction tolerances and the
 *   bootstrap floor are deployment presets in `vcrVocabulary.mjs` that the
 *   engine reads from the snapshot; a scenario written by a model cannot loosen
 *   the rule that makes a comparison 「不可估计」.
 * - **Every new key needs a row here first.** A scenario key the schema does not
 *   list cannot reach the engine, so adding a handler option starts in this
 *   file and in its R twin's test (case N00), not in the handler.
 *
 * Schema language (every node has `t`):
 *
 *   number   { min, max, gt, lt, unit, default }        finite; gt/lt exclusive
 *   integer  { min, max, unit, default }
 *   boolean
 *   string   { values | valuesBy, maxLength, pattern, ref: 'input', badValueCode, default }
 *   array    { items, min, max, increasing, nondecreasing, last, unique }
 *   object   { fields, exactlyOne, atLeastOne, requires, lengthRules }
 *   variant  { on, variants: { <value>: object-fields }, default }   discriminated object
 *   map      { values, keysFrom, min, max }             keys are column names
 *   matrix   { min, max, size }                         square, numeric
 *   rules    { allowEmpty, columnsFrom }                list of { name, rule }
 *
 * and on a field: `req` (required — inside a `when` gate, required whenever the
 * gate holds), `reqWhen` (required only when the condition holds), `when`
 * (condition or list of conditions, all must hold, else the
 * key is unknown), `nullable` (null reads as absent).
 *
 * @module @evimed/domain/vcrScenarioSchemas
 */

import {
  VCR_CRITERION_STATES, VCR_CRITERION_TYPES, VCR_ENDPOINT_TYPES, VCR_MISSING_REASONS, VCR_PERFORMANCE_MEASURES,
  VCR_CONFIRMATORY_DESIGNS, VCR_CONFIRMATORY_SPENDING, VCR_POOLING_METHODS, VCR_SPENDING_FUNCTIONS, VCR_TRIAL_DESIGNS,
  VCR_BAYESIAN_DESIGNS, VCR_BAYESIAN_OBJECTIVES, VCR_DOSE_DESIGNS, VCR_DOSE_FINDING_DESIGNS,
} from './vcrVocabulary.mjs'
import {
  VCR_ROW_RULE_COLUMN_PATTERN, findExpressionFields, validateNamedRules, validateRowRule,
} from './vcrRules.mjs'
import { VCR_DEFAULT_TIME_UNIT, VCR_TIME_UNITS } from './vcrTimeUnits.mjs'
import { VCR_BARTOS_2023_EFFECT_SCALES, VCR_TURNER_COMPARISONS, VCR_TURNER_OUTCOMES } from './vcrEvidencePriors.mjs'

/** @typedef {{ code: string, field: string, detail: string }} VcrScenarioIssue */

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * A schema is data that two languages read; nothing may edit it in place.
 * @template T @param {T} value @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** @param {Record<string, any>} [o] */
const number = (o = {}) => ({ t: 'number', ...o })
/** @param {Record<string, any>} [o] */
const integer = (o = {}) => ({ t: 'integer', ...o })
/** @param {Record<string, any>} [o] */
const boolean = (o = {}) => ({ t: 'boolean', ...o })
/** @param {Record<string, any>} [o] */
const string = (o = {}) => ({ t: 'string', ...o })
/** @param {Record<string, any>} fields @param {Record<string, any>} [o] */
const object = (fields, o = {}) => ({ t: 'object', fields, ...o })
/** @param {Record<string, any>} items @param {Record<string, any>} [o] */
const array = (items, o = {}) => ({ t: 'array', items, ...o })
/** @template {Record<string, any>} N @param {N} node @returns {N & { req: true }} */
const req = (node) => ({ ...node, req: true })
/** @template {Record<string, any>} N @param {N} node @param {any} when @returns {N & { when: any }} */
const gated = (node, when) => ({ ...node, when })

/** @param {string} path @param {...string} values */
const is = (path, ...values) => ({ path, in: values })
/** @param {string} path @param {...string} values */
const isNot = (path, ...values) => ({ path, notIn: values })
/** @param {string} path @param {boolean} [present] */
const has = (path, present = true) => ({ path, present })

const CONTINUOUS = is('endpoint.type', 'continuous')
const BINARY = is('endpoint.type', 'binary')
const TIME_TO_EVENT = is('endpoint.type', 'time_to_event')
/**
 * The unit every time quantity of a time-to-event scenario is stated in (a medians, a duration, a follow-up, a horizon): the closed
 * table of `@evimed/domain` (`VCR_TIME_UNITS`). It decides how long a year is for the dropout (`dropoutAnnual` is a proportion lost
 * per year whatever the unit), and names the `_months` measures' conversion; nothing else in the engine reads a time as a unit.
 * Left out, it is months — the unit the engine always assumed — and the control plane says so in the result.
 */
const TIME_UNIT = () => gated(string({ values: [...VCR_TIME_UNITS], default: VCR_DEFAULT_TIME_UNIT }), TIME_TO_EVENT)
const SINGLE_BINARY = is('design.kind', 'single_arm', 'simon_two_stage')
const SINGLE_EXTERNAL = is('design.kind', 'single_arm_external')
const TWO_ARM_BINARY = [BINARY, isNot('design.kind', 'single_arm', 'single_arm_external', 'simon_two_stage')]
/** The binary single-arm and Simon designs state their rates; a single-arm trial of a mean or a survival time states an effect over its benchmark. */
const SINGLE_BINARY_ENDPOINT = [SINGLE_BINARY, BINARY]
const SINGLE_CONTINUOUS = [CONTINUOUS, is('design.kind', 'single_arm')]
const BINARY_RATE = { min: 0, max: 1 }
const SINGLE_SIZE = integer({ min: 1, max: 10000 })
const EXTERNAL_MODEL = object({
  kind: req(string({ values: ['stratified_beta_binomial'] })),
  n: req(integer({ min: 2, max: 1000000 })),
  targetPrevalence: req(number(BINARY_RATE)), sourcePrevalence: req(number(BINARY_RATE)),
  parameterInformation: req(number({ gt: 0, max: 1000000000 })),
  logOddsDrift: req(number({ min: -10, max: 10 })),
  sensitivityDrifts: req(array(number({ min: -10, max: 10 }), { min: 1, max: 9, unique: true })),
})

/** A column name, in the row-rule grammar's spelling. */
const COLUMN = string({ pattern: VCR_ROW_RULE_COLUMN_PATTERN, maxLength: 64 })
const COLUMN_LIST = array(COLUMN, { min: 1, max: 100, unique: true })
const PROBABILITY = { gt: 0, lt: 1 }

// The vocabulary check names an unknown type (`endpoint_unknown`); whether the
// method implements a known one is `endpoint_not_supported`, decided by the
// job validator from the method's own list, so it is not repeated per schema.
const ENDPOINT = () => object({ type: req(string({ values: [...VCR_ENDPOINT_TYPES], badValueCode: 'endpoint_unknown' })) })

const ALPHA = number({ ...PROBABILITY, default: 0.025 })

const CRITERION_NAME = { minLength: 1, maxLength: 80 }

const KM_CURVE = array(object({ time: req(number({ min: 0 })), surv: req(number({ gt: 0, max: 1 })) }), { min: 2, max: 2000 })
const KM_RISK_TABLE = array(object({ time: req(number({ min: 0 })), atRisk: req(number({ min: 0 })) }), { min: 2, max: 200 })

/** Inputs a method names by id, checked against the job's inputs. */
const INPUT_REF = string({ ref: 'input', maxLength: 141 })

/** One named inclusion step of a cohort: a rule and what to do with the rows it cannot judge. */
const COHORT_STEP = object({
  name: req(string(CRITERION_NAME)),
  rule: req({ t: 'rule' }),
  unknownAs: string({ values: ['include', 'exclude'], default: 'exclude' }),
})
const COHORT_STEPS = array(COHORT_STEP, { min: 1, max: 100 })

/** How closely a real-world control emulates each element of the target trial. */
const TARGET_TRIAL = array(object({
  item: req(string({ maxLength: 80 })),
  emulation: req(string({ values: ['exact', 'approximate', 'cannot'] })),
}), { min: 1, max: 50 })

/** What a simulated design costs, for the design's cost measure. */
const COSTS = object({
  perPatient: number({ min: 0 }), perSite: number({ min: 0 }), perMonth: number({ min: 0 }), sites: integer({ min: 0 }),
})

/**
 * A declared estimand a synthetic population is checked on, by the analysis a
 * study would actually run (utility of the data): the mean of one column, or a
 * regression coefficient. Data, never code.
 */
const ANALYSES = array({
  t: 'variant', on: 'kind',
  variants: {
    mean: { name: string(CRITERION_NAME), column: req(COLUMN) },
    glm: {
      name: string(CRITERION_NAME), outcome: req(COLUMN), predictors: req(array(COLUMN, { min: 1, max: 50 })), target: req(COLUMN),
      family: req(string({ values: ['gaussian', 'binomial'] })),
    },
    // the time-to-event analyses a study actually runs (population.synthpop / population.quality 1.1.0, algorithm round P1): `status` is 1 for an event;
    // a Cox model reports the log hazard ratio of its target, the log-rank test the Peto log hazard ratio of the second group against the first,
    // and the restricted mean survival time the difference of the second group's less the first's up to `tau`
    cox: { name: string(CRITERION_NAME), time: req(COLUMN), status: req(COLUMN), predictors: req(array(COLUMN, { min: 1, max: 50 })), target: req(COLUMN) },
    logrank: { name: string(CRITERION_NAME), time: req(COLUMN), status: req(COLUMN), group: req(COLUMN) },
    rmst: { name: string(CRITERION_NAME), time: req(COLUMN), status: req(COLUMN), group: req(COLUMN), tau: req(number({ gt: 0 })) },
  },
}, { min: 1, max: 20 })

/**
 * What a synthesis or a quality report may be asked beyond 1.0.0 (algorithm round P1, P2): the false-positive rate of one declared analysis
 * on the generator's own copies when the arm labels of the real table are permuted (`inference`), and the per-record and attribute-inference
 * measures of the disclosure axis (`privacy`).
 */
const SYNTHETIC_INFERENCE = object({
  nullCalibration: object({
    analysis: req(string(CRITERION_NAME)),
    replicates: integer({ min: 20, max: 1000, default: 100 }),
    copies: integer({ min: 1, max: 5, default: 1 }),
  }),
})
/**
 * `population.quality` reads a table the engine did not necessarily make: `parametersRedrawn` says the generator redrew its parameters for every copy
 * (the proper-synthesis rule of Raab, Nowok and Dibben), which the engine's own generator never does. Without it the rule that fits the engine's own
 * synthesis is applied to such a table and rejects too often (a false-positive rate of .099 against .05 with one copy, review stats2 finding 27).
 */
const SYNTHETIC_QUALITY_INFERENCE = object({
  ...SYNTHETIC_INFERENCE.fields,
  parametersRedrawn: boolean({ default: false }),
})
const SYNTHETIC_PRIVACY = object({
  membershipRiskBound: number({ gt: 0.5, lt: 1, default: 0.75 }),
  secrets: array(COLUMN, { min: 1, max: 10, unique: true }),
  attacks: integer({ min: 50, max: 2000, default: 500 }),
})

/** Which parameters of a variable are uncertain, and by how much (per-variable parameter uncertainty). */
const PARAM_SD = { t: 'map', values: number({ min: 0 }), min: 1, max: 4 }

/**
 * The prior for a pooling's between-study standard deviation (`evidence.pool`, 1.1.0). A stated family keeps its own parametrization (a half-normal
 * and an inverse-gamma on tau; a log-normal and a log-t on tau-squared); the empirical ones are looked up in `vcrEvidencePriors.mjs`.
 */
const TAU_PRIOR = {
  t: 'variant', on: 'kind',
  variants: {
    half_normal: { scale: req(number({ gt: 0 })) },
    log_normal: { meanLog: req(number()), sdLog: req(number({ gt: 0 })) },
    inverse_gamma: { shape: req(number({ gt: 0 })), scale: req(number({ gt: 0 })) },
    log_t: { location: req(number()), scale: req(number({ gt: 0 })), df: req(number({ gt: 0 })) },
    turner_2015: { outcome: req(string({ values: [...VCR_TURNER_OUTCOMES] })), comparison: req(string({ values: [...VCR_TURNER_COMPARISONS] })) },
    turner_2015_generic: {},
    bartos_2023: { effectScale: req(string({ values: [...VCR_BARTOS_2023_EFFECT_SCALES] })) },
  },
}

/** The names a covariate effect is keyed by: columns of the generated data. */
const COVARIATE_EFFECTS = { t: 'map', values: number(), min: 1, max: 100 }


// ---------------------------------------------------------------------------
// Shared blocks
// ---------------------------------------------------------------------------

/**
 * A piecewise profile lists the end of every interval but the last (`breaks`) and one rate per interval (`rates`), the last
 * running on: one rate more than there are breaks. A list of the wrong length used to be recycled with a warning or read as NA.
 */
const ONE_RATE_PER_INTERVAL = Object.freeze({ lengthRules: Object.freeze([Object.freeze({ key: 'rates', of: 'breaks', plus: 1 })]) })

/** Control-arm survival: exponential, Weibull or piecewise-exponential. */
const CONTROL_DISTRIBUTION = {
  t: 'variant', on: 'kind', default: 'exponential',
  variants: {
    exponential: { rate: req(number({ gt: 0, unit: 'per time unit' })) },
    weibull: { shape: req(number({ gt: 0 })), scale: req(number({ gt: 0, unit: 'time units' })) },
    piecewise: {
      breaks: req(array(number({ gt: 0 }), { min: 1, max: 50, increasing: true })),
      rates: req(array(number({ gt: 0 }), { min: 2, max: 51 })),
    },
  },
  variantGroups: { piecewise: ONE_RATE_PER_INTERVAL },
}

/**
 * A treatment-arm hazard ratio that changes over time (remediation plan D1; simulation only): `ratios[j]` applies on the j-th interval
 * of `breaks`, the last running on, so a delayed effect is ratios [1, 0.6] with one break and a crossing of the curves [1.4, 0.6].
 * A formula cannot size it, so the analytic design refuses it by name and points to the simulation.
 */
const TREATMENT_HAZARD_RATIOS = object({
  breaks: req(array(number({ gt: 0, unit: 'time units' }), { min: 1, max: 20, increasing: true })),
  ratios: req(array(number({ gt: 0 }), { min: 2, max: 21 })),
}, { lengthRules: [{ key: 'ratios', of: 'breaks', plus: 1 }] })

/**
 * The data-generating truth of a two-arm trial, by endpoint family. `binaryWhen`
 * is the gate of the binary keys (the analytic path drops them for a Simon
 * design, which is single-arm).
 * `nph` lets a simulated two-arm time-to-event truth state a hazard ratio that changes over time instead of one ratio.
 * @param {{ binaryWhen?: any, simulated?: boolean, generator?: boolean, nph?: boolean, extra?: Record<string, any> }} [options]
 */
const truthFields = ({ binaryWhen = BINARY, simulated = true, generator = false, nph = false, extra = {} } = {}) => ({
  ...(simulated && !generator ? { null: boolean() } : {}),
  effect: req(gated(number({ unit: 'outcome units' }), CONTINUOUS)),
  sd: gated(number({ gt: 0, default: 1, unit: 'outcome units' }), CONTINUOUS),
  // two-arm only: a single-arm trial has no baseline covariate to correlate the outcome with
  ...(simulated ? { baselineCorrelation: gated(number({ gt: -1, lt: 1, default: 0 }), [CONTINUOUS, isNot('design.kind', 'single_arm')]) } : {}),
  controlRate: req(gated(number({ ...PROBABILITY }), binaryWhen)),
  treatmentRate: gated(number({ ...PROBABILITY }), binaryWhen),
  riskDifference: gated(number({ gt: -1, lt: 1 }), binaryWhen),
  oddsRatio: gated(number({ gt: 0 }), binaryWhen),
  ...(simulated ? { covariateLogit: gated(number({ default: 0 }), binaryWhen) } : {}),
  // a simulated two-arm trial states either one hazard ratio or one that changes over time (an exactlyOne group of the schema); a
  // single-arm trial against its benchmark states the one ratio
  hazardRatio: nph ? { ...gated(number({ gt: 0 }), TIME_TO_EVENT), reqWhen: is('design.kind', 'single_arm') } : req(gated(number({ gt: 0 }), TIME_TO_EVENT)),
  ...(nph ? { treatmentHazardRatios: gated(TREATMENT_HAZARD_RATIOS, [TIME_TO_EVENT, is('design.kind', 'two_arm_fixed', 'group_sequential')]) } : {}),
  controlMedian: gated(number({ gt: 0, unit: 'time units' }), TIME_TO_EVENT),
  controlDistribution: gated(CONTROL_DISTRIBUTION, TIME_TO_EVENT),
  ...extra,
})
/** @param {any} [binaryWhen] */
const truthGroups = (binaryWhen = BINARY) => [
  { keys: ['treatmentRate', 'riskDifference', 'oddsRatio'], when: binaryWhen },
  { keys: ['controlMedian', 'controlDistribution'], when: TIME_TO_EVENT },
]

const PERFORMANCE = array(string({ values: [...VCR_PERFORMANCE_MEASURES] }), { min: 0, max: VCR_PERFORMANCE_MEASURES.length, unique: true })
const TARGET_MCSE = number({ min: 0.0005, max: 0.05, unit: 'proportion' })

/** Accrual and follow-up of a simulated time-to-event trial. */
const SIMULATED_ACCRUAL = gated({
  t: 'variant', on: 'kind', default: 'uniform',
  variants: {
    uniform: {
      duration: number({ min: 0, default: 0, unit: 'time units' }),
      // the rate a person states (「每月入组 20 人」): the platform derives `duration` from it and the stated sizes before the scenario is frozen
      // (vcrAccrualRate.mjs); the engine reads the duration, never the rate
      rate: number({ gt: 0, unit: 'people per rateUnit' }),
      rateUnit: string({ values: [...VCR_TIME_UNITS] }),
      followup: number({ min: 0, unit: 'time units' }),
      dropoutAnnual: number({ min: 0, lt: 1, default: 0, unit: 'proportion per year' }),
      maxFollowup: number({ gt: 0, unit: 'time units' }),
    },
    piecewise: {
      // rates[i] is the accrual per time unit on the i-th interval; the last interval is open in the profile, so its length is stated:
      // patients enter for `tail` time units after the last break. There is no default length (the engine once assumed 1,000,000).
      breaks: req(array(number({ gt: 0 }), { min: 1, max: 50, increasing: true })),
      rates: req(array(number({ gt: 0 }), { min: 2, max: 51 })),
      tail: req(number({ gt: 0, unit: 'time units' })),
      followup: number({ min: 0, unit: 'time units' }),
      dropoutAnnual: number({ min: 0, lt: 1, default: 0, unit: 'proportion per year' }),
      maxFollowup: number({ gt: 0, unit: 'time units' }),
    },
  },
  variantGroups: { piecewise: ONE_RATE_PER_INTERVAL },
}, TIME_TO_EVENT)

const SIMULATED_ANALYSIS = object({
  method: string({ values: ['ttest', 'ancova', 'risk_difference', 'logistic', 'logrank', 'rmst', 'maxcombo', 'modestly_weighted', 'exact_binomial', 'simon_boundary', 'stratified_risk_difference', 'one_sample_t', 'one_sample_z', 'one_sample_logrank'], reqWhen: is('design.kind', 'single_arm', 'single_arm_external', 'simon_two_stage') }),
  // the standard deviation a one-sample z analysis takes as known (it need not be the generator's)
  sd: req(gated(number({ gt: 0, unit: 'outcome units' }), is('analysis.method', 'one_sample_z'))),
  alternative: req(gated(string({ values: ['greater', 'less', 'two.sided'] }), is('design.kind', 'single_arm'))),
  estimand: req(gated(string({ values: ['ATT'] }), SINGLE_EXTERNAL)),
  alpha: ALPHA,
  sided: integer({ min: 1, max: 2, default: 1 }),
  tau: req(gated(number({ gt: 0, unit: 'time units' }), is('analysis.method', 'rmst'))),
  // the modestly weighted log-rank test (1.5.0): the weight is 1 / max(S, sStar) of the pooled survival curve, so at most 1 / sStar times the earliest
  sStar: gated(number({ gt: 0, max: 1, default: 0.5 }), is('analysis.method', 'modestly_weighted')),
})

const SIMULATED_DESIGN_FIELDS = {
  kind: req(string({ values: [...VCR_TRIAL_DESIGNS], badValueCode: 'design_unknown' })),
  nTreat: req(gated(integer({ min: 1, max: 1000000 }), is('design.kind', 'two_arm_fixed', 'group_sequential'))),
  nControl: gated(integer({ min: 1, max: 1000000 }), is('design.kind', 'two_arm_fixed', 'group_sequential')),
  n: req(gated(SINGLE_SIZE, is('design.kind', 'single_arm', 'single_arm_external', 'simon_two_stage'))),
  n1: req(gated(SINGLE_SIZE, is('design.kind', 'simon_two_stage'))),
  r1: req(gated(integer({ min: 0, max: 9999 }), is('design.kind', 'simon_two_stage'))),
  r: req(gated(integer({ min: 0, max: 9999 }), is('design.kind', 'simon_two_stage'))),
  informationRates: req(gated(array(number({ gt: 0, max: 1 }), { min: 2, max: 20, increasing: true, last: 1 }), is('design.kind', 'group_sequential'))),
  spending: gated(string({ values: [...VCR_SPENDING_FUNCTIONS], default: 'obrien_fleming' }), is('design.kind', 'group_sequential')),
}

/**
 * The hypothesis a two-arm design tests (T1, design.analytic and design.simulate 1.4.0). Without it a design tests superiority, as every
 * design did; `non_inferiority` states the margin the new treatment may fall short of the control by: a mean difference in the outcome's
 * units, a risk difference, or (for an event-time endpoint) a hazard ratio above 1. The margin is a clinical choice and is never filled
 * in: a design that states none is a superiority design, and the result says so.
 */
const HYPOTHESIS = object({
  kind: req(string({ values: ['superiority', 'non_inferiority'] })),
  margin: req(gated(number({ gt: 0, unit: 'the endpoint\'s own scale: outcome units, risk difference, or hazard ratio' }), is('hypothesis.kind', 'non_inferiority'))),
  // which way the margin points (2026-11-04): a mean or a risk difference of "not worse than the margin" is a different question for an outcome
  // where higher is better (a response rate) and one where lower is (an adverse event), 34,504 patients against 1,404 for the same two rates, so
  // it is never defaulted. A hazard ratio's direction is known (a lower ratio is the benefit) and the key is not read for it.
  direction: req(gated(string({ values: ['higher_better', 'lower_better'] }), [is('hypothesis.kind', 'non_inferiority'), isNot('endpoint.type', 'time_to_event')])),
})

/**
 * A confirmatory design (algorithm round T2-T6, `design.confirmatory` 1.0.0): the group-sequential design with a futility boundary, the
 * sample-size re-estimation, the multi-arm selection, the enrichment and the count endpoint. The effect keys are on the endpoint's own
 * scale (continuous: the difference of means; binary: the risk difference; time to event: the hazard ratio; a count: the rate ratio),
 * the control-side keys are the same ones the other design methods read, and everything the person leaves out that the design needs is a
 * default the result lists as an assumption.
 */
const CONF_KIND = (/** @type {string[]} */ ...kinds) => is('design.kind', ...kinds)
const CONF_ADAPTIVE = CONF_KIND('sample_size_reestimation', 'multi_arm_selection', 'enrichment')
const CONF_SELECTION = object({
  rule: string({ values: ['best', 'rbest', 'epsilon', 'all'], default: 'best' }),
  r: req(gated(integer({ min: 1, max: 3 }), is('design.selection.rule', 'rbest'))),
  epsilon: req(gated(number({ gt: 0, max: 5 }), is('design.selection.rule', 'epsilon'))),
})

const CONFIRMATORY_SCHEMA = object({
  design: req(object({
    kind: req(string({ values: [...VCR_CONFIRMATORY_DESIGNS], badValueCode: 'design_unknown' })),
    // the looks, as cumulative information fractions ending at 1; the adaptive designs look once (two entries), a count endpoint may have none
    informationRates: { ...array(number({ gt: 0, max: 1 }), { min: 2, max: 8, increasing: true, last: 1 }), reqWhen: isNot('design.kind', 'count_endpoint') },
    spending: string({ values: [...VCR_CONFIRMATORY_SPENDING], default: 'obrien_fleming' }),
    spendingGamma: req(gated(number({ min: -10, max: 10 }), is('design.spending', 'hwang_shih_decani', 'kim_demets'))),
    allocation: gated(number({ ...PROBABILITY, default: 0.5 }), CONF_KIND('futility_group_sequential', 'sample_size_reestimation', 'count_endpoint')),
    futility: gated(object({
      spending: string({ values: [...VCR_CONFIRMATORY_SPENDING], default: 'obrien_fleming' }),
      gamma: req(gated(number({ min: -10, max: 10 }), is('design.futility.spending', 'hwang_shih_decani', 'kim_demets'))),
      binding: boolean({ default: false }),
    }), CONF_KIND('futility_group_sequential')),
    conditionalPower: gated(number({ ...PROBABILITY, default: 0.8 }), CONF_KIND('sample_size_reestimation')),
    // the promising zone (design.confirmatory 1.1.0): the size is enlarged only when the conditional power of the planned second stage, read at
    // the interim estimate, lies between the two bounds; below the lower or above the upper bound the planned size is kept
    promisingZone: gated(object({
      lower: req(number({ min: 0, max: 1, unit: 'conditional power' })),
      upper: req(number({ min: 0, max: 1, unit: 'conditional power' })),
    }), CONF_KIND('sample_size_reestimation')),
    maxSampleSizeFactor: gated(number({ gt: 1, max: 10, default: 2, unit: 'times the planned size' }), CONF_KIND('sample_size_reestimation')),
    plannedSize: gated(integer({ min: 4, max: 1_000_000, unit: 'patients, or events for a time-to-event endpoint' }), CONF_ADAPTIVE),
    activeArms: req(gated(integer({ min: 2, max: 4 }), CONF_KIND('multi_arm_selection'))),
    selection: gated(CONF_SELECTION, [CONF_KIND('multi_arm_selection', 'enrichment')]),
    intersectionTest: gated(string({ values: ['simes', 'bonferroni', 'dunnett'], default: 'simes' }), CONF_KIND('multi_arm_selection', 'enrichment')),
    subsetPrevalence: req(gated(number({ ...PROBABILITY }), CONF_KIND('enrichment'))),
  })),
  endpoint: req(gated(ENDPOINT(), isNot('design.kind', 'count_endpoint'))),
  // which way a mean difference or a risk difference is better (2026-11-04). It orients every effect of the scenario the same way in all five
  // kinds: higher_better reads a positive difference as the benefit, lower_better a negative one. A hazard ratio and a rate ratio have their
  // direction already (below 1 is the benefit) and the key is not read for them. Never defaulted: the same -0.1 is a benefit of ten points
  // or a harm of ten points, and a size planned for the wrong one is power 0.
  hypothesis: req(gated(object({
    kind: string({ values: ['superiority'] }),
    direction: req(string({ values: ['higher_better', 'lower_better'] })),
  }), is('endpoint.type', 'continuous', 'binary'))),
  truth: req(object({
    plannedEffect: req(gated(number(), CONF_KIND('futility_group_sequential', 'sample_size_reestimation'))),
    effects: gated(array(number(), { min: 1, max: 8 }), CONF_KIND('sample_size_reestimation')),
    effectScenarios: req(gated(array(array(number(), { min: 2, max: 4 }), { min: 1, max: 8 }), CONF_KIND('multi_arm_selection'))),
    subsetEffects: req(gated(array(object({ subset: req(number()), rest: req(number()) }), { min: 1, max: 8 }), CONF_KIND('enrichment'))),
    sd: gated(number({ gt: 0, default: 1, unit: 'outcome units' }), [CONTINUOUS, isNot('design.kind', 'count_endpoint')]),
    controlRate: req(gated(number({ ...PROBABILITY }), [BINARY, isNot('design.kind', 'count_endpoint')])),
    // the selection and the enrichment designs are simulated on the log-rank statistics from the planned events: no control median and no accrual
    // are needed; when both are stated (design.confirmatory 1.2.0) the events are turned into people (checkConfirmatorySemantics: one without the other is refused)
    controlMedian: { ...gated(number({ gt: 0, unit: 'time units' }), [TIME_TO_EVENT, CONF_KIND('futility_group_sequential', 'sample_size_reestimation', 'multi_arm_selection', 'enrichment')]), reqWhen: [TIME_TO_EVENT, isNot('design.kind', 'multi_arm_selection', 'enrichment')] },
    controlEventRate: req(gated(number({ gt: 0, unit: 'events per patient per unit of exposure time' }), CONF_KIND('count_endpoint'))),
    rateRatio: req(gated(number({ gt: 0 }), CONF_KIND('count_endpoint'))),
    overdispersion: req(gated(number({ min: 0, max: 20 }), CONF_KIND('count_endpoint'))),
    exposureTime: gated(number({ gt: 0, default: 1, unit: 'unit of exposure time' }), CONF_KIND('count_endpoint')),
  })),
  analysis: object({
    alpha: number({ ...PROBABILITY, default: 0.025, unit: 'one-sided level' }),
    power: number({ ...PROBABILITY, default: 0.9 }),
  }),
  accrual: gated(object({
    duration: req(number({ min: 0, unit: 'time units' })),
    followup: req(number({ min: 0, unit: 'time units' })),
    dropoutAnnual: number({ min: 0, lt: 1, default: 0, unit: 'proportion per year' }),
  }), [TIME_TO_EVENT, CONF_KIND('futility_group_sequential', 'sample_size_reestimation', 'multi_arm_selection', 'enrichment')]),
  timeUnit: gated(string({ values: [...VCR_TIME_UNITS], default: VCR_DEFAULT_TIME_UNIT }), [TIME_TO_EVENT, CONF_KIND('futility_group_sequential', 'sample_size_reestimation', 'multi_arm_selection', 'enrichment')]),
})

/**
 * A dose-finding design (algorithm round T7, T15, `design.dose` 1.0.0). `design.kind` is the design asked about; `design.compare` lists others
 * to run on the same toxicity curve with the same random numbers (3+3, BOIN, keyboard, CRM). The per-design settings (`boin`, `keyboard`,
 * `crm`) are read when that design runs, whether it is the one asked about or a comparison; one for a design that does not run is refused
 * (`checkDoseSemantics`). A randomised selection among two or three doses is exact and has its own truth (`responseScenarios`).
 * Everything left out is a default the result lists as an assumption.
 */
const DOSE_SELECTION = is('design.kind', 'randomized_selection')
const DOSE_SIMULATED = isNot('design.kind', 'randomized_selection')
/**
 * The precision a design-search campaign evaluates a candidate at (version 1). Set by the platform's campaign alone: the job queue
 * refuses it from every other caller. With `screeningReplicates` the run is a screening run of exactly that many replicates, below the
 * method's floor (`maxScreening` is one under it), and the engine labels every measure screening precision; without it the run is a
 * final one at the normal floor. Either way the result reports what lets two runs be compared pairwise (the draw signature, and for a
 * simulated design the per-replicate rejections). A changed block is a changed scenario: its own hash, cache key and receipt.
 * @param {number} maxScreening
 */
const EVALUATION = (maxScreening) => object({
  version: req(integer({ min: 1, max: 1 })),
  screeningReplicates: integer({ min: 200, max: maxScreening, unit: 'replicates' }),
})

const DOSE_SCHEMA = object({
  evaluation: gated(EVALUATION(9999), DOSE_SIMULATED),
  design: req(object({
    kind: req(string({ values: [...VCR_DOSE_DESIGNS], badValueCode: 'design_unknown' })),
    compare: gated(array(string({ values: [...VCR_DOSE_FINDING_DESIGNS] }), { min: 1, max: 3, unique: true }), DOSE_SIMULATED),
    targetToxicity: gated(number({ min: 0.05, max: 0.6, default: 0.3, unit: 'probability of a dose-limiting toxicity' }), DOSE_SIMULATED),
    cohortSize: gated(integer({ min: 1, max: 6, default: 3, unit: 'patients' }), DOSE_SIMULATED),
    maxPatients: gated(integer({ min: 6, max: 200, default: 30, unit: 'patients' }), DOSE_SIMULATED),
    startDose: gated(integer({ min: 1, max: 10, default: 1 }), DOSE_SIMULATED),
    boin: gated(object({
      safeRate: number({ gt: 0, lt: 1, unit: 'toxicity rate deemed safe' }),
      toxicRate: number({ gt: 0, lt: 1, unit: 'toxicity rate deemed too toxic' }),
      eliminationCutoff: number({ gt: 0.5, lt: 1, default: 0.95 }),
    }), DOSE_SIMULATED),
    keyboard: gated(object({
      margin: number({ gt: 0, max: 0.2, default: 0.05, unit: 'half the width of the target key' }),
      eliminationCutoff: number({ gt: 0.5, lt: 1, default: 0.95 }),
    }), DOSE_SIMULATED),
    crm: gated(object({
      skeleton: array(number({ gt: 0, lt: 1 }), { min: 2, max: 10, increasing: true }),
      halfwidth: number({ gt: 0, max: 0.2, default: 0.05 }),
      priorVariance: number({ gt: 0, max: 20, default: 1.34 }),
      restrictEscalation: boolean({ default: true }),
    }), DOSE_SIMULATED),
    // the randomised selection: the higher dose is chosen only when it looks better by at least the margin
    margin: req(gated(number({ gt: 0, lt: 1, unit: 'response rate difference' }), DOSE_SELECTION)),
    perArm: gated(integer({ min: 2, max: 2000, unit: 'patients per dose' }), DOSE_SELECTION),
    maxPerArm: gated(integer({ min: 4, max: 2000, default: 300, unit: 'patients per dose' }), DOSE_SELECTION),
    targetProbability: gated(number({ gt: 0, lt: 1, default: 0.9 }), DOSE_SELECTION),
  })),
  truth: req(object({
    toxicity: req(gated(array(number({ gt: 0, lt: 1 }), { min: 2, max: 10, nondecreasing: true }), DOSE_SIMULATED)),
    responseScenarios: req(gated(array(array(number({ gt: 0, lt: 1 }), { min: 2, max: 3 }), { min: 1, max: 6 }), DOSE_SELECTION)),
  })),
})

/**
 * A Bayesian design without MCMC (algorithm round T8, T10, `design.bayesian` 1.0.0): the phase II designs `bop2` and `predictive_monitoring` for a
 * single-arm response rate (stated by the null and the alternative rate), and `threshold_calibration` for the success rule
 * "posterior probability that the effect exceeds a margin is above c" of a two-arm trial under a conjugate prior. All exact.
 */
const BAYES_KIND = (/** @type {string[]} */ ...kinds) => is('design.kind', ...kinds)
const BAYES_PHASE2 = BAYES_KIND('bop2', 'predictive_monitoring')
const BAYES_CALIBRATION = BAYES_KIND('threshold_calibration')
const BAYES_BETA = object({ a: req(number({ gt: 0, max: 1000 })), b: req(number({ gt: 0, max: 1000 })) })
const BAYESIAN_SCHEMA = object({
  design: req(object({
    kind: req(string({ values: [...VCR_BAYESIAN_DESIGNS], badValueCode: 'design_unknown' })),
    // phase II: the largest size, how often to look, the prior of the response rate, what the search is for
    maxN: req(gated(integer({ min: 10, max: 300, unit: 'patients' }), BAYES_PHASE2)),
    lookEvery: gated(integer({ min: 1, max: 300, default: 10, unit: 'patients' }), BAYES_PHASE2),
    prior: gated(BAYES_BETA, BAYES_PHASE2),
    objective: gated(string({ values: [...VCR_BAYESIAN_OBJECTIVES], default: 'max_power' }), BAYES_PHASE2),
    bop2: gated(object({
      lambda: number({ gt: 0, lt: 1 }), gamma: number({ gt: 0, max: 10 }),
      efficacyEta: number({ gt: 0, max: 10 }),
    }, { requires: { lambda: ['gamma'], gamma: ['lambda'] } }), BAYES_KIND('bop2')),
    predictive: gated(object({
      final: number({ gt: 0, lt: 1 }), futility: number({ gt: 0, lt: 1, default: 0.05 }), efficacy: number({ gt: 0, lt: 1 }),
    }), BAYES_KIND('predictive_monitoring')),
    // threshold calibration
    nTreat: req(gated(integer({ min: 2, max: 600, unit: 'patients' }), [BAYES_CALIBRATION, isNot('endpoint.type', 'time_to_event')])),
    nControl: req(gated(integer({ min: 2, max: 600, unit: 'patients' }), [BAYES_CALIBRATION, isNot('endpoint.type', 'time_to_event')])),
    events: req(gated(integer({ min: 2, max: 100000, unit: 'events' }), [BAYES_CALIBRATION, TIME_TO_EVENT])),
    allocation: gated(number({ ...PROBABILITY, default: 0.5 }), [BAYES_CALIBRATION, TIME_TO_EVENT]),
    margin: gated(number({ min: -1, max: 1000, unit: 'the effect the posterior must exceed: a difference, a risk difference, or a hazard ratio below which the treatment is better' }), BAYES_CALIBRATION),
    threshold: gated(number({ gt: 0, lt: 1 }), BAYES_CALIBRATION),
    priorTreatment: gated(BAYES_BETA, [BAYES_CALIBRATION, BINARY]),
    priorControl: gated(BAYES_BETA, [BAYES_CALIBRATION, BINARY]),
    // a normal prior on the effect (a difference of means, or a log hazard ratio); left out, the prior is flat
    priorEffect: gated(object({ mean: req(number()), sd: req(number({ gt: 0 })) }), [BAYES_CALIBRATION, isNot('endpoint.type', 'binary')]),
  })),
  endpoint: req(gated(ENDPOINT(), BAYES_CALIBRATION)),
  truth: req(object({
    nullRate: req(gated(number({ ...PROBABILITY }), BAYES_PHASE2)),
    alternativeRate: req(gated(number({ ...PROBABILITY }), BAYES_PHASE2)),
    sd: gated(number({ gt: 0, default: 1, unit: 'outcome units' }), [BAYES_CALIBRATION, CONTINUOUS]),
    effect: req(gated(number(), [BAYES_CALIBRATION, CONTINUOUS])),
    hazardRatio: req(gated(number({ gt: 0 }), [BAYES_CALIBRATION, TIME_TO_EVENT])),
    controlRate: req(gated(number({ ...PROBABILITY }), [BAYES_CALIBRATION, BINARY])),
    treatmentRate: req(gated(number({ ...PROBABILITY }), [BAYES_CALIBRATION, BINARY])),
  })),
  analysis: object({
    alpha: number({ ...PROBABILITY, unit: 'one-sided level' }),
    power: gated(number({ ...PROBABILITY }), BAYES_PHASE2),
  }),
})

/**
 * A hierarchical composite endpoint compared by win ratio (algorithm round T9, `design.win_ratio` 1.0.0): death first, then recurrent events
 * (fewer is better) and a score (higher is better, with a threshold below which two people tie) when they are stated. The size of each arm
 * gives the power; the power wanted, with no size, gives the size. Everybody is followed for the same time (`design.followup`) unless they die or
 * leave (`dropoutAnnual`). One correlation links the three levels through a shared severity factor. Everything left out is a default the
 * result lists as an assumption.
 */
const WIN_RATIO_SCHEMA = object({
  design: req(object({
    nTreat: integer({ min: 10, max: 1500, unit: 'patients', reqWhen: has('analysis.power', false) }),
    nControl: integer({ min: 10, max: 1500, unit: 'patients', when: has('design.nTreat') }),
    maxPerArm: gated(integer({ min: 10, max: 1500, default: 1000, unit: 'patients per arm' }), has('analysis.power')),
    followup: req(number({ gt: 0, unit: 'time units' })),
    dropoutAnnual: number({ min: 0, lt: 1, default: 0, unit: 'proportion per year' }),
  })),
  truth: req(object({
    death: req(object({
      hazardRatio: req(number({ gt: 0 })),
      controlMedian: number({ gt: 0, unit: 'time units' }),
      controlRisk: number({ gt: 0, lt: 1, unit: 'proportion dying within the follow-up' }),
    }, { exactlyOne: [['controlMedian', 'controlRisk']] })),
    events: object({
      controlRate: req(number({ gt: 0, unit: 'events per person per time unit' })),
      rateRatio: req(number({ gt: 0 })),
      overdispersion: number({ min: 0, max: 5, default: 1 }),
    }),
    score: object({
      shift: req(number({ unit: 'score units, treatment minus control, higher is better' })),
      sd: number({ gt: 0, default: 1, unit: 'score units' }),
      threshold: number({ min: 0, default: 0, unit: 'score units' }),
    }),
    correlation: number({ min: 0, max: 0.95, default: 0.3 }),
  }, { atLeastOne: [['events', 'score']] })),
  analysis: object({
    alpha: ALPHA,
    sided: integer({ min: 1, max: 2, default: 1 }),
    power: number({ ...PROBABILITY }),
  }),
  timeUnit: string({ values: [...VCR_TIME_UNITS], default: VCR_DEFAULT_TIME_UNIT }),
})

const SIMULATE_FIELDS = {
  design: req(object(SIMULATED_DESIGN_FIELDS)),
  endpoint: req(ENDPOINT()),
  truth: req(object(truthFields({ binaryWhen: TWO_ARM_BINARY, nph: true, extra: {
    nullRate: req(gated(number(BINARY_RATE), SINGLE_BINARY_ENDPOINT)),
    responseRate: req(gated(number(BINARY_RATE), SINGLE_BINARY_ENDPOINT)),
    alternativeRate: req(gated(number(BINARY_RATE), is('design.kind', 'simon_two_stage'))),
    // the fixed historical mean a single-arm trial of a continuous endpoint is compared with (the trial's mean is benchmark + effect)
    benchmark: gated(number({ default: 0, unit: 'outcome units' }), SINGLE_CONTINUOUS),
    controlRates: req(gated(array(number(BINARY_RATE), { min: 2, max: 2 }), SINGLE_EXTERNAL)),
    treatmentRates: req(gated(array(number(BINARY_RATE), { min: 2, max: 2 }), SINGLE_EXTERNAL)),
  } }), { exactlyOne: [...truthGroups(TWO_ARM_BINARY),
    { keys: ['hazardRatio', 'treatmentHazardRatios'], when: [TIME_TO_EVENT, is('design.kind', 'two_arm_fixed', 'group_sequential')] }] })),
  analysis: { ...SIMULATED_ANALYSIS, reqWhen: is('design.kind', 'single_arm', 'single_arm_external', 'simon_two_stage') },
  external: req(gated(EXTERNAL_MODEL, SINGLE_EXTERNAL)),
  accrual: SIMULATED_ACCRUAL,
  timeUnit: TIME_UNIT(),
  hypothesis: HYPOTHESIS,
  performance: PERFORMANCE,
  targetMcse: TARGET_MCSE,
  costs: COSTS,
}

/** A generator: two arms drawn from one endpoint family's reference simulator. */
const patientsFields = () => ({
  cohortRules: COHORT_STEPS,
  pairing: object({ key: req(string({ minLength: 1, maxLength: 200 })), replicate: req(integer({ min: 1, max: 10000 })) }),
  design: req(object({ nTreat: req(integer({ min: 1, max: 1_000_000 })), nControl: integer({ min: 0, max: 1_000_000 }) })),
  endpoint: req(ENDPOINT()),
  truth: req(object(truthFields({ generator: true, extra: { covariateEffects: COVARIATE_EFFECTS } }), { exactlyOne: truthGroups() })),
  accrual: SIMULATED_ACCRUAL,
  timeUnit: TIME_UNIT(),
})

// ---------------------------------------------------------------------------
// Population variables (population.scenario)
// ---------------------------------------------------------------------------

const VARIABLE_BOUNDS = { min: number(), max: number() }
const VARIABLE_LABEL = string({ maxLength: 80 })
/**
 * What a variable of a stated population may carry besides its distribution: how uncertain each parameter is, and the name a
 * reader sees for it. The label is display only (the engine never reads it into a calculation); it comes back in the profile of
 * the generated table (`diagnostics.profile[].label`) so the page can say 年龄 where the column is called `age`.
 * @param {Record<string, any>} fields
 */
const uncertain = (fields) => ({ ...fields, paramSd: PARAM_SD, label: VARIABLE_LABEL })
const POPULATION_VARIABLES = array({
  t: 'variant', on: 'family',
  variants: {
    normal: uncertain({ name: req(COLUMN), mean: req(number()), sd: req(number({ gt: 0 })), ...VARIABLE_BOUNDS }),
    lognormal: uncertain({ name: req(COLUMN), meanlog: req(number()), sdlog: req(number({ gt: 0 })), ...VARIABLE_BOUNDS }),
    beta: uncertain({ name: req(COLUMN), alpha: req(number({ gt: 0 })), beta: req(number({ gt: 0 })), ...VARIABLE_BOUNDS }),
    gamma: uncertain({ name: req(COLUMN), shape: req(number({ gt: 0 })), rate: number({ gt: 0 }), mean: number({ gt: 0 }), ...VARIABLE_BOUNDS }),
    bernoulli: uncertain({ name: req(COLUMN), prob: req(number({ min: 0, max: 1 })) }),
    categorical: uncertain({ name: req(COLUMN), probs: req(array(number({ min: 0 }), { min: 2, max: 100 })) }),
    uniform: uncertain({ name: req(COLUMN), min: number(), max: number() }),
    exponential: uncertain({ name: req(COLUMN), rate: req(number({ gt: 0 })), ...VARIABLE_BOUNDS }),
  },
  variantGroups: { gamma: { exactlyOne: [['rate', 'mean']] } },
}, { min: 1, max: 100 })

/**
 * A baseline table: one row per variable of a published population, a continuous variable's mean and SD, a binary variable's proportion
 * or a categorical variable's proportions. `population.literature` generates from one; `population.check` holds a generated population
 * against a second one.
 */
const BASELINE_TABLE = req(array(object({
  variable: req(COLUMN),
  label: VARIABLE_LABEL,
  mean: number(), sd: number({ gt: 0 }), proportion: number({ min: 0, max: 1 }),
  // A categorical row: its proportions (which sum to one — the handler checks), and optionally what each level is called.
  proportions: array(number({ min: 0, max: 1 }), { min: 2, max: 50 }),
  levels: array(string({ maxLength: 64 }), { min: 2, max: 50 }),
  min: { ...number(), nullable: true }, max: { ...number(), nullable: true },
  distribution: string({ values: ['normal', 'lognormal'], default: 'normal' }),
}, { exactlyOne: [['proportion', 'mean', 'proportions']], requires: { mean: ['sd'], levels: ['proportions'] } }), { min: 1, max: 100 }))

const MISSINGNESS = array({
  t: 'variant', on: 'kind', default: 'MCAR',
  variants: {
    MCAR: { variable: req(COLUMN), rate: req(number({ ...PROBABILITY })), reason: string({ values: [...VCR_MISSING_REASONS] }) },
    MAR: {
      variable: req(COLUMN), rate: req(number({ ...PROBABILITY })), reason: string({ values: [...VCR_MISSING_REASONS] }),
      on: req(array(COLUMN, { min: 1, max: 20 })), beta: req(array(number(), { min: 1, max: 20 })),
    },
  },
}, { min: 1, max: 100 })

/**
 * What a weighted comparison says about itself beyond its covariates: the
 * endpoint (a time-to-event outcome adds `tau`, the RMST horizon), the
 * parameter of the analysis table it reads, the rules that made the control
 * cohort, and how closely the control emulates the target trial.
 */
/**
 * A distribution of a bias parameter (algorithm round C1, C2): a discriminated object on `family`. Which families a parameter may use
 * is the engine's check (`.vcr_bias_check_dist`: a prevalence is inside [0, 1], a ratio is above 0, the minimum is below the maximum), so
 * the schema holds only the shape of each family.
 * @param {readonly string[]} families
 */
const BIAS_DISTRIBUTION = (families) => {
  const all = {
    constant: { value: req(number()) },
    uniform: { min: req(number()), max: req(number()) },
    triangular: { min: req(number()), mode: req(number()), max: req(number()) },
    normal: { mean: req(number()), sd: req(number({ gt: 0 })) },
    lognormal: { median: req(number({ gt: 0 })), sdlog: req(number({ gt: 0 })) },
  }
  return { t: 'variant', on: 'family', variants: Object.fromEntries(families.map((family) => [family, all[/** @type {keyof typeof all} */ (family)]])) }
}

/**
 * Propensity trimming (algorithm round C14): the people with no comparable counterpart are removed before the weights are fitted, and
 * the result restates who they were. `fixed` removes whoever has a score outside [lower, upper] (upper is 1 - lower unless stated);
 * `crump` is the optimal rule of Crump, Hotz, Imbens & Mitnik (2009), which needs no number from the person.
 */
const TRIM = object({
  rule: req(string({ values: ['fixed', 'crump'] })),
  lower: req(gated(number({ gt: 0, lt: 0.5 }), is('trim.rule', 'fixed'))),
  upper: gated(number({ gt: 0.5, lt: 1 }), is('trim.rule', 'fixed')),
})

/**
 * Missing covariates (algorithm round C7): the comparison is run on `m` tables completed by chained equations (predictive mean matching
 * for a number, a logistic draw for a 0/1 column, a multinomial draw for a column declared in `categorical`) and read by Rubin's rules,
 * with the complete-case answer beside it. Without the key a missing covariate still refuses the job by name.
 */
const IMPUTATION = object({
  m: req(integer({ min: 2, max: 50 })),
  maxIterations: integer({ min: 1, max: 30, default: 10 }),
  categorical: array(COLUMN, { min: 1, max: 20, unique: true }),
})

const WEIGHTING_CONTEXT = {
  endpoint: ENDPOINT(),
  tau: req(gated(number({ gt: 0, unit: 'time units' }), TIME_TO_EVENT)),
  timeUnit: string({ maxLength: 20 }),
  parameterCode: string({ maxLength: 64 }),
  cohortRules: COHORT_STEPS,
  targetTrial: TARGET_TRIAL,
}

// --- robustness methods (2026-10-04): shared pieces of their schemas ---

/**
 * One outcome of a negative-control job: a column of the subject table (a 0/1
 * event indicator the engine analyses with the primary's adjustment) or an
 * estimate and its standard error on the log scale that was analysed elsewhere.
 */
const effectSource = (/** @type {Record<string, any>} */ extra = {}) => object({
  ...extra,
  column: COLUMN,
  estimate: number(),
  se: number({ gt: 0 }),
}, { exactlyOne: [['column', 'estimate']], requires: { estimate: ['se'], se: ['estimate'] } })

/** One arm of a binary tipping-point analysis: everyone in it, the observed responders, and how many outcomes are missing. */
const TIPPING_ARM = object({
  n: req(integer({ min: 1, max: 10_000_000 })),
  responders: req(integer({ min: 0, max: 10_000_000 })),
  missing: req(integer({ min: 0, max: 10_000_000 })),
})
const TWO_ARM = is('design.kind', 'two_arm')
const SINGLE_ARM_DESIGN = is('design.kind', 'single_arm')

// --- end robustness methods ---

// ---------------------------------------------------------------------------
// The schemas
// ---------------------------------------------------------------------------

/**
 * Per method: the object the engine's `scenario` must be. Read by
 * `validateScenario` here and by `vcr_validate_job` in R from the snapshot.
 */
// Coefficients are canonical linear-predictor beta, never HR/OR. Transform x first;
// center and positive scale are expressed on that transformed predictor scale.
const PROGNOSTIC_TERM = object({
  column: req(COLUMN), coefficient: req(number()), unit: req(string({ maxLength: 80 })),
  transform: req(string({ values: ['identity', 'log', 'log1p', 'square', 'indicator'] })),
  center: req(number()), scale: req(number({ gt: 0 })),
  category: string({ maxLength: 100 }), levels: array(string({ maxLength: 100 }), { min: 2, max: 100, unique: true }),
});
/** A number of the progression model with where it came from (algorithm round P4): `literature` names the citation, `assumed` is the person's own premise, `data` was estimated from their table. */
const PROGRESSION_PARAM = (/** @type {Record<string, any>} */ range = {}) => object({
  value: req(number(range)), basis: req(string({ values: ['literature', 'assumed', 'data'] })), citation: string({ maxLength: 300 }),
})
/**
 * The four families with a unit shape, and the published model whose numbers are a parameter set of the engine (`patients.progression` 1.1.0). The
 * four's fields are gated as "not beta_logit", so a scenario of any other family (an unknown one included) is judged exactly as at 1.0.0.
 */
const PROGRESSION_SHAPES = isNot('model.family', 'beta_logit')
const BETA_LOGIT = is('model.family', 'beta_logit')
/** A list of `n` numbers stated with where they came from (a range, three shares, three means). */
const PROGRESSION_LIST = (/** @type {Record<string, any>} */ range, /** @type {number} */ n) => object({
  value: req(array(number(range), { min: n, max: n })), basis: req(string({ values: ['literature', 'assumed', 'data'] })), citation: string({ maxLength: 300 }),
})
/** The families an effect distribution may have (plan R25), the tiers of what stands behind it and the kinds of source it names. */
export const VCR_EFFECT_DISTRIBUTION_FAMILIES = Object.freeze(['fixed', 'normal', 'truncated_normal', 'lognormal', 'beta', 'uniform', 'empirical_draws'])
export const VCR_EFFECT_DISTRIBUTION_TIERS = Object.freeze(['A', 'B', 'C', 'stated'])
export const VCR_EFFECT_SOURCE_KINDS = Object.freeze(['literature', 'model_result', 'stated'])
/** The two ways a run uses a record of virtual patients (plan R23): every person under every arm, or a trial's worth drawn from it. */
export const VCR_PEOPLE_MODES = Object.freeze(['paired_counterfactual', 'resampled_trials'])
/** The parameter sets of the beta_logit family the engine carries, by id (the version of each): a record of people made for another one is made for an earlier model. */
export const VCR_PROGRESSION_PARAMETER_SETS = Object.freeze({ 'camd-adas-cog-11': 'adsim-3.0' })
/** An effect stated as a distribution drawn once per simulated trial: `{ family, parameters, source, tier }`; `at` is the effect's own path, which gates its parameters. */
const EFFECT_DISTRIBUTION = (/** @type {string} */ at) => {
  const family = (/** @type {string[]} */ ...names) => is(`${at}.distribution.family`, ...names)
  return object({
    family: req(string({ values: [...VCR_EFFECT_DISTRIBUTION_FAMILIES] })),
    parameters: req(object({
      value: req(gated(number(), family('fixed'))),
      mean: req(gated(number(), family('normal', 'truncated_normal'))), sd: req(gated(number({ gt: 0 }), family('normal', 'truncated_normal'))),
      lower: req(gated(number(), family('truncated_normal'))), upper: req(gated(number(), family('truncated_normal'))),
      meanlog: req(gated(number(), family('lognormal'))), sdlog: req(gated(number({ gt: 0 }), family('lognormal'))),
      shape1: req(gated(number({ gt: 0 }), family('beta'))), shape2: req(gated(number({ gt: 0 }), family('beta'))),
      min: req(gated(number(), family('uniform'))), max: req(gated(number(), family('uniform'))),
      values: req(gated(array(number(), { min: 2, max: 10_000 }), family('empirical_draws'))),
    })),
    source: req(object({
      kind: req(string({ values: [...VCR_EFFECT_SOURCE_KINDS] })), citation: string({ maxLength: 300 }), objectRef: string({ maxLength: 120 }), note: string({ maxLength: 300 }),
    }, { atLeastOne: [['citation', 'objectRef', 'note']] })),
    tier: req(string({ values: [...VCR_EFFECT_DISTRIBUTION_TIERS] })),
  })
}
/** A progression effect: one number with where it came from, or (1.2.0) a distribution. */
const EFFECT_PARAM = (/** @type {Record<string, any>} */ range, /** @type {string} */ at) => object({
  value: number(range), basis: string({ values: ['literature', 'assumed', 'data'] }), citation: string({ maxLength: 300 }), distribution: EFFECT_DISTRIBUTION(at),
}, { exactlyOne: [['value', 'distribution']], requires: { value: ['basis'] } })
const PROGNOSTIC_TERMS = req(array(PROGNOSTIC_TERM, { min: 1, max: 100 }));
const PROGNOSTIC_MODEL = { t: 'variant', on: 'family', variants: {
  linear: { intercept: req(number()), residualSd: number({ gt: 0 }), terms: PROGNOSTIC_TERMS },
  logistic: { intercept: req(number()), terms: PROGNOSTIC_TERMS },
  cox: { terms: PROGNOSTIC_TERMS, baseline: object({ reference: req(string({ values: ['zero', 'centered'] })), survival: req(number({ min: 0, max: 1 })), horizon: req(number({ gt: 0 })), timeUnit: req(string({ values: [...VCR_TIME_UNITS] })) }) },
} };

export const VCR_SCENARIO_SCHEMAS = deepFreeze({
  'model.survival_fit': object({
    inputId: req(INPUT_REF), timeColumn: req(COLUMN), statusColumn: req(COLUMN),
    statusEncoding: req(string({ values: ['event', 'censor'] })), idColumn: COLUMN,
    distribution: req(string({ values: ['exponential', 'weibull', 'lognormal', 'loglogistic', 'spline'] })),
    // spline (1.1.0): the Royston-Parmar model of the log cumulative hazard with this many interior knots (0 is a Weibull)
    knots: gated(integer({ min: 0, max: 4, default: 2 }), is('distribution', 'spline')),
    timeUnit: req(string({ values: [...VCR_TIME_UNITS] })),
    horizons: req(array(number({ gt: 0 }), { min: 1, max: 100, increasing: true })),
    sourceCondition: string({ values: ['unspecified', 'control', 'natural_history', 'standard_care'], default: 'unspecified' }),
    armColumn: { ...COLUMN, reqWhen: is('sourceCondition', 'control', 'natural_history', 'standard_care') }, armValue: string({ maxLength: 80 }),
    parameterColumn: COLUMN, parameterValue: string({ maxLength: 80 }),
  }, { requires: { armColumn: ['armValue'], armValue: ['armColumn'], parameterColumn: ['parameterValue'], parameterValue: ['parameterColumn'] } }),
  'model.prognostic_apply': object({
    inputId: req(INPUT_REF), idColumn: req(COLUMN), cohortRules: COHORT_STEPS,
    sourceCondition: req(string({ values: ['control', 'natural_history', 'standard_care'] })),
    endpoint: req(object({ type: req(string({ valuesBy: { path: 'model.family', map: { linear: ['continuous'], logistic: ['binary'], cox: ['time_to_event'] } } })),
      horizon: req(number({ gt: 0 })), timeUnit: req(string({ values: [...VCR_TIME_UNITS] })) })),
    inputUnits: req({ t: 'map', values: string({ maxLength: 80 }), min: 1, max: 100 }),
    model: req(PROGNOSTIC_MODEL),
    // Local calibration (remediation plan D3): the outcome the table itself holds, so the applied equation is held against what happened.
    // A binary or continuous outcome is one column; a time-to-event outcome is a time and a status (1 = event) column.
    calibration: object({
      outcomeColumn: req(gated(COLUMN, is('model.family', 'linear', 'logistic'))),
      timeColumn: req(gated(COLUMN, is('model.family', 'cox'))),
      statusColumn: req(gated(COLUMN, is('model.family', 'cox'))),
    }),
  }),

  // A prognostic model trained on the person's own historical table and cross-fitted (algorithm round P3): `model` Cox for time to event, logistic for a 0/1 outcome, linear
  // for a continuous one, with `folds` folds; a forest (`ranger`) is fitted on the same folds as a comparison only. `predictors` states each column's unit, and a text column
  // becomes one indicator per level held by at least the small-cell size of people. `procova` sets the discounts the table of sample-size savings is computed under.
  'model.prognostic_train': object({
    inputId: req(INPUT_REF), idColumn: req(COLUMN),
    sourceCondition: req(string({ values: ['control', 'natural_history', 'standard_care'] })),
    // the arm to train on, when the table holds more than one; a table that is already the control cohort names none
    armColumn: COLUMN, armValue: string({ maxLength: 80 }),
    endpoint: req(object({
      type: req(string({ values: ['continuous', 'binary', 'time_to_event'] })),
      outcomeColumn: req(gated(COLUMN, is('endpoint.type', 'continuous', 'binary'))),
      timeColumn: req(gated(COLUMN, is('endpoint.type', 'time_to_event'))), statusColumn: req(gated(COLUMN, is('endpoint.type', 'time_to_event'))),
      // a time that is not a column of the table is read from the snapshot's event table (AVAL, CNSR) for this parameter
      parameterCode: gated(string({ maxLength: 64 }), is('endpoint.type', 'time_to_event')),
      horizon: req(number({ gt: 0 })), timeUnit: req(string({ values: [...VCR_TIME_UNITS] })),
    })),
    predictors: req(array(object({
      column: req(COLUMN), unit: req(string({ maxLength: 80 })), transform: string({ values: ['identity', 'log', 'log1p', 'square'], default: 'identity' }),
    }), { min: 1, max: 50 })),
    folds: integer({ min: 3, max: 10, default: 5 }),
    comparison: object({ ranger: boolean({ default: true }) }),
    procova: object({
      lambdas: array(number({ min: 0, max: 1 }), { min: 1, max: 8 }), gammas: array(number({ min: 1 }), { min: 1, max: 8 }),
      allocation: number({ gt: 0, lt: 1, default: 0.5 }),
    }),
  }, { requires: { armColumn: ['armValue'], armValue: ['armColumn'] } }),

  // A population-level disease-progression simulator from a published model family (algorithm round P4). Every number is a parameter that says where it came from
  // (`basis`: the literature with its citation, an assumption, or the person's data); the change of a person at time t is amplitude_i * u(t), u the family's unit shape
  // (linear t, exponential (exp(k t) - 1) / k, logistic S(k (t - t50)) - S(-k t50), Emax t / (T50 + t)), the amplitude (the slope, or the plateau) varying between people
  // as N(mean, sd) with correlation `correlation` to the baseline; a treated person follows the same curve with time scaled by 1 - slowing. The first visit is time zero.
  // 1.1.0 (plan T06): `beta_logit`, a published drug-disease-trial model whose numbers are a parameter set in the engine (`parameterSet`, today the CAMD ADAS-cog 11 model of
  // mild and moderate Alzheimer disease from adsim 3.0): the four families' amplitude, baseline, residual and slowing are theirs alone, and beta_logit states instead the
  // population it is run on (each override with its basis), the placebo and dropout switches, and a symptomatic effect (points at a week for a reference score, or a logit
  // Emax) and/or a disease-modifying share of the mean slope, both hypotheses the run states; the engine runs it in weeks, the unit its parameters were estimated in.
  'patients.progression': object({
    // a record of people (`instantiate`) runs no trial, so it needs no endpoint, design or visits; a paired run takes its n from the record
    endpoint: { ...object({ type: req(string({ values: ['continuous'] })), unit: string({ maxLength: 40 }) }), reqWhen: has('instantiate', false) },
    design: { ...object({ nTreat: req(integer({ min: 2, max: 100_000 })), nControl: req(integer({ min: 2, max: 100_000 })) }), reqWhen: [has('instantiate', false), isNot('people.mode', 'paired_counterfactual')] },
    timeUnit: req(string({ values: [...VCR_TIME_UNITS] })),
    visits: { ...array(number({ min: 0 }), { min: 3, max: 40, increasing: true }), reqWhen: has('instantiate', false) },
    model: req(object({
      family: req(string({ values: ['linear', 'exponential', 'logistic', 'emax', 'beta_logit'] })),
      // the amplitude is the slope (linear, exponential: initial slope, with `acceleration` k) or the plateau (logistic: `midpoint` and `steepness`; emax: `halfTime`)
      slope: req(gated(PROGRESSION_PARAM(), is('model.family', 'linear', 'exponential'))),
      // the between-person SD of that amplitude, whatever the family
      betweenPersonSd: req(gated(PROGRESSION_PARAM({ min: 0 }), PROGRESSION_SHAPES)),
      acceleration: req(gated(PROGRESSION_PARAM(), is('model.family', 'exponential'))),
      amplitude: req(gated(PROGRESSION_PARAM(), is('model.family', 'logistic', 'emax'))),
      midpoint: req(gated(PROGRESSION_PARAM(), is('model.family', 'logistic'))),
      steepness: req(gated(PROGRESSION_PARAM({ gt: 0 }), is('model.family', 'logistic'))),
      halfTime: req(gated(PROGRESSION_PARAM({ gt: 0 }), is('model.family', 'emax'))),
      parameterSet: req(gated(object({ id: req(string({ values: Object.keys(VCR_PROGRESSION_PARAMETER_SETS) })), version: req(string({ values: Object.values(VCR_PROGRESSION_PARAMETER_SETS) })) }), BETA_LOGIT)),
      // one study drawn per simulated trial (adsim's default), the typical study at the posterior medians, or a posterior draw and then a study per trial
      uncertainty: gated(string({ values: ['new_study', 'typical_study', 'posterior_draws'], default: 'new_study' }), BETA_LOGIT),
    })),
    baseline: req(gated(object({ mean: req(PROGRESSION_PARAM()), sd: req(PROGRESSION_PARAM({ min: 0 })) }), PROGRESSION_SHAPES)),
    residualSd: req(gated(PROGRESSION_PARAM({ min: 0 }), PROGRESSION_SHAPES)),
    correlation: gated(PROGRESSION_PARAM({ min: -1, max: 1 }), PROGRESSION_SHAPES),
    // the people a beta_logit trial enrols: baseline MMSE drawn uniformly over a range (default 16 to 26) and the parameter set's covariate model unless overridden
    population: gated(object({
      mmseRange: PROGRESSION_LIST({ min: 0, max: 30 }, 2), ageBounds: PROGRESSION_LIST({ min: 0, max: 130 }, 2), apoe4: PROGRESSION_LIST({ min: 0, max: 1 }, 3),
      femaleShare: PROGRESSION_PARAM({ min: 0, max: 1 }), ageMeanByApoe4: PROGRESSION_LIST({ gt: 0, max: 130 }, 3), ageSd: PROGRESSION_PARAM({ gt: 0 }),
    }), BETA_LOGIT),
    // 1.2.0 (plan R23): a table of virtual people made by `instantiate` (an input of this job) and how the run uses it: every person under every arm
    // (`paired_counterfactual`) or n people drawn from it per simulated trial (`resampled_trials`); the table fixes the people and the study they were made in
    people: gated(object({ inputId: req(INPUT_REF), mode: req(string({ values: [...VCR_PEOPLE_MODES] })) }), BETA_LOGIT),
    // 1.2.0: make that table. n people from the model's covariate model (or the `population` block), or the covariates of a generated population table named
    // by its columns (any covariate not named is drawn); one study and each person's intercept and slope are drawn once with the job's seed
    instantiate: gated(object({
      n: integer({ min: 2, max: 50_000 }),
      covariates: object({
        inputId: req(INPUT_REF),
        columns: req(object({ mmse: COLUMN, age: COLUMN, apoe4: COLUMN, female: COLUMN }, { atLeastOne: [['mmse', 'age', 'apoe4', 'female']] })),
      }),
    }, { atLeastOne: [['n', 'covariates']] }), BETA_LOGIT),
    placebo: gated(boolean({ default: true }), BETA_LOGIT),
    // who leaves: the parameter set's Weibull model (age and MMSE, not arm or outcome), or nobody
    dropoutModel: gated(string({ values: ['parameter_set', 'none'], default: 'parameter_set' }), BETA_LOGIT),
    treatment: {
      ...object({
        slowing: req(gated(PROGRESSION_PARAM({ min: 0, lt: 1 }), PROGRESSION_SHAPES)),
        // a change in points (treated less untreated; negative is better) at `atWeek` for a person at `referenceAdas`, or the logit Emax itself
        symptomatic: gated(object({
          pointsAt: EFFECT_PARAM({ gt: -70, lt: 70 }, 'treatment.symptomatic.pointsAt'), atWeek: number({ gt: 0 }), referenceAdas: number({ gt: 0, lt: 70 }), logitEmax: PROGRESSION_PARAM(),
          et50Weeks: req(PROGRESSION_PARAM({ gt: 0 })), washoutHalfLifeWeeks: PROGRESSION_PARAM({ gt: 0 }),
        }, { exactlyOne: [['pointsAt', 'logitEmax']], requires: { pointsAt: ['atWeek', 'referenceAdas'] } }), BETA_LOGIT),
        // the share of the study's covariate-adjusted mean slope taken away while on drug, held after the dose ends
        diseaseModifying: gated(object({ fraction: req(EFFECT_PARAM({ min: 0, lt: 1 }, 'treatment.diseaseModifying.fraction')) }), BETA_LOGIT),
        doseBegin: gated(number({ min: 0, default: 0 }), BETA_LOGIT), doseEnd: gated(number({ gt: 0 }), BETA_LOGIT),
      }),
      reqWhen: PROGRESSION_SHAPES,
    },
    analysis: object({ kind: string({ values: ['change', 'slope', 'ancova'], default: 'change' }), visit: number({ min: 0 }), alpha: number({ gt: 0, lt: 1, default: 0.05 }) }),
  }),

  'profile.snapshot': object({}),

  'cohort.build': object({
    rules: req(COHORT_STEPS),
    // The cohort's time zero and the end of each subject's follow-up are columns
    // of the table, carried with the cohort to every job that reads it (EA-6).
    timeZero: object({ column: req(COLUMN) }),
    exit: object({ column: req(COLUMN) }),
    idColumn: { ...COLUMN, default: 'USUBJID' },
    grain: string({ values: ['subject'] }),
    // A second version of the definition on the same table, and the baseline columns the two cohorts are
    // compared on: counts, overlap and a standardized difference per covariate (a definition library's
    // version comparison). The primary `rules` are version A.
    compare: object({ rules: req(COHORT_STEPS), covariates: req(COLUMN_LIST) }),
  }),

  'population.scenario': object({
    population: req(object({
      variables: req(POPULATION_VARIABLES),
      correlation: { t: 'matrix', min: -1, max: 1, size: 'population.variables' },
      correlationScale: string({ values: ['latent', 'spearman'], default: 'latent' }),
      constraints: { t: 'rules', allowEmpty: true, columnsFrom: { path: 'population.variables', key: 'name' } },
      missing: MISSINGNESS,
    })),
    n: integer({ min: 1, max: 1_000_000, default: 1000 }),
    parameterDraws: integer({ min: 1, max: 1000, default: 1 }),
  }),

  'population.literature': object({
    baselineTable: BASELINE_TABLE,
    n: integer({ min: 1, max: 1_000_000, default: 1000 }),
    correlation: { t: 'matrix', min: -1, max: 1, size: 'baselineTable' },
    correlationSource: string({ values: ['assumed', 'cited'], default: 'assumed' }),
    parameterDraws: integer({ min: 1, max: 1000, default: 1 }),
  }),

  // A generated population held against a second baseline table (remediation plan D2). `generated` is the population job's own
  // profile, copied in by the control plane from the population the check is about; a caller does not type it.
  'population.check': object({
    baselineTable: BASELINE_TABLE,
    // not `req`: the platform writes it before the job is queued, and a row of the shape help marked required would be a field a caller thinks is theirs
    generated: array(object({
      variable: req(COLUMN),
      label: VARIABLE_LABEL,
      kind: req(string({ values: ['continuous', 'binary', 'categorical'] })),
      n: integer({ min: 0 }),
      mean: { ...number(), nullable: true }, sd: { ...number({ min: 0 }), nullable: true },
      levels: array(object({ level: req(string({ maxLength: 64 })), p: { ...number({ min: 0, max: 1 }), nullable: true } }), { min: 1, max: 100 }),
    }), { min: 1, max: 200 }),
    // the second table's own sample size, when its source says it: with it a row carries the standard error of the difference
    referenceN: integer({ min: 2, max: 100_000_000 }),
  }),

  'population.synthpop': object({
    holdoutShare: number({ min: 0, lt: 1, default: 0.2 }),
    m: integer({ min: 5, max: 50, default: 5 }),
    constraints: { t: 'rules', allowEmpty: true },
    criteria: { t: 'rules', allowEmpty: true },
    analyses: ANALYSES,
    tstrOutcome: COLUMN,
    imputationRules: array(object({ valueColumn: req(COLUMN), indicatorColumn: req(COLUMN), imputedValue: req(number()), missingValue: req(integer({ min: 1, max: 1 })) }), { min: 1, max: 200 }),
    inference: SYNTHETIC_INFERENCE,
    privacy: SYNTHETIC_PRIVACY,
  }),

  'population.quality': object({
    trainingInputId: req(INPUT_REF),
    syntheticInputId: req(INPUT_REF),
    holdoutInputId: INPUT_REF,
    constraints: { t: 'rules', allowEmpty: true },
    criteria: { t: 'rules', allowEmpty: true },
    analyses: ANALYSES,
    tstrOutcome: COLUMN,
    generator: object({
      family: string({ maxLength: 40 }), m: integer({ min: 1, max: 50 }), smoothing: string({ maxLength: 40 }), seed: integer({ min: 0, max: 2_147_483_647 }),
    }),
    inference: SYNTHETIC_QUALITY_INFERENCE,
    privacy: SYNTHETIC_PRIVACY,
  }),

  'patients.continuous': object(patientsFields()),
  'patients.binary': object(patientsFields()),
  'patients.time_to_event': object(patientsFields()),

  // Virtual patients with a continuous trajectory (plan 5.2): the linear mixed model
  //   y_ij = (b0 + u0_i) + (b1 + u1_i) t_j + delta z_i t_j + beta' x_i + e_ij
  // `intercept` is b0, `slope` b1, `effect` delta (the treatment changes the rate of change, so the arms start alike), `sd` the
  // residual, `randomEffects` the SDs of u0 and u1 and their correlation (a covariance the model cannot make non-positive-definite),
  // `visits` the schedule and `dropoutPerVisit` the probability of leaving before each follow-up visit (missing completely at
  // random, monotone). The effect is required, as in every generator: a typo must not read as "no effect". Covariate effects take
  // their covariates from a stored population and are refused without one.
  'patients.longitudinal': object({
  cohortRules: COHORT_STEPS,
  pairing: object({ key: req(string({ minLength: 1, maxLength: 200 })), replicate: req(integer({ min: 1, max: 10000 })) }),
    design: req(object({ nTreat: req(integer({ min: 1, max: 1_000_000 })), nControl: integer({ min: 0, max: 1_000_000 }) })),
    endpoint: req(ENDPOINT()),
    visits: req(array(number({ min: 0, unit: 'time units' }), { min: 2, max: 50, increasing: true })),
    truth: req(object({
      effect: req(number({ unit: 'outcome units per time unit' })),
      intercept: number({ default: 0, unit: 'outcome units' }),
      slope: number({ default: 0, unit: 'outcome units per time unit' }),
      sd: number({ gt: 0, default: 1, unit: 'outcome units' }),
      randomEffects: object({
        sdIntercept: number({ min: 0, default: 0, unit: 'outcome units' }),
        sdSlope: number({ min: 0, default: 0, unit: 'outcome units per time unit' }),
        correlation: number({ gt: -1, lt: 1, default: 0 }),
      }),
      covariateEffects: COVARIATE_EFFECTS,
    })),
    dropoutPerVisit: number({ min: 0, lt: 1, default: 0, unit: 'probability of leaving before each follow-up visit' }),
    // 1.2.0 (algorithm round T11). A mean that bends: time enters as g(t), a plateau (half way to it at halfTime) or t + curvature t^2.
    trajectory: object({
      kind: req(string({ values: ['linear', 'plateau', 'quadratic'] })),
      halfTime: req(gated(number({ gt: 0, unit: 'time units' }), is('trajectory.kind', 'plateau'))),
      curvature: req(gated(number({ unit: 'per time unit' }), is('trajectory.kind', 'quadratic'))),
    }),
    // Dropout that depends on the outcome: from dropoutPerVisit at an average outcome, the log-odds of leaving before a visit change by logOddsPerSd per
    // standard deviation of the outcome (a positive number: people with higher values leave sooner). "mar" reads the previous value, "mnar" the value at the visit.
    dropoutModel: object({
      mechanism: req(string({ values: ['mar', 'mnar'] })),
      logOddsPerSd: req(number({ min: -5, max: 5, unit: 'change in the log-odds of leaving per standard deviation of the outcome' })),
    }),
    // A rescue medication, an intercurrent event: before each visit a person not yet on it starts it with probability perVisit at an average previous value
    // (more or less as logOddsPerSd says), and from that visit the outcome is shifted by effect.
    rescue: object({
      perVisit: req(number({ ...PROBABILITY, unit: 'probability of starting rescue before each follow-up visit' })),
      effect: req(number({ unit: 'outcome units' })),
      logOddsPerSd: number({ min: -5, max: 5, default: 0, unit: 'change in the log-odds of starting rescue per standard deviation of the previous value' }),
    }),
  }),

  'evidence.pool': object({
    studies: req(array(object({
      studyId: req(string({ minLength: 1, maxLength: 121 })),
      estimate: req(number()),
      se: req(number({ gt: 0 })),
    }), { min: 1, max: 500 })),
    method: string({ values: [...VCR_POOLING_METHODS], default: 'random_effects_dl' }),
    level: number({ gt: 0, lt: 1, default: 0.95 }),
    scale: string({ values: ['identity', 'log', 'logit'], default: 'identity' }),
    // An informative prior for the between-study standard deviation (1.1.0, algorithm round E7): a stated half-normal on tau, log-normal or log-t
    // on tau-squared, inverse-gamma on tau, or an empirical one from a table the domain holds with the place in the paper each number was read at.
    tauPrior: TAU_PRIOR,
  }),

  // Frequentist network meta-analysis (algorithm round C5). A study states its arms (events and n for a binary outcome, mean, sd and n for a
  // continuous one) or its contrasts (every pair of its arms: treatment, comparator, effect and standard error, the effect on the log scale
  // for a ratio). The treatment names are the person's own words and are matched as written.
  'evidence.network': object({
    label: string({ maxLength: 120 }),
    measure: req(string({ values: ['odds_ratio', 'risk_ratio', 'mean_difference', 'log_ratio', 'difference'] })),
    direction: req(string({ values: ['lower_better', 'higher_better'] })),
    studies: req(array(object({
      studyId: req(string({ minLength: 1, maxLength: 121 })),
      arms: array(object({
        treatment: req(string({ minLength: 1, maxLength: 80 })),
        events: integer({ min: 0 }), n: integer({ min: 1 }), mean: number(), sd: number({ gt: 0 }),
      }), { min: 2, max: 12 }),
      contrasts: array(object({
        treatment: req(string({ minLength: 1, maxLength: 80 })),
        comparator: req(string({ minLength: 1, maxLength: 80 })),
        effect: req(number()), se: req(number({ gt: 0 })),
      }), { min: 1, max: 66 }),
    }, { exactlyOne: [['arms', 'contrasts']] }), { min: 2, max: 500 })),
    reference: string({ minLength: 1, maxLength: 80 }),
    model: string({ values: ['random', 'common'], default: 'random' }),
    level: number({ gt: 0, lt: 1, default: 0.95 }),
    continuityCorrection: number({ gt: 0, max: 1, default: 0.5 }),
  }),

  // Dose-response meta-analysis of grouped data (algorithm round C6). One reference row per study (an effect of 0 and no standard error), the
  // other levels with their dose, effect on the log scale and standard error; the counts rebuild the covariance of the contrasts (cases and n:
  // the number at risk, the controls plus cases, or the person-years).
  'evidence.dose_response': object({
    label: string({ maxLength: 120 }),
    doseUnit: string({ maxLength: 40 }),
    ratioKind: string({ values: ['relative_risk', 'odds_ratio', 'hazard_ratio'], default: 'relative_risk' }),
    studies: req(array(object({
      studyId: req(string({ minLength: 1, maxLength: 121 })),
      type: req(string({ values: ['cc', 'ci', 'ir'] })),
      rows: req(array(object({
        dose: req(number()), effect: req(number()), se: number({ gt: 0 }), cases: number({ min: 0 }), n: number({ gt: 0 }),
      }), { min: 2, max: 60 })),
    }), { min: 1, max: 500 })),
    model: object({
      kind: req(string({ values: ['linear', 'spline'] })),
      knots: gated(array(number(), { min: 3, max: 5, increasing: true }), is('model.kind', 'spline')),
      knotPercentiles: gated(array(number({ gt: 0, lt: 1 }), { min: 3, max: 5, increasing: true }), is('model.kind', 'spline')),
    }),
    stage: string({ values: ['one', 'two'], default: 'two' }),
    method: string({ values: ['reml', 'ml', 'fixed'], default: 'reml' }),
    covariance: string({ values: ['gl', 'h', 'indep'], default: 'gl' }),
    referenceDose: number(),
    predictAt: array(number(), { min: 1, max: 50 }),
    perDose: number({ gt: 0 }),
    level: number({ gt: 0, lt: 1, default: 0.95 }),
  }),

  // The empirical shrinkage of a published effect against the trials of the Cochrane Database (algorithm round E8; van Zwet et al. 2023). The
  // estimate is on a scale whose null is 0: a difference, or the log of a ratio.
  'evidence.shrinkage': object({
    label: string({ maxLength: 120 }),
    scale: req(string({ values: ['identity', 'log'] })),
    values: req(array(object({
      id: string({ minLength: 1, maxLength: 80 }),
      estimate: req(number()), se: req(number({ gt: 0 })),
      futureSe: number({ gt: 0 }),
    }), { min: 1, max: 20 })),
    level: number({ gt: 0, lt: 1, default: 0.95 }),
    alpha: number({ gt: 0, lt: 1, default: 0.05 }),
  }),

  // The published numbers at risk are the best information a reconstruction can have, not a condition of having one: a paper that
  // prints none still gives the arm's size at the start (`initialAtRisk`), and the reconstruction runs on that, labelled by what
  // the paper gave (four information levels) and limited when there is no table (Guyot 2012). With neither, nobody is counted and
  // the job is refused by name. The coordinates say where they came from — a curve "read" off a picture by a language model is
  // several times less accurate than a digitizer's (EB-6).
  'evidence.reconstruct_km': object({
    curve: req(KM_CURVE),
    riskTable: KM_RISK_TABLE,
    initialAtRisk: integer({ min: 1, max: 1_000_000 }),
    totalEvents: number({ min: 0 }),
    reportedMedian: number({ gt: 0 }),
    reportedLogHazardRatio: number(),
    provenance: req(object({
      kind: req(string({ values: ['digitizer', 'human_click'] })),
      tool: req(string({ minLength: 1, maxLength: 80 })),
      toolVersion: string({ maxLength: 40 }),
    })),
    treatmentArm: object({
      curve: req(KM_CURVE),
      riskTable: KM_RISK_TABLE,
      initialAtRisk: integer({ min: 1, max: 1_000_000 }),
      totalEvents: number({ min: 0 }),
      reportedMedian: number({ gt: 0 }),
    }, { atLeastOne: [['riskTable', 'initialAtRisk']] }),
  }, { atLeastOne: [['riskTable', 'initialAtRisk']] }),

  // The weighted comparators dispatch on the endpoint: a time-to-event outcome
  // is a weighted Kaplan-Meier curve and an RMST at `tau` (EB-2), so `tau` is
  // required exactly when the endpoint says so.
  'comparator.entropy_balance': object({
    covariates: req(COLUMN_LIST),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    outcomeColumn: { ...COLUMN, default: 'y' },
    moments: integer({ min: 1, max: 3, default: 1 }),
    estimand: string({ values: ['ATT'], default: 'ATT' }),
    imputation: IMPUTATION,
    ...WEIGHTING_CONTEXT,
  }),

  'comparator.propensity_weight': object({
    covariates: req(COLUMN_LIST),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    outcomeColumn: { ...COLUMN, default: 'y' },
    estimand: string({ values: ['ATT', 'ATE', 'ATO'], default: 'ATT' }),
    trim: TRIM,
    imputation: IMPUTATION,
    ...WEIGHTING_CONTEXT,
  }),

  // A weighted Cox comparison: the weights are estimated INSIDE the job (so the bootstrap re-estimates them in every
  // resample), the hazard ratio carries a robust variance and a bootstrap, and the proportional-hazards test is reported
  // with the RMST difference beside it. `tau` is required so that companion is always computable; the PH level and the
  // time transform are declared before the data is read, never chosen after (the estimator is not switched by the test).
  'comparator.weighted_cox': object({
    covariates: req(COLUMN_LIST),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    weighting: string({ values: ['entropy_balance', 'propensity'], default: 'entropy_balance' }),
    moments: gated(integer({ min: 1, max: 3, default: 1 }), isNot('weighting', 'propensity')),
    estimand: string({ values: ['ATT', 'ATE', 'ATO'], default: 'ATT' }),
    trim: gated(TRIM, is('weighting', 'propensity')),
    imputation: IMPUTATION,
    tau: req(number({ gt: 0, unit: 'time units' })),
    ties: string({ values: ['efron', 'breslow'], default: 'efron' }),
    phAlpha: number({ gt: 0, lt: 1, default: 0.05 }),
    phTransform: string({ values: ['km', 'rank', 'identity'], default: 'km' }),
    endpoint: ENDPOINT(),
    timeUnit: string({ maxLength: 20 }),
    parameterCode: string({ maxLength: 64 }),
    cohortRules: COHORT_STEPS,
    targetTrial: TARGET_TRIAL,
  }),

  // The comparator analysis re-run under alternative, pre-declared covariate sets. The first set is the primary analysis; every set
  // is a full run of the named analysis (its own weights, balance, overlap rules and bootstrap), so a set that breaks a
  // not-estimable rule is reported as that, never dropped. The other keys are the ones the named analysis reads, once.
  'comparator.covariate_sets': object({
    analysis: string({ values: ['entropy_balance', 'propensity', 'aipw'], default: 'entropy_balance' }),
    covariateSets: req(array(object({ name: req(string(CRITERION_NAME)), covariates: req(COLUMN_LIST) }), { min: 2, max: 8 })),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    outcomeColumn: { ...COLUMN, default: 'y' },
    moments: gated(integer({ min: 1, max: 3, default: 1 }), isNot('analysis', 'propensity', 'aipw')),
    estimand: string({ values: ['ATT', 'ATE', 'ATO'], default: 'ATT' }),
    ...WEIGHTING_CONTEXT,
    endpoint: req(ENDPOINT()),
  }),

  // A doubly robust (AIPW) estimator of the effect in the trial's own population (ATT) for a single-arm study against an
  // external control: arm 1 is the trial, arm 0 the external source. The propensity model (membership of the trial against the
  // external source, logistic) and the outcome model (fitted on the external controls only, logistic for a binary outcome,
  // linear for a continuous one) may use different covariates; main effects only, so a nonlinear term is a column of the table.
  // The estimator is consistent when EITHER model is right. Everything is estimated inside the job: the bootstrap re-fits both
  // models in every resample, and the influence-function standard error is reported beside it.
  'comparator.aipw': object({
    covariates: array(COLUMN, { min: 1, max: 100, unique: true }),
    propensityCovariates: array(COLUMN, { min: 1, max: 100, unique: true }),
    outcomeCovariates: array(COLUMN, { min: 1, max: 100, unique: true }),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    outcomeColumn: gated({ ...COLUMN, default: 'y' }, isNot('endpoint.type', 'time_to_event')),
    endpoint: req(ENDPOINT()),
    estimand: string({ values: ['ATT'], default: 'ATT' }),
    // A time-to-event outcome (1.3.0): the horizon, and what is read at it - the restricted mean survival time up to tau or the survival at tau.
    tau: req(gated(number({ gt: 0, unit: 'time units' }), TIME_TO_EVENT)),
    summary: gated(string({ values: ['rmst', 'survival'], default: 'rmst' }), TIME_TO_EVENT),
    timeUnit: gated(string({ maxLength: 20 }), TIME_TO_EVENT),
    parameterCode: gated(string({ maxLength: 64 }), TIME_TO_EVENT),
    trim: TRIM,
    imputation: IMPUTATION,
    cohortRules: COHORT_STEPS,
    targetTrial: TARGET_TRIAL,
  }, { atLeastOne: [['covariates', 'propensityCovariates'], ['covariates', 'outcomeCovariates']] }),

  // A time-to-event MAIC (NICE DSU TSD 18, Signorovitch 2012). The study's patients are the subject table (and its events table);
  // the comparator's pseudo-individual rows come from a reconstruction (`evidence.reconstruct_km`) and are named by their input id.
  // Unanchored: the weighted patients against the comparator's rows in one Cox model. Anchored: the study has a common comparator
  // C (the arm column: 1 = A, 0 = C) and the contrast of B with C is either the reconstructed rows of both arms (1 = B, 0 = C) or
  // the published log hazard ratio with its standard error; the indirect contrast is Bucher's on the log scale.
  'comparator.maic_time_to_event': object({
    covariates: req(COLUMN_LIST),
    targets: req({ t: 'map', values: number(), keysFrom: 'covariates', min: 1, max: 100 }),
    anchored: boolean({ default: false }),
    treatmentColumn: gated({ ...COLUMN, default: 'arm' }, is('anchored', 'true')),
    pseudoIpdInputId: { ...INPUT_REF, reqWhen: isNot('anchored', 'true') },
    pseudoTreatmentColumn: gated({ ...COLUMN, default: 'arm' }, [is('anchored', 'true'), has('pseudoIpdInputId')]),
    aggregateEstimate: gated(number({ unit: 'log hazard ratio' }), is('anchored', 'true')),
    aggregateSe: gated(number({ gt: 0 }), is('anchored', 'true')),
    ties: string({ values: ['efron', 'breslow'], default: 'efron' }),
    endpoint: ENDPOINT(),
    timeUnit: string({ maxLength: 20 }),
    parameterCode: string({ maxLength: 64 }),
    unadjustedEffectModifiers: array(string({ maxLength: 80 }), { min: 0, max: 50 }),
  }, {
    exactlyOne: [{ keys: ['pseudoIpdInputId', 'aggregateEstimate'], when: is('anchored', 'true') }],
    requires: { aggregateEstimate: ['aggregateSe'], aggregateSe: ['aggregateEstimate'] },
  }),

  'comparator.rmst': object({
    tau: req(number({ gt: 0, unit: 'time units' })),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    weightColumn: COLUMN,
    timeUnit: string({ maxLength: 20 }),
    parameterCode: string({ maxLength: 64 }),
    cohortRules: COHORT_STEPS,
  }),

  'comparator.maic': object({
    covariates: req(COLUMN_LIST),
    targets: req({ t: 'map', values: number(), keysFrom: 'covariates', min: 1, max: 100 }),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    endpoint: ENDPOINT(),
    anchored: boolean({ default: false }),
    // Anchored: the aggregate trial's contrast, already on the link scale (a log odds ratio, a log risk ratio, a mean difference).
    // Unanchored: its outcome on the outcome's OWN scale -- a proportion for the logit link, a positive mean or rate for the log link --
    // with the standard error of that level; the engine applies the link to the level and the delta method to the error.
    aggregateEstimate: req(gated(number({ unit: 'link scale' }), is('anchored', 'true'))),
    aggregateOutcome: req(gated(number({ unit: 'the outcome\'s own scale' }), isNot('anchored', 'true'))),
    aggregateSe: req(number({ gt: 0 })),
    // The outcome the weighted means are taken of: the column the IPD trial measured it in, anchored or not (the anchored contrast is the
    // difference of the arms' weighted means of it, so an anchored job names it too).
    outcomeColumn: { ...COLUMN, default: 'y' },
    link: string({ values: ['identity', 'log', 'logit'], default: 'identity' }),
    unadjustedEffectModifiers: array(string({ maxLength: 80 }), { min: 0, max: 50 }),
  }),

  'comparator.evalue': object({
    riskRatio: req(number({ gt: 0 })),
    confidenceLimit: number({ gt: 0 }),
    scale: string({ values: ['risk_ratio', 'odds_ratio', 'hazard_ratio'], default: 'risk_ratio' }),
    rare: boolean(),
  }),

  // Quantitative bias analysis of an estimate (algorithm round C1, C2): the estimate and its interval (or its standard error) are the input -
  // stated, or taken from a saved comparison by the platform. Every bias is the one that exaggerates the observed effect: a ratio of at least 1
  // (an amount of at least 0 on the difference scale). The tipping bias is always computed; the other parts when their parameters are stated
  // (the tipping confounder has a default grid of associations on a ratio scale).
  'comparator.bias_analysis': object({
    scale: req(string({ values: ['hazard_ratio', 'risk_ratio', 'odds_ratio', 'difference'] })),
    estimate: req(number()),
    lower: number(),
    upper: number(),
    se: number({ gt: 0 }),
    confidenceLevel: number({ gt: 0.5, lt: 1, default: 0.95 }),
    shiftedNull: object({ biases: req(array(number({ min: 0 }), { min: 1, max: 20 })) }),
    confounderTipping: object({
      associations: array(number(), { min: 1, max: 20 }),
      baselinePrevalence: number({ min: 0, lt: 1 }),
    }),
    probabilistic: object({
      bias: BIAS_DISTRIBUTION(['constant', 'uniform', 'triangular', 'normal', 'lognormal']),
      confounder: object({
        exposedPrevalence: req(BIAS_DISTRIBUTION(['constant', 'uniform', 'triangular'])),
        unexposedPrevalence: req(BIAS_DISTRIBUTION(['constant', 'uniform', 'triangular'])),
        association: req(BIAS_DISTRIBUTION(['constant', 'uniform', 'triangular', 'normal', 'lognormal'])),
      }),
    }, { exactlyOne: [['bias', 'confounder']] }),
  }, { exactlyOne: [['lower', 'se']], requires: { lower: ['upper'], upper: ['lower'] } }),

  // The G-computation form of the simulated treatment comparison (algorithm round C9): the IPD outcome model (main effects, and the declared
  // effect modifiers interacting with the arm) averaged over the aggregate trial's covariate distribution, which the engine builds from the
  // published margins (`aggregateCovariates`, a baseline table) with the IPD's correlation unless `correlation` is stated. Anchored: the IPD trial has
  // two arms and the aggregate trial's contrast against the common comparator is `aggregateEstimate` on the link scale; unanchored: only the IPD
  // active arm is modelled, set against the aggregate arm's outcome on its own scale.
  'comparator.stc': object({
    covariates: req(COLUMN_LIST),
    effectModifiers: array(COLUMN, { min: 1, max: 100, unique: true }),
    aggregateCovariates: BASELINE_TABLE,
    correlation: { t: 'matrix', min: -1, max: 1, size: 'covariates' },
    treatmentColumn: { ...COLUMN, default: 'arm' },
    outcomeColumn: { ...COLUMN, default: 'y' },
    endpoint: req(ENDPOINT()),
    anchored: boolean({ default: false }),
    link: string({ values: ['identity', 'log', 'logit'] }),
    aggregateEstimate: req(gated(number({ unit: 'link scale' }), is('anchored', 'true'))),
    aggregateOutcome: req(gated(number({ unit: 'the outcome\'s own scale' }), isNot('anchored', 'true'))),
    aggregateSe: req(number({ gt: 0 })),
    size: integer({ min: 1000, max: 200000, default: 10000 }),
    unadjustedEffectModifiers: array(string({ maxLength: 80 }), { min: 0, max: 50 }),
  }),

  // Target-trial emulation from a person-period table (algorithm round C3, C4). The table is the data plane's longitudinal shape (USUBJID, PARAMCD, AVAL
  // and ADT = the period number); `parameters` name the PARAMCDs of the treatment, the outcome and the eligibility, `covariates` those of the covariates
  // (as they stand at each period; the baseline value of a trial is the value at its first period). A sequence of trials (`sequential`) asks for the
  // intention-to-treat and per-protocol risk difference at `horizon` periods; `clone_censor_weight` asks for a strategy with a grace period: start within
  // `gracePeriod` periods of time zero (the first eligible period) against never start.
  'comparator.target_trial': object({
    parameters: object({
      treatment: string({ minLength: 1, maxLength: 64, default: 'treatment' }),
      outcome: string({ minLength: 1, maxLength: 64, default: 'outcome' }),
      eligible: string({ minLength: 1, maxLength: 64, default: 'eligible' }),
    }),
    covariates: array(string({ minLength: 1, maxLength: 64 }), { max: 50, unique: true }),
    strategy: req(object({
      kind: req(string({ values: ['sequential', 'clone_censor_weight'] })),
      estimand: gated(string({ values: ['itt', 'per_protocol', 'both'], default: 'both' }), is('strategy.kind', 'sequential')),
      weights: gated(object({
        numerator: array(string({ minLength: 1, maxLength: 64 }), { max: 50, unique: true }),
        denominator: array(string({ minLength: 1, maxLength: 64 }), { max: 50, unique: true }),
      }), is('strategy.kind', 'sequential')),
      gracePeriod: req(gated(integer({ min: 0, max: 1000, unit: 'periods' }), is('strategy.kind', 'clone_censor_weight'))),
    })),
    horizon: req(integer({ min: 1, max: 5000, unit: 'periods' })),
    outcomeModel: gated(object({
      followupDegree: integer({ min: 1, max: 3, default: 2 }),
      trialPeriodDegree: integer({ min: 0, max: 3, default: 2 }),
      armByFollowup: boolean({ default: false }),
    }), is('strategy.kind', 'sequential')),
    // the periods trials may start in, and how many follow-up periods of each trial are used: both only make the expanded table smaller
    firstPeriod: gated(integer({ min: -100000, max: 100000, unit: 'periods' }), is('strategy.kind', 'sequential')),
    lastPeriod: gated(integer({ min: -100000, max: 100000, unit: 'periods' }), is('strategy.kind', 'sequential')),
    followUpLimit: gated(integer({ min: 1, max: 5000, unit: 'periods' }), is('strategy.kind', 'sequential')),
    timeUnit: string({ values: [...VCR_TIME_UNITS] }),
  }),

  'comparator.map_prior': object({
    historical: req(object({
      events: array(integer({ min: 0 }), { min: 2, max: 200 }),
      n: array(integer({ min: 1 }), { min: 2, max: 200 }),
      estimate: array(number(), { min: 2, max: 200 }),
      se: array(number({ gt: 0 }), { min: 2, max: 200 }),
    }, { exactlyOne: [['events', 'estimate']], requires: { events: ['n'], estimate: ['se'] } })),
    unitVariance: req(gated(number({ gt: 0 }), has('historical.estimate'))),
    tauPrior: object({
      kind: req(string({ values: ['half_normal', 'half_cauchy', 'uniform'] })),
      scale: req(number({ gt: 0 })),
    }),
    components: integer({ min: 1, max: 2, default: 2 }),
    robustWeight: number({ gt: 0, lt: 1, default: 0.2 }),
    current: object({ estimate: req(number()), se: req(number({ gt: 0 })) }),
    // The design-period operating characteristics of the borrowing: type-I error
    // and power over a grid of drifts of the true control rate (EB-7).
    operatingCharacteristics: object({
      nControl: req(integer({ min: 1, max: 1_000_000 })),
      nTreatment: req(integer({ min: 1, max: 1_000_000 })),
      drifts: req(array(number(), { min: 1, max: 50 })),
      effect: req(number()),
      robustWeights: array(number({ min: 0, max: 1 }), { min: 1, max: 5 }),
      alpha: ALPHA,
    }),
  }),

  // Dynamic borrowing of an external control arm (algorithm round C10, C11, C12): one historical control arm (a count of responders or a mean with its
  // standard deviation, taken as known) and a kind of prior for the CONTROL arm. `power`: the historical likelihood raised to the fixed discount a0.
  // `sam`: Yang et al. 2023, the informative prior mixed with a vague one at a weight the current data decide, delta being the difference beyond which
  // nothing should be borrowed. `elastic`: Jiang et al. 2023, the historical posterior with its variance inflated by 1 / g(T), g a function of how far
  // the current data are from the historical ones (delta, and the two percentiles q0 and q1 that place the function). `current` (and `treatment`) ask for
  // the analysis, `operatingCharacteristics` for the type I error and power over drifts of the true control value; either or both.
  'comparator.borrowing': object({
    endpoint: req(ENDPOINT()),
    historical: req(object({
      n: req(integer({ min: 1, max: 100_000_000 })),
      responders: req(gated(integer({ min: 0, max: 100_000_000 }), BINARY)),
      mean: req(gated(number(), CONTINUOUS)),
      sd: req(gated(number({ gt: 0 }), CONTINUOUS)),
    })),
    current: object({
      n: req(integer({ min: 1, max: 100_000_000 })),
      responders: req(gated(integer({ min: 0, max: 100_000_000 }), BINARY)),
      mean: req(gated(number(), CONTINUOUS)),
    }),
    treatment: object({
      n: req(integer({ min: 1, max: 100_000_000 })),
      responders: req(gated(integer({ min: 0, max: 100_000_000 }), BINARY)),
      mean: req(gated(number(), CONTINUOUS)),
    }),
    prior: req(object({
      kind: req(string({ values: ['power', 'sam', 'elastic'] })),
      a0: req(gated(number({ min: 0, max: 1 }), is('prior.kind', 'power'))),
      delta: req(gated(number({ gt: 0 }), is('prior.kind', 'sam', 'elastic'))),
      vague: gated(object({ alpha: req(number({ gt: 0, max: 1000 })), beta: req(number({ gt: 0, max: 1000 })) }), BINARY),
      function: gated(string({ values: ['logistic', 'step'] }), is('prior.kind', 'elastic')),
      q0: gated(number({ gt: 0, lt: 1 }), is('prior.kind', 'elastic')),
      q1: gated(number({ gt: 0, lt: 1 }), is('prior.kind', 'elastic')),
      c1: gated(number({ gt: 0.5, lt: 1 }), is('prior.kind', 'elastic')),
      c2: gated(number({ gt: 0, lt: 0.5 }), is('prior.kind', 'elastic')),
    })),
    analysis: object({ alpha: ALPHA }),
    operatingCharacteristics: object({
      nControl: req(integer({ min: 2, max: 2000 })),
      nTreatment: req(integer({ min: 2, max: 2000 })),
      drifts: req(array(number(), { min: 1, max: 21 })),
      effect: req(number()),
    }),
  }, { atLeastOne: [['current', 'operatingCharacteristics']], requires: { treatment: ['current'] } }),

  'design.analytic': object({
    design: req(object({
      kind: req(string({ values: [...VCR_TRIAL_DESIGNS], badValueCode: 'design_unknown' })),
      informationRates: req(gated(array(number({ gt: 0, max: 1 }), { min: 2, max: 20, increasing: true, last: 1 }), is('design.kind', 'group_sequential'))),
      spending: gated(string({ values: [...VCR_SPENDING_FUNCTIONS], default: 'obrien_fleming' }), is('design.kind', 'group_sequential')),
      allocation: gated(number({ ...PROBABILITY, default: 0.5 }), isNot('design.kind', 'single_arm')),
      maxN: gated(integer({ min: 2, max: 500, default: 100 }), is('design.kind', 'simon_two_stage')),
      n: req(gated(SINGLE_SIZE, is('design.kind', 'single_arm'))),
    })),
    endpoint: req(ENDPOINT()),
    truth: req(object(truthFields({
      binaryWhen: TWO_ARM_BINARY,
      simulated: false,
      extra: {
        nullRate: req(gated(number(BINARY_RATE), SINGLE_BINARY)),
        responseRate: req(gated(number(BINARY_RATE), is('design.kind', 'single_arm'))),
        alternativeRate: req(gated(number({ ...PROBABILITY }), is('design.kind', 'simon_two_stage'))),
      },
    }), { exactlyOne: truthGroups(TWO_ARM_BINARY) })),
    analysis: object({
      method: req(gated(string({ values: ['exact_binomial'] }), is('design.kind', 'single_arm'))),
      alternative: req(gated(string({ values: ['greater', 'less', 'two.sided'] }), is('design.kind', 'single_arm'))),
      alpha: ALPHA,
      power: gated(number({ ...PROBABILITY, default: 0.9 }), isNot('design.kind', 'single_arm')),
      sided: integer({ min: 1, max: 2, default: 1 }),
    }, { reqWhen: is('design.kind', 'single_arm') }),
    accrual: gated(object({
      duration: req(number({ min: 0, unit: 'time units' })),
      followup: req(number({ min: 0, unit: 'time units' })),
      dropoutAnnual: number({ min: 0, lt: 1, default: 0, unit: 'proportion per year' }),
    }), TIME_TO_EVENT),
    timeUnit: TIME_UNIT(),
    hypothesis: HYPOTHESIS,
  }),

  'design.simulate': object({ ...SIMULATE_FIELDS, evaluation: EVALUATION(4999) }),

  'design.confirmatory': CONFIRMATORY_SCHEMA,

  'design.dose': DOSE_SCHEMA,

  'design.bayesian': BAYESIAN_SCHEMA,

  'design.win_ratio': WIN_RATIO_SCHEMA,

  'design.grid': object({
    ...SIMULATE_FIELDS,
    designs: req(array(object({
      kind: string({ values: [...VCR_TRIAL_DESIGNS], badValueCode: 'design_unknown' }),
      n: SINGLE_SIZE, n1: SINGLE_SIZE, r1: integer({ min: 0, max: 9999 }), r: integer({ min: 0, max: 9999 }),
      nTreat: integer({ min: 1, max: 1_000_000 }),
      nControl: integer({ min: 1, max: 1_000_000 }),
      informationRates: array(number({ gt: 0, max: 1 }), { min: 2, max: 20, increasing: true, last: 1 }),
      spending: string({ values: [...VCR_SPENDING_FUNCTIONS] }),
    }), { min: 1, max: 50 })),
    truths: req(array(object({
      null: boolean(),
      nullRate: number(BINARY_RATE), responseRate: number(BINARY_RATE), alternativeRate: number(BINARY_RATE),
      controlRates: array(number(BINARY_RATE), { min: 2, max: 2 }), treatmentRates: array(number(BINARY_RATE), { min: 2, max: 2 }),
      effect: number(), sd: number({ gt: 0 }), baselineCorrelation: number({ gt: -1, lt: 1 }),
      controlRate: number({ ...PROBABILITY }), treatmentRate: number({ ...PROBABILITY }),
      riskDifference: number({ gt: -1, lt: 1 }), oddsRatio: number({ gt: 0 }), covariateLogit: number(),
      hazardRatio: number({ gt: 0 }), treatmentHazardRatios: TREATMENT_HAZARD_RATIOS, controlMedian: number({ gt: 0 }), controlDistribution: CONTROL_DISTRIBUTION,
    }), { min: 1, max: 50 })),
  }, { gridCells: 400 }),

  'design.assurance': object({
    design: req(object({
      // two-arm fixed unless it says group_sequential: the assurance of a group-sequential design is the probability, under the
      // design prior, that it crosses a boundary at any look (the events are the design's maximum, the information rates its looks)
      kind: string({ values: [...VCR_TRIAL_DESIGNS], badValueCode: 'design_unknown', default: 'two_arm_fixed' }),
      allocation: number({ ...PROBABILITY, default: 0.5 }),
      events: req(gated(integer({ min: 1 }), TIME_TO_EVENT)),
      nTreat: req(gated(integer({ min: 1, max: 1_000_000 }), isNot('endpoint.type', 'time_to_event'))),
      nControl: gated(integer({ min: 1, max: 1_000_000 }), isNot('endpoint.type', 'time_to_event')),
      informationRates: req(gated(array(number({ gt: 0, max: 1 }), { min: 2, max: 20, increasing: true, last: 1 }), is('design.kind', 'group_sequential'))),
      spending: gated(string({ values: [...VCR_SPENDING_FUNCTIONS], default: 'obrien_fleming' }), is('design.kind', 'group_sequential')),
    })),
    endpoint: req(ENDPOINT()),
    // The design prior is the assumption card's own distribution: on the
    // prediction interval unless the run says otherwise and says so (EB-11).
    designPrior: req(object({
      mean: req(number()), sd: req(number({ gt: 0 })),
      kind: string({ values: ['normal', 'lognormal'], default: 'normal' }),
      basis: string({ values: ['prediction', 'confidence'], default: 'prediction' }),
      basisOverride: boolean(),
    })),
    truth: req(gated(object({
      sd: gated(number({ gt: 0, default: 1 }), CONTINUOUS),
      controlRate: req(gated(number({ ...PROBABILITY }), BINARY)),
    }), isNot('endpoint.type', 'time_to_event'))),
    analysis: object({ alpha: ALPHA, sided: integer({ min: 1, max: 2, default: 1 }) }),
  }),

  'design.procova': object({
    endpoint: ENDPOINT(),
    design: object({ allocation: number({ ...PROBABILITY, default: 0.5 }) }),
    truth: req(object({ effect: req(number({ unit: 'outcome units' })), sd: number({ gt: 0, default: 1 }) })),
    analysis: object({ alpha: ALPHA, power: number({ ...PROBABILITY, default: 0.9 }), sided: integer({ min: 1, max: 2, default: 1 }) }),
    prognostic: req(object({
      rho: req(number({ min: 0, lt: 1 })),
      rhoOrdinary: number({ min: 0, lt: 1, default: 0 }),
      lambda: number({ gt: 0, max: 1, default: 1 }),
      gamma: number({ min: 1, default: 1 }),
    })),
  }),

  'accrual.poisson_gamma': object({
    sites: req(array(object({
      id: req(string({ minLength: 1, maxLength: 80 })),
      alpha: req(number({ gt: 0 })),
      beta: req(number({ gt: 0 })),
      startTime: req(number({ min: 0, unit: 'time units' })),
      enrolled: integer({ min: 0 }),
      exposureTime: number({ min: 0, unit: 'time units' }),
    }, { requires: { enrolled: ['exposureTime'], exposureTime: ['enrolled'] } }), { min: 1, max: 5000 })),
    target: req(integer({ min: 1, max: 10_000_000 })),
    eventTarget: integer({ min: 1, max: 10_000_000 }),
    eventHazard: number({ gt: 0, unit: 'per month' }),
    screenFailure: object({ alpha: req(number({ gt: 0 })), beta: req(number({ gt: 0 })) }),
    byTimes: array(number({ gt: 0 }), { min: 1, max: 100, increasing: true }),
  }),

  'matching.evaluate': object({
    criteria: req(array(object({
      id: req(string({ minLength: 1, maxLength: 80 })),
      kind: req(string({ values: ['inclusion', 'exclusion'] })),
      type: string({ values: [...VCR_CRITERION_TYPES], default: 'other' }),
      state: req(string({ values: [...VCR_CRITERION_STATES] })),
      notApplicable: boolean(),
    }), { min: 1, max: 500 })),
  }),

  // --- robustness methods (2026-10-04) ---

  // Negative-control outcomes: outcomes the treatment cannot affect, analysed with the primary's adjustment. The weighting keys are
  // those of the weighted comparators, so "the same adjustment" is the same words. `covariates` is required only when a control is a
  // column (the engine refuses by name when it is missing).
  'comparator.negative_control': object({
    endpoint: ENDPOINT(),
    covariates: COLUMN_LIST,
    treatmentColumn: { ...COLUMN, default: 'arm' },
    weighting: string({ values: ['entropy_balance', 'propensity'], default: 'entropy_balance' }),
    estimand: string({ values: ['ATT', 'ATE', 'ATO'], default: 'ATT' }),
    moments: integer({ min: 1, max: 3, default: 1 }),
    cohortRules: COHORT_STEPS,
    effectScale: string({ values: ['log_risk_ratio', 'log_odds_ratio', 'log_hazard_ratio'], default: 'log_risk_ratio' }),
    controls: req(array(effectSource({ name: req(string(CRITERION_NAME)) }), { min: 1, max: 500 })),
    primary: effectSource({ name: string(CRITERION_NAME) }),
  }),

  // Tipping-point analysis for missing outcomes. Binary: exact enumeration over how many of the missing responded, from counts or
  // from a 0/1 column with NA for a missing outcome. Time to event: a delta-adjusted hazard after censoring, by seeded multiple
  // imputation (the job's `replicates` is the number of imputations; the engine refuses fewer than 40). The binary keys and the
  // time-to-event keys are each gated by the endpoint, so a key of the other kind is refused by its path.
  'comparator.tipping_point': object({
    endpoint: req(ENDPOINT()),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    cohortRules: COHORT_STEPS,
    direction: string({ values: ['against_treatment', 'in_favour'] }),
    // binary
    design: req(gated(object({ kind: req(string({ values: ['two_arm', 'single_arm'] })) }), BINARY)),
    counts: gated(object({
      treatment: req(TIPPING_ARM),
      control: { ...TIPPING_ARM, reqWhen: TWO_ARM, when: TWO_ARM },
    }), BINARY),
    outcomeColumn: gated(COLUMN, BINARY),
    missingHandling: gated(string({ values: ['non_responders', 'complete_cases'], default: 'non_responders' }), BINARY),
    // time to event
    horizon: req(gated(number({ gt: 0, unit: 'time units' }), TIME_TO_EVENT)),
    parameterCode: gated(string({ maxLength: 64 }), TIME_TO_EVENT),
    timeUnit: gated(string({ maxLength: 20, default: 'months' }), TIME_TO_EVENT),
    deltas: gated(array(number({ min: 1, max: 1_000_000_000 }), { min: 2, max: 60, increasing: true }), TIME_TO_EVENT),
    deltaApplies: gated(string({ values: ['treatment', 'both_opposite'], default: 'treatment' }), TIME_TO_EVENT),
    analysis: object({
      method: req(gated(string({ valuesBy: { path: 'design.kind', map: { two_arm: ['fisher_exact', 'risk_difference'], single_arm: ['exact_binomial'] } } }), BINARY)),
      nullRate: req(gated(number({ ...PROBABILITY }), [BINARY, SINGLE_ARM_DESIGN])),
      alpha: ALPHA,
      sided: integer({ min: 1, max: 2, default: 1 }),
    }, { reqWhen: BINARY }),
  }, { exactlyOne: [{ keys: ['counts', 'outcomeColumn'], when: BINARY }] }),

  // Prognostic covariate adjustment of a binary or a time-to-event endpoint: a pre-specified score (a column) and optional further
  // covariates in a logistic or a Cox model, reported as a marginal effect. Every result says that no regulator has qualified it
  // beyond continuous outcomes (`diagnostics.regulatoryStatus`, `VCR_PROGNOSTIC_QUALIFICATION`).
  'comparator.prognostic_adjustment': object({
    endpoint: req(ENDPOINT()),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    prognosticScoreColumn: req(COLUMN),
    covariates: COLUMN_LIST,
    outcomeColumn: gated({ ...COLUMN, default: 'y' }, BINARY),
    tau: req(gated(number({ gt: 0, unit: 'time units' }), TIME_TO_EVENT)),
    timeUnit: gated(string({ maxLength: 20, default: 'months' }), TIME_TO_EVENT),
    parameterCode: gated(string({ maxLength: 64 }), TIME_TO_EVENT),
    cohortRules: COHORT_STEPS,
  }),

  // --- end robustness methods ---
})

/** Design × endpoint combinations each method implements; anything else is refused. */
export const VCR_DESIGN_SUPPORT = deepFreeze({
  'design.analytic': Object.freeze({
    two_arm_fixed: Object.freeze(['continuous', 'binary', 'time_to_event']),
    group_sequential: Object.freeze(['time_to_event']),
    simon_two_stage: Object.freeze(['binary']),
    single_arm: Object.freeze(['binary']),
  }),
  'design.simulate': Object.freeze({
    single_arm: Object.freeze(['binary', 'continuous', 'time_to_event']), single_arm_external: Object.freeze(['binary']), simon_two_stage: Object.freeze(['binary']),
    two_arm_fixed: Object.freeze(['continuous', 'binary', 'time_to_event']),
    group_sequential: Object.freeze(['time_to_event']),
  }),
  'design.grid': Object.freeze({
    single_arm: Object.freeze(['binary', 'continuous', 'time_to_event']), single_arm_external: Object.freeze(['binary']), simon_two_stage: Object.freeze(['binary']),
    two_arm_fixed: Object.freeze(['continuous', 'binary', 'time_to_event']),
    group_sequential: Object.freeze(['time_to_event']),
  }),
  'design.assurance': Object.freeze({
    two_arm_fixed: Object.freeze(['continuous', 'binary', 'time_to_event']),
    group_sequential: Object.freeze(['time_to_event']),
  }),
  'design.procova': Object.freeze({
    two_arm_fixed: Object.freeze(['continuous']),
  }),
})

/**
 * The endpoints each confirmatory design is computed for. A count endpoint is its own design and names none. The event-time multi-arm and
 * enrichment designs (design.confirmatory 1.1.0) are simulated on the log-rank statistics from the planned events; under the 1.0.0 label
 * they are refused (`legacyDesignVersionMatches`), because that release did not have them.
 */
export const VCR_CONFIRMATORY_SUPPORT = deepFreeze({
  futility_group_sequential: Object.freeze(['continuous', 'binary', 'time_to_event']),
  sample_size_reestimation: Object.freeze(['continuous', 'binary', 'time_to_event']),
  multi_arm_selection: Object.freeze(['continuous', 'binary', 'time_to_event']),
  enrichment: Object.freeze(['continuous', 'binary', 'time_to_event']),
  count_endpoint: Object.freeze([]),
})

// ---------------------------------------------------------------------------
// The null scenario
// ---------------------------------------------------------------------------

/**
 * Is this scenario a null one — no true effect? One predicate for the replicate
 * floor, the measure's name (`type_one_error` vs `power`) and the report; the R
 * engine mirrors it (`vcr_is_null_scenario`). An explicit `truth.null` wins
 * for legacy two-arm scenarios. Single-arm laws derive the null from their
 * declared response/target ATT; a contradictory flag is refused by validation;
 * otherwise it is derived from the effect the scenario states. A scenario that
 * states no effect at all is not null: it cannot be told.
 * @param {any} scenario
 */
export function vcrIsNullScenario(scenario) {
  const truth = scenario?.truth
  if (!truth || typeof truth !== 'object' || Array.isArray(truth)) return false
  const kind = scenario?.design?.kind
  // A single-arm trial of a mean or a survival time states its effect against the benchmark, and its null is that effect (0, or a hazard
  // ratio of 1) whatever a label says: like the single-arm laws below, a contradictory `truth.null` is refused by validation, never obeyed.
  // The response-rate comparison is the binary single-arm and Simon designs'.
  if (kind === 'single_arm' && ['continuous', 'time_to_event'].includes(scenario?.endpoint?.type)) {
    if (scenario.endpoint.type === 'continuous') return Number.isFinite(truth.effect) && Math.abs(truth.effect) < 1e-12
    return Number.isFinite(truth.hazardRatio) && truth.hazardRatio > 0 && Math.abs(Math.log(truth.hazardRatio)) < 1e-12
  }
  if (kind === 'single_arm' || kind === 'simon_two_stage') return Number.isFinite(truth.responseRate) && Number.isFinite(truth.nullRate) && Math.abs(truth.responseRate - truth.nullRate) < 1e-12
  if (kind === 'single_arm_external' && Array.isArray(truth.controlRates) && Array.isArray(truth.treatmentRates)) {
    const q = scenario?.external?.targetPrevalence
    const validRates = truth.controlRates.length === 2 && truth.treatmentRates.length === 2 && [...truth.controlRates, ...truth.treatmentRates].every(Number.isFinite)
    return validRates && Number.isFinite(q) && Math.abs((1 - q) * (truth.treatmentRates[0] - truth.controlRates[0]) + q * (truth.treatmentRates[1] - truth.controlRates[1])) < 1e-12
  }
  const type = scenario?.endpoint?.type
  const tiny = (/** @type {number} */ x) => Math.abs(x) < 1e-12
  const finite = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x)
  // A non-inferiority design is at its null on the margin, not at an effect of zero: the type I error is the rejection probability there.
  const margin = scenario?.hypothesis?.kind === 'non_inferiority' && finite(scenario.hypothesis.margin) ? /** @type {number} */ (scenario.hypothesis.margin) : null
  if (margin !== null) {
    // the null difference is minus the margin when higher is better and plus the margin when lower is (`hypothesis.direction`)
    const shift = scenario.hypothesis.direction === 'lower_better' ? -margin : margin
    if (type === 'continuous') return finite(truth.effect) && tiny(truth.effect + shift)
    if (type === 'time_to_event') return finite(truth.hazardRatio) && truth.hazardRatio > 0 && tiny(Math.log(truth.hazardRatio / margin))
    if (type === 'binary') {
      const p0 = truth.controlRate
      if (!finite(p0)) return false
      if (finite(truth.treatmentRate)) return tiny(truth.treatmentRate - p0 + shift)
      if (finite(truth.riskDifference)) return tiny(truth.riskDifference + shift)
      if (finite(truth.oddsRatio) && p0 > 0 && p0 < 1) {
        const odds = truth.oddsRatio * p0 / (1 - p0)
        return tiny(odds / (1 + odds) - p0 + shift)
      }
    }
    return false
  }
  if (typeof truth.null === 'boolean') return truth.null
  if (type === 'continuous') return finite(truth.effect) && tiny(truth.effect)
  if (type === 'time_to_event') {
    // a hazard ratio that changes over time is null only when every ratio is 1
    const ratios = truth.treatmentHazardRatios?.ratios
    if (Array.isArray(ratios)) return ratios.length > 0 && ratios.every((/** @type {unknown} */ r) => finite(r) && /** @type {number} */ (r) > 0 && tiny(Math.log(/** @type {number} */ (r))))
    return finite(truth.hazardRatio) && truth.hazardRatio > 0 && tiny(Math.log(truth.hazardRatio))
  }
  if (type === 'binary') {
    const p0 = truth.controlRate
    if (!finite(p0)) return false
    if (finite(truth.treatmentRate)) return tiny(truth.treatmentRate - p0)
    if (finite(truth.riskDifference)) return tiny(truth.riskDifference)
    if (finite(truth.oddsRatio) && p0 > 0 && p0 < 1) {
      const odds = truth.oddsRatio * p0 / (1 - p0)
      return tiny(odds / (1 + odds) - p0)
    }
  }
  return false
}

/**
 * The same scenario with no true effect: the zero-effect case of a two-arm design, stated by the one key of its endpoint that
 * says "no difference" (an effect of 0, a hazard ratio of 1, a risk difference of 0 — the last because a binary control rate
 * may be the card's and not the object's, and 0 needs no copy of it). Everything else the truth says (the control level, the
 * standard deviation, the distribution) stays. `null` is the label the null predicate derives, so it is left out rather than
 * written: a stated label that contradicts the law is refused by validation. Returns null for a scenario this cannot be made for
 * (a single-arm trial states its effect over a benchmark in other keys).
 * @param {any} scenario
 * @returns {Record<string, any> | null} the truth of the null case
 */
export function vcrNullTruth(scenario) {
  // A truth the object leaves out entirely (every number is a card's) is an empty one: the null case adds its one key.
  const truth = scenario?.truth === undefined ? {} : scenario?.truth
  const kind = scenario?.design?.kind
  if (!isObject(truth) || !['two_arm_fixed', 'group_sequential'].includes(kind)) return null
  // The hazard ratio that changes over time is the alternative's law too: the null case states one key for no effect, and two laws for one
  // arm are refused (`Give only one of`).
  const { null: _label, effect: _effect, hazardRatio: _hazardRatio, treatmentHazardRatios: _treatmentHazardRatios, treatmentRate: _treatmentRate, riskDifference: _riskDifference, oddsRatio: _oddsRatio, ...rest } = truth
  // For a non-inferiority design "no effect" is the margin itself: the case where the new treatment is exactly as much worse as is allowed.
  const margin = scenario?.hypothesis?.kind === 'non_inferiority' && typeof scenario.hypothesis.margin === 'number' && scenario.hypothesis.margin > 0 ? scenario.hypothesis.margin : null
  // (and on the side the direction names: minus the margin when higher is better, plus it when lower is)
  const nullDifference = margin === null ? 0 : scenario.hypothesis.direction === 'lower_better' ? margin : -margin
  switch (scenario?.endpoint?.type) {
    case 'continuous': return { ...rest, effect: nullDifference }
    case 'time_to_event': return { ...rest, hazardRatio: margin === null ? 1 : margin }
    case 'binary': return { ...rest, riskDifference: nullDifference }
    default: return null
  }
}

/**
 * The fields of a scenario the engine filled in because the scenario stated none, in the order the schema lists them: a dropout of
 * 0, an alpha of 0.025, one-sided, a uniform accrual. The schema's own defaults are the engine's (case N26 holds the two
 * together), so this reads them rather than keeping a list beside them. A container that is absent but whose default is applied
 * whole (`analysis`, `accrual`) is read as empty, because that is what the engine does with it; any other absent container is
 * not entered, since its defaults only apply to a thing that exists. The analysis method is the one default the schema cannot
 * state (it follows the endpoint), so it is named here from the same table the coupled check reads.
 * @param {string} method @param {unknown} scenario
 * @returns {Array<{ path: string, value: string | number | boolean, unit: string | null }>}
 */
export function vcrAppliedDefaults(method, scenario) {
  const schema = /** @type {any} */ (VCR_SCENARIO_SCHEMAS)[method]
  if (!schema || !isObject(scenario)) return []
  /** @type {Array<{ path: string, value: string | number | boolean, unit: string | null }>} */
  const out = []
  /** @param {any} node @param {unknown} value @param {string} path */
  const walk = (node, value, path) => {
    const fields = node.t === 'variant'
      ? (() => {
        const chosen = isObject(value) && typeof value[node.on] === 'string' ? value[node.on] : node.default
        return typeof chosen === 'string' && Object.hasOwn(node.variants, chosen)
          ? { [node.on]: string({ values: Object.keys(node.variants), default: node.default }), ...node.variants[chosen] } : {}
      })()
      : node.fields
    for (const [key, field] of Object.entries(fields ?? {})) {
      const f = /** @type {any} */ (field)
      if (!whenHolds(f.when, scenario)) continue
      const here = path ? `${path}.${key}` : key
      const stated = isObject(value) && Object.hasOwn(value, key) && value[key] !== null && value[key] !== undefined
      if (f.t === 'object' || f.t === 'variant') {
        if (stated) walk(f, value[key], here)
        else if (ALWAYS_APPLIED.has(here) && !f.req) walk(f, {}, here)
        continue
      }
      if (!stated && f.default !== undefined && ['number', 'integer', 'string', 'boolean'].includes(f.t)) {
        out.push({ path: here, value: f.default, unit: typeof f.unit === 'string' ? f.unit : null })
      }
    }
  }
  walk(schema, scenario, '')
  const analysis = isObject(scenario.analysis) ? scenario.analysis : {}
  const kind = /** @type {any} */ (scenario.design)?.kind ?? 'two_arm_fixed'
  const twoArm = ['two_arm_fixed', 'group_sequential'].includes(kind)
  if (['design.simulate', 'design.grid'].includes(method) && twoArm && analysis.method === undefined) {
    const first = /** @type {Record<string, readonly string[]>} */ (VCR_TWO_ARM_ANALYSIS_METHODS)[/** @type {string} */ (/** @type {any} */ (scenario.endpoint)?.type)]?.[0]
    if (first) out.push({ path: 'analysis.method', value: first, unit: null })
  }
  return out
}

/** The blocks the engine reads as a whole when the scenario leaves them out (the control's time distribution is exponential). */
const ALWAYS_APPLIED = new Set(['analysis', 'accrual', 'truth.controlDistribution'])

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

/** @param {string} path @param {string} key */
const at = (path, key) => (path ? `${path}.${key}` : key)
/** @param {string} path @param {number} i */
const atIndex = (path, i) => `${path}[${i}]`

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value */
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * The value at a dotted path of the scenario, or `undefined`.
 * @param {any} root @param {string} path
 */
function lookup(root, path) {
  let node = root
  for (const key of path.split('.')) {
    if (!isObject(node) || !Object.hasOwn(node, key)) return undefined
    node = node[key]
  }
  return node
}

/** How a booleans is spelled in a `when`: `is('anchored', 'true')`. @param {unknown} value */
const spell = (value) => (typeof value === 'boolean' ? String(value) : value)

/**
 * Does a `when` hold on this scenario?
 * @param {any} when @param {any} root
 * @returns {boolean}
 */
export function whenHolds(when, root) {
  if (!when) return true
  if (Array.isArray(when)) return when.every((/** @type {any} */ item) => whenHolds(item, root))
  const value = lookup(root, when.path)
  if (Array.isArray(when.in)) return when.in.includes(spell(value))
  if (Array.isArray(when.notIn)) return !when.notIn.includes(spell(value))
  if (typeof when.present === 'boolean') return (value !== undefined && value !== null) === when.present
  return true
}

/**
 * Whether a design-search precision block (`evaluation`) may ride on this scenario: the method's schema has one and its gate holds — a
 * dose design of kind `randomized_selection` has none, and the job queue would refuse the field as unknown.
 * @param {string} method @param {any} scenario
 */
export function vcrEvaluationAllowed(method, scenario) {
  const node = /** @type {any} */ (VCR_SCENARIO_SCHEMAS)[method]?.fields?.evaluation
  return Boolean(node) && whenHolds(node.when, scenario)
}

/**
 * @typedef {{ root: any, inputIds: ReadonlySet<string> | null, issues: VcrScenarioIssue[], suppressExpression: boolean }} WalkContext
 */

/** @param {WalkContext} ctx @param {string} code @param {string} field @param {string} detail */
function raise(ctx, code, field, detail) {
  ctx.issues.push({ code, field, detail })
}

/**
 * Names of the members of the list at `columnsFrom`, for a column check.
 * @param {any} root @param {{ path: string, key: string }} spec
 */
function namesFrom(root, spec) {
  const list = lookup(root, spec.path)
  if (!Array.isArray(list)) return null
  const names = list.map((item) => (isObject(item) && typeof item[spec.key] === 'string' ? item[spec.key] : null)).filter((name) => name !== null)
  return names.length ? names : null
}

/**
 * The characters of a string, as R's `nchar()` counts them.
 * @param {string} text
 */
const characters = (text) => [...text].length

/**
 * @param {any} node @param {unknown} value @param {string} path @param {WalkContext} ctx
 */
function checkValue(node, value, path, ctx) {
  switch (node.t) {
    case 'number':
    case 'integer': {
      if (!isNumber(value) || (node.t === 'integer' && !Number.isInteger(value))) {
        raise(ctx, 'scenario_value_invalid', path, node.t === 'integer' ? 'An integer is expected.' : 'A finite number is expected.')
        return
      }
      const num = /** @type {number} */ (value)
      const bounds = []
      if (node.min !== undefined && num < node.min) bounds.push(`at least ${node.min}`)
      if (node.max !== undefined && num > node.max) bounds.push(`at most ${node.max}`)
      if (node.gt !== undefined && !(num > node.gt)) bounds.push(`greater than ${node.gt}`)
      if (node.lt !== undefined && !(num < node.lt)) bounds.push(`less than ${node.lt}`)
      if (bounds.length) raise(ctx, 'scenario_value_invalid', path, `The value must be ${bounds.join(' and ')}.`)
      return
    }
    case 'boolean':
      if (typeof value !== 'boolean') raise(ctx, 'scenario_value_invalid', path, 'A boolean is expected.')
      return
    case 'string': {
      if (typeof value !== 'string') { raise(ctx, 'scenario_value_invalid', path, 'A string is expected.'); return }
      const length = characters(value)
      if (node.minLength !== undefined && length < node.minLength) raise(ctx, 'scenario_value_invalid', path, `At least ${node.minLength} characters.`)
      else if (node.maxLength !== undefined && length > node.maxLength) raise(ctx, 'scenario_value_invalid', path, `At most ${node.maxLength} characters.`)
      else if (node.pattern && !new RegExp(node.pattern).test(value)) raise(ctx, 'scenario_value_invalid', path, 'The value does not match the expected name pattern.')
      else if (node.values && !node.values.includes(value)) {
        raise(ctx, node.badValueCode ?? 'scenario_value_invalid', path, `One of ${node.values.join(', ')} is expected.`)
      } else if (node.valuesBy) {
        const by = lookup(ctx.root, node.valuesBy.path)
        const allowed = typeof by === 'string' ? node.valuesBy.map[by] : undefined
        if (allowed && !allowed.includes(value)) {
          raise(ctx, 'scenario_value_invalid', path, `For a ${by} endpoint one of ${allowed.join(', ')} is expected.`)
        } else if (!allowed && !Object.values(node.valuesBy.map).some((/** @type {any} */ list) => list.includes(value))) {
          raise(ctx, 'scenario_value_invalid', path, 'An analysis method the engine does not have.')
        }
      } else if (node.ref === 'input' && ctx.inputIds && !ctx.inputIds.has(value)) {
        raise(ctx, 'scenario_value_invalid', path, 'The job carries no input with this id.')
      }
      return
    }
    case 'array': {
      if (!Array.isArray(value)) { raise(ctx, 'scenario_value_invalid', path, 'A list is expected.'); return }
      if ((node.min !== undefined && value.length < node.min) || (node.max !== undefined && value.length > node.max)) {
        raise(ctx, 'scenario_value_invalid', path, `A list of ${node.min ?? 0}–${node.max ?? 'any number of'} items is expected.`)
        return
      }
      const before = ctx.issues.length
      value.forEach((item, i) => checkValue(node.items, item, atIndex(path, i), ctx))
      if (ctx.issues.length > before) return
      if (node.increasing && value.some((item, i) => i > 0 && !(item > value[i - 1]))) raise(ctx, 'scenario_value_invalid', path, 'The values must strictly increase.')
      if (node.nondecreasing && value.some((item, i) => i > 0 && !(item >= value[i - 1]))) raise(ctx, 'scenario_value_invalid', path, 'The values must not decrease from one dose to the next.')
      if (node.last !== undefined && value.length && value[value.length - 1] !== node.last) raise(ctx, 'scenario_value_invalid', path, `The last value must be ${node.last}.`)
      if (node.unique && new Set(value).size !== value.length) raise(ctx, 'scenario_value_invalid', path, 'The values must be distinct.')
      return
    }
    case 'object':
      checkObject(node, value, path, ctx)
      return
    case 'variant': {
      if (!isObject(value)) { raise(ctx, 'scenario_value_invalid', path, 'An object is expected.'); return }
      const raw = value[node.on]
      const chosen = raw === undefined ? node.default : raw
      if (typeof chosen !== 'string' || !Object.hasOwn(node.variants, chosen)) {
        raise(ctx, raw === undefined ? 'scenario_field_missing' : 'scenario_value_invalid', at(path, node.on),
          `${node.on} is one of ${Object.keys(node.variants).join(', ')}.`)
        return
      }
      const variant = object({ [node.on]: string({ values: Object.keys(node.variants) }), ...node.variants[chosen] },
        node.variantGroups?.[chosen] ?? {})
      checkObject(variant, value, path, ctx)
      return
    }
    case 'map': {
      if (!isObject(value)) { raise(ctx, 'scenario_value_invalid', path, 'An object is expected.'); return }
      const keys = Object.keys(value)
      if ((node.min !== undefined && keys.length < node.min) || (node.max !== undefined && keys.length > node.max)) {
        raise(ctx, 'scenario_value_invalid', path, `An object of ${node.min ?? 0}–${node.max ?? 'any number of'} entries is expected.`)
        return
      }
      for (const key of keys) {
        if (!new RegExp(VCR_ROW_RULE_COLUMN_PATTERN).test(key)) raise(ctx, 'scenario_field_unknown', at(path, key), 'A key is a column name.')
        else checkValue(node.values, value[key], at(path, key), ctx)
      }
      if (node.keysFrom) {
        const wanted = lookup(ctx.root, node.keysFrom)
        if (Array.isArray(wanted) && wanted.every((item) => typeof item === 'string')) {
          for (const name of wanted) if (!Object.hasOwn(value, name)) raise(ctx, 'scenario_field_missing', at(path, name), `${node.keysFrom} names ${name} but this object does not.`)
          for (const key of keys) if (!wanted.includes(key)) raise(ctx, 'scenario_field_unknown', at(path, key), `${node.keysFrom} does not name ${key}.`)
        }
      }
      return
    }
    case 'matrix': {
      if (!Array.isArray(value) || value.length < 1 || value.some((row) => !Array.isArray(row))) {
        raise(ctx, 'scenario_value_invalid', path, 'A square matrix (a list of equal-length lists of numbers) is expected.')
        return
      }
      const size = value.length
      let bad = value.some((row) => row.length !== size)
      for (const row of value) for (const cell of row) {
        if (!isNumber(cell) || (node.min !== undefined && cell < node.min) || (node.max !== undefined && cell > node.max)) bad = true
      }
      if (bad) { raise(ctx, 'scenario_value_invalid', path, `A square matrix of numbers from ${node.min} to ${node.max} is expected.`); return }
      const dimension = node.size ? lookup(ctx.root, node.size) : undefined
      if (Array.isArray(dimension) && dimension.length !== size) raise(ctx, 'scenario_value_invalid', path, `The matrix is ${size}×${size} but ${node.size} lists ${dimension.length}.`)
      return
    }
    case 'rules': {
      const columns = node.columnsFrom ? namesFrom(ctx.root, node.columnsFrom) : null
      for (const issue of validateNamedRules(value, { path, columns, allowEmpty: node.allowEmpty === true })) {
        if (issue.code === 'rule_expression_forbidden' && ctx.suppressExpression) continue
        ctx.issues.push(issue)
      }
      return
    }
    case 'rule': {
      for (const issue of validateRowRule(value, { path })) {
        if (issue.code === 'rule_expression_forbidden' && ctx.suppressExpression) continue
        ctx.issues.push(issue)
      }
      return
    }
    default:
      throw new TypeError(`vcrScenarioSchemas: unknown node type ${node.t}`)
  }
}

/**
 * Is a key present for the purposes of `exactlyOne` and friends? A key set to
 * null is not present.
 * @param {Record<string, any>} value @param {string} key
 */
const present = (value, key) => Object.hasOwn(value, key) && value[key] !== undefined && value[key] !== null

/**
 * @param {any} node @param {unknown} value @param {string} path @param {WalkContext} ctx
 */
function checkObject(node, value, path, ctx) {
  if (!isObject(value)) { raise(ctx, 'scenario_value_invalid', path, 'An object is expected.'); return }
  const fields = node.fields
  /** @param {any} field */
  const active = (field) => whenHolds(field.when, ctx.root)

  for (const key of Object.keys(value)) {
    if (key === 'expression' && ctx.suppressExpression) continue
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined
    if (!field || !active(field)) raise(ctx, 'scenario_field_unknown', at(path, key), `The engine does not read ${JSON.stringify(key)} here.`)
  }
  for (const key of Object.keys(fields)) {
    const field = fields[key]
    const required = field.req || (field.reqWhen && whenHolds(field.reqWhen, ctx.root))
    if (!active(field)) continue
    if (Object.hasOwn(value, key) && value[key] === null) {
      // null is a value in canonical JSON, so it is refused rather than read as
      // "absent": the two would hash differently and mean the same.
      if (!field.nullable) raise(ctx, 'scenario_value_invalid', at(path, key), 'null is not a value; leave the key out.')
      else if (required) raise(ctx, 'scenario_field_missing', at(path, key), `${key} is required.`)
      continue
    }
    if (!present(value, key)) {
      if (required) raise(ctx, 'scenario_field_missing', at(path, key), `${key} is required.`)
      continue
    }
    checkValue(field, value[key], at(path, key), ctx)
  }
  for (const group of node.exactlyOne ?? []) {
    const keys = Array.isArray(group) ? group : group.keys
    if (!Array.isArray(group) && !whenHolds(group.when, ctx.root)) continue
    const held = keys.filter((/** @type {string} */ key) => present(value, key))
    if (held.length === 0) raise(ctx, 'scenario_field_missing', at(path, keys[0]), `Exactly one of ${keys.join(', ')} is required.`)
    else if (held.length > 1) raise(ctx, 'scenario_value_invalid', at(path, held[1]), `Give only one of ${keys.join(', ')}.`)
  }
  for (const keys of node.atLeastOne ?? []) {
    if (!keys.some((/** @type {string} */ key) => present(value, key))) raise(ctx, 'scenario_field_missing', at(path, keys[0]), `At least one of ${keys.join(', ')} is required.`)
  }
  for (const [key, needs] of Object.entries(node.requires ?? {})) {
    if (!present(value, key)) continue
    for (const need of /** @type {string[]} */ (needs)) {
      if (!present(value, need)) raise(ctx, 'scenario_field_missing', at(path, need), `${need} is required when ${key} is given.`)
    }
  }
  // A list that has one entry per interval of another: a missing or malformed list is reported by its own field, not twice.
  for (const rule of node.lengthRules ?? []) {
    const list = value[rule.key]
    const of = value[rule.of]
    if (!Array.isArray(list) || !Array.isArray(of)) continue
    const want = of.length + (rule.plus ?? 0)
    if (list.length !== want) raise(ctx, 'scenario_value_invalid', at(path, rule.key), `${rule.key} needs ${want} values (${rule.plus ?? 0} more than the ${of.length} in ${rule.of}); it has ${list.length}.`)
  }
}

/**
 * A grid's cell count is bounded, and every cell is a scenario of its own.
 * @param {any} schema @param {any} scenario @param {WalkContext} ctx
 */
function checkGrid(schema, scenario, ctx) {
  const { designs, truths } = scenario
  if (!Array.isArray(designs) || !Array.isArray(truths)) return
  if (designs.length * truths.length > schema.gridCells) {
    raise(ctx, 'scenario_value_invalid', 'designs', `A grid has at most ${schema.gridCells} cells (designs × truths).`)
    return
  }
  const cellSchema = VCR_SCENARIO_SCHEMAS['design.simulate']
  for (let d = 0; d < designs.length; d += 1) {
    for (let t = 0; t < truths.length; t += 1) {
      if (!isObject(designs[d]) || !isObject(truths[t])) return
      // a truth that states its own hazard law replaces the base's, in either form: both would be two laws for one arm
      const base = { ...(isObject(scenario.truth) ? scenario.truth : {}) }
      if (truths[t].treatmentHazardRatios !== undefined) delete base.hazardRatio
      if (truths[t].hazardRatio !== undefined) delete base.treatmentHazardRatios
      const cell = {
        ...scenario,
        design: { ...(isObject(scenario.design) ? scenario.design : {}), ...designs[d] },
        truth: { ...base, ...truths[t] },
      }
      delete cell.designs
      delete cell.truths
      /** @type {WalkContext} */
      const inner = { root: cell, inputIds: ctx.inputIds, issues: [], suppressExpression: true }
      checkObject(cellSchema, cell, '', inner)
      checkDesignSemantics(cell, '', inner)
      const single = ['single_arm', 'single_arm_external', 'simon_two_stage'].includes(cell.design.kind)
      const first = inner.issues.find((issue) => single || issue.code !== 'scenario_field_unknown')
      if (first) {
        raise(ctx, 'scenario_value_invalid', first.field.startsWith('truth') ? atIndex('truths', t) : atIndex('designs', d),
          `Cell (${d}, ${t}) is not a valid scenario: ${first.code} at ${first.field}.`)
        return
      }
    }
  }
}

/**
 * The analyses a two-arm simulation may run, by endpoint, and the one analysis each single-arm design runs. The coupled
 * check below reads them, and so does the help a model is given (`vcrScenarioHelp.mjs`): one table, not a sentence kept beside it.
 */
export const VCR_TWO_ARM_ANALYSIS_METHODS = deepFreeze({ continuous: ['ttest', 'ancova'], binary: ['risk_difference', 'logistic'], time_to_event: ['logrank', 'rmst', 'maxcombo', 'modestly_weighted'] })
export const VCR_SINGLE_ARM_ANALYSIS_METHODS = deepFreeze({
  single_arm: { binary: ['exact_binomial'], continuous: ['one_sample_t', 'one_sample_z'], time_to_event: ['one_sample_logrank'] },
  single_arm_external: { binary: ['stratified_risk_difference'] },
  simon_two_stage: { binary: ['simon_boundary'] },
})

/**
 * The coupled fields of a confirmatory design (mirrored by protocol.R): the endpoint the design is computed for, the looks of an adaptive
 * design (one interim, two entries), the effects on the scale of the endpoint (a hazard ratio is positive, a risk difference leaves the
 * rate inside 0 and 1), and an effect the size is planned for that is not the null (a size cannot be planned against nothing).
 * @param {any} scenario @param {string} path @param {WalkContext} ctx
 */
function checkConfirmatorySemantics(scenario, path, ctx) {
  const bad = (/** @type {string} */ field, /** @type {string} */ detail, /** @type {string} */ code = 'scenario_value_invalid') => raise(ctx, code, at(path, field), detail)
  const design = scenario?.design
  const kind = design?.kind
  if (!isObject(design) || !VCR_CONFIRMATORY_DESIGNS.includes(kind)) return
  const type = scenario?.endpoint?.type
  const support = /** @type {Record<string, readonly string[]>} */ (VCR_CONFIRMATORY_SUPPORT)[kind]
  if (kind !== 'count_endpoint' && VCR_ENDPOINT_TYPES.includes(type) && !support.includes(type)) {
    bad('endpoint.type', `A ${kind} design is computed for a ${support.join(' or ')} endpoint; a ${type} endpoint is refused rather than run as something else.`, 'design_not_supported')
  }
  if (['sample_size_reestimation', 'multi_arm_selection', 'enrichment'].includes(kind) && Array.isArray(design.informationRates) && design.informationRates.length !== 2) {
    bad('design.informationRates', 'An adaptive design looks once: two information rates, the interim fraction and 1.')
  }
  const zone = design.promisingZone
  if (isObject(zone) && typeof zone.lower === 'number' && typeof zone.upper === 'number' && !(zone.lower < zone.upper)) {
    bad('design.promisingZone.upper', 'The promising zone runs from a lower conditional power to a higher one.')
  }
  // Dunnett's test is for several arms against one control; rpact has no Dunnett test for the subsets of an enrichment design
  if (kind === 'enrichment' && design.intersectionTest === 'dunnett') {
    bad('design.intersectionTest', 'An enrichment design tests its subsets with Simes or Bonferroni; Dunnett\'s test is for several arms against one control.', 'design_not_supported')
  }
  const truth = isObject(scenario?.truth) ? scenario.truth : {}
  // an event-time selection or enrichment turns its events into people from the accrual and the control median together: one of them alone is
  // not silently ignored (design.confirmatory 1.2.0)
  if ((kind === 'multi_arm_selection' || kind === 'enrichment') && type === 'time_to_event') {
    const accrual = scenario?.accrual !== undefined
    const median = truth.controlMedian !== undefined
    if (accrual && !median) bad('truth.controlMedian', 'The accrual turns events into people through the control median: state the control median too, or leave the accrual out.', 'scenario_field_missing')
    if (median && !accrual) bad('accrual.duration', 'The control median turns events into people through the accrual: state the accrual (its duration and follow-up) too, or leave the control median out.', 'scenario_field_missing')
  }
  /** @param {string} field @param {unknown} value */
  const onScale = (field, value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    if (type === 'time_to_event' && !(value > 0)) bad(field, 'A hazard ratio is positive.')
    if (type === 'binary') {
      const rate = truth.controlRate + value
      if (Number.isFinite(rate) && !(rate > 0 && rate < 1)) bad(field, 'The control rate plus the risk difference is a rate strictly between 0 and 1.')
    }
  }
  const nullValue = type === 'time_to_event' ? 1 : 0
  if (typeof truth.plannedEffect === 'number') {
    onScale('truth.plannedEffect', truth.plannedEffect)
    if (truth.plannedEffect === nullValue) bad('truth.plannedEffect', 'A size is planned for an effect, not for no effect.', 'design_effect_null')
    // ONE sign convention for the five kinds: the effect a size is planned for is a benefit. A hazard ratio is a benefit below 1, a mean or a
    // risk difference on the side hypothesis.direction names. (The other effects of a scenario may be harm: they show what the design does there.)
    else if (type === 'time_to_event' ? truth.plannedEffect > 1 : scenario?.hypothesis?.direction === 'higher_better' ? truth.plannedEffect < 0 : scenario?.hypothesis?.direction === 'lower_better' && truth.plannedEffect > 0) {
      bad('truth.plannedEffect', type === 'time_to_event'
        ? 'A size is planned for a benefit, and a hazard ratio above 1 is a harm: a design cannot be sized to reach power for it. Give a hazard ratio below 1.'
        : `A size is planned for a benefit, and this effect is on the wrong side of hypothesis.direction (${scenario.hypothesis.direction}): a design cannot be sized to reach power for it. Change the sign of the effect or the direction.`, 'effect_against_direction')
    }
  }
  if (Array.isArray(truth.effects)) truth.effects.forEach((/** @type {unknown} */ value, /** @type {number} */ i) => onScale(`truth.effects[${i}]`, value))
  if (Array.isArray(truth.effectScenarios)) {
    truth.effectScenarios.forEach((/** @type {unknown} */ row, /** @type {number} */ i) => {
      if (!Array.isArray(row)) return
      if (Number.isInteger(design.activeArms) && row.length !== design.activeArms) bad(`truth.effectScenarios[${i}]`, `A scenario states one effect per active arm: ${design.activeArms}.`)
      row.forEach((value, j) => onScale(`truth.effectScenarios[${i}][${j}]`, value))
    })
  }
  if (Array.isArray(truth.subsetEffects)) {
    truth.subsetEffects.forEach((/** @type {any} */ row, /** @type {number} */ i) => {
      onScale(`truth.subsetEffects[${i}].subset`, row?.subset)
      onScale(`truth.subsetEffects[${i}].rest`, row?.rest)
    })
  }
  if (kind === 'count_endpoint' && truth.rateRatio === 1) bad('truth.rateRatio', 'A size is planned for a rate ratio other than 1.', 'design_effect_null')
  if (kind === 'count_endpoint' && typeof truth.rateRatio === 'number' && truth.rateRatio > 1) {
    bad('truth.rateRatio', 'A size is planned for a benefit, and a rate ratio above 1 is more events: a design cannot be sized to reach power for it. Give a rate ratio below 1.', 'effect_against_direction')
  }
  if (Number.isFinite(scenario?.analysis?.alpha) && scenario.analysis.alpha >= 0.5) bad('analysis.alpha', 'The level is one-sided: below one half.')
}

/**
 * The coupled fields of a dose-finding design (mirrored by protocol.R): a comparison is with another design, the settings of a design that does
 * not run are refused (an ignored setting is a silent change), the starting dose and the skeleton fit the curve, and the rates BOIN and the
 * keyboard design are built around sit on either side of the target.
 * @param {any} scenario @param {string} path @param {WalkContext} ctx
 */
function checkDoseSemantics(scenario, path, ctx) {
  const bad = (/** @type {string} */ field, /** @type {string} */ detail) => raise(ctx, 'scenario_value_invalid', at(path, field), detail)
  const design = scenario?.design
  const kind = design?.kind
  if (!isObject(design) || !VCR_DOSE_DESIGNS.includes(kind)) return
  const truth = isObject(scenario?.truth) ? scenario.truth : {}
  if (kind === 'randomized_selection') {
    const rows = Array.isArray(truth.responseScenarios) ? truth.responseScenarios.filter(Array.isArray) : []
    if (rows.length && rows.some((/** @type {any[]} */ row) => row.length !== rows[0].length)) bad('truth.responseScenarios', 'Every scenario states one response rate per dose, the same doses in each.')
    return
  }
  const asked = [kind, ...(Array.isArray(design.compare) ? design.compare : [])]
  if (Array.isArray(design.compare) && design.compare.includes(kind)) bad('design.compare', 'The design asked about is not also compared with itself.')
  for (const name of ['boin', 'keyboard', 'crm']) {
    if (design[name] !== undefined && !asked.includes(name)) bad(`design.${name}`, `Settings for the ${name} design are given, but that design is not one of those asked about.`)
  }
  const doses = Array.isArray(truth.toxicity) ? truth.toxicity.length : null
  if (doses !== null && Number.isInteger(design.startDose) && design.startDose > doses) bad('design.startDose', 'The starting dose is one of the doses on the curve.')
  if (doses !== null && Array.isArray(design.crm?.skeleton) && design.crm.skeleton.length !== doses) bad('design.crm.skeleton', 'The skeleton has one prior toxicity guess per dose on the curve.')
  const target = typeof design.targetToxicity === 'number' ? design.targetToxicity : 0.3
  const safe = design.boin?.safeRate
  const toxic = design.boin?.toxicRate
  if ((typeof safe === 'number' && !(safe < target)) || (typeof toxic === 'number' && !(toxic > target))) {
    bad('design.boin', 'The toxicity rate deemed safe is below the target and the one deemed too toxic above it.')
  }
  const margin = design.keyboard?.margin
  if (typeof margin === 'number' && !(target - margin > 0 && target + margin < 1)) bad('design.keyboard.margin', 'The target key lies inside 0 and 1.')
}

/**
 * The coupled fields of a longitudinal virtual-patient scenario (mirrored by protocol.R): a dropout that depends on the outcome starts from a
 * probability of leaving, so dropoutPerVisit is stated and above 0.
 * @param {any} scenario @param {string} path @param {WalkContext} ctx
 */
function checkLongitudinalSemantics(scenario, path, ctx) {
  if (!isObject(scenario?.dropoutModel)) return
  if (!(typeof scenario.dropoutPerVisit === 'number' && scenario.dropoutPerVisit > 0)) {
    raise(ctx, 'scenario_value_invalid', at(path, 'dropoutPerVisit'), 'A dropout that depends on the outcome starts from the probability of leaving at an average outcome: state dropoutPerVisit above 0.')
  }
}

/**
 * The coupled fields of a win-ratio design (mirrored by protocol.R): a size and a power wanted are two ways to ask, never both (the size would be
 * read and the power ignored), and the events level tracks at most 8 events per person on average.
 * @param {any} scenario @param {string} path @param {WalkContext} ctx
 */
function checkWinRatioSemantics(scenario, path, ctx) {
  const bad = (/** @type {string} */ field, /** @type {string} */ detail) => raise(ctx, 'scenario_value_invalid', at(path, field), detail)
  const design = isObject(scenario?.design) ? scenario.design : {}
  const analysis = isObject(scenario?.analysis) ? scenario.analysis : {}
  if (design.nTreat !== undefined && design.nTreat !== null && analysis.power !== undefined && analysis.power !== null) {
    bad('analysis.power', 'State the size of each arm to get the power, or the power wanted to get the size; not both.')
  }
  const events = scenario?.truth?.events
  if (isObject(events) && typeof events.controlRate === 'number' && typeof events.rateRatio === 'number' && typeof design.followup === 'number'
    && events.controlRate * design.followup * Math.max(1, events.rateRatio) > 8) {
    bad('truth.events.controlRate', 'More than 8 events per person on average are not tracked by this method.')
  }
}

/**
 * The coupled fields of a Bayesian design (mirrored by protocol.R): the alternative response rate is above the null rate, the looks fit the
 * size, a hazard-ratio margin is positive, and the rate a risk-difference margin leads to stays a rate.
 * @param {any} scenario @param {string} path @param {WalkContext} ctx
 */
function checkBayesianSemantics(scenario, path, ctx) {
  const bad = (/** @type {string} */ field, /** @type {string} */ detail) => raise(ctx, 'scenario_value_invalid', at(path, field), detail)
  const design = scenario?.design
  const kind = design?.kind
  if (!isObject(design) || !VCR_BAYESIAN_DESIGNS.includes(kind)) return
  const truth = isObject(scenario?.truth) ? scenario.truth : {}
  if (kind !== 'threshold_calibration') {
    if (typeof truth.nullRate === 'number' && typeof truth.alternativeRate === 'number' && !(truth.alternativeRate > truth.nullRate)) bad('truth.alternativeRate', 'The alternative response rate is above the null rate.')
    if (Number.isInteger(design.lookEvery) && Number.isInteger(design.maxN) && design.lookEvery > design.maxN) bad('design.lookEvery', 'The first look comes at or before the largest size.')
    else if (Number.isInteger(design.lookEvery) && Number.isInteger(design.maxN) && Math.ceil(design.maxN / design.lookEvery) > 60) bad('design.lookEvery', 'A phase II design has at most 60 looks: look less often.')
    return
  }
  const type = scenario?.endpoint?.type
  if (type === 'time_to_event' && typeof design.margin === 'number' && !(design.margin > 0)) bad('design.margin', 'A hazard-ratio margin is positive.')
  if (type === 'binary' && typeof design.margin === 'number' && typeof truth.controlRate === 'number') {
    const rate = truth.controlRate + design.margin
    if (!(rate > 0 && rate < 1)) bad('design.margin', 'The control rate plus the margin is a rate strictly between 0 and 1.')
  }
}

/**
 * What a non-inferiority margin may be asked of (T1): a comparison of two arms, run by the test the margin is defined for, with the
 * margin on the scale of its endpoint. Mirrored by protocol.R.
 * @param {any} scenario @param {string} path @param {WalkContext} ctx
 */
function checkHypothesis(scenario, path, ctx) {
  const hypothesis = scenario?.hypothesis
  if (!isObject(hypothesis) || hypothesis.kind !== 'non_inferiority') return
  const bad = (/** @type {string} */ field, /** @type {string} */ detail) => raise(ctx, 'scenario_value_invalid', at(path, field), detail)
  const kind = scenario?.design?.kind
  const type = scenario?.endpoint?.type
  const method = scenario?.analysis?.method
  if (['single_arm', 'single_arm_external', 'simon_two_stage'].includes(kind)) {
    bad('hypothesis.kind', 'A non-inferiority margin compares two arms; a single-arm design states its benchmark instead.')
    return
  }
  const tests = /** @type {Record<string, string>} */ ({ continuous: 'ttest', binary: 'risk_difference', time_to_event: 'logrank' })
  if (method !== undefined && tests[type] !== undefined && method !== tests[type]) {
    bad('analysis.method', `A non-inferiority margin is tested with ${tests[type]} for a ${type} endpoint.`)
  }
  if (scenario?.truth && Object.hasOwn(scenario.truth, 'treatmentHazardRatios')) {
    bad('truth.treatmentHazardRatios', 'A margin on the hazard ratio assumes one hazard ratio; a ratio that changes over time has none to compare with it.')
  }
  const margin = hypothesis.margin
  if (typeof margin === 'number' && Number.isFinite(margin)) {
    if (type === 'binary' && !(margin < 1)) bad('hypothesis.margin', 'The margin of a risk difference is below 1.')
    if (type === 'time_to_event' && !(margin > 1)) bad('hypothesis.margin', 'The margin of a hazard ratio is above 1: the largest hazard ratio at which the new treatment still counts as not worse.')
  }
}

/** Coupled design fields, mirrored by protocol.R. @param {any} scenario @param {string} path @param {WalkContext} ctx */
function checkDesignSemantics(scenario, path, ctx) {
  const kind = scenario?.design?.kind
  const method = scenario.analysis?.method
  const bad = (/** @type {string} */ field, /** @type {string} */ detail) => raise(ctx, 'scenario_value_invalid', at(path, field), detail)
  checkHypothesis(scenario, path, ctx)
  if (!['single_arm', 'single_arm_external', 'simon_two_stage'].includes(kind)) {
    const methods = /** @type {Record<string, readonly string[]>} */ (VCR_TWO_ARM_ANALYSIS_METHODS)
    if (method && !(methods[/** @type {string} */ (scenario.endpoint?.type)] ?? []).includes(method)) bad('analysis.method', 'The analysis must match the endpoint.')
    return
  }
  // the analyses a single-arm design runs, by endpoint: the external-control and Simon designs are binary-endpoint designs only
  const allowed = /** @type {Record<string, Record<string, readonly string[]>>} */ (VCR_SINGLE_ARM_ANALYSIS_METHODS)[kind]?.[/** @type {string} */ (scenario.endpoint?.type)]
  if (!allowed) bad('endpoint.type', kind === 'single_arm' ? 'A single-arm design is simulated for a binary, continuous or time-to-event endpoint.' : 'This single-arm implementation requires a binary endpoint.')
  else if (method && !allowed.includes(method)) bad('analysis.method', 'The analysis must match the declared single-arm design.')
  const sided = scenario.analysis?.sided ?? 1
  if (sided === 1 && Number.isFinite(scenario.analysis?.alpha) && scenario.analysis.alpha >= 0.5) bad('analysis.alpha', 'A one-sided analysis uses alpha below one half.')
  if (kind === 'single_arm' && sided !== (scenario.analysis?.alternative === 'two.sided' ? 2 : 1)) bad('analysis.sided', 'Sidedness must agree with the exact binomial alternative.')
  if (kind === 'simon_two_stage') {
    const { n1, n, r1, r } = scenario.design
    if (Number.isFinite(n1) && Number.isFinite(n) && n1 >= n) bad('design.n1', 'Stage one is smaller than the total sample size.')
    if (Number.isFinite(r1) && Number.isFinite(n1) && r1 >= n1) bad('design.r1', 'Stage one continues only when responses exceed r1 < n1.')
    if (Number.isFinite(r) && Number.isFinite(n) && (r >= n || r < r1)) bad('design.r', 'The final success threshold satisfies r1 <= r < n.')
    if (sided !== 1) bad('analysis.sided', 'Simon uses the upper one-sided frozen boundary rule.')
    if (Number.isFinite(scenario.truth?.alternativeRate) && Number.isFinite(scenario.truth?.nullRate) && scenario.truth.alternativeRate <= scenario.truth.nullRate) bad('truth.alternativeRate', 'The alternative response rate exceeds the null rate.')
  }
  if (typeof scenario.truth?.null === 'boolean' && scenario.truth.null !== vcrIsNullScenario(scenario)) bad('truth.null', 'The null label must agree with the generating estimand; it does not change the generating law.')
}

/**
 * The fields of a design scenario that have no closed form: a hazard ratio that changes over time and the MaxCombo analysis. A design
 * stating either is sized by simulation only; the analytic design and the assurance are not asked for it (the programme skips them) and
 * refuse it by name when asked (`checkNoNonProportionalHazards`).
 * @param {any} scenario
 * @returns {string[]} the paths, empty for a design that has a closed form
 */
export function vcrNoClosedFormFields(scenario) {
  return [
    scenario?.truth && typeof scenario.truth === 'object' && Object.hasOwn(scenario.truth, 'treatmentHazardRatios') ? 'truth.treatmentHazardRatios' : null,
    scenario?.analysis?.method === 'maxcombo' || scenario?.analysis?.method === 'modestly_weighted' ? 'analysis.method' : null,
  ].filter((field) => field !== null)
}

/**
 * A hazard ratio that changes over time and the MaxCombo analysis exist in the simulation only (remediation plan D1): a formula sizes a
 * proportional-hazards design. The analytic design and the assurance refuse them by name and say where to go, in place of the
 * schema's "the engine does not read it".
 * @param {any} scenario @param {string} path @param {WalkContext} ctx
 */
function checkNoNonProportionalHazards(scenario, path, ctx) {
  const where = vcrNoClosedFormFields(scenario)
  if (!where.length) return
  ctx.issues = ctx.issues.filter((issue) => !(issue.code === 'scenario_field_unknown' && where.some((field) => issue.field === at(path, /** @type {string} */ (field)))))
  for (const field of where) {
    raise(ctx, 'scenario_value_invalid', at(path, /** @type {string} */ (field)),
      'A hazard ratio that changes over time, the MaxCombo analysis and the modestly weighted test are simulated, not sized by a formula: ask for design_simulation (design.simulate) with this truth and analysis.')
  }
}

/**
 * The aggregate outcome of an unanchored MAIC is on the outcome's own scale -- the engine applies the link to it, and to its standard
 * error by the delta method -- so it has to lie inside the link's domain: a proportion strictly between 0 and 1 for the logit link, a
 * positive mean or rate for the log link. Mirrored by protocol.R.
 * @param {any} scenario @param {string} path @param {WalkContext} ctx
 */
function checkMaicSemantics(scenario, path, ctx) {
  const link = scenario.link ?? 'identity'
  const value = scenario.aggregateOutcome
  if (scenario.anchored === true || !isNumber(value)) return
  if (link === 'logit' && !(value > 0 && value < 1)) raise(ctx, 'scenario_value_invalid', at(path, 'aggregateOutcome'), 'On the logit link the aggregate outcome is a proportion strictly between 0 and 1, on its own scale (not log-odds).')
  if (link === 'log' && !(value > 0)) raise(ctx, 'scenario_value_invalid', at(path, 'aggregateOutcome'), 'On the log link the aggregate outcome is positive, on its own scale (not its log).')
}

/**
 * A target number of events is counted among every patient the forecast follows: the patients the sites report as enrolled
 * (`sites[].enrolled`, whose events the engine simulates from the sites' exposure) and the ones still to enrol. A target above their
 * number (the enrolment target, or the patients already enrolled if there are more) is never reached, in any replicate: the run found no
 * event time at all and ended as a handler error, after every replicate. It is refused by name instead. Mirrored by protocol.R.
 * @param {any} scenario @param {string} path @param {WalkContext} ctx
 */
function checkAccrualSemantics(scenario, path, ctx) {
  const { eventTarget, target, sites } = scenario
  if (!isNumber(eventTarget) || !isNumber(target) || !Array.isArray(sites)) return
  const enrolled = sites.reduce((/** @type {number} */ sum, /** @type {any} */ site) => sum + (isObject(site) && isNumber(site.enrolled) && site.enrolled > 0 ? site.enrolled : 0), 0)
  const patients = Math.max(target, enrolled)
  if (eventTarget > patients) {
    raise(ctx, 'scenario_value_invalid', at(path, 'eventTarget'), enrolled > target
      ? `Events are counted among the ${patients} patients already enrolled (more than the target of ${target}); an event target of ${eventTarget} is never reached.`
      : `Events are counted among the ${patients} patients of the enrolment target, enrolled and still to enrol; an event target of ${eventTarget} is never reached.`)
  }
}

/**
 * Validate one method's scenario against its schema. Returns issues; empty is
 * valid. `inputIds` is the set of the job's input ids, for keys that name one.
 * @param {string} method @param {unknown} scenario
 * @param {{ inputIds?: Iterable<string> | null, path?: string }} [options]
 * @returns {readonly VcrScenarioIssue[]}
 */
export function validateScenario(method, scenario, { inputIds = null, path = 'scenario' } = {}) {
  const schema = /** @type {any} */ (VCR_SCENARIO_SCHEMAS)[method]
  if (!schema) return Object.freeze([{ code: 'method_unknown', field: 'method', detail: `No schema for method ${JSON.stringify(method)}.` }])
  if (Array.isArray(scenario)) {
    return Object.freeze([{ code: 'scenario_value_invalid', field: path, detail: 'A scenario is an object, not a list.' }])
  }
  if (!isObject(scenario)) return Object.freeze([{ code: 'scenario_missing', field: path, detail: 'A job carries its frozen scenario, not a reference to one.' }])

  /** @type {WalkContext} */
  const ctx = { root: scenario, inputIds: inputIds ? new Set(inputIds) : null, issues: [], suppressExpression: true }
  for (const holder of findExpressionFields(scenario, { path })) {
    ctx.issues.push({ code: 'rule_expression_forbidden', field: holder, detail: 'A scenario never carries an expression: rules are data in a closed grammar.' })
  }
  checkObject(schema, scenario, path, ctx)
  // a stated accrual rate is turned into the duration by the platform before the job is frozen (vcrAccrualRate.mjs); a job that reaches the
  // engine with the rate alone would run with a duration it never stated, so it is refused (mirrored in R/protocol.R)
  if (isObject(scenario?.accrual) && scenario.accrual.rate !== undefined && scenario.accrual.duration === undefined) {
    raise(ctx, 'scenario_field_missing', at(path, 'accrual.duration'), 'A rate gives the duration only through the platform, before the job is frozen: state accrual.duration too.')
  }
  if (method === 'design.simulate' || method === 'design.grid' || method === 'design.analytic') checkDesignSemantics(scenario, path, ctx)
  if (method === 'design.confirmatory') checkConfirmatorySemantics(scenario, path, ctx)
  if (method === 'design.dose') checkDoseSemantics(scenario, path, ctx)
  if (method === 'design.bayesian') checkBayesianSemantics(scenario, path, ctx)
  if (method === 'design.win_ratio') checkWinRatioSemantics(scenario, path, ctx)
  if (method === 'patients.longitudinal') checkLongitudinalSemantics(scenario, path, ctx)
  if (method === 'design.analytic' || method === 'design.assurance') checkNoNonProportionalHazards(scenario, path, ctx)
  if (method === 'comparator.maic') checkMaicSemantics(scenario, path, ctx)
  if (method === 'accrual.poisson_gamma') checkAccrualSemantics(scenario, path, ctx)
  if (schema.gridCells) checkGrid(schema, scenario, ctx)

  // The same defect can be reported by two walkers; say it once.
  const seen = new Set()
  return Object.freeze(ctx.issues.filter((issue) => {
    const key = `${issue.code}@${issue.field}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }))
}
