import { validateEvolutionDataRequirements } from '@evimed/domain';
import { HttpError } from './security.mjs';
/** Preserve declared requirements; legacy prose does not establish a field type or numeric limit.
 * @param {any} value */
export function normalizeEvolutionDataRequirements(value) {
  if (value == null) return value;
  if (!validateEvolutionDataRequirements(value).length) return value;
  const fields = value.requiredFields;
  if (value.schema !== undefined || !fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length || Object.entries(fields).some(([name, description]) => !name || typeof description !== 'string' || !description.trim())) throw new HttpError(400, 'evolution_requirements_invalid', 'Invalid data requirements.');
  const normalized = { ...value, schema: { fields: Object.entries(fields).map(([name, description]) => ({ name, type: 'any', description, constraints: { required: true } })) }, typeKnowledge: 'unknown', requirementsBasis: 'legacy-prose' };
  if (validateEvolutionDataRequirements(normalized).length) throw new HttpError(400, 'evolution_requirements_invalid', 'Invalid data requirements.');
  return normalized;
}
