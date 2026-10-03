import assert from 'node:assert/strict';
import test from 'node:test';
import { runProofRefusalControls, reviewedQualificationReceipt } from '../extension-saas-acceptance-proof.mjs';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
test('issuance gate refuses unknown/partial22 measurement even with an operator-approved digest; no qualification key is involved',()=>{
 const hash=value=>'sha256:'+createHash('sha256').update(canonicalJson(value)).digest('hex'),identity={fixture:'not-a-real-qualified-identity'},now=Date.now();
 const measurement={qualified:false,cleanup:{physicallyJoined:true},cases:Array.from({length:22},(_,index)=>({caseId:'SAAS-'+String(index+1).padStart(2,'0'),status:'unknown',uncovered:['remaining main path'],observations:[{fixture:true}],observationDigests:[],artifactDigests:[]}))};
 const sourceHashes={fixture:'controlled'},review={schemaVersion:1,decision:'approved-complete-measurements',measurementDigest:hash(measurement),identityDigest:hash(identity),sourceHashes,reviewedAt:new Date(now).toISOString()};
 assert.throws(()=>reviewedQualificationReceipt(measurement,review,identity,{},sourceHashes,now),/incomplete/);
 assert.throws(()=>reviewedQualificationReceipt(measurement,{...review,measurementDigest:'sha256:'+'a'.repeat(64)},identity,{},sourceHashes,now),/not_reviewed/);
 assert.throws(()=>reviewedQualificationReceipt({...measurement,cleanup:{physicallyJoined:false}},review,identity,{},sourceHashes,now),/not_reviewed/);
});
test('actual signed reader refuses incomplete/tampered records and every identity drift without producing any pass receipt', async () => {
 const report=await runProofRefusalControls();
 assert.equal(report.qualified,false); assert.equal(report.receiptsQualified,0); assert.equal(report.cleanup.ownedRootRemoved,true);
 assert.equal(report.observations[0].caseId,'SAAS-22');assert.equal(report.observations[0].actual.incomplete,'extension_proof_incomplete');
 assert.equal(report.observations[0].actual.signatureTamper,'extension_proof_untrusted');assert.equal(report.observations[0].actual.outcomeTamper,'extension_proof_untrusted');
 assert.deepEqual(Object.keys(report.observations[0].actual.identityDrifts).sort(),['adapterRevision','dshVersion','executionClass','packageIntegrity','permissionProfileRevision','runtimeImageDigest','sourceCommit','suiteRevision'].sort());
 assert(Object.values(report.observations[0].actual.identityDrifts).every(value=>['extension_proof_stale','extension_contract_invalid'].includes(value)));
});
