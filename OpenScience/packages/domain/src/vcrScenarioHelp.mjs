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
  pool_evidence: Object.freeze(['parameter', 'endpointKey', 'calibres', 'armRole', 'target', 'method']),
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
 *   increasing?: boolean, last?: number, unique?: boolean, size?: string }} VcrHelpRow
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
  'population.synthpop': [{ label: 'a synthetic copy of the study table', scenario: { holdoutShare: 0.2, m: 5, constraints: [{ name: 'age', rule: { op: 'between', column: 'age', low: 18, high: 100 } }] } }],
  'population.quality': [{ label: 'a synthetic table against its training table', scenario: { trainingInputId: 'snp_1:subject', syntheticInputId: 'pop_synth@1' } }],
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
  'comparator.maic': [{ label: 'an unanchored indirect comparison on a binary outcome: the aggregate trial\'s response rate is 0.42 (standard error 0.05), on the logit link', scenario: {
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
    { label: 'non-inferiority: the treatment is expected to be as good as the control (hazard ratio 1) and must not be worse than a hazard ratio of 1.3', scenario: {
      design: { kind: 'two_arm_fixed' }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 1, controlMedian: 12 }, hypothesis: { kind: 'non_inferiority', margin: 1.3 },
      analysis: { alpha: 0.025, power: 0.9 }, accrual: { duration: 12, followup: 24 } } },
  ],
  'design.confirmatory': [
    { label: 'stop for futility: three looks, efficacy and futility boundaries for a mean difference of 0.4 standard deviations', scenario: {
      design: { kind: 'futility_group_sequential', informationRates: [0.4, 0.7, 1] }, endpoint: { type: 'continuous' }, truth: { plannedEffect: 0.4, sd: 1 }, analysis: { alpha: 0.025, power: 0.9 } } },
    { label: 're-estimate the sample size at an interim look when the effect is uncertain: planned for a hazard ratio of 0.7, reported at 0.8 and 0.7 (the null is added)', scenario: {
      design: { kind: 'sample_size_reestimation', informationRates: [0.5, 1], conditionalPower: 0.8, maxSampleSizeFactor: 1.5 }, endpoint: { type: 'time_to_event' },
      truth: { plannedEffect: 0.7, effects: [0.8, 0.7], controlMedian: 12 }, accrual: { duration: 12, followup: 12, dropoutAnnual: 0.05 } } },
    { label: 'the same re-estimation with a promising zone: enlarge only when the conditional power at the interim is between 36% and 80% (the null is added)', scenario: {
      design: { kind: 'sample_size_reestimation', informationRates: [0.5, 1], conditionalPower: 0.8, maxSampleSizeFactor: 2, promisingZone: { lower: 0.36, upper: 0.8 } }, endpoint: { type: 'continuous' },
      truth: { plannedEffect: 0.4, effects: [0.2, 0.3], sd: 1 } } },
    { label: 'three doses against one control, the best dose kept at the interim (80 patients per arm planned)', scenario: {
      design: { kind: 'multi_arm_selection', informationRates: [0.5, 1], activeArms: 3, plannedSize: 80 }, endpoint: { type: 'continuous' },
      truth: { effectScenarios: [[0.2, 0.4, 0.6], [0.3, 0.3, 0.3]], sd: 1 } } },
    { label: 'three doses against one control for an event-time endpoint: hazard ratios 0.9, 0.75 and 0.6, the best dose kept at the interim (240 events planned in all, no accrual or control median needed)', scenario: {
      design: { kind: 'multi_arm_selection', informationRates: [0.5, 1], activeArms: 3, plannedSize: 240 }, endpoint: { type: 'time_to_event' },
      truth: { effectScenarios: [[0.9, 0.75, 0.6]] } } },
    { label: 'a biomarker-positive subset of 40% for an event-time endpoint: hazard ratio 0.6 in the subset and 0.9 outside it (240 events planned)', scenario: {
      design: { kind: 'enrichment', informationRates: [0.5, 1], subsetPrevalence: 0.4, plannedSize: 240 }, endpoint: { type: 'time_to_event' },
      truth: { subsetEffects: [{ subset: 0.6, rest: 0.9 }] } } },
    { label: 'a biomarker-positive subset of 40%: enrol everyone, keep the subset or everyone at the interim (200 patients planned)', scenario: {
      design: { kind: 'enrichment', informationRates: [0.5, 1], subsetPrevalence: 0.4, plannedSize: 200 }, endpoint: { type: 'binary' },
      truth: { subsetEffects: [{ subset: 0.25, rest: 0 }, { subset: 0.15, rest: 0.15 }], controlRate: 0.3 } } },
    { label: 'a count endpoint (attacks per patient-year): rate ratio 0.67 on a control rate of 0.6, overdispersion 0.5', scenario: {
      design: { kind: 'count_endpoint' }, truth: { controlEventRate: 0.6, rateRatio: 0.67, overdispersion: 0.5, exposureTime: 1 } } },
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
 * The hypothesis of a two-arm design (T1): said to the run that writes it, so that a margin is the person's own choice and a design
 * without one is read as a superiority design.
 */
const HYPOTHESIS_NOTE = 'hypothesis is for a two-arm design and is left out for superiority (the default). { kind: "non_inferiority", margin } tests that the treatment is not worse than the control by more than the margin: margin is a positive number in the outcome\'s units for a mean, a risk difference below 1 for a binary endpoint (the treatment rate may be this far below the control\'s), and a hazard ratio above 1 for an event-time endpoint (the largest ratio still counted as not worse). The margin is a clinical choice: ask for it, never invent one. truth then states the effect the treatment is EXPECTED to have (often 0, or a hazard ratio of 1), not the margin; design.simulate measures the type I error by putting the truth on the margin itself. The test is one-sided; analysis.method is the t-test, the risk difference or the log-rank test.'

/** @type {Readonly<Record<string, readonly string[]>>} */
const METHOD_NOTES = Object.freeze({
  'comparator.entropy_balance': COMPARATOR_TIME_UNIT_NOTES,
  'comparator.propensity_weight': COMPARATOR_TIME_UNIT_NOTES,
  'comparator.covariate_sets': COMPARATOR_TIME_UNIT_NOTES,
  'comparator.weighted_cox': COMPARATOR_TIME_UNIT_NOTES,
  'comparator.maic_time_to_event': Object.freeze([...COMPARATOR_TIME_UNIT_NOTES, ...UNANCHORED_NOTES]),
  'comparator.rmst': COMPARATOR_TIME_UNIT_NOTES,
  'comparator.tipping_point': ROBUSTNESS_TIME_UNIT_NOTES,
  'comparator.prognostic_adjustment': ROBUSTNESS_TIME_UNIT_NOTES,
  'population.synthpop': vcrSynthpopHelpNotes(),
  'patients.continuous': PATIENT_PAIRING_NOTES,
  'patients.binary': PATIENT_PAIRING_NOTES,
  'patients.time_to_event': PATIENT_PAIRING_NOTES,
  'patients.longitudinal': PATIENT_PAIRING_NOTES,
  'model.survival_fit': ['Uses survival::survreg with a fixed intercept-only formula and four closed distributions. It fits a population baseline, not an individual digital twin.', 'Declare and select the source treatment group before using a fit as a control baseline. Never infer exposure across an unobserved trial period. Select exactly one time/event row per observed patient; CNSR is a censor indicator and must use statusEncoding=censor. Reconstructed pseudo-IPD retains its source and omitted reconstruction uncertainty.', 'Median P10/P50/P90 describe delta-method parameter uncertainty, not patient-time percentiles or trial success probabilities. Baseline scenarios hold fitted shape fixed. Only exponential and Weibull currently have patient/design adapters; other fitted curves remain available. Observed survival-time units must agree with the frozen field map.'],
  'model.prognostic_apply': ['Apply only an immutable source-bound typed equation. Missing predictors, category mappings or units stay unknown; never fill them with zero. Observed predictor units come from the selected frozen field map, while synthetic units are explicit scenario declarations. Source horizon units stay bound to the literal publication.', 'Equation coefficients are linear-predictor beta. Source bindings explicitly declare coefficientScale=linear_predictor or ratio; positive Cox HR/logistic OR are converted once by log_of_ratio. Apply transform first, then subtract center and divide by scale, both on the transformed predictor scale. For a nonidentity transform, center bindings explicitly declare centerScale=transformed or source_raw; source_raw is converted with the same transform. A Cox equation without baseline survival yields relative scores only. Every centered baseline reference, including zero, needs its preserved numeric binding; standardized zero references remain valid. Baseline centering, horizon and units must match the publication.', 'Predicted control outcomes are descriptive benchmarks. They do not identify treatment effects, replace observed controls or increase effective sample size.', 'calibration (optional) holds the applied equation against the outcome the table itself has: outcomeColumn for a linear or logistic equation (a binary outcome is 0/1), timeColumn and statusColumn (1 = event) for a Cox equation. The result then reports the calibration intercept (ideal 0) and slope (ideal 1) with intervals, the observed and the predicted risk and why anything is missing: the slope needs at least 10 events and 10 non-events (10 pairs for a continuous outcome), with fewer only the intercept is reported, and with none of one kind there is no intercept either. The outcome must be observed, never a synthetic or predicted column. It is calibration in this table, not clinical validation, and it says nothing about any other population: the conclusion stays limited.'],
  'accrual.poisson_gamma': Object.freeze([
    'eventTarget counts events among every patient the forecast follows: the patients still to enrol and the patients already enrolled (the sum of explicitly supplied sites[].enrolled design assumptions; no operational ledger is read), so it is at most the target, or the patients already enrolled if there are more (scenario_value_invalid at eventTarget above that). The events of the enrolled patients are simulated, not read: the engine is given no observed event count, so it draws how long each enrolled patient has been followed from how long the site has been open (sites[].exposureTime) and an event time after enrolment from eventHazard; diagnostics.eventForecast says how many events that drew as already happened. With every patient already enrolled, last_patient_in_months is 0 and target_events_months is still forecast. Write eventHazard with eventTarget.',
  ]),
  'design.analytic': Object.freeze([
    HYPOTHESIS_NOTE,
  ]),
  'design.confirmatory': Object.freeze([
    'design.kind picks the question. futility_group_sequential: efficacy and futility boundaries for an interim-look design (the size, the expected size under the null and the alternative, the chance of stopping at each look). sample_size_reestimation: one interim look, the second stage sized so that the conditional power at the interim estimate reaches conditionalPower, between the planned second stage and maxSampleSizeFactor times the plan, reported for each assumed effect beside the fixed and the group-sequential design with the same alpha and power. design.promisingZone {lower, upper} (re-estimation only, optional) limits the enlargement to the trials whose conditional power at the interim, read at the interim estimate for the planned second stage, lies between the two bounds: below the lower bound or above the upper the planned size is kept, which stops the rule from enlarging the trials that have no effect; without it the second stage is sized at every interim estimate. multi_arm_selection: activeArms against one control, the arm(s) kept at the interim by selection.rule, closed testing with intersectionTest. enrichment: a biomarker-positive subset (subsetPrevalence of the patients) and the full population, one of them kept at the interim. count_endpoint: the sample size of a rate ratio for a count (negative binomial), fixed, or group sequential when informationRates is given.',
    'Effects are on the endpoint\'s own scale: a difference of means (continuous), a risk difference (binary: truth.controlRate plus the effect is the treatment rate), a hazard ratio (time to event, with truth.controlMedian and an accrual). truth.plannedEffect is the effect the size is planned for; truth.effects (re-estimation) lists the true effects to report. The null is ALWAYS added as a row (an effect of 0, a hazard ratio of 1, every arm at 0) so the type I error is shown; say nothing about it.',
    'alpha is one-sided (0.025 by default) and power 0.9 unless analysis states them. design.plannedSize: patients in total (events for a time-to-event design) for re-estimation and enrichment, patients PER ARM (the control too) for multi-arm and, for an event-time multi-arm design, the events in all at the final analysis (the arms still in the trial and the control); re-estimation takes the size of the group-sequential design with the same looks when it is not stated. Every default the engine takes is returned in confirmatory.assumed: report each one to the person as an assumption.',
    'A stopped run (the CPU budget) is returned as limited with the iterations each effect ran. Multi-arm and enrichment take continuous, binary and event-time endpoints; the event-time ones are simulated on the log-rank statistics from the planned events (proportional hazards, the same control hazard in every group, no accrual, follow-up or dropout), so they need no truth.controlMedian or accrual, their sizes are events, and the effects are hazard ratios. An enrichment design tests with simes or bonferroni (dunnett is refused by name). The result is read on the trial page; do not recompute any number of it.',
  ]),
  'design.simulate': Object.freeze([
    HYPOTHESIS_NOTE,
    'A hazard ratio that changes over time is simulation-only: truth.treatmentHazardRatios = { breaks, ratios } gives the treatment arm\'s hazard as ratios[j] times the control\'s on the j-th interval of breaks (ratios has one more value than breaks, the last runs on), so a delayed effect is breaks [6], ratios [1, 0.6] and a crossing of the curves [6], [1.4, 0.6]. State it INSTEAD of truth.hazardRatio, not beside it; the analytic design (design_analytic) and the assurance refuse it by name. There is then no single true hazard ratio, so bias, mean squared error and coverage are not computed for the log-rank family, and no closed form is drawn for the power; an RMST analysis keeps its bias, against the RMST difference integrated from the two survival curves.',
    'analysis.method maxcombo (time-to-event, two-arm, fixed design only) is the most favourable of the four Fleming-Harrington weighted log-rank statistics G(0,0), G(0,1), G(1,0), G(1,1), its p-value read from their joint null distribution. It is never a default: the analysis is the log-rank unless you say otherwise, because the log-rank is often as good (it loses to MaxCombo mainly when the curves separate late or cross), and the choice is made before the data. Use it only for a hypothesis the person has stated (an effect that starts late, curves that separate late or cross), and run the log-rank beside it. A group-sequential design looks with the log-rank and refuses maxcombo.',
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
  /** @type {Record<string, { required: string[], optional: string[] }>} */
  const longitudinal = {}
  for (const [method, schema] of Object.entries(VCR_LONGITUDINAL_SCHEMAS)) {
    longitudinal[method] = { required: [.../** @type {any} */ (schema).required], optional: [.../** @type {any} */ (schema).optional] }
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
