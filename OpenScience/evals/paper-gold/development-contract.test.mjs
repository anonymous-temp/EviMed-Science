import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const contract = JSON.parse(await fs.readFile(new URL('./development-contract.json', import.meta.url), 'utf8'));

test('builder-forwarded callable contract declares complete flow and weight semantics', () => {
  const builderFields = { entrypointContract: contract.entrypointContract, basis: contract.basis, cases: contract.cases };
  for (const field of ['initial', 'strategies', 'transitionMatrices', 'costRewards', 'utilityRewards', 'costWeights', 'utilityWeights']) assert.ok(builderFields.entrypointContract.includes(field));
  assert.match(builderFields.entrypointContract, /N by N/);
  assert.match(builderFields.entrypointContract, /T\+1/);
  assert.match(builderFields.entrypointContract, /origin i to destination j/);
  assert.match(builderFields.entrypointContract, /do not add another correction/);
  assert.match(builderFields.entrypointContract, /preserve every supplied strategy key/);
});

test('independent synthetic analytic example distinguishes transition rewards from state occupancy', () => {
  const example = contract.cases.find(row => row.id === 'toy-development-flow-rewards');
  assert.equal(example.kind, 'synthetic-development');
  const spec = example.input.specification;
  const strategy = spec.strategies['teaching-example'];
  assert.equal(strategy.transitionMatrices.length, 1);
  assert.equal(spec.costWeights.length, 2);
  // Closed-form two-path calculation, independent of the production loop and hidden reference scorer.
  const cost = 2 + 0.5 * 2 + 0.5 * 10;
  const qaly = 1 + 0.5 * 1 - 0.5 * 0.25;
  assert.deepEqual(example.expected['teaching-example'], { cost, qaly });
  assert.notEqual(cost, 2 + 0.5 * 2); // Dropping the non-diagonal flow must fail.
  assert.notEqual(qaly, 1 + 0.5); // Dropping the negative transition reward must fail.
});
