import assert from 'node:assert/strict';
import test from 'node:test';
import { runProofRefusalControls } from '../extension-saas-acceptance-proof.mjs';
test('actual signed reader refuses incomplete/tampered records and every identity drift without producing any pass receipt', async () => {
 const report=await runProofRefusalControls();
 assert.equal(report.qualified,false); assert.equal(report.receiptsQualified,0); assert.equal(report.cleanup.ownedRootRemoved,true);
 assert.equal(report.observations[0].caseId,'SAAS-22');assert.equal(report.observations[0].actual.incomplete,'extension_proof_incomplete');
 assert.equal(report.observations[0].actual.signatureTamper,'extension_proof_untrusted');assert.equal(report.observations[0].actual.outcomeTamper,'extension_proof_untrusted');
 assert.deepEqual(Object.keys(report.observations[0].actual.identityDrifts).sort(),['adapterRevision','dshVersion','executionClass','packageIntegrity','permissionProfileRevision','runtimeImageDigest','sourceCommit','suiteRevision'].sort());
 assert(Object.values(report.observations[0].actual.identityDrifts).every(value=>['extension_proof_stale','extension_contract_invalid'].includes(value)));
});
