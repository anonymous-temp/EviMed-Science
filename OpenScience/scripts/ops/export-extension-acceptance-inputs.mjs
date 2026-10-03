#!/usr/bin/env node
/** Export only public prepared observations and exact image identities; never qualification. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readAcceptanceInputs, readPreparedCatalogueSnapshot } from './extension-saas-acceptance-inputs.mjs';
import { assessmentDockerEnvironment } from './extension-saas-acceptance-docker.mjs';
import { openScopedFileNoFollow, readStableFileHandle } from '../../apps/server/src/security.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** All files are fixed public build observations. Secrets, build contexts and logs are excluded. */
export async function prepareAcceptanceExport({ inputsFile, output, sourceRevision, workflowRun, workflowAttempt, docker = (args) => { const bytes = execFileSync('docker', args, { env: assessmentDockerEnvironment(), timeout: 30000, maxBuffer: 1024 * 1024 }).toString(); return bytes.trim() ? JSON.parse(bytes) : null; } }) {
  if (!path.isAbsolute(output) || !/^[a-f0-9]{40}$/.test(sourceRevision) || !/^\d+$/.test(workflowRun) || !/^\d+$/.test(workflowAttempt)) throw new Error('invalid_assessment_export_identity');
  const inputs = await readAcceptanceInputs(inputsFile); await readPreparedCatalogueSnapshot(inputs);
  await fs.mkdir(output, { mode: 0o700 });
  const records = [];
  const copy = async (root, relative, target) => {
    const opened = await openScopedFileNoFollow(root, path.join(root, relative)); let bytes;
    try {
      if ((opened.stat.mode & 0o022) || opened.stat.size < 1 || opened.stat.size > 32 * 1024 * 1024) throw new Error('unsafe_export_input');
      bytes = await readStableFileHandle(opened.handle, opened.stat);
    } finally { await opened.handle.close(); }
    const file = path.join(output, target); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o400 });
    records.push({ path: target, bytes: bytes.length, sha256: hash(bytes), mode: '0400' }); return bytes;
  };
  await copy(inputs.preparedRoot, 'acceptance-inputs.json', 'prepared/acceptance-inputs.json');
  await copy(inputs.preparedRoot, 'preparation-record.json', 'prepared/preparation-record.json');
  await copy(inputs.preparedRoot, inputs.fixtures.catalogueSnapshotPath, 'prepared/fixtures/catalogue-snapshot.json');
  const preparationRoot = path.dirname(inputs.preparedRoot);
  const closure = await copy(preparationRoot, 'cowork/context/dependency-closure.json', 'closure/dependency-closure.json');
  if (hash(closure) !== inputs.artifact.closureExpectedSHA || JSON.parse(closure).contentDigest !== inputs.artifact.integrity) throw new Error('export_closure_changed');
  const attestation = JSON.parse(await copy(preparationRoot, 'cowork/context/overlay-attestation.json', 'closure/overlay-attestation.json'));
  const overlayLock = await copy(preparationRoot, 'public-adapter/overlay/pnpm-lock.yaml', 'closure/overlay-pnpm-lock.yaml');
  const overlayPins = await copy(preparationRoot, 'public-adapter/overlay/pins.json', 'closure/overlay-pins.json');
  if (attestation.dependencyClosureSha256 !== hash(closure) || attestation.dependencyClosureDigest !== inputs.artifact.integrity
    || attestation.sourceCommit !== inputs.sourceCommit || attestation.admittedLockSha256 !== hash(overlayLock)
    || attestation.overlayPinsSha256 !== hash(overlayPins)) throw new Error('export_attestation_changed');
  const lock = await copy(preparationRoot, 'cowork/context/pnpm-lock.yaml', 'closure/pnpm-lock.yaml');
  const source = await copy(preparationRoot, 'public-adapter/source-manifest.json', 'closure/source-manifest.json');
  const record = JSON.parse(await fs.readFile(path.join(output, 'prepared/preparation-record.json'), 'utf8'));
  if (record.lockSHA !== hash(lock) || record.sourceManifestSHA !== hash(source) || JSON.parse(source).commit !== inputs.sourceCommit) throw new Error('export_preparation_changed');
  const roles = {}, images = [];
  for (const [role, imageId] of Object.entries(inputs.images)) {
    let image = images.find(value => value.imageId === imageId);
    if (!image) {
      const actual = docker(['image', 'inspect', imageId])[0];
      if (actual?.Id !== imageId || `${actual.Os}/${actual.Architecture}` !== inputs.platform || !Array.isArray(actual.RootFS?.Layers)) throw new Error('export_image_changed');
      const reference = `evimed-extension-assessment:${sourceRevision}-${workflowRun}-${workflowAttempt}-${role.replace('ImageId', '').toLowerCase()}`;
      // Tagging is a local CI observation, never image mutation or serving admission.
      docker(['image', 'tag', imageId, reference]);
      image = { imageId, reference, platform: inputs.platform, inspectedBytes: actual.Size, diffIds: actual.RootFS.Layers }; images.push(image);
    }
    roles[role] = { imageId, reference: image.reference };
  }
  await fs.writeFile(path.join(output, 'images.txt'), images.map(value => value.reference + '\n').join(''), { mode: 0o400, flag: 'wx' });
  const metadata = { schemaVersion: 1, sourceRevision, workflowRun, workflowAttempt, evidenceState: 'source-assessed', qualified: false, qualification: 'unverified', roles, images, files: records, restoration: { privateDirectoryMode: '0700', observationFileMode: '0400', inputsFile: 'prepared/acceptance-inputs.json', servingImageIncluded: false } };
  await fs.writeFile(path.join(output, 'prepared-export.json'), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o400, flag: 'wx' });
  return metadata;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareAcceptanceExport({ inputsFile: process.env.EVIMED_EXTENSION_ACCEPTANCE_INPUTS, output: path.join(process.env.RUNNER_TEMP, 'evimed-extension-assessment'), sourceRevision: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID, workflowAttempt: process.env.GITHUB_RUN_ATTEMPT });
}
