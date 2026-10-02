/** Private measurement admission writer. An admission is permission to measure, never an outcome or qualification. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { extensionRequestObject } from '../../apps/server/src/extensionAccess.mjs';
import { EXTENSION_ASSESSMENT_DOMAIN } from '../../apps/server/src/extensionAssessmentAuthority.mjs';
import { assertAssessmentFixtureRoot, ASSESSMENT_SHORT_PARENT } from './extension-saas-acceptance-manifest.mjs';
export const ASSESSMENT_FACT_FIELDS = Object.freeze(['catalogueId','coordinate','sourceCommit','packageIntegrity','artifactDigest','containedImageDigest','adapterDigest','adapterRevision','runtimeImageDigest','dshVersion','permissionProfileRevision','suiteRevision','sourcePolicyDigest','descriptorDigest','fixtureRootDigest','databaseNamespace','ownerId','actorId','ownerAccountCreatedAt','actorAccountCreatedAt','actorMembershipEpoch','installerMembershipEpoch','projectId','projectCreatedAt']);
const digestFields = ['packageIntegrity','artifactDigest','containedImageDigest','adapterDigest','adapterRevision','runtimeImageDigest','permissionProfileRevision','suiteRevision','sourcePolicyDigest','descriptorDigest','fixtureRootDigest'];
const digest = value => 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
export function validateMeasurementAdmission(value, now = Date.now()) {
  extensionRequestObject(value, [...ASSESSMENT_FACT_FIELDS,'assessmentId','issuedAt','expiresAt','allowedOperations']);
  if (Object.keys(value).length !== ASSESSMENT_FACT_FIELDS.length + 4 || ASSESSMENT_FACT_FIELDS.some(field =>
    field === 'sourceCommit' ? value[field] !== null && !/^[a-f0-9]{40}$/.test(value[field])
      : ['actorMembershipEpoch','installerMembershipEpoch'].includes(field) ? value.actorId===value.ownerId ? value[field]!==null : typeof value[field]!=='string'||!value[field]||value[field].length>16384
      : typeof value[field] !== 'string' || !value[field] || value[field].length > 1024)
    || digestFields.some(field => !/^sha256:[a-f0-9]{64}$/.test(value[field]))
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.assessmentId)
    || !Array.isArray(value.allowedOperations) || !value.allowedOperations.length || value.allowedOperations.length > 2
    || new Set(value.allowedOperations).size !== value.allowedOperations.length || value.allowedOperations.some(operation => !['doc_read','doc_write'].includes(operation))) throw new Error('invalid_measurement_admission');
  const issued = Date.parse(value.issuedAt), expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now || expires <= issued || expires - issued > 60 * 60 * 1000) throw new Error('invalid_measurement_window');
  return Object.freeze({ ...value, allowedOperations: Object.freeze([...value.allowedOperations]) });
}
/** Caller provisions a new private owned fixture root; writer creates only its fixed admission subtree, once. */
export async function writeMeasurementAdmission({ root, admissions, now = Date.now() }) {
  const short=typeof root==='string'&&path.dirname(root)===ASSESSMENT_SHORT_PARENT&&/^[a-f0-9]{10}$/.test(path.basename(root));
  if(short)await assertAssessmentFixtureRoot(root);
  if (typeof root !== 'string' || !path.isAbsolute(root) || !short&&!/^evimed-saas-(?:assessment|root|boundaries)-[A-Za-z0-9-]+$/.test(path.basename(root)) && !/^extension-saas-[a-f0-9-]{36}$/.test(path.basename(root))) throw new Error('unowned_assessment_root');
  const info = await fs.lstat(root);
  const expectedOwnerUid = process.getuid();
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o7777) !== 0o700 || info.uid !== expectedOwnerUid || await fs.realpath(root) !== root) throw new Error('unowned_assessment_root');
  if (!Array.isArray(admissions) || !admissions.length || admissions.length > 32) throw new Error('invalid_measurement_admissions');
  const records = admissions.map(value => validateMeasurementAdmission(value, now));
  const subjects = records.map(record => canonicalJson(ASSESSMENT_FACT_FIELDS.map(field => record[field])));
  if (new Set(subjects).size !== records.length) throw new Error('duplicate_measurement_subject');
  const directory = path.join(root, 'assessment-admission');
  await fs.mkdir(directory, { mode: 0o700 });
  const recordPath = path.join(directory, 'admission.json'), { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const body = { domain: EXTENSION_ASSESSMENT_DOMAIN, payload: { schemaVersion: 1, admissions: records } };
  const envelope = { ...body, signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString('base64') };
  const file = await fs.open(recordPath, 'wx', 0o400);
  try { await file.writeFile(canonicalJson(envelope) + '\n'); await file.sync(); await file.chmod(0o400); } finally { await file.close(); }
  // The private signer is neither persisted nor returned. Readers have public verification material only.
  return Object.freeze({ root: directory, recordPath, expectedOwnerUid, publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    assessmentAdmissionDigest: digest(envelope), qualification: 'unverified' });
}
