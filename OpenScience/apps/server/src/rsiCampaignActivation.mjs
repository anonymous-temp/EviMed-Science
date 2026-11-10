import { createHash } from 'node:crypto'

/** Only an adapter's inspected installed identity is a publication receipt. @param {any} proof @param {any} row */
export function rsiActivationReceipt(proof, row) {
  return proof?.phase === row.phase && proof?.installed === true && proof.operationId === row.operationId && proof.candidateDigest === row.candidateDigest
    && typeof proof.revision === 'string' && proof.revision.length > 0 && (!row.revision || proof.revision === row.revision)
}
/** A run records its selected revision once; caller persists runPin with the run.
 * Shared feeds always retain incumbent publication in shadow mode. @param {any} row @param {any} context */
export function rsiCampaignSelection(row, context = {}) {
  const enabled = ['exposed','consumer-observed','broadly-active'].includes(row.state)
  // Every arm of an exposed campaign names the candidate under observation, so a control execution is a countable witness.
  const observed = enabled && typeof row.candidateDigest === 'string' ? {candidateDigest:row.candidateDigest} : {}
  if (enabled && row.mode!=='shadow' && [row.revision,row.previousRevision].includes(context.runPin) && context.runPin && !(context.runPin === row.revision && ['stopped','rolled-back'].includes(row.state))) return {revision:context.runPin,arm:context.runPin === row.revision ? 'candidate':'control',operationId:row.operationId,...observed,...(row.stageIndex!==undefined?{stageIndex:row.stageIndex}:{})}
  const bucket = parseInt(createHash('sha256').update(JSON.stringify([row.id,context.userId??'',context.projectId??''])).digest('hex').slice(0,8),16) / 0x100000000 * 100
  const candidate = enabled && (row.mode === 'global' || row.mode === 'cohort' && !!context.userId && !!context.projectId && bucket < row.cohortPercent)
  return {revision:candidate?row.revision:row.previousRevision,arm:candidate?'candidate':'control',...(enabled && row.mode==='shadow'?{shadowRevision:row.revision}:{}),operationId:row.operationId,...observed,...(row.stageIndex!==undefined?{stageIndex:row.stageIndex}:{})}
}
/** The stage's selected volume: the latest count of each day the witnesses read, the candidate's line against the incumbent's. @param {any} observations */
function stageVolume(observations) {
  const days = Object.values(observations.volumeByDay ?? {})
  return { incumbent: days.reduce((sum, /** @type {any} */ day) => sum + day.incumbentPicks, 0), candidate: days.reduce((sum, /** @type {any} */ day) => sum + day.candidatePicks, 0) }
}
/** Daily execution accounting is a bounded operational fuse, not a sequential significance test. The volume bound is the online twin of the offline rule on a candidate's selected
 * volume, the one thing a line can get wrong that the serving side can see: past its floor the stage's ratio stays inside the registered range or the campaign stops.
 * @param {any} observations @param {any} policy */
export function rsiCampaignFuse(observations, policy) {
  if (['corrupt-bytes','unauthorized-behavior','incompatible-generation','deterministic-regression'].includes(observations.criticalCode)) return {state:'stop',reason:observations.criticalCode}
  if (!Number.isSafeInteger(policy?.minExecutions) || policy.minExecutions <= 0 || !Number.isSafeInteger(policy?.minDays) || policy.minDays <= 0 || !Number.isSafeInteger(policy?.maxErrors) || policy.maxErrors < 0) return {state:'inconclusive',reason:'thresholds-unconfigured'}
  if (observations.errors > policy.maxErrors) return {state:'stop',reason:'registered-error-limit'}
  if (policy.volumeBound) {
    const volume = stageVolume(observations)
    if (Math.max(volume.incumbent, volume.candidate) >= policy.volumeBound.minPicks) {
      const ratio = volume.incumbent > 0 ? volume.candidate / volume.incumbent : Number.POSITIVE_INFINITY
      if (ratio > policy.volumeBound.max || ratio < policy.volumeBound.min) return {state:'stop',reason:'registered-volume-bound',volume}
    }
  }
  if (observations.candidateExecutions < policy.minExecutions || observations.days.length < policy.minDays) return {state:'inconclusive',reason:'insufficient-executions'}
  return {state:'sufficient',reason:'registered-execution-thresholds'}
}
