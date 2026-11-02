import assert from 'node:assert/strict'
import test from 'node:test'

import { PLATFORM_ROOT_DIRECTORIES, SCRATCH_DIRECTORIES, isOrdinaryOutputDirectory, ordinaryOutputPath, workspaceLayout } from '../index.mjs'

// The closed list of what is an ordinary file lives in the domain since 2026-11-02: the control plane reads it to name a run's
// files and the run side reads it to name the files an earlier conversation left. The server's own tests (runArtifacts) hold the
// behaviour the ledger depends on; these hold that the domain's copy is the one both read.
test('a visible file outside scratch, platform and hidden places is an ordinary file', () => {
  for (const path of ['notes.md', 'designs/A_fixed.json', 'deliverables/report-1/report.md', '/workspace/out/table.csv']) {
    assert.equal(ordinaryOutputPath(path), true, path)
  }
})

test('hidden names, scratch, render output, the platform directories and the platform files are not', () => {
  for (const path of ['.evimed-run/state.json', '.hidden', 'a/.cache/x', 'node_modules/x/index.js', '__pycache__/a.pyc', 'tmp/a.txt', 'work/a.txt', 'preview-3/page-1.png',
    'knowledge-base/paper.pdf', 'library/a.pdf', `${workspaceLayout.dataDir}/rows.csv`, workspaceLayout.planFile, '../escape.txt', '']) {
    assert.equal(ordinaryOutputPath(path), false, path)
  }
  assert.equal(ordinaryOutputPath('sub/knowledge-base/a.txt'), true, 'a platform directory is the first-level one only')
  assert.equal(ordinaryOutputPath(`sub/${workspaceLayout.planFile}`), true, 'and so is a platform file')
})

test('a directory name is judged by the same list', () => {
  assert.equal(isOrdinaryOutputDirectory('designs', true), true)
  assert.equal(isOrdinaryOutputDirectory('knowledge-base', true), false)
  assert.equal(isOrdinaryOutputDirectory('knowledge-base', false), true)
  assert.equal(isOrdinaryOutputDirectory('.git', false), false)
  assert.equal(isOrdinaryOutputDirectory('Node_Modules', false), false, 'compared in lower case')
  assert.ok(SCRATCH_DIRECTORIES.has('node_modules') && PLATFORM_ROOT_DIRECTORIES.has('knowledge-base') && PLATFORM_ROOT_DIRECTORIES.has(workspaceLayout.dataDir))
})
