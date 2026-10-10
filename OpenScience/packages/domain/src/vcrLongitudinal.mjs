/** Longitudinal research contracts. Semantic mappings are supplied by the researcher
 * or the agent; arithmetic, replay and provenance are deterministic. An incomplete
 * row affects that row or metric, never the rest of the research package. */
export const VCR_LONGITUDINAL_SCHEMA = 1
export const VCR_LONGITUDINAL_METHODS = Object.freeze({
  'forecast.trajectories': { version: '1.0.0', modelTier: null },
  'forecast.evaluate': { version: '1.0.0', modelTier: null },
  'forecast.compare': { version: '1.0.0', modelTier: null },
  'forecast.trial_benchmark': { version: '1.0.0', modelTier: null },
})
export const VCR_LONGITUDINAL_JOBS = Object.freeze({
  forecast_trajectories: 'forecast.trajectories', evaluate_forecast: 'forecast.evaluate',
  compare_forecasts: 'forecast.compare', benchmark_trial_effect: 'forecast.trial_benchmark',
})
export const VCR_PREDICTION_TYPES = Object.freeze(['continuous', 'risk', 'survival_probability', 'rate'])
export const VCR_FORECAST_UNCERTAINTY = Object.freeze(['predictive', 'parameter', 'model', 'monte_carlo', 'unknown'])
export const VCR_LONGITUDINAL_LIMITS = Object.freeze({ events: 500_000, forecasts: 100_000, samples: 1_000, horizons: 100, bootstrap: 500 })

/** @param {unknown} value @returns {Record<string, any>} */
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
/** @param {unknown} value @returns {any[]} */
const arr = value => Array.isArray(value) ? value : []
/** Empty cells are missing, never zero. @param {unknown} value */
export function longitudinalNumber(value) {
  if (value == null || typeof value === 'boolean' || typeof value === 'object' || String(value).trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
/** @param {unknown} value */
export function longitudinalInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null
  const n = Date.parse(value)
  if (!Number.isFinite(n)) return null
  const day = value.slice(0,10)
  if (new Date(`${day}T00:00:00.000Z`).toISOString().slice(0,10) !== day) return null
  return Number.isFinite(n) ? new Date(n).toISOString() : null
}
/** @param {number[]} values */
export const longitudinalMean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
/** @param {number[]} values */
export function longitudinalVariance(values) {
  const m = longitudinalMean(values)
  return m != null && values.length > 1 ? values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1) : null
}
/** @param {number[]} values @param {number} p */
export function longitudinalQuantile(values, p) {
  if (!values.length) return null
  const xs = [...values].sort((a, b) => a - b), pos = (xs.length - 1) * p, low = Math.floor(pos)
  return xs[low] + (xs[Math.ceil(pos)] - xs[low]) * (pos - low)
}

/** Content identity is provided by the server's SHA-256. This pure conversion
 * retains the original cell, unit, source row and transformation rather than
 * silently assigning medical meaning to a code or changing its unit.
 * @param {{header:string[],rows:string[][]}} table @param {Record<string, any>} map
 * @param {{inputId:string,inputHash:string,valueSource:string,ingestedAt:string}} source
 * @returns {{events:any[],issues:any[]}} */
export function eventsFromMappedTable(table, map, source) {
  const at = new Map(table.header.map((key, index) => [key, index]))
  const fields = ['subjectColumn','valueColumn','codeColumn','unitColumn','occurredColumn','recordedColumn','availableColumn',
    'eventIdColumn','revisionColumn','supersedesColumn','siteColumn','assertionColumn','experiencerColumn','medicationStateColumn']
  const absent = fields.filter(k => map[k] && !at.has(map[k]))
  if (absent.length || !map.subjectColumn || !map.occurredColumn || (!map.code && !map.codeColumn)) {
    return { events: [], issues: [{ code: 'mapping_columns_missing', inputId: source.inputId, fields: absent }] }
  }
  /** @param {string[]} row @param {string} key */
  const cell = (row, key) => map[key] ? String(row[at.get(map[key]) ?? -1] ?? '').trim() : ''
  /** @type {any[]} */ const events = [], issues = []
  for (const [index, row] of table.rows.entries()) {
    const subjectKey = cell(row, 'subjectColumn'), code = cell(row, 'codeColumn') || String(map.code ?? '')
    if (!subjectKey || !code) { issues.push({ code: 'event_identity_missing', row: index + 2, inputId: source.inputId }); continue }
    const originalValue = cell(row, 'valueColumn'), originalUnit = cell(row, 'unitColumn') || String(map.unit ?? '')
    events.push({ subjectKey, code, kind: map.kind ?? 'measurement', value: longitudinalNumber(originalValue), originalValue,
      unit: originalUnit || null, originalUnit: originalUnit || null, valueSource: source.valueSource,
      occurredAt: longitudinalInstant(cell(row, 'occurredColumn')), recordedAt: longitudinalInstant(cell(row, 'recordedColumn')),
      availableAt: longitudinalInstant(cell(row, 'availableColumn')), ingestedAt: source.ingestedAt,
      availabilityBasis: map.availableColumn ? 'source_column' : 'unknown',
      sourceEventId: cell(row, 'eventIdColumn') || null, revision: longitudinalNumber(cell(row, 'revisionColumn')),
      supersedes: cell(row, 'supersedesColumn') || null, site: cell(row, 'siteColumn') || null,
      assertion: cell(row, 'assertionColumn') || 'unknown', experiencer: cell(row, 'experiencerColumn') || 'unknown',
      medicationState: cell(row, 'medicationStateColumn') || 'unknown',
      source: { inputId: source.inputId, hash: source.inputHash, row: index + 2, column: map.valueColumn ?? null },
      transformation: { kind: 'field_mapping', basis: map.basis ?? 'model_inferred', version: map.version ?? '1' },
    })
  }
  return { events, issues }
}

/** Source revisions are resolved only among records available at the cutoff.
 * Unknown time remains visible in coverage, not in a replay's predictors.
 * Conflicting same-revision events are retained and labelled; never guessed away.
 * @param {any[]} events @param {string} asOf */
export function replayClinicalEvents(events, asOf) {
  const cutoff = longitudinalInstant(asOf)
  if (!cutoff) throw new TypeError('A history requires an ISO prediction origin.')
  /** @type {Record<string, number>} */
  const excluded = { future_occurrence: 0, not_available: 0, unknown_time: 0, duplicate: 0, superseded: 0 }
  /** @type {Map<string, any>} */ const exact = new Map()
  /** @type {Map<string, any[]>} */ const revisions = new Map()
  /** @type {Map<string,string>} */ const parents = new Map()
  /** @param {string} key @returns {string} */
  const root = key => { let current = key; const seen = new Set(); while (parents.has(current) && !seen.has(current)) { seen.add(current); current = parents.get(current) ?? current } return current }
  /** @param {any} event @param {string} id */
  const eventKey = (event,id) => `${event.subjectKey}\0${event.source?.inputNamespace ?? event.source?.inputId ?? ''}\0${id}`
  /** @type {any[]} */ const unversioned = [], conflicts = []
  for (const event of events) {
    if (!event.occurredAt || !event.availableAt) { excluded.unknown_time++; continue }
    if (event.occurredAt > cutoff) { excluded.future_occurrence++; continue }
    if (event.availableAt > cutoff) { excluded.not_available++; continue }
    const identity = JSON.stringify([event.subjectKey, event.code, event.occurredAt, event.availableAt, event.originalValue,
      event.unit, event.sourceEventId, event.revision, event.assertion, event.experiencer, event.medicationState,
      event.source?.inputNamespace ?? null, ...(event.sourceEventId ? [] : [event.source?.hash,event.source?.row])])
    if (exact.has(identity)) { excluded.duplicate++; continue }
    exact.set(identity, event)
    if (!event.sourceEventId) { unversioned.push(event); continue }
    if (event.supersedes) {
      const child = root(eventKey(event,event.sourceEventId)), parent = root(eventKey(event,event.supersedes))
      if (child !== parent) parents.set(child,parent)
    }
  }
  for (const event of exact.values()) {
    if (!event.sourceEventId) continue
    const key = root(eventKey(event,event.sourceEventId))
    if (!revisions.has(key)) revisions.set(key,[])
    revisions.get(key)?.push(event)
  }
  const kept = [...unversioned]
  for (const rows of revisions.values()) {
    if (rows.length === 1) { kept.push(rows[0]); continue }
    // Without a revision number an apparent correction is not automatically a replacement.
    const highest = rows.reduce((n,row) => Math.max(n,row.revision ?? -Infinity),-Infinity)
    const ranked = rows.every(row => Number.isInteger(row.revision))
      ? rows.filter(row => row.revision === highest) : rows
    excluded.superseded += rows.length - ranked.length
    if (ranked.length > 1) conflicts.push({ code: 'event_revision_conflict', events: ranked.length })
    kept.push(...ranked.map(row => ({ ...row, conflict: ranked.length > 1 })))
  }
  kept.sort((a, b) => a.subjectKey.localeCompare(b.subjectKey) || a.occurredAt.localeCompare(b.occurredAt) || a.code.localeCompare(b.code))
  return { asOf: cutoff, events: kept, coverage: { received: events.length, retained: kept.length, excluded, conflicts: conflicts.length }, issues: conflicts }
}

/** A task-specific inventory, without a minimum patient-count admission rule.
 * @param {any[]} events @param {Record<string, any>} [coverage] */
export function longitudinalReadiness(events, coverage = {}) {
  /** @type {Map<string, any[]>} */ const subjects = new Map()
  /** @type {Map<string, any[]>} */ const codes = new Map()
  for (const event of events) {
    if (!subjects.has(event.subjectKey)) subjects.set(event.subjectKey,[])
    if (!codes.has(event.code)) codes.set(event.code,[])
    subjects.get(event.subjectKey)?.push(event)
    codes.get(event.code)?.push(event)
  }
  const followup = [...subjects.values()].map(rows => {
    const times = rows.map(e => Date.parse(e.occurredAt)).filter(Number.isFinite)
    return times.length ? (times.reduce((a,b) => Math.max(a,b),-Infinity) - times.reduce((a,b) => Math.min(a,b),Infinity)) / 86400000 : 0
  })
  return { subjects: subjects.size, events: events.length, repeatedSubjects: [...subjects.values()].filter(rows => new Set(rows.map(e => e.occurredAt)).size > 1).length,
    medianHistoryDays: longitudinalQuantile(followup, .5), maxHistoryDays: followup.length ? followup.reduce((a,b) => Math.max(a,b),0) : null,
    coverage, concepts: [...codes].map(([code, rows]) => ({ code, events: rows.length,
      subjects: new Set(rows.map(e => e.subjectKey)).size, missingValues: rows.filter(e => e.value == null).length,
      units: [...new Set(rows.map(e => e.unit))], valueSources: [...new Set(rows.map(e => e.valueSource))] })),
    tasks: [
      { task: 'literature_scenario', available: true, needs: [] },
      { task: 'history_forecast', available: events.length > 0, needs: events.length ? ['callable_model_or_external_predictions'] : ['dated_available_observations'] },
      { task: 'external_validation', available: false, needs: ['frozen_predictions', 'subsequent_observed_outcomes', 'independent_split'] },
    ] }
}

/** Validate numerical meaning per row; retain usable rows even in a damaged file.
 * @param {Record<string, any>} input @param {{subjects?:Set<string>,origin?:string}} [context] */
export function validateForecast(input, context = {}) {
  const endpoint = obj(input.endpoint), rows = arr(input.rows), origin = longitudinalInstant(input.origin)
  /** @type {any[]} */ const issues = [], accepted = [], rejected = []
  const horizons = arr(input.horizonsDays)
  const validHeader = VCR_PREDICTION_TYPES.includes(endpoint.type) && typeof endpoint.code === 'string' && endpoint.code.length > 0
    && typeof endpoint.unit === 'string' && endpoint.unit.length > 0 && origin && (!context.origin || origin === context.origin)
    && horizons.length > 0 && horizons.length <= VCR_LONGITUDINAL_LIMITS.horizons
    && horizons.every((h, i) => Number.isFinite(h) && h > 0 && (!i || h > horizons[i - 1]))
  if (!validHeader) return { rows: [], issues: [{ code: 'forecast_header_invalid' }], received: rows.length }
  if (rows.length > VCR_LONGITUDINAL_LIMITS.forecasts) return { rows: [], issues: [{ code: 'forecast_row_limit' }], received: rows.length }
  const probability = ['risk', 'survival_probability'].includes(endpoint.type)
  const seen = new Set()
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { issues.push({row:index+1,codes:['forecast_row_invalid']}); continue }
    /** @type {string[]} */ const errors = []
    const key = `${row.subjectKey}\0${row.horizonDays}`
    if (typeof row.subjectKey !== 'string' || !row.subjectKey || (context.subjects && !context.subjects.has(row.subjectKey))) errors.push('subject_not_in_history')
    if (!horizons.includes(row.horizonDays)) errors.push('horizon_not_declared')
    if (seen.has(key)) errors.push('duplicate_forecast')
    if (!Number.isFinite(row.point) || probability && (row.point < 0 || row.point > 1) || endpoint.type === 'rate' && row.point < 0) errors.push('point_out_of_range')
    if (row.unit != null && row.unit !== endpoint.unit) errors.push('unit_mismatch')
    const qs = arr(row.quantiles)
    if (qs.some((q, i) => !q || !Number.isFinite(q.p) || q.p <= 0 || q.p >= 1 || !Number.isFinite(q.value)
      || probability && (q.value < 0 || q.value > 1) || (i > 0 && (!qs[i-1] || q.p <= qs[i-1].p || q.value < qs[i-1].value)))) errors.push('quantiles_invalid')
    if (row.sd != null && (!Number.isFinite(row.sd) || row.sd < 0)) errors.push('sd_invalid')
    const samples = arr(row.samples)
    if (samples.length > VCR_LONGITUDINAL_LIMITS.samples || samples.some(v => !Number.isFinite(v) || probability && (v < 0 || v > 1))) errors.push('samples_invalid')
    if (row.absorbedAtDays != null && (!Number.isFinite(row.absorbedAtDays) || row.absorbedAtDays < 0
      || row.horizonDays > row.absorbedAtDays && endpoint.type === 'continuous')) errors.push('after_absorbing_event')
    if (errors.length) {
      issues.push({ row: index + 1, codes: errors })
      if (typeof row.subjectKey === 'string' && horizons.includes(row.horizonDays)) rejected.push({subjectKey:row.subjectKey,horizonDays:row.horizonDays,codes:errors})
      continue
    }
    seen.add(key)
    accepted.push({ subjectKey: row.subjectKey, horizonDays: row.horizonDays, point: row.point,
      unit: endpoint.unit, ...(row.sd != null ? { sd: row.sd } : {}), quantiles: qs.map(q => ({ p: q.p, value: q.value })), samples,
      uncertainty: VCR_FORECAST_UNCERTAINTY.includes(row.uncertainty) ? row.uncertainty : 'unknown',
      absorbedAtDays: row.absorbedAtDays ?? null, valueSource: 'predicted' })
  }
  // Survival cannot increase with time. Keep the last consistent value and
  // quarantine only the offending horizon; unrelated subjects remain usable.
  const invalid = new Set()
  if (endpoint.type === 'survival_probability') {
    const last = new Map()
    for (const row of [...accepted].sort((a,b) => a.horizonDays-b.horizonDays)) {
      const previous = last.get(row.subjectKey)
      if (previous && row.point > previous.point + 1e-12) {
        invalid.add(row)
        const codes = ['survival_probability_increases']
        issues.push({codes,horizonDays:row.horizonDays})
        rejected.push({subjectKey:row.subjectKey,horizonDays:row.horizonDays,codes})
      } else last.set(row.subjectKey,row)
    }
  }
  // Rejected cell identities stay in the protected artifact, never its summary.
  return { rows: accepted.filter(row => !invalid.has(row)), issues, rejected, received: rows.length }
}

/** @type {Record<string, string[]>} */ const required = {
    'forecast.trajectories': ['historyId', 'providerId', 'endpoint', 'horizonsDays'],
    'forecast.evaluate': ['predictionId', 'outcomeHistoryId'],
    'forecast.compare': ['predictionId', 'otherPredictionId'],
    'forecast.trial_benchmark': ['benchmarkId'],
  }
/** @type {Record<string, string[]>} */ const optional = {
    'forecast.trajectories': ['scenario', 'samples', 'modelVersion'],
    'forecast.evaluate': ['windowDays', 'eventCodes', 'followupCode', 'bootstrap', 'split', 'trainingOverlap'],
    'forecast.compare': ['bootstrap'], 'forecast.trial_benchmark': ['bootstrap'],
  }

export const VCR_LONGITUDINAL_SCHEMAS = Object.freeze(Object.fromEntries(Object.keys(required).map(method => [method,{required:required[method],optional:optional[method]}])))

/** Structural validation for control-plane methods. Methodology gaps are notes.
 * @param {string} method @param {Record<string, any>} scenario */
export function validateLongitudinalScenario(method, scenario) {
  const keys = required[method]
  if (!keys) return [{ code: 'method_unknown', field: 'method', detail: 'Unknown longitudinal method.' }]
  const problems = keys.filter(key => scenario[key] == null).map(key => ({ code: 'scenario_field_required', field: `scenario.${key}`, detail: 'Required input reference.' }))
  for (const key of Object.keys(scenario)) if (![...keys, ...optional[method]].includes(key)) problems.push({ code: 'scenario_field_unknown', field: `scenario.${key}`, detail: 'Unused scenario field.' })
  for (const key of keys.filter(k => k.endsWith('Id'))) if (typeof scenario[key] !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(scenario[key])) problems.push({ code: 'scenario_field_invalid', field: `scenario.${key}`, detail: 'An owned record reference is required.' })
  if (scenario.bootstrap != null && (!Number.isInteger(scenario.bootstrap) || scenario.bootstrap < 0 || scenario.bootstrap > VCR_LONGITUDINAL_LIMITS.bootstrap)) problems.push({ code: 'scenario_field_invalid', field: 'scenario.bootstrap', detail: 'Bootstrap must be between 0 and 500.' })
  if (scenario.windowDays != null && (!Number.isFinite(scenario.windowDays) || scenario.windowDays < 0)) problems.push({ code: 'scenario_field_invalid', field: 'scenario.windowDays', detail: 'A nonnegative observation window is required.' })
  if (scenario.samples != null && (!Number.isInteger(scenario.samples) || scenario.samples < 1 || scenario.samples > VCR_LONGITUDINAL_LIMITS.samples)) problems.push({code:'scenario_field_invalid',field:'scenario.samples',detail:'Samples must be between 1 and 1000.'})
  if (scenario.split != null && !['train','calibration','test'].includes(scenario.split)) problems.push({code:'scenario_field_invalid',field:'scenario.split',detail:'Select a recorded split role.'})
  return problems
}

/** These decline only the requested data operation; other research continues. */
export const VCR_LONGITUDINAL_ERROR_CODES = Object.freeze(['vcr_benchmark_invalid', 'vcr_forecast_endpoint_unsupported', 'vcr_forecast_fields_unavailable', 'vcr_forecast_horizon_unsupported', 'vcr_forecast_provider_unavailable', 'vcr_forecast_request_changed', 'vcr_forecast_unavailable', 'vcr_history_input_changed', 'vcr_history_mapping_missing', 'vcr_history_perturbation_invalid', 'vcr_history_required', 'vcr_history_subject_mapping', 'vcr_history_too_large', 'vcr_longitudinal_changed', 'vcr_longitudinal_not_found', 'vcr_prediction_rows_missing', 'vcr_split_invalid'])
