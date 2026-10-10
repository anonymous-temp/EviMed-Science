/** Forecast evaluation: one patient is one sampling unit. Distributions describe
 * future observations, not additional trial participants or a treatment effect. */
import { longitudinalMean as mean, longitudinalVariance as variance, longitudinalQuantile as quantile } from './vcrLongitudinal.mjs'

/** Reproducible bootstrap, isolated from model sampling. @param {number} seed */
export function forecastRandom(seed) {
  let value = seed >>> 0
  return () => { value += 0x6D2B79F5; let n = value; n = Math.imul(n ^ n >>> 15, n | 1); n ^= n + Math.imul(n ^ n >>> 7, n | 61); return ((n ^ n >>> 14) >>> 0) / 4294967296 }
}
/** Empirical CRPS: E|X-y| - E|X-X'|/2, using sorted samples in O(n log n).
 * @param {number[]} samples @param {number} actual */
export function empiricalCrps(samples, actual) {
  if (!samples.length) return null
  const sorted = [...samples].sort((a,b) => a-b), n = sorted.length
  return Number(mean(sorted.map(x => Math.abs(x - actual)))) - sorted.reduce((s,x,i) => s + (2*i-n+1)*x, 0) / (n*n)
}

/** Rank AUROC and threshold-grouped average precision (ties share a threshold).
 * @param {{point:number,actual:number}[]} rows */
export function discrimination(rows) {
  const positives = rows.filter(r => r.actual === 1).length, negatives = rows.length - positives
  if (!positives || !negatives) return { auroc: null, averagePrecision: null }
  const sorted = [...rows].sort((a,b) => a.point-b.point)
  let rankSum = 0, start = 0
  while (start < sorted.length) {
    let end = start + 1
    while (end < sorted.length && sorted[end].point === sorted[start].point) end++
    rankSum += sorted.slice(start,end).filter(r => r.actual === 1).length * (start + end + 1) / 2
    start = end
  }
  let seen = 0, tp = 0, ap = 0
  for (let end = sorted.length; end > 0;) {
    let first = end - 1
    while (first > 0 && sorted[first-1].point === sorted[end-1].point) first--
    const added = sorted.slice(first,end).filter(r => r.actual === 1).length
    seen += end-first; tp += added; ap += added / positives * tp / seen; end = first
  }
  return { auroc: (rankSum - positives*(positives+1)/2) / (positives*negatives), averagePrecision: ap }
}

/** @param {any[]} rows @param {string} type @returns {Record<string,number|null>} */
export function forecastMetrics(rows, type) {
  if (!rows.length) return {}
  if (type === 'continuous' || type === 'rate') {
    const predictedMean = Number(mean(rows.map(r => r.point))), actualMean = Number(mean(rows.map(r => r.actual)))
    const cross = rows.reduce((s,r) => s+(r.point-predictedMean)*(r.actual-actualMean),0)
    const denominator = Math.sqrt(rows.reduce((s,r) => s+(r.point-predictedMean)**2,0)*rows.reduce((s,r) => s+(r.actual-actualMean)**2,0))
    const covered = rows.filter(r => r.quantiles?.length >= 2 && r.uncertainty === 'predictive')
    const scores = rows.map(r => empiricalCrps(r.uncertainty === 'predictive' ? r.samples ?? [] : [], r.actual)).filter(x => x != null)
    return { mae: mean(rows.map(r => Math.abs(r.point-r.actual))), rmse: Math.sqrt(Number(mean(rows.map(r => (r.point-r.actual)**2)))),
      correlation: denominator > 0 ? Math.max(-1,Math.min(1,cross/denominator)) : null,
      intervalCoverage: covered.length ? mean(covered.map(r => Number(r.actual >= r.quantiles[0].value && r.actual <= r.quantiles.at(-1).value))) : null,
      nominalCoverage: covered.length ? mean(covered.map(r => r.quantiles.at(-1).p - r.quantiles[0].p)) : null,
      crps: mean(/** @type {number[]} */ (scores)) }
  }
  const probabilities = rows.map(r => ({ ...r, point: type === 'survival_probability' ? 1-r.point : r.point }))
  return { ...discrimination(probabilities), brier: mean(probabilities.map(r => (r.point-r.actual)**2)),
    observedRisk: mean(probabilities.map(r => r.actual)), predictedRisk: mean(probabilities.map(r => r.point)),
    calibrationInLarge: Number(mean(probabilities.map(r => r.point))) - Number(mean(probabilities.map(r => r.actual))) }
}

/** Patient-cluster percentile intervals. Repeated origins or horizons never
 * increase the number of independent subjects. @param {any[]} rows @param {string} type
 * @param {{seed?:number,bootstrap?:number}} options */
export function metricIntervals(rows, type, { seed = 1, bootstrap = 200 } = {}) {
  const point = forecastMetrics(rows,type), rng = forecastRandom(seed)
  const subjects = [...new Set(rows.map(r => r.subjectKey))]
  const groups = groupBy(rows, r => r.subjectKey)
  /** @type {Record<string,number[]>} */ const replicates = {}
  if (subjects.length >= 2) for (let i=0; i<bootstrap; i++) {
    const sample = subjects.flatMap(() => groups.get(subjects[Math.floor(rng()*subjects.length)]) ?? [])
    for (const [key,value] of Object.entries(forecastMetrics(sample,type))) if (value != null) (replicates[key] ??= []).push(value)
  }
  return Object.fromEntries(Object.entries(point).map(([key,value]) => [key, { value,
    availability: value == null ? 'unavailable' : 'computed',
    unavailableReason: value != null ? null : key === 'crps' ? 'predictive_samples_missing'
      : ['intervalCoverage','nominalCoverage'].includes(key) ? 'predictive_quantiles_missing'
        : ['auroc','averagePrecision'].includes(key) ? 'both_outcome_classes_required'
          : key === 'correlation' ? 'nonconstant_predictions_and_outcomes_required' : 'paired_observations_required',
    lower: quantile(replicates[key] ?? [], .025), upper: quantile(replicates[key] ?? [], .975),
    successfulReplicates: replicates[key]?.length ?? 0, interval: 'patient_cluster_percentile', bootstrap }]))
}

/** Availability is checked at the outcome extraction cutoff by its history.
 * Actual future observations are selected deterministically around the requested
 * horizon, never interpolated by a language model. @param {any} prediction @param {any[]} events @param {any} options */
export function pairForecastOutcomes(prediction, events, options = {}) {
  const origin = Date.parse(prediction.origin), endpoint = prediction.endpoint
  const actualSources = new Set(options.dataClass === 'synthetic' ? ['observed','extracted','synthetic'] : ['observed','extracted'])
  const bySubject = groupBy(events, e => e.subjectKey)
  /** @type {any[]} */ const paired = [], missing = []
  for (const row of prediction.rows) {
    const own = (bySubject.get(row.subjectKey) ?? []).filter(e => actualSources.has(e.valueSource) && !e.conflict
      && !['negated','hypothetical','conditional','possible'].includes(e.assertion) && !['family','other'].includes(e.experiencer))
    const horizonAt = origin + row.horizonDays*86400000
    let actual = null, censorTime = null, eventTime = null
    if (['continuous','rate'].includes(endpoint.type)) {
      const window = Number(options.windowDays ?? 0)*86400000
      const candidates = own.filter(e => e.code === endpoint.code && e.unit === endpoint.unit && Number.isFinite(e.value)
        && Date.parse(e.occurredAt) > origin && Math.abs(Date.parse(e.occurredAt)-horizonAt) <= window)
        .sort((a,b) => Math.abs(Date.parse(a.occurredAt)-horizonAt)-Math.abs(Date.parse(b.occurredAt)-horizonAt))
      if (candidates.length && !(candidates.length > 1 && candidates[0].occurredAt === candidates[1].occurredAt && candidates[0].value !== candidates[1].value)) actual = candidates[0].value
    } else if (options.eventCodes?.length && options.followupCode) {
      const eventTimes = own.filter(e => options.eventCodes.includes(e.code) && e.assertion === 'affirmed' && e.experiencer === 'patient')
        .map(e => (Date.parse(e.occurredAt)-origin)/86400000).filter(t => t > 0)
      const followup = own.filter(e => e.code === options.followupCode).map(e => (Date.parse(e.occurredAt)-origin)/86400000).filter(t => t > 0)
      eventTime = eventTimes.length ? Math.min(...eventTimes) : null
      censorTime = followup.length ? Math.max(...followup) : null
      if (eventTime != null && eventTime <= row.horizonDays) actual = 1
      else if (censorTime != null && censorTime >= row.horizonDays) actual = 0
    } else {
      const found = own.filter(e => e.code === endpoint.code && e.unit === endpoint.unit && [0,1].includes(e.value)
        && Date.parse(e.occurredAt) === horizonAt)
      if (found.length === 1) actual = found[0].value
    }
    const result = { ...row, actual, censorTime, eventTime }
    if (actual == null) missing.push(result); else paired.push(result)
  }
  return { paired, missing }
}

/** Fit no model on future outcomes. The two continuous comparators use only the
 * frozen pre-origin history, and stay unavailable with insufficient history.
 * @param {any[]} rows @param {any} history @param {any} endpoint */
export function continuousBaselines(rows, history, endpoint) {
  /** @type {any[]} */ const persistence = [], trend = []
  const bySubject = groupBy(history.events, e => e.subjectKey)
  for (const row of rows) {
    const prior = (bySubject.get(row.subjectKey) ?? []).filter((/** @type {any} */ e) => e.subjectKey === row.subjectKey && e.code === endpoint.code && e.unit === endpoint.unit
      && Number.isFinite(e.value) && !e.conflict && (history.dataClass === 'synthetic' ? ['observed','extracted','synthetic'] : ['observed','extracted']).includes(e.valueSource)
      && !['negated','hypothetical','conditional','possible'].includes(e.assertion) && !['family','other'].includes(e.experiencer))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => a.occurredAt.localeCompare(b.occurredAt))
    const last = prior.at(-1)
    if (!last) continue
    persistence.push({ ...row, point: last.value, quantiles: [], samples: [] })
    const previous = prior.findLast((/** @type {any} */ e) => e.occurredAt < last.occurredAt)
    if (previous) {
      const days = (Date.parse(last.occurredAt)-Date.parse(previous.occurredAt))/86400000
      const ahead = (Date.parse(history.asOf)-Date.parse(last.occurredAt))/86400000+row.horizonDays
      trend.push({ ...row, point: last.value + (last.value-previous.value)/days*ahead, quantiles: [], samples: [] })
    }
  }
  return { persistence, trend }
}

/** Censoring-aware Brier using reverse Kaplan-Meier (G(t-), G(h)). AUROC/AP
 * remain the observed-at-horizon subset and are explicitly labelled as such.
 * @param {any[]} rows @param {number} horizon @param {string} type */
export function ipcwBrier(rows, horizon, type) {
  const survivalRows = rows.filter(r => r.eventTime != null || r.censorTime != null).map(r => ({ ...r,
    time: Math.min(r.eventTime ?? Infinity, r.censorTime ?? Infinity),
    censored: r.censorTime != null && (r.eventTime == null || r.censorTime < r.eventTime) }))
  if (!survivalRows.length) return null
  const byTime = groupBy(survivalRows, r => String(r.time))
  const times = [...byTime.keys()].map(Number).sort((a,b) => a-b)
  /** @type {Map<number,number>} */ const before = new Map()
  let g = 1, gh = 1, atRisk = survivalRows.length
  for (const time of times) {
    before.set(time,g)
    const atTime = byTime.get(String(time)) ?? []
    const censored = atTime.filter(r => r.censored).length
    // Event-before-censor ties in reverse KM remove events from the censoring
    // risk denominator (scikit-survival kaplan_meier_estimator, reverse=True).
    const observed = atTime.length-censored
    if (censored) g *= 1-censored/(atRisk-observed)
    if (time <= horizon) gh = g
    atRisk -= atTime.length
  }
  let sum = 0
  for (const row of survivalRows) {
    const risk = type === 'survival_probability' ? 1-row.point : row.point
    if (!row.censored && row.time <= horizon) { const weight = before.get(row.time) ?? 0; if (weight <= 0) return null; sum += (1-risk)**2/weight }
    else if (row.time > horizon) { if (gh <= 0) return null; sum += risk**2/gh }
  }
  // G(h)=0 leaves no censoring support at or beyond the last follow-up.
  // Zero contributing weights must not masquerade as perfect error.
  if (gh <= 0) return null
  return sum/survivalRows.length
}

/** @param {any} prediction @param {any} history @param {any} outcomes @param {any} [options] */
export function evaluateForecast(prediction, history, outcomes, options = {}) {
  const paired = pairForecastOutcomes(prediction,outcomes.events,{...options,dataClass:history.dataClass === 'synthetic' && outcomes.dataClass === 'synthetic' ? 'synthetic' : 'patient'})
  const role = options.split ?? 'test'
  const eligible = (/** @type {any} */ row) => !history.split || history.split.assignments[row.subjectKey] === role
  const rows = paired.paired.filter(eligible), missing = paired.missing.filter(eligible)
  const expectedSubjects = new Set(history.events.filter(eligible).map((/** @type {any} */ row) => row.subjectKey))
  const dataClass = history.dataClass === 'synthetic' && outcomes.dataClass === 'synthetic' ? 'synthetic' : 'patient'
  const bootstrap = options.bootstrap ?? 200, seed = options.seed ?? 1
  const groups = prediction.horizonsDays.map((/** @type {number} */ horizonDays) => {
    const cells = rows.filter(r => r.horizonDays === horizonDays), absent = missing.filter(r => r.horizonDays === horizonDays)
    const present = new Set([...cells,...absent].map(r => r.subjectKey))
    const invalid = new Set((prediction.rejected ?? []).filter((/** @type {any} */ r) => r.horizonDays === horizonDays
      && expectedSubjects.has(r.subjectKey) && !present.has(r.subjectKey)).map((/** @type {any} */ r) => r.subjectKey))
    /** @type {Record<string,any[]>} */
    const baselines = ['continuous','rate'].includes(prediction.endpoint.type) ? continuousBaselines(cells,history,prediction.endpoint) : {}
    const calibration = [...paired.paired,...paired.missing].filter(r => r.horizonDays === horizonDays && history.split?.assignments[r.subjectKey] === 'calibration')
    if (['risk','survival_probability'].includes(prediction.endpoint.type) && calibration.length) {
      const known = calibration.filter(r => r.actual != null)
      let risk = mean(known.map(r => r.actual))
      if (options.followupCode) {
        const observations = calibration.filter(r => r.eventTime != null || r.censorTime != null).map(r => ({
          time: Math.min(r.eventTime ?? Infinity,r.censorTime ?? Infinity),event:r.eventTime != null && (r.censorTime == null || r.eventTime <= r.censorTime) }))
        let survival = 1
        for (const time of [...new Set(observations.filter(r => r.event && r.time <= horizonDays).map(r => r.time))].sort((a,b) => a-b)) {
          survival *= 1-observations.filter(r => r.event && r.time === time).length/observations.filter(r => r.time >= time).length
        }
        risk = observations.some(r => r.time >= horizonDays) || survival === 0 ? 1-survival : null
      }
      if (risk != null) baselines[options.followupCode ? 'calibration_kaplan_meier' : 'calibration_prevalence'] = cells.map(r => ({...r,
        point:prediction.endpoint.type === 'survival_probability' ? 1-risk : risk,quantiles:[],samples:[]}))
    }
    const metrics = metricIntervals(cells,prediction.endpoint.type,{bootstrap,seed})
    const probability = ['risk','survival_probability'].includes(prediction.endpoint.type)
    return { horizonDays, requested: expectedSubjects.size, evaluated: cells.length, missingOutcomes: absent.length,
      acceptedForecasts: present.size, invalidForecasts: invalid.size, missingForecasts: expectedSubjects.size-present.size-invalid.size,
      subjects: new Set(cells.map(r => r.subjectKey)).size, events: probability ? cells.filter(r => r.actual === 1).length : null,
      observedMean: mean(cells.map(r => r.actual)), forecastMean: mean(cells.map(r => r.point)),
      distributionAvailability: { evaluatedRows: cells.length,
        predictiveRows: cells.filter(r => r.uncertainty === 'predictive').length,
        sampleRows: cells.filter(r => r.uncertainty === 'predictive' && r.samples?.length).length,
        intervalRows: cells.filter(r => r.uncertainty === 'predictive' && r.quantiles?.length >= 2).length,
        sdRows: cells.filter(r => r.uncertainty === 'predictive' && Number.isFinite(r.sd)).length,
        crpsRequires: 'predictive_samples', intervalCoverageRequires: 'predictive_quantiles' },
      metrics, ipcwBrier: probability && options.followupCode ? ipcwBrier([...cells,...absent],horizonDays,prediction.endpoint.type) : null,
      discriminationPopulation: probability ? 'observed_at_horizon_subset' : null,
      calibration: probability ? Array.from({length:10},(_,bin) => {
        const group = cells.filter(r => Math.min(9,Math.floor((prediction.endpoint.type === 'survival_probability' ? 1-r.point : r.point)*10)) === bin)
        return { bin, subjects: group.length, observed: mean(group.map(r => r.actual)), predicted: mean(group.map(r => prediction.endpoint.type === 'survival_probability' ? 1-r.point : r.point)) }
      }) : [],
      baselines: Object.fromEntries(Object.entries(baselines).map(([name, values]) => {
        const subjects = new Set(values.map(r => r.subjectKey))
        const baselineMetrics = metricIntervals(values,prediction.endpoint.type,{bootstrap,seed})
        const modelMetrics = metricIntervals(cells.filter(r => subjects.has(r.subjectKey)),prediction.endpoint.type,{bootstrap,seed})
        const comparisons = Object.fromEntries(['mae','rmse','crps','brier','auroc','averagePrecision'].flatMap(key => {
          const model = modelMetrics[key]?.value, baseline = baselineMetrics[key]?.value
          if (model == null || baseline == null) return []
          const lowerIsBetter = !['auroc','averagePrecision'].includes(key), difference = model-baseline
          return [[key,{model,baseline,modelMinusBaseline:difference,lowerIsBetter,
            preferred: difference === 0 ? 'equal' : (lowerIsBetter ? difference < 0 : difference > 0) ? 'model' : 'baseline',
            meaning:'point_estimate_only_not_a_significance_test'}]]
        }))
        return [name,{subjects:values.length,metrics:baselineMetrics,modelOnSameSubjects:modelMetrics,comparisons}]
      })) }
  })
  return { schema: 1, endpoint: prediction.endpoint, origin: prediction.origin, groups, split: history.split ? role : 'not_declared',
    diagnostics: forecastShiftDiagnostics(prediction,history),
    trainingOverlap: options.trainingOverlap ?? 'unknown', dataClass,
    validationClass: dataClass === 'synthetic' ? 'engineering_synthetic' : 'longitudinal_outcomes',
    calibrationIndependent: role === 'test' && !!history.split,
    forecastFailures: prediction.issues?.length ?? 0, uncertainty: { intervals: 'patient_cluster_bootstrap', trajectoriesArePatients: false,
      predictiveIntervals: 'only_rows_declared_predictive', modelUncertainty: 'not_estimated', monteCarloError: 'separate_from_patient_uncertainty' },
    notes: [...(!history.split ? ['independent_split_not_declared'] : []), ...(options.trainingOverlap ? [] : ['provider_training_overlap_unknown']),
      ...(groups.some((/** @type {any} */ g) => g.missingOutcomes > 0) ? ['outcomes_missing_or_censored'] : [])] }
}

/** Same-history paired scenarios, always described as model contrasts.
 * @param {any} first @param {any} second @param {{seed?:number,bootstrap?:number}} [options] */
export function compareForecasts(first, second, options = {}) {
  if (first.historyId !== second.historyId || first.origin !== second.origin || JSON.stringify(first.endpoint) !== JSON.stringify(second.endpoint)
    || JSON.stringify(first.horizonsDays) !== JSON.stringify(second.horizonsDays)) return { available: false, code: 'paired_inputs_differ' }
  const groups = first.horizonsDays.map((/** @type {number} */ horizonDays) => {
    const secondBySubject = new Map(second.rows.filter((/** @type {any} */ r) => r.horizonDays === horizonDays).map((/** @type {any} */ r) => [r.subjectKey,r]))
    const rows = first.rows.filter((/** @type {any} */ r) => r.horizonDays === horizonDays).flatMap((/** @type {any} */ row) => {
      const other = /** @type {any} */ (secondBySubject.get(row.subjectKey))
      return other ? [{ subjectKey: row.subjectKey, point: row.point-other.point, actual: 0 }] : []
    })
    const rng = forecastRandom(options.seed ?? 1), values = rows.map((/** @type {any} */ r) => r.point), boot = []
    if (values.length > 1) for (let i=0;i<(options.bootstrap ?? 200);i++) boot.push(Number(mean(values.map(() => values[Math.floor(rng()*values.length)]))))
    return { horizonDays, subjects: rows.length, meanDifference: mean(values), lower: quantile(boot,.025), upper: quantile(boot,.975),
      intervalMeaning: 'between_subject_sampling', modelUncertainty: 'not_estimated' }
  })
  return { available: true, groups, interpretation: 'paired_model_scenario_contrast', causalEffectIdentified: false,
    dataClass: first.dataClass === 'synthetic' && second.dataClass === 'synthetic' ? 'synthetic' : 'patient',
    scenarios: [first.scenario ?? null,second.scenario ?? null] }
}

/** Design assumptions retain their model origin and dispersion meaning. A risk
 * is not an event hazard; forecast confidence bands are not an outcome SD.
 * @param {any} prediction */
export function forecastDesignInputs(prediction) {
  return prediction.horizonsDays.map((/** @type {number} */ horizonDays) => {
    const rows = prediction.rows.filter((/** @type {any} */ r) => r.horizonDays === horizonDays)
    const values = rows.map((/** @type {any} */ r) => r.point)
    const between = variance(values)
    const dispersions = rows.map((/** @type {any} */ r) => r.uncertainty !== 'predictive' ? {value:null,source:'unavailable'}
      : Number.isFinite(r.sd) ? {value:r.sd**2,source:'provided_sd'}
        : {value:variance(r.samples ?? []),source:'predictive_samples'})
    const within = rows.length && dispersions.every((/** @type {any} */ d) => d.value != null)
      ? mean(dispersions.map((/** @type {any} */ d) => d.value)) : null
    return { horizonDays, subjects: new Set(rows.map((/** @type {any} */ r) => r.subjectKey)).size, mean: mean(values),
      outcomeVariance: prediction.endpoint.type === 'continuous' && between != null && within != null ? between + within : null,
      betweenSubjectVariance: between, withinSubjectPredictiveVariance: within, type: prediction.endpoint.type,
      varianceSources: [...new Set(dispersions.map((/** @type {any} */ d) => d.value == null ? 'unavailable' : d.source))],
      sampleVarianceDenominator: 'n_minus_one',
      unit: prediction.endpoint.unit, valueSource: 'predicted', interpretation: 'scenario_design_input',
      hazard: null, dropout: null, parameterUncertainty: 'not_estimated' }
  })
}

/** @param {any[]} rows @param {(row:any)=>string} key @returns {Map<string,any[]>} */
function groupBy(rows,key) {
  const groups = new Map()
  for (const row of rows) { const k = key(row); if (!groups.has(k)) groups.set(k,[]); groups.get(k).push(row) }
  return groups
}

/** Descriptive shift and freshness, not learned-model validity thresholds.
 * Unknown model training support remains unknown. @param {any} prediction @param {any} history */
export function forecastShiftDiagnostics(prediction,history) {
  const own = groupBy(history.events, e => e.subjectKey)
  const ages = [...own.values()].map(events => (Date.parse(history.asOf)-Math.max(...events.map(e => Date.parse(e.occurredAt))))/86400000)
  const predictionKeys = new Set(prediction.rows.map((/** @type {any} */ r) => `${r.subjectKey}:${r.horizonDays}`))
  const splitCodes = ['train','calibration','test']
  const endpointRows = history.events.filter((/** @type {any} */ e) => e.code === prediction.endpoint.code && e.unit === prediction.endpoint.unit && Number.isFinite(e.value))
  const reference = endpointRows.filter((/** @type {any} */ e) => history.split?.assignments[e.subjectKey] === 'train').map((/** @type {any} */ e) => e.value)
  const heldout = endpointRows.filter((/** @type {any} */ e) => history.split?.assignments[e.subjectKey] === 'test').map((/** @type {any} */ e) => e.value)
  const low = quantile(reference,0), high = quantile(reference,1)
  return { expectedCells: own.size * prediction.horizonsDays.length, missingForecasts: own.size * prediction.horizonsDays.length - predictionKeys.size,
    staleHistoryDays: {median:quantile(ages,.5),p90:quantile(ages,.9),maximum:quantile(ages,1)},
    siteCount:new Set(history.events.map((/** @type {any} */ e) => e.site).filter(Boolean)).size,
    splits: Object.fromEntries(splitCodes.map(role => [role,{observations:endpointRows.filter((/** @type {any} */ e) => history.split?.assignments[e.subjectKey] === role).length}])),
    heldoutOutsideTrainingRange: low == null || high == null || !heldout.length ? null : mean(heldout.map((/** @type {number} */ x) => Number(x < low || x > high))),
    shiftMeaning:'local_split_observations_not_provider_training_support', providerTrainingSupport:'unknown',
    perturbation:history.perturbation ?? null }
}
