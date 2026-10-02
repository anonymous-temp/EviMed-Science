import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalJson, canonicalExtensionCoordinate, EXTENSION_EXECUTION_CLASSES, validateExtensionProofIdentity, extensionProofAdapterRevision } from '@evimed/domain';
import { extensionRequestObject, extensionArray, extensionIdentifier } from './extensionAccess.mjs';
import { extensionToolArtifactDigest } from './extensionToolController.mjs';
import { HttpError } from './security.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const sha = value => createHash('sha256').update(value).digest('hex');
const DIGEST = /^sha256:[a-f0-9]{64}$/u,
  HEX = /^[a-f0-9]{64}$/u;
const ADAPTER_SOURCES = Object.freeze(['apps/server/src/extensionDeployment.mjs', 'apps/server/src/extensionHostedIntegration.mjs', 'apps/server/src/extensionGateway.mjs', 'apps/server/src/server.mjs', 'apps/server/src/extensionRoutes.mjs', 'apps/server/src/runtimeControllerClient.mjs', 'apps/server/src/runtimeControllerServer.mjs', 'apps/server/src/runtimeControllerIndex.mjs', 'apps/server/src/dshRuntimeAdapter.mjs', 'apps/server/src/extensionAccountExport.mjs', 'apps/server/src/extensionActorBindings.mjs', 'apps/server/src/extensionControllerComposition.mjs', 'apps/server/src/extensionOperationService.mjs', 'apps/server/src/extensionOperationWorker.mjs', 'apps/server/src/extensionOperationGrants.mjs', 'apps/server/src/extensionResourceResolver.mjs', 'apps/server/src/extensionDocumentResources.mjs', 'apps/server/src/extensionInvocationLookup.mjs', 'apps/server/src/extensionQualification.mjs', 'apps/server/src/extensionToolController.mjs', 'apps/server/src/extensionGenerationService.mjs', 'apps/server/src/extensionGenerationWorker.mjs', 'apps/server/src/extensionPreparationWorker.mjs', 'apps/server/src/productJobs.mjs', 'apps/server/src/productPersistence.mjs', 'apps/server/src/heavyWorkAdmission.mjs', 'apps/server/src/productStore.mjs', 'apps/server/src/controlPlaneDatabase.mjs', 'apps/server/src/config.mjs', 'packages/domain/index.mjs', 'packages/harness-port/index.mjs', 'apps/server/src/publicSourceGateway.mjs', 'packages/domain/src/extensions.mjs', 'packages/socket/extensions/cowork/bridge.mjs', 'packages/harness-port/src/pluginProbe.mjs', 'packages/harness-port/seam-manifest.json', 'scripts/runtime/extensions/cowork/runner.mjs', 'scripts/runtime/extensions/cowork/policy.mjs', 'scripts/runtime/extensions/cowork/image-inventory.mjs', 'deps-version.json']);
const PERMISSION_SOURCES = Object.freeze(['apps/server/src/runtimeManager.mjs', 'apps/server/src/runtimeUiServer.mjs', 'apps/server/src/runtimeUiDocument.mjs', 'apps/server/src/managedBrowserRoutes.mjs', 'apps/server/src/managedBrowserService.mjs', 'apps/server/src/managedBrowserDns.mjs', 'apps/server/src/webRenderEgress.mjs', 'apps/server/src/edgeProxy.mjs', 'apps/server/src/dshProfilePatch.mjs', 'apps/server/src/extensionAccess.mjs', 'apps/server/src/pluginService.mjs', 'apps/server/src/security.mjs', 'apps/server/src/runtimeGatewayEntry.mjs', 'apps/server/src/modelGateway.mjs', 'packages/socket/presets/evimed-universal/agent.cordis.yml']);
const PERSONAL_SOURCES = Object.freeze([
  'apps/server/src/pluginInventoryRoutes.mjs',
  'apps/server/src/nativeSkillCatalogue.mjs', 'apps/server/src/skillLibraryService.mjs', 'apps/server/src/skillLibraryRoutes.mjs',
  'apps/server/src/skillLibraryArtifacts.mjs', 'apps/server/src/skillArchive.mjs', 'apps/server/src/skillValidationController.mjs',
  'apps/server/src/personalSkillRepositoryImport.mjs', 'apps/server/src/personalSkillTransfer.mjs',
  'apps/server/src/personalSkillTransferRoutes.mjs', 'apps/server/src/personalSkillTransferArchive.mjs',
  'apps/server/src/personalSkillGenerationService.mjs', 'apps/server/src/personalSkillGenerationWorker.mjs',
  'apps/server/src/personalSkillMount.mjs', 'apps/server/src/extensionPrivateCleanup.mjs', 'apps/server/src/webReadNetwork.mjs',
  'packages/harness-port/src/scopedSkillCatalogue.mjs', 'packages/harness-port/src/personalSkills.mjs',
  'packages/socket/plugins/skill-catalogue.mjs', 'packages/socket/cordis.patch.yml', 'packages/socket/index.mjs',
  'runtime/mcp/evimed-research/open_access_fulltext.py', 'runtime/mcp/evimed-research/public_sources.py',
]);
const failure = () => new HttpError(503, 'product_state_unavailable', 'The protected extension deployment is unavailable.');
/** Hash only a closed source list; no environment, private configuration or package-defined path participates.
 * @param {readonly string[]} sources */
function sourceDigest(sources) {
  try {
    const inventory = sources.map(name => {
      const target = path.join(root, name),
        stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw failure();
      return {
        name,
        sha256: sha(fs.readFileSync(target))
      };
    });
    return digest(canonicalJson(inventory));
  } catch {
    throw failure();
  }
}
/** Actual deployed source bytes define policy freshness; manifest assertions alone never authorize a package. */
export function currentExtensionSourcePolicy() {
  return Object.freeze({
    adapterRevision: sourceDigest([...ADAPTER_SOURCES, ...PERSONAL_SOURCES]),
    permissionProfileRevision: sourceDigest(PERMISSION_SOURCES)
  });
}
/** @param {any} value */
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** @param {any[]} rows */
function immutableMap(rows) {
  const value = new Map(rows);
  for (const method of ['set', 'delete', 'clear']) Object.defineProperty(value, method, {
    value: () => {
      throw failure();
    },
    enumerable: false
  });
  return Object.freeze(value);
}
/** @param {any} config @param {string} status @param {string|null} [errorCode] */
function empty(config, status, errorCode = null) {
  return Object.freeze({
    status,
    errorCode,
    catalogue: Object.freeze([]),
    admittedArtifacts: Object.freeze([]),
    admittedDescriptors: Object.freeze([]),
    generatedAt: null,
    surfaces: immutableMap([]),
    qualificationRoot: path.join(path.resolve(config.dataDir), '.openscience', 'extension-qualification'),
    policy: null,
    sourceDigest: null
  });
}
/** The one protected path is never selected by a public request. Reads are synchronous to preserve createWebApiApp's existing contract.
 * @param {any} config */
export function loadExtensionDeployment(config) {
  const dataDir = path.resolve(config.dataDir),
    parent = path.join(dataDir, '.openscience'),
    target = path.join(parent, 'extensions-deployment.json');
  let fd;
  try {
    for (const directory of [dataDir, parent]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw failure();
    }
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || ![0o400, 0o440].includes(before.mode & 0o7777) || before.size < 1 || before.size > 512 * 1024 || ![0, process.getuid?.()].includes(before.uid)) throw failure();
    const bytes = Buffer.alloc(before.size + 1),
      read = fs.readSync(fd, bytes, 0, bytes.length, 0),
      after = fs.fstatSync(fd);
    if (read !== before.size || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw failure();
    const manifest = JSON.parse(new TextDecoder('utf-8', {
      fatal: true
    }).decode(bytes.subarray(0, read)));
    extensionRequestObject(manifest, ['schemaVersion', 'generatedAt', 'dshVersion', 'policy', 'catalogue', 'admittedArtifacts', 'admittedDescriptors', 'surfaces']);
    if (manifest.schemaVersion !== 1 || manifest.dshVersion !== '0.1.7-rc.2' || typeof manifest.generatedAt !== 'string' || !Number.isFinite(Date.parse(manifest.generatedAt))) throw failure();
    extensionRequestObject(manifest.policy, ['adapterRevision', 'permissionProfileRevision']);
    const policy = currentExtensionSourcePolicy();
    if (canonicalJson(policy) !== canonicalJson(manifest.policy)) throw failure();
    for (const key of ['catalogue', 'admittedArtifacts', 'admittedDescriptors', 'surfaces']) extensionArray(manifest[key], 128);
    const catalogue = new Map(),
      artifacts = new Map(),
      descriptors = new Map(),
      surfaces = new Map(),
      coordinates = new Set();
    for (const row of manifest.catalogue) {
      extensionRequestObject(row, ['id', 'title', 'coordinate', 'executionClass', 'integrity', 'settingsSchema']);
      extensionIdentifier(row.id);
      canonicalExtensionCoordinate(row.coordinate);
      if (catalogue.has(row.id) || !DIGEST.test(row.integrity) || !EXTENSION_EXECUTION_CLASSES.includes(row.executionClass) || typeof row.title !== 'string' || !row.title.trim() || Buffer.byteLength(row.title) > 512) throw failure();
      extensionRequestObject(row.settingsSchema, Object.keys(row.settingsSchema));
      for (const [key, definition] of Object.entries(row.settingsSchema)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || /^(?:ownerid|userid|role|qualified|proof|apikey|token|secret|password|credentials|hostpath|env|cmd|command|url|baseurl|endpoint|path)$/iu.test(key.replaceAll('_', ''))) throw failure();
        extensionRequestObject(definition, ['type', 'default', 'min', 'max', 'maxLength', 'enum'], ['type']);
        if (!['integer', 'number', 'boolean', 'string'].includes(definition.type)) throw failure();
      }
      const coordinate = canonicalExtensionCoordinate(row.coordinate);
      if (coordinates.has(coordinate)) throw failure();
      coordinates.add(coordinate);
      catalogue.set(row.id, freeze(row));
    }
    for (const row of manifest.admittedDescriptors) {
      extensionRequestObject(row, ['id', 'coordinate', 'integrity', 'imageId', 'closureExpectedSHA', 'runnerSHA', 'policySHA', 'inventorySHA', 'adapterDigest', 'artifactDigest']);
      extensionIdentifier(row.id);
      canonicalExtensionCoordinate(row.coordinate);
      const entry = catalogue.get(row.id);
      if (descriptors.has(row.id) || !entry || entry.executionClass !== 'isolated-tool' || canonicalExtensionCoordinate(entry.coordinate) !== canonicalExtensionCoordinate(row.coordinate) || entry.integrity !== row.integrity || ![row.imageId, row.integrity, row.adapterDigest, row.artifactDigest].every(x => DIGEST.test(x)) || ![row.closureExpectedSHA, row.runnerSHA, row.policySHA, row.inventorySHA].every(x => HEX.test(x))) throw failure();
      if (row.adapterDigest !== digest(canonicalJson({
        runnerSHA: row.runnerSHA,
        policySHA: row.policySHA,
        inventorySHA: row.inventorySHA
      })) || row.artifactDigest !== extensionToolArtifactDigest(row)) throw failure();
      descriptors.set(row.id, freeze(row));
    }
    for (const row of manifest.admittedArtifacts) {
      extensionRequestObject(row, ['id', 'coordinate', 'integrity', 'artifactDigest', 'adapterRevision', 'suiteRevision']);
      extensionIdentifier(row.id);
      const entry = catalogue.get(row.id),
        descriptor = descriptors.get(row.id);
      if (artifacts.has(row.id) || !entry || !descriptor || canonicalExtensionCoordinate(row.coordinate) !== canonicalExtensionCoordinate(entry.coordinate) || row.integrity !== entry.integrity || row.artifactDigest !== descriptor.artifactDigest || row.adapterRevision !== descriptor.adapterDigest || !DIGEST.test(row.suiteRevision)) throw failure();
      artifacts.set(row.id, freeze(row));
    }
    if (artifacts.size !== descriptors.size) throw failure();
    for (const row of manifest.surfaces) {
      extensionRequestObject(row, ['id', 'client', 'browser', 'externalActions', 'descriptorDigest']);
      if (surfaces.has(row.id) || !artifacts.has(row.id) || ![row.client, row.browser, row.externalActions].every(x => typeof x === 'boolean') || !DIGEST.test(row.descriptorDigest)) throw failure();
      const {
        id,
        ...surface
      } = row;
      surfaces.set(id, freeze(surface));
    }
    if (surfaces.size !== artifacts.size) throw failure();
    return Object.freeze({
      status: 'configured',
      errorCode: null,
      catalogue: Object.freeze([...catalogue.values()]),
      admittedArtifacts: Object.freeze([...artifacts.values()]),
      admittedDescriptors: Object.freeze([...descriptors.values()]),
      generatedAt: manifest.generatedAt,
      surfaces: immutableMap([...surfaces]),
      qualificationRoot: path.join(parent, 'extension-qualification'),
      policy,
      sourceDigest: sha(bytes.subarray(0, read))
    });
  } catch (error) {
    return empty(config, error?.code === 'ENOENT' && fd === undefined ? 'unconfigured' : 'unavailable', error?.code === 'ENOENT' && fd === undefined ? null : 'extension_contract_invalid');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
/** Policy and runtime pins are constructor authority, never a caller-provided proof or qualifier.
 * @param {any} deployment @param {string} immutableRuntimeImageId */
export function deploymentGenerationIdentities(deployment, immutableRuntimeImageId) {
  const current = currentExtensionSourcePolicy();
  if (deployment.status !== 'configured' || !DIGEST.test(immutableRuntimeImageId) || canonicalJson(deployment.policy) !== canonicalJson(current)) throw failure();
  return {
    baseRuntimeImageDigest: immutableRuntimeImageId,
    ...current,
    legacyCitationArtifactDigest: digest(canonicalJson({
      baseRuntimeImageDigest: immutableRuntimeImageId,
      plugin: 'dsh-cite',
      version: '0.3.2'
    }))
  };
}
/** Native readiness still proves the actual cite binary; a digest is not a probe result.
 * @param {any} deployment @param {any} entry @param {string} immutableRuntimeImageId */
export function deploymentProofIdentity(deployment, entry, immutableRuntimeImageId) {
  const identities = deploymentGenerationIdentities(deployment, immutableRuntimeImageId),
    known = deployment.catalogue.find(row => row.id === entry?.id),
    artifact = deployment.admittedArtifacts.find(row => row.id === entry?.id);
  if (!known || !artifact || canonicalExtensionCoordinate(known.coordinate) !== canonicalExtensionCoordinate(entry.coordinate) || known.integrity !== entry.integrity || known.executionClass !== entry.executionClass) throw failure();
  return validateExtensionProofIdentity({
    packageIntegrity: known.integrity,
    sourceCommit: known.coordinate.kind === 'github' ? known.coordinate.commit : null,
    adapterRevision: extensionProofAdapterRevision(artifact.adapterRevision,identities.adapterRevision,sha),
    dshVersion: '0.1.7-rc.2',
    runtimeImageDigest: immutableRuntimeImageId,
    executionClass: known.executionClass,
    permissionProfileRevision: identities.permissionProfileRevision,
    suiteRevision: artifact.suiteRevision
  });
}
