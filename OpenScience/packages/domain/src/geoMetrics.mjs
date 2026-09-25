/**
 * 「循证 GEO」 metrics — the pure arithmetic behind every number the GEO pages,
 * the weekly report and the proposal pack show (plan 2026-09-24 §4, build spec
 * 2026-09-25 §2, §5).
 *
 * Hidden knowledge:
 *
 * - **One definition, the owner's.** The metric set, the pools, the index, the
 *   denominator discipline and every constant are the owner's geo-skills 3.0.0
 *   (`shared/rules/metrics.yaml` + `catalogue.yaml`), converted once to
 *   `geo/metrics.json` beside this module. Nothing here restates a number from
 *   that file; a new constant goes into the table with its provenance, never
 *   into code. The arithmetic is a port of the package's
 *   `shared/scripts/compute_metrics.py` (and of `monitor.py`'s net effect and
 *   hard lines), and a golden test holds this port equal to that script's
 *   output cell by cell on a synthetic batch. Where the script and the yaml
 *   disagree, this port follows the script — it is what the owner's tests pin —
 *   and the disagreements are listed in the package M report.
 * - **No fake numbers.** A metric that cannot be computed is
 *   `not_measurable` with a reason code, never 0: no retrieval means no
 *   citation rate, an unregistered owned domain means no hit rate, an
 *   unadjudicated answer is not a correct one. An engine that was not measured
 *   is `absent`. A rate over fewer answers than `STD_CELL_MIN_SAMPLES` is
 *   `insufficient` (the UI's 「样本不足」) — the value is kept for the record,
 *   never for display. Suspect answers (login page, empty shell) leave the
 *   denominator; refusals stay in it.
 * - **Rows are the platform's, the shape is fixed.** A row is one snapshot
 *   joined with its question's pool and group and its facts row
 *   ({@link GeoFactRow}). Noise and error-confirmation repeats are passed in
 *   with the batch and excluded here (so a caller cannot forget), except that
 *   M-20 counts their suspects exactly as the script does.
 * - **Rounding is Python's.** Every value is rounded the way CPython's
 *   `round(x, 2)` rounds (half-even on the exact binary value) and every float
 *   sum is CPython 3.12's compensated `sum()`, so a value on a page equals the
 *   value in the owner's own tooling to the last digit.
 *
 * @module @evimed/domain/geoMetrics
 */

import metricsTable from './geo/metrics.json' with { type: 'json' }
import sanityTable from './geo/sanity.json' with { type: 'json' }

/**
 * @typedef {{ name: string, rule: string, client_term: string, target_direction: string, gvi_weight: number }} GeoPoolDefinition
 */
/**
 * @typedef {object} GeoMetricDefinition
 * @property {string} id
 * @property {string} name
 * @property {string} formula
 * @property {'percent'|'count'|'ratio'|'index'|'rank_tier'} unit
 * @property {'measured'|'web'|'derived'} channel
 * @property {string} measurable_when
 * @property {'up'|'down'|'neutral'} direction
 * @property {string[]} pools
 * @property {boolean} client_facing
 * @property {string} gvi_group
 * @property {string} [note]
 * @property {string} [standard_alias]
 * @property {Record<string, string>} [variants]
 */
/**
 * @typedef {object} GeoMetricsTable
 * @property {{ source: string, version: string, sha256: Record<string, string>, converted: string, rule: string, constants: Record<string, string>, computation: Record<string, string>, engines: string, platform: Record<string, string> }} _provenance
 * @property {string} version
 * @property {Record<string, GeoPoolDefinition>} pools
 * @property {GeoMetricDefinition[]} metrics
 * @property {{ dimension_weights: Record<string, number>, normalization: string, pool_weighting: string, cap: string, not_measurable_policy: string }} gvi
 * @property {Record<string, string>} denominator
 * @property {Array<{ id: string, name: string, source: string, note?: string }>} tiers
 * @property {string[]} tier_variants
 * @property {{ formula: string, control_group_count_min: number, control_group_count_max: number, rule: string, window_weeks: string, control_share: string[], change: string, verdict: string, comparability_keys: string[], control_exclusion: string, metrics_by_pool: Record<string, string[]> }} net_effect
 * @property {Record<string, { metric: string, variant?: string, pools?: string[], note?: string }>} standard_aliases
 * @property {Array<{ id: string, name: string, formula: string }>} diagnostics
 * @property {Record<string, unknown>} url_observation
 * @property {Record<string, unknown>} anchor_schema
 * @property {Record<string, number|string|number[]|null>} constants
 * @property {{ value_decimals: number, wilson_z: number, pool_metric_ids: string[], gvi_normalizable_metric_ids: string[], gvi_inverse_rank_metric_ids: string[], uneven_denominator_metric_ids: string[], top_n_variant_max_position: number, percent_scale: number, derived_metrics: Record<string, { kind: 'ratio'|'copy', numerator?: { pool: string, metric: string }, denominator?: { pool: string, metric: string }, source?: { pool: string, metric: string }, pool_cell?: boolean }> }} computation
 * @property {Record<string, { display_name: string, citation_display: string, optional: boolean, planned: boolean }>} engines
 * @property {{ snapshot_statuses: string[], in_denominator_statuses: string[], excluded_round_kinds: string[], noise_round_kind: string, inclusion_surface_mode: string, inclusion_metric_ids: string[], error_closed_statuses: string[], noise_band_sd_multiplier: number, noise_band_metric_ids: string[], insufficient_gvi_below_answers: string }} platform
 */
/**
 * @typedef {object} GeoProbeSanityTable
 * @property {Record<string, unknown>} _provenance
 * @property {string[]} session_invalid_markers
 * @property {string[]} service_unavailable_markers
 * @property {number} service_unavailable_max_chars
 * @property {string[]} refusal_markers
 * @property {number} refusal_max_chars
 * @property {number} min_answer_chars
 * @property {string[]} page_chrome_markers
 * @property {number} page_chrome_tail_ratio
 * @property {string[]} retriable_raw_statuses
 */

/**
 * One citation of a snapshot (`snapshots.citations[]`).
 * @typedef {{ url?: string|null, domain?: string|null, title?: string|null, inBody?: boolean|null }} GeoCitation
 */
/**
 * One drug entity the parser found in an answer (`facts.brands[]`). A
 * registered brand is ours (`ours`) or a registered competitor
 * (`competitor`); an entity that is neither is an unregistered drug the model
 * extracted — it counts toward M-04C's denominator only.
 * @typedef {{ name: string, ours?: boolean, competitor?: boolean, position?: number|null, inRecommendation?: boolean, count?: number }} GeoBrandMention
 */
/**
 * One adjudicated statement about our product (`facts.statements[]`).
 * @typedef {{ text: string, verdict?: string|null, claimId?: string|null, errorType?: string|null, severity?: string|null, evidence?: string|null }} GeoStatement
 */
/**
 * The facts row of a snapshot. Counts and presence come from `brands`; the
 * order-dependent verdicts from the three flags. `redFlagExpected` /
 * `redFlagHits` feed M-11 and `safetyTermsHit` feeds M-12; a batch whose rows
 * lack `safetyTermsHit` gets M-12 `not_measurable`, never 0.
 * @typedef {object} GeoFacts
 * @property {GeoBrandMention[]} [brands]
 * @property {boolean|null} [firstOurs]      our product is the first registered brand in the answer
 * @property {number|null} [positionOurs]    1-based rank of our product among the registered brands
 * @property {boolean|null} [recommendedOurs]
 * @property {boolean|null} [retrievalTriggered]
 * @property {GeoStatement[]} [statements]
 * @property {string[]} [redFlagExpected]
 * @property {string[]} [redFlagHits]
 * @property {string[]} [safetyTermsHit]
 */
/**
 * One snapshot as the metrics read it: the `snapshots` row, the question's
 * pool and group (`questions.pool`, `question_groups.id`/`is_control`) and
 * the `facts` row (null when there is none). A `valid` snapshot without facts
 * has not been parsed yet and is left out (counted as `unparsed`); a refusal
 * without facts is an answer that mentions nothing.
 * @typedef {object} GeoFactRow
 * @property {string} snapshotId
 * @property {string|null} [questionId]
 * @property {string} engine
 * @property {string|null} [roundId]
 * @property {string|null} [roundKind]      rounds.kind; `noise` and `confirm` rows never enter a denominator
 * @property {number|null} [repeatIndex]    probe_jobs.repeat_index (noise repeats)
 * @property {string|null} [askedAt]
 * @property {'valid'|'suspect'|'refusal'|'failed'} status
 * @property {{ mode?: string|null } & Record<string, unknown> | null} [surface]
 * @property {GeoCitation[]|null} [citations]
 * @property {string|null} [pool]           null = a probe outside the question map (never in a per-engine rate)
 * @property {string|null} [groupId]
 * @property {boolean|null} [isControl]
 * @property {GeoFacts|null} [facts]
 */
/**
 * @typedef {'project'|'pool'|'engine'|'pool_engine'|'group'|'arm'} GeoMetricScope
 */
/**
 * One number, with everything a reader needs to trust it. `value`,
 * `ciLow`, `ciHigh` are on the metric's own scale (percent 0–100, the index
 * 0–100, a position, a count). `variant` is `top1`/`top3` for M-01S and
 * `refusal` for M-20's refusal share; `rival` names the competitor of an
 * M-16/M-17 cell.
 * @typedef {object} GeoMetricCell
 * @property {string} metricId
 * @property {GeoMetricScope} scope
 * @property {string|null} pool
 * @property {string|null} engine
 * @property {string|null} groupId
 * @property {'pilot'|'control'|null} arm
 * @property {string|null} rival
 * @property {string|null} variant
 * @property {number|null} numerator
 * @property {number|null} denominator
 * @property {number|null} value
 * @property {number|null} ciLow
 * @property {number|null} ciHigh
 * @property {'ok'|'insufficient'|'not_measurable'|'absent'} status
 * @property {string|null} reason         a code when the status is not ok (`no_retrieval`, `coverage_below_min`, …)
 * @property {'measured'|'derived'} dataType
 * @property {number} snapshotCount       snapshots in the scope, repeats excluded
 */
/**
 * @typedef {object} GeoMetricsOptions
 * @property {string[]} [pools]            pools to compute (default: every pool of the table)
 * @property {string[]} [engines]          the project's engines; one with no snapshot is `absent`
 * @property {Array<{ id: string, pool: string }>} [groups]  groups to compute (default: those in the rows)
 * @property {{ pilot?: string[], control?: string[] }} [arms]  group ids per arm (default: `isControl`)
 * @property {GeoMetricScope[]} [scopes]   scopes to emit (default: all six)
 * @property {string[]} [competitors]      registered competitor names (default: those in the rows)
 * @property {{ domains?: string[], urls?: string[] }} [owned]  what counts as our source; empty = citation metrics not measurable
 * @property {Record<string, string>} [citationDisplay]  engine -> inline_marker|outside_list|unknown (default: the table)
 */

const TABLE = /** @type {GeoMetricsTable} */ (/** @type {unknown} */ (deepFreeze(metricsTable)))
const SANITY = /** @type {GeoProbeSanityTable} */ (/** @type {unknown} */ (deepFreeze(sanityTable)))

/** The owner's metric table (`geo/metrics.json`), frozen. */
export const GEO_METRICS = TABLE
/** Probe answer sanity markers (`geo/sanity.json`), frozen. */
export const GEO_PROBE_SANITY = SANITY
/** The four question pools, in the table's order. */
export const GEO_METRIC_POOL_IDS = Object.freeze(Object.keys(TABLE.pools))
/** Every metric id of the table, in the table's order. */
export const GEO_METRIC_IDS = Object.freeze(TABLE.metrics.map((metric) => metric.id))
/** @type {readonly GeoMetricScope[]} */
export const GEO_METRIC_SCOPES = Object.freeze(['project', 'pool', 'engine', 'pool_engine', 'group', 'arm'])

const METRIC_INDEX = new Map(TABLE.metrics.map((metric) => [metric.id, metric]))
const COMPUTATION = TABLE.computation
const PLATFORM = TABLE.platform
const DECIMALS = COMPUTATION.value_decimals
const PERCENT = COMPUTATION.percent_scale
const POOL_METRIC_IDS = COMPUTATION.pool_metric_ids
const UNEVEN_METRIC_IDS = new Set(COMPUTATION.uneven_denominator_metric_ids)
const IN_DENOMINATOR = new Set(PLATFORM.in_denominator_statuses)
const SNAPSHOT_STATUSES = new Set(PLATFORM.snapshot_statuses)
const EXCLUDED_ROUND_KINDS = new Set(PLATFORM.excluded_round_kinds)
const INCLUSION_METRIC_IDS = new Set(PLATFORM.inclusion_metric_ids)
const DIMENSION_WEIGHTS = TABLE.gvi.dimension_weights
const DIMENSIONS = Object.keys(DIMENSION_WEIGHTS)

/**
 * A named constant of the table. Throws on an unknown name, so a typo fails
 * where it is written rather than computing with `undefined`.
 * @param {string} name
 * @returns {any}
 */
export function geoConstant(name) {
  if (!Object.hasOwn(TABLE.constants, name)) throw new Error(`geo/metrics.json has no constant ${name}`)
  return TABLE.constants[name]
}

/**
 * A metric's definition (name, formula, unit, pools, …), or null.
 * @param {string} metricId
 * @returns {GeoMetricDefinition|null}
 */
export function geoMetricDefinition(metricId) {
  return METRIC_INDEX.get(metricId) ?? null
}

const MIN_SAMPLES = Number(geoConstant('STD_CELL_MIN_SAMPLES'))
const SOV_COVERAGE_MIN = Number(geoConstant('SOV_COVERAGE_MIN'))
const GVI_CAP = Number(geoConstant(TABLE.gvi.cap))

// ------------------------------------------------------------------ numbers

/**
 * CPython's `round(x, digits)` for a float: half-even on the exact binary
 * value, returned as the double nearest that decimal. `Math.round(x * 100) /
 * 100` differs on exact ties (0.125 → 0.13 instead of 0.12) and on products
 * the multiplication itself rounds.
 * @param {number} x @param {number} digits @returns {number}
 */
export function pythonRound(x, digits) {
  if (!Number.isFinite(x) || x === 0) return x
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, Math.abs(x))
  const high = view.getUint32(0)
  const biased = (high >>> 20) & 0x7ff
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(view.getUint32(4))
  let exponent = -1074
  if (biased !== 0) {
    mantissa |= 1n << 52n
    exponent = biased - 1075
  }
  if (exponent >= 0) return x
  const denominator = 1n << BigInt(-exponent)
  const numerator = mantissa * 10n ** BigInt(digits)
  let quotient = numerator / denominator
  const twice = (numerator % denominator) * 2n
  if (twice > denominator || (twice === denominator && (quotient & 1n) === 1n)) quotient += 1n
  const value = Number(`${quotient}e-${digits}`)
  return x < 0 ? -value : value
}

/**
 * CPython 3.12's `sum()` over floats: the first term exactly, then Neumaier
 * compensated addition. Summing in the same order with the same compensation
 * is what makes a weighted index equal the script's to the last bit.
 * @param {readonly number[]} values @returns {number}
 */
export function pythonSum(values) {
  if (values.length === 0) return 0
  let total = 0 + values[0]
  let compensation = 0
  for (let index = 1; index < values.length; index += 1) {
    const x = values[index]
    const next = total + x
    if (Math.abs(total) >= Math.abs(x)) compensation += (total - next) + x
    else compensation += (x - next) + total
    total = next
  }
  if (compensation !== 0 && Number.isFinite(compensation)) total += compensation
  return total
}

/** @param {number} x */
const round2 = (x) => pythonRound(x, DECIMALS)

/**
 * Wilson 95 % interval on the percent scale, or null where a binomial interval
 * has no meaning (no denominator, a numerator outside 0…denominator).
 * @param {number} numerator @param {number} denominator @returns {[number, number]|null}
 */
export function wilsonInterval(numerator, denominator) {
  if (!denominator || numerator < 0 || numerator > denominator) return null
  const z = COMPUTATION.wilson_z
  const p = numerator / denominator
  const base = 1 + z * z / denominator
  const centre = p + z * z / (2 * denominator)
  const spread = z * Math.sqrt(p * (1 - p) / denominator + z * z / (4 * denominator * denominator))
  return [round2(PERCENT * (centre - spread) / base), round2(PERCENT * (centre + spread) / base)]
}

// ------------------------------------------------------------------ core cells

/**
 * @typedef {{ value: number|null, measurable: boolean, numerator: number|null, denominator: number|null, reason: string|null }} CoreCell
 */

/** @param {number|null} value @param {{ numerator?: number|null, denominator?: number|null }} [parts] @returns {CoreCell} */
function measured(value, parts = {}) {
  return {
    value: value === null ? null : round2(value),
    measurable: true,
    numerator: parts.numerator ?? null,
    denominator: parts.denominator ?? null,
    reason: null,
  }
}

/** @param {string} reason @returns {CoreCell} */
function unmeasurable(reason) {
  return { value: null, measurable: false, numerator: null, denominator: null, reason }
}

/** @param {number} numerator @param {number} denominator @param {string} reasonWhenZero @returns {CoreCell} */
function rate(numerator, denominator, reasonWhenZero) {
  if (!denominator) return { value: null, measurable: false, numerator, denominator, reason: reasonWhenZero }
  return measured(PERCENT * numerator / denominator, { numerator, denominator })
}

/** @param {unknown} value @returns {value is number} */
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * @param {string} metricId @param {CoreCell} core
 * @param {{ scope: GeoMetricScope, pool?: string|null, engine?: string|null, groupId?: string|null, arm?: 'pilot'|'control'|null, rival?: string|null, variant?: string|null }} where
 * @param {number} snapshotCount
 * @returns {GeoMetricCell}
 */
function finish(metricId, core, where, snapshotCount) {
  const definition = /** @type {GeoMetricDefinition} */ (METRIC_INDEX.get(metricId))
  const percent = definition.unit === 'percent'
  const counted = isNumber(core.numerator) && isNumber(core.denominator)
  let status = /** @type {GeoMetricCell['status']} */ ('ok')
  if (!core.measurable) status = 'not_measurable'
  else if (percent && counted && /** @type {number} */ (core.denominator) < MIN_SAMPLES) status = 'insufficient'
  const interval = core.measurable && percent && counted
    ? wilsonInterval(/** @type {number} */ (core.numerator), /** @type {number} */ (core.denominator))
    : null
  return {
    metricId,
    scope: where.scope,
    pool: where.pool ?? null,
    engine: where.engine ?? null,
    groupId: where.groupId ?? null,
    arm: where.arm ?? null,
    rival: where.rival ?? null,
    variant: where.variant ?? null,
    numerator: core.numerator,
    denominator: core.denominator,
    value: core.measurable ? core.value : null,
    ciLow: interval ? interval[0] : null,
    ciHigh: interval ? interval[1] : null,
    status,
    reason: core.measurable ? null : core.reason,
    dataType: definition.channel === 'derived' ? 'derived' : 'measured',
    snapshotCount,
  }
}

/**
 * @param {string} metricId @param {Parameters<typeof finish>[2]} where
 * @param {'absent'|'not_measurable'} status @param {string} reason
 * @returns {GeoMetricCell}
 */
function emptyCell(metricId, where, status, reason) {
  const cell = finish(metricId, unmeasurable(reason), where, 0)
  return { ...cell, status }
}

// ------------------------------------------------------------------ rows

/**
 * @typedef {object} GeoItem
 * @property {GeoFactRow} row
 * @property {string} question
 * @property {string} engine
 * @property {string|null} pool
 * @property {string|null} groupId
 * @property {boolean} isControl
 * @property {string} status
 * @property {boolean} inDenominator
 * @property {boolean} excluded
 * @property {boolean} noise
 * @property {boolean} inclusion
 * @property {number} selfMentions
 * @property {number} entityMentions
 * @property {Record<string, number>} rivalCounts
 * @property {boolean} withAnyBrand
 * @property {boolean} selfFirst
 * @property {number|null} selfPosition
 * @property {boolean} selfTop3
 * @property {boolean} recommended
 * @property {boolean} retrieval
 * @property {Array<{ domain: string, ours: boolean, inBody: boolean|null }>} citations
 * @property {Set<string>} ownedDomains
 * @property {string[]} verdicts
 * @property {string[]} wrongTexts
 * @property {number} redFlagExpected
 * @property {number} redFlagHits
 * @property {boolean|null} safetyHit
 */

/** @param {unknown} url @returns {string} */
function hostOf(url) {
  const match = /https?:\/\/([^/\s]+)/.exec(String(url ?? ''))
  return match ? match[1].toLowerCase() : ''
}

/**
 * The URL key the owner's scripts compare published articles by: lower case,
 * no query or fragment, no scheme, no `www.`, no trailing slash.
 * @param {unknown} url @returns {string}
 */
export function canonicalGeoUrl(url) {
  let text = String(url ?? '').trim().toLowerCase()
  text = text.split('#', 1)[0].split('?', 1)[0]
  text = text.replaceAll('https://', '').replaceAll('http://', '')
  return (text.startsWith('www.') ? text.slice(4) : text).replace(/\/+$/, '')
}

/**
 * @typedef {{ domains: string[], urls: Set<string>, registered: boolean }} OwnedSources
 */

/** @param {GeoMetricsOptions['owned']} owned @returns {OwnedSources} */
function ownedSources(owned) {
  const domains = (owned?.domains ?? []).map((domain) => String(domain ?? '').trim().toLowerCase()).filter(Boolean)
  const urls = new Set((owned?.urls ?? []).map(canonicalGeoUrl).filter(Boolean))
  return { domains, urls, registered: domains.length > 0 || urls.size > 0 }
}

/**
 * Whether a citation points at our source: its host is an owned domain or a
 * subdomain of one, label-aligned (`www.example.com` is `example.com`'s,
 * `notexample.com` is not — the scripts' rule since geo-skills 3.0.1), or it
 * is one of our published article URLs. The parser uses this same function
 * for `facts.cites_ours`, so a page and a metric never disagree about what is
 * ours.
 * @param {GeoCitation} citation @param {{ domains?: string[], urls?: string[] }} owned
 * @returns {boolean}
 */
export function isOurCitation(citation, owned) {
  return citationIsOurs(citation, ownedSources(owned))
}

/** @param {GeoCitation} citation @param {OwnedSources} owned */
function citationIsOurs(citation, owned) {
  const domain = String(citation?.domain || hostOf(citation?.url)).toLowerCase()
  if (domain && owned.domains.some((owner) => domain === owner || domain.endsWith(`.${owner}`))) return true
  const key = canonicalGeoUrl(citation?.url)
  return Boolean(key) && owned.urls.has(key)
}

/**
 * @typedef {{ owned: OwnedSources, display: (engine: string) => string }} Context
 */

/** @param {GeoFactRow} row @param {Context} ctx @returns {GeoItem|null} null when a valid snapshot has no facts yet */
function prepare(row, ctx) {
  if (!row || typeof row !== 'object') throw new TypeError('a GEO metric row must be an object')
  if (!SNAPSHOT_STATUSES.has(row.status)) {
    throw new TypeError(`snapshot ${String(row.snapshotId)} has status ${JSON.stringify(row.status)}, not one of ${[...SNAPSHOT_STATUSES].join('|')}`)
  }
  const inDenominator = IN_DENOMINATOR.has(row.status)
  if (inDenominator && row.status !== 'refusal' && !row.facts) return null
  const facts = inDenominator ? (row.facts ?? {}) : {}
  const brands = Array.isArray(facts.brands) ? facts.brands : []
  const count = (/** @type {GeoBrandMention} */ brand) => (isNumber(brand.count) ? brand.count : 0)
  /** @type {Record<string, number>} */
  const rivalCounts = {}
  for (const brand of brands) if (brand.competitor && count(brand) > 0) rivalCounts[brand.name] = count(brand)
  const citations = (inDenominator && Array.isArray(row.citations) ? row.citations : []).map((citation) => ({
    domain: String(citation?.domain || hostOf(citation?.url)).toLowerCase(),
    ours: citationIsOurs(citation, ctx.owned),
    inBody: typeof citation?.inBody === 'boolean' ? citation.inBody : null,
  }))
  const statements = Array.isArray(facts.statements) ? facts.statements : []
  const judged = statements.filter((statement) => typeof statement?.verdict === 'string' && statement.verdict !== '')
  const position = isNumber(facts.positionOurs) ? facts.positionOurs : null
  const roundKind = row.roundKind ?? null
  return {
    row,
    question: String(row.questionId ?? null),
    engine: String(row.engine ?? ''),
    pool: row.pool || null,
    groupId: row.groupId || null,
    isControl: Boolean(row.isControl),
    status: row.status,
    inDenominator,
    excluded: roundKind !== null && EXCLUDED_ROUND_KINDS.has(roundKind),
    noise: roundKind === PLATFORM.noise_round_kind,
    inclusion: row.surface?.mode === PLATFORM.inclusion_surface_mode,
    selfMentions: brands.filter((brand) => brand.ours).reduce((sum, brand) => sum + count(brand), 0),
    entityMentions: brands.reduce((sum, brand) => sum + count(brand), 0),
    rivalCounts,
    withAnyBrand: brands.some((brand) => (brand.ours || brand.competitor) && count(brand) > 0),
    selfFirst: Boolean(facts.firstOurs),
    selfPosition: position,
    selfTop3: position !== null && position <= COMPUTATION.top_n_variant_max_position,
    recommended: Boolean(facts.recommendedOurs),
    retrieval: Boolean(facts.retrievalTriggered),
    citations,
    ownedDomains: new Set(citations.filter((citation) => citation.ours && citation.domain).map((citation) => citation.domain)),
    verdicts: judged.map((statement) => /** @type {string} */ (statement.verdict)),
    wrongTexts: judged.filter((statement) => statement.verdict === 'wrong').map((statement) => String(statement.text ?? '')),
    redFlagExpected: Array.isArray(facts.redFlagExpected) ? facts.redFlagExpected.length : 0,
    redFlagHits: Array.isArray(facts.redFlagHits) ? facts.redFlagHits.length : 0,
    safetyHit: Array.isArray(facts.safetyTermsHit) ? facts.safetyTermsHit.length > 0 : null,
  }
}

// ------------------------------------------------------------------ one scope

/**
 * Every per-scope metric over one subset of snapshots — the port of the
 * script's `pool_metrics`. Repeats are dropped here; M-20 alone still counts
 * the suspects among them, as the script does.
 * @param {GeoItem[]} items @param {Context} ctx @returns {Record<string, CoreCell>}
 */
function scopeMetrics(items, ctx) {
  const baseline = items.filter((item) => !item.excluded)
  const valid = baseline.filter((item) => item.inDenominator)
  const nValid = valid.length
  const mentioned = valid.filter((item) => item.selfMentions > 0)
  const withAnyBrand = valid.filter((item) => item.withAnyBrand)
  const retrieval = valid.filter((item) => item.retrieval)

  const selfTotal = valid.reduce((sum, item) => sum + item.selfMentions, 0)
  const rivalTotal = valid.reduce((sum, item) => sum + Object.values(item.rivalCounts).reduce((a, b) => a + b, 0), 0)
  const brandTotal = selfTotal + rivalTotal
  const entityTotal = valid.reduce((sum, item) => sum + item.entityMentions, 0)
  const coverage = entityTotal ? brandTotal / entityTotal : null

  let right = 0
  let wrong = 0
  const wrongTexts = new Set()
  for (const item of valid) {
    for (const text of item.wrongTexts) wrongTexts.add(text)
    if (!item.verdicts.length) continue
    if (item.verdicts.includes('wrong')) wrong += 1
    else if (item.verdicts.includes('correct')) right += 1
  }
  const adjudicated = right + wrong

  /** @type {number[]} */
  const positions = []
  for (const item of mentioned) if (item.selfPosition) positions.push(item.selfPosition)
  const positionSum = positions.reduce((sum, position) => sum + position, 0)
  const expectedFlags = valid.reduce((sum, item) => sum + item.redFlagExpected, 0)
  const hitFlags = valid.reduce((sum, item) => sum + item.redFlagHits, 0)
  const safetyExtracted = valid.some((item) => item.safetyHit !== null)
  const inline = retrieval.filter((item) => ctx.display(item.engine) === 'inline_marker')
  const suspects = items.filter((item) => item.status === 'suspect').length

  /** @type {Record<string, CoreCell>} */
  const out = {
    'M-01': rate(mentioned.length, nValid, 'no_valid_answers'),
    'M-02': rate(withAnyBrand.filter((item) => item.selfFirst).length, withAnyBrand.length, 'no_brand_mentioned'),
    'M-03': rate(valid.filter((item) => item.recommended).length, nValid, 'no_valid_answers'),
    'M-04': coverage !== null && coverage >= SOV_COVERAGE_MIN
      ? rate(selfTotal, brandTotal, 'no_brand_mentions')
      : unmeasurable(coverage !== null ? 'coverage_below_min' : 'no_drug_entities'),
    'M-04C': rate(brandTotal, entityTotal, 'no_drug_entities'),
    'M-05': positions.length
      ? measured(positionSum / positions.length, { numerator: positionSum, denominator: positions.length })
      : unmeasurable('not_mentioned'),
    'M-06': rate(right, adjudicated, 'not_adjudicated'),
    'M-07': adjudicated ? measured(wrongTexts.size, { numerator: wrongTexts.size }) : unmeasurable('not_adjudicated'),
    'M-08': ctx.owned.registered
      ? rate(retrieval.filter((item) => item.ownedDomains.size > 0).length, retrieval.length, 'no_retrieval')
      : unmeasurable('owned_not_registered'),
    'M-09': !ctx.owned.registered
      ? unmeasurable('owned_not_registered')
      : retrieval.length
        ? measured(new Set(valid.flatMap((item) => [...item.ownedDomains])).size)
        : unmeasurable('no_retrieval'),
    'M-10': rate(retrieval.length, nValid, 'no_valid_answers'),
    'M-08B': !ctx.owned.registered
      ? unmeasurable('owned_not_registered')
      : inline.length
        ? rate(inline.filter((item) => item.citations.some((c) => c.ours && c.inBody === true)).length, inline.length, 'no_inline_citation_engine')
        : unmeasurable('no_inline_citation_engine'),
    'M-11': rate(hitFlags, expectedFlags, 'no_red_flag_expectations'),
    'M-12': nValid && !safetyExtracted
      ? unmeasurable('not_extracted')
      : rate(valid.filter((item) => item.safetyHit === true).length, nValid, 'no_valid_answers'),
    'M-20': rate(nValid, nValid + suspects, 'no_snapshots'),
  }
  // Rates over questions answered a different number of times are not one
  // rate: a pool whose questions have 3 and 5 valid answers averages two
  // rulers. The script withdraws the pool-level rate; so does this port.
  const perQuestion = new Map()
  for (const item of valid) perQuestion.set(item.question, (perQuestion.get(item.question) ?? 0) + 1)
  if (new Set(perQuestion.values()).size > 1) {
    for (const id of UNEVEN_METRIC_IDS) if (out[id]?.measurable) out[id] = unmeasurable('uneven_denominators')
  }
  return out
}

/** @param {GeoItem[]} items */
const baselineCount = (items) => items.filter((item) => !item.excluded).length

/** @param {GeoItem[]} items @param {Parameters<typeof finish>[2]} where @returns {GeoMetricCell} */
function refusalCell(items, where) {
  const baseline = items.filter((item) => !item.excluded)
  const core = rate(
    baseline.filter((item) => item.status === 'refusal').length,
    baseline.filter((item) => item.inDenominator).length,
    'no_valid_answers',
  )
  return finish('M-20', core, { ...where, variant: 'refusal' }, baseline.length)
}

/** @param {string} metricId @param {string} pool */
const applies = (metricId, pool) => (METRIC_INDEX.get(metricId)?.pools ?? []).includes(pool)

/**
 * The metrics a pool-bound scope reports: those defined for the pool, the
 * risk metric where it is defined (M-15, from its source metric before the
 * pool mask), and the refusal share.
 * @param {string} pool @returns {string[]}
 */
function poolMetricIds(pool) {
  const ids = POOL_METRIC_IDS.filter((id) => applies(id, pool))
  for (const [id, rule] of Object.entries(COMPUTATION.derived_metrics)) {
    if (rule.kind === 'copy' && rule.pool_cell && rule.source?.pool === pool && applies(id, pool)) ids.push(id)
  }
  return ids
}

/**
 * A pool-bound cell's core. A copy metric (M-15 = the risk pool's M-03) reads
 * its source as this scope computed it, BEFORE the pool mask: M-03 is not
 * defined for P4, so the masked cell would never be measurable — the defect
 * geo-skills 3.0.1 fixed in the script.
 * @param {string} metricId @param {Record<string, CoreCell>} core @param {string} pool @returns {CoreCell}
 */
function poolCore(metricId, core, pool) {
  if (core[metricId]) return applies(metricId, pool) ? core[metricId] : unmeasurable('not_applicable')
  const rule = COMPUTATION.derived_metrics[metricId]
  return core[/** @type {{ pool: string, metric: string }} */ (rule.source).metric]
}

/**
 * @param {GeoItem[]} items @param {string} pool @param {Parameters<typeof finish>[2]} where @param {Context} ctx
 * @returns {GeoMetricCell[]}
 */
function poolBoundCells(items, pool, where, ctx) {
  const scoped = { ...where, pool }
  if (!items.length) {
    return [
      ...poolMetricIds(pool).map((id) => emptyCell(id, scoped, 'not_measurable', 'no_snapshots')),
      emptyCell('M-20', { ...scoped, variant: 'refusal' }, 'not_measurable', 'no_snapshots'),
    ]
  }
  const core = scopeMetrics(items, ctx)
  const count = baselineCount(items)
  const cells = poolMetricIds(pool).map((id) => finish(id, poolCore(id, core, pool), scoped, count))
  cells.push(refusalCell(items, scoped))
  return cells
}

/** @param {GeoMetricCell[]} cells @param {GeoItem[]} items */
function inclusionOnly(cells, items) {
  if (!items.some((item) => item.inclusion)) return cells
  return cells.map((cell) => (INCLUSION_METRIC_IDS.has(cell.metricId) && !cell.variant
    ? cell
    : { ...cell, value: null, numerator: null, denominator: null, ciLow: null, ciHigh: null, status: /** @type {const} */ ('not_measurable'), reason: 'inclusion_channel' }))
}

// ------------------------------------------------------------------ the index

/**
 * @typedef {object} GeoPoolIndex
 * @property {string} pool
 * @property {number} weight
 * @property {number|null} value
 * @property {number|null} rawValue
 * @property {'ok'|'not_measurable'} status
 * @property {'IRON-04'|null} cappedBy
 * @property {string[]} redistributed    dimensions that were not measurable; their weight went to the rest
 * @property {Record<string, { value: number|null, measurable: boolean, used: string[] }>} dimensions
 * @property {Record<string, number>} effectiveWeights
 * @property {number} sampleSize         answers in the pool's denominator
 */
/**
 * @typedef {object} GeoGviResult
 * @property {number|null} value
 * @property {'ok'|'not_measurable'} status
 * @property {string|null} reason
 * @property {string[]} poolsUsed
 * @property {string[]} poolsMissing
 * @property {Record<string, GeoPoolIndex>} pools
 * @property {Record<string, number>} poolWeights   each used pool's effective weight after redistribution
 * @property {number} sampleSize
 * @property {{ dimensions: Record<string, string[]>, poolsMissing: string[] }} declaration
 */

/** Dimension → the metric ids that feed it, in the table's order of first appearance. */
const DIMENSION_METRICS = (() => {
  /** @type {Map<string, string[]>} */
  const groups = new Map()
  for (const metric of TABLE.metrics) {
    if (!DIMENSIONS.includes(metric.gvi_group)) continue
    const ids = groups.get(metric.gvi_group) ?? []
    ids.push(metric.id)
    groups.set(metric.gvi_group, ids)
  }
  return groups
})()
const NORMALIZABLE = new Set(COMPUTATION.gvi_normalizable_metric_ids)
const INVERSE_RANK = new Set(COMPUTATION.gvi_inverse_rank_metric_ids)

/**
 * @param {Map<string, GeoMetricCell>} byMetric @param {string} pool @param {number} weight @returns {GeoPoolIndex}
 */
function poolIndex(byMetric, pool, weight) {
  /** @type {GeoPoolIndex['dimensions']} */
  const dimensions = {}
  for (const [dimension, ids] of DIMENSION_METRICS) {
    const values = []
    const used = []
    for (const id of [...ids].sort()) {
      if (!NORMALIZABLE.has(id)) continue
      const cell = byMetric.get(id)
      if (!cell || cell.value === null || (cell.status !== 'ok' && cell.status !== 'insufficient')) continue
      let value = cell.value
      if (INVERSE_RANK.has(id)) value = value ? Math.min(PERCENT, PERCENT / value) : 0
      values.push(value)
      used.push(id)
    }
    dimensions[dimension] = values.length
      ? { value: round2(pythonSum(values) / values.length), measurable: true, used }
      : { value: null, measurable: false, used: [] }
  }
  const measurable = Object.keys(dimensions).filter((dimension) => dimensions[dimension].measurable)
  const redistributed = DIMENSIONS.filter((dimension) => !measurable.includes(dimension)).sort()
  const sampleSize = byMetric.get('M-20')?.numerator ?? 0
  if (!measurable.length) {
    return { pool, weight, value: null, rawValue: null, status: 'not_measurable', cappedBy: null, redistributed, dimensions, effectiveWeights: {}, sampleSize }
  }
  const total = pythonSum(measurable.map((dimension) => DIMENSION_WEIGHTS[dimension]))
  /** @type {Record<string, number>} */
  const effectiveWeights = {}
  for (const dimension of measurable) effectiveWeights[dimension] = DIMENSION_WEIGHTS[dimension] / total
  const raw = pythonSum(measurable.map((dimension) => /** @type {number} */ (dimensions[dimension].value) * (DIMENSION_WEIGHTS[dimension] / total)))
  return {
    pool,
    weight,
    value: round2(Math.min(raw, GVI_CAP)),
    rawValue: round2(raw),
    status: 'ok',
    cappedBy: raw > GVI_CAP ? 'IRON-04' : null,
    redistributed,
    dimensions,
    effectiveWeights,
    sampleSize,
  }
}

/**
 * The composite visibility index (M-19) from the pool-level cells: per pool,
 * the equal-weight mean of each dimension's normalisable metrics, weighted by
 * the dimension weights; then the pools by their weights (P4 carries none).
 * A dimension or pool that is not measurable gives its weight to the rest in
 * proportion, and the result says so (`redistributed`, `poolsMissing`,
 * `declaration`) — the reader is told what the index is made of.
 * @param {GeoMetricCell[]} cells  cells from {@link computeGeoMetrics}
 * @param {{ arm?: 'pilot'|'control'|null }} [options]  read an arm's cells instead of the pools'
 * @returns {GeoGviResult}
 */
export function computeGvi(cells, { arm = null } = {}) {
  const scope = arm ? 'arm' : 'pool'
  /** @type {Record<string, GeoPoolIndex>} */
  const pools = {}
  for (const [pool, spec] of Object.entries(TABLE.pools)) {
    if (!spec.gvi_weight) continue
    const scoped = cells.filter((cell) => cell.scope === scope && cell.pool === pool && cell.arm === (arm ?? null)
      && cell.engine === null && cell.groupId === null && cell.rival === null && cell.variant === null)
    if (!scoped.length || scoped.every((cell) => cell.reason === 'no_snapshots')) continue
    pools[pool] = poolIndex(new Map(scoped.map((cell) => [cell.metricId, cell])), pool, spec.gvi_weight)
  }
  const weighted = Object.keys(TABLE.pools).filter((pool) => TABLE.pools[pool].gvi_weight)
  const used = weighted.filter((pool) => pools[pool]?.status === 'ok')
  const missing = weighted.filter((pool) => !used.includes(pool)).sort()
  /** @type {Record<string, string[]>} */
  const redistributedByPool = {}
  for (const [pool, index] of Object.entries(pools)) redistributedByPool[pool] = index.redistributed
  const declaration = { dimensions: redistributedByPool, poolsMissing: missing }
  if (!used.length) {
    return { value: null, status: 'not_measurable', reason: 'no_measurable_pool', poolsUsed: [], poolsMissing: missing, pools, poolWeights: {}, sampleSize: 0, declaration }
  }
  const total = pythonSum(used.map((pool) => TABLE.pools[pool].gvi_weight))
  const value = pythonSum(used.map((pool) => /** @type {number} */ (pools[pool].value) * (TABLE.pools[pool].gvi_weight / total)))
  /** @type {Record<string, number>} */
  const poolWeights = {}
  for (const pool of used) poolWeights[pool] = TABLE.pools[pool].gvi_weight / total
  return {
    value: round2(Math.min(value, GVI_CAP)),
    status: 'ok',
    reason: null,
    poolsUsed: used,
    poolsMissing: missing,
    pools,
    poolWeights,
    sampleSize: used.reduce((sum, pool) => sum + pools[pool].sampleSize, 0),
    declaration,
  }
}

const GVI_MIN_ANSWERS = Number(geoConstant(PLATFORM.insufficient_gvi_below_answers))

/**
 * @param {{ value: number|null, status: 'ok'|'not_measurable' }} index @param {number} answers
 * @param {Parameters<typeof finish>[2]} where @param {number} count @param {string} reason
 * @returns {GeoMetricCell}
 */
function indexCell(index, answers, where, count, reason) {
  const core = index.status === 'ok'
    ? { value: index.value, measurable: true, numerator: null, denominator: null, reason: null }
    : unmeasurable(reason)
  const cell = finish('M-19', core, where, count)
  return index.status === 'ok' && answers < GVI_MIN_ANSWERS ? { ...cell, status: 'insufficient' } : cell
}

// ------------------------------------------------------------------ the batch

/**
 * @typedef {object} GeoDenominators
 * @property {number} snapshots       snapshots of the batch, repeats excluded
 * @property {number} inDenominator   valid + refusal
 * @property {number} valid
 * @property {number} refusal
 * @property {number} suspect
 * @property {number} failed
 * @property {number} noiseExcluded   noise-round snapshots (their own measurement, never a denominator)
 * @property {number} repeatExcluded  error-confirmation snapshots
 * @property {number} unparsed        valid snapshots without a facts row, left out
 */
/**
 * @typedef {{ cells: GeoMetricCell[], gvi: { project: GeoGviResult, arms: Partial<Record<'pilot'|'control', GeoGviResult>> }, denominators: GeoDenominators }} GeoMetricsResult
 */

/**
 * Every GEO metric of one measurement batch (normally one round), in every
 * scope the pages read:
 *
 * - `project` — the index (M-19), the standard view (M-01S and its top1/top3,
 *   M-08S, M-09S), the derived M-13/M-14/M-15, and each per-scope metric over
 *   the union of the pools it is defined for (M-06 over P1+P2, M-08 over
 *   P1–P3, …). The overview's four numbers are project M-19, M-01S, M-06, M-08.
 * - `pool` — per pool, masked to the metrics defined for it; competitors'
 *   M-16/M-17; the pool's index.
 * - `engine` — per engine over every question in a pool (never a probe outside
 *   the question map, decision 14), not masked; an engine of the project with
 *   no snapshot is `absent`.
 * - `pool_engine`, `group` — the same per-scope metrics on those subsets.
 * - `arm` — per pool for the pilot and the control groups, and each arm's
 *   index: the inputs of the net effect.
 *
 * @param {GeoFactRow[]} rows
 * @param {GeoMetricsOptions} [options]
 * @returns {GeoMetricsResult}
 */
export function computeGeoMetrics(rows, options = {}) {
  const owned = ownedSources(options.owned)
  const display = (/** @type {string} */ engine) =>
    options.citationDisplay?.[engine] ?? TABLE.engines[engine]?.citation_display ?? 'unknown'
  /** @type {Context} */
  const ctx = { owned, display }
  const scopes = new Set(options.scopes ?? GEO_METRIC_SCOPES)
  const poolIds = options.pools ?? GEO_METRIC_POOL_IDS

  let unparsed = 0
  /** @type {GeoItem[]} */
  const items = []
  for (const row of rows) {
    const item = prepare(row, ctx)
    if (item) items.push(item)
    else unparsed += 1
  }
  const pooledAll = items.filter((item) => item.pool)
  const pooled = pooledAll.filter((item) => !item.inclusion)

  const competitors = options.competitors ?? [...new Set(pooled.flatMap((item) => Object.keys(item.rivalCounts)))].sort()

  /** @type {GeoMetricCell[]} */
  const cells = []
  /** @param {GeoMetricScope} scope @param {GeoMetricCell[]} produced */
  const emit = (scope, produced) => {
    if (scopes.has(scope)) cells.push(...produced)
  }

  // ---- pools (always computed: the index and the derived metrics read them)
  /** @type {GeoMetricCell[]} */
  const poolCells = []
  /** @type {Map<string, GeoItem[]>} */
  const poolItems = new Map()
  for (const pool of poolIds) {
    const subset = pooled.filter((item) => item.pool === pool)
    poolItems.set(pool, subset)
    poolCells.push(...poolBoundCells(subset, pool, { scope: 'pool' }, ctx))
    if (!subset.length) continue
    const baseline = subset.filter((item) => !item.excluded)
    const valid = baseline.filter((item) => item.inDenominator)
    const brandTotal = valid.reduce((sum, item) => sum + item.selfMentions + Object.values(item.rivalCounts).reduce((a, b) => a + b, 0), 0)
    for (const rival of competitors) {
      const appearances = valid.filter((item) => item.rivalCounts[rival]).length
      const total = valid.reduce((sum, item) => sum + (item.rivalCounts[rival] ?? 0), 0)
      const where = { scope: /** @type {const} */ ('pool'), pool, rival }
      poolCells.push(finish('M-16', rate(appearances, valid.length, 'no_valid_answers'), where, baseline.length))
      poolCells.push(finish('M-17', rate(total, brandTotal, 'no_brand_mentions'), where, baseline.length))
    }
  }
  const projectIndex = computeGvi(poolCells)
  /** @type {GeoMetricCell[]} */
  const poolIndexCells = []
  for (const pool of poolIds) {
    const index = projectIndex.pools[pool]
    const subset = poolItems.get(pool) ?? []
    if (!TABLE.pools[pool]?.gvi_weight) continue
    if (!index) {
      if (!subset.length) poolIndexCells.push(emptyCell('M-19', { scope: 'pool', pool }, 'not_measurable', 'no_snapshots'))
      continue
    }
    poolIndexCells.push(indexCell(index, index.sampleSize, { scope: 'pool', pool }, baselineCount(subset), 'no_measurable_dimension'))
  }
  emit('pool', [...poolCells, ...poolIndexCells])

  // ---- project
  if (scopes.has('project')) {
    const weightedPools = GEO_METRIC_POOL_IDS.filter((pool) => TABLE.pools[pool].gvi_weight)
    const inPools = (/** @type {readonly string[]} */ pools) => pooled.filter((item) => pools.includes(/** @type {string} */ (item.pool)))
    const project = { scope: /** @type {const} */ ('project') }
    cells.push(indexCell(projectIndex, projectIndex.sampleSize, project, baselineCount(inPools(weightedPools)), 'no_measurable_pool'))

    const baseline = pooled.filter((item) => !item.excluded && item.inDenominator)
    const standardPools = (/** @type {string} */ id) => /** @type {GeoMetricDefinition} */ (METRIC_INDEX.get(id)).pools
    const category = baseline.filter((item) => standardPools('M-01S').includes(/** @type {string} */ (item.pool)))
    const categoryCount = baselineCount(inPools(standardPools('M-01S')))
    cells.push(finish('M-01S', rate(category.filter((item) => item.selfMentions > 0).length, category.length, 'no_valid_answers'), project, categoryCount))
    cells.push(finish('M-01S', rate(category.filter((item) => item.selfFirst).length, category.length, 'no_valid_answers'), { ...project, variant: 'top1' }, categoryCount))
    cells.push(finish('M-01S', rate(category.filter((item) => item.selfTop3).length, category.length, 'no_valid_answers'), { ...project, variant: 'top3' }, categoryCount))
    const sourced = baseline.filter((item) => standardPools('M-08S').includes(/** @type {string} */ (item.pool)))
    const citations = baseline.filter((item) => standardPools('M-09S').includes(/** @type {string} */ (item.pool))).flatMap((item) => item.citations)
    cells.push(finish('M-08S', owned.registered
      ? rate(sourced.filter((item) => item.ownedDomains.size > 0).length, sourced.length, 'no_valid_answers')
      : unmeasurable('owned_not_registered'), project, baselineCount(inPools(standardPools('M-08S')))))
    cells.push(finish('M-09S', owned.registered
      ? rate(citations.filter((citation) => citation.ours).length, citations.length, 'no_citations')
      : unmeasurable('owned_not_registered'), project, baselineCount(inPools(standardPools('M-09S')))))

    // derived metrics, from the pool cells exactly as the script derives them
    const poolCell = (/** @type {string} */ pool, /** @type {string} */ id) =>
      (poolItems.get(pool)?.length ? poolCells.find((cell) => cell.pool === pool && cell.metricId === id && !cell.variant && !cell.rival) : undefined)
    for (const [id, rule] of Object.entries(COMPUTATION.derived_metrics)) {
      if (rule.kind === 'ratio') {
        const top = /** @type {{ pool: string, metric: string }} */ (rule.numerator)
        const bottom = /** @type {{ pool: string, metric: string }} */ (rule.denominator)
        const a = poolCell(top.pool, top.metric)
        const b = poolCell(bottom.pool, bottom.metric)
        const derivable = a && b && a.value !== null && b.value !== null && b.value !== 0 && a.status !== 'not_measurable' && b.status !== 'not_measurable'
        cells.push(finish(id, derivable
          ? measured(/** @type {number} */ (a.value) / /** @type {number} */ (b.value), { numerator: a.value, denominator: b.value })
          : unmeasurable('conversion_not_derivable'), project, baselineCount(inPools([top.pool, bottom.pool]))))
        continue
      }
      const source = /** @type {{ pool: string, metric: string }} */ (rule.source)
      const cell = poolCell(source.pool, id) ?? poolCell(source.pool, source.metric)
      const core = cell
        ? { value: cell.value, measurable: cell.status === 'ok' || cell.status === 'insufficient', numerator: cell.numerator, denominator: cell.denominator, reason: cell.reason }
        : unmeasurable('no_snapshots')
      cells.push(finish(id, core, project, baselineCount(inPools([source.pool]))))
    }

    // per-scope metrics over the union of the pools each is defined for
    /** @type {Map<string, Record<string, CoreCell>>} */
    const byPools = new Map()
    for (const id of POOL_METRIC_IDS) {
      const pools = /** @type {GeoMetricDefinition} */ (METRIC_INDEX.get(id)).pools
      const key = pools.join('+')
      const subset = inPools(pools)
      if (!byPools.has(key)) byPools.set(key, scopeMetrics(subset, ctx))
      cells.push(finish(id, /** @type {Record<string, CoreCell>} */ (byPools.get(key))[id], project, baselineCount(subset)))
    }
    cells.push(refusalCell(pooled, project))
  }

  // ---- engines
  const configured = options.engines ?? []
  const engines = [...configured, ...[...new Set(pooledAll.map((item) => item.engine))].filter((engine) => !configured.includes(engine)).sort()]
  if (scopes.has('engine')) {
    for (const engine of engines) {
      const subset = pooledAll.filter((item) => item.engine === engine)
      const where = { scope: /** @type {const} */ ('engine'), engine }
      if (!subset.length) {
        cells.push(...POOL_METRIC_IDS.map((id) => emptyCell(id, where, 'absent', 'engine_absent')))
        cells.push(emptyCell('M-20', { ...where, variant: 'refusal' }, 'absent', 'engine_absent'))
        continue
      }
      const core = scopeMetrics(subset, ctx)
      const count = baselineCount(subset)
      cells.push(...inclusionOnly([...POOL_METRIC_IDS.map((id) => finish(id, core[id], where, count)), refusalCell(subset, where)], subset))
    }
  }
  if (scopes.has('pool_engine')) {
    for (const pool of poolIds) {
      for (const engine of engines) {
        const subset = pooledAll.filter((item) => item.pool === pool && item.engine === engine)
        const where = { scope: /** @type {const} */ ('pool_engine'), pool, engine }
        if (!subset.length) {
          cells.push(...poolMetricIds(pool).map((id) => emptyCell(id, where, 'absent', 'engine_absent')))
          cells.push(emptyCell('M-20', { ...where, variant: 'refusal' }, 'absent', 'engine_absent'))
          continue
        }
        cells.push(...inclusionOnly(poolBoundCells(subset, pool, where, ctx), subset))
      }
    }
  }

  // ---- groups
  if (scopes.has('group')) {
    const groups = options.groups ?? groupsOf(pooled)
    for (const group of groups) {
      const subset = pooled.filter((item) => item.groupId === group.id)
      cells.push(...poolBoundCells(subset, group.pool, { scope: 'group', groupId: group.id }, ctx))
    }
  }

  // ---- arms
  /** @type {Partial<Record<'pilot'|'control', GeoGviResult>>} */
  const armIndexes = {}
  if (scopes.has('arm')) {
    const arms = armsOf(pooled, options.arms)
    for (const arm of /** @type {const} */ (['pilot', 'control'])) {
      const members = arms[arm]
      /** @type {GeoMetricCell[]} */
      const armCells = []
      /** @type {Map<string, number>} */
      const armCounts = new Map()
      for (const pool of poolIds) {
        const subset = pooled.filter((item) => item.pool === pool && item.groupId !== null && members.has(item.groupId))
        if (!subset.length) continue
        armCounts.set(pool, baselineCount(subset))
        armCells.push(...poolBoundCells(subset, pool, { scope: 'arm', arm }, ctx))
      }
      const index = computeGvi(armCells, { arm })
      armIndexes[arm] = index
      for (const [pool, poolIdx] of Object.entries(index.pools)) {
        armCells.push(indexCell(poolIdx, poolIdx.sampleSize, { scope: 'arm', pool, arm }, armCounts.get(pool) ?? 0, 'no_measurable_dimension'))
      }
      const weightedCount = [...armCounts].filter(([pool]) => TABLE.pools[pool]?.gvi_weight).reduce((sum, [, n]) => sum + n, 0)
      armCells.push(indexCell(index, index.sampleSize, { scope: 'arm', arm }, weightedCount, 'no_measurable_pool'))
      cells.push(...armCells)
    }
  }

  const baselineAll = items.filter((item) => !item.excluded)
  return {
    cells,
    gvi: { project: projectIndex, arms: armIndexes },
    denominators: {
      snapshots: baselineAll.length,
      inDenominator: baselineAll.filter((item) => item.inDenominator).length,
      valid: baselineAll.filter((item) => item.status === 'valid').length,
      refusal: baselineAll.filter((item) => item.status === 'refusal').length,
      suspect: baselineAll.filter((item) => item.status === 'suspect').length,
      failed: baselineAll.filter((item) => item.status === 'failed').length,
      noiseExcluded: items.filter((item) => item.noise).length,
      repeatExcluded: items.filter((item) => item.excluded && !item.noise).length,
      unparsed,
    },
  }
}

/** @param {GeoItem[]} items @returns {Array<{ id: string, pool: string }>} */
function groupsOf(items) {
  /** @type {Map<string, string>} */
  const pools = new Map()
  for (const item of items) if (item.groupId && item.pool && !pools.has(item.groupId)) pools.set(item.groupId, item.pool)
  return [...pools].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, pool]) => ({ id, pool }))
}

/** @param {GeoItem[]} items @param {GeoMetricsOptions['arms']} arms */
function armsOf(items, arms) {
  if (arms) return { pilot: new Set(arms.pilot ?? []), control: new Set(arms.control ?? []) }
  const pilot = new Set()
  const control = new Set()
  for (const item of items) if (item.groupId) (item.isControl ? control : pilot).add(item.groupId)
  return { pilot, control }
}

/**
 * The snapshot rows behind one cell, for 「点开这条回答」: the same selection
 * {@link computeGeoMetrics} made (repeats excluded, probes outside the question
 * map excluded). Pass the `arms` used for the batch when the cell is an arm's.
 * @param {GeoFactRow[]} rows @param {GeoMetricCell} cell @param {{ arms?: GeoMetricsOptions['arms'] }} [options]
 * @returns {GeoFactRow[]}
 */
export function geoCellRows(rows, cell, options = {}) {
  const inScope = rows.filter((row) => row.pool && !(row.roundKind && EXCLUDED_ROUND_KINDS.has(row.roundKind)))
  const pools = cell.pool ? [cell.pool] : cell.scope === 'engine' ? GEO_METRIC_POOL_IDS : (METRIC_INDEX.get(cell.metricId)?.pools ?? GEO_METRIC_POOL_IDS)
  let armGroups = null
  if (cell.arm) {
    const arms = options.arms
    armGroups = arms
      ? new Set(arms[cell.arm] ?? [])
      : new Set(inScope.filter((row) => row.groupId && Boolean(row.isControl) === (cell.arm === 'control')).map((row) => row.groupId))
  }
  return inScope.filter((row) => pools.includes(/** @type {string} */ (row.pool))
    && (cell.engine === null || row.engine === cell.engine)
    && (cell.groupId === null || row.groupId === cell.groupId)
    && (armGroups === null || (row.groupId != null && armGroups.has(row.groupId)))
    && (cell.scope === 'engine' || cell.scope === 'pool_engine' || row.surface?.mode !== PLATFORM.inclusion_surface_mode))
}

// ------------------------------------------------------------------ noise, trend, net effect

/**
 * @typedef {object} GeoNoiseBand
 * @property {string} metricId
 * @property {number|null} value         the band on the metric's scale (percentage points)
 * @property {boolean} measured
 * @property {string|null} reason
 * @property {number|null} sd            standard deviation of the per-repeat rates
 * @property {number} multiplier
 * @property {Array<{ repeatIndex: number, numerator: number, denominator: number, value: number|null }>} repeats
 */

const NOISE_COUNTERS = /** @type {Record<string, (item: GeoItem) => boolean>} */ ({
  'M-01': (item) => item.selfMentions > 0,
  'M-03': (item) => item.recommended,
  'M-10': (item) => item.retrieval,
})

/**
 * The noise band from a noise round (the same questions asked of the same
 * engines several times, nothing else changing): the metric is computed on
 * each repeat, and the band is `noise_band_sd_multiplier` × the standard
 * deviation of those repeat values — the A/A spread a week-on-week change
 * must clear before it is a change. geo-skills leaves this number to the
 * skill; the definition here is the platform's and is recorded in the table.
 * @param {GeoFactRow[]} noiseRows @param {{ metricId?: string }} [options] @returns {GeoNoiseBand}
 */
export function noiseBand(noiseRows, { metricId = 'M-01' } = {}) {
  if (!PLATFORM.noise_band_metric_ids.includes(metricId)) {
    throw new RangeError(`a noise band is defined for ${PLATFORM.noise_band_metric_ids.join(', ')}, not ${metricId}`)
  }
  const multiplier = PLATFORM.noise_band_sd_multiplier
  const counter = NOISE_COUNTERS[metricId]
  /** @type {Context} */
  const ctx = { owned: ownedSources(undefined), display: () => 'unknown' }
  /** @type {Map<number, GeoItem[]>} */
  const byRepeat = new Map()
  for (const row of noiseRows) {
    const item = prepare(row, ctx)
    if (!item || !item.inDenominator || item.inclusion || !item.pool) continue
    const index = isNumber(row.repeatIndex) ? row.repeatIndex : 0
    const bucket = byRepeat.get(index) ?? []
    bucket.push(item)
    byRepeat.set(index, bucket)
  }
  const repeats = [...byRepeat.keys()].sort((a, b) => a - b).map((repeatIndex) => {
    const valid = /** @type {GeoItem[]} */ (byRepeat.get(repeatIndex))
    const numerator = valid.filter(counter).length
    return { repeatIndex, numerator, denominator: valid.length, exact: valid.length ? PERCENT * numerator / valid.length : null }
  })
  const values = repeats.map((repeat) => repeat.exact).filter(isNumber)
  const shown = repeats.map(({ exact, ...rest }) => ({ ...rest, value: exact === null ? null : round2(exact) }))
  if (values.length < 2) {
    return { metricId, value: null, measured: false, reason: 'too_few_repeats', sd: null, multiplier, repeats: shown }
  }
  const mean = pythonSum(values) / values.length
  const sd = Math.sqrt(pythonSum(values.map((value) => (value - mean) ** 2)) / (values.length - 1))
  return { metricId, value: round2(multiplier * sd), measured: true, reason: null, sd, multiplier, repeats: shown }
}

/**
 * @typedef {{ date: string, value?: number|null, numerator?: number|null, denominator?: number|null }} GeoSeriesPoint
 * @typedef {{ date: string, value: number|null, numerator: number|null, denominator: number|null, points: number }} GeoTrendPoint
 */

/** @param {string} date @returns {number} */
function dayOf(date) {
  const time = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(time)) throw new TypeError(`not a date: ${JSON.stringify(date)}`)
  return Math.round(time / 86_400_000)
}

/**
 * @param {GeoSeriesPoint[]} points  sorted by date
 * @param {number} end  day number of the window's last day
 * @param {number} weeks
 * @returns {GeoTrendPoint|null}
 */
function windowValue(points, end, weeks) {
  const inWindow = points.filter((point) => {
    const day = dayOf(point.date)
    return day <= end && day > end - weeks * 7
  })
  if (!inWindow.length) return null
  const date = inWindow[inWindow.length - 1].date
  if (inWindow.every((point) => isNumber(point.numerator) && isNumber(point.denominator))) {
    const numerator = inWindow.reduce((sum, point) => sum + /** @type {number} */ (point.numerator), 0)
    const denominator = inWindow.reduce((sum, point) => sum + /** @type {number} */ (point.denominator), 0)
    return { date, value: denominator ? round2(PERCENT * numerator / denominator) : null, numerator, denominator, points: inWindow.length }
  }
  const values = inWindow.map((point) => point.value).filter(isNumber)
  return { date, value: values.length ? round2(pythonSum(values) / values.length) : null, numerator: null, denominator: null, points: inWindow.length }
}

/**
 * The rolling trend of a metric's series: for each point, the window of the
 * last `weeks` weeks ending on it. Points that carry numerator and
 * denominator pool into one rate (k/n summed — a big week weighs more than a
 * small one); points without them (the index) average.
 * @param {GeoSeriesPoint[]} points
 * @param {number} [weeks]  default ROLLING_WINDOW_WEEKS
 * @returns {GeoTrendPoint[]}
 */
export function rollingTrend(points, weeks = Number(geoConstant(TABLE.net_effect.window_weeks))) {
  const sorted = [...points].sort((a, b) => dayOf(a.date) - dayOf(b.date))
  return sorted.map((point) => /** @type {GeoTrendPoint} */ (windowValue(sorted, dayOf(point.date), weeks)))
}

/**
 * @typedef {object} GeoNetEffect
 * @property {'computed'|'not_computable'} status
 * @property {number|null} [value]          pilot change − control change, rounded
 * @property {number} [pilotChange]
 * @property {number} [controlChange]
 * @property {'up'|'down'|'flat'} [verdict]  flat when |net| does not exceed the noise threshold
 * @property {number} [noiseThreshold]
 * @property {boolean} [noiseMeasured]      false = the default threshold was used (say 「噪声阈值未实测」)
 * @property {{ baseline: GeoTrendPoint, current: GeoTrendPoint }} [pilot]
 * @property {{ baseline: GeoTrendPoint, current: GeoTrendPoint }} [control]
 * @property {Array<{ input: string, reason: string }>} [missing]
 */

/**
 * The net effect of placement, the only acceptance figure (plan §4.4):
 * (pilot's current window − its baseline window) − (control's current window
 * − its baseline window), each window `ROLLING_WINDOW_WEEKS` weeks. Within the
 * noise threshold — measured by {@link noiseBand}, or the default and flagged
 * as not measured — it is flat, never an arrow. Fewer control groups than the
 * table's minimum, or a missing window, is `not_computable`, never a number.
 * @param {GeoSeriesPoint[]} pilotSeries
 * @param {GeoSeriesPoint[]} controlSeries
 * @param {{ noise?: { value: number|null, measured: boolean }|null, weeks?: number, baselineDate?: string|null, controlGroupCount?: number|null }} [options]
 * @returns {GeoNetEffect}
 */
export function netEffect(pilotSeries, controlSeries, options = {}) {
  const weeks = options.weeks ?? Number(geoConstant(TABLE.net_effect.window_weeks))
  /** @type {Array<{ input: string, reason: string }>} */
  const missing = []
  if (isNumber(options.controlGroupCount) && options.controlGroupCount < TABLE.net_effect.control_group_count_min) {
    missing.push({ input: 'control', reason: 'too_few_control_groups' })
  }
  /** @type {Record<string, { baseline: GeoTrendPoint, current: GeoTrendPoint }>} */
  const arms = {}
  for (const [arm, series] of /** @type {const} */ ([['pilot', pilotSeries], ['control', controlSeries]])) {
    const sorted = [...(series ?? [])].sort((a, b) => dayOf(a.date) - dayOf(b.date))
    if (!sorted.length) {
      missing.push({ input: arm, reason: 'no_points' })
      continue
    }
    const baselineEnd = dayOf(options.baselineDate ?? sorted[0].date)
    const baseline = windowValue(sorted, baselineEnd, weeks)
    const current = windowValue(sorted, dayOf(sorted[sorted.length - 1].date), weeks)
    if (!baseline || baseline.value === null) missing.push({ input: `${arm}.baseline`, reason: 'not_measurable' })
    if (!current || current.value === null) missing.push({ input: `${arm}.current`, reason: 'not_measurable' })
    if (baseline && current) arms[arm] = { baseline, current }
  }
  if (missing.length) return { status: 'not_computable', missing }
  const measuredNoise = options.noise?.measured === true && isNumber(options.noise.value)
  const threshold = measuredNoise
    ? /** @type {number} */ (options.noise?.value)
    : Number(geoConstant('RANKING_NOISE_DEFAULT_THRESHOLD'))
  const pilotChange = /** @type {number} */ (arms.pilot.current.value) - /** @type {number} */ (arms.pilot.baseline.value)
  const controlChange = /** @type {number} */ (arms.control.current.value) - /** @type {number} */ (arms.control.baseline.value)
  const net = pilotChange - controlChange
  const compared = pythonRound(net, 9)
  return {
    status: 'computed',
    value: round2(net),
    pilotChange,
    controlChange,
    verdict: Math.abs(compared) <= threshold ? 'flat' : compared > 0 ? 'up' : 'down',
    noiseThreshold: threshold,
    noiseMeasured: measuredNoise,
    pilot: arms.pilot,
    control: arms.control,
  }
}

// ------------------------------------------------------------------ hard lines, names

/**
 * @typedef {{ id?: string|null, status?: string|null, severity?: string|null, citedSource?: { url?: string|null, domain?: string|null, attribute?: string|null }|null }} GeoErrorRow
 */
/**
 * @typedef {object} GeoHardLines
 * @property {boolean|null} met   null when the accuracy is not measurable
 * @property {{ metricId: string, value: number|null, share: number|null, line: number, met: boolean|null, status: string|null, numerator: number|null, denominator: number|null }} accuracy
 * @property {{ open: number, ids: string[], bySeverity: Record<string, number>, met: boolean }} retrievalErrors
 * @property {{ open: number, ids: string[], bySeverity: Record<string, number>, blocking: false }} parametricErrors
 */

/**
 * The two hard lines (plan §4.2, decisions #1–#2): fact accuracy (M-06) at
 * or above ACCURACY_HARD_LINE, and no open 讲错我方 traced to a cited source
 * (the retrieval layer, correctable in period). Misstatements from the
 * model's own knowledge are listed apart and never block.
 * @param {GeoMetricCell[]} cells
 * @param {GeoErrorRow[]} errors  the project's `errors` rows
 * @param {{ accuracyCell?: GeoMetricCell|null }} [options]  default: the project-scope M-06 cell
 * @returns {GeoHardLines}
 */
export function hardLines(cells, errors, options = {}) {
  const line = Number(geoConstant('ACCURACY_HARD_LINE'))
  const cell = options.accuracyCell
    ?? cells.find((candidate) => candidate.scope === 'project' && candidate.metricId === 'M-06' && candidate.variant === null)
    ?? null
  const value = cell && cell.value !== null && (cell.status === 'ok' || cell.status === 'insufficient') ? cell.value : null
  const share = value === null ? null : value / PERCENT
  const accuracyMet = share === null ? null : share >= line
  const closed = new Set(PLATFORM.error_closed_statuses)
  const open = (errors ?? []).filter((error) => !closed.has(String(error?.status ?? '')))
  const retrieval = open.filter((error) => {
    const source = error?.citedSource
    return Boolean(source && (source.url || source.domain) && source.attribute !== 'none')
  })
  const parametric = open.filter((error) => !retrieval.includes(error))
  /** @param {GeoErrorRow[]} list */
  const bySeverity = (list) => {
    /** @type {Record<string, number>} */
    const counts = {}
    for (const error of list) {
      const severity = String(error?.severity ?? 'unknown')
      counts[severity] = (counts[severity] ?? 0) + 1
    }
    return counts
  }
  const retrievalMet = retrieval.length === 0
  return {
    met: accuracyMet === null ? null : accuracyMet && retrievalMet,
    accuracy: {
      metricId: 'M-06',
      value,
      share,
      line,
      met: accuracyMet,
      status: cell?.status ?? null,
      numerator: cell?.numerator ?? null,
      denominator: cell?.denominator ?? null,
    },
    retrievalErrors: { open: retrieval.length, ids: retrieval.map((error) => String(error?.id ?? '')), bySeverity: bySeverity(retrieval), met: retrievalMet },
    parametricErrors: { open: parametric.length, ids: parametric.map((error) => String(error?.id ?? '')), bySeverity: bySeverity(parametric), blocking: false },
  }
}

/**
 * The T/CAACCHINA 001–005—2026 name of a metric (X-STDVIS): only metrics whose
 * formula is the standard's carry one — M-01S (可见率; top1 首推率, top3
 * 前三推荐率), M-04 (可见份额, a reference line, never a KPI), M-05, M-06,
 * M-08S, M-09S. M-01/M-02/M-03 are not renamed. Null when there is none.
 * @param {string} metricId @param {string|null} [variant] @returns {string|null}
 */
export function standardName(metricId, variant = null) {
  const definition = METRIC_INDEX.get(metricId)
  if (variant) return definition?.variants?.[variant] ?? null
  if (definition?.standard_alias) return definition.standard_alias
  for (const [alias, target] of Object.entries(TABLE.standard_aliases)) {
    if (target.metric === metricId && !target.variant) return alias
  }
  return null
}

// ------------------------------------------------------------------ helpers

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
