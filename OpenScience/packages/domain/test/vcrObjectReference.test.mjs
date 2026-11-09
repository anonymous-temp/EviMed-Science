import assert from 'node:assert/strict';
import test from 'node:test';
import { vcrObjectReference } from '../src/vcrObjectReference.mjs';
const selected = { studyId: 'std_a', kind: 'population', objectId: 'pop_a', version: 2, resultId: 'res_a', resultVersion: 3 };
test('closed research references retain exact object and comparison versions', () => {
  assert.deepEqual(vcrObjectReference({ ...selected, forgedAuthority: true }), selected);
  assert.deepEqual(vcrObjectReference({ ...selected, compareTo: { objectId: 'pop_b', version: 1 } })?.compareTo, { objectId: 'pop_b', version: 1 });
  for (const value of [{ ...selected, version: 'latest' }, { ...selected, studyId: undefined }, { ...selected, kind: 'anything' }, { ...selected, compareTo: selected }]) assert.equal(vcrObjectReference(value), null);
  assert.deepEqual(vcrObjectReference({ kind: 'model', objectId: 'model_a', version: '1.2.0' }), { kind: 'model', objectId: 'model_a', version: '1.2.0' });
});

test('R11 a study reference names exactly one study: no version, no result, no comparison, and it needs the study id', () => {
  assert.deepEqual(vcrObjectReference({ studyId: 'std_a', kind: 'study', objectId: 'study', forgedAuthority: true }), { studyId: 'std_a', kind: 'study', objectId: 'study' });
  for (const value of [{ kind: 'study', objectId: 'study' }, { studyId: 'std_a', kind: 'study', objectId: 'pop_a' }, { studyId: 'std_a', kind: 'study', objectId: 'study', version: 1 },
    { studyId: 'std_a', kind: 'study', objectId: 'study', resultId: 'res_a' }, { studyId: 'std_a', kind: 'study', objectId: 'study', compareTo: { objectId: 'study' } }]) assert.equal(vcrObjectReference(value), null);
});
