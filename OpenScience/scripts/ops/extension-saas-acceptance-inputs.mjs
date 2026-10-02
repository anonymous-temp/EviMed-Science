/** Protected reproducible preparation inputs; neither a caller's options nor package health is authority. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { extensionRequestObject } from '../../apps/server/src/extensionAccess.mjs';
import { openScopedFileNoFollow, readStableFileHandle } from '../../apps/server/src/security.mjs';
import { createAssessmentDescriptor } from './extension-saas-acceptance-manifest.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), DIGEST = /^sha256:[a-f0-9]{64}$/, HEX = /^[a-f0-9]{64}$/;
function immutable(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); } return value; }
export async function readAcceptanceInputs(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== 'acceptance-inputs.json') throw new Error('invalid_acceptance_input_path');
  const parent = path.dirname(file), info = await fs.lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || await fs.realpath(parent) !== parent) throw new Error('unsafe_acceptance_input_parent');
  const opened = await openScopedFileNoFollow(parent, file); let bytes;
  try { if (![0o400,0o440,0o600].includes(opened.stat.mode & 0o7777) || opened.stat.size < 1 || opened.stat.size > 256 * 1024) throw new Error('unsafe_acceptance_input_file'); bytes = await readStableFileHandle(opened.handle, opened.stat); }
  finally { await opened.handle.close(); }
  const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  extensionRequestObject(record, ['schemaVersion','platform','sourceCommit','dshVersion','images','artifact','fixtures','qualification']);
  extensionRequestObject(record.images, ['coworkImageId','nativeSdkImageId','nativeKernelImageId']);
  extensionRequestObject(record.artifact, ['closureExpectedSHA','integrity','runnerSHA','policySHA','inventorySHA','adapterDigest','artifactDigest']);
  extensionRequestObject(record.fixtures, ['catalogueSnapshotPath','catalogueSnapshotSHA']);
  const pin = JSON.parse(await fs.readFile(new URL('../../deps-version.json', import.meta.url), 'utf8')).dsh.version;
  if (record.schemaVersion !== 1 || !['linux/amd64','linux/arm64'].includes(record.platform) || record.dshVersion !== pin || record.qualification !== 'unverified'
    || !/^[a-f0-9]{40}$/.test(record.sourceCommit) || !Object.values(record.images).every(value => DIGEST.test(value))
    || record.fixtures.catalogueSnapshotPath !== 'fixtures/catalogue-snapshot.json' || !HEX.test(record.fixtures.catalogueSnapshotSHA)) throw new Error('invalid_acceptance_preparation');
  const descriptor = await createAssessmentDescriptor({ imageId: record.images.coworkImageId, integrity: record.artifact.integrity, closureExpectedSHA: record.artifact.closureExpectedSHA });
  if (record.sourceCommit !== descriptor.coordinate.commit || Object.entries(record.artifact).some(([key,value]) => descriptor[key] !== value)) throw new Error('acceptance_artifact_adapter_changed');
  return immutable({ ...record, recordSHA256: hash(bytes), preparedRoot: parent, descriptor });
}
/** Snapshot bytes stay in the protected prepared tree and independently match the frozen external record. */
export async function readPreparedCatalogueSnapshot(inputs) {
  const file = path.join(inputs.preparedRoot, inputs.fixtures.catalogueSnapshotPath), opened = await openScopedFileNoFollow(inputs.preparedRoot, file); let bytes;
  try { if (opened.stat.size < 1 || opened.stat.size > 32 * 1024 * 1024 || (opened.stat.mode & 0o022)) throw new Error('unsafe_acceptance_snapshot'); bytes = await readStableFileHandle(opened.handle, opened.stat); }
  finally { await opened.handle.close(); }
  if (hash(bytes) !== inputs.fixtures.catalogueSnapshotSHA) throw new Error('acceptance_snapshot_changed');
  const snapshot = JSON.parse(bytes.toString('utf8')); extensionRequestObject(snapshot, ['list','body','snapshot']);
  return immutable({ value: snapshot, digest: 'sha256:' + hash(canonicalJson(snapshot)) });
}
