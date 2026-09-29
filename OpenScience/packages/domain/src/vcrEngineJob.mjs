/**
 * The engine protocol: what a frozen scenario is, and what comes back.
 *
 * Hidden knowledge:
 *
 * - **The control plane and `vcr-engine` are written in different languages,
 *   so the contract lives here and nowhere else.** The server validates a job
 *   before it queues it; the engine validates the same job before it runs it
 *   (`engine/protocol.R` mirrors these lists and a test asserts the two agree).
 *   A field neither side knows is refused by name rather than ignored, because
 *   an ignored field is a silent parameter change.
 * - **A job is frozen, not referenced.** Every input a run used — assumption
 *   values, population version, method version, seed, replicate count, the
 *   snapshot's hash — is copied into the job. Re-reading a row later would
 *   make a result unreproducible the moment anyone edits an assumption, which
 *   is exactly the moment reproducibility matters (plan §3.4, §5.4).
 * - **No hashing here.** This package is browser-safe and imports nothing, so
 *   it produces the canonical bytes (`canonicalScenarioJson`) and the caller
 *   hashes them. Both sides hash the same bytes: key order is sorted, numbers
 *   are JSON numbers, and `undefined` is dropped.
 * - **Replicates follow from the precision asked for, not from a habit.** A
 *   proportion measured to a Monte-Carlo standard error of `target` needs
 *   `p(1-p)/target²` replicates — for a one-sided 0.025 type-I error measured
 *   to 0.001 that is 24,375 (plan §5.4, case N05). The floors in
 *   `vcrVocabulary.mjs` apply on top of it.
 * - **Every reported number carries its Monte-Carlo standard error** (AC-28).
 *   A result that omits `mcse` for a simulated measure is refused here, not in
 *   review.
 *
 * @module @evimed/domain/vcrEngineJob
 */

import {
  VCR_ENDPOINT_TYPES, VCR_JOB_KINDS, VCR_REPLICATES_ALT_MIN, VCR_REPLICATES_NULL_MIN, VCR_TRIAL_DESIGNS,
} from './vcrVocabulary.mjs'

/** @template T @param {readonly T[]} list @returns {readonly T[]} */
const frozen = (list) => Object.freeze([...list])

/** The protocol's own version. A change that is not backward compatible bumps it. */
export const VCR_ENGINE_PROTOCOL_VERSION = 1

/**
 * The methods the engine publishes, each with the version its numbers were
 * validated at (plan §11.4, §12.4). `crossChecks` names the independent
 * implementation or reference software the numeric cases compare against.
 */
export const VCR_ENGINE_METHODS = Object.freeze({
  'profile.snapshot': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen(['profile_dataset.py']) },
  'cohort.build': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen([]) },
  'population.scenario': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen(['simstudy semantics']) },
  'population.literature': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen([]) },
  'population.synthpop': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen(['synthpop']) },
  'population.quality': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen([]) },
  'patients.continuous': { version: '1.0.0', endpoints: frozen(['continuous']), crossChecks: frozen([]) },
  'patients.binary': { version: '1.0.0', endpoints: frozen(['binary']), crossChecks: frozen([]) },
  'patients.time_to_event': { version: '1.0.0', endpoints: frozen(['time_to_event']), crossChecks: frozen(['simsurv']) },
  'evidence.pool': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen(['metafor', 'meta engine']) },
  'evidence.reconstruct_km': { version: '1.0.0', endpoints: frozen(['time_to_event']), crossChecks: frozen(['IPDfromKM']) },
  'comparator.entropy_balance': { version: '1.0.0', endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen(['WeightIt', 'cobalt']) },
  'comparator.propensity_weight': { version: '1.0.0', endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen(['WeightIt']) },
  'comparator.rmst': { version: '1.0.0', endpoints: frozen(['time_to_event']), crossChecks: frozen(['survRM2']) },
  'comparator.maic': { version: '1.0.0', endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen(['NICE DSU TSD 18']) },
  'comparator.evalue': { version: '1.0.0', endpoints: frozen(['binary', 'time_to_event']), crossChecks: frozen(['EValue']) },
  'comparator.map_prior': { version: '1.0.0', endpoints: frozen(['binary', 'continuous']), crossChecks: frozen(['RBesT']) },
  'design.analytic': { version: '1.0.0', endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen(['rpact', 'gsDesign']) },
  'design.simulate': { version: '1.0.0', endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen(['design.analytic']) },
  'design.grid': { version: '1.0.0', endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen([]) },
  'design.assurance': { version: '1.0.0', endpoints: frozen(['continuous', 'binary', 'time_to_event']), crossChecks: frozen(["O'Hagan 2005"]) },
  'design.procova': { version: '1.0.0', endpoints: frozen(['continuous']), crossChecks: frozen(['EMA 2022 qualification opinion']) },
  'accrual.poisson_gamma': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen(['Anisimov & Fedorov 2007']) },
  'matching.evaluate': { version: '1.0.0', endpoints: frozen([]), crossChecks: frozen(['Kleene truth table']) },
})

export const VCR_ENGINE_METHOD_IDS = frozen(Object.keys(VCR_ENGINE_METHODS))

/** Which method each job kind runs. */
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
})

/** Job kinds that read patient-level rows, and so need a snapshot grant (plan §8.1). */
export const VCR_PATIENT_LEVEL_JOB_KINDS = frozen([
  'profile_snapshot', 'build_cohort', 'synthesize_population', 'population_quality',
  'weight_comparator', 'propensity_weight_comparator', 'rmst', 'match_criteria',
])

/**
 * Canonical JSON: sorted keys, dropped `undefined`, no whitespace. Both sides
 * hash exactly these bytes.
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
      out[key] = canonicalize(value[key])
    }
    return out
  }
  return value
}

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
 * @param {{ isNull: boolean, targetMcse?: number | null, p?: number }} input
 */
export function replicateFloor({ isNull, targetMcse = null, p = 0.5 }) {
  const base = isNull ? VCR_REPLICATES_NULL_MIN : VCR_REPLICATES_ALT_MIN
  if (!targetMcse) return base
  return Math.max(base, replicatesForMcse({ measure: 'proportion', target: targetMcse, p }))
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/
// An input names a *version* of an object, so `@3` is part of its id — the same
// shape `vcrLineage.mjs` writes. Job and study ids never carry one.
const INPUT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,140}$/
const SHA256 = /^[a-f0-9]{64}$/

/**
 * Validate a job the control plane is about to queue, or the engine is about
 * to run. Returns issues; an empty array is a valid job.
 *
 * A job is `{ jobId, studyId, kind, method, methodVersion, protocolVersion,
 * scenario, inputs, seed, replicates?, cpuSecondsLimit, requestedBy }`.
 *
 * @param {any} job
 * @returns {readonly { code: string, field: string, detail: string }[]}
 */
export function validateEngineJob(job) {
  /** @type {{ code: string, field: string, detail: string }[]} */
  const issues = []
  const bad = (code, field, detail) => issues.push({ code, field, detail })
  if (!job || typeof job !== 'object') return frozen([{ code: 'job_not_object', field: '', detail: 'A job is a JSON object.' }])

  if (!ID.test(String(job.jobId ?? ''))) bad('job_id_invalid', 'jobId', 'A job id is 1–121 characters of [A-Za-z0-9_.:-].')
  if (!ID.test(String(job.studyId ?? ''))) bad('study_id_invalid', 'studyId', 'A study id is 1–121 characters of [A-Za-z0-9_.:-].')
  if (job.protocolVersion !== VCR_ENGINE_PROTOCOL_VERSION) {
    bad('protocol_version_mismatch', 'protocolVersion', `This build speaks protocol ${VCR_ENGINE_PROTOCOL_VERSION}.`)
  }
  if (!VCR_JOB_KINDS.includes(job.kind)) bad('kind_unknown', 'kind', `Unknown job kind ${JSON.stringify(job.kind)}.`)
  const method = String(job.method ?? '')
  if (!VCR_ENGINE_METHOD_IDS.includes(method)) bad('method_unknown', 'method', `Unknown method ${JSON.stringify(job.method)}.`)
  else if (job.methodVersion && job.methodVersion !== VCR_ENGINE_METHODS[/** @type {keyof typeof VCR_ENGINE_METHODS} */ (method)].version) {
    bad('method_version_mismatch', 'methodVersion', `Method ${method} is ${VCR_ENGINE_METHODS[/** @type {keyof typeof VCR_ENGINE_METHODS} */ (method)].version} in this build.`)
  }
  if (!Number.isInteger(job.seed) || job.seed < 0 || job.seed > 2_147_483_647) {
    bad('seed_invalid', 'seed', 'A seed is an integer from 0 to 2147483647; it is written into the result so the run can be repeated.')
  }
  if (job.replicates !== undefined && job.replicates !== null) {
    if (!Number.isInteger(job.replicates) || job.replicates < 1) bad('replicates_invalid', 'replicates', 'Replicates is a positive integer.')
  }
  if (!Number.isFinite(job.cpuSecondsLimit) || job.cpuSecondsLimit <= 0) {
    bad('cpu_limit_invalid', 'cpuSecondsLimit', 'Every job carries its own CPU-second ceiling (plan §11.4).')
  }
  if (!job.scenario || typeof job.scenario !== 'object') bad('scenario_missing', 'scenario', 'A job carries its frozen scenario, not a reference to one.')

  const inputs = Array.isArray(job.inputs) ? job.inputs : null
  if (!inputs) bad('inputs_missing', 'inputs', 'A job lists every frozen input it used.')
  else {
    inputs.forEach((input, index) => {
      if (!input || typeof input !== 'object') { bad('input_not_object', `inputs[${index}]`, 'An input is an object.'); return }
      if (!INPUT_ID.test(String(input.id ?? ''))) bad('input_id_invalid', `inputs[${index}].id`, 'An input carries the id of the object version it froze (`asm_1@3`).')
      if (!input.kind) bad('input_kind_missing', `inputs[${index}].kind`, 'An input names what it is (assumption, snapshot, population …).')
      if (input.hash !== undefined && input.hash !== null && !SHA256.test(String(input.hash))) {
        bad('input_hash_invalid', `inputs[${index}].hash`, 'An input hash is a lowercase sha256 hex digest.')
      }
    })
  }

  if (VCR_PATIENT_LEVEL_JOB_KINDS.includes(job.kind)) {
    const snapshot = (inputs ?? []).find((input) => input?.kind === 'snapshot')
    if (!snapshot) bad('snapshot_required', 'inputs', `A ${job.kind} job reads patient-level rows and must name the snapshot it is granted.`)
  }

  const design = job.scenario?.design
  if (design && !VCR_TRIAL_DESIGNS.includes(design.kind)) {
    bad('design_unknown', 'scenario.design.kind', `Unknown design ${JSON.stringify(design.kind)}.`)
  }
  const endpoint = job.scenario?.endpoint
  if (endpoint && !VCR_ENDPOINT_TYPES.includes(endpoint.type)) {
    bad('endpoint_unknown', 'scenario.endpoint.type', `Unknown endpoint type ${JSON.stringify(endpoint.type)}.`)
  }
  return frozen(issues)
}

/**
 * Validate what the engine hands back: `{ jobId, method, methodVersion,
 * protocolVersion, status, scenarioHash, seed, replicates?, measures[],
 * tables[], manifest }`.
 *
 * A simulated measure without `mcse` is refused here (AC-28), and so is a
 * manifest without the environment it ran in (AC-04).
 *
 * @param {any} result
 * @returns {readonly { code: string, field: string, detail: string }[]}
 */
export function validateEngineResult(result) {
  /** @type {{ code: string, field: string, detail: string }[]} */
  const issues = []
  const bad = (code, field, detail) => issues.push({ code, field, detail })
  if (!result || typeof result !== 'object') return frozen([{ code: 'result_not_object', field: '', detail: 'A result is a JSON object.' }])

  if (!ID.test(String(result.jobId ?? ''))) bad('job_id_invalid', 'jobId', 'A result carries the job id it answers.')
  if (result.protocolVersion !== VCR_ENGINE_PROTOCOL_VERSION) bad('protocol_version_mismatch', 'protocolVersion', `This build speaks protocol ${VCR_ENGINE_PROTOCOL_VERSION}.`)
  if (!['succeeded', 'failed', 'canceled', 'not_estimable'].includes(result.status)) {
    bad('status_unknown', 'status', 'A result is succeeded, failed, canceled or not_estimable.')
  }
  if (!SHA256.test(String(result.scenarioHash ?? ''))) bad('scenario_hash_invalid', 'scenarioHash', 'A result carries the sha256 of the canonical scenario it ran.')
  if (result.status === 'not_estimable' && !result.notEstimableRule) {
    bad('not_estimable_rule_missing', 'notEstimableRule', 'A not-estimable result names the deterministic rule that fired (plan §5.3).')
  }

  const measures = Array.isArray(result.measures) ? result.measures : null
  if (!measures) bad('measures_missing', 'measures', 'A result lists its measures, even when the list is empty.')
  else {
    measures.forEach((measure, index) => {
      if (!measure || typeof measure !== 'object') { bad('measure_not_object', `measures[${index}]`, 'A measure is an object.'); return }
      if (!measure.name) bad('measure_name_missing', `measures[${index}].name`, 'A measure is named.')
      if (typeof measure.value !== 'number' || !Number.isFinite(measure.value)) {
        bad('measure_value_invalid', `measures[${index}].value`, 'A measure carries a finite number; a failed computation is an issue, never a 0 (plan §9.6).')
      }
      if (measure.simulated && !(typeof measure.mcse === 'number' && Number.isFinite(measure.mcse) && measure.mcse >= 0)) {
        bad('mcse_missing', `measures[${index}].mcse`, 'Every simulated measure reports its Monte-Carlo standard error (AC-28).')
      }
      if (measure.interval && !['confidence', 'credible', 'prediction', 'monte_carlo'].includes(measure.interval.kind)) {
        bad('interval_kind_unknown', `measures[${index}].interval.kind`, 'An interval names which kind it is (plan §8.3).')
      }
    })
  }

  const manifest = result.manifest
  if (!manifest || typeof manifest !== 'object') bad('manifest_missing', 'manifest', 'A result carries the manifest that lets it be repeated.')
  else {
    for (const field of ['engineVersion', 'rVersion', 'packageLockHash', 'startedAt', 'finishedAt', 'cpuSeconds']) {
      if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
        bad('manifest_field_missing', `manifest.${field}`, `The manifest states ${field} (AC-04).`)
      }
    }
    if (manifest.outputHash !== undefined && manifest.outputHash !== null && !SHA256.test(String(manifest.outputHash))) {
      bad('output_hash_invalid', 'manifest.outputHash', 'An output hash is a lowercase sha256 hex digest.')
    }
  }
  return frozen(issues)
}

/**
 * The counts a result may report, kept apart (plan §3.5). Generating more
 * records never raises `realPatients`.
 * @param {any} counts
 * @returns {readonly { code: string, field: string, detail: string }[]}
 */
export function validateCounts(counts) {
  /** @type {{ code: string, field: string, detail: string }[]} */
  const issues = []
  if (!counts || typeof counts !== 'object') return frozen([{ code: 'counts_not_object', field: '', detail: 'Counts are an object.' }])
  for (const [key, value] of Object.entries(counts)) {
    if (value === null) continue
    if (!Number.isFinite(Number(value)) || Number(value) < 0) {
      issues.push({ code: 'count_invalid', field: key, detail: 'A count is a non-negative number or null (not knowable), never 0 standing in for unknown.' })
    }
  }
  if (Number(counts.generatedRecords ?? 0) > 0 && Number(counts.realPatients ?? 0) > 0
    && Number(counts.realPatients) < Number(counts.effectiveSampleSize ?? 0)) {
    issues.push({ code: 'ess_above_real', field: 'effectiveSampleSize', detail: 'A weighted effective sample size never exceeds the real patients it weights (AC-08).' })
  }
  return frozen(issues)
}
