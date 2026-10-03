import assert from 'node:assert/strict';
import test from 'node:test';
import { containedDocumentExecutionIdentity, runContainedDocumentControls } from '../extension-saas-acceptance-contained.mjs';
import { extensionExecutionIdentity } from '../../../apps/server/src/extensionToolController.mjs';
const image = process.env.COWORK_TEST_IMAGE, nativeImage = process.env.NATIVE_SKILL_VALIDATOR_IMAGE, closureExpectedSHA = process.env.COWORK_TEST_CLOSURE_SHA256, integrity = process.env.COWORK_TEST_INTEGRITY;
test('the contained acceptance CLI fixture satisfies current execution identity before Docker initialization',()=>{
  const scope={userId:'fixture-actor',ownerId:'fixture-actor',ownerAccountCreatedAt:'fixture-account-epoch',membershipEpoch:null,projectId:'fixture-project'};
  const descriptor={id:'fixture-descriptor',artifactDigest:'sha256:'+'b'.repeat(64)},preparation={accountCreatedAt:'fixture-account-epoch',installationId:'fixture-installation',installationRevision:1};
  const identity=containedDocumentExecutionIdentity({descriptor,scope,preparation,sequence:1});
  assert.deepEqual(extensionExecutionIdentity(identity),identity);
  assert.equal(identity.ownerId,identity.userId);assert.equal(identity.ownerAccountCreatedAt,identity.accountCreatedAt);assert.equal(identity.membershipEpoch,null);
  for(const field of ['ownerId','ownerAccountCreatedAt','membershipEpoch']){
    const incomplete={...scope};delete incomplete[field];
    assert.throws(()=>extensionExecutionIdentity(containedDocumentExecutionIdentity({descriptor,scope:incomplete,preparation,sequence:1})),{code:'extension_contract_invalid'});
  }
});
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
