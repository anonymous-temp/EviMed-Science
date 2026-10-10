export const EVOLUTION_DEMAND_MIN_ACCOUNTS = 5;
/** The two classes of account the platform counts apart. A signal from researchers reaches the platform loop only when enough
 * different people show it (`EVOLUTION_DEMAND_MIN_ACCOUNTS`), so one person's private work cannot steer it; an operator's own
 * account is the platform's, owes nobody that protection, and on a deployment with a handful of accounts would otherwise leave
 * every user-originated signal below the line for ever (review D-E12). Each class is counted on its own against its own floor. */
export const EVOLUTION_ACCOUNT_CLASSES = Object.freeze(['user', 'operator']);
/** The floor of each class: researchers five, operators `OPEN_SCIENCE_EVOLUTION_OPERATOR_SIGNAL_FLOOR` (default 1, never above five).
 * @param {{evolutionOperatorSignalFloor?: unknown}} [config] @returns {{user: number, operator: number}} */
export function evolutionAccountFloors(config = {}) {
  const operator = Math.trunc(Number(config?.evolutionOperatorSignalFloor));
  return { user: EVOLUTION_DEMAND_MIN_ACCOUNTS, operator: operator >= 1 ? Math.min(operator, EVOLUTION_DEMAND_MIN_ACCOUNTS) : 1 };
}
/** The class a stored summary or lead counts under; a record written before the classes existed counted researchers only.
 * @param {unknown} value @returns {'user'|'operator'} */
export const evolutionAccountClass = value => (value === 'operator' ? 'operator' : 'user');
