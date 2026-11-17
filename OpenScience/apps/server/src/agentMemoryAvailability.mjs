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

export function agentMemoryDisabled() {
  return new HttpError(503, 'agent_memory_disabled', 'The agent memory API is not enabled in this deployment.');
}
