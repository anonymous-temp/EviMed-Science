import { isPlatformAccount } from './platformAccount.mjs';
import { HttpError } from './security.mjs';

/** One audience decision for the browser, key management and bearer API.
 * Without an account, reports whether authentication can lead to access.
 * Operator access needs an explicit opt-in so today's default stays closed.
 * @param {any} config @param {any} [user]
 */
export function agentMemoryAvailable(config, user = undefined) {
  const additional = config.agentMemoryApiInternalUsers ?? [];
  const operators = config.agentMemoryApiInternalEnabled === true ? config.operatorUsers ?? [] : [];
  if (user === undefined) return config.agentMemoryApiEnabled === true || additional.length > 0 || operators.length > 0;
  if (!user?.id || isPlatformAccount(user)) return false;
  return config.agentMemoryApiEnabled === true || additional.includes(user.id) || operators.includes(user.id);
}

/** Key management is shared by every API a key can call (memory and data analysis today), so it stays open while
 * any of them is offered: gating it on the memory audience alone closed the data-analysis keys with it. A key's
 * memory scopes still open nothing for an account outside the memory audience, since the memory routes ask
 * `agentMemoryAvailable` of the key's own account.
 * @param {any} config @param {any} [user]
 */
export function agentKeysAvailable(config, user = undefined) {
  return config.dataAnalysisApiEnabled === true || agentMemoryAvailable(config, user);
}

export function agentMemoryDisabled() {
  return new HttpError(503, 'agent_memory_disabled', 'The agent memory API is not enabled in this deployment.');
}
