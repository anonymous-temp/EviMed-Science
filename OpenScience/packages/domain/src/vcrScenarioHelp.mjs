/**
 * What a model is given to write a 虚拟临床研究 scenario from: a rendering of the
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
 *   `atLeastOne`, `requires` and `lengthRules` from the schema, the design × endpoint table
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
import { VCR_LONGITUDINAL_SCHEMAS } from './vcrLongitudinal.mjs'
import { vcrSynthpopHelpNotes } from './vcrSynthesisLimits.mjs'

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
  pool_evidence: Object.freeze(['parameter', 'endpointKey', 'calibres', 'armRole', 'target', 'method', 'tauPrior']),
  match_criteria: Object.freeze([]),
  // The batch reading of records takes a selection and no scenario: the platform freezes the roster, the questions and the estimate.
  match_extract: Object.freeze([]),
})

/**
 * @typedef {{ path: string, in?: string[], notIn?: string[], present?: boolean }} VcrHelpWhen
 * @typedef {{ on: string, is: string[], default?: string }} VcrHelpVariant
 * @typedef {{ path: string, type: string, required?: boolean, requiredWhen?: VcrHelpWhen[], within?: string, when?: VcrHelpWhen[],
 *   variant?: VcrHelpVariant, nullable?: boolean, default?: unknown, unit?: string, min?: number, max?: number, gt?: number, lt?: number,
 *   values?: string[], valuesBy?: { path: string, map: Record<string, string[]> }, minLength?: number, maxLength?: number, role?: string,
 *   count?: { min?: number, max?: number }, items?: Record<string, any>, of?: Record<string, any>, keysFrom?: string,
 *   increasing?: boolean, nondecreasing?: boolean, last?: number, unique?: boolean, size?: string }} VcrHelpRow
 * @typedef {{ kind: 'exactlyOne' | 'atLeastOne' | 'requires' | 'lengthRule', keys?: string[], key?: string, needs?: string[], of?: string, plus?: number, when?: VcrHelpWhen[], variant?: VcrHelpVariant }} VcrHelpRule
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
        nondecreasing: node.nondecreasing ? true : undefined,
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
  for (const rule of node.lengthRules ?? []) {
    state.rules.push(/** @type {VcrHelpRule} */ ({ kind: 'lengthRule', key: at(path, rule.key), of: at(path, rule.of), plus: rule.plus ?? 0, ...base }))
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
  'model.survival_fit': [{ label: 'Fit a Weibull baseline to a selected right-censored endpoint', scenario: { inputId: 'snp_example', idColumn: 'USUBJID', timeColumn: 'AVAL', statusColumn: 'CNSR', statusEncoding: 'censor', distribution: 'weibull', timeUnit: 'months', horizons: [6, 12, 24] } }],
  'model.prognostic_apply': [{ label: 'Apply a source-bound logistic equation; illustrative coefficients only', scenario: { inputId: 'snp_example', idColumn: 'USUBJID', sourceCondition: 'control', endpoint: { type: 'binary', horizon: 12, timeUnit: 'months' }, inputUnits: { age: 'years' }, model: { family: 'logistic', intercept: -3, terms: [{ column: 'age', coefficient: 0.02, transform: 'identity', unit: 'years', center: 50, scale: 1 }] } } }],
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
  'population.synthpop': [{ label: 'a synthetic copy of the study table', scenario: { holdoutShare: 0.2, m: 5, constraints: [{ name: 'age', rule: { op: 'between', column: 'age', low: 18, high: 100 } }] } },
    { label: 'a synthetic copy that is asked how often its hazard ratio is a false positive, and which records are easiest to recognise', scenario: { holdoutShare: 0.2, m: 5,
      analyses: [{ name: 'hazard ratio of the arm', kind: 'cox', time: 'os_months', status: 'death', predictors: ['arm', 'age'], target: 'arm' }],
      inference: { nullCalibration: { analysis: 'hazard ratio of the arm', replicates: 100 } }, privacy: { membershipRiskBound: 0.75 } } }],
  'population.quality': [{ label: 'a synthetic table against its training table', scenario: { trainingInputId: 'snp_1:subject', syntheticInputId: 'pop_synth@1' } },
    { label: 'a synthetic table with a survival analysis combined over its copies, and the per-record privacy', scenario: { trainingInputId: 'snp_1:subject', syntheticInputId: 'pop_synth@1', holdoutInputId: 'snp_1:holdout',
      analyses: [{ name: 'log-rank of the arm', kind: 'logrank', time: 'os_months', status: 'death', group: 'arm' }, { name: 'restricted mean at 24 months', kind: 'rmst', time: 'os_months', status: 'death', group: 'arm', tau: 24 }],
      privacy: { membershipRiskBound: 0.75, secrets: ['sex'] } } }],
  'model.prognostic_train': [{ label: 'a survival prognostic model trained on the historical control arm of a table, five folds', scenario: {
    inputId: 'snp_1:subject', idColumn: 'USUBJID', sourceCondition: 'control', armColumn: 'arm', armValue: 'control',
    endpoint: { type: 'time_to_event', timeColumn: 'os_months', statusColumn: 'death', horizon: 24, timeUnit: 'months' },
    predictors: [{ column: 'age', unit: 'years' }, { column: 'ecog', unit: 'category' }, { column: 'ldh', unit: 'U/L', transform: 'log' }], folds: 5 } },
    { label: 'a continuous change score, with the discounts the savings table is computed under', scenario: {
      inputId: 'snp_1:subject', idColumn: 'USUBJID', sourceCondition: 'natural_history',
      endpoint: { type: 'continuous', outcomeColumn: 'change_score', horizon: 18, timeUnit: 'months' },
      predictors: [{ column: 'baseline_score', unit: 'points' }, { column: 'age', unit: 'years' }], folds: 5,
      procova: { lambdas: [1, 0.9, 0.5], gammas: [1, 1.1], allocation: 0.5 } } }],
  'patients.progression': [{ label: 'linear progression of a score, 25% slower under treatment, power of the change at 18 months (every number says where it came from)', scenario: {
    endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 150, nControl: 150 }, timeUnit: 'months', visits: [0, 6, 12, 18],
    model: { family: 'linear', slope: { value: 0.12, basis: 'literature', citation: 'a published progression model, its placebo slope' }, betweenPersonSd: { value: 0.08, basis: 'literature', citation: 'the same model, its between-person SD of the slope' } },
    baseline: { mean: { value: 3, basis: 'data' }, sd: { value: 1.2, basis: 'data' } }, residualSd: { value: 0.7, basis: 'literature', citation: 'the same model, its residual SD' },
    treatment: { slowing: { value: 0.25, basis: 'assumed' } }, analysis: { kind: 'change', visit: 18 } } },
    { label: 'a saturating (Emax) progression, tested by the per-person slope', scenario: {
      endpoint: { type: 'continuous' }, design: { nTreat: 100, nControl: 100 }, timeUnit: 'months', visits: [0, 3, 6, 12, 18, 24],
      model: { family: 'emax', amplitude: { value: 4, basis: 'literature', citation: 'a published saturating model' }, betweenPersonSd: { value: 1.5, basis: 'literature' }, halfTime: { value: 12, basis: 'literature' } },
      baseline: { mean: { value: 20, basis: 'data' }, sd: { value: 4, basis: 'data' } }, residualSd: { value: 1, basis: 'literature' }, correlation: { value: 0.2, basis: 'assumed' },
      treatment: { slowing: { value: 0.3, basis: 'assumed' } }, analysis: { kind: 'slope' } } },
    { label: 'mild to moderate Alzheimer disease on ADAS-cog 11 (the CAMD model with its released parameters): a hypothetical drug 2.5 points better at week 24 plus 30% slower decline, 78 weeks, 200 per arm', scenario: {
      endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 200, nControl: 200 }, timeUnit: 'weeks', visits: [0, 13, 26, 39, 52, 65, 78],
      model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' }, uncertainty: 'new_study' },
      population: { mmseRange: { value: [16, 26], basis: 'assumed' } },
      treatment: { symptomatic: { pointsAt: { value: -2.5, basis: 'assumed' }, atWeek: 24, referenceAdas: 25, et50Weeks: { value: 1, basis: 'assumed' } },
        diseaseModifying: { fraction: { value: 0.3, basis: 'assumed' } } },
      analysis: { kind: 'change', visit: 78 } } },
    { label: 'the same trial with the symptomatic effect stated as a distribution instead of one number (the result is an assurance: the chance of a significant benefit averaged over what the effect might be)', scenario: {
      endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 200, nControl: 200 }, timeUnit: 'weeks', visits: [0, 13, 26, 39, 52, 65, 78],
      model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' }, uncertainty: 'new_study' },
      treatment: { symptomatic: { atWeek: 24, referenceAdas: 25, et50Weeks: { value: 1, basis: 'assumed' },
        pointsAt: { distribution: { family: 'normal', parameters: { mean: -2, sd: 1 }, source: { kind: 'literature', citation: 'a published estimate of the effect in points, its mean and SD' }, tier: 'A' } } } },
      analysis: { kind: 'change', visit: 78 } } },
    { label: 'donepezil 10 mg a day as the treated arm (the posterior\'s own fitted effect, with its parameter uncertainty), 26 weeks, 150 per arm', scenario: {
      endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 150, nControl: 150 }, timeUnit: 'weeks', visits: [0, 13, 26],
      model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' }, uncertainty: 'posterior_draws' },
      treatment: { reference: { drug: 'donepezil', doseMg: 10 } }, analysis: { kind: 'change', visit: 26 } } },
    { label: 'aducanumab titrated to 10 mg/kg every 4 weeks, effect on ADAS-cog 11 at week 78 through the published exposure, amyloid and clinical chain (an assurance that holds only if the chain holds)', scenario: {
      endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 300, nControl: 300 }, timeUnit: 'weeks', visits: [0, 26, 52, 78],
      model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' }, uncertainty: 'new_study' },
      treatment: { mechanism: { drug: 'aducanumab', regimen: { maintenanceMgPerKg: 10, titrationMgPerKg: [1, 1, 3, 3, 6, 6], intervalWeeks: 4 }, atWeek: 78 } },
      analysis: { kind: 'change', visit: 78 } } }],
  'population.check': [{ label: 'a generated population against a second, independent baseline table (the platform fills `generated` from the population subjectId names)', scenario: {
    baselineTable: [{ variable: 'age', mean: 63, sd: 10 }, { variable: 'male', proportion: 0.58 }], referenceN: 412 } }],
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
    dropoutPerVisit: 0.1 } },
    { label: 'the same, with dropout that depends on the previous value (people doing worse leave sooner), a rescue medication that 6% start before each visit and a trajectory that levels off', scenario: {
      design: { nTreat: 150, nControl: 150 }, endpoint: { type: 'continuous' }, visits: [0, 3, 6, 9, 12],
      truth: { intercept: 50, slope: -0.4, effect: -0.2, sd: 3, randomEffects: { sdIntercept: 6, sdSlope: 0.3, correlation: -0.2 } },
      dropoutPerVisit: 0.1, dropoutModel: { mechanism: 'mar', logOddsPerSd: 1 }, rescue: { perVisit: 0.06, effect: -3, logOddsPerSd: 1 }, trajectory: { kind: 'plateau', halfTime: 4 } } }],
  'evidence.pool': [
    { label: 'two published log hazard ratios', scenario: {
      studies: [{ studyId: 'NCT001', estimate: -0.35, se: 0.12 }, { studyId: 'NCT002', estimate: -0.2, se: 0.15 }], method: 'random_effects_reml', scale: 'log' } },
    { label: 'the same two studies with the Cochrane reference for how much trials of one comparison differ (all-cause mortality, drug against placebo): a prediction interval from two studies', scenario: {
      studies: [{ studyId: 'NCT001', estimate: -0.35, se: 0.12 }, { studyId: 'NCT002', estimate: -0.2, se: 0.15 }], method: 'random_effects_reml', scale: 'log',
      tauPrior: { kind: 'turner_2015', outcome: 'all_cause_mortality', comparison: 'pharmacological_vs_placebo' } } },
  ],
  'evidence.network': [
    { label: 'three treatments compared by odds ratio from arm counts, one three-arm study; a higher response is better', scenario: {
      label: 'response', measure: 'odds_ratio', direction: 'higher_better', reference: 'A', studies: [
        { studyId: 'S1', arms: [{ treatment: 'A', events: 12, n: 100 }, { treatment: 'B', events: 20, n: 98 }] },
        { studyId: 'S2', arms: [{ treatment: 'A', events: 9, n: 80 }, { treatment: 'C', events: 18, n: 82 }, { treatment: 'B', events: 15, n: 79 }] },
        { studyId: 'S3', arms: [{ treatment: 'B', events: 22, n: 110 }, { treatment: 'C', events: 30, n: 112 }] }] } },
    { label: 'hazard ratios published as comparisons: a three-arm trial states every pair of its arms', scenario: {
      measure: 'log_ratio', direction: 'lower_better', studies: [
        { studyId: 'H1', contrasts: [{ treatment: 'B', comparator: 'A', effect: -0.3, se: 0.12 }] },
        { studyId: 'H2', contrasts: [{ treatment: 'C', comparator: 'A', effect: -0.5, se: 0.2 }, { treatment: 'C', comparator: 'B', effect: -0.2, se: 0.2 }, { treatment: 'B', comparator: 'A', effect: -0.3, se: 0.15 }] },
        { studyId: 'H3', contrasts: [{ treatment: 'C', comparator: 'B', effect: -0.15, se: 0.18 }] }] } },
  ],
  'evidence.dose_response': [
    { label: 'a log-linear dose-response of two cohorts reporting incidence rates (the reference level states an effect of 0 and no standard error)', scenario: {
      label: 'alcohol and colorectal cancer', doseUnit: 'g/day', ratioKind: 'relative_risk', model: { kind: 'linear' }, perDose: 12, studies: [
        { studyId: 'K1', type: 'ir', rows: [{ dose: 0, effect: 0, cases: 120, n: 40000 }, { dose: 10, effect: 0.10, se: 0.12, cases: 80, n: 25000 }, { dose: 25, effect: 0.30, se: 0.14, cases: 60, n: 15000 }] },
        { studyId: 'K2', type: 'ir', rows: [{ dose: 0, effect: 0, cases: 90, n: 30000 }, { dose: 12, effect: 0.05, se: 0.15, cases: 70, n: 22000 }, { dose: 30, effect: 0.35, se: 0.17, cases: 45, n: 12000 }] }] } },
    { label: 'a restricted cubic spline with knots at the 10th, 50th and 90th percentiles of the doses, and the ratios at chosen doses against a dose of 0', scenario: {
      model: { kind: 'spline', knotPercentiles: [0.1, 0.5, 0.9] }, predictAt: [0, 10, 20, 30], referenceDose: 0, studies: [
        { studyId: 'K1', type: 'ir', rows: [{ dose: 0, effect: 0, cases: 120, n: 40000 }, { dose: 10, effect: 0.10, se: 0.12, cases: 80, n: 25000 }, { dose: 25, effect: 0.30, se: 0.14, cases: 60, n: 15000 }, { dose: 40, effect: 0.5, se: 0.2, cases: 30, n: 6000 }] },
        { studyId: 'K2', type: 'ir', rows: [{ dose: 0, effect: 0, cases: 90, n: 30000 }, { dose: 12, effect: 0.05, se: 0.15, cases: 70, n: 22000 }, { dose: 30, effect: 0.35, se: 0.17, cases: 45, n: 12000 }, { dose: 45, effect: 0.6, se: 0.22, cases: 25, n: 5000 }] }] } },
  ],
  'evidence.shrinkage': [
    { label: 'a phase 2 hazard ratio of 0.66 (the standard error of its log is 0.19), and a phase 3 that will measure the effect with a standard error of 0.12', scenario: {
      label: 'phase 2 hazard ratio', scale: 'log', values: [{ id: 'phase2', estimate: -0.4155, se: 0.19, futureSe: 0.12 }] } },
  ],
  'decision.value_of_information': [
    { label: 'whether to run a 150, 300 or 450 per arm phase 3 (or none): the effect, the standard deviation and the dropout are uncertain, the net benefit is the value of success less the cost of the people, and one phase 2 of 80 per arm is asked about', scenario: {
      label: 'phase 3 size', source: 'two_arm_continuous', utility: 'net_benefit', successValue: 400, costPerPatient: 0.2, unit: '百万元',
      options: [{ label: 'no_trial', nPerArm: 0 }, { label: 'n150', nPerArm: 150 }, { label: 'n300', nPerArm: 300 }, { label: 'n450', nPerArm: 450 }],
      inputs: { effect: { family: 'normal', mean: 1.2, sd: 0.8 }, sd: { family: 'lognormal', meanlog: 1.95, sdlog: 0.12 }, dropoutShare: { family: 'beta', alpha: 4, beta: 16 } },
      studies: [{ label: 'phase 2, 80 per arm', kind: 'phase2_effect', size: 80 }] } },
    { label: 'an effect that is a share of the control arm\'s worsening, with the share given only as optimistic, base and pessimistic values (a threshold is reported, never a probability), the control worsening uncertain, and a natural-history cohort of 200', scenario: {
      source: 'two_arm_continuous', utility: 'success_probability', effectScale: 'proportional_slowing',
      options: [{ label: 'n200', nPerArm: 200 }, { label: 'n400', nPerArm: 400 }],
      inputs: { effect: { family: 'range', optimistic: 0.35, base: 0.25, pessimistic: 0.1 }, sd: { family: 'fixed', value: 7 }, controlProgression: { family: 'lognormal', meanlog: 0.9, sdlog: 0.3 } },
      studies: [{ label: 'natural-history cohort of 200', kind: 'natural_history_control', size: 200 }] } },
  ],
  'pk.interaction': [
    { label: 'a 3 mg oral midazolam dose 12 hours after the last of seven daily 75 mg rifampicin doses, over 48 hours, in an 80 kg adult', scenario: {
      label: 'midazolam after rifampicin', victim: { drug: 'midazolam', doseMg: 3 }, perpetrator: { drug: 'rifampicin', doseMg: 75, doses: 7 } } },
    { label: 'the same victim as a 30-minute intravenous infusion of 2 mg after 600 mg rifampicin daily for ten days, a 70 kg adult', scenario: {
      victim: { drug: 'midazolam', doseMg: 2, route: 'iv', infusionH: 0.5 }, perpetrator: { drug: 'rifampicin', doseMg: 600, doses: 10, gapH: 24 }, weightKg: 70 } },
  ],
  'evidence.reconstruct_km': [{ label: 'one digitized arm and its risk table', scenario: {
    curve: [{ time: 0, surv: 1 }, { time: 12, surv: 0.55 }, { time: 24, surv: 0.3 }],
    riskTable: [{ time: 0, atRisk: 150 }, { time: 12, atRisk: 70 }, { time: 24, atRisk: 20 }],
    provenance: { kind: 'digitizer', tool: 'WebPlotDigitizer' } } }],
  'comparator.entropy_balance': [{ label: 'entropy balancing on three covariates', scenario: { covariates: ['age', 'ecog', 'ldh'], estimand: 'ATT' } }],
  'comparator.propensity_weight': [
    { label: 'propensity weights for a binary endpoint', scenario: { covariates: ['age'], endpoint: { type: 'binary' }, estimand: 'ATO' } },
    { label: 'the same weights after removing the people with no comparable counterpart (Crump\'s rule: no bound to choose)', scenario: { covariates: ['age', 'ecog'], endpoint: { type: 'binary' }, trim: { rule: 'crump' } } },
    { label: 'the same weights when some covariates are missing: impute them 20 times and read the answer by Rubin\'s rules, the complete-case answer beside it', scenario: { covariates: ['age', 'ecog'], endpoint: { type: 'binary' }, imputation: { m: 20 } } },
  ],
  'comparator.rmst': [{ label: 'restricted mean survival time to 24 months', scenario: { tau: 24, treatmentColumn: 'arm', timeUnit: 'months' } }],
  'comparator.maic': [{ label: 'an unanchored indirect comparison on a binary outcome: the aggregate trial\'s response rate is 0.42 (standard error 0.05), on the logit link', scenario: {
    covariates: ['age', 'male'], targets: { age: 60, male: 0.5 }, endpoint: { type: 'binary' }, aggregateOutcome: 0.42, aggregateSe: 0.05, link: 'logit', outcomeColumn: 'response' } }],
  'comparator.evalue': [{ label: 'the E-value of a hazard ratio', scenario: { riskRatio: 0.6, confidenceLimit: 0.8, scale: 'hazard_ratio', rare: true } }],
  'comparator.bias_analysis': [
    { label: 'how large a bias, and what confounder, turns a hazard ratio of 0.70 (95% interval 0.50 to 0.98): the tipping bias and the tipping confounder', scenario: {
      scale: 'hazard_ratio', estimate: 0.7, lower: 0.5, upper: 0.98 } },
    { label: 'the same estimate tested against stated biases (the shifted null), with a probabilistic analysis of a confounder that is twice as common in the treated', scenario: {
      scale: 'hazard_ratio', estimate: 0.7, lower: 0.5, upper: 0.98, shiftedNull: { biases: [1.1, 1.25, 1.5] },
      probabilistic: { confounder: { exposedPrevalence: { family: 'triangular', min: 0.3, mode: 0.4, max: 0.5 },
        unexposedPrevalence: { family: 'triangular', min: 0.1, mode: 0.2, max: 0.3 }, association: { family: 'lognormal', median: 1.8, sdlog: 0.2 } } } } },
  ],
  'comparator.target_trial': [
    { label: 'a sequence of emulated trials from a person-period table: the intention-to-treat and per-protocol risk difference after 24 months, with stabilised weights for the treatment received', scenario: { covariates: ['age', 'ecog'], strategy: { kind: 'sequential', estimand: 'both' }, horizon: 24, timeUnit: 'months' } },
    { label: 'clone-censor-weight for starting treatment within three periods of diagnosis against never starting, after twelve periods', scenario: { covariates: ['age', 'ecog'], strategy: { kind: 'clone_censor_weight', gracePeriod: 3 }, horizon: 12 } },
  ],
  'comparator.stc': [{ label: 'an anchored comparison on a binary outcome: the aggregate trial\'s log odds ratio against the common comparator is -0.35 (standard error 0.12)', scenario: {
    covariates: ['age', 'male'], effectModifiers: ['age'], aggregateCovariates: [{ variable: 'age', mean: 62, sd: 9 }, { variable: 'male', proportion: 0.55 }],
    endpoint: { type: 'binary' }, anchored: true, aggregateEstimate: -0.35, aggregateSe: 0.12, outcomeColumn: 'response' } }],
  'comparator.borrowing': [
    { label: 'the external control counts for 0.3 of a patient each: a power prior on a response rate (90 of 300 historically, 40 of 150 now, 100 of 300 on treatment)', scenario: {
      endpoint: { type: 'binary' }, historical: { responders: 90, n: 300 }, current: { responders: 40, n: 150 }, treatment: { responders: 100, n: 300 }, prior: { kind: 'power', a0: 0.3 } } },
    { label: 'borrowing decided by the data: a self-adapting mixture prior, a difference of 0.1 in the response rate being too much to borrow across, and what it does to the type I error and power if the true control rate drifts', scenario: {
      endpoint: { type: 'binary' }, historical: { responders: 90, n: 300 }, prior: { kind: 'sam', delta: 0.1 },
      operatingCharacteristics: { nControl: 150, nTreatment: 300, drifts: [-0.1, -0.05, 0, 0.05, 0.1], effect: 0.1 } } },
    { label: 'how a conflict becomes a level of borrowing: an elastic prior on a mean (historical mean 10, sd 4, 120 patients; 60 now, mean 11), a difference of 2 being a conflict', scenario: {
      endpoint: { type: 'continuous' }, historical: { mean: 10, sd: 4, n: 120 }, current: { mean: 11, n: 60 }, prior: { kind: 'elastic', delta: 2 } } },
  ],
  'comparator.map_prior': [{ label: 'a robust MAP prior from three historical control arms', scenario: {
    historical: { events: [12, 15, 9], n: [60, 70, 50] }, tauPrior: { kind: 'half_normal', scale: 0.5 }, components: 2, robustWeight: 0.2 } }],
  'design.analytic': [
    { label: 'two-arm time-to-event: accrual is an object of duration, followup and dropoutAnnual', scenario: {
      design: { kind: 'two_arm_fixed', allocation: 0.5 }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 12 },
      analysis: { alpha: 0.025, power: 0.9, sided: 1 }, accrual: { duration: 12, followup: 12, dropoutAnnual: 0.05 } } },
    { label: 'two-arm binary: no accrual', scenario: {
      design: { kind: 'two_arm_fixed' }, endpoint: { type: 'binary' }, truth: { controlRate: 0.3, treatmentRate: 0.45 }, analysis: { alpha: 0.025, power: 0.9 } } },
    { label: 'non-inferiority on an adverse-event rate, where lower is better: expected 8% against 10% on the control and allowed to be at most 3 points higher (the same numbers with higher_better ask for 25 times the patients)', scenario: {
      design: { kind: 'two_arm_fixed' }, endpoint: { type: 'binary' }, truth: { controlRate: 0.1, treatmentRate: 0.08 }, hypothesis: { kind: 'non_inferiority', margin: 0.03, direction: 'lower_better' },
      analysis: { alpha: 0.025, power: 0.9 } } },
    { label: 'non-inferiority: the treatment is expected to be as good as the control (hazard ratio 1) and must not be worse than a hazard ratio of 1.3', scenario: {
      design: { kind: 'two_arm_fixed' }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 1, controlMedian: 12 }, hypothesis: { kind: 'non_inferiority', margin: 1.3 },
      analysis: { alpha: 0.025, power: 0.9 }, accrual: { duration: 12, followup: 24 } } },
  ],
  'design.confirmatory': [
    { label: 'stop for futility: three looks, efficacy and futility boundaries for a mean difference of 0.4 standard deviations', scenario: {
      design: { kind: 'futility_group_sequential', informationRates: [0.4, 0.7, 1] }, endpoint: { type: 'continuous' }, hypothesis: { direction: 'higher_better' }, truth: { plannedEffect: 0.4, sd: 1 }, analysis: { alpha: 0.025, power: 0.9 } } },
    { label: 're-estimate the sample size at an interim look when the effect is uncertain: planned for a hazard ratio of 0.7, reported at 0.8 and 0.7 (the null is added)', scenario: {
      design: { kind: 'sample_size_reestimation', informationRates: [0.5, 1], conditionalPower: 0.8, maxSampleSizeFactor: 1.5 }, endpoint: { type: 'time_to_event' },
      truth: { plannedEffect: 0.7, effects: [0.8, 0.7], controlMedian: 12 }, accrual: { duration: 12, followup: 12, dropoutAnnual: 0.05 } } },
    { label: 'the same re-estimation with a promising zone: enlarge only when the conditional power at the interim is between 36% and 80% (the null is added)', scenario: {
      design: { kind: 'sample_size_reestimation', informationRates: [0.5, 1], conditionalPower: 0.8, maxSampleSizeFactor: 2, promisingZone: { lower: 0.36, upper: 0.8 } }, endpoint: { type: 'continuous' }, hypothesis: { direction: 'higher_better' },
      truth: { plannedEffect: 0.4, effects: [0.2, 0.3], sd: 1 } } },
    { label: 'three doses against one control, the best dose kept at the interim (80 patients per arm planned)', scenario: {
      design: { kind: 'multi_arm_selection', informationRates: [0.5, 1], activeArms: 3, plannedSize: 80 }, endpoint: { type: 'continuous' }, hypothesis: { direction: 'higher_better' },
      truth: { effectScenarios: [[0.2, 0.4, 0.6], [0.3, 0.3, 0.3]], sd: 1 } } },
    { label: 'three doses against one control for an event-time endpoint: hazard ratios 0.9, 0.75 and 0.6, the best dose kept at the interim (240 events planned in all, no accrual or control median needed)', scenario: {
      design: { kind: 'multi_arm_selection', informationRates: [0.5, 1], activeArms: 3, plannedSize: 240 }, endpoint: { type: 'time_to_event' },
      truth: { effectScenarios: [[0.9, 0.75, 0.6]] } } },
    { label: 'a biomarker-positive subset of 40% for an event-time endpoint: hazard ratio 0.6 in the subset and 0.9 outside it (240 events planned)', scenario: {
      design: { kind: 'enrichment', informationRates: [0.5, 1], subsetPrevalence: 0.4, plannedSize: 240 }, endpoint: { type: 'time_to_event' },
      truth: { subsetEffects: [{ subset: 0.6, rest: 0.9 }] } } },
    { label: 'a biomarker-positive subset of 40%: enrol everyone, keep the subset or everyone at the interim (200 patients planned)', scenario: {
      design: { kind: 'enrichment', informationRates: [0.5, 1], subsetPrevalence: 0.4, plannedSize: 200 }, endpoint: { type: 'binary' }, hypothesis: { direction: 'higher_better' },
      truth: { subsetEffects: [{ subset: 0.25, rest: 0 }, { subset: 0.15, rest: 0.15 }], controlRate: 0.3 } } },
    { label: 'stop for futility where LOWER is better: an adverse-event rate that should fall from 30% to 20% (the effect is -0.1, the direction says a negative difference is the benefit)', scenario: {
      design: { kind: 'futility_group_sequential', informationRates: [0.5, 1] }, endpoint: { type: 'binary' }, hypothesis: { direction: 'lower_better' }, truth: { plannedEffect: -0.1, controlRate: 0.3 }, analysis: { alpha: 0.025, power: 0.9 } } },
    { label: 'a count endpoint (attacks per patient-year): rate ratio 0.67 on a control rate of 0.6, overdispersion 0.5', scenario: {
      design: { kind: 'count_endpoint' }, truth: { controlEventRate: 0.6, rateRatio: 0.67, overdispersion: 0.5, exposureTime: 1 } } },
  ],
  'design.dose': [
    { label: 'BOIN against 3+3 on a six-dose toxicity curve, target 0.30, 30 patients in cohorts of 3 (the same curve and the same random numbers for both)', scenario: {
      design: { kind: 'boin', compare: ['three_plus_three'], targetToxicity: 0.3, cohortSize: 3, maxPatients: 30 }, truth: { toxicity: [0.05, 0.1, 0.2, 0.3, 0.45, 0.6] } } },
    { label: 'four designs side by side on one curve: CRM with a stated skeleton, BOIN, the keyboard design and 3+3', scenario: {
      design: { kind: 'crm', compare: ['boin', 'keyboard', 'three_plus_three'], targetToxicity: 0.25, maxPatients: 36, crm: { skeleton: [0.05, 0.12, 0.25, 0.4, 0.55, 0.7] } },
      truth: { toxicity: [0.05, 0.1, 0.2, 0.3, 0.45, 0.6] } } },
    { label: 'how many patients per dose to choose the lower of two doses with probability 0.9 when it is not worse (the higher dose must look 10 points better to be chosen)', scenario: {
      design: { kind: 'randomized_selection', margin: 0.1, targetProbability: 0.9 }, truth: { responseScenarios: [[0.3, 0.3], [0.3, 0.45]] } } },
  ],
  'design.bayesian': [
    { label: 'Bayesian optimal phase II: a look every 10 patients up to 40, response rate 0.1 against 0.3, searched for the largest power at one-sided 0.05; Simon\'s design is the baseline', scenario: {
      design: { kind: 'bop2', maxN: 40, lookEvery: 10 }, truth: { nullRate: 0.1, alternativeRate: 0.3 }, analysis: { alpha: 0.05, power: 0.8 } } },
    { label: 'the same trial searched for the fewest expected patients under the null among the designs that keep alpha and reach 80% power', scenario: {
      design: { kind: 'bop2', maxN: 40, lookEvery: 10, objective: 'min_expected_n' }, truth: { nullRate: 0.1, alternativeRate: 0.3 }, analysis: { alpha: 0.05, power: 0.8 } } },
    { label: 'predictive-probability monitoring: stop when the chance of a successful final analysis is below 5%', scenario: {
      design: { kind: 'predictive_monitoring', maxN: 40, lookEvery: 10, predictive: { futility: 0.05 } }, truth: { nullRate: 0.1, alternativeRate: 0.3 }, analysis: { alpha: 0.05, power: 0.8 } } },
    { label: 'the type I error and power of a posterior-probability success rule (0.975) for a mean difference under a normal prior, and the threshold that gives 0.025', scenario: {
      design: { kind: 'threshold_calibration', nTreat: 100, nControl: 100, threshold: 0.975, priorEffect: { mean: 0.2, sd: 0.3 } }, endpoint: { type: 'continuous' }, truth: { sd: 1, effect: 0.4 }, analysis: { alpha: 0.025 } } },
    { label: 'the same for a hazard ratio from 200 events (the log hazard ratio under a normal prior)', scenario: {
      design: { kind: 'threshold_calibration', events: 200, margin: 1, priorEffect: { mean: -0.2, sd: 0.2 } }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7 } } },
    { label: 'the same for two beta-binomial arms of 60 and a non-inferiority margin of 10 points on the risk difference', scenario: {
      design: { kind: 'threshold_calibration', nTreat: 60, nControl: 60, margin: -0.1 }, endpoint: { type: 'binary' }, truth: { controlRate: 0.3, treatmentRate: 0.3 } } },
  ],
  'design.win_ratio': [
    { label: 'death, then hospitalisations, then a score (KCCQ-like, 5 points matter, SD 20): 300 patients per arm followed for 24 months, the power of the win-ratio test', scenario: {
      design: { nTreat: 300, nControl: 300, followup: 24, dropoutAnnual: 0.05 },
      truth: { death: { controlRisk: 0.15, hazardRatio: 0.75 }, events: { controlRate: 0.04, rateRatio: 0.8 }, score: { shift: 4, sd: 20, threshold: 5 }, correlation: 0.3 },
      analysis: { alpha: 0.025, sided: 1 } } },
    { label: 'the same hierarchy: how many patients per arm for 90% power', scenario: {
      design: { followup: 24, dropoutAnnual: 0.05 },
      truth: { death: { controlRisk: 0.15, hazardRatio: 0.75 }, events: { controlRate: 0.04, rateRatio: 0.8 }, score: { shift: 4, sd: 20, threshold: 5 }, correlation: 0.3 },
      analysis: { alpha: 0.025, power: 0.9 } } },
    { label: 'death, then a score only, with no treatment effect on death or the score (the type I error)', scenario: {
      design: { nTreat: 150, nControl: 150, followup: 12 },
      truth: { death: { controlMedian: 60, hazardRatio: 1 }, score: { shift: 0, sd: 1 } }, analysis: { alpha: 0.025 } } },
  ],
  'design.simulate': [
    { label: 'two-arm time-to-event with uniform accrual', scenario: {
      design: { kind: 'two_arm_fixed', nTreat: 150, nControl: 150 }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 12 },
      analysis: { method: 'logrank', alpha: 0.025, sided: 1 }, accrual: { kind: 'uniform', duration: 12, followup: 12, dropoutAnnual: 0.1 },
      performance: ['power', 'bias'], targetMcse: 0.005 } },
    { label: 'two-arm binary: no accrual', scenario: {
      design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'binary' }, truth: { controlRate: 0.3, treatmentRate: 0.5 }, analysis: { method: 'logistic' } } },
    { label: 'a delayed treatment effect (hazard ratio 1 for 6 months, 0.6 after) analysed by MaxCombo: simulation only', scenario: {
      design: { kind: 'two_arm_fixed', nTreat: 150, nControl: 150 }, endpoint: { type: 'time_to_event' }, truth: { treatmentHazardRatios: { breaks: [6], ratios: [1, 0.6] }, controlMedian: 12 },
      accrual: { kind: 'uniform', duration: 12, followup: 18 }, analysis: { method: 'maxcombo', alpha: 0.025, sided: 1 } } },
    { label: 'a delayed treatment effect (hazard ratio 1 for 6 months, 0.6 after) analysed by the modestly weighted test, the log-rank power reported beside it', scenario: {
      design: { kind: 'two_arm_fixed', nTreat: 150, nControl: 150 }, endpoint: { type: 'time_to_event' }, truth: { treatmentHazardRatios: { breaks: [6], ratios: [1, 0.6] }, controlMedian: 12 },
      accrual: { kind: 'uniform', duration: 12, followup: 18 }, analysis: { method: 'modestly_weighted', sStar: 0.5, alpha: 0.025, sided: 1 } } },
    { label: 'a delayed treatment effect analysed by MaxCombo at three looks (O\'Brien-Fleming spending): the boundaries are found by simulation under no effect', scenario: {
      design: { kind: 'group_sequential', nTreat: 150, nControl: 150, informationRates: [0.5, 0.8, 1], spending: 'obrien_fleming' }, endpoint: { type: 'time_to_event' },
      truth: { treatmentHazardRatios: { breaks: [4], ratios: [1, 0.6] }, controlMedian: 12 }, accrual: { kind: 'uniform', duration: 12, followup: 30, dropoutAnnual: 0.05 },
      analysis: { method: 'maxcombo', alpha: 0.025, sided: 1 } } },
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
  'comparator.aipw': [
    { label: 'doubly robust, binary outcome', scenario: {
      covariates: ['age', 'male'], treatmentColumn: 'arm', outcomeColumn: 'response', endpoint: { type: 'binary' } } },
    { label: 'doubly robust, restricted mean survival time to 24 months', scenario: {
      covariates: ['age', 'male'], treatmentColumn: 'arm', endpoint: { type: 'time_to_event' }, tau: 24, summary: 'rmst', timeUnit: 'months' } },
  ],
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
// What a row asks of the person, and the minimal scenario of each common path (C2, C4)
// ---------------------------------------------------------------------------

/**
 * Whether a key of a scenario is a fact of the research or something the model can settle itself, read from the row's own
 * structure and from nothing kept beside it (remediation plan C2):
 *
 * - `research_fact` — the schema requires it (always, in the case the row's gate describes, or as one of the keys a coupled rule
 *   says one of must be given) and states no default, and it is not a choice among the method's own words: a hazard ratio, a
 *   control median, a sample size. Only the research can give it, so it is the one kind of key a conversation may ask about, and
 *   only when the answer would change the next computation.
 * - `defaultable` — everything else: a key with a default (the platform fills it and says so in `applied`), an optional key (the engine
 *   goes on without it), and a closed vocabulary with no default (the endpoint, the design: a choice the question itself makes).
 *   The model settles these, states the assumption in its reply, and does not ask.
 *
 * An object has no role of its own — it is only its keys, and a key inside it that depends on a sibling's value is a fact only when
 * that value says so — and `null` is returned for it; the keys inside carry the roles.
 * @param {VcrHelpRow} row @param {{ rules?: readonly VcrHelpRule[] }} [context] the method's coupled rules
 * @returns {'research_fact' | 'defaultable' | null}
 */
export function vcrRowRole(row, { rules = [] } = {}) {
  if (row.type === 'object') return null
  if (row.default !== undefined) return 'defaultable'
  const coupled = rules.some((rule) => (rule.kind === 'exactlyOne' || rule.kind === 'atLeastOne') && (rule.keys ?? []).includes(row.path)
    || rule.kind === 'requires' && (rule.needs ?? []).includes(row.path))
  const needed = row.required === true || (Array.isArray(row.requiredWhen) && row.requiredWhen.length > 0) || coupled
  if (!needed) return 'defaultable'
  const choice = row.type === 'string' && (Array.isArray(row.values) || Boolean(row.valuesBy))
  return choice ? 'defaultable' : 'research_fact'
}

/**
 * One minimal scenario per common path: the facts of the research and the choices the question makes, and nothing the platform
 * defaults (alpha, power, the analysis, the accrual's shape, the dropout). It is a starting point a model reads, never a form and
 * never shown to a person; a number in it is a placeholder for the study's own. The test runs every template through
 * `validateScenario` and holds it to the rule above: no key of a template has a default.
 * @type {Readonly<Record<string, ReadonlyArray<{ name: string, label: string, scenario: Record<string, any> }>>>}
 */
export const VCR_MINIMAL_TEMPLATES = Object.freeze({
  'design.analytic': [
    { name: 'two_arm_time_to_event', label: 'sample size of a two-arm time-to-event design', scenario: {
      design: { kind: 'two_arm_fixed' }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { duration: 12, followup: 12 } } },
    { name: 'two_arm_binary', label: 'sample size of a two-arm binary design', scenario: {
      design: { kind: 'two_arm_fixed' }, endpoint: { type: 'binary' }, truth: { controlRate: 0.3, treatmentRate: 0.45 } } },
    { name: 'two_arm_continuous', label: 'sample size of a two-arm continuous design, the effect in standard-deviation units (truth.sd defaults to 1: state it when the effect is in the outcome\'s own unit)', scenario: {
      design: { kind: 'two_arm_fixed' }, endpoint: { type: 'continuous' }, truth: { effect: 0.5 } } },
  ],
  'design.simulate': [
    { name: 'two_arm_time_to_event', label: 'operating characteristics of a two-arm time-to-event design', scenario: {
      design: { kind: 'two_arm_fixed', nTreat: 150, nControl: 150 }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 12 } } },
    { name: 'two_arm_binary', label: 'operating characteristics of a two-arm binary design', scenario: {
      design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'binary' }, truth: { controlRate: 0.3, treatmentRate: 0.45 } } },
    { name: 'two_arm_continuous', label: 'operating characteristics of a two-arm continuous design, the effect in standard-deviation units (truth.sd defaults to 1: state it when the effect is in the outcome\'s own unit)', scenario: {
      design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'continuous' }, truth: { effect: 0.5 } } },
  ],
  'population.literature': [
    { name: 'literature_population', label: 'a population from a published baseline table', scenario: {
      baselineTable: [{ variable: 'age', mean: 62, sd: 9 }, { variable: 'male', proportion: 0.55 }] } },
  ],
  'comparator.entropy_balance': [
    { name: 'entropy_balance', label: 'entropy-balance weighting of an external control', scenario: { covariates: ['age', 'ecog'] } },
  ],
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
    notes.push('costs: the cost measure is perPatient x N + perSite x sites + perMonth x duration. A duration exists only for a time-to-event design with an accrual block, so a continuous or binary design gets its cost from perPatient and perSite, and a perMonth cost there is declined with its reason (diagnostics.performanceNotComputed).')
    notes.push('A frozen Simon two-stage design (simon_two_stage) is simulated at truth.responseRate with its given boundaries n1, r1, n, r. truth.alternativeRate and analysis.alpha do not change that; they are what the result reports the frozen design against: diagnostics.frozenDesign holds its exact rejection probability, early-stop probability and expected sample size at truth.nullRate and at truth.alternativeRate, and, when analysis.alpha is written, whether its type I error is within it.')
  }
  return notes
}

/**
 * What a row's type and range cannot say: the scale and pairing policy a number uses.
 * @type {readonly string[]}
 */
const PATIENT_PAIRING_NOTES = Object.freeze(["A selected immutable population uses a stable cohort pairing key by default. Explicit pairing.key and pairing.replicate select the comparison group and an independent L'Ecuyer-CMRG replicate stream. Common random numbers require the same key, seed, method and member ordering; changing the replicate changes random draws, while member identity stays fixed. A paired synthetic scenario does not identify an individual causal effect."])

/**
 * What a comparator's `timeUnit` row (any text up to 20 characters, for the jobs saved before the engine's unit rules) cannot say: the
 * four words the engine reads, what the queue does with the spellings of them, and what a table's own unit does.
 * @type {readonly string[]}
 */
const COMPARATOR_TIME_UNIT_NOTES = Object.freeze(["timeUnit is days, weeks, months or years. The usual spellings (day, d, 天, month, 个月, yr, 年 …) are written as these when the job is queued, so one request is one job in any spelling; text that names no unit is refused before queueing. A table that carries its own unit (the event times of a mapped snapshot, a reconstruction calibrated in one) must agree with it, and a scenario that states none takes the table's; a time-to-event analysis with neither is refused rather than assume months. Nothing is converted between units."])
/** The two robustness analyses that take the declared unit as it is and default it to months. @type {readonly string[]} */
const ROBUSTNESS_TIME_UNIT_NOTES = Object.freeze(["timeUnit is days, weeks, months or years (the usual spellings are written as these when the job is queued; text that names no unit is refused before queueing); months when none is stated. It labels the horizon and the times in the result; nothing is converted."])

/**
 * What an unanchored indirect comparison (`anchored: false`, the default) rests on, said to the run that writes it so that it says the same to the
 * person: the result lists the premise itself ("无锚定：假定所有预后因子和效应修饰因子都已调整"), and what was not adjusted belongs in
 * `unadjustedEffectModifiers` rather than being left out.
 * @type {readonly string[]}
 */
const UNANCHORED_NOTES = Object.freeze(["anchored false (the default) has no common comparator, so the comparison is unbiased only if every prognostic factor and every effect modifier is among the matched covariates; the result states that as its premise (无锚定：假定所有预后因子和效应修饰因子都已调整). Name the effect modifiers you could not match on in unadjustedEffectModifiers instead of leaving it empty, and report the number as an unanchored comparison, never as an adjusted treatment effect."])

/**
 * Trimming (algorithm round C14), said to the run that writes it: it changes who the estimate is about, and the result says so.
 * @type {string}
 */
const TRIM_NOTE = 'trim (propensity weighting, weighted Cox with propensity weights, doubly robust) removes the people who have no comparable counterpart before the weights are fitted: { rule: "crump" } is the optimal rule of Crump et al. (2009) and needs no number; { rule: "fixed", lower: 0.1 } removes whoever has a propensity score below lower or above upper (1 - lower unless stated), and the bound is the person\'s own choice. The result is then about the people who were kept, not about everyone: it lists how many were removed in each arm and how they differ from the kept people (the target population is the trimmed one, EU HTA guideline 6.2), and says it is limited by that. Leave trim out unless overlap is the problem; do not pick a bound to make a result significant.'
/**
 * Missing covariates (algorithm round C7), said to the run that writes it: what the key does, what it assumes, and what the result shows beside it.
 * @type {string}
 */
const IMPUTATION_NOTE = 'imputation (entropy balancing, propensity weighting, weighted Cox, doubly robust) is for a table in which a covariate has missing values; without it a missing covariate refuses the job by name. { m: 20 } imputes the missing covariates 20 times by chained equations (a number by predictive mean matching, a 0/1 column by a logistic draw, a column named in categorical by a multinomial draw; the other covariates, the arm and the outcome are in each model), runs the analysis on each completed table and pools the answers by Rubin\'s rules; the complete-case answer is reported beside it. Take m at least the percentage of people with a missing value (the result says when it is not). The assumption is missing at random given the other covariates, the arm and the outcome, and the result states it as a premise. A covariate coded as several indicator columns is imputed column by column and can give a person two categories at once: give a categorical covariate as one coded column and name it in categorical. The interval is Rubin\'s, from a bootstrap whose draws are shared among the imputations, so asking for more imputations does not make the job slower.'
/** The time-to-event doubly robust comparison (algorithm round C8). @type {string} */
const AIPW_TIME_TO_EVENT_NOTE = 'For endpoint time_to_event, tau is the horizon and summary says what is read at it: rmst (the default) is the restricted mean survival time up to tau, survival the survival probability at tau; the effect is the trial arm\'s Kaplan-Meier value minus the augmented estimate of what the trial\'s patients would have had on the external control. The event times come from the events table (AVAL, CNSR) as in the other time-to-event comparisons. Each person enters as a Kaplan-Meier pseudo-observation of his arm, so the estimate assumes censoring does not depend on the covariates within an arm (the result states that as a premise); a tau beyond the follow-up of either arm is a not-estimable result.'

/**
 * Target-trial emulation (algorithm round C3, C4), said to the run that writes it: what the table must look like, which question each strategy answers and
 * which estimand the result is.
 * @type {readonly string[]}
 */
const TARGET_TRIAL_NOTES = Object.freeze([
  'It answers "in a cohort whose treatment starts at different times, what is the effect of starting against not starting, without immortal-time bias". The input is a longitudinal table with one row per person, period and parameter (USUBJID, PARAMCD, AVAL, and ADT = the period number, a whole number): a file with one row per person-period and a visit column is mapped to it by marking the visit column visit_date and the treatment, outcome, eligibility and covariates as measurements, the outcome measurement also outcome: true (the study\'s seal then withholds the table until the analysis plan is frozen, and records the first read; unmarked, the outcome is read unrecorded). parameters names the parameter codes of the treatment, the outcome (an event in the period, 0/1) and the eligibility (1 in a period the person could enter a trial; default treatment, outcome, eligible); covariates names the others, as they stand in each period. A record ends at the first event, the first period with a missing required value and the first gap in the periods: the follow-up stops there and the result counts it.',
  'strategy.kind sequential is a sequence of emulated trials, one for every period a person is eligible, the arm being the treatment in that period (Danaei 2013; Hernan & Robins 2016): estimand itt ignores what happens after the start, per_protocol censors a person when the treatment leaves the arm and weights by the stabilised inverse probability of the treatment received (weights.numerator is the stabilising set, default none, weights.denominator the full set, default all covariates), both (the default) reports the two. horizon is the number of follow-up periods the risk is read at, counted from each trial\'s start. The result is a risk difference at that horizon with both arms\' risks, standardised over everyone eligible at any trial start; it says which estimand it is. An estimand whose arm has nobody followed (for per protocol: on protocol) to the horizon is left out and named while the other is kept; an arm with no event at all has an exact upper limit and no interval, and the result is limited. firstPeriod, lastPeriod and followUpLimit only make the expanded table smaller; a design too large for the memory of a job is refused by name (too_many_person_periods) and the refusal says which of them to use.',
  'strategy.kind clone_censor_weight is the grace-period strategy a sequence of trials cannot ask: "start treatment within gracePeriod periods of the first eligible period" against "do not start". Every person is in both arms from time zero; the first arm is censored at the start of the last period of the grace period (periods 0 to gracePeriod) if treatment has not started, the second when it does; the censoring is undone by weights from one model of starting treatment on the covariates AS THEY STAND IN EACH PERIOD (a covariate that changes over time enters with its value then, and is assumed not to be changed by starting treatment) and the period since. The risk difference at the horizon is the effect of starting within the grace period: it reads when treatment started and nothing after it, so it is not a per-protocol estimand (its measures end in _start, not _pp). A horizon inside the grace period leaves the first arm uncensored (the natural course) and is limited; people treated before time zero are counted apart and limited; an arm with no event has an exact upper limit and no interval, and the result is limited. The result also shows the naive comparison of those who ever started with those who never did, only so that the waiting time of the first can be seen: it is not an estimate. Do not choose the grace period after looking at the result.',
]);

/**
 * Quantitative bias analysis (algorithm round C1, C2): said to the run that writes it, so that the person\'s question, the direction of a bias
 * and who supplies the numbers are the same in the conversation and on the page.
 * @type {readonly string[]}
 */
const BIAS_ANALYSIS_NOTES = Object.freeze([
  'It answers "how large a shift from an unmeasured confounder would turn this conclusion, and what would the effect be if the bias is what I believe". The input is an estimate and its interval: scale (hazard_ratio, risk_ratio, odds_ratio or difference), estimate, and either lower and upper (the limits as published) or se (the standard error of the log ratio, or of the difference). On a saved comparison, name it (subjectId) and leave the estimate out: the platform takes the estimate and interval from its result; never copy a number from a result into the scenario.',
  'Every bias is the one that exaggerates the observed effect: a ratio of at least 1 (an amount of at least 0 on the difference scale) that moves the estimate toward the null when removed, on whichever side of the null the estimate is. The tipping bias (the bias that brings the interval\'s nearer limit to the null, and the one that brings the estimate there) is always computed. shiftedNull { biases: [...] } tests the effect against stated biases (the EU HTA guideline\'s shifted null hypothesis). The tipping confounder is a binary confounder with outcome association gamma (confounderTipping.associations, default 1.5, 2, 3, 5 on a ratio scale; there is no default on the difference scale) that is rarer in one arm, with prevalence baselinePrevalence there (default 0: the smallest prevalence difference that can tip the estimate); the result names the arm that carries more of it and the prevalence it needs, and gives the standardised mean difference of a normal confounder.',
  'probabilistic is the analysis with stated distributions: either bias (the exaggerating bias itself: constant, uniform, triangular, normal on the log scale of a ratio, lognormal with a median and sdlog) or confounder (exposedPrevalence, unexposedPrevalence, association: constant, uniform, triangular, and lognormal for the association). The ranges are the person\'s or the literature\'s: ask for them or read them from a source, never invent them. Each draw removes its bias from the estimate (systematic error only), and a second pass adds the sampling error (combined uncertainty). Defaults are 100000 draws (replicates raises it); the median and the 2.5 and 97.5 percentiles carry their Monte-Carlo error. A stand-alone call (no subjectId) with a stated estimate files its own comparison.',
])

/**
 * The simulated treatment comparison in its G-computation form (algorithm round C9).
 * @type {readonly string[]}
 */
const BORROWING_NOTES = Object.freeze([
  'One historical control arm (a count of responders and patients for a rate; the mean, n and the standard deviation for a mean, the standard deviation taken as known and the same in every group) and a prior for the CONTROL arm; the treatment arm is read with a flat prior. prior.kind power: the historical data count at a fixed discount a0 between 0 (nothing) and 1 (as if pooled). sam: the informative prior is mixed with a vague one at a weight the current control data decide; prior.delta is the difference beyond which nothing should be borrowed, in the unit of the rate or the mean, and it is a clinical choice. elastic: the historical posterior is made less certain by the factor 1 / g(T), where T is how far the current control data are from the historical ones; delta, q0 and q1 place the function g, which is a choice rather than a finding.',
  'current (the control arm\'s own data) with treatment gives the posterior, the prior effective sample size above the vague prior, the probability that the treatment is better, each against no borrowing and against full borrowing (a0 = 1). operatingCharacteristics gives the type I error and the power of the rule "the probability that the treatment is better exceeds 1 - analysis.alpha" when the true control value is the historical one plus each drift (the unit of the rate or the mean), exactly, for nControl and nTreatment patients, beside the same rule with no borrowing; at most 2000 patients an arm. State at least one of current and operatingCharacteristics.',
  'The weight of a sam prior and the discount of an elastic one are data-dependent: with current they are read from it, and the table of conflict against borrowing (the discount at observed differences of -2 to 2 deltas from the historical value) is returned for both. The elastic function needs q0 (the share of the congruent data it treats as in full agreement) and q1 (the share of data a delta away that it treats as in conflict): they are not searched, and left out they default to 0.5 and 0.5, returned among the assumptions. Several historical studies: pool them first, or use comparator.map_prior.',
])

const STC_NOTES = Object.freeze([
  'It needs the patients of one trial (the subject table: covariates, the arm column, the outcome) and the published summary of the other: aggregateCovariates, one row per covariate (mean and sd for a continuous one, proportion for a 0/1 one), and the trial\'s result. The outcome model is main effects plus the effect modifiers named in effectModifiers interacting with the arm; name every effect modifier you know of, and the ones you could not use in unadjustedEffectModifiers. The covariate distribution of the published trial is simulated from its margins with the IPD\'s own correlation unless correlation is stated.',
  'Anchored (anchored true): the arm column is 1 for the active arm and 0 for the common comparator, and aggregateEstimate is the other trial\'s contrast of its active arm against the same comparator on the link scale (a log odds ratio for logit, a log risk ratio for log, a difference for identity). Unanchored: only the active arm is modelled (treatmentColumn selects arm 1) and aggregateOutcome is the other trial\'s outcome on its OWN scale with its standard error; ' + UNANCHORED_NOTES[0],
  'link defaults to identity for a continuous outcome and logit for a binary one. The result is the marginal effect in the published trial\'s population; the conventional STC (conditional, covariates centred at the published means) is reported beside it.',
])

/**
 * The hypothesis of a two-arm design (T1): said to the run that writes it, so that a margin is the person's own choice and a design
 * without one is read as a superiority design.
 */
const HYPOTHESIS_NOTE = 'hypothesis is for a two-arm design and is left out for superiority (the default). { kind: "non_inferiority", margin, direction } tests that the treatment is not worse than the control by more than the margin: margin is a positive number in the outcome\'s units for a mean, a risk difference below 1 for a binary endpoint, and a hazard ratio above 1 for an event-time endpoint (the largest ratio still counted as not worse). direction (a mean or a risk only; a hazard ratio is always better below 1) says which way is better: higher_better for a response rate or a score that should not fall by more than the margin, lower_better for an adverse-event rate, a blood pressure or a symptom score that should not rise by more than it. It is never defaulted, because the same margin asks a different question the other way (34,504 patients against 1,404 for event rates of 8% and 10% and a margin of 3 points): ask which way is better, do not guess. The margin is a clinical choice: ask for it, never invent one. An expected effect on the wrong side of the margin has no sample size (the power falls as patients are added): design_analytic refuses it by name, and design_simulation shows the power at a stated size. truth then states the effect the treatment is EXPECTED to have (often 0, or a hazard ratio of 1), not the margin; design.simulate measures the type I error by putting the truth on the margin itself. The test is one-sided (at alpha / sided, group-sequential designs included); analysis.method is the t-test, the risk difference or the log-rank test.'

/**
 * Evidence synthesis beyond a pairwise pool (algorithm round C5, C6, E7, E8): said to the run that writes it, so that what each result is a reference for
 * is the same in the conversation and on the page.
 */
const POOL_PRIOR_NOTE = 'tauPrior (optional) gives the between-study standard deviation an informative prior, so that two studies (or one) have a prediction interval: the pooled value becomes the Bayesian one (posterior mean and credible interval), and the frequentist pooling is kept beside it. kind turner_2015 (outcome, comparison) takes the prior of Turner et al. (2015) for binary outcomes on the log odds ratio scale from their table of 80 settings, turner_2015_generic their overall one, bartos_2023 (effectScale: log_odds_ratio, log_risk_ratio, risk_difference or log_hazard_ratio) the priors of Bartos et al. (2023) from the Cochrane database; half_normal (scale, on tau), log_normal (meanLog, sdLog, on tau-squared), inverse_gamma (shape, scale, on tau) and log_t (location, scale, df, on tau-squared) state your own. These describe how much trials of one comparison typically differ, not the drug in front of you: say which prior was used and why that setting fits, and state the pooled value beside the one without it.'
const NETWORK_NOTES = Object.freeze([
  'It compares every treatment of a connected set of studies with every other, through the studies that join them, and says how well the direct and the indirect evidence agree. A study states arms (events and n for odds_ratio or risk_ratio; mean, sd and n for mean_difference) or contrasts (every pair of its arms: treatment, comparator, effect on the log scale for log_ratio or the measure\'s own scale for difference, and standard error); a study with three or more arms in contrast form must state every pair. Treatment names are matched as written, so write each one the same way in every study.',
  'direction says which side is better (lower_better: a smaller effect is better), and it is yours to state, not the engine\'s: it only orders the P-scores. The result has the league table (every pair, with the number of studies that compared them directly), the effects against a reference (reference, or the treatment in most studies), tau-squared and I-squared, the heterogeneity test, and the inconsistency test that splits Q into within and between designs (of the common-effect fit). model random (the default) or common chooses the headline; both are in the result. A zero cell is corrected as continuityCorrection says and the studies are named. A network in separate parts is refused with the parts listed.',
  'The P-score is a ranking of point estimates weighted by their precision (the mean probability of being better than each other treatment); it is not the probability of being best, and treatments with few studies rank on thin evidence. Report the league table and the consistency test with it, and do not recompute any number.',
])
const DOSE_RESPONSE_NOTES = Object.freeze([
  'It pools grouped dose-response data (the reference level and the others against it, as a paper prints them): per study type cc (case-control, n = cases plus controls), ci (cumulative incidence, n = the number at risk) or ir (incidence rate, n = person-years), and rows of dose, effect (the log ratio; 0 for the reference row, which has no se), se, cases and n. Cases and n rebuild the correlation between the levels of one study (Greenland and Longnecker); a level without them makes the levels count as independent, and the result says so.',
  'model.kind linear gives the change in the log ratio per unit of dose (perDose turns it into a ratio for a step you choose, such as one standard drink); spline fits a restricted cubic spline with knots at doses (knots) or at percentiles of the pooled doses (knotPercentiles, default 10th, 50th, 90th), tests non-linearity, and returns the ratios at predictAt against referenceDose (default the smallest dose). stage two (default) fits each study first and needs at least as many non-reference levels as coefficients, leaving smaller studies out and naming them; one stage keeps them.',
  '"From what dose does it work" is answered with the predicted ratios and the first dose on a fine grid at which the interval leaves 1; that is a pointwise reading of the fitted curve, not a threshold the data establish, and a dose-response across studies is not a statement about one person.',
])
const VOI_NOTES = Object.freeze([
  'It asks which unknown input, if it were learned, would change the decision, and how much that is worth: the expected value of perfect information (EVPI), of perfect partial information on each input (EVPPI, a GAM regression of each option\'s utility on the input; Strong, Oakley and Brennan 2014) and of the sample information of a named study (EVSI by regression; Strong et al. 2015). Every number comes from the engine; the model reports the table and never ranks, estimates or recomputes a value.',
  'source two_arm_continuous evaluates the power of a two-arm trial of each option on every draw (options give the people per arm, 0 for no trial). The utility is the probability of success, or a net benefit (successValue times that probability less costPerPatient times the people enrolled). Each of effect, sd, dropoutShare and controlProgression is fixed, drawn from a distribution (it gets an EVPPI), or a range of optimistic, base and pessimistic values (no distribution: held at base, and it gets the value at which the best option changes, never a probability). Dropout only removes analysed people. effectScale proportional_slowing reads effect as a share of controlProgression, the control arm\'s worsening.',
  'source table takes the utilities of each option and the draws of each input (lists of numbers of equal length, at least 30) from any other computation, as the voi package does; the engine says it did not compute them. groups name two to four inputs whose joint EVPPI is wanted. studies: phase2_effect (people per arm, observes the effect), natural_history_control (people, observes the control worsening) or, for a table, normal_known (a named input observed with a known sd).',
  'replicates is the number of draws (default 10,000, at least 30; under 1,000 the regression is rough and the premises say so). An EVPPI may exceed the EVPI by estimation error, and the standard error does not include the smoothing error of the regression.',
])

const PK_INTERACTION_NOTES = Object.freeze([
  'It runs one published whole-body PBPK model (Asaumi et al. 2018, CPT Pharmacometrics Syst Pharmacol) of midazolam with CYP3A4 induction by repeated oral rifampicin, in gut wall and liver, with the enzyme turnover the paper states: the victim\'s curve alone and after the perpetrator, the area and peak ratios, and the enzyme activity at the victim\'s dose. Victim: midazolam, oral (default) or intravenous (a bolus, or an infusion over infusionH). Perpetrator: rifampicin, doses of doseMg every intervalH hours (default 24), the victim given gapH hours (default 12) after the last. Nothing else is in the model: another victim or perpetrator is refused by name, and no stand-in is run.',
  'It is a typical healthy adult: every clearance, flow and volume is per kilogram and weightKg (default 80) is the only person. There is no between-person variability, genotype or disease, so the ratio is the model\'s typical value and not a prediction interval. The paper prints no interaction ratio in its text (the fits are figures); the model reproduces its authors\' own simulation to the digit, and a comparison with a clinical study is a separate, labelled thing. Say that when you report it.',
])

const SHRINKAGE_NOTES = Object.freeze([
  'It reads a published effect (a difference, or the log of a ratio; the estimate and its standard error) against the primary efficacy results of 23,551 randomized trials of the Cochrane Database (van Zwet et al. 2023): the effect shrunk toward no effect, how much larger the estimate probably is than the truth (the exaggeration, median and quartiles), the probability that its sign is right, and the probability that an exact replication of the same precision reaches two-sided significance in the same direction. futureSe asks the last for a later trial with another standard error (the true effect held).',
  'It is a comparison beside the stated value and never replaces it: the reference is every kind of trial in the database, so it describes a typical trial with this z statistic, not this drug, and it may shrink a trial of a drug with a strong mechanism more than it deserves. Say that when you report it.',
])

/** @type {Readonly<Record<string, readonly string[]>>} */
/** What a synthesis or a quality job reports beyond 1.0.0 (algorithm round P1, P2), for the model that writes the scenario. */
const SYNTHETIC_REPORT_NOTES = Object.freeze([
  'Every declared analysis is run on the real table and on every synthetic copy, and the copies are combined by the rules for synthetic data (Raab, Nowok and Dibben 2016, as synthpop prints them): the variance is (k / n) ubar (1 + n / (k m)) for n real rows, k rows a copy, m copies, the parameters not redrawn per copy. A table with a `copy` column is read as its copies. Kinds: mean, glm, cox (the log hazard ratio of target), logrank (the Peto log hazard ratio of the second group against the first, with the log-rank p-value) and rmst (the difference of the restricted mean survival times up to tau, second group less first); status is 1 for an event.',
  'inference.nullCalibration permutes the arm labels of the REAL table (the analysis needs a target or a group), makes copies from it the way the job makes them (synthpop CART; population.quality only when generator.family is "synthpop_cart"), runs the analysis and returns how often its interval excludes no effect when there is none: on the permuted real table, on the first copy read as if it were real data, and on the copies combined; each is simulated and carries its Monte Carlo error. replicates 20 to 1000 (default 100); a CPU budget that runs out keeps the finished ones.',
  'population.quality only: inference.parametersRedrawn true says the generator that made the table redrew its parameters for every copy (the proper-synthesis rule of Raab, Nowok and Dibben); the default false is the rule for a generator that does not, which is the engine\'s own. A table from a generator that does redraw them, read with the default rule, rejects a true null too often (.10 against .05 with one copy). A calibration is then not offered: the engine can only re-run its own generator.',
  'privacy needs a holdout: the share of real records whose membership risk (from the distance to the closest synthetic record, against the holdout) is above membershipRiskBound (default 0.75), beside the holdout\'s share, which is what chance alone gives; the kind of person the at-risk group is (a count of 1 to 9 people is never shown, and no row ever is); and attribute inference for the secret columns (default up to five categorical ones): an attacker who knows a person\'s other columns reads the closest synthetic record\'s value, and the success is held against the same attack on holdout people.',
])

/** What a prognostic model trained on the person's own table reports and does not (algorithm round P3), for the model that writes the scenario. */
const PROGNOSTIC_TRAIN_NOTES = Object.freeze([
  'Trains on the person\'s own historical table: Cox for a time-to-event outcome, logistic for a 0/1 outcome, linear for a continuous one, cross-fitted in `folds` folds (events dealt round the folds), so every figure is out of fold. A forest (ranger) is fitted on the same folds as a comparison only and is never saved. Each predictor states its unit (a text column is "category"); a text column becomes one indicator per level held by at least the small-cell size of people, the commonest level is the reference, and a person with a rarer level gets no prediction from the saved equation.',
  'The result holds the equation in the shape model.prognostic_apply takes, labelled as trained on the person\'s own data and not externally validated; to apply it to other people, bind the result as a model with vcr_write what=model and card.trainedResultId (the equation is the engine\'s, nothing in the card is), then vcr_simulate kind apply_prognostic_model with that modelId and modelVersion and the table to predict: the equation, endpoint, source condition and units are filled in by the platform; out-of-fold discrimination (C index, AUC or R squared), calibration slope and intercept, the correlation rho between score and outcome with its interval (for a time-to-event outcome the correlation with an event by the horizon among people whose status there is known, an approximation), and a table of PROCOVA sample-size savings under discounts lambda on the correlation and gamma on the control SD, from design.procova\'s own formula, at the estimated rho and at the lower end of its interval. A model that cannot be estimated (fewer than 10 events or non-events, or fewer than 5 per fitted parameter) is not_estimable, never invented.',
])

/**
 * What the forecast kinds' optional fields mean (they run in the control plane, so no schema row carries a description): one sentence
 * a field, for the model that writes a scenario. A batch forecast names what it is, what it depends on, where its actions came from
 * and which earlier version it updates.
 */
export const VCR_FORECAST_FIELD_NOTES = Object.freeze({
  'forecast.trajectories': Object.freeze({
    predictionMode: 'What the forecast is: factual_forecast (current care, no future actions; the default), conditional_forecast (depends on the schedule in actions) or intervention_comparison. A factual forecast takes no actions and a conditional one needs them.',
    actions: 'The schedule a conditional forecast depends on, [{ code, at: { value, unit }, dose?: { value, unit } }], applied to everyone. A time is converted to days and a dose only within its own dimension; one that cannot be converted refuses that action, never a guessed unit.',
    actionSource: 'Where the actions came from: none, supplied_schedule (stated at the origin; the default when actions are given) or logged_replay (recorded after the origin, per person). A logged replay tests the model given what really happened and is not a forecast anyone could have had at the origin.',
    actionHistoryId: 'The later history whose recorded actions are replayed (sets actionSource to logged_replay). Actions recorded after the prediction origin are never an input to an ordinary forecast.',
    priorPredictionId: 'The earlier prediction this one updates after new observations (the new history is the prediction\'s own); the result is then compared with the old version and with what was observed.',
  }),
  'forecast.compare': Object.freeze({
    outcomeHistoryId: 'A history holding the observed outcomes: both predictions are read against it as well as against each other (an update compared with what happened).',
  }),
})

/** What the disease-progression simulator is and is not (algorithm round P4), for the model that writes the scenario. */
const PROGRESSION_NOTES = Object.freeze([
  'A population-level simulator of the average course of a continuous score and how widely people scatter around it, from a model family the run takes from a publication: linear (slope), exponential (slope and acceleration), logistic (amplitude, midpoint, steepness) or emax (amplitude, halfTime). Every number is { value, basis: literature | assumed | data, citation? }: the source of a value is a premise the page shows, and nothing is built in: no disease, no parameter. The first visit is time zero, the baseline. The between-person spread (betweenPersonSd) is on the progression amplitude, correlated with the baseline by `correlation` (default 0).',
  'The treatment slows the clock: a treated person follows the same curve with time scaled by 1 - slowing. The result is the exact mean curve and spread by arm at every visit, and the power of the analysis (a Welch t-test of the change from baseline to `visit`, or of each person\'s least-squares slope over all the visits) by simulation with its Monte Carlo error, with the closed-form power of the same test beside it. With no slowing the same number is the type I error. It is a population-level curve and not a prediction for a person.',
  'family "beta_logit" (1.1.0) is a published model whose numbers are in the engine: parameterSet camd-adas-cog-11 / adsim-3.0 is the CAMD drug-disease-trial model of mild and moderate Alzheimer disease on ADAS-cog 11 (0 to 70, higher is worse), run with the 1,600 posterior draws its authors released; timeUnit must be "weeks" and the first visit 0. State no slope, spread, baseline, residual or slowing: those are the other families\'. population overrides the entry (mmseRange, default 16 to 26) and the covariate model (apoe4 shares for 0/1/2 alleles, femaleShare, ageMeanByApoe4, ageSd, ageBounds), each with its basis. placebo (default true) and dropoutModel ("parameter_set" or "none") switch those parts of the model.',
  'The drug is a hypothesis the run states, never a prediction for a compound: treatment.symptomatic is a difference in points (treated less untreated, negative is better) at atWeek for a person at referenceAdas, or a logitEmax, with et50Weeks and, when doseEnd is before the last visit, washoutHalfLifeWeeks; treatment.diseaseModifying.fraction is the share of the study\'s mean decline removed while on drug (kept after the dose ends). uncertainty: "new_study" draws one study per simulated trial (default), "typical_study" none, "posterior_draws" a posterior draw and then a study. analysis.kind "change" (Welch) or "ancova" (change on arm and baseline), among the people still observed at the visit. The curves are calculated for a typical study; the power is simulated. Report the premises the result lists (the parameters reproduce the EMA 2013 qualification opinion Tables 7, 9 and 11, not Table 10 or Figures 15-16; no regulatory status transfers); never recompute a number.',
  'From 1.2.0 treatment.symptomatic.pointsAt and treatment.diseaseModifying.fraction are either { value, basis } or { distribution: { family, parameters, source, tier } }, drawn once per simulated trial: family fixed (value), normal (mean, sd), truncated_normal (mean, sd, lower, upper), lognormal (meanlog, sdlog), beta (shape1, shape2), uniform (min, max) or empirical_draws (values); source { kind: literature | model_result | stated, with a citation, an objectRef or a note }; tier A (from a published fit of the compound\'s class), B (from a mechanism chain), C (a literature estimate with no model) or stated (the person\'s own). The result is then an assurance (named so): it counts every significant benefit, a null or irrelevant effect included, and is neither the chance that the drug works nor a programme\'s chance of success; more simulated trials shrink only its Monte Carlo error. A draw the model cannot represent is redrawn and the share is reported.',
  'From 1.2.0 the drug effect has an origin, named by tier on the result. Tier A: treatment.reference { drug: donepezil | galantamine | rivastigmine, doseMg, washoutHalfLifeWeeks (needed only when doseEnd is before the last visit) } is the treated arm taking that marketed inhibitor, instead of treatment.symptomatic: the effect is the posterior\'s own (the manual\'s equation: the effect at the reference dose of 5, 24 and 6 mg times (dose / reference dose) to the fitted exponent), one posterior row per trial under uncertainty "posterior_draws"; the range of the fitted doses is not published, so the same law applies at any dose and the result says so. treatment.background { drug, doseMg, weeksBefore } is an inhibitor both arms already take (an add-on trial), started weeksBefore weeks before baseline. The donepezil 10 mg effect at 26 weeks agrees with the Cochrane review (Birks and Harvey 2018, -2.67 points): a consistency check of the implementation, not an independent validation. Tier B: treatment.mechanism { drug: aducanumab, regimen { maintenanceMgPerKg, titrationMgPerKg (the first doses), intervalWeeks (default 4), infusionHours (default 1) }, atWeek, link } replaces diseaseModifying with the published chain from dose to serum concentration to amyloid PET SUVR (Muralidharan 2022) to ADAS-Cog (Pang 2023: 0.33 points per 0.1 SUVR, 95% CI 0.12 to 0.55, drawn per simulated trial), turned into the model\'s disease-modifying share by calculation at the typical study; the result is an assurance that holds only if that chain holds, with its three mismatches (scale, population, link) among its premises. lecanemab is not executable: its serum model is published and its amyloid model is not, and nothing is guessed. Never state a number of the chain yourself.',
  'From 1.2.0 intercurrent states what happens to a person besides finishing as planned, each number { value, basis }: discontinuation { shareControl, shareTreated (the share of each arm that stops the drug by the last visit), retrievedShare (of those, who stay in the study and are followed), progressionLogHazardPerSd (optional: positive means the person who declines fastest stops sooner, the missing-not-at-random case) }, withdrawal { treatedHazardRatio, progressionLogHazardPerSd } on the parameter set\'s own hazard of leaving, death { share } (scored as the worst value, 70, from that day) and offTreatment.reboundLogit. A person who stops keeps the symptomatic effect fading with washoutHalfLifeWeeks (required then) and the disease-modifying effect held. estimand.strategy is treatment_policy (everyone followed whatever happened) or hypothetical (nobody stops the drug): the result computes the true value of both from the model and gives the estimator\'s bias and 95% coverage against each. analysis.kind adds mmrm (unstructured, visit by arm and visit by baseline), cmi_jump_to_reference and cmi_copy_reference (conditional-mean imputation, jackknife standard error over jackknifeGroups); analysis.data is all_observed (default; for a reference-based imputation on_treatment) or on_treatment; analysis.delta adds points to what is imputed for the treated arm (the tipping-point delta). An estimator answers one estimand: say which the research question asked for and read the bias against it, never against the other.',
])

const METHOD_NOTES = Object.freeze({
  'comparator.entropy_balance': Object.freeze([...COMPARATOR_TIME_UNIT_NOTES, IMPUTATION_NOTE]),
  'comparator.propensity_weight': Object.freeze([...COMPARATOR_TIME_UNIT_NOTES, TRIM_NOTE, IMPUTATION_NOTE]),
  'comparator.covariate_sets': COMPARATOR_TIME_UNIT_NOTES,
  'comparator.weighted_cox': Object.freeze([...COMPARATOR_TIME_UNIT_NOTES, TRIM_NOTE, IMPUTATION_NOTE]),
  'comparator.aipw': Object.freeze([COMPARATOR_TIME_UNIT_NOTES[0], TRIM_NOTE, AIPW_TIME_TO_EVENT_NOTE, IMPUTATION_NOTE]),
  'comparator.bias_analysis': BIAS_ANALYSIS_NOTES,
  'comparator.stc': STC_NOTES,
  'comparator.borrowing': BORROWING_NOTES,
  'comparator.target_trial': TARGET_TRIAL_NOTES,
  'evidence.pool': Object.freeze([POOL_PRIOR_NOTE]),
  'evidence.network': NETWORK_NOTES,
  'evidence.dose_response': DOSE_RESPONSE_NOTES,
  'evidence.shrinkage': SHRINKAGE_NOTES,
  'decision.value_of_information': VOI_NOTES,
  'pk.interaction': PK_INTERACTION_NOTES,
  'comparator.maic_time_to_event': Object.freeze([...COMPARATOR_TIME_UNIT_NOTES, ...UNANCHORED_NOTES]),
  'comparator.rmst': COMPARATOR_TIME_UNIT_NOTES,
  'comparator.tipping_point': ROBUSTNESS_TIME_UNIT_NOTES,
  'comparator.prognostic_adjustment': ROBUSTNESS_TIME_UNIT_NOTES,
  'population.synthpop': Object.freeze([...vcrSynthpopHelpNotes(), ...SYNTHETIC_REPORT_NOTES]),
  'population.quality': SYNTHETIC_REPORT_NOTES,
  'model.prognostic_train': PROGNOSTIC_TRAIN_NOTES,
  'patients.progression': PROGRESSION_NOTES,
  'patients.continuous': PATIENT_PAIRING_NOTES,
  'patients.binary': PATIENT_PAIRING_NOTES,
  'patients.time_to_event': PATIENT_PAIRING_NOTES,
  'patients.longitudinal': Object.freeze([...PATIENT_PAIRING_NOTES,
    'dropoutPerVisit is the probability of leaving before each follow-up visit at an average outcome (missing completely at random unless dropoutModel says otherwise). dropoutModel makes the outcome decide who leaves: mechanism "mar" reads the previous value (what is missing is explained by what was seen), "mnar" the value at the visit itself (the missing value is the cause); logOddsPerSd is the change in the log-odds of leaving per standard deviation of the outcome, positive when people with higher values leave sooner. It needs dropoutPerVisit above 0. Say which mechanism was assumed: an analysis that ignores the dropout is biased under both, and a mixed model is right under "mar" and not under "mnar".',
    'rescue is an intercurrent event: before each follow-up visit a person not yet on rescue medication starts it with probability perVisit at an average previous value (logOddsPerSd makes it more likely after a high previous value, the usual case when rescue is given to people who are doing badly), and from that visit on the outcome is shifted by effect (negative lowers it). Every generated person is run through all the visits under both arms, so the result carries the two estimands as known truths (estimands): the treatment-policy effect at the last visit (the outcome as it comes, whatever was taken) and the hypothetical one (had there been no rescue; it is the model\'s own effect times the time scale), the share on rescue in each arm at the last visit, the plain comparison of those still in, and the people per arm each estimand needs for 80% and 90% power (one-sided 2.5%, a two-sample comparison of the last visit). Report the two estimands and say which one the question is about; never recompute them. The table gains a 0/1 column rescue.',
    'trajectory bends the mean: "plateau" (the change per time unit slows; halfTime is when the person is half way to the plateau) or "quadratic" (curvature); time enters as g(t) in place of t, g(0) = 0, so the arms start alike and the effect is the difference in the rate on that scale. A scenario that states none of dropoutModel, rescue and trajectory is the 1.1.0 generator to the bit.',
  ]),
  'model.survival_fit': ['Uses survival::survreg with a fixed intercept-only formula and four closed distributions, or distribution spline: a Royston-Parmar model of the log cumulative hazard with knots interior knots (0 to 4, default 2; 0 is a Weibull). It fits a population baseline, not an individual digital twin.', 'The spline family returns the median, the survival at each horizon and the restricted mean survival time to the LAST horizon, each with a delta-method interval, how many times the longest follow-up each horizon is (a horizon beyond it is an extrapolation along the Weibull-like tail the model implies, not an observation) and the same numbers for 0 to 3 knots: the spread between them is the model-form uncertainty of an extrapolation, which the interval does not include. It fits at least 5 events per parameter; a curve whose hazard would fall is not estimable. It has no design adapter: a spline fit is not a control distribution a trial scenario can use.', 'Declare and select the source treatment group before using a fit as a control baseline. Never infer exposure across an unobserved trial period. Select exactly one time/event row per observed patient; CNSR is a censor indicator and must use statusEncoding=censor. Reconstructed pseudo-IPD retains its source and omitted reconstruction uncertainty.', 'Median P10/P50/P90 describe delta-method parameter uncertainty, not patient-time percentiles or trial success probabilities. Baseline scenarios hold fitted shape fixed. Only exponential and Weibull currently have patient/design adapters; other fitted curves remain available. Observed survival-time units must agree with the frozen field map.'],
  'model.prognostic_apply': ['Apply only an immutable source-bound typed equation. Missing predictors, category mappings or units stay unknown; never fill them with zero. Observed predictor units come from the selected frozen field map, while synthetic units are explicit scenario declarations. Source horizon units stay bound to the literal publication.', 'Equation coefficients are linear-predictor beta. Source bindings explicitly declare coefficientScale=linear_predictor or ratio; positive Cox HR/logistic OR are converted once by log_of_ratio. Apply transform first, then subtract center and divide by scale, both on the transformed predictor scale. For a nonidentity transform, center bindings explicitly declare centerScale=transformed or source_raw; source_raw is converted with the same transform. A Cox equation without baseline survival yields relative scores only. Every centered baseline reference, including zero, needs its preserved numeric binding; standardized zero references remain valid. Baseline centering, horizon and units must match the publication.', 'Predicted control outcomes are descriptive benchmarks. They do not identify treatment effects, replace observed controls or increase effective sample size.', 'calibration (optional) holds the applied equation against the outcome the table itself has: outcomeColumn for a linear or logistic equation (a binary outcome is 0/1), timeColumn and statusColumn (1 = event) for a Cox equation. The result then reports the calibration intercept (ideal 0) and slope (ideal 1) with intervals, the observed and the predicted risk and why anything is missing: the slope needs at least 10 events and 10 non-events (10 pairs for a continuous outcome), with fewer only the intercept is reported, and with none of one kind there is no intercept either. The outcome must be observed, never a synthetic or predicted column. It is calibration in this table, not clinical validation, and it says nothing about any other population: the conclusion stays limited.'],
  'accrual.poisson_gamma': Object.freeze([
    'eventTarget counts events among every patient the forecast follows: the patients still to enrol and the patients already enrolled (the sum of explicitly supplied sites[].enrolled design assumptions; no operational ledger is read), so it is at most the target, or the patients already enrolled if there are more (scenario_value_invalid at eventTarget above that). The events of the enrolled patients are simulated, not read: the engine is given no observed event count, so it draws how long each enrolled patient has been followed from how long the site has been open (sites[].exposureTime) and an event time after enrolment from eventHazard; diagnostics.eventForecast says how many events that drew as already happened. With every patient already enrolled, last_patient_in_months is 0 and target_events_months is still forecast. Write eventHazard with eventTarget.',
  ]),
  'design.analytic': Object.freeze([
    HYPOTHESIS_NOTE,
  ]),
  'design.confirmatory': Object.freeze([
    'design.kind picks the question. futility_group_sequential: efficacy and futility boundaries for an interim-look design (the size, the expected size under the null and the alternative, the chance of stopping at each look). sample_size_reestimation: one interim look, the second stage sized so that the conditional power at the interim estimate reaches conditionalPower, between the planned second stage and maxSampleSizeFactor times the plan, reported for each assumed effect beside the fixed and the group-sequential design with the same alpha and power. design.promisingZone {lower, upper} (re-estimation only, optional) limits the enlargement to the trials whose conditional power at the interim, read at the interim estimate for the planned second stage, lies between the two bounds: below the lower bound or above the upper the planned size is kept, which stops the rule from enlarging the trials that have no effect; without it the second stage is sized at every interim estimate. multi_arm_selection: activeArms against one control, the arm(s) kept at the interim by selection.rule, closed testing with intersectionTest. enrichment: a biomarker-positive subset (subsetPrevalence of the patients) and the full population, one of them kept at the interim. count_endpoint: the sample size of a rate ratio for a count (negative binomial), fixed, or group sequential when informationRates is given.',
    'Effects are on the endpoint\'s own scale: a difference of means (continuous), a risk difference (binary: truth.controlRate plus the effect is the treatment rate), a hazard ratio (time to event, with truth.controlMedian and an accrual). ONE sign convention holds for all five kinds: for a mean or a risk, hypothesis.direction (required, never defaulted: ask which way is better) says whether a positive difference (higher_better) or a negative one (lower_better) is the benefit, and an adverse-event rate that should fall is lower_better with a negative effect; a hazard ratio and a rate ratio are a benefit below 1 and take no direction. truth.plannedEffect is the effect the size is planned for and must be a benefit: on the wrong side (a hazard ratio above 1, a difference against the direction) it is refused by name (effect_against_direction); the other effects (truth.effects, effectScenarios, subsetEffects) may be harm, to show what the design does there. truth.effects (re-estimation) lists the true effects to report. The null is ALWAYS added as a row (an effect of 0, a hazard ratio of 1, every arm at 0) so the type I error is shown; say nothing about it.',
    'alpha is one-sided (0.025 by default) and power 0.9 unless analysis states them. design.plannedSize: patients in total (events for a time-to-event design) for re-estimation and enrichment, patients PER ARM (the control too) for multi-arm and, for an event-time multi-arm design, the events in all at the final analysis (the arms still in the trial and the control); re-estimation takes the size of the group-sequential design with the same looks when it is not stated. Every default the engine takes is returned in confirmatory.assumed: report each one to the person as an assumption.',
    'A stopped run (the CPU budget) is returned as limited with the iterations each effect ran. Multi-arm and enrichment take continuous, binary and event-time endpoints; the event-time ones are simulated on the log-rank statistics from the planned events (proportional hazards, the same control hazard in every group, no accrual, follow-up or dropout), so they need no truth.controlMedian or accrual, their sizes are events, and the effects are hazard ratios. State accrual (duration, followup, dropoutAnnual) AND truth.controlMedian together and the result also gives people (expected_patients_from_events and max_patients_from_events: the events over the chance of an event of one person, not a simulation of enrolment); without them people are not computed (diagnostics.confirmatory.people says so), and a person who asks "how many people" is told that and which keys give them, never given a number worked out from the events. A group-sequential or re-estimation design on an event-time endpoint always gives expected_patients and max_patients (the people enrolled when the trial ends, with the looks falling before the accrual has ended): report those, do not convert events yourself. An enrichment design tests with simes or bonferroni (dunnett is refused by name). The result is read on the trial page; do not recompute any number of it.',
  ]),
  'design.dose': Object.freeze([
    'design.kind is the design asked about: three_plus_three, boin, keyboard or crm, simulated on truth.toxicity (the true toxicity of each dose, in order, never decreasing from one dose to the next; a CRM skeleton strictly increases; every design, 3+3 included, starts at design.startDose), or randomized_selection (exact, with truth.responseScenarios). design.compare lists other simulated designs to run on the SAME curve with the SAME random numbers: the result shows them side by side with the paired difference and its error. Report that comparison; do not recompute a number.',
    'Defaults the engine takes (each returned in doseFinding.assumed: report them as assumptions): target toxicity 0.3, cohorts of 3, 30 patients, start at dose 1, BOIN\'s safe and toxic rates 0.6 and 1.4 times the target and elimination at 0.95, the keyboard design\'s half-width 0.05, the CRM skeleton from a half-width of 0.05 around the target with the prior guess of the MTD at the starting dose (the skeleton matters a great deal: ask the person for one if they have it), prior variance 1.34, and no climbing more than one level or after a cohort at or above the target. 3+3 uses its own cohort size and number of patients.',
    'The true MTD is the dose whose true toxicity is closest to the target (the lower on a tie): correct_dose_probability is the chance the trial picks it; patients_above_mtd counts patients treated at higher doses. BOIN here is the local design with a non-informative prior; combinations and late-onset toxicity are not in it. Never say or imply that any design is qualified, endorsed or accepted by an agency.',
    'randomized_selection: the lowest dose is the candidate and a higher dose replaces it when its observed response rate is at least design.margin higher; correct means the lowest dose strictly within the margin of the best true rate. With design.perArm the result is the table at that size; without it the engine searches for the size per dose at which every scenario reaches design.targetProbability (default 0.9) and returns both the first such size and the first from which every larger size does (a count cut-off makes the probability saw-tooth). It is a selection rule of the kind the randomised dose-optimisation literature uses, not a copy of a published decision table.',
  ]),
  'design.bayesian': Object.freeze([
    'design.kind: bop2 (Bayesian optimal phase II) and predictive_monitoring are single-arm phase II designs for a response rate (truth.nullRate and truth.alternativeRate, a look every design.lookEvery patients up to design.maxN); threshold_calibration is the success rule "probability that the effect exceeds design.margin is above a threshold" for a two-arm trial under a conjugate prior (endpoint continuous with a known sd, time_to_event from the number of events, or binary with beta priors). Every number is exact: there is no simulation and no Monte-Carlo error.',
    'bop2 and predictive_monitoring return the stopping table (futility when the responses so far are at or below a count; success at the end at a count or more), the type I error, power and expected size under both rates, and Simon\'s optimal and minimax designs at the same alpha and power as the baseline: report the saving as the difference of two numbers the result carries. design.objective is max_power (the published BOP2 choice) or min_expected_n (the fewest expected patients under the null among the designs that keep alpha and reach the power): say which was used. alpha defaults to 0.05 and power to 0.8 for these two; the prior of the response rate is Beta(p0, 1 - p0) unless design.prior states one. State bop2.lambda and bop2.gamma, or predictive.final, to evaluate a design instead of searching. At most 60 looks (maxN / lookEvery); Simon\'s design is searched up to 100 patients, and left out of the result beyond that.',
    'threshold_calibration returns three rows: the threshold you stated (if any), the conventional 1 - alpha, and the calibrated threshold that makes the type I error the level (for a binary endpoint the discrete type I error is a step function, so the calibrated threshold is the smallest that keeps it at or below alpha, with the achieved level). The effect is positive when the treatment is better: a difference of means, a risk difference, or (time to event) a hazard ratio below design.margin (default 1). design.priorEffect is a normal prior on the effect (a log hazard ratio for time to event); left out, the prior is flat. alpha defaults to 0.025.',
  ]),
  'design.win_ratio': Object.freeze([
    'A hierarchical composite compared pair by pair: death first (truth.death: hazardRatio and either controlMedian or controlRisk, the proportion of control patients who die within the follow-up), then the number of events such as hospitalisations (truth.events: controlRate per person per time unit, rateRatio, overdispersion), then a score (truth.score: shift = treatment minus control at the end of follow-up, higher is better, sd, and threshold: a difference up to it is a tie). Death is required and at least one of events and score. The levels are compared in that order and a pair is decided at the first level that separates it; the rest are ties.',
    'State design.nTreat (and nControl, default equal) to get the power of the win-ratio test, or analysis.power to get the size of each arm (one patient count for both, searched by simulation; design.maxPerArm stops the search, default 1000, at most 1500): not both. The result carries the win ratio (wins over losses, with the range one trial of this size shows), the win difference, the win odds and the proportion of ties, and by level the share of pairs won, lost and left tied. Report the ties and the win difference beside the ratio. Everyone is followed for design.followup unless they die or leave (dropoutAnnual); alpha one-sided 0.025.',
    'The three levels are linked by one correlation (truth.correlation, default 0.3: a sicker patient dies earlier, has more events and a lower score). The events level takes that link through overdispersion (default 1), so without overdispersion it is independent of the others. Defaults the engine takes are returned in winRatio.assumed: report each one as an assumption. A formula for the power of a win ratio can differ from the simulation by ten points; this is the simulation. A stopped run (the CPU budget) is returned as limited with the trials that ran. Do not recompute any number of the result.',
  ]),
  'design.simulate': Object.freeze([
    HYPOTHESIS_NOTE,
    'A hazard ratio that changes over time is simulation-only: truth.treatmentHazardRatios = { breaks, ratios } gives the treatment arm\'s hazard as ratios[j] times the control\'s on the j-th interval of breaks (ratios has one more value than breaks, the last runs on), so a delayed effect is breaks [6], ratios [1, 0.6] and a crossing of the curves [6], [1.4, 0.6]. State it INSTEAD of truth.hazardRatio, not beside it; the analytic design (design_analytic) and the assurance refuse it by name. There is then no single true hazard ratio, so bias, mean squared error and coverage are not computed for the log-rank family, and no closed form is drawn for the power; an RMST analysis keeps its bias, against the RMST difference integrated from the two survival curves.',
    'analysis.method maxcombo (time-to-event, two-arm) is the most favourable of the four Fleming-Harrington weighted log-rank statistics G(0,0), G(0,1), G(1,0), G(1,1), its p-value read from their joint null distribution. It is never a default: the analysis is the log-rank unless you say otherwise, because the log-rank is often as good (it loses to MaxCombo mainly when the curves separate late or cross), and the choice is made before the data. Use it only for a hypothesis the person has stated (an effect that starts late, curves that separate late or cross), and run the log-rank beside it. A group-sequential design may analyse by maxcombo too (see below).',
    'analysis.method modestly_weighted (time-to-event, two-arm; the weight is 1 / max(S, sStar) of the pooled survival curve, sStar 0.5 unless stated, so a late event counts at most 1 / sStar times an early one) is the middle road between the log-rank test and a late-weighted test: it keeps most of the power of a late-weighted test when the effect starts late, and it protects against the false positives a late-weighted test gives when the treatment is worse early and equal later. Describe it by that protection, and run the log-rank beside it. It is never a default. The result carries the log-rank power on the same replicates and, for a design with an effect, the rejection probability of both tests under a strong null derived from the design (the treatment worse early, then equal), as MaxCombo does. A group-sequential design may use it too (see below).',
    'A group-sequential design (design.kind group_sequential, informationRates, spending) may analyse by maxcombo or modestly_weighted. Its boundaries have no closed form: the engine simulates the design under no effect (the same accrual, dropout and size, from another seed than the power run), takes the statistic at every look, and sets look k\'s boundary so that exactly the planned share of all those trials stops there (the spending function\'s increment at the look\'s information fraction, the events so far over the final events). The power and the type I error come from a separate run, so a null scenario\'s type I error is an independent check of the boundaries. The result says how many null trials the boundaries rest on; a look whose planned spend is below one trial cannot stop the trial and is listed. The log-rank power is reported beside it on the same trials, with its own asymptotic boundaries, as for the fixed design; the cost of the boundary run is real (about 20,000 trials of the design), so a large trial may end limited. Like maxcombo in a fixed design, it is not a default.',
  ]),
  'design.grid': Object.freeze([
    'From design.grid 1.3.0 the truth scenarios of one design share that design\'s random stream (common random numbers), where the generator makes that an honest pairing (two-arm designs); designs are never paired with each other and single-arm designs keep independent seeds. A difference between two truths of a design is then a cleaner comparison; each cell is still one immutable run, equal to the design.simulate job at its own seed. A truth that states treatmentHazardRatios replaces the base truth\'s hazardRatio (and the other way round).',
  ]),
  'population.check': Object.freeze([
    'subjectId is the existing population the check is about. `generated` is the population\'s own profile, filled in by the platform: do not write it (a scenario that carries one is refused). baselineTable is a SECOND baseline table, one that did not make the population, and baselineBindings bind each of its numbers to a verified evidence item exactly as a literature population\'s do; a table from the same evidence the population was built on is a comparison with the inputs, and the result says so.',
    'Each variable of the table is held against the same variable of the population, by its own distribution: a standardized difference for a continuous or binary variable, the total variation distance for a categorical one, "close" at or under 0.1 and "apart" above it. The joint structure, the shape and the tails of the distributions and any subgroup are not compared, so the result is not a validation of the population; say what it covered and what it did not. referenceN (the second table\'s sample size, when its source gives it) adds the standard error of each difference.',
  ]),
  'comparator.map_prior': Object.freeze([
    'tauPrior is the prior on the between-study spread tau, on the analysis scale (a logit for events / n): half_normal has density proportional to exp(-tau^2 / (2 scale^2)), half_cauchy proportional to 1 / (1 + (tau / scale)^2) over the whole half line, and uniform is flat on [0, scale] and zero beyond scale. With two historical studies a half-Cauchy prior leaves the predictive spread without a finite value (diagnostics.tauPrior says so); three or more, or a half-normal prior, make it finite. current.estimate and current.se are on the analysis scale as well: the logit of the control rate (and its standard error on that scale) on the events / n path, the scale of historical.estimate on the estimate / se path.',
  ]),
  'design.assurance': Object.freeze([
    'design.allocation is the share allocated to treatment. On a time-to-event endpoint it enters the power calculation. On a continuous or binary endpoint the arms are sized by nTreat and nControl: a stated allocation sizes the control arm when nControl is absent (nControl = nTreat x (1 - allocation) / allocation), and a stated nControl is used as it is, with an allocation it contradicts named in diagnostics.notApplied.',
  ]),
  'comparator.maic': Object.freeze([
    'Arms. Anchored: treatmentColumn is the arm column of the IPD trial (1 = the active arm, 0 = the common comparator) and outcomeColumn the outcome the arms\' weighted means are taken of. Unanchored: the IPD patients are the active arm; naming treatmentColumn selects the rows of arm 1 (a table that holds both arms of a trial), without it every row is the active arm. A treatmentColumn the table cannot honour (not in the table, not a complete 1/0 column, no row in arm 1) is reported in diagnostics.notApplied with the reason and every row is used.',
    'Scales. Unanchored: aggregateOutcome and aggregateSe are the aggregate trial\'s outcome and its standard error on the outcome\'s OWN scale (a proportion for link logit, a positive mean or rate for link log, any number for identity), the scale of the outcomeColumn\'s mean; the engine applies the link to the level and the delta method to the standard error. A level outside the link\'s domain (a proportion not strictly between 0 and 1 on logit, a mean not above 0 on log) is refused (scenario_value_invalid). Anchored: aggregateEstimate and aggregateSe are already the aggregate trial\'s contrast and its standard error on the link scale (a log odds ratio, a log risk ratio, a mean difference).',
    ...UNANCHORED_NOTES,
  ]),
})

/** The file's rendering of one method. @param {string} method */
function methodEntry(method) {
  const { rows, rules } = vcrScenarioRows(method)
  const schema = /** @type {Record<string, any>} */ (VCR_SCENARIO_SCHEMAS)[method]
  const spec = /** @type {Record<string, any>} */ (VCR_ENGINE_METHODS)[method]
  const notes = [...designNotes(method), .../** @type {Record<string, readonly string[]>} */ (METHOD_NOTES)[method] ?? []]
  const templates = /** @type {Record<string, any>} */ (VCR_MINIMAL_TEMPLATES)[method]
  return compact({
    endpoints: [...spec.endpoints],
    designs: /** @type {Record<string, any>} */ (VCR_DESIGN_SUPPORT)[method] ? JSON.parse(JSON.stringify(/** @type {Record<string, any>} */ (VCR_DESIGN_SUPPORT)[method])) : undefined,
    gridCells: schema.gridCells,
    notes: notes.length ? notes : undefined,
    // Every key says what it asks of a person (research fact or defaultable; an object is only its keys): derived from the row, never kept as a list.
    rows: rows.map((row) => { const fieldRole = vcrRowRole(row, { rules }); return fieldRole ? { ...row, fieldRole } : row }),
    rules: rules.length ? rules : undefined,
    templates: templates ? JSON.parse(JSON.stringify(templates)) : undefined,
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
  // The forecast kinds run in the control plane, not the engine: their scenario is a few references to stored histories,
  // forecasts and outcomes plus options, read off `VCR_LONGITUDINAL_SCHEMAS` (the validator's own lists).
  /** @type {Record<string, { required: string[], optional: string[], fields?: Record<string, string> }>} */
  const longitudinal = {}
  for (const [method, schema] of Object.entries(VCR_LONGITUDINAL_SCHEMAS)) {
    const notes = /** @type {Record<string, Record<string, string>>} */ (VCR_FORECAST_FIELD_NOTES)[method]
    longitudinal[method] = { required: [.../** @type {any} */ (schema).required], optional: [.../** @type {any} */ (schema).optional], ...(notes ? { fields: { ...notes } } : {}) }
  }
  return {
    schemaVersion: VCR_SCENARIO_HELP_VERSION,
    description: 'Generated by scripts/build/generate-vcr-scenario-help.mjs from packages/domain/src/vcrScenarioSchemas.mjs (the schemas the validator and the engine enforce) and the examples in packages/domain/src/vcrScenarioHelp.mjs. Do not edit by hand: change the schema, then run `pnpm generate:vcr-scenario-help`.',
    kinds,
    methods,
    longitudinal,
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
