import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionAccountClass, evolutionAccountFloors } from '../src/evolutionAccountClasses.mjs';
import { evolutionPriorityBreakdown } from '../src/evolutionScout.mjs';
import { deriveEvolutionCapabilityMap } from '../src/evolutionCapabilityMap.mjs';
import { loadConfig } from '../src/config.mjs';
import { validateEvolutionConfiguration } from '../src/evolutionConfiguration.mjs';

// Researchers are counted five at a time, always; an operator's own account is counted on its own against a floor that defaults to one
// (review D-E12: with a handful of accounts every user-originated signal sat below five for ever).
test('the floors are five for researchers and the configured number, one to five, for operators', () => {
  assert.deepEqual(evolutionAccountFloors({}), { user: 5, operator: 1 });
  assert.deepEqual(evolutionAccountFloors({ evolutionOperatorSignalFloor: 3 }), { user: 5, operator: 3 });
  assert.equal(evolutionAccountFloors({ evolutionOperatorSignalFloor: 9 }).operator, 5, 'an operator never needs more than a researcher');
  for (const bad of [0, -2, Number.NaN, 'x', null, undefined]) assert.equal(evolutionAccountFloors({ evolutionOperatorSignalFloor: bad }).operator, 1, String(bad));
  assert.deepEqual(['operator', 'user', undefined, 'other'].map(evolutionAccountClass), ['operator', 'user', 'user', 'user']);
});
test('the setting is read from the environment and held to one to five', () => {
  const name = 'OPEN_SCIENCE_EVOLUTION_OPERATOR_SIGNAL_FLOOR', prior = process.env[name];
  try {
    delete process.env[name]; assert.equal(loadConfig().evolutionOperatorSignalFloor, 1);
    process.env[name] = '2'; assert.equal(loadConfig().evolutionOperatorSignalFloor, 2); assert.deepEqual(validateEvolutionConfiguration(loadConfig()), []);
    for (const bad of ['0', '6', '1.5']) { process.env[name] = bad; assert.ok(validateEvolutionConfiguration(loadConfig()).some(issue => issue.key === 'evolutionOperatorSignalFloor'), bad); }
  } finally { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; }
});
test('demand scores once the account count reaches the floor the opportunity carries, and five otherwise', () => {
  assert.equal(evolutionPriorityBreakdown({ distinctAccounts: 1 }).demand, 0, 'one researcher is below five');
  assert.equal(evolutionPriorityBreakdown({ distinctAccounts: 4 }).demand, 0);
  assert.ok(evolutionPriorityBreakdown({ distinctAccounts: 5 }).demand > 0);
  assert.ok(evolutionPriorityBreakdown({ distinctAccounts: 1, demandFloor: 1 }).demand > 0, 'one operator account meets the operator floor');
  assert.equal(evolutionPriorityBreakdown({ distinctAccounts: 1, demandFloor: 2 }).demand, 0);
  assert.equal(evolutionPriorityBreakdown({ distinctAccounts: 3, demandFloor: 99 }).demand, 0, 'a carried floor is held to one to five');
  assert.equal(evolutionPriorityBreakdown({ distinctAccounts: 1, demandFloor: 0 }).demand, 0, 'a floor of nothing falls back to five');
});
test('the capability map shows operator demand at its floor and researcher demand only from five', () => {
  const codes = { capability: 'statistical-analysis', operation: 'transform', dataShape: 'table', reason: 'missing-tool' };
  const registry = [{ id: 'statistical-analysis', visibility: 'public' }];
  const signal = (patch) => ({ id: `s-${patch.distinctAccounts}-${patch.accountClass ?? 'user'}`, payload: { kind: 'unmet-demand', codes, occurrences: 3, scope: 'platform-aggregate', ...patch } });
  const demand = (signals) => deriveEvolutionCapabilityMap({ registry, methods: {}, signals, now: new Date('2026-10-10') }).cells.find(cell => cell.version === 'unavailable')?.demand?.distinctAccounts ?? null;
  assert.equal(demand([signal({ distinctAccounts: 4 })]), null, 'four researchers are below five');
  assert.equal(demand([signal({ distinctAccounts: 5 })]), 5);
  assert.equal(demand([signal({ distinctAccounts: 1, accountClass: 'operator' })]), 1, 'one operator account meets the operator floor');
  assert.equal(demand([signal({ distinctAccounts: 1, accountClass: 'user' })]), null);
});
