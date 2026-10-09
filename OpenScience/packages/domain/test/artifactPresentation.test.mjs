import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactPresentation, compareArtifacts } from '../src/artifactPresentation.mjs';

test('declared roles order unfamiliar names and never make scripts into documents', () => {
  const refs = [{ path: 'notes.py', role: 'report' }, { path: 'answer.json', role: 'report' }, { path: 'matrix.json', role: 'matrix' }, { path: 'draft.md', role: 'draft' }];
  assert.equal(artifactPresentation('notes.py', 'report').readable, false);
  assert.equal(artifactPresentation('answer.json', 'report').readable, true);
  assert.deepEqual(refs.filter(ref => artifactPresentation(ref.path, ref.role).readable).sort(compareArtifacts).map(ref => ref.path), ['answer.json', 'matrix.json', 'draft.md']);
});
