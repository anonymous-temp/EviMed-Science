import { HttpError } from './security.mjs';
export const EVOLUTION_DEMAND_MIN_ACCOUNTS = 1;
export const EVOLUTION_OPERATOR_MAX_FLOOR = 5;
/** Operator tuning retains its independent range of one through five (`OPEN_SCIENCE_EVOLUTION_OPERATOR_SIGNAL_FLOOR`, default 1).
 * An unset floor is the default and one above five is held at five, the cap; any other value that is not a positive integer is refused
 * by name, never read as another number (2.5 is neither two nor one). The configuration check replaces it with the default at start
 * (`validateEvolutionConfiguration`), so this guards a caller that bypassed it.
 * @param {{evolutionOperatorSignalFloor?: unknown}} [config] @returns {{user: number, operator: number}} */
export function evolutionAccountFloors(config = {}) {
  const configured = config?.evolutionOperatorSignalFloor;
  if (configured === undefined || configured === null) return { user: EVOLUTION_DEMAND_MIN_ACCOUNTS, operator: 1 };
  const operator = typeof configured === 'number' ? configured : Number.NaN;
  if (!Number.isSafeInteger(operator) || operator < 1) throw new HttpError(500, 'evolution_setting_invalid', 'The operator signal floor must be a whole number of accounts from one to five.');
  return { user: EVOLUTION_DEMAND_MIN_ACCOUNTS, operator: Math.min(operator, EVOLUTION_OPERATOR_MAX_FLOOR) };
}
