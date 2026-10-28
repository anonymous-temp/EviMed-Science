import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { withResearchDbCapacity } from '../src/researchDbCapacity.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (url) { const value = new URL(url); assert(['localhost', '127.0.0.1', '[::1]'].includes(value.hostname)); assert.match(value.pathname, /evimed_test/); }
test('capacity is shared by independent pools and is released on completion', { skip: !url && 'A disposable PostgreSQL database is required' }, async () => {
  const pools = Array.from({ length: 6 }, () => new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 1, databaseConnectionTimeoutMs: 2000 }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = [];
  try {
    const held = pools.slice(0, 4).map((pool, index) => withResearchDbCapacity(pool, `capacity-user-${index}`, async () => {
      entered[index](); await gate;
    }));
    const starts = pools.slice(0, 4).map((_, index) => new Promise(resolve => { entered[index] = resolve; }));
    await Promise.all(starts);
    await assert.rejects(withResearchDbCapacity(pools[4], 'capacity-user-0', async () => {}), { code: 'research_db_busy' });
    await assert.rejects(withResearchDbCapacity(pools[5], 'capacity-user-5', async () => {}), { code: 'research_db_busy' });
    release(); await Promise.all(held);
    assert.equal(await withResearchDbCapacity(pools[5], 'capacity-user-5', async () => 'ok'), 'ok');
  } finally { release(); await Promise.all(pools.map(pool => pool.close())); }
});
