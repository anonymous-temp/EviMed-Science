import assert from 'node:assert/strict';
import test from 'node:test';
import { RESEARCH_DB_IMPORT_OUTCOMES, RESEARCH_DB_REFUSAL_REASONS, recordResearchDbImport, recordResearchDbRefusal, researchDbMetricFamilies, researchDbMetricSnapshot, researchDbRefusalReason, resetResearchDbMetrics } from '../src/researchDbMetrics.mjs';

test('every series exists from the start at zero, and a count moves only its own series', () => {
  resetResearchDbMetrics();
  const families = researchDbMetricFamilies();
  assert.deepEqual(families.map(family => family.name), ['open_science_research_db_imports_total', 'open_science_research_db_refusals_total']);
  assert.deepEqual(families[0].series.map(item => item.labels.outcome), [...RESEARCH_DB_IMPORT_OUTCOMES]);
  assert.deepEqual(families[1].series.map(item => item.labels.reason), [...RESEARCH_DB_REFUSAL_REASONS]);
  for (const reason of ['truncated', 'busy', 'network_denied', 'tls_failed', 'login_failed', 'failed']) assert(RESEARCH_DB_REFUSAL_REASONS.includes(reason), reason);
  assert(families.every(family => family.type === 'counter' && family.series.every(item => item.value === 0)));
  recordResearchDbImport('partial'); recordResearchDbImport('partial'); recordResearchDbRefusal('tls_failed');
  recordResearchDbImport('made-up'); recordResearchDbRefusal('made-up');
  const snapshot = researchDbMetricSnapshot();
  assert.equal(snapshot.imports.partial, 2); assert.equal(snapshot.refusals.tls_failed, 1);
  assert.equal(Object.values(snapshot.imports).reduce((sum, value) => sum + value, 0), 2, 'an unknown outcome is ignored, not counted under a made-up label');
  assert.equal(Object.values(snapshot.refusals).reduce((sum, value) => sum + value, 0), 1);
  resetResearchDbMetrics();
});

test('an error code is counted under the reason it names, and an unnamed one is a failure', () => {
  assert.equal(researchDbRefusalReason('research_db_busy'), 'busy');
  assert.equal(researchDbRefusalReason('research_db_network_denied'), 'network_denied');
  assert.equal(researchDbRefusalReason('research_db_tls_failed'), 'tls_failed');
  assert.equal(researchDbRefusalReason('research_db_login_failed'), 'login_failed');
  assert.equal(researchDbRefusalReason('research_db_login_too_privileged'), 'too_privileged');
  assert.equal(researchDbRefusalReason('research_db_unreachable'), 'unreachable');
  assert.equal(researchDbRefusalReason('autopilot_materials_full'), 'materials_full');
  assert.equal(researchDbRefusalReason('research_db_selection_invalid'), 'selection_invalid');
  for (const other of ['research_db_unavailable', 'ECONNRESET', undefined, null, '__proto__', 'constructor']) assert.equal(researchDbRefusalReason(other), 'failed', String(other));
});
