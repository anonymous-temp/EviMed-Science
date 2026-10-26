/** Signal disposition is independent of execution, clinical judgment and publication state. */
export const GEO_SIGNAL_KINDS = Object.freeze(['error_observed', 'source_changed', 'citation_observed', 'group_changed', 'order_anomaly'])
export const GEO_SIGNAL_STATES = Object.freeze(['pending', 'started', 'processing', 'completed', 'ignored', 'failed_recoverable'])
export const GEO_SIGNAL_DISPOSITIONS = Object.freeze(['active', 'ignored'])
export const GEO_SIGNAL_STEPS = Object.freeze({ error_observed: 'diagnosis', source_changed: 'evidence', citation_observed: 'monitoring', group_changed: 'monitoring', order_anomaly: 'distribution' })
export const GEO_SIGNAL_STATE_LABELS_ZH = Object.freeze({ pending: '待处理', started: '已开始', processing: '处理中', completed: '任务已完成', ignored: '已忽略', failed_recoverable: '未完成，可继续处理' })

/** The shared in-app and external-notification destination for an exact signal. @param {unknown} sourceId */
export function geoSignalHref(sourceId) {
  const match = /^([A-Za-z0-9_-]{1,80})\/signals\/(gs_[a-f0-9]{64})$/.exec(String(sourceId ?? ''))
  return match ? `/app/geo/${match[1]}?signal=${match[2]}` : null
}

/**
 * Read projection only. The caller proves exact request/run/result membership before passing facts here.
 * A successful drafting task never changes its source object's clinical or business outcome.
 * @param {{ disposition?: string, context?: {state?: string}|null, run?: {status?: string}|null,
 * resultPresent?: boolean, lookupAvailable?: boolean, businessOutcome?: string }} [input]
 */
export function geoSignalLifecycle({ disposition = 'active', context = null, run = null, resultPresent = false, lookupAvailable = true } = {}) {
  let executionState = 'pending', availability = 'available', reason = null
  if (!lookupAvailable || context?.state === 'bound' && !run) {
    executionState = context?.state === 'bound' ? 'started' : 'pending'
    availability = 'unknown'
    reason = 'run_unavailable'
  } else if (context?.state === 'bound' && run) {
    if (['queued', 'starting'].includes(run.status ?? '')) executionState = 'started'
    else if (run.status === 'running') executionState = 'processing'
    else if (run.status === 'succeeded') {
      executionState = resultPresent ? 'completed' : 'pending'
      reason = resultPresent ? null : 'result_unavailable'
    } else if (['failed', 'cancelled', 'canceled', 'budget_exhausted'].includes(run.status ?? '')) executionState = 'failed_recoverable'
    else { availability = 'unknown'; executionState = 'started'; reason = 'run_state_unknown' }
  }
  return { state: disposition === 'ignored' ? 'ignored' : executionState, executionState, availability, reason }
}
