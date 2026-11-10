import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionAccountFloors } from '../src/evolutionAccountClasses.mjs';
import { loadConfig } from '../src/config.mjs';
import { validateEvolutionConfiguration } from '../src/evolutionConfiguration.mjs';

// A single researcher signal is useful; operator tuning remains independently bounded.
test('one researcher qualifies while operator floor retains its independent one-to-five range', () => {
  assert.deepEqual(evolutionAccountFloors({}), { user: 1, operator: 1 });
  assert.deepEqual(evolutionAccountFloors({ evolutionOperatorSignalFloor: 3 }), { user: 1, operator: 3 });
  assert.equal(evolutionAccountFloors({ evolutionOperatorSignalFloor: 9 }).operator, 5, 'operator tuning remains capped independently of the user floor');
  for (const unset of [null, undefined]) assert.equal(evolutionAccountFloors({ evolutionOperatorSignalFloor: unset }).operator, 1, String(unset));
  // Not a whole number of accounts: refused by name, never read as another number (2.5 used to become 1 in silence).
  for (const bad of [2.5, 1.5, 0, -2, Number.NaN, Number.POSITIVE_INFINITY, 'x', '3']) assert.throws(() => evolutionAccountFloors({ evolutionOperatorSignalFloor: bad }), { code: 'evolution_setting_invalid' }, String(bad));
});
test('the setting is read from the environment and held to one to five', () => {
  const name = 'OPEN_SCIENCE_EVOLUTION_OPERATOR_SIGNAL_FLOOR', prior = process.env[name];
  try {
    delete process.env[name]; assert.equal(loadConfig().evolutionOperatorSignalFloor, 1);
    process.env[name] = '2'; assert.equal(loadConfig().evolutionOperatorSignalFloor, 2); assert.deepEqual(validateEvolutionConfiguration(loadConfig()), []);
    for (const bad of ['0', '6', '1.5']) {
      assert.ok(validateEvolutionConfiguration({ evolutionOperatorSignalFloor: Number(bad) }).some(issue => issue.key === 'evolutionOperatorSignalFloor'), bad);
      process.env[name] = bad; assert.equal(loadConfig().evolutionOperatorSignalFloor, 1, `${bad}: the default replaces it at start`);
    }
  } finally { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; }
});
