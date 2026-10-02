import assert from 'node:assert/strict';
import test from 'node:test';
import { runContainedDocumentControls } from '../extension-saas-acceptance-contained.mjs';
const image = process.env.COWORK_TEST_IMAGE, nativeImage = process.env.NATIVE_SKILL_VALIDATOR_IMAGE, closureExpectedSHA = process.env.COWORK_TEST_CLOSURE_SHA256, integrity = process.env.COWORK_TEST_INTEGRITY;
test('actual contained image reads/writes public documents, rejects active assets, and joins a stalled operation', {
  skip: (!image || !nativeImage || !closureExpectedSHA || !integrity) && 'Explicit immutable cached Cowork/native images required; missing is not a pass', timeout: 90000,
}, async () => {
  const result = await runContainedDocumentControls({ image, nativeImage, closureExpectedSHA, integrity });
  assert.equal(result.qualified, false); assert.equal(result.cleanup.physicallyJoined, true);
  assert.deepEqual(result.observations.map(item => item.caseId), ['SAAS-08', 'SAAS-16', 'SAAS-17']);
  assert.equal(result.observations[0].actual.chineseDocxRead, true); assert.equal(result.observations[0].actual.notebookCodeExecuted, false);
  assert.equal(result.observations[1].actual.imageInventoryMatched, true); assert.equal(result.observations[1].actual.noProviderKeysMounted, true);
  assert.equal(result.observations[2].actual.timedOutJoined, true); assert.equal(result.observations[2].actual.subsequentReadSucceeded, true);
});
