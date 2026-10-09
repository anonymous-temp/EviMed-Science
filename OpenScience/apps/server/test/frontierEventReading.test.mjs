import test from 'node:test';
import assert from 'node:assert/strict';
import { frontierEventEvidenceCounts } from '@evimed/domain';
import { frontierEventChanges } from '../src/frontierEventReading.mjs';

test('three reports by one institution about one identified study have three distinct counts', () => {
  assert.deepEqual(frontierEventEvidenceCounts([
    { owner: 'institution-a', studyIds: ['doi:10.1/a', 'registry:NCT123'] },
    { owner: 'institution-a', studyIds: ['registry:NCT123', 'doi:10.1/b'] },
    { owner: 'institution-a', studyIds: ['doi:10.1/b'] },
  ]), { reports: 3, institutions: 1, studies: 1, unlinkedReports: 0 });
  assert.deepEqual(frontierEventEvidenceCounts([{ owner: 'institution-a' }]), { reports: 1, institutions: 1, studies: 0, unlinkedReports: 1 });
});

test('a reader sees new and corrected prose since their baseline, without treating popularity as new facts', () => {
  const initial = [{ id: 'a', title: 'A', summary: 'Preserved fact', role: 'primary', studyIds: ['doi:a'] }];
  const first = frontierEventChanges(initial, null);
  assert.deepEqual(first.changes, []);
  assert.deepEqual(frontierEventChanges([{ ...initial[0], heat: 90 }], first.mark).changes, []);
  const next = frontierEventChanges([{ ...initial[0], summary: 'Corrected fact' }, { ...initial[0], id: 'b' }], first.mark);
  assert.deepEqual(next.changes.map(change => [change.id, change.kind]), [['a', 'updated'], ['b', 'added']]);
});
