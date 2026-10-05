import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionDataMatch, validateEvolutionDataRequirements } from '@evimed/domain';
import { normalizeEvolutionDataRequirements } from '../src/evolutionDataRequirements.mjs';
test('legacy declared aggregate requirements retain unknown types and prose without inventing limits', () => {
  const input = { requiredFields: { transitionMatrices: 'Square transition matrices', stateCosts: 'Costs per state' }, privacy: 'Aggregate only', refusalConditions: ['Invalid transition row'] };
  const normalized = normalizeEvolutionDataRequirements(input);
  assert.deepEqual(validateEvolutionDataRequirements(normalized), []);
  assert.equal(normalized.typeKnowledge, 'unknown');
  assert.equal(normalized.requirementsBasis, 'legacy-prose');
  assert.deepEqual(evolutionDataMatch(normalized, { fields: normalized.schema.fields, semanticsChecksPassed: true }), { matched: false, issues: ['requirements-not-machine-verified'] });
  assert.equal(normalized.privacy, input.privacy);
  assert.equal(normalized.researchRules, undefined);
  assert.deepEqual(normalized.schema.fields.map(field => [field.name, field.type, field.constraints.required]), [['transitionMatrices', 'any', true], ['stateCosts', 'any', true]]);
  assert.equal(evolutionDataMatch(normalized, { fields: [], semanticsChecksPassed: true }).matched, false);
  assert.equal(evolutionDataMatch(normalized, { fields: [{ name: 'transitionMatrices', type: 'array' }, { name: 'stateCosts', type: 'array' }], semanticsChecksPassed: true }).matched, false);
  assert.equal(input.schema, undefined);
});
test('typed native requirements are unchanged and malformed declared schemas never silently weaken', () => {
  const native = { schema: { fields: [{ name: 'cost', type: 'number', constraints: { required: true } }] }, researchRules: { minEvents: 20 } };
  assert.equal(normalizeEvolutionDataRequirements(native), native);
  for (const invalid of [{ schema: {}, requiredFields: { cost: 'Cost' } }, { requiredFields: { cost: 12 } }]) assert.throws(() => normalizeEvolutionDataRequirements(invalid), error => error.code === 'evolution_requirements_invalid');
});
