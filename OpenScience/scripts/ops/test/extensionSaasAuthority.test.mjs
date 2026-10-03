import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, verify } from 'node:crypto';
import { canonicalJson, canonicalExtensionCoordinate } from '@evimed/domain';
import { ASSESSMENT_FACT_FIELDS, validateMeasurementAdmission, writeMeasurementAdmission } from '../extension-saas-acceptance-authority.mjs';
import { createExtensionAssessmentAuthority } from '../../../apps/server/src/extensionAssessmentAuthority.mjs';
const now = Date.now(), sha = 'sha256:' + 'a'.repeat(64);
function admission() {
  const value = Object.fromEntries(ASSESSMENT_FACT_FIELDS.map(field => [field, sha]));
  return { ...value, assessmentId: 'fixture-measurement', catalogueId: 'cowork-portable',
    coordinate: canonicalExtensionCoordinate({ kind: 'github', repository: 'Jesse-njx/dsh-cowork', commit: 'a'.repeat(40) }),
    sourceCommit: 'a'.repeat(40), dshVersion: 'fixture-pin', databaseNamespace: 'evimed_test_fixture',
    ownerId: 'owner', actorId: 'owner', projectId: 'project', ownerAccountCreatedAt: new Date(now).toISOString(),
    actorAccountCreatedAt: new Date(now).toISOString(),actorMembershipEpoch:null,installerId:'owner',installerAccountCreatedAt:new Date(now).toISOString(),installerMembershipEpoch:null, projectCreatedAt: new Date(now).toISOString(),
    allowedOperations: ['doc_read','doc_write'], issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString() };
}
test('private admission writer signs the exact canonical envelope, never returns or persists signing key', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-saas-assessment-')));
  try {
    const written = await writeMeasurementAdmission({ root, admissions: [admission()], now });
    const bytes = await fs.readFile(written.recordPath, 'utf8'), envelope = JSON.parse(bytes);
    assert.equal(bytes, canonicalJson(envelope) + '\n');
    assert.equal(verify(null, Buffer.from(canonicalJson({ domain: envelope.domain, payload: envelope.payload })), written.publicKey, Buffer.from(envelope.signature, 'base64')), true);
    assert.equal(written.assessmentAdmissionDigest, 'sha256:' + createHash('sha256').update(canonicalJson(envelope)).digest('hex'));
    assert.equal((await fs.stat(written.recordPath)).mode & 0o7777, 0o400);
    assert.equal(written.qualification, 'unverified');
    assert.equal(Object.hasOwn(written, 'privateKey'), false);
    assert.deepEqual(await fs.readdir(written.root), ['admission.json']);
    await assert.rejects(writeMeasurementAdmission({ root, admissions: [admission()], now }), { code: 'EEXIST' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('writer rejects extra authority fields, wildcard operations, stale/overlong windows and duplicate subjects before writing', async () => {
  for (const value of [{ ...admission(), qualified: true }, { ...admission(), allowedOperations: ['*'] },
    { ...admission(),actorMembershipEpoch:'owner-cannot-claim-membership' },{...admission(),installerMembershipEpoch:undefined},
    { ...admission(), expiresAt: new Date(now).toISOString() }, { ...admission(), expiresAt: new Date(now + 3600001).toISOString() }]) {
    assert.throws(() => validateMeasurementAdmission(value, now));
  }
  let touched = false; const value = admission(); Object.defineProperty(value, 'artifactDigest', { enumerable: true, get() { touched = true; return sha; } });
  assert.throws(() => validateMeasurementAdmission(value, now)); assert.equal(touched, false);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-saas-assessment-')));
  try { await assert.rejects(writeMeasurementAdmission({ root, admissions: [admission(), admission()], now })); assert.deepEqual(await fs.readdir(root), []); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('private signer requires explicit current collaborating actor and installer epochs, never owner-null smuggling',()=>{
 const epoch=JSON.stringify({studyId:'fixture',members:[{role:'lead',createdAt:'fixture-created-at'}]}),collaborator={...admission(),actorId:'collaborator',actorMembershipEpoch:epoch,installerId:'collaborator',installerMembershipEpoch:epoch};
 assert.equal(validateMeasurementAdmission(collaborator,now).installerMembershipEpoch,epoch);
 assert.throws(()=>validateMeasurementAdmission({...collaborator,actorMembershipEpoch:null},now));
 assert.throws(()=>validateMeasurementAdmission({...collaborator,installerMembershipEpoch:null},now));
});
test('signer requires independent installer identity/account even when manager is owner',()=>{
 const epoch=JSON.stringify({studyId:'fixture',members:[{role:'lead',createdAt:'installer'}]}),mixed={...admission(),installerId:'lead',installerAccountCreatedAt:new Date(now+1).toISOString(),installerMembershipEpoch:epoch};
 assert.equal(validateMeasurementAdmission(mixed,now).actorId,'owner');
 for(const field of ['installerId','installerAccountCreatedAt','installerMembershipEpoch']){const missing={...mixed};delete missing[field];assert.throws(()=>validateMeasurementAdmission(missing,now));}
 assert.throws(()=>validateMeasurementAdmission({...mixed,installerId:'owner'},now));
 assert.throws(()=>validateMeasurementAdmission({...mixed,installerMembershipEpoch:null},now));
 assert.throws(()=>validateMeasurementAdmission({...admission(),installerAccountCreatedAt:new Date(now+1).toISOString()},now));
});
test('independently constructed real readers verify signer records and refuse operation, identity drift and writable records', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-saas-assessment-'))), record = admission();
  const entry = { id: record.catalogueId, executionClass: 'isolated-tool', integrity: record.packageIntegrity,
    coordinate: { kind: 'github', repository: 'Jesse-njx/dsh-cowork', commit: record.sourceCommit } };
  const artifact = { artifactDigest: record.artifactDigest }, identity = { sourceCommit: record.sourceCommit,
    adapterRevision: record.adapterRevision, runtimeImageDigest: record.runtimeImageDigest, dshVersion: record.dshVersion,
    permissionProfileRevision: record.permissionProfileRevision, suiteRevision: record.suiteRevision };
  const scope = Object.fromEntries(['ownerId','actorId','ownerAccountCreatedAt','actorAccountCreatedAt','actorMembershipEpoch','projectId','projectCreatedAt'].map(field => [field, record[field]]));
  try {
    const written = await writeMeasurementAdmission({ root, admissions: [record], now });
    let webFacts = record, controllerFacts = record;
    const web = createExtensionAssessmentAuthority({ ...written, currentFacts: async () => webFacts, now: () => now });
    const controller = createExtensionAssessmentAuthority({ ...written, currentFacts: async () => controllerFacts, now: () => now });
    const context = { entry, artifact, identity, scope, managerScope:scope, operation: 'doc_read' };
    assert.notEqual(web, controller);
    assert.equal((await web.admit(context)).assessmentAdmissionDigest, written.assessmentAdmissionDigest);
    assert.equal((await controller.admit(context)).assessmentAdmissionDigest, written.assessmentAdmissionDigest);
    await assert.rejects(controller.admit({ ...context, operation: 'shell' }), { code: 'extension_access_denied' });
    controllerFacts = { ...record, runtimeImageDigest: 'sha256:' + 'b'.repeat(64) };
    await assert.rejects(controller.admit(context), { code: 'extension_access_denied' });
    assert.equal((await web.admit(context)).assessmentAdmissionDigest, written.assessmentAdmissionDigest);
    webFacts = { ...record, actorAccountCreatedAt: new Date(now + 1).toISOString() };
    await assert.rejects(web.admit(context), { code: 'extension_access_denied' });
    controllerFacts = record; await fs.chmod(written.recordPath, 0o600);
    await assert.rejects(controller.admit(context), { code: 'extension_access_denied' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
