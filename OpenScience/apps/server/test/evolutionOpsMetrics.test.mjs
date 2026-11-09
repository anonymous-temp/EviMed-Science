import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionOpsMetricFamilies } from '../src/evolutionOpsMetrics.mjs';

test('the signal groups and the retention pass reach the scrape; without the product ledger nothing is exported', () => {
  assert.deepEqual(evolutionOpsMetricFamilies({ signals: null, retention: null }), []);
  const families = evolutionOpsMetricFamilies({
    signals: { counters: { aggregated: { user: 2, operator: 1 }, heldBack: { user: 3, operator: 0 } } },
    retention: { counters: { passes: 4, failed: 1, recordsDeleted: 9 } } });
  const groups = families.find(family => family.name === 'open_science_evolution_signal_groups');
  assert.deepEqual(groups?.series.map(row => [row.labels?.class, row.labels?.outcome, row.value]), [['user', 'aggregated', 2], ['user', 'held_back', 3], ['operator', 'aggregated', 1], ['operator', 'held_back', 0]]);
  const retention = families.find(family => family.name === 'open_science_evolution_retention_total');
  assert.deepEqual(retention?.series.map(row => [row.labels?.outcome, row.value]), [['passes', 4], ['failed', 1], ['records_deleted', 9]]);
  assert.ok(families.every(family => family.help.length > 20 && ['gauge', 'counter'].includes(family.type)));
});
