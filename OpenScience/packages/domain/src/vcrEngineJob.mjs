/**
 * The engine protocol: what a frozen scenario is, and what comes back.
 *
 * Hidden knowledge:
 *
 * - **The control plane and `vcr-engine` are written in different languages,
 *   so the contract lives here and nowhere else.** The server validates a job
 *   before it queues it; the engine validates the same job before it runs it
 *   (`R/protocol.R` reads the vocabularies, the per-method scenario schemas and
 *   the patterns out of `R/domain-snapshot.json`, and case N00 holds the two
 *   verdicts equal on a fixture set of jobs). A field neither side knows is
 *   refused by name rather than ignored, because an ignored field is a silent
 *   parameter change: the first build sent `dropoutRate` where the engine read
 *   `dropoutAnnual`, and every simulation ran with no dropout.
 * - **A job is frozen, not referenced.** Every input a run used — assumption
 *   values, population version, method version, seed, replicate count, the
 *   snapshot's hash — is copied into the job. Re-reading a row later would
 *   make a result unreproducible the moment anyone edits an assumption, which
 *   is exactly the moment reproducibility matters (plan §3.4, §5.4).
 * - **Two stages, two validators.** A caller (a browser route, the runtime's
 *   gateway, the orchestrator) names patient-level data only as
 *   `{ kind: "snapshot", id }`; `validateCallerInputs` refuses a `location`, a
 *   `hash`, a `shape` or a `valueSource` it supplied. The control plane checks
 *   the grant and turns each such input into engine inputs — `analysis_table`
 *   or `snapshot_file`, with a data-plane-relative `location`, the file's
 *   sha256 and a `valueSource` — and `validateEngineJob` checks the job the
 *   engine will actually receive. A location the engine opens is never one a
 *   caller wrote (contract §3.2).
 * - **No hashing here.** This package is browser-safe and imports nothing
 *   Node-only, so it produces the canonical bytes (`canonicalScenarioJson`,
 *   `vcrResultOutputPayload`) and the caller hashes them. Both sides hash the
 *   same bytes: sorted keys (UTF-16 order, integer-like keys first — what
 *   `JSON.stringify` does to the object built from them), `null` kept,
 *   `undefined` dropped, `{}` distinct from `[]`, numbers as ECMAScript prints
 *   them. `R/protocol.R` reproduces exactly that.
 * - **Replicates follow from the precision asked for, not from a habit.** A
 *   proportion measured to a Monte-Carlo standard error of `target` needs
 *   `p(1-p)/target²` replicates — for a one-sided 0.025 type-I error measured
 *   to 0.001 that is 24,375 (plan §5.4, case N05). Under the null `p` is alpha,
 *   not 0.5: the 20,000 floor is what alpha = 0.025 needs for a Monte-Carlo
 *   standard error of 0.0011. The floors in `vcrVocabulary.mjs` apply on top.
 * - **Every reported number carries its Monte-Carlo standard error** (AC-28).
 *   A result that omits `mcse` for a simulated measure is refused here, not in
 *   review.
 *
 * @module @evimed/domain/vcrEngineJob
 */

import {
  VCR_ANALYSIS_TABLES, VCR_CONCLUSIONS, VCR_ENDPOINT_TYPES, VCR_INTERVAL_KINDS, VCR_JOB_KINDS, VCR_MODEL_RISKS,
  VCR_MODEL_TIERS, VCR_NOT_ESTIMABLE_RULES, VCR_REPLICATES_ALT_MIN, VCR_REPLICATES_NULL_MIN, VCR_TRIAL_DESIGNS,
  VCR_REAL_PATIENT_SOURCES, VCR_VALUE_SOURCES,
} from './vcrVocabulary.mjs'
import { VCR_DESIGN_SUPPORT, validateScenario, vcrIsNullScenario } from './vcrScenarioSchemas.mjs'

// The schemas live in their own module (they are the file most likely to be
// edited); the protocol's callers find them here, beside the validators.
export { VCR_DESIGN_SUPPORT, VCR_SCENARIO_SCHEMAS, vcrIsNullScenario } from './vcrScenarioSchemas.mjs'

/** @template T @param {readonly T[]} list @returns {readonly T[]} */
const frozen = (list) => Object.freeze([...list])

/** The protocol's own version. A change that is not backward compatible bumps it. */
export const VCR_ENGINE_PROTOCOL_VERSION = 1

/**
 * The methods the engine publishes, each with the version its numbers were
 * validated at (plan §11.4, §12.4). `crossChecks` names the independent
 * implementation or reference software the numeric cases compare against.
 * `modelTier` is the credibility tier the method's output carries on its own
 * (plan §3.6, §8.2), or `null` for a method that is no model at all (profiling,
 * a cohort filter, an eligibility verdict): it is recorded here so the control
 * plane attaches a tier to a result without asking the engine to describe
 * itself, and `intendedUseCeilingFor` reads it.
 */
export const VCR_ENGINE_METHODS = Object.freeze({
  'profile.snapshot': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen(['profile_dataset.py']), modelTier: null },
  'cohort.build': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen([]), modelTier: null },
  'population.scenario': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen(['simstudy semantics']), modelTier: 'scenario' },
  'population.literature': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen([]), modelTier: 'literature' },
  'population.synthpop': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen(['synthpop']), modelTier: 'data' },
  'population.quality': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen([]), modelTier: 'data' },
  'patients.continuous': { version: '1.0.0', endpoints: frozen(['continuous']), crossChecks: frozen([]), modelTier: 'scenario' },
  'patients.binary': { version: '1.0.0', endpoints: frozen(['binary']), crossChecks: frozen([]), modelTier: 'scenario' },
  'patients.time_to_event': { version: '1.0.0', endpoints: frozen(['time_to_event']), crossChecks: frozen(['simsurv']), modelTier: 'scenario' },
  'evidence.pool': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen(['metafor', 'meta engine']), modelTier: 'literature' },
  'evidence.reconstruct_km': { version: '1.0.0', endpoints: frozen(['time_to_event']), crossChecks: frozen(['IPDfromKM']), modelTier: 'literature' },
  'comparator.entropy_balance': { version: '1.0.0', endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen(['WeightIt', 'cobalt']), modelTier: 'data' },
  'comparator.propensity_weight': { version: '1.0.0', endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen(['WeightIt']), modelTier: 'data' },
  'comparator.rmst': { version: '1.0.0', endpoints: frozen(['time_to_event']), crossChecks: frozen(['survRM2']), modelTier: 'data' },
  'comparator.maic': { version: '1.0.0', endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen(['NICE DSU TSD 18']), modelTier: 'data' },
  'comparator.evalue': { version: '1.0.0', endpoints: frozen(['binary', 'time_to_event']), crossChecks: frozen(['EValue']), modelTier: 'scenario' },
  'comparator.map_prior': { version: '1.0.0', endpoints: frozen(['binary', 'continuous']), crossChecks: frozen(['RBesT']), modelTier: 'literature' },
  'design.analytic': { version: '1.1.0', legacyVersion: '1.0.0', legacyDesigns: frozen(['two_arm_fixed', 'group_sequential', 'simon_two_stage']), endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen(['rpact', 'gsDesign', 'stats::binom.test', 'Simon 1989']), modelTier: 'scenario' },
  'design.simulate': { version: '1.1.0', legacyVersion: '1.0.0', legacyDesigns: frozen(['two_arm_fixed', 'group_sequential']), endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen(['design.analytic', 'independent beta-binomial variance']), modelTier: 'scenario' },
  'design.grid': { version: '1.1.0', legacyVersion: '1.0.0', legacyDesigns: frozen(['two_arm_fixed', 'group_sequential']), endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen([]), modelTier: 'scenario' },
  'design.assurance': { version: '1.0.0', endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen(["O'Hagan 2005"]), modelTier: 'scenario' },
  'design.procova': { version: '1.0.0', endpoints: frozen(['continuous']), crossChecks: frozen(['EMA 2022 qualification opinion']), modelTier: 'scenario' },
  'accrual.poisson_gamma': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen(['Anisimov & Fedorov 2007']), modelTier: 'scenario' },
  'matching.evaluate': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen(['Kleene truth table']), modelTier: null },
  // --- robustness methods (2026-10-04). A new method is a new entry here, a job kind, a schema and a handler; none of the methods above changed. ---
  'comparator.negative_control': { version: '1.0.0', endpoints: frozen(['binary', 'time_to_event']), crossChecks: frozen(['EmpiricalCalibration 3.1.4 (sccs example)', 'Lipsitch 2010', 'Schuemie 2014']), modelTier: 'data' },
  'comparator.tipping_point': { version: '1.0.0', endpoints: frozen(['binary', 'time_to_event']), crossChecks: frozen(['stats::fisher.test and stats::binom.test', 'closed-form worst case (censoring as event)', 'Jackson et al. 2014']), modelTier: 'data' },
  'comparator.prognostic_adjustment': { version: '1.0.0', endpoints: frozen(['binary', 'time_to_event']), crossChecks: frozen(['FDA 2023 covariate-adjustment guidance, Table 1', 'M-estimation sandwich by numerical Jacobians', 'survival::coxph and survfit(newdata)']), modelTier: 'data' },
  // --- end robustness methods ---
})

export const VCR_ENGINE_METHOD_IDS = frozen(Object.keys(VCR_ENGINE_METHODS))

/**
 * Which method each job kind runs. This is also the kind ↔ method pairing:
 * a job whose `method` is not the one its `kind` runs is refused
 * (`kind_method_mismatch`), because the two are checked independently
 * everywhere else and a mismatch would otherwise queue the wrong computation.
 */
export const VCR_JOB_METHODS = Object.freeze({
  profile_snapshot: 'profile.snapshot',
  build_cohort: 'cohort.build',
  generate_population: 'population.scenario',
  literature_population: 'population.literature',
  synthesize_population: 'population.synthpop',
  population_quality: 'population.quality',
  generate_patients: 'patients.time_to_event',
  generate_patients_continuous: 'patients.continuous',
  generate_patients_binary: 'patients.binary',
  reconstruct_km: 'evidence.reconstruct_km',
  pool_evidence: 'evidence.pool',
  weight_comparator: 'comparator.entropy_balance',
  propensity_weight_comparator: 'comparator.propensity_weight',
  maic_comparator: 'comparator.maic',
  evalue: 'comparator.evalue',
  rmst: 'comparator.rmst',
  design_analytic: 'design.analytic',
  design_simulation: 'design.simulate',
  design_grid: 'design.grid',
  assurance: 'design.assurance',
  procova: 'design.procova',
  accrual_forecast: 'accrual.poisson_gamma',
  map_prior: 'comparator.map_prior',
  match_criteria: 'matching.evaluate',
  // --- robustness methods ---
  negative_control_comparator: 'comparator.negative_control',
  tipping_point: 'comparator.tipping_point',
  prognostic_adjustment_comparator: 'comparator.prognostic_adjustment',
  // --- end robustness methods ---
})

/** Job kinds that read patient-level rows, and so need a snapshot grant (plan §8.1). */
export const VCR_PATIENT_LEVEL_JOB_KINDS = frozen([
  'profile_snapshot', 'build_cohort', 'synthesize_population', 'population_quality',
  'weight_comparator', 'propensity_weight_comparator', 'rmst', 'match_criteria',
  'prognostic_adjustment_comparator',
])

/**
 * Methods that weigh, adjust or compare real patients, and the value sources
 * each accepts for a patient-level table (contract §3.2, amended after wave A).
 * A real person's row stays a real person's row when a value in it was
 * extracted from text, calculated from other fields or imputed, so those
 * sources pass with `observed`; a synthetic, aggregate, predicted or assumed
 * table is not a person, and entering one into an external control is the
 * error the value sources exist to prevent (plan §5.1, §5.3; AC-27). RMST also
 * reads the pseudo-patients a Guyot reconstruction produced — the literature
 * control route — and counts them apart, never as real patients.
 */
export const VCR_INDIVIDUAL_INPUT_SOURCES = Object.freeze({
  'population.synthpop': VCR_REAL_PATIENT_SOURCES,
  'comparator.entropy_balance': VCR_REAL_PATIENT_SOURCES,
  'comparator.propensity_weight': VCR_REAL_PATIENT_SOURCES,
  'comparator.maic': VCR_REAL_PATIENT_SOURCES,
  // robustness methods
  'comparator.negative_control': VCR_REAL_PATIENT_SOURCES,
  'comparator.tipping_point': VCR_REAL_PATIENT_SOURCES,
  'comparator.prognostic_adjustment': VCR_REAL_PATIENT_SOURCES,
  'comparator.rmst': frozen([...VCR_REAL_PATIENT_SOURCES, 'reconstructed']),
})
/** The methods above, by name (kept for callers that only need the list). */
export const VCR_OBSERVED_ONLY_METHODS = frozen(Object.keys(VCR_INDIVIDUAL_INPUT_SOURCES))

/** The largest replicate count a job may ask for (`VCR_ENGINE_MAX_REPLICATES`' default). */
export const VCR_MAX_REPLICATES = 200_000

/** Every key a job may carry. Anything else is refused by name. */
export const VCR_JOB_FIELDS = frozen([
  'jobId', 'studyId', 'kind', 'method', 'methodVersion', 'protocolVersion', 'scenario', 'inputs', 'seed',
  'replicates', 'cpuSecondsLimit', 'requestedBy', 'cores', 'batchSize',
])

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Patterns as source text, not RegExp objects: they have to survive a JSON
 * snapshot into R. R matches them with PCRE and treats the trailing `$` as
 * "end of string", which is what JavaScript's `$` already means.
 */
export const VCR_PATTERNS = Object.freeze({
  id: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$',
  // An input names a *version* of an object, so `@3` is part of its id — the
  // same shape `vcrLineage.mjs` writes. Job and study ids never carry one.
  inputId: '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,140}$',
  version: '@[1-9][0-9]*$',
  sha256: '^[a-f0-9]{64}$',
  // One path segment of a data-plane location: no dot-leading name, so neither
  // `..` nor a hidden file can be spelled.
  locationSegment: '^[A-Za-z0-9_][A-Za-z0-9_.@:+=,-]{0,199}$',
})
/**
 * A pattern is tested against a string only: `String(5)` is "5" and would pass
 * an id pattern that a number was never meant to satisfy, and R's `grepl` would
 * not agree.
 * @param {string} source
 */
const matcher = (source) => {
  const re = new RegExp(source)
  return { test: (/** @type {unknown} */ value) => typeof value === 'string' && re.test(value) }
}
const ID = matcher(VCR_PATTERNS.id)
const INPUT_ID = matcher(VCR_PATTERNS.inputId)
const VERSION = matcher(VCR_PATTERNS.version)
const SHA256 = matcher(VCR_PATTERNS.sha256)
const LOCATION_SEGMENT = matcher(VCR_PATTERNS.locationSegment)
/** Segments and total length a data-plane location may have. */
export const VCR_LOCATION_LIMITS = Object.freeze({ maxSegments: 8, maxLength: 512 })

/**
 * What an input can be. Lineage kinds carry an id with a version (`asm_1@3`),
 * because a result references a version, never an object; `snapshot` is the
 * caller's way to name patient-level data; `analysis_table` and `snapshot_file`
 * are what the control plane turns it into.
 */
export const VCR_INPUT_KINDS = frozen([
  'assumption', 'study_definition', 'population', 'comparator_design', 'evidence',
  'snapshot', 'analysis_table', 'snapshot_file',
])
/** Input kinds whose id is a lineage node and so ends in `@<version>`. */
export const VCR_VERSIONED_INPUT_KINDS = frozen(['assumption', 'study_definition', 'population', 'comparator_design'])
/** Input kinds only the control plane may write, and the engine reads as files. */
export const VCR_ENGINE_TABLE_INPUT_KINDS = frozen(['analysis_table', 'snapshot_file'])
/** The kind a caller uses for patient-level data. */
export const VCR_CALLER_SNAPSHOT_KIND = 'snapshot'
/**
 * The keys an input may carry, and nothing else (merge review, 2026-09-29): a
 * caller names an object and its version and never where it lives; the engine
 * receives a table's location, hash, shape and value source only from the
 * control plane, and a lineage input's hash at most. An extra key is refused by
 * name on both sides — R's `$` matches a key by its prefix, so a `locationX`
 * that got through would have been read as `location`. A lineage input may
 * carry its frozen `value` (the assumption's point and distribution); a
 * snapshot input carries nothing but its kind and id.
 */
export const VCR_CALLER_INPUT_KEYS = frozen(['kind', 'id', 'value'])
export const VCR_ENGINE_TABLE_INPUT_KEYS = frozen(['kind', 'id', 'shape', 'location', 'hash', 'valueSource'])
export const VCR_ENGINE_LINEAGE_INPUT_KEYS = frozen(['kind', 'id', 'hash', 'value'])

/**
 * Is this a data-plane-relative path the engine may open? Relative, no `..`, no
 * empty or hidden segment, no backslash, bounded.
 * @param {unknown} location
 */
export function vcrLocationIsValid(location) {
  if (typeof location !== 'string' || !location || location.length > VCR_LOCATION_LIMITS.maxLength) return false
  const segments = location.split('/')
  return segments.length <= VCR_LOCATION_LIMITS.maxSegments && segments.every((segment) => LOCATION_SEGMENT.test(segment))
}

/** @typedef {{ code: string, field: string, detail: string }} VcrProtocolIssue */

// ---------------------------------------------------------------------------
// Canonical bytes
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: sorted keys, dropped `undefined`, `null` kept, no whitespace.
 * Both sides hash exactly these bytes. Key order is what `JSON.stringify` gives
 * the object built here, so an integer-like key (`"9"`, `"10"`) is emitted
 * first, in numeric order, ahead of the sorted string keys — R reproduces that.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalScenarioJson(value) {
  return JSON.stringify(canonicalize(value))
}

/** @param {any} value @returns {any} */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      // `out["__proto__"] = x` would set the prototype and vanish from the
      // output; a scenario is model output, and it may carry that key.
      Object.defineProperty(out, key, { value: canonicalize(value[key]), enumerable: true, writable: true, configurable: true })
    }
    return out
  }
  return value
}

/**
 * The bytes `manifest.outputHash` is the sha256 of (contract §3.4): the
 * canonical JSON of what a result says, without its bookkeeping —
 * `{ measures, counts, conclusion, notEstimableRule, tables: [{ name, sha256 }] }`.
 * This package cannot hash, so it returns the payload and the caller hashes
 * it; `vcr_output_hash()` in `R/protocol.R` is the twin.
 * @param {any} result
 * @returns {string}
 */
export function vcrResultOutputPayload(result) {
  const tables = Array.isArray(result?.tables) ? result.tables : []
  return canonicalScenarioJson({
    measures: Array.isArray(result?.measures) ? result.measures : [],
    counts: result?.counts ?? null,
    conclusion: result?.conclusion ?? null,
    notEstimableRule: result?.notEstimableRule ?? null,
    tables: tables.map((/** @type {any} */ table) => ({ name: table?.name, sha256: table?.sha256 })),
  })
}

// ---------------------------------------------------------------------------
// Replicates
// ---------------------------------------------------------------------------

/**
 * How many replicates a target Monte-Carlo standard error needs.
 *
 * - `proportion`: p(1-p)/target² — a type-I error of 0.025 to ±0.001 is 24,375.
 * - `mean`: sd²/target² — a bias measured to 0.005 with sd 0.2 is 1,600.
 *
 * @param {{ measure: 'proportion' | 'mean', target: number, p?: number, sd?: number }} input
 * @returns {number}
 */
export function replicatesForMcse({ measure, target, p = 0.5, sd = 1 }) {
  if (!(target > 0)) throw new Error('replicatesForMcse: target must be positive')
  const variance = measure === 'proportion' ? p * (1 - p) : sd * sd
  // Rounded to twelve significant digits before the ceiling: 0.025 × 0.975 /
  // 0.001² is 24,375 exactly, and in binary floating point it is
  // 24,375.000000000004, which would ask for one more replicate forever.
  return Math.ceil(Number((variance / (target * target)).toPrecision(12)))
}

/**
 * The Monte-Carlo standard error of a measure estimated from `replicates`.
 * @param {{ measure: 'proportion' | 'mean', replicates: number, p?: number, sd?: number }} input
 */
export function mcseOf({ measure, replicates, p = 0.5, sd = 1 }) {
  if (!(replicates > 0)) throw new Error('mcseOf: replicates must be positive')
  const variance = measure === 'proportion' ? p * (1 - p) : sd * sd
  return Math.sqrt(variance / replicates)
}

/**
 * The replicate floor for a scenario: the plan's defaults (20,000 under the
 * null, 5,000 under an alternative), raised to whatever the asked-for
 * precision needs.
 *
 * The proportion the precision is asked of is the rejection probability the
 * scenario measures: alpha under the null (20,000 replicates is what alpha =
 * 0.025 needs for a standard error of 0.0011), the worst case 0.5 under an
 * alternative. Passing `p` overrides it.
 * @param {{ isNull: boolean, targetMcse?: number | null, alpha?: number, p?: number }} input
 */
export function replicateFloor({ isNull, targetMcse = null, alpha = 0.025, p }) {
  const base = isNull ? VCR_REPLICATES_NULL_MIN : VCR_REPLICATES_ALT_MIN
  if (!targetMcse) return base
  const proportion = p ?? (isNull ? alpha : 0.5)
  return Math.max(base, replicatesForMcse({ measure: 'proportion', target: targetMcse, p: proportion }))
}

/**
 * The floor of a whole scenario, with its null predicate and alpha read from
 * the scenario itself — what the control plane uses when it enqueues.
 * @param {any} scenario
 */
export function vcrReplicateFloorFor(scenario) {
  const target = Number(scenario?.targetMcse)
  const alpha = Number(scenario?.analysis?.alpha)
  return replicateFloor({
    isNull: vcrIsNullScenario(scenario),
    targetMcse: Number.isFinite(target) && target > 0 ? target : null,
    alpha: Number.isFinite(alpha) && alpha > 0 && alpha < 1 ? alpha : 0.025,
  })
}

// ---------------------------------------------------------------------------
// Validating a job
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Validate the inputs a CALLER may send (a browser route, the runtime's gateway,
 * the orchestrator): lineage references, and patient-level data named only as
 * `{ kind: "snapshot", id }`. A `location`, `hash`, `shape` or `valueSource` a
 * caller supplied is refused (`input_location_forbidden`): only the control
 * plane, having checked the grant, says where a file is and what it hashes to.
 * `hash: null` is allowed — it says nothing.
 *
 * With the job `kind`, a patient-level kind must name the snapshot it reads
 * (`snapshot_required`); without it only the inputs themselves are checked.
 *
 * @param {unknown} inputs
 * @param {{ kind?: string }} [options]
 * @returns {readonly VcrProtocolIssue[]}
 */
export function validateCallerInputs(inputs, { kind = undefined } = {}) {
  /** @type {VcrProtocolIssue[]} */
  const issues = []
  const bad = (/** @type {string} */ code, /** @type {string} */ field, /** @type {string} */ detail) => issues.push({ code, field, detail })
  const needsSnapshot = typeof kind === 'string' && VCR_PATIENT_LEVEL_JOB_KINDS.includes(kind)
  if (inputs === undefined || inputs === null) {
    return frozen(needsSnapshot ? [{ code: 'snapshot_required', field: 'inputs', detail: `A ${kind} job reads patient-level rows and must name the snapshot it is granted.` }] : [])
  }
  if (!Array.isArray(inputs)) return frozen([{ code: 'inputs_missing', field: 'inputs', detail: 'inputs is a list.' }])
  if (needsSnapshot && !inputs.some((input) => isObject(input) && input.kind === VCR_CALLER_SNAPSHOT_KIND)) {
    bad('snapshot_required', 'inputs', `A ${kind} job reads patient-level rows and must name the snapshot it is granted.`)
  }
  inputs.forEach((input, i) => {
    const at = `inputs[${i}]`
    if (!isObject(input)) { bad('input_not_object', at, 'An input is an object.'); return }
    if (!VCR_INPUT_KINDS.includes(input.kind) || VCR_ENGINE_TABLE_INPUT_KINDS.includes(input.kind)) {
      if (VCR_ENGINE_TABLE_INPUT_KINDS.includes(input.kind)) {
        bad('input_location_forbidden', `${at}.kind`, 'A caller names patient-level data as { kind: "snapshot", id }; the control plane builds the table input.')
      } else if (input.kind === undefined || input.kind === null || input.kind === '') {
        bad('input_kind_missing', `${at}.kind`, 'An input names what it is (assumption, snapshot, population …).')
      } else bad('input_kind_unknown', `${at}.kind`, `Unknown input kind ${JSON.stringify(input.kind)}.`)
    }
    for (const key of ['location', 'shape', 'valueSource']) {
      if (input[key] !== undefined && input[key] !== null) bad('input_location_forbidden', `${at}.${key}`, `A caller never supplies ${key}: the control plane resolves it from the snapshot.`)
    }
    if (input.hash !== undefined && input.hash !== null) bad('input_location_forbidden', `${at}.hash`, 'A caller never supplies a hash: the control plane hashes the file it resolved.')
    if (!INPUT_ID.test(input.id)) bad('input_id_invalid', `${at}.id`, 'An input carries the id of the object it names (`asm_1@3`, a snapshot id).')
    else if (VCR_VERSIONED_INPUT_KINDS.includes(input.kind) && !VERSION.test(input.id)) {
      bad('input_version_missing', `${at}.id`, 'A lineage input names a version: `<id>@<n>`.')
    }
    for (const key of Object.keys(input)) {
      if (['location', 'shape', 'valueSource', 'hash'].includes(key)) continue
      if (VCR_CALLER_INPUT_KEYS.includes(key) && !(key === 'value' && input.kind === VCR_CALLER_SNAPSHOT_KIND)) continue
      bad('input_field_unknown', `${at}.${key}`, 'A caller input is { kind, id } (and a lineage input its frozen value), nothing else.')
    }
  })
  return frozen(issues)
}

/**
 * Validate a job the engine is about to run — the control plane calls this
 * after it resolved the caller's inputs, and the engine calls it again (as
 * `vcr_validate_job`, from the snapshot of these same tables).
 *
 * A job is `{ jobId, studyId, kind, method, methodVersion, protocolVersion,
 * scenario, inputs, seed, replicates?, cpuSecondsLimit, requestedBy?, cores?,
 * batchSize? }`. Returns issues; an empty array is a valid job.
 *
 * @param {any} job
 * @returns {readonly VcrProtocolIssue[]}
 */
export function validateEngineJob(job) {
  /** @type {VcrProtocolIssue[]} */
  const issues = []
  const bad = (/** @type {string} */ code, /** @type {string} */ field, /** @type {string} */ detail) => issues.push({ code, field, detail })
  if (!isObject(job)) return frozen([{ code: 'job_not_object', field: '', detail: 'A job is a JSON object.' }])

  for (const key of Object.keys(job)) {
    if (!VCR_JOB_FIELDS.includes(key)) bad('job_field_unknown', key, `A job has no field ${JSON.stringify(key)}.`)
  }
  if (!ID.test(job.jobId)) bad('job_id_invalid', 'jobId', 'A job id is 1–121 characters of [A-Za-z0-9_.:-].')
  if (!ID.test(job.studyId)) bad('study_id_invalid', 'studyId', 'A study id is 1–121 characters of [A-Za-z0-9_.:-].')
  if (job.protocolVersion !== VCR_ENGINE_PROTOCOL_VERSION) {
    bad('protocol_version_mismatch', 'protocolVersion', `This build speaks protocol ${VCR_ENGINE_PROTOCOL_VERSION}.`)
  }
  const kindKnown = VCR_JOB_KINDS.includes(job.kind)
  if (!kindKnown) bad('kind_unknown', 'kind', `Unknown job kind ${JSON.stringify(job.kind)}.`)
  const method = typeof job.method === 'string' ? job.method : ''
  const methodKnown = VCR_ENGINE_METHOD_IDS.includes(method)
  if (!methodKnown) bad('method_unknown', 'method', `Unknown method ${JSON.stringify(job.method)}.`)
  if (kindKnown && methodKnown && /** @type {Record<string, string>} */ (VCR_JOB_METHODS)[job.kind] !== method) {
    bad('kind_method_mismatch', 'method', `A ${job.kind} job runs ${/** @type {Record<string, string>} */ (VCR_JOB_METHODS)[job.kind]}, not ${method}.`)
  }
  if (job.methodVersion === undefined || job.methodVersion === null || job.methodVersion === '') {
    bad('method_version_missing', 'methodVersion', 'A job names the method version its numbers are validated at.')
  } else if (methodKnown && job.methodVersion !== VCR_ENGINE_METHODS[/** @type {keyof typeof VCR_ENGINE_METHODS} */ (method)].version && !legacyDesignVersionMatches(job)) {
    bad('method_version_mismatch', 'methodVersion', `Method ${method} is ${VCR_ENGINE_METHODS[/** @type {keyof typeof VCR_ENGINE_METHODS} */ (method)].version} in this build.`)
  }
  if (!Number.isInteger(job.seed) || job.seed < 0 || job.seed > 2_147_483_647) {
    bad('seed_invalid', 'seed', 'A seed is an integer from 0 to 2147483647; it is written into the result so the run can be repeated.')
  }
  if (job.replicates !== undefined && job.replicates !== null) {
    if (!Number.isInteger(job.replicates) || job.replicates < 1 || job.replicates > VCR_MAX_REPLICATES) {
      bad('replicates_invalid', 'replicates', `Replicates is an integer from 1 to ${VCR_MAX_REPLICATES}.`)
    }
  }
  if (!Number.isFinite(job.cpuSecondsLimit) || job.cpuSecondsLimit <= 0) {
    bad('cpu_limit_invalid', 'cpuSecondsLimit', 'Every job carries its own CPU-second ceiling (plan §11.4).')
  }
  for (const { key, code, max } of [{ key: 'cores', code: 'cores_invalid', max: 64 }, { key: 'batchSize', code: 'batch_size_invalid', max: 100_000 }]) {
    if (job[key] !== undefined && job[key] !== null && !(Number.isInteger(job[key]) && job[key] >= 1 && job[key] <= max)) {
      bad(code, key, `${key} is an integer from 1 to ${max}.`)
    }
  }

  // --- inputs --------------------------------------------------------------
  const inputs = Array.isArray(job.inputs) ? job.inputs : null
  /** @type {string[]} */
  const inputIds = []
  /** @type {any[]} */
  const tables = []
  if (!inputs) bad('inputs_missing', 'inputs', 'A job lists every frozen input it used.')
  else {
    inputs.forEach((/** @type {any} */ input, /** @type {number} */ i) => {
      const at = `inputs[${i}]`
      if (!isObject(input)) { bad('input_not_object', at, 'An input is an object.'); return }
      if (typeof input.id === 'string') inputIds.push(input.id)
      if (input.kind === undefined || input.kind === null || input.kind === '') bad('input_kind_missing', `${at}.kind`, 'An input names what it is (assumption, snapshot, population …).')
      else if (!VCR_INPUT_KINDS.includes(input.kind)) bad('input_kind_unknown', `${at}.kind`, `Unknown input kind ${JSON.stringify(input.kind)}.`)
      else if (input.kind === VCR_CALLER_SNAPSHOT_KIND) {
        bad('input_kind_caller_only', `${at}.kind`, 'A snapshot is what a caller names; the engine receives an analysis_table or snapshot_file with a location and a hash.')
      }
      if (!INPUT_ID.test(input.id)) bad('input_id_invalid', `${at}.id`, 'An input carries the id of the object version it froze (`asm_1@3`).')
      else if (VCR_VERSIONED_INPUT_KINDS.includes(input.kind) && !VERSION.test(input.id)) {
        bad('input_version_missing', `${at}.id`, 'A lineage input names a version: `<id>@<n>`.')
      }
      const allowedKeys = VCR_ENGINE_TABLE_INPUT_KINDS.includes(input.kind) ? VCR_ENGINE_TABLE_INPUT_KEYS : VCR_ENGINE_LINEAGE_INPUT_KEYS
      for (const key of Object.keys(input)) {
        if (!allowedKeys.includes(key) && !(input.kind === VCR_CALLER_SNAPSHOT_KIND && VCR_ENGINE_TABLE_INPUT_KEYS.includes(key))) {
          bad('input_field_unknown', `${at}.${key}`, `A ${VCR_ENGINE_TABLE_INPUT_KINDS.includes(input.kind) ? 'table' : 'lineage'} input carries only ${allowedKeys.join(', ')}.`)
        }
      }
      const hasHash = input.hash !== undefined && input.hash !== null
      if (hasHash && !SHA256.test(input.hash)) bad('input_hash_invalid', `${at}.hash`, 'An input hash is a lowercase sha256 hex digest.')
      const hasSource = input.valueSource !== undefined && input.valueSource !== null
      if (hasSource && !VCR_VALUE_SOURCES.includes(input.valueSource)) bad('input_value_source_invalid', `${at}.valueSource`, `valueSource is one of ${VCR_VALUE_SOURCES.join(', ')}.`)
      const hasLocation = input.location !== undefined && input.location !== null
      if (hasLocation && !vcrLocationIsValid(input.location)) {
        bad('input_location_invalid', `${at}.location`, 'A location is a path relative to the data plane: no "..", no leading "/", no hidden or empty segment.')
      }
      const isTable = VCR_ENGINE_TABLE_INPUT_KINDS.includes(input.kind)
      if (isTable || hasLocation) {
        tables.push(input)
        if (!hasLocation) bad('input_location_missing', `${at}.location`, 'A table input names where the engine reads it, relative to the data plane.')
        if (!hasHash) bad('input_hash_missing', `${at}.hash`, 'A table input carries the sha256 of exactly the file the engine will read.')
        if (!hasSource) bad('input_value_source_missing', `${at}.valueSource`, 'A table input says what its values are (observed, synthetic …); the control plane sets it.')
        else {
          const accepted = VCR_INDIVIDUAL_INPUT_SOURCES[/** @type {keyof typeof VCR_INDIVIDUAL_INPUT_SOURCES} */ (method)]
          if (accepted && !accepted.includes(input.valueSource)) {
            bad('input_source_not_individual', `${at}.valueSource`, `${method} reads real patients (${accepted.join(', ')}) and refuses ${input.valueSource} rows.`)
          }
        }
      }
      if (input.kind === 'analysis_table') {
        if (!VCR_ANALYSIS_TABLES.includes(input.shape)) bad('input_shape_invalid', `${at}.shape`, `An analysis table is one of ${VCR_ANALYSIS_TABLES.join(', ')}.`)
      } else if (input.shape !== undefined && input.shape !== null) {
        bad('input_shape_invalid', `${at}.shape`, 'Only an analysis_table has a shape.')
      }
    })
  }
  if (VCR_PATIENT_LEVEL_JOB_KINDS.includes(job.kind)) {
    const patientLevel = (inputs ?? []).filter((/** @type {any} */ input) => isObject(input) && VCR_ENGINE_TABLE_INPUT_KINDS.includes(input.kind))
    if (!patientLevel.length) bad('patient_input_required', 'inputs', `A ${job.kind} job reads patient-level rows and must carry the analysis_table or snapshot_file the control plane built from its granted snapshot.`)
  }

  // --- scenario ------------------------------------------------------------
  const scenario = job.scenario
  if (Array.isArray(scenario)) bad('scenario_value_invalid', 'scenario', 'A scenario is an object, not a list.')
  else if (!isObject(scenario)) bad('scenario_missing', 'scenario', 'A job carries its frozen scenario, not a reference to one.')
  else if (methodKnown) {
    for (const issue of validateScenario(method, scenario, { inputIds })) issues.push(issue)
    const supported = /** @type {Record<string, any>} */ (VCR_ENGINE_METHODS)[method].endpoints
    const type = scenario.endpoint?.type
    if (VCR_ENDPOINT_TYPES.includes(type) && supported.length && !supported.includes(type)) {
      bad('endpoint_not_supported', 'scenario.endpoint.type', `${method} handles ${supported.join(', ')} endpoints, not ${type}.`)
    }
    const support = /** @type {Record<string, any>} */ (VCR_DESIGN_SUPPORT)[method]
    if (support && VCR_ENDPOINT_TYPES.includes(type)) {
      const kinds = [['scenario.design.kind', scenario.design?.kind]]
      if (Array.isArray(scenario.designs)) scenario.designs.forEach((/** @type {any} */ cell, /** @type {number} */ i) => kinds.push([`scenario.designs[${i}].kind`, cell?.kind]))
      for (const [field, kind] of kinds) {
        if (kind === undefined || !VCR_TRIAL_DESIGNS.includes(kind)) continue
        if (!Array.isArray(support[kind]) || !support[kind].includes(type)) {
          bad('design_not_supported', field, `${method} does not implement a ${kind} design for a ${type} endpoint; it is refused rather than run as something else.`)
        }
      }
    }
    if (method === 'design.simulate' || method === 'design.grid') {
      const target = scenario.targetMcse
      if (Number.isFinite(target) && target > 0) {
        const truths = method === 'design.grid' && Array.isArray(scenario.truths) ? scenario.truths.filter(isObject) : [{}]
        const worst = Math.max(...truths.map((/** @type {any} */ cell) => vcrReplicateFloorFor({ ...scenario, truth: { ...(isObject(scenario.truth) ? scenario.truth : {}), ...cell } })))
        if (worst > VCR_MAX_REPLICATES) {
          bad('scenario_value_invalid', 'scenario.targetMcse', `A standard error of ${target} needs ${worst} replicates, above the ${VCR_MAX_REPLICATES} cap.`)
        }
      }
    }
  }
  return frozen(issues)
}

/** Replay prior supported designs under their recorded version; never label new designs as old. @param {any} job */
function legacyDesignVersionMatches(job) {
  const spec = /** @type {any} */ (VCR_ENGINE_METHODS)[job.method]
  if (!spec?.legacyVersion || job.methodVersion !== spec.legacyVersion) return false
  const base = job.scenario?.design?.kind
  const kinds = job.method === 'design.grid' && Array.isArray(job.scenario?.designs)
    ? job.scenario.designs.map((/** @type {any} */ design) => design.kind ?? base) : [base]
  return kinds.length > 0 && kinds.every((/** @type {string} */ kind) => !VCR_TRIAL_DESIGNS.includes(kind) || spec.legacyDesigns.includes(kind))
}

// ---------------------------------------------------------------------------
// Validating a result
// ---------------------------------------------------------------------------

const RESULT_STATUSES = frozen(['succeeded', 'failed', 'canceled', 'not_estimable'])

/**
 * Validate what the engine hands back: `{ jobId, method, methodVersion,
 * protocolVersion, status, conclusion, notEstimableRule?, scenarioHash, seed,
 * replicates, counts, measures[], tables[], models?, manifest }`.
 *
 * A simulated measure without `mcse` is refused here (AC-28), and so is a
 * manifest without the environment it ran in (AC-04), a measure without a value
 * source (§3.5), an interval that runs backwards, a conclusion or a
 * not-estimable rule outside the closed vocabularies (§3.6) and a hash that is
 * a placeholder.
 *
 * @param {any} result
 * @returns {readonly VcrProtocolIssue[]}
 */
export function validateEngineResult(result) {
  /** @type {VcrProtocolIssue[]} */
  const issues = []
  const bad = (/** @type {string} */ code, /** @type {string} */ field, /** @type {string} */ detail) => issues.push({ code, field, detail })
  if (!isObject(result)) return frozen([{ code: 'result_not_object', field: '', detail: 'A result is a JSON object.' }])
  const ZERO_HASH = '0'.repeat(64)

  if (!ID.test(result.jobId)) bad('job_id_invalid', 'jobId', 'A result carries the job id it answers.')
  if (result.protocolVersion !== VCR_ENGINE_PROTOCOL_VERSION) bad('protocol_version_mismatch', 'protocolVersion', `This build speaks protocol ${VCR_ENGINE_PROTOCOL_VERSION}.`)
  if (!RESULT_STATUSES.includes(result.status)) bad('status_unknown', 'status', 'A result is succeeded, failed, canceled or not_estimable.')
  if (!SHA256.test(result.scenarioHash) || result.scenarioHash === ZERO_HASH) {
    bad('scenario_hash_invalid', 'scenarioHash', 'A result carries the sha256 of the canonical scenario it ran.')
  }

  // Echo: what the result says it ran, for the control plane to hold against
  // the frozen job (`vcr_engine_result_mismatch`).
  if (!VCR_ENGINE_METHOD_IDS.includes(result.method)) bad('method_unknown', 'method', 'A result echoes the method it ran.')
  if (typeof result.methodVersion !== 'string' || !result.methodVersion) bad('method_version_missing', 'methodVersion', 'A result echoes the method version it ran.')
  if (!Number.isInteger(result.seed) || result.seed < 0 || result.seed > 2_147_483_647) bad('seed_invalid', 'seed', 'A result echoes the seed it ran with.')
  if (result.replicates === undefined) bad('replicates_missing', 'replicates', 'A result states its replicate count, or null when the method has none.')
  else if (result.replicates !== null && !(Number.isInteger(result.replicates) && result.replicates >= 1)) {
    bad('replicates_invalid', 'replicates', 'Replicates is a positive integer, or null.')
  }

  // The scientific conclusion is the method's own diagnosis (§3.6).
  const finished = result.status === 'succeeded' || result.status === 'not_estimable'
  if (result.conclusion === undefined || result.conclusion === null) {
    if (finished) bad('conclusion_missing', 'conclusion', `A finished result states its conclusion (${VCR_CONCLUSIONS.join(' / ')}).`)
  } else if (!VCR_CONCLUSIONS.includes(result.conclusion)) {
    bad('conclusion_unknown', 'conclusion', `conclusion is one of ${VCR_CONCLUSIONS.join(', ')}.`)
  }
  const notEstimable = result.status === 'not_estimable' || result.conclusion === 'not_estimable'
  if (notEstimable) {
    if (!result.notEstimableRule) bad('not_estimable_rule_missing', 'notEstimableRule', 'A not-estimable result names the deterministic rule that fired (plan §5.3).')
    else if (!VCR_NOT_ESTIMABLE_RULES.includes(result.notEstimableRule)) {
      bad('not_estimable_rule_unknown', 'notEstimableRule', `notEstimableRule is one of ${VCR_NOT_ESTIMABLE_RULES.join(', ')}.`)
    }
    if (result.status === 'not_estimable' && result.conclusion !== undefined && result.conclusion !== null && result.conclusion !== 'not_estimable') {
      bad('conclusion_status_mismatch', 'conclusion', 'A not_estimable result concludes not_estimable.')
    }
  }

  const measures = Array.isArray(result.measures) ? result.measures : null
  if (!measures) bad('measures_missing', 'measures', 'A result lists its measures, even when the list is empty.')
  else {
    measures.forEach((/** @type {any} */ measure, /** @type {number} */ i) => {
      const at = `measures[${i}]`
      if (!isObject(measure)) { bad('measure_not_object', at, 'A measure is an object.'); return }
      if (!measure.name) bad('measure_name_missing', `${at}.name`, 'A measure is named.')
      if (typeof measure.value !== 'number' || !Number.isFinite(measure.value)) {
        bad('measure_value_invalid', `${at}.value`, 'A measure carries a finite number; a failed computation is an issue, never a 0 (plan §9.6).')
      }
      if (measure.source === undefined || measure.source === null || measure.source === '') {
        bad('measure_source_missing', `${at}.source`, 'Every measure says where its number came from (plan §3.5).')
      } else if (!VCR_VALUE_SOURCES.includes(measure.source)) {
        bad('measure_source_invalid', `${at}.source`, `source is one of ${VCR_VALUE_SOURCES.join(', ')}.`)
      }
      const hasMcse = measure.mcse !== undefined && measure.mcse !== null
      if (measure.simulated && !(typeof measure.mcse === 'number' && Number.isFinite(measure.mcse) && measure.mcse >= 0)) {
        bad('mcse_missing', `${at}.mcse`, 'Every simulated measure reports its Monte-Carlo standard error (AC-28).')
      } else if (hasMcse && !(typeof measure.mcse === 'number' && Number.isFinite(measure.mcse) && measure.mcse >= 0)) {
        bad('mcse_invalid', `${at}.mcse`, 'A standard error is a non-negative number.')
      }
      const interval = measure.interval
      if (interval !== undefined && interval !== null) {
        if (!isObject(interval) || !VCR_INTERVAL_KINDS.includes(interval.kind)) {
          bad('interval_kind_unknown', `${at}.interval.kind`, 'An interval names which kind it is (plan §8.3).')
        } else if (!(typeof interval.low === 'number' && Number.isFinite(interval.low) && typeof interval.high === 'number' && Number.isFinite(interval.high) && interval.low <= interval.high)) {
          bad('interval_invalid', `${at}.interval`, 'An interval has finite bounds with low not above high.')
        }
      }
    })
  }

  if (result.counts !== undefined && result.counts !== null) {
    for (const issue of validateCounts(result.counts)) bad(issue.code, `counts.${issue.field}`.replace(/\.$/, ''), issue.detail)
  }
  if (Array.isArray(result.tables)) {
    result.tables.forEach((/** @type {any} */ table, /** @type {number} */ i) => {
      if (!isObject(table) || !table.name || !SHA256.test(table.sha256)) bad('table_invalid', `tables[${i}]`, 'A table names itself and carries its sha256.')
    })
  }
  if (Array.isArray(result.models)) {
    result.models.forEach((/** @type {any} */ model, /** @type {number} */ i) => {
      if (!isObject(model) || !VCR_MODEL_TIERS.includes(model.tier)) bad('model_tier_invalid', `models[${i}].tier`, `tier is one of ${VCR_MODEL_TIERS.join(', ')}.`)
      if (isObject(model) && model.risk !== undefined && model.risk !== null && !VCR_MODEL_RISKS.includes(model.risk)) {
        bad('model_risk_invalid', `models[${i}].risk`, `risk is one of ${VCR_MODEL_RISKS.join(', ')}.`)
      }
    })
  }

  const manifest = result.manifest
  if (!isObject(manifest)) bad('manifest_missing', 'manifest', 'A result carries the manifest that lets it be repeated.')
  else {
    for (const field of ['engineVersion', 'rVersion', 'packageLockHash', 'startedAt', 'finishedAt', 'cpuSeconds']) {
      if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
        bad('manifest_field_missing', `manifest.${field}`, `The manifest states ${field} (AC-04).`)
      }
    }
    if (typeof manifest.cpuSeconds === 'number' ? !(Number.isFinite(manifest.cpuSeconds) && manifest.cpuSeconds >= 0) : (manifest.cpuSeconds !== undefined && manifest.cpuSeconds !== null && manifest.cpuSeconds !== '')) {
      bad('cpu_seconds_invalid', 'manifest.cpuSeconds', 'CPU seconds is a non-negative number.')
    }
    if (manifest.packageLockHash && (!SHA256.test(manifest.packageLockHash) || manifest.packageLockHash === ZERO_HASH)) {
      bad('package_lock_hash_invalid', 'manifest.packageLockHash', 'The package lock hash is a lowercase sha256 hex digest.')
    }
    if (manifest.outputHash === undefined || manifest.outputHash === null) {
      if (finished) bad('output_hash_missing', 'manifest.outputHash', 'A finished result carries the hash of its output, which the control plane recomputes (contract §3.4).')
    } else if (!SHA256.test(manifest.outputHash) || manifest.outputHash === ZERO_HASH) {
      bad('output_hash_invalid', 'manifest.outputHash', 'An output hash is a lowercase sha256 hex digest.')
    }
  }
  return frozen(issues)
}

/**
 * The counts a result may report, kept apart (plan §3.5). Generating more
 * records never raises `realPatients`, and a weighted effective sample size
 * never exceeds the real patients it weights.
 * @param {any} counts
 * @returns {readonly VcrProtocolIssue[]}
 */
export function validateCounts(counts) {
  /** @type {VcrProtocolIssue[]} */
  const issues = []
  if (!isObject(counts)) return frozen([{ code: 'counts_not_object', field: '', detail: 'Counts are an object.' }])
  for (const [key, value] of Object.entries(counts)) {
    if (value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      issues.push({ code: 'count_invalid', field: key, detail: 'A count is a non-negative number or null (not knowable), never 0 standing in for unknown.' })
    }
  }
  // The ESS bound holds whenever there are real patients to weight, whether or
  // not any records were generated: a weighting of 50 people has at most 50.
  const real = counts.realPatients
  const ess = counts.effectiveSampleSize
  if (typeof real === 'number' && Number.isFinite(real) && typeof ess === 'number' && Number.isFinite(ess) && ess > real) {
    issues.push({ code: 'ess_above_real', field: 'effectiveSampleSize', detail: 'A weighted effective sample size never exceeds the real patients it weights (AC-08).' })
  }
  return frozen(issues)
}
