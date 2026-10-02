/** Data-only local assessment manifest; this never writes a qualification receipt or accepts private configuration. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { extensionRequestObject } from '../../apps/server/src/extensionAccess.mjs';
import { extensionToolArtifactDigest } from '../../apps/server/src/extensionToolController.mjs';
import { currentExtensionSourcePolicy, loadExtensionDeployment } from '../../apps/server/src/extensionDeployment.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HEX = /^[a-f0-9]{64}$/;
const coordinate = Object.freeze({ kind: 'github', repository: 'Jesse-njx/dsh-cowork', commit: '2ae5cf755c4294a1e988eebf3b12dd062425d84c' });
const repo = path.resolve(new URL('../../../', import.meta.url).pathname);
const root = path.join(repo, '.evimed-local/extensions/build/fixtures');
export const ASSESSMENT_BOOTSTRAP = 'isolated-fixture-metadata-only; no fabricated qualification receipt';
/** Inputs are a trusted image/closure observation, never a customer descriptor or pass flag. */
export async function createAssessmentDescriptor(input) {
  extensionRequestObject(input, ['imageId', 'integrity', 'closureExpectedSHA']);
  if (!DIGEST.test(input.imageId) || !DIGEST.test(input.integrity) || !HEX.test(input.closureExpectedSHA)) throw new Error('invalid_assessment_artifact');
  const adapter = path.join(repo, 'OpenScience/scripts/runtime/extensions/cowork');
  const descriptor = { id: 'cowork-portable', coordinate, integrity: input.integrity, imageId: input.imageId, closureExpectedSHA: input.closureExpectedSHA };
  for (const [key, file] of [['runnerSHA', 'runner.mjs'], ['policySHA', 'policy.mjs'], ['inventorySHA', 'image-inventory.mjs']]) descriptor[key] = hash(await fs.readFile(path.join(adapter, file)));
  descriptor.adapterDigest = 'sha256:' + hash(canonicalJson({ runnerSHA: descriptor.runnerSHA, policySHA: descriptor.policySHA, inventorySHA: descriptor.inventorySHA }));
  descriptor.artifactDigest = extensionToolArtifactDigest(descriptor);
  return Object.freeze(descriptor);
}
/** A fixed owned disposable tree is the only write destination. Loader independently checks the prepared bytes. */
export async function prepareAssessmentDeployment(dataDir, descriptor, suiteRevision) {
  if (!path.isAbsolute(dataDir) || path.dirname(dataDir) !== root || !/^extension-saas-[a-f0-9-]{36}$/.test(path.basename(dataDir)) || !DIGEST.test(suiteRevision)) throw new Error('invalid_assessment_root');
  extensionRequestObject(descriptor, ['id', 'coordinate', 'integrity', 'imageId', 'closureExpectedSHA', 'runnerSHA', 'policySHA', 'inventorySHA', 'adapterDigest', 'artifactDigest']);
  const checked = await createAssessmentDescriptor({ imageId: descriptor.imageId, integrity: descriptor.integrity, closureExpectedSHA: descriptor.closureExpectedSHA });
  if (canonicalJson(checked) !== canonicalJson(descriptor)) throw new Error('assessment_descriptor_changed');
  const info = await fs.lstat(dataDir);
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(dataDir) !== dataDir || (info.mode & 0o022)) throw new Error('unsafe_assessment_root');
  const parent = path.join(dataDir, '.openscience'); await fs.mkdir(parent, { mode: 0o700 });
  const surfaces = { id: descriptor.id, client: false, browser: false, externalActions: false,
    descriptorDigest: 'sha256:' + hash(canonicalJson({ artifactDigest: descriptor.artifactDigest, adapterDigest: descriptor.adapterDigest,
      exposure: 'fixed doc_read/doc_write bridge only; no bundled client/browser/external-action routes' })) };
  const nativePin = JSON.parse(await fs.readFile(path.join(repo, 'OpenScience/deps-version.json'), 'utf8')).dsh.version;
  const manifest = { schemaVersion: 1, generatedAt: new Date().toISOString(), dshVersion: nativePin, policy: currentExtensionSourcePolicy(),
    catalogue: [{ id: descriptor.id, title: 'Contained document tools under local assessment', coordinate, integrity: descriptor.integrity, executionClass: 'isolated-tool', settingsSchema: {} }],
    admittedArtifacts: [{ id: descriptor.id, coordinate, integrity: descriptor.integrity, artifactDigest: descriptor.artifactDigest, adapterRevision: descriptor.adapterDigest, suiteRevision }],
    admittedDescriptors: [descriptor], surfaces: [surfaces] };
  const file = await fs.open(path.join(parent, 'extensions-deployment.json'), 'wx', 0o400);
  try { await file.writeFile(canonicalJson(manifest) + '\n'); await file.chmod(0o400); } finally { await file.close(); }
  const deployment = loadExtensionDeployment({ dataDir });
  if (deployment.status !== 'configured') throw new Error('assessment_deployment_refused');
  return deployment;
}
