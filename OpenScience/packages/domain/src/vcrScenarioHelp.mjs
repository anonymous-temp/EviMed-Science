/**
 * What a model is given to write a 虚拟临研 scenario from: a rendering of the
 * schemas the validator enforces, never a second description of them.
 *
 * Hidden knowledge:
 *
 * - **A hand-typed description of a scenario drifts, and a model fills the gap
 *   with the key it would have named itself.** On 2026-10-04 a protocol run wrote
 *   `accrual.months`; the platform refused it by name (`vcr_scenario_unknown_fields`)
 *   and the next scenario was valid, so the refusal worked — what failed was
 *   what the run had been given to write from. The tool description listed the
 *   shapes by hand and gave `accrual?` no keys at all. So the keys, their types,
 *   units, ranges, defaults and gates are read out of `VCR_SCENARIO_SCHEMAS` here,
 *   once, and `scripts/build/generate-vcr-scenario-help.mjs` writes the result to
 *   `runtime/mcp/evimed-research/vcr_scenario_help.json`, which the runtime's
 *   `vcr_simulate` renders on request (`action: "shape"`). `--check` fails when
 *   the file is not what the schemas now say, the same arrangement as
 *   `check:skill-packages`.
 * - **Rows are flat, with paths, because a model reads a list better than a
 *   tree.** A row says where a key lives (`accrual.duration`, `controls[].name`),
 *   what it is, whether it is required (and, when its object is optional, that it
 *   is needed only once the object is given), the endpoint or design it is read
 *   for, and the variant it belongs to. Nothing is invented: a unit, a range or a
 *   default that the schema does not state is not in the row.
 * - **The coupled rules the walker applies are in the help too**: `exactlyOne`,
 *   `atLeastOne` and `requires` from the schema, the design × endpoint table
 *   (`VCR_DESIGN_SUPPORT`) and which analysis a design may run, read from the
 *   tables the validator reads.
 * - **The examples are checked, not trusted.** Each is run through
 *   `validateScenario` by the test; an example the validator refuses fails the
 *   build of the file.
 * - **A refusal can name the keys.** `vcrScenarioChildKeys` answers "what does
 *   the engine read inside `accrual`", from the same rows, so the sentence that
 *   refuses a key also lists the ones that are read.
 *
 * @module @evimed/domain/vcrScenarioHelp
 */

import { VCR_DESIGN_SUPPORT, VCR_SCENARIO_SCHEMAS, VCR_SINGLE_ARM_ANALYSIS_METHODS, VCR_TWO_ARM_ANALYSIS_METHODS, whenHolds } from './vcrScenarioSchemas.mjs'
import { VCR_ENGINE_METHODS, VCR_JOB_METHODS } from './vcrEngineJob.mjs'

/** The version of the file's own shape. */
export const VCR_SCENARIO_HELP_VERSION = 1

/**
 * The kinds whose scenario the platform builds, and the only keys a run states
 * for each. The gateway refuses any other key; the help says the same thing from
 * the same list. `match_criteria` takes none: the platform freezes the protocol's
 * own criteria and the facts written for the study.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const VCR_RUN_SCENARIO_FIELDS = Object.freeze({
  pool_evidence: Object.freeze(['parameter', 'endpointKey', 'calibres', 'armRole', 'target', 'method']),
  match_criteria: Object.freeze([]),
  accrual_forecast: Object.freeze(['target', 'eventTarget', 'eventHazard', 'byTimes']),
})

/**
 * @typedef {{ path: string, in?: string[], notIn?: string[], present?: boolean }} VcrHelpWhen
 * @typedef {{ on: string, is: string[], default?: string }} VcrHelpVariant
 * @typedef {{ path: string, type: string, required?: boolean, requiredWhen?: VcrHelpWhen[], within?: string, when?: VcrHelpWhen[],
 *   variant?: VcrHelpVariant, nullable?: boolean, default?: unknown, unit?: string, min?: number, max?: number, gt?: number, lt?: number,
 *   values?: string[], valuesBy?: { path: string, map: Record<string, string[]> }, minLength?: number, maxLength?: number, role?: string,
 *   count?: { min?: number, max?: number }, items?: Record<string, any>, of?: Record<string, any>, keysFrom?: string,
 *   increasing?: boolean, last?: number, unique?: boolean, size?: string }} VcrHelpRow
 * @typedef {{ kind: 'exactlyOne' | 'atLeastOne' | 'requires', keys?: string[], key?: string, needs?: string[], when?: VcrHelpWhen[], variant?: VcrHelpVariant }} VcrHelpRule
 */

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** @param {string} path @param {string} key */
const at = (path, key) => (path ? `${path}.${key}` : key)

/** @param {any} when @returns {any[]} */
const asList = (when) => (Array.isArray(when) ? when : when ? [when] : [])

/** A condition as plain data, in the schema's own closed language. @param {any} when @returns {VcrHelpWhen[]} */
const plainWhen = (when) => asList(when).map((condition) => ({
  path: condition.path,
  ...(Array.isArray(condition.in) ? { in: [...condition.in] } : {}),
  ...(Array.isArray(condition.notIn) ? { notIn: [...condition.notIn] } : {}),
  ...(typeof condition.present === 'boolean' ? { present: condition.present } : {}),
}))

/** Drop what is undefined, so a row says only what the schema says. @param {Record<string, any>} object */
function compact(object) {
  /** @type {Record<string, any>} */
  const out = {}
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value
  return out
}

/** What a node is, as a row's own words. @param {any} node @returns {Record<string, any>} */
function describe(node) {
  switch (node.t) {
    case 'number':
    case 'integer':
      return compact({ type: node.t, min: node.min, max: node.max, gt: node.gt, lt: node.lt, unit: node.unit, default: node.default })
    case 'boolean':
      return compact({ type: 'boolean', default: node.default })
    case 'string':
      return compact({
        type: 'string',
        values: Array.isArray(node.values) ? [...node.values] : undefined,
        valuesBy: node.valuesBy ? JSON.parse(JSON.stringify(node.valuesBy)) : undefined,
        minLength: node.minLength,
        maxLength: node.maxLength,
        role: node.pattern ? 'column' : node.ref === 'input' ? 'input id' : undefined,
        default: node.default,
      })
    case 'array':
      return compact({
        type: 'list',
        count: node.min !== undefined || node.max !== undefined ? compact({ min: node.min, max: node.max }) : undefined,
        items: node.items.t === 'object' || node.items.t === 'variant' ? { type: 'object' } : describe(node.items),
        increasing: node.increasing ? true : undefined,
        last: node.last,
        unique: node.unique ? true : undefined,
      })
    case 'object':
    case 'variant':
      return { type: 'object' }
    case 'map':
      return compact({
        type: 'map',
        of: describe(node.values),
        keysFrom: node.keysFrom,
        count: node.min !== undefined || node.max !== undefined ? compact({ min: node.min, max: node.max }) : undefined,
      })
    case 'matrix':
      return compact({ type: 'matrix', min: node.min, max: node.max, size: node.size })
    case 'rules':
      return { type: 'rules' }
    case 'rule':
      return { type: 'rule' }
    default:
      throw new TypeError(`vcrScenarioHelp: unknown node type ${node.t}`)
  }
}

/**
 * @typedef {{ when: VcrHelpWhen[], within: string | null, variant: VcrHelpVariant | null }} Context
 * @typedef {{ rows: VcrHelpRow[], rules: VcrHelpRule[] }} State
 */

/** @param {State} state @param {any} node @param {string} path @param {Context} context */
function emitRules(state, node, path, context) {
  const base = compact({ when: context.when.length ? context.when : undefined, variant: context.variant ?? undefined })
  for (const group of node.exactlyOne ?? []) {
    const keys = Array.isArray(group) ? group : group.keys
    const extra = Array.isArray(group) ? [] : plainWhen(group.when)
    state.rules.push(/** @type {VcrHelpRule} */ ({
      kind: 'exactlyOne', keys: keys.map((/** @type {string} */ key) => at(path, key)), ...base,
      ...(extra.length ? { when: [...context.when, ...extra] } : {}),
    }))
  }
  for (const keys of node.atLeastOne ?? []) {
    state.rules.push(/** @type {VcrHelpRule} */ ({ kind: 'atLeastOne', keys: keys.map((/** @type {string} */ key) => at(path, key)), ...base }))
  }
  for (const [key, needs] of Object.entries(node.requires ?? {})) {
    state.rules.push(/** @type {VcrHelpRule} */ ({ kind: 'requires', key: at(path, key), needs: /** @type {string[]} */ (needs).map((need) => at(path, need)), ...base }))
  }
}

/** @param {State} state @param {Record<string, any>} fields @param {string} prefix @param {Context} context */
function emitFields(state, fields, prefix, context) {
  for (const [key, field] of Object.entries(fields)) {
    emitRow(state, at(prefix, key), field, { ...context, when: [...context.when, ...plainWhen(field.when)] })
  }
}

/** The members of an object-like node: an object's fields, or a variant's. @param {State} state @param {any} node @param {string} path @param {Context} context */
function emitMembers(state, node, path, context) {
  if (node.t === 'object') {
    emitFields(state, node.fields, path, context)
    emitRules(state, node, path, context)
    return
  }
  // A variant: the discriminating key, then every key any variant reads, once. A key that two variants read
  // under the same definition is one row (belonging to both); one that differs between them is a row per definition.
  const names = Object.keys(node.variants)
  state.rows.push(/** @type {VcrHelpRow} */ (compact({
    path: at(path, node.on), type: 'string', values: names, default: node.default,
    required: node.default === undefined ? true : undefined,
    within: context.within ?? undefined, when: context.when.length ? context.when : undefined, variant: context.variant ?? undefined,
  })))
  /** @type {Map<string, Array<{ sig: string, field: any, names: string[] }>>} */
  const groups = new Map()
  for (const name of names) {
    for (const [key, field] of Object.entries(node.variants[name])) {
      const sig = JSON.stringify(field)
      const entries = groups.get(key) ?? []
      const found = entries.find((entry) => entry.sig === sig)
      if (found) found.names.push(name)
      else entries.push({ sig, field, names: [name] })
      groups.set(key, entries)
    }
  }
  for (const [key, entries] of groups) {
    for (const entry of entries) {
      const variant = entry.names.length === names.length
        ? context.variant
        : /** @type {VcrHelpVariant} */ (compact({ on: at(path, node.on), is: entry.names, default: node.default }))
      emitRow(state, at(path, key), entry.field, { ...context, when: [...context.when, ...plainWhen(entry.field.when)], variant })
    }
  }
  for (const [name, group] of Object.entries(node.variantGroups ?? {})) {
    emitRules(state, group, path, { ...context, variant: /** @type {VcrHelpVariant} */ (compact({ on: at(path, node.on), is: [name], default: node.default })) })
  }
}

/** @param {State} state @param {string} path @param {any} field @param {Context} context */
function emitRow(state, path, field, context) {
  const row = /** @type {VcrHelpRow} */ (compact({
    path,
    ...describe(field),
    required: field.req === true ? true : undefined,
    requiredWhen: field.reqWhen ? plainWhen(field.reqWhen) : undefined,
    within: context.within ?? undefined,
    when: context.when.length ? context.when : undefined,
    variant: context.variant ?? undefined,
    nullable: field.nullable === true ? true : undefined,
  }))
  state.rows.push(row)
  // What is inside an object that must be given is needed whenever the object's own ancestors are; inside an optional one,
  // only once it is given.
  const within = field.req === true ? context.within : path
  const inside = { when: context.when, within, variant: context.variant }
  if (field.t === 'object' || field.t === 'variant') emitMembers(state, field, path, inside)
  else if (field.t === 'array' && (field.items.t === 'object' || field.items.t === 'variant')) emitMembers(state, field.items, `${path}[]`, inside)
}

/**
 * Every key a method's scenario may carry, flattened, with the cross-field rules.
 * @param {string} method a key of `VCR_SCENARIO_SCHEMAS`
 * @returns {{ rows: VcrHelpRow[], rules: VcrHelpRule[] }}
 */
export function vcrScenarioRows(method) {
  const schema = /** @type {Record<string, any>} */ (VCR_SCENARIO_SCHEMAS)[method]
  if (!schema) throw new TypeError(`vcrScenarioHelp: no schema for ${method}`)
  /** @type {State} */
  const state = { rows: [], rules: [] }
  emitMembers(state, schema, '', { when: [], within: null, variant: null })
  return state
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

const AGE_RULE = { op: 'compare', column: 'age', comparator: 'gte', value: 18 }
const ADULT = [{ name: 'adult', rule: AGE_RULE }]

/**
 * One valid scenario per method, more where the endpoint changes which keys are read. Each is run through
 * `validateScenario` by the test, so an example cannot outlive the schema it shows.
 * @type {Readonly<Record<string, ReadonlyArray<{ label: string, scenario: Record<string, any> }>>>}
 */
export const VCR_SCENARIO_EXAMPLES = Object.freeze({
  'profile.snapshot': [{ label: 'nothing to state: the snapshot is the input', scenario: {} }],
  'cohort.build': [{ label: 'two inclusion steps on a subject table', scenario: {
    rules: [{ name: 'adult', rule: AGE_RULE }, { name: 'no prior therapy', rule: { op: 'any', operands: [{ op: 'missing', column: 'prior' }, { op: 'compare', column: 'prior', comparator: 'eq', value: false }] }, unknownAs: 'include' }],
    timeZero: { column: 'index_date' }, exit: { column: 'last_followup' } } }],
  'population.scenario': [{ label: 'three variables from stated distributions', scenario: {
    population: { variables: [
      { name: 'age', label: '年龄', family: 'normal', mean: 60, sd: 10, min: 18, max: 90 },
      { name: 'female', family: 'bernoulli', prob: 0.4 },
      { name: 'stage', family: 'categorical', probs: [0.5, 0.3, 0.2] }] },
    n: 500 } }],
  'population.literature': [{ label: 'a published baseline table', scenario: {
    baselineTable: [{ variable: 'age', label: '年龄', mean: 62, sd: 9 }, { variable: 'male', proportion: 0.55 }, { variable: 'ecog', proportions: [0.4, 0.5, 0.1], levels: ['0', '1', '2'] }], n: 400 } }],
  'population.synthpop': [{ label: 'a synthetic copy of the study table', scenario: { holdoutShare: 0.2, m: 5, constraints: [{ name: 'age', rule: { op: 'between', column: 'age', low: 18, high: 100 } }] } }],
  'population.quality': [{ label: 'a synthetic table against its training table', scenario: { trainingInputId: 'snp_1:subject', syntheticInputId: 'pop_synth@1' } }],
  'patients.continuous': [{ label: 'a continuous endpoint', scenario: {
    design: { nTreat: 60, nControl: 60 }, endpoint: { type: 'continuous' }, truth: { effect: -0.5, sd: 1.2 } } }],
  'patients.binary': [{ label: 'a binary endpoint', scenario: {
    design: { nTreat: 60, nControl: 60 }, endpoint: { type: 'binary' }, truth: { controlRate: 0.3, oddsRatio: 1.5 } } }],
  'patients.time_to_event': [{ label: 'a time-to-event endpoint with uniform accrual', scenario: {
    design: { nTreat: 100, nControl: 100 }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 12 },
    accrual: { duration: 12, followup: 12, dropoutAnnual: 0.1 } } }],
  'patients.longitudinal': [{ label: 'a continuous trajectory over five visits, random intercept and slope, 10% leaving per visit', scenario: {
    design: { nTreat: 150, nControl: 150 }, endpoint: { type: 'continuous' }, visits: [0, 3, 6, 9, 12],
    truth: { intercept: 50, slope: -0.4, effect: -0.2, sd: 3, randomEffects: { sdIntercept: 6, sdSlope: 0.3, correlation: -0.2 } },
    dropoutPerVisit: 0.1 } }],
  'evidence.pool': [{ label: 'three published log hazard ratios', scenario: {
    studies: [{ studyId: 'NCT001', estimate: -0.35, se: 0.12 }, { studyId: 'NCT002', estimate: -0.2, se: 0.15 }], method: 'random_effects_reml', scale: 'log' } }],
  'evidence.reconstruct_km': [{ label: 'one digitized arm and its risk table', scenario: {
    curve: [{ time: 0, surv: 1 }, { time: 12, surv: 0.55 }, { time: 24, surv: 0.3 }],
    riskTable: [{ time: 0, atRisk: 150 }, { time: 12, atRisk: 70 }, { time: 24, atRisk: 20 }],
    provenance: { kind: 'digitizer', tool: 'WebPlotDigitizer' } } }],
  'comparator.entropy_balance': [{ label: 'entropy balancing on three covariates', scenario: { covariates: ['age', 'ecog', 'ldh'], estimand: 'ATT' } }],
  'comparator.propensity_weight': [{ label: 'propensity weights for a binary endpoint', scenario: { covariates: ['age'], endpoint: { type: 'binary' }, estimand: 'ATO' } }],
  'comparator.rmst': [{ label: 'restricted mean survival time to 24 months', scenario: { tau: 24, treatmentColumn: 'arm', timeUnit: 'months' } }],
  'comparator.maic': [{ label: 'an unanchored indirect comparison on a binary outcome', scenario: {
    covariates: ['age', 'male'], targets: { age: 60, male: 0.5 }, endpoint: { type: 'binary' }, aggregateOutcome: 0.42, aggregateSe: 0.05, link: 'logit', outcomeColumn: 'response' } }],
  'comparator.evalue': [{ label: 'the E-value of a hazard ratio', scenario: { riskRatio: 0.6, confidenceLimit: 0.8, scale: 'hazard_ratio', rare: true } }],
  'comparator.map_prior': [{ label: 'a robust MAP prior from three historical control arms', scenario: {
    historical: { events: [12, 15, 9], n: [60, 70, 50] }, tauPrior: { kind: 'half_normal', scale: 0.5 }, components: 2, robustWeight: 0.2 } }],
  'design.analytic': [
    { label: 'two-arm time-to-event: accrual is an object of duration, followup and dropoutAnnual', scenario: {
      design: { kind: 'two_arm_fixed', allocation: 0.5 }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 12 },
      analysis: { alpha: 0.025, power: 0.9, sided: 1 }, accrual: { duration: 12, followup: 12, dropoutAnnual: 0.05 } } },
    { label: 'two-arm binary: no accrual', scenario: {
      design: { kind: 'two_arm_fixed' }, endpoint: { type: 'binary' }, truth: { controlRate: 0.3, treatmentRate: 0.45 }, analysis: { alpha: 0.025, power: 0.9 } } },
  ],
  'design.simulate': [
    { label: 'two-arm time-to-event with uniform accrual', scenario: {
      design: { kind: 'two_arm_fixed', nTreat: 150, nControl: 150 }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 12 },
      analysis: { method: 'logrank', alpha: 0.025, sided: 1 }, accrual: { kind: 'uniform', duration: 12, followup: 12, dropoutAnnual: 0.1 },
      performance: ['power', 'bias'], targetMcse: 0.005 } },
    { label: 'two-arm binary: no accrual', scenario: {
      design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'binary' }, truth: { controlRate: 0.3, treatmentRate: 0.5 }, analysis: { method: 'logistic' } } },
    { label: 'single arm, continuous: 40 patients against a historical mean of 50, one-sample t', scenario: {
      design: { kind: 'single_arm', n: 40 }, endpoint: { type: 'continuous' }, truth: { benchmark: 50, effect: 5, sd: 12 },
      analysis: { method: 'one_sample_t', alternative: 'greater', sided: 1, alpha: 0.025 }, performance: ['power', 'bias'] } },
    { label: 'single arm, time to event: 60 patients against a benchmark median of 12, one-sample log-rank', scenario: {
      design: { kind: 'single_arm', n: 60 }, endpoint: { type: 'time_to_event' }, truth: { controlMedian: 12, hazardRatio: 0.65 },
      accrual: { kind: 'uniform', duration: 12, followup: 12, dropoutAnnual: 0.05 },
      analysis: { method: 'one_sample_logrank', alternative: 'less', sided: 1, alpha: 0.025 }, performance: ['power', 'bias'] } },
  ],
  'design.grid': [{ label: 'two sample sizes against three true effects, binary', scenario: {
    design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'binary' }, truth: { controlRate: 0.3, treatmentRate: 0.45 },
    designs: [{ nTreat: 80, nControl: 80 }, { nTreat: 120, nControl: 120 }], truths: [{ treatmentRate: 0.3 }, { treatmentRate: 0.45 }, { treatmentRate: 0.6 }],
    performance: ['power'] } }],
  'design.assurance': [
    { label: 'assurance for a time-to-event design with a prior on the log hazard ratio', scenario: {
      design: { allocation: 0.5, events: 300 }, endpoint: { type: 'time_to_event' }, designPrior: { mean: -0.3, sd: 0.15 }, analysis: { alpha: 0.025, sided: 1 } } },
    { label: 'assurance of a group-sequential design: three looks, O\'Brien-Fleming spending, 300 events at the end', scenario: {
      design: { kind: 'group_sequential', allocation: 0.5, events: 300, informationRates: [0.4, 0.7, 1], spending: 'obrien_fleming' }, endpoint: { type: 'time_to_event' },
      designPrior: { mean: -0.3, sd: 0.15 }, analysis: { alpha: 0.025, sided: 1 } } },
  ],
  'design.procova': [{ label: 'PROCOVA on a continuous endpoint', scenario: {
    endpoint: { type: 'continuous' }, design: { allocation: 0.5 }, truth: { effect: 0.5, sd: 1 }, analysis: { alpha: 0.025, power: 0.9, sided: 2 }, prognostic: { rho: 0.6 } } }],
  'accrual.poisson_gamma': [{ label: 'two sites, a target and a horizon', scenario: {
    sites: [{ id: 'site_a', alpha: 2, beta: 4, startTime: 0 }, { id: 'site_b', alpha: 3, beta: 5, startTime: 3, enrolled: 4, exposureTime: 5 }],
    target: 120, byTimes: [6, 12, 18] } }],
  'matching.evaluate': [{ label: 'two criteria and their states', scenario: {
    criteria: [{ id: 'inc_1', kind: 'inclusion', type: 'diagnosis', state: 'satisfied' }, { id: 'exc_1', kind: 'exclusion', type: 'pregnancy', state: 'unknown' }] } }],
  'comparator.weighted_cox': [{ label: 'a weighted Cox comparison to 24 months', scenario: {
    covariates: ['age', 'male'], treatmentColumn: 'arm', tau: 24, timeUnit: 'months', endpoint: { type: 'time_to_event' }, cohortRules: ADULT } }],
  'comparator.maic_time_to_event': [{ label: 'unanchored, against a reconstruction', scenario: {
    covariates: ['age', 'male'], targets: { age: 60, male: 0.5 }, timeUnit: 'months', pseudoIpdInputId: 'rec_1:1' } }],
  'comparator.aipw': [{ label: 'doubly robust, binary outcome', scenario: {
    covariates: ['age', 'male'], treatmentColumn: 'arm', outcomeColumn: 'response', endpoint: { type: 'binary' } } }],
  'comparator.covariate_sets': [{ label: 'two covariate sets under entropy balancing', scenario: {
    covariateSets: [{ name: 'primary', covariates: ['age', 'male'] }, { name: 'without sex', covariates: ['age'] }], endpoint: { type: 'binary' } } }],
  'comparator.negative_control': [{ label: 'two negative-control outcomes that are columns', scenario: {
    covariates: ['age', 'ecog'], weighting: 'propensity', estimand: 'ATE', effectScale: 'log_odds_ratio',
    controls: [{ name: 'fracture', column: 'fracture' }, { name: 'cataract', column: 'cataract' }], primary: { column: 'death' } } }],
  'comparator.tipping_point': [
    { label: 'binary, two arms, from counts', scenario: {
      endpoint: { type: 'binary' }, design: { kind: 'two_arm' },
      counts: { treatment: { n: 60, responders: 36, missing: 6 }, control: { n: 60, responders: 22, missing: 8 } },
      analysis: { method: 'fisher_exact', alpha: 0.025, sided: 1 } } },
    { label: 'time to event, delta-adjusted', scenario: {
      endpoint: { type: 'time_to_event' }, horizon: 24, treatmentColumn: 'arm', deltas: [1, 1.5, 2, 4], deltaApplies: 'both_opposite', direction: 'against_treatment', timeUnit: 'months' } },
  ],
  'comparator.prognostic_adjustment': [{ label: 'binary endpoint with a prognostic score column', scenario: {
    endpoint: { type: 'binary' }, prognosticScoreColumn: 'prognostic_score', treatmentColumn: 'arm', outcomeColumn: 'response', covariates: ['age', 'stratum'] } }],
})

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/**
 * The design × endpoint table and the analysis each design may run, as the notes a design method's help carries. Read
 * from the tables the validator reads, never typed again.
 * @param {string} method @returns {string[]}
 */
function designNotes(method) {
  const support = /** @type {Record<string, Record<string, readonly string[]>>} */ (VCR_DESIGN_SUPPORT)[method]
  if (!support) return []
  const notes = [`design.kind × endpoint.type this method implements: ${Object.entries(support).map(([design, endpoints]) => `${design} (${endpoints.join('|')})`).join('; ')}. Any other pairing is refused (design_not_supported).`]
  if (method === 'design.simulate' || method === 'design.grid') {
    notes.push(`analysis.method for a two-arm design follows the endpoint: ${Object.entries(VCR_TWO_ARM_ANALYSIS_METHODS).map(([endpoint, methods]) => `${endpoint} ${methods.join('|')}`).join('; ')}.`)
    notes.push(`A single-arm design runs the analysis of its endpoint: ${Object.entries(VCR_SINGLE_ARM_ANALYSIS_METHODS).map(([design, byEndpoint]) => `${design} ${Object.entries(byEndpoint).map(([endpoint, analyses]) => `${endpoint} ${analyses.join('|')}`).join(', ')}`).join('; ')}.`)
    notes.push('A single-arm trial of a mean or a survival time is compared with a fixed benchmark: truth.benchmark is the historical mean (continuous), truth.controlMedian or truth.controlDistribution the benchmark survival, and truth.effect (the true mean minus the benchmark) or truth.hazardRatio (the trial\'s hazard over the benchmark\'s) is the effect, 0 or 1 for the null. analysis.alternative describes that parameter: for a time-to-event endpoint less is a benefit (a hazard below the benchmark\'s) and greater is harm.')
  }
  return notes
}

/** The file's rendering of one method. @param {string} method */
function methodEntry(method) {
  const { rows, rules } = vcrScenarioRows(method)
  const schema = /** @type {Record<string, any>} */ (VCR_SCENARIO_SCHEMAS)[method]
  const spec = /** @type {Record<string, any>} */ (VCR_ENGINE_METHODS)[method]
  const notes = designNotes(method)
  return compact({
    endpoints: [...spec.endpoints],
    designs: /** @type {Record<string, any>} */ (VCR_DESIGN_SUPPORT)[method] ? JSON.parse(JSON.stringify(/** @type {Record<string, any>} */ (VCR_DESIGN_SUPPORT)[method])) : undefined,
    gridCells: schema.gridCells,
    notes: notes.length ? notes : undefined,
    rows,
    rules: rules.length ? rules : undefined,
    examples: (/** @type {Record<string, any>} */ (VCR_SCENARIO_EXAMPLES)[method] ?? []).map((/** @type {any} */ example) => JSON.parse(JSON.stringify(example))),
  })
}

/**
 * The whole help: every job kind and the method it runs, and for every method the keys its scenario reads. This
 * is what `runtime/mcp/evimed-research/vcr_scenario_help.json` holds.
 * @returns {Record<string, any>}
 */
export function vcrScenarioHelp() {
  /** @type {Record<string, any>} */
  const kinds = {}
  for (const [kind, method] of Object.entries(VCR_JOB_METHODS)) {
    const platform = /** @type {Record<string, readonly string[]>} */ (VCR_RUN_SCENARIO_FIELDS)[kind]
    kinds[kind] = platform ? { method, platformBuilt: [...platform] } : { method }
  }
  /** @type {Record<string, any>} */
  const methods = {}
  for (const method of Object.keys(VCR_ENGINE_METHODS)) methods[method] = methodEntry(method)
  return {
    schemaVersion: VCR_SCENARIO_HELP_VERSION,
    description: 'Generated by scripts/build/generate-vcr-scenario-help.mjs from packages/domain/src/vcrScenarioSchemas.mjs (the schemas the validator and the engine enforce) and the examples in packages/domain/src/vcrScenarioHelp.mjs. Do not edit by hand: change the schema, then run `pnpm generate:vcr-scenario-help`.',
    kinds,
    methods,
  }
}

// ---------------------------------------------------------------------------
// What is read inside a node: for a sentence that refuses a key
// ---------------------------------------------------------------------------

/** @type {Map<string, VcrHelpRow[]>} */
const rowsByMethod = new Map()
/** @param {string} method */
function rowsOf(method) {
  let rows = rowsByMethod.get(method)
  if (!rows) { rows = vcrScenarioRows(method).rows; rowsByMethod.set(method, rows) }
  return rows
}

/**
 * The node a path lives in: its dotted parent, with a list index read as the list's item (`cohortRules[2].foo` →
 * `cohortRules[]`). The empty string is the scenario itself.
 * @param {string} path
 */
export function vcrScenarioParentOf(path) {
  const normal = path.replace(/\[\d+\]/g, '[]')
  const cut = normal.lastIndexOf('.')
  return cut < 0 ? '' : normal.slice(0, cut)
}

/**
 * The keys the engine reads directly inside a node, over one or more methods (a scenario that is planned as two jobs is
 * read by both): `[]` for a node no method has. With the scenario itself as `root`, a key whose endpoint or design gate does
 * not hold for it is left out — the engine would refuse it there.
 * @param {readonly string[]} methods method ids @param {string} node `''` for the scenario's own keys, `accrual`, `cohortRules[]` …
 * @param {Record<string, any>} [root]
 * @returns {Array<{ key: string, required: boolean, variant: string[] | null }>}
 */
export function vcrScenarioChildKeys(methods, node, root) {
  const normal = node.replace(/\[\d+\]/g, '[]')
  /** @type {Map<string, { key: string, required: boolean, variant: string[] | null }>} */
  const found = new Map()
  for (const method of methods) {
    if (!Object.hasOwn(VCR_SCENARIO_SCHEMAS, method)) continue
    for (const row of rowsOf(method)) {
      if (vcrScenarioParentOf(row.path) !== normal) continue
      if (root && row.when && !whenHolds(row.when, root)) continue
      const key = row.path.slice(normal ? normal.length + 1 : 0)
      const entry = found.get(key)
      const variant = row.variant ? [...row.variant.is] : null
      if (!entry) found.set(key, { key, required: row.required === true, variant })
      else {
        entry.required = entry.required || row.required === true
        entry.variant = entry.variant && variant ? [...new Set([...entry.variant, ...variant])] : null
      }
    }
  }
  return [...found.values()]
}
