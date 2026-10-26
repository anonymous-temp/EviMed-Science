export const EVOLUTION_DEMAND_MIN_ACCOUNTS = 1;
export const EVOLUTION_OPERATOR_MAX_FLOOR = 5;
/** Account classes remain separate; one authorized incident can identify a useful platform defect. */
export const EVOLUTION_ACCOUNT_CLASSES = Object.freeze(['user', 'operator']);
/** Operator tuning retains its independent range of one through five.
 * @param {{evolutionOperatorSignalFloor?: unknown}} [config] @returns {{user: number, operator: number}} */
export function evolutionAccountFloors(config = {}) {
  const operator = Number(config?.evolutionOperatorSignalFloor);
  return { user: EVOLUTION_DEMAND_MIN_ACCOUNTS, operator: Number.isSafeInteger(operator) && operator >= 1 ? Math.min(operator, EVOLUTION_OPERATOR_MAX_FLOOR) : 1 };
}
/** The class a stored summary or lead counts under; a record written before the classes existed counted researchers only.
 * @param {unknown} value @returns {'user'|'operator'} */
export const evolutionAccountClass = value => (value === 'operator' ? 'operator' : 'user');
