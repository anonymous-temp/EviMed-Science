import { array, check, digest, identifier, integer, object, oneOf, strings, unique } from './validation.mjs'
import { HOST_ABI, HOST_PORT_METHODS } from './ports.mjs'

export const SCHEMA_VERSIONS = Object.freeze(Object.fromEntries(
  ['task', 'context', 'trial', 'evidence', 'calculation', 'assessment', 'decision', 'result', 'report'].map((key) => [key, '1']),
))

function version(value, path) {
  check(typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value), path, 'expected an exact semantic version')
}

function packageArtifact(value, path, expectedName) {
  object(value, path, ['package', 'version', 'integrity'])
  check(value.package === expectedName, `${path}.package`, 'unexpected package coordinate')
  version(value.version, `${path}.version`)
  // Canonical SHA-512 SRI: exactly 64 bytes; tags and mutable ranges are refused.
  check(typeof value.integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity), `${path}.integrity`, 'expected SHA-512 package integrity')
}

function resourceArtifact(value, path) {
  object(value, path, ['id', 'package', 'version', 'integrity'])
  identifier(value.id, `${path}.id`)
  check(typeof value.package === 'string' && /^@evimed\/[a-z0-9-]+$/.test(value.package), `${path}.package`, 'expected a first-party package')
  packageArtifact({ package: value.package, version: value.version, integrity: value.integrity }, path, value.package)
}

function modelProfile(value, path, provider, models, extra = []) {
  object(value, path, ['provider', 'model', 'revision', 'digest', ...extra])
  check(value.provider === provider, `${path}.provider`, 'unsupported provider')
  oneOf(value.model, models, `${path}.model`)
  identifier(value.revision, `${path}.revision`)
  digest(value.digest, `${path}.digest`)
}

function codeProfile(value, path) {
  object(value, path, ['id', 'version', 'digest'])
  identifier(value.id, `${path}.id`)
  version(value.version, `${path}.version`)
  digest(value.digest, `${path}.digest`)
}

/** Closed release format: no credentials, endpoints, workspace paths or executable snippets. */
export function validateReleaseManifest(manifest) {
  const p = 'release'
  object(manifest, p, ['schemaVersion', 'plugin', 'artifacts', 'host', 'kernel', 'schemas', 'profiles', 'resources', 'verification', 'upgrade'])
  check(manifest.schemaVersion === '1', `${p}.schemaVersion`, 'unsupported release schema', 'unsupported_schema')
  object(manifest.plugin, `${p}.plugin`, ['id', 'version'])
  check(manifest.plugin.id === 'patient-matching', `${p}.plugin.id`, 'unexpected plugin')
  version(manifest.plugin.version, `${p}.plugin.version`)
  object(manifest.artifacts, `${p}.artifacts`, ['core', 'bundle', 'worker', 'resources'])
  packageArtifact(manifest.artifacts.core, `${p}.artifacts.core`, '@evimed/patient-matching-core')
  packageArtifact(manifest.artifacts.bundle, `${p}.artifacts.bundle`, '@evimed/dsh-patient-matching')
  object(manifest.artifacts.worker, `${p}.artifacts.worker`, ['image'])
  check(typeof manifest.artifacts.worker.image === 'string' && /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(manifest.artifacts.worker.image), `${p}.artifacts.worker.image`, 'expected an immutable OCI image digest')
  array(manifest.artifacts.resources, `${p}.artifacts.resources`, resourceArtifact)
  unique(manifest.artifacts.resources, `${p}.artifacts.resources`, (resource) => resource.id)
  object(manifest.host, `${p}.host`, ['abi', 'ports'])
  check(manifest.host.abi === HOST_ABI, `${p}.host.abi`, 'unsupported host ABI', 'unsupported_host_abi')
  object(manifest.host.ports, `${p}.host.ports`, Object.keys(HOST_PORT_METHODS))
  for (const [port, methods] of Object.entries(HOST_PORT_METHODS)) {
    const declared = strings(manifest.host.ports[port], `${p}.host.ports.${port}`)
    unique(declared, `${p}.host.ports.${port}`)
    check(declared.length === methods.length && methods.every((method) => declared.includes(method)), `${p}.host.ports.${port}`, 'host operation set must match ABI')
  }
  object(manifest.kernel, `${p}.kernel`, ['version', 'seamDigest'])
  version(manifest.kernel.version, `${p}.kernel.version`)
  digest(manifest.kernel.seamDigest, `${p}.kernel.seamDigest`)
  object(manifest.schemas, `${p}.schemas`, Object.keys(SCHEMA_VERSIONS))
  for (const [key, expected] of Object.entries(SCHEMA_VERSIONS)) check(manifest.schemas[key] === expected, `${p}.schemas.${key}`, 'unsupported schema', 'unsupported_schema')
  object(manifest.profiles, `${p}.profiles`, ['reasoning', 'embedding', 'rerank', 'priority', 'algorithm', 'skill'])
  const profiles = manifest.profiles
  modelProfile(profiles.reasoning, `${p}.profiles.reasoning`, 'deepseek', ['deepseek-flash'], ['efforts'])
  array(profiles.reasoning.efforts, `${p}.profiles.reasoning.efforts`, (effort, path) => oneOf(effort, ['low', 'medium', 'high'], path))
  check(profiles.reasoning.efforts.length > 0, `${p}.profiles.reasoning.efforts`, 'at least one effort required')
  unique(profiles.reasoning.efforts, `${p}.profiles.reasoning.efforts`)
  modelProfile(profiles.embedding, `${p}.profiles.embedding`, 'bailian', ['qwen3.7-text-embedding', 'qwen3.7-text-embedding-flash'], ['dimensions'])
  integer(profiles.embedding.dimensions, `${p}.profiles.embedding.dimensions`, 1)
  modelProfile(profiles.rerank, `${p}.profiles.rerank`, 'bailian', ['qwen3.7-text-rerank'])
  if (profiles.priority !== undefined) modelProfile(profiles.priority, `${p}.profiles.priority`, 'typesafe', ['jev-1.14.0'])
  codeProfile(profiles.algorithm, `${p}.profiles.algorithm`)
  codeProfile(profiles.skill, `${p}.profiles.skill`)
  object(manifest.resources, `${p}.resources`, ['trialIndex', 'knowledgeRequired'])
  check(typeof manifest.resources.knowledgeRequired === 'boolean', `${p}.resources.knowledgeRequired`, 'expected boolean')
  if (manifest.resources.trialIndex !== null) {
    const index = object(manifest.resources.trialIndex, `${p}.resources.trialIndex`, ['generation', 'embeddingProfileDigest', 'dimensions'])
    identifier(index.generation, `${p}.resources.trialIndex.generation`)
    digest(index.embeddingProfileDigest, `${p}.resources.trialIndex.embeddingProfileDigest`)
    check(index.embeddingProfileDigest === profiles.embedding.digest && index.dimensions === profiles.embedding.dimensions, `${p}.resources.trialIndex`, 'index and embedding profiles differ', 'index_profile_mismatch')
  }
  object(manifest.verification, `${p}.verification`, ['receipts'])
  array(manifest.verification.receipts, `${p}.verification.receipts`, (receipt, path) => {
    object(receipt, path, ['kind', 'artifactDigest', 'artifactId'])
    oneOf(receipt.kind, ['package', 'runtime', 'workflow', 'benchmark'], `${path}.kind`)
    digest(receipt.artifactDigest, `${path}.artifactDigest`)
    identifier(receipt.artifactId, `${path}.artifactId`)
  })
  object(manifest.upgrade, `${p}.upgrade`, ['readableSchemaVersions', 'rollbackGenerations'])
  array(manifest.upgrade.readableSchemaVersions, `${p}.upgrade.readableSchemaVersions`, (value, path) => oneOf(value, ['1'], path))
  check(manifest.upgrade.readableSchemaVersions.includes('1'), `${p}.upgrade.readableSchemaVersions`, 'current schema reader required')
  array(manifest.upgrade.rollbackGenerations, `${p}.upgrade.rollbackGenerations`, identifier)
  return manifest
}

export function assertReleaseCompatibility(manifest, { hostAbi, kernelVersion, seamDigest }) {
  validateReleaseManifest(manifest)
  check(hostAbi === manifest.host.abi, 'hostAbi', 'incompatible host ABI', 'unsupported_host_abi')
  check(kernelVersion === manifest.kernel.version && seamDigest === manifest.kernel.seamDigest, 'kernel', 'kernel or seam not tested for this release', 'unsupported_kernel')
  return true
}
