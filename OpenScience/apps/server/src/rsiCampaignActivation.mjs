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
  if (enabled && row.mode!=='shadow' && [row.revision,row.previousRevision].includes(context.runPin) && context.runPin && !(context.runPin === row.revision && ['stopped','rolled-back'].includes(row.state))) return {revision:context.runPin,arm:context.runPin === row.revision ? 'candidate':'control',operationId:row.operationId,...(row.stageIndex!==undefined?{stageIndex:row.stageIndex}:{})}
  const bucket = parseInt(createHash('sha256').update(JSON.stringify([row.id,context.userId??'',context.projectId??''])).digest('hex').slice(0,8),16) / 0x100000000 * 100
  const candidate = enabled && (row.mode === 'global' || row.mode === 'cohort' && !!context.userId && !!context.projectId && bucket < row.cohortPercent)
  return {revision:candidate?row.revision:row.previousRevision,arm:candidate?'candidate':'control',...(enabled && row.mode==='shadow'?{shadowRevision:row.revision}:{}),operationId:row.operationId,...(row.stageIndex!==undefined?{stageIndex:row.stageIndex}:{})}
}
/** Daily execution accounting is a bounded operational fuse, not a sequential significance test.
 * @param {any} observations @param {any} policy */
export function rsiCampaignFuse(observations, policy) {
  if (['corrupt-bytes','unauthorized-behavior','incompatible-generation','deterministic-regression'].includes(observations.criticalCode)) return {state:'stop',reason:observations.criticalCode}
  if (!Number.isSafeInteger(policy?.minExecutions) || policy.minExecutions <= 0 || !Number.isSafeInteger(policy?.minDays) || policy.minDays <= 0 || !Number.isSafeInteger(policy?.maxErrors) || policy.maxErrors < 0) return {state:'inconclusive',reason:'thresholds-unconfigured'}
  if (observations.errors > policy.maxErrors) return {state:'stop',reason:'registered-error-limit'}
  if (observations.candidateExecutions < policy.minExecutions || observations.days.length < policy.minDays) return {state:'inconclusive',reason:'insufficient-executions'}
  return {state:'sufficient',reason:'registered-execution-thresholds'}
}
