/** A decision option serving can carry out; every other operation moved offline.
 * Exact recovery is verified by `EvolutionMaintenance.restoreReview`, not by a caller-supplied flag. @param {string} operation */
export function evolutionServingDecision(operation) {
  return ['keep', 'wait', 'maintenance-retire'].includes(operation);
}
/** What an option serving cannot carry out answers: said once, with a closed code. */
export const EVOLUTION_OFFLINE_ONLY = Object.freeze({ status: 'deferred', code: 'evolution_offline_only', reason: 'Platform experiments run only in offline campaigns.' });
