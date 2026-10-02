import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runDocumentBoundaryControls } from '../extension-saas-acceptance-boundaries.mjs';

test('real file/provenance/archive controls record measured refusals and allowed reads without qualification', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-saas-boundaries-')));
  try {
    const result = await runDocumentBoundaryControls(root);
    assert.equal(result.qualified, false);
    assert.deepEqual(result.observations.map(row => row.caseId), ['SAAS-02', 'SAAS-07', 'SAAS-08', 'SAAS-12', 'SAAS-17']);
    assert(result.observations.every(row => row.actual.assertions > 0));
    assert.equal(result.observations[0].actual.foreignProjectCode, 'extension_access_denied');
    assert.equal(result.observations[1].actual.patientCode, 'extension_access_denied');
    assert.equal(result.observations[2].actual.centralLocalMismatchRefused, true);
    assert.equal(result.observations[3].actual.rawDestinationRefused, true);
    assert.equal(result.observations[1].actual.staleProvenanceRefused, true);
    assert.equal(result.observations[1].actual.changedPreservedBytesRefused, true);
    const publication = result.observations[4];
    assert.equal(publication.scope, 'actual-platform-guard-and-descriptor-file-control');
    assert.equal(publication.actual.identicalRetryRetained, true);
    assert.equal(publication.actual.foreignProjectRefused, true);
    assert.equal(publication.actual.changedResultRefused, true);
    assert.equal(publication.actual.linkedOutputRefused, true);
    assert.match(publication.actual.uncovered, /controller cancellation/);
    assert.equal(result.unrelatedWorkspaceUnchanged, true);
    assert.equal(Object.hasOwn(result, 'receiptDigest'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('boundary driver refuses unowned or linked fixture roots before creating resources', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-saas-root-')));
  try {
    await fs.symlink(root, path.join(root, 'linked'));
    await assert.rejects(runDocumentBoundaryControls(path.join(root, 'linked')));
    await assert.rejects(runDocumentBoundaryControls('/'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
