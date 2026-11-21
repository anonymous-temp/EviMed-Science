/**
 * Execution status is about the approved withdrawal. A bounded copy scan
 * never proves that all paraphrases have been removed.
 * @param {Record<string, unknown>} request
 * @param {Record<string, unknown>} plan
 */
export function forgetRequestStatus(request, plan) {
  if (request.status === 'completed' || request.status === 'confirmed') return 'executed';
  if (request.status === 'pending') return 'pending_verification';
  if (request.status === 'applying' && plan.state !== 'failed') return 'requested';
  if (request.status === 'applying' && Number(plan.attempts) < 3) return 'pending_verification';
  return 'not_executed';
}

/** @param {{removed?:boolean,removedLines?:number,historyRejected?:boolean,historyScanPending?:boolean,missingLines?:string[]}} result */
export function forgetToolStatus(result) {
  if (result.historyScanPending) return 'pending_verification';
  if (!result.missingLines && (result.removed || result.removedLines || result.historyRejected)) return 'executed';
  return 'not_executed';
}
