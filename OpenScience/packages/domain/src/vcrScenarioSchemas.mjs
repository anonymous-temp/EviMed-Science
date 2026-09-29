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
 *   options (`exactlyOne`, `atLeastOne`, `requires`).
 * - **Design × endpoint is a table.** The engine implements fixed two-arm
 *   designs for all three endpoint families and group-sequential only for
 *   time-to-event; single-arm, Simon and single-arm-with-external-control
 *   designs are not simulated. A combination outside `VCR_DESIGN_SUPPORT` is
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
 *   array    { items, min, max, increasing, last, unique }
 *   object   { fields, exactlyOne, atLeastOne, requires }
 *   variant  { on, variants: { <value>: object-fields }, default }   discriminated object
 *   map      { values, keysFrom, min, max }             keys are column names
 *   matrix   { min, max, size }                         square, numeric
 *   rules    { allowEmpty, columnsFrom }                list of { name, rule }
 *
 * and on a field: `req` (required — inside a `when` gate, required whenever the
 * gate holds), `when` (condition or list of conditions, all must hold, else the
 * key is unknown), `nullable` (null reads as absent).
 *
 * @module @evimed/domain/vcrScenarioSchemas
 */

import {
  VCR_CRITERION_STATES, VCR_CRITERION_TYPES, VCR_ENDPOINT_TYPES, VCR_MISSING_REASONS, VCR_PERFORMANCE_MEASURES,
  VCR_POOLING_METHODS, VCR_SPENDING_FUNCTIONS, VCR_TRIAL_DESIGNS,
} from './vcrVocabulary.mjs'
import {
  VCR_ROW_RULE_COLUMN_PATTERN, findExpressionFields, validateNamedRules, validateRowRule,
} from './vcrRules.mjs'

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
  },
}, { min: 1, max: 20 })

/** Which parameters of a variable are uncertain, and by how much (per-variable parameter uncertainty). */
const PARAM_SD = { t: 'map', values: number({ min: 0 }), min: 1, max: 4 }

/** The names a covariate effect is keyed by: columns of the generated data. */
const COVARIATE_EFFECTS = { t: 'map', values: number(), min: 1, max: 100 }


// ---------------------------------------------------------------------------
// Shared blocks
// ---------------------------------------------------------------------------

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
}

/**
 * The data-generating truth of a two-arm trial, by endpoint family. `binaryWhen`
 * is the gate of the binary keys (the analytic path drops them for a Simon
 * design, which is single-arm).
 * @param {{ binaryWhen?: any, simulated?: boolean, generator?: boolean, extra?: Record<string, any> }} [options]
 */
const truthFields = ({ binaryWhen = BINARY, simulated = true, generator = false, extra = {} } = {}) => ({
  ...(simulated && !generator ? { null: boolean() } : {}),
  effect: req(gated(number({ unit: 'outcome units' }), CONTINUOUS)),
  sd: gated(number({ gt: 0, default: 1, unit: 'outcome units' }), CONTINUOUS),
  ...(simulated ? { baselineCorrelation: gated(number({ gt: -1, lt: 1, default: 0 }), CONTINUOUS) } : {}),
  controlRate: req(gated(number({ ...PROBABILITY }), binaryWhen)),
  treatmentRate: gated(number({ ...PROBABILITY }), binaryWhen),
  riskDifference: gated(number({ gt: -1, lt: 1 }), binaryWhen),
  oddsRatio: gated(number({ gt: 0 }), binaryWhen),
  ...(simulated ? { covariateLogit: gated(number({ default: 0 }), BINARY) } : {}),
  hazardRatio: req(gated(number({ gt: 0 }), TIME_TO_EVENT)),
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
      followup: number({ min: 0, unit: 'time units' }),
      dropoutAnnual: number({ min: 0, lt: 1, default: 0, unit: 'proportion per 12 time units' }),
      maxFollowup: number({ gt: 0, unit: 'time units' }),
    },
    piecewise: {
      breaks: req(array(number({ gt: 0 }), { min: 1, max: 50, increasing: true })),
      rates: req(array(number({ gt: 0 }), { min: 2, max: 51 })),
      tail: number({ gt: 0 }),
      followup: number({ min: 0, unit: 'time units' }),
      dropoutAnnual: number({ min: 0, lt: 1, default: 0, unit: 'proportion per 12 time units' }),
      maxFollowup: number({ gt: 0, unit: 'time units' }),
    },
  },
}, TIME_TO_EVENT)

const SIMULATED_ANALYSIS = object({
  method: string({
    valuesBy: { path: 'endpoint.type', map: { continuous: ['ttest', 'ancova'], binary: ['risk_difference', 'logistic'], time_to_event: ['logrank', 'rmst'] } },
  }),
  alpha: ALPHA,
  sided: integer({ min: 1, max: 2, default: 1 }),
  tau: req(gated(number({ gt: 0, unit: 'time units' }), is('analysis.method', 'rmst'))),
})

const SIMULATED_DESIGN_FIELDS = {
  kind: req(string({ values: [...VCR_TRIAL_DESIGNS], badValueCode: 'design_unknown' })),
  nTreat: req(integer({ min: 1, max: 1_000_000 })),
  nControl: integer({ min: 1, max: 1_000_000 }),
  informationRates: req(gated(array(number({ gt: 0, max: 1 }), { min: 2, max: 20, increasing: true, last: 1 }), is('design.kind', 'group_sequential'))),
  spending: gated(string({ values: [...VCR_SPENDING_FUNCTIONS], default: 'obrien_fleming' }), is('design.kind', 'group_sequential')),
}

const SIMULATE_FIELDS = {
  design: req(object(SIMULATED_DESIGN_FIELDS)),
  endpoint: req(ENDPOINT()),
  truth: req(object(truthFields(), { exactlyOne: truthGroups() })),
  analysis: SIMULATED_ANALYSIS,
  accrual: SIMULATED_ACCRUAL,
  performance: PERFORMANCE,
  targetMcse: TARGET_MCSE,
  costs: COSTS,
}

/** A generator: two arms drawn from one endpoint family's reference simulator. */
const patientsFields = () => ({
  design: req(object({ nTreat: req(integer({ min: 1, max: 1_000_000 })), nControl: integer({ min: 0, max: 1_000_000 }) })),
  endpoint: req(ENDPOINT()),
  truth: req(object(truthFields({ generator: true, extra: { covariateEffects: COVARIATE_EFFECTS } }), { exactlyOne: truthGroups() })),
  accrual: SIMULATED_ACCRUAL,
})

// ---------------------------------------------------------------------------
// Population variables (population.scenario)
// ---------------------------------------------------------------------------

const VARIABLE_BOUNDS = { min: number(), max: number() }
/** @param {Record<string, any>} fields */
const uncertain = (fields) => ({ ...fields, paramSd: PARAM_SD })
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
const WEIGHTING_CONTEXT = {
  endpoint: ENDPOINT(),
  tau: req(gated(number({ gt: 0, unit: 'time units' }), TIME_TO_EVENT)),
  timeUnit: string({ maxLength: 20, default: 'months' }),
  parameterCode: string({ maxLength: 64 }),
  cohortRules: COHORT_STEPS,
  targetTrial: TARGET_TRIAL,
}

// ---------------------------------------------------------------------------
// The schemas
// ---------------------------------------------------------------------------

/**
 * Per method: the object the engine's `scenario` must be. Read by
 * `validateScenario` here and by `vcr_validate_job` in R from the snapshot.
 */
export const VCR_SCENARIO_SCHEMAS = deepFreeze({
  'profile.snapshot': object({}),

  'cohort.build': object({
    rules: req(COHORT_STEPS),
    // The cohort's time zero and the end of each subject's follow-up are columns
    // of the table, carried with the cohort to every job that reads it (EA-6).
    timeZero: object({ column: req(COLUMN) }),
    exit: object({ column: req(COLUMN) }),
    idColumn: { ...COLUMN, default: 'USUBJID' },
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
    baselineTable: req(array(object({
      variable: req(COLUMN),
      mean: number(), sd: number({ gt: 0 }), proportion: number({ min: 0, max: 1 }),
      // A categorical row: its proportions (which sum to one — the handler checks), and optionally what each level is called.
      proportions: array(number({ min: 0, max: 1 }), { min: 2, max: 50 }),
      levels: array(string({ maxLength: 64 }), { min: 2, max: 50 }),
      min: { ...number(), nullable: true }, max: { ...number(), nullable: true },
      distribution: string({ values: ['normal', 'lognormal'], default: 'normal' }),
    }, { exactlyOne: [['proportion', 'mean', 'proportions']], requires: { mean: ['sd'], levels: ['proportions'] } }), { min: 1, max: 100 })),
    n: integer({ min: 1, max: 1_000_000, default: 1000 }),
    correlation: { t: 'matrix', min: -1, max: 1, size: 'baselineTable' },
    correlationSource: string({ values: ['assumed', 'cited'], default: 'assumed' }),
    parameterDraws: integer({ min: 1, max: 1000, default: 1 }),
  }),

  'population.synthpop': object({
    holdoutShare: number({ min: 0, lt: 1, default: 0.2 }),
    m: integer({ min: 1, max: 50, default: 5 }),
    constraints: { t: 'rules', allowEmpty: true },
    criteria: { t: 'rules', allowEmpty: true },
    analyses: ANALYSES,
    tstrOutcome: COLUMN,
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
  }),

  'patients.continuous': object(patientsFields()),
  'patients.binary': object(patientsFields()),
  'patients.time_to_event': object(patientsFields()),

  'evidence.pool': object({
    studies: req(array(object({
      studyId: req(string({ minLength: 1, maxLength: 121 })),
      estimate: req(number()),
      se: req(number({ gt: 0 })),
    }), { min: 1, max: 500 })),
    method: string({ values: [...VCR_POOLING_METHODS], default: 'random_effects_dl' }),
    level: number({ gt: 0, lt: 1, default: 0.95 }),
    scale: string({ values: ['identity', 'log', 'logit'], default: 'identity' }),
  }),

  // Without the published numbers at risk censoring is not identified, so the
  // risk table is required; and the coordinates say where they came from — a
  // curve "read" off a picture by a language model is several times less
  // accurate than a digitizer's (EB-6).
  'evidence.reconstruct_km': object({
    curve: req(KM_CURVE),
    riskTable: req(KM_RISK_TABLE),
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
      riskTable: req(KM_RISK_TABLE),
      totalEvents: number({ min: 0 }),
      reportedMedian: number({ gt: 0 }),
    }),
  }),

  // The weighted comparators dispatch on the endpoint: a time-to-event outcome
  // is a weighted Kaplan-Meier curve and an RMST at `tau` (EB-2), so `tau` is
  // required exactly when the endpoint says so.
  'comparator.entropy_balance': object({
    covariates: req(COLUMN_LIST),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    outcomeColumn: { ...COLUMN, default: 'y' },
    moments: integer({ min: 1, max: 3, default: 1 }),
    estimand: string({ values: ['ATT'], default: 'ATT' }),
    ...WEIGHTING_CONTEXT,
  }),

  'comparator.propensity_weight': object({
    covariates: req(COLUMN_LIST),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    outcomeColumn: { ...COLUMN, default: 'y' },
    estimand: string({ values: ['ATT', 'ATE', 'ATO'], default: 'ATT' }),
    ...WEIGHTING_CONTEXT,
  }),

  'comparator.rmst': object({
    tau: req(number({ gt: 0, unit: 'time units' })),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    weightColumn: COLUMN,
    timeUnit: string({ maxLength: 20, default: 'months' }),
    parameterCode: string({ maxLength: 64 }),
    cohortRules: COHORT_STEPS,
  }),

  'comparator.maic': object({
    covariates: req(COLUMN_LIST),
    targets: req({ t: 'map', values: number(), keysFrom: 'covariates', min: 1, max: 100 }),
    treatmentColumn: { ...COLUMN, default: 'arm' },
    endpoint: ENDPOINT(),
    anchored: boolean({ default: false }),
    aggregateEstimate: req(gated(number(), is('anchored', 'true'))),
    aggregateOutcome: req(gated(number(), isNot('anchored', 'true'))),
    aggregateSe: req(number({ gt: 0 })),
    outcomeColumn: gated({ ...COLUMN, default: 'y' }, isNot('anchored', 'true')),
    link: string({ values: ['identity', 'log', 'logit'], default: 'identity' }),
    unadjustedEffectModifiers: array(string({ maxLength: 80 }), { min: 0, max: 50 }),
  }),

  'comparator.evalue': object({
    riskRatio: req(number({ gt: 0 })),
    confidenceLimit: number({ gt: 0 }),
    scale: string({ values: ['risk_ratio', 'odds_ratio', 'hazard_ratio'], default: 'risk_ratio' }),
    rare: boolean(),
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

  'design.analytic': object({
    design: req(object({
      kind: req(string({ values: [...VCR_TRIAL_DESIGNS], badValueCode: 'design_unknown' })),
      informationRates: req(gated(array(number({ gt: 0, max: 1 }), { min: 2, max: 20, increasing: true, last: 1 }), is('design.kind', 'group_sequential'))),
      spending: gated(string({ values: [...VCR_SPENDING_FUNCTIONS], default: 'obrien_fleming' }), is('design.kind', 'group_sequential')),
      allocation: number({ ...PROBABILITY, default: 0.5 }),
      maxN: gated(integer({ min: 2, max: 500, default: 100 }), is('design.kind', 'simon_two_stage')),
    })),
    endpoint: req(ENDPOINT()),
    truth: req(object(truthFields({
      binaryWhen: [BINARY, isNot('design.kind', 'simon_two_stage')],
      simulated: false,
      extra: {
        nullRate: req(gated(number({ ...PROBABILITY }), is('design.kind', 'simon_two_stage'))),
        alternativeRate: req(gated(number({ ...PROBABILITY }), is('design.kind', 'simon_two_stage'))),
      },
    }), { exactlyOne: truthGroups([BINARY, isNot('design.kind', 'simon_two_stage')]) })),
    analysis: object({
      alpha: ALPHA,
      power: number({ ...PROBABILITY, default: 0.9 }),
      sided: integer({ min: 1, max: 2, default: 1 }),
    }),
    accrual: gated(object({
      duration: req(number({ min: 0, unit: 'time units' })),
      followup: req(number({ min: 0, unit: 'time units' })),
      dropoutAnnual: number({ min: 0, lt: 1, default: 0, unit: 'proportion per 12 time units' }),
    }), TIME_TO_EVENT),
  }),

  'design.simulate': object({ ...SIMULATE_FIELDS }),

  'design.grid': object({
    ...SIMULATE_FIELDS,
    designs: req(array(object({
      kind: string({ values: [...VCR_TRIAL_DESIGNS], badValueCode: 'design_unknown' }),
      nTreat: integer({ min: 1, max: 1_000_000 }),
      nControl: integer({ min: 1, max: 1_000_000 }),
      informationRates: array(number({ gt: 0, max: 1 }), { min: 2, max: 20, increasing: true, last: 1 }),
      spending: string({ values: [...VCR_SPENDING_FUNCTIONS] }),
    }), { min: 1, max: 50 })),
    truths: req(array(object({
      null: boolean(),
      effect: number(), sd: number({ gt: 0 }), baselineCorrelation: number({ gt: -1, lt: 1 }),
      controlRate: number({ ...PROBABILITY }), treatmentRate: number({ ...PROBABILITY }),
      riskDifference: number({ gt: -1, lt: 1 }), oddsRatio: number({ gt: 0 }), covariateLogit: number(),
      hazardRatio: number({ gt: 0 }), controlMedian: number({ gt: 0 }), controlDistribution: CONTROL_DISTRIBUTION,
    }), { min: 1, max: 50 })),
  }, { gridCells: 400 }),

  'design.assurance': object({
    design: req(object({
      allocation: number({ ...PROBABILITY, default: 0.5 }),
      events: req(gated(integer({ min: 1 }), TIME_TO_EVENT)),
      nTreat: req(gated(integer({ min: 1, max: 1_000_000 }), isNot('endpoint.type', 'time_to_event'))),
      nControl: gated(integer({ min: 1, max: 1_000_000 }), isNot('endpoint.type', 'time_to_event')),
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
})

/** Design × endpoint combinations each method implements; anything else is refused. */
export const VCR_DESIGN_SUPPORT = deepFreeze({
  'design.analytic': Object.freeze({
    two_arm_fixed: Object.freeze(['continuous', 'binary', 'time_to_event']),
    group_sequential: Object.freeze(['time_to_event']),
    simon_two_stage: Object.freeze(['binary']),
  }),
  'design.simulate': Object.freeze({
    two_arm_fixed: Object.freeze(['continuous', 'binary', 'time_to_event']),
    group_sequential: Object.freeze(['time_to_event']),
  }),
  'design.grid': Object.freeze({
    two_arm_fixed: Object.freeze(['continuous', 'binary', 'time_to_event']),
    group_sequential: Object.freeze(['time_to_event']),
  }),
  'design.assurance': Object.freeze({
    two_arm_fixed: Object.freeze(['continuous', 'binary', 'time_to_event']),
  }),
  'design.procova': Object.freeze({
    two_arm_fixed: Object.freeze(['continuous']),
  }),
})

// ---------------------------------------------------------------------------
// The null scenario
// ---------------------------------------------------------------------------

/**
 * Is this scenario a null one — no true effect? One predicate for the replicate
 * floor, the measure's name (`type_one_error` vs `power`) and the report; the R
 * engine mirrors it (`vcr_is_null_scenario`). An explicit `truth.null` wins;
 * otherwise it is derived from the effect the scenario states. A scenario that
 * states no effect at all is not null: it cannot be told.
 * @param {any} scenario
 */
export function vcrIsNullScenario(scenario) {
  const truth = scenario?.truth
  if (!truth || typeof truth !== 'object' || Array.isArray(truth)) return false
  if (typeof truth.null === 'boolean') return truth.null
  const type = scenario?.endpoint?.type
  const tiny = (/** @type {number} */ x) => Math.abs(x) < 1e-12
  const finite = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x)
  if (type === 'continuous') return finite(truth.effect) && tiny(truth.effect)
  if (type === 'time_to_event') return finite(truth.hazardRatio) && truth.hazardRatio > 0 && tiny(Math.log(truth.hazardRatio))
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
    if (!active(field)) continue
    if (Object.hasOwn(value, key) && value[key] === null) {
      // null is a value in canonical JSON, so it is refused rather than read as
      // "absent": the two would hash differently and mean the same.
      if (!field.nullable) raise(ctx, 'scenario_value_invalid', at(path, key), 'null is not a value; leave the key out.')
      else if (field.req) raise(ctx, 'scenario_field_missing', at(path, key), `${key} is required.`)
      continue
    }
    if (!present(value, key)) {
      if (field.req) raise(ctx, 'scenario_field_missing', at(path, key), `${key} is required.`)
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
      const cell = {
        ...scenario,
        design: { ...(isObject(scenario.design) ? scenario.design : {}), ...designs[d] },
        truth: { ...(isObject(scenario.truth) ? scenario.truth : {}), ...truths[t] },
      }
      delete cell.designs
      delete cell.truths
      /** @type {WalkContext} */
      const inner = { root: cell, inputIds: ctx.inputIds, issues: [], suppressExpression: true }
      checkObject(cellSchema, cell, '', inner)
      const first = inner.issues.find((issue) => issue.code !== 'scenario_field_unknown')
      if (first) {
        raise(ctx, 'scenario_value_invalid', first.field.startsWith('truth') ? atIndex('truths', t) : atIndex('designs', d),
          `Cell (${d}, ${t}) is not a valid scenario: ${first.code} at ${first.field}.`)
        return
      }
    }
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
