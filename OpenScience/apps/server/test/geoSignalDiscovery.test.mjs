import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geoSourceImpactEvent } from '../src/geoSignalDiscovery.mjs';

test('source impact versions change only with the preserved notice and affected versions', () => {
  const finding = { id: 'finding', statement: 'A bounded result', sourceRef: 'doi:example', claimIds: ['claim'], groupIds: ['group'] };
  const profile = { version: 1, data: { findings: [finding] } };
  const impact = { change: { id: 'change', sourceRef: 'doi:example', kind: 'retraction', at: '2026-10-01T00:00:00Z' }, findingIds: ['finding'], articleIds: ['article'], groupIds: ['group'] };
  const claims = [{ id: 'claim', version: 2, statement: 'A bounded result', sourceRef: 'doi:example' }];
  const articles = [{ id: 'article', currentResultVersionId: 'v1', contentSha256: 'a'.repeat(64), valueContext: { findingIds: ['finding'] } }];
  const original = geoSourceImpactEvent(profile, impact, articles, claims);
  const rechecked = geoSourceImpactEvent({ ...profile, version: 9 }, { ...impact, change: { ...impact.change, at: '2026-10-23T00:00:00Z', checkedAt: 'later', summary: 'Edited display' } }, articles, claims);
  assert.equal(rechecked.eventVersion, original.eventVersion);
  assert.equal(original.basis.dependencyObservation, 'current_at_detection');
  assert.equal(original.basis.targets.length, 3);
  const revised = geoSourceImpactEvent(profile, impact, [{ ...articles[0], currentResultVersionId: 'v2' }], claims);
  assert.notEqual(revised.eventVersion, original.eventVersion);
  assert.ok(original.basis.targets.every(target => target.relationship !== 'possible_group_dependency'));
  const indirect = geoSourceImpactEvent(profile, impact, [{ ...articles[0], valueContext: {} }], claims);
  assert.equal(indirect.basis.targets.find(target => target.type === 'article').relationship, 'possible_group_dependency');
});
