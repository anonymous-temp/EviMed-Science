/** Trial forecasts have their own target and split. Patient rollouts do not
 * identify trial treatment effects. Each scale is evaluated separately. */
import { longitudinalMean as mean } from './vcrLongitudinal.mjs'
import { metricIntervals } from './vcrForecastEvaluation.mjs'

/** @param {any} benchmark @param {{bootstrap?:number,seed?:number}} [options] */
export function evaluateTrialBenchmark(benchmark,options = {}) {
  const comparisons = benchmark.comparisons ?? []
  const testFamilies = new Set(comparisons.filter((/** @type {any} */ r) => r.split === 'test').map((/** @type {any} */ r) => r.familyId))
  const leakedFamilies = new Set(comparisons.filter((/** @type {any} */ r) => r.split !== 'test' && testFamilies.has(r.familyId)).map((/** @type {any} */ r) => r.familyId))
  const seen = new Set()
  /** @type {any[]} */ const excluded = [], heldout = []
  for (const row of comparisons) {
    if (row.issue || !['train','calibration','test'].includes(row.split)) {
      excluded.push({code:row.issue ?? 'split_not_declared'});continue
    }
    if (row.split !== 'test') continue
    const key = JSON.stringify([row.trialId,row.endpoint,row.scale,row.unit,row.horizonDays,row.arm])
    const issue = !Number.isFinite(row.actual) || !Number.isFinite(row.predicted) ? 'effect_missing'
      : !row.trialId || !row.familyId || !row.endpoint || !row.scale ? 'target_identity_missing'
        : leakedFamilies.has(row.familyId) || row.calibrationTrialIds?.includes(row.trialId) ? 'trial_family_overlap'
          : seen.has(key) ? 'duplicate_comparison' : null
    if (issue) {excluded.push({code:issue});continue}
    seen.add(key);heldout.push(row)
  }
  /** @type {Map<string,any[]>} */ const groups = new Map()
  for (const row of heldout) {
    const key = JSON.stringify([row.endpoint,row.scale,row.unit,row.horizonDays])
    if (!groups.has(key)) groups.set(key,[])
    groups.get(key)?.push(row)
  }
  return {schema:1,contract:'trial_effect_prediction',comparisons:heldout.length,
    trials:new Set(heldout.map(r => r.trialId)).size,families:new Set(heldout.map(r => r.familyId)).size,
    excluded:excluded.length,issues:excluded,familyOverlap:leakedFamilies.size > 0,
    trainingOverlap:benchmark.trainingOverlap ?? 'unknown',causalEffectIdentified:false,
    groups:[...groups.values()].map(rows => {
      const target = rows[0]
      const calibration = comparisons.filter((/** @type {any} */ r) => !r.issue && ['train','calibration'].includes(r.split)
        && !testFamilies.has(r.familyId) && r.endpoint === target.endpoint && r.scale === target.scale
        && r.unit === target.unit && r.horizonDays === target.horizonDays && Number.isFinite(r.actual))
      // Equal-family means avoid overweighting repeated publications of a trial.
      const familyMeans = [...new Set(calibration.map((/** @type {any} */ r) => r.familyId))].map(family => mean(calibration.filter((/** @type {any} */ r) => r.familyId === family).map((/** @type {any} */ r) => r.actual)))
      const baseline = mean(/** @type {number[]} */ (familyMeans))
      const cells = rows.map(r => ({subjectKey:r.familyId,point:r.predicted,actual:r.actual}))
      const metrics = metricIntervals(cells,'continuous',options)
      for (const m of Object.values(metrics)) m.interval = 'trial_family_percentile'
      const baselineMetrics = baseline == null ? null : metricIntervals(cells.map(r => ({...r,point:baseline})),'continuous',options)
      if (baselineMetrics) for (const m of Object.values(baselineMetrics)) m.interval = 'trial_family_percentile'
      return {endpoint:target.endpoint,scale:target.scale,unit:target.unit,horizonDays:target.horizonDays,
        comparisons:rows.length,trials:new Set(rows.map(r => r.trialId)).size,metrics,
        baseline:{kind:'other_trial_family_mean',value:baseline,calibrationFamilies:familyMeans.length,metrics:baselineMetrics}}
    }),notes:['external_trial_effect_forecasts_not_patient_rollouts','family_assignments_declared_not_independently_verified']}
}
