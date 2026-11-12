/**
 * What the batch jobs (`match_judge`, `records_import`) share: the smallest head count a model is shown, and what a batch's result says of
 * itself from its counts.
 *
 * @module vcrMatchBatch
 */

import { VCR_MIN_CELL_SIZE } from '@evimed/domain';

/**
 * The smallest head count the model is shown: the domain's floor, raised and never lowered by the deployment (the service's own rule).
 * @param {Record<string, any>} config
 */
export function matchBatchMinCell(config) {
  const configured = Number(config?.vcrMinCellSize);
  return Number.isInteger(configured) && configured > VCR_MIN_CELL_SIZE ? configured : VCR_MIN_CELL_SIZE;
}

/**
 * What a batch's result says of itself, from its counts. Nothing finished out of something is a failure, with the commonest reason named, however
 * many attempts it took; some finished and some not (or stopped before the end) is `limited`, and what was done stands; all of it is `estimable`. A job
 * never reports success by default.
 * @param {{ finished: number, total: number, failed: number, stopped: boolean, failures: Record<string, number>, noun: string, verb: string }} input
 * @returns {{ status: 'succeeded' | 'failed', conclusion: 'estimable' | 'limited' | 'not_estimable', issues: Array<{ code: string, message: string }> }}
 */
export function resultOutcome({ finished, total, failed, stopped, failures, noun, verb }) {
  const commonest = Object.entries(failures).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
  if (total > 0 && finished === 0) {
    return { status: 'failed', conclusion: 'not_estimable', issues: [{ code: commonest ?? 'vcr_match_nothing_finished', message: `${total} ${noun}都没有${verb}成${commonest ? `，最多的原因是 ${commonest}` : ''}。` }] };
  }
  if (failed > 0 || stopped || finished < total) {
    return { status: 'succeeded', conclusion: 'limited', issues: [{ code: commonest ?? 'vcr_match_stopped_early', message: `${total} ${noun}里${verb}完 ${finished} ${noun}${failed > 0 ? `，${failed} ${noun}没${verb}成` : ''}${stopped ? '，中途停下' : ''}；${verb}完的保留。` }] };
  }
  return { status: 'succeeded', conclusion: 'estimable', issues: [] };
}
