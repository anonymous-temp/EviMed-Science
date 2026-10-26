import { HttpError } from './security.mjs';

export const EVOLUTION_SERVING_KINDS = Object.freeze(['evolution-event', 'evolution-decision', 'evolution-digest', 'evolution-maintain']);
export const EVOLUTION_SERVING_EVALUATE_ACTION = 'release-replay';

/** Closed serving operations; an unknown kind or evaluate action is experimental.
 * Release replay is admitted only so execution can record an honest deferral (or an empty no-op).
 * @param {string} kind @param {any} payload */
export function evolutionServingJob(kind, payload = {}) {
  return EVOLUTION_SERVING_KINDS.includes(kind)
    || kind === 'evolution-evaluate' && payload.action === EVOLUTION_SERVING_EVALUATE_ACTION;
}
/** @param {string} [code] @param {string} [reason] */
export function evolutionDeferred(code = 'evolution_search_paused', reason = 'Platform experiments wait while evolution search is paused.') {
  return { status: 'deferred', code, reason };
}
/** Publication is checked again immediately before the serving pin changes. In-flight model work is not cancelled.
 * This is process-local startup configuration, not a cross-process hot-pause barrier; rollout must drain old workers.
 * @param {any} config */
export function assertEvolutionExperimentalPublication(config) {
  if (config.evolutionSearchPaused === true) throw new HttpError(409, 'evolution_search_paused', 'Experimental publication waits while evolution search is paused.');
}
/** Exact recovery is verified by maintenance.restoreReview, not by a caller-supplied resume flag.
 * @param {string} operation */
export function evolutionServingDecision(operation) {
  return ['keep', 'wait', 'maintenance-retire'].includes(operation);
}
