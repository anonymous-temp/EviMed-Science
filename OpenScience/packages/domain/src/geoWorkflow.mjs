/** Task scope and dependencies shared by the orchestrator and every GEO surface.
 * Existing step records remain authoritative; this projection grants no authority.
 * Completion, a default tier or a locked question set never requests new work.
 */
import { GEO_STEPS, GEO_STEP_STATUSES } from './geoVocabulary.mjs'

export const GEO_STEP_DEPENDENCIES = Object.freeze({
  evidence: Object.freeze([]), journey: Object.freeze(['evidence']), questions: Object.freeze(['evidence']),
  diagnosis: Object.freeze(['questions']), sources: Object.freeze(['diagnosis']), content: Object.freeze(['evidence']),
  distribution: Object.freeze(['content']), monitoring: Object.freeze(['diagnosis']),
})
const finished = new Set(['done', 'minimal'])
/** @param {unknown} value */
const text = value => typeof value === 'string' && value.trim() ? value : null

/** @param {Record<string, any> | null | undefined} input */
export function geoWorkflowState(input = {}) {
  const values = input ?? {}
  const legacyUnconfirmed = GEO_STEPS.filter(key => values[key]?.requested === true && values[key]?.requestOrigin === 'legacy'
    && !['queued', 'running', 'done', 'minimal'].includes(values[key]?.status))
  const requested = GEO_STEPS.filter(key => (values[key]?.requested === true && values[key]?.requestOrigin !== 'legacy')
    || ['queued', 'running'].includes(values[key]?.status))
  const full = GEO_STEPS.every(key => requested.includes(key))
  /** @param {string} key @returns {string[]} */
  const dependencies = key => [...(/** @type {Record<string, readonly string[]>} */ (GEO_STEP_DEPENDENCIES)[key] ?? []), ...(full && key === 'content' ? ['sources'] : [])]
  const requiredSet = new Set()
  /** @param {string} key */
  const add = key => { if (requiredSet.has(key)) return; requiredSet.add(key); dependencies(key).forEach(add) }
  requested.forEach(add)
  const required = GEO_STEPS.filter(key => requiredSet.has(key))
  /** @param {string} key */
  const status = key => GEO_STEP_STATUSES.includes(values[key]?.status) ? values[key].status : 'none'
  const steps = Object.fromEntries(GEO_STEPS.map(key => [key, {
    key, status: status(key), requested: requested.includes(key), required: requiredSet.has(key),
    dependencies: dependencies(key), waitingFor: dependencies(key).filter(need => !finished.has(status(need))),
    runId: text(values[key]?.runId), error: text(values[key]?.error ?? values[key]?.note), updatedAt: text(values[key]?.updatedAt),
  }]))
  return {
    requested, required, full, steps, legacyUnconfirmed,
    active: GEO_STEPS.filter(key => ['running', 'queued'].includes(steps[key].status)),
    nextRunnable: required.filter(key => steps[key].status === 'none' && !steps[key].waitingFor.length),
  }
}

/** A historical requested flag is not evidence of authorization for new recurring paid work.
 * @param {{ engines?: readonly string[], coverageDays?: number, steps?: Record<string, any> }} project */
export function geoAutomationEnabled(project) {
  const consent = project.steps?.monitoring?.automation
  return consent?.state === 'confirmed' && typeof consent.actorId === 'string' && consent.actorId.length > 0
    && typeof consent.at === 'string' && Number.isFinite(Date.parse(consent.at))
    && consent.coverageDays === project.coverageDays && Array.isArray(consent.engines)
    && consent.engines.length === project.engines?.length && new Set(consent.engines).size === consent.engines.length
    && consent.engines.every((/** @type {string} */ engine) => project.engines?.includes(engine))
}
