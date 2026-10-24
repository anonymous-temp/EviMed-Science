import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecyclePlan, safeCleanupIds } from '../provision.mjs';
import benchmark from '../cases.json' with { type:'json' };
test('each lifecycle question has an executable adapter without operator case configuration', () => {
  const plan = lifecyclePlan(benchmark);
  assert.equal(plan.length, 30);
  assert.equal(new Set(plan.map(p => p.id)).size, 30);
  assert.ok(plan.every(p => typeof p.execute === 'function'));
});
test('cleanup refuses objects outside the current owned fixture receipt', () => {
  assert.deepEqual(safeCleanupIds({runId:'eval-one',created:[{id:'p1',runId:'eval-one'}]}), ['p1']);
  assert.throws(() => safeCleanupIds({runId:'eval-one',created:[{id:'p2',runId:'other'}]}), /ownership/);
});
