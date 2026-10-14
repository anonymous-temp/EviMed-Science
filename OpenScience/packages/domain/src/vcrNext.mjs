/**
 * Which step of a 虚拟临床研究 study is the next one to do — one pure function, read by the study's page (`GET /studies/:id` →
 * `next`), by the route that starts a step and by anything that names "next" to a person or to a model, so a button and a sentence
 * cannot disagree about it.
 *
 * Hidden knowledge:
 *
 * - **A step in flight is not next.** A step that is queued or running is being done: proposing it again is the button that was
 *   pressed a moment ago. Nor is a step whose input is being produced right now proposed — its need (`VCR_STEP_NEEDS`) is not finished,
 *   and a step started on an unfinished input would be a second run for the same thing.
 * - **Order is the programme's.** The first unfinished step in the study's own order whose needs are finished. A step that failed or
 *   went stale comes by its place in that order, not ahead of it: the person is told which it is (`reason`), and the order stays the
 *   one they see on the step bar.
 * - **Nothing is next for a study nobody has described.** Every step reads the research definition; with neither a question nor a
 *   definition the platform refuses the request by name (`vcr_definition_missing`), so it is not offered.
 *
 * @module @evimed/domain/vcrNext
 */

import { VCR_NEXT_REASON_LABELS_ZH, VCR_STEPS, VCR_STEP_ACTION_LABELS_ZH, VCR_STEP_NEEDS } from './vcrVocabulary.mjs'

/** A step is finished when it is `done` or a deliberate `minimal`. */
const FINISHED = new Set(['done', 'minimal'])
/** What a step in flight reads. */
const IN_FLIGHT = new Set(['queued', 'running'])
/** The statuses that leave a step to be done. */
const OPEN = new Set(['none', 'failed', 'stale'])

/**
 * @typedef {{ step: string, label: string, reason: 'start' | 'retry' | 'refresh', reasonText: string }} VcrNextStep
 */

/**
 * @param {{ steps?: Record<string, { status?: string | null } | null | undefined> | null, described?: boolean }} input
 *   `steps`: the study's steps by key, as the read model returns them (a missing one is `none`); `described`: whether the study says
 *   what it is about — a question or a definition
 * @returns {VcrNextStep | null} null when there is nothing to propose: the study is not described, everything is finished, or what is
 *   left waits on a step that is under way
 */
export function vcrNext({ steps, described = true } = {}) {
  if (described !== true) return null
  const status = (/** @type {string} */ step) => String(steps?.[step]?.status ?? 'none')
  for (const step of VCR_STEPS) {
    const own = status(step)
    if (FINISHED.has(own) || IN_FLIGHT.has(own) || !OPEN.has(own)) continue
    const needs = /** @type {Record<string, readonly string[]>} */ (VCR_STEP_NEEDS)[step] ?? []
    if (!needs.every((need) => FINISHED.has(status(need)))) continue
    const reason = own === 'failed' ? 'retry' : own === 'stale' ? 'refresh' : 'start'
    return {
      step,
      label: /** @type {Record<string, string>} */ (VCR_STEP_ACTION_LABELS_ZH)[step],
      reason,
      reasonText: VCR_NEXT_REASON_LABELS_ZH[reason],
    }
  }
  return null
}
