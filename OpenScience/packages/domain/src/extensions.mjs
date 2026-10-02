/** Hosted extension contracts. Inputs are content; native compatibility and loading stay in harness-port. */
import { canonicalJson } from './capsule.mjs'

/** @typedef {{kind:'npm',name:string,version:string}|{kind:'github',repository:string,commit:string,subdirectory?:string}} ExtensionCoordinate */
/** @typedef {{coordinate:ExtensionCoordinate,scope:'library'|'project',projectId?:string,idempotencyKey:string}} ExtensionInstallRequest */
/** @typedef {{expectedRevision:number,title:string,description:string,instructions:string}} SkillWriteRequest */
/** @typedef {{packageIntegrity:string,sourceCommit:string|null,adapterRevision:string,dshVersion:string,runtimeImageDigest:string,executionClass:string,permissionProfileRevision:string,suiteRevision:string}} ExtensionProofIdentity */

export const EXTENSION_EXECUTION_CLASSES = Object.freeze(['isolated-tool', 'restricted-viewer', 'personal-skill', 'managed-native', 'local-only'])
export const EXTENSION_EVIDENCE_STATES = Object.freeze(['discovered', 'source-assessed', 'runtime-verified', 'saas-qualified'])
export const EXTENSION_APPLY_PHASES = Object.freeze(['saved', 'preparing', 'waiting', 'applying', 'effective', 'connection-needed', 'unsupported', 'failed', 'rolled-back'])
export const EXTENSION_PRODUCT_KINDS = Object.freeze(['extension-installation', 'extension-generation', 'extension-proof', 'skill', 'extension-defaults'])
export const EXTENSION_JOB_KINDS = Object.freeze(['extension-prepare', 'personal-skill-apply'])
export const EXTENSION_SAAS_CASE_IDS = Object.freeze(Array.from({ length: 22 }, (_, i) => `SAAS-${String(i + 1).padStart(2, '0')}`))
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u
const IDENTITY_KEYS = ['packageIntegrity', 'sourceCommit', 'adapterRevision', 'dshVersion', 'runtimeImageDigest', 'executionClass', 'permissionProfileRevision', 'suiteRevision']

/** Errors name the failed boundary only; no submitted value or secret enters diagnostics. */
export class ExtensionContractError extends Error {
  /** @param {string} code @param {string} field */
  constructor(code, field) { super(`${code}: ${field}`); this.name = 'ExtensionContractError'; this.code = code; this.field = field }
}
/** @param {string} field @param {string} [code] @returns {never} */
function reject(field, code = 'extension_contract_invalid') { throw new ExtensionContractError(code, field) }
/** Canonical portable data paths for personal skill resources only. A caller
 * may supply its bounded prefix map to reject case/compatibility aliases.
 * Incoming archive names may normalize; stored manifests must already match path.
 * @param {unknown} value @param {Map<string,string>} [prefixes]
 * @returns {{path:string,key:string}} */
export function canonicalPersonalSkillResourcePath(value, prefixes) {
  if (typeof value !== 'string') reject('resourcePath')
  const normalized = value.normalize('NFC')
  const parts = normalized.split('/')
  const bytes = input => new TextEncoder().encode(input).length
  if (!normalized || bytes(normalized) > 240 || parts.length > 16
    || parts.some(part => bytes(part) > 101 || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]*$/u.test(part))) reject('resourcePath')
  const folded = input => input.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFC')
  for (const part of parts) {
    const protectedName = folded(part).normalize('NFD').replace(/\p{M}/gu, '')
    if (/^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|node_modules|\.git)$/u.test(protectedName)
      || /\.(?:pem|key|p12|pfx)$/u.test(protectedName)) reject('resourcePath')
  }
  const key = folded(normalized)
  if (prefixes) {
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/'), prefixKey = folded(prefix)
      if (prefixes.has(prefixKey) && prefixes.get(prefixKey) !== prefix) reject('resourcePathCollision')
    }
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/')
      prefixes.set(folded(prefix), prefix)
    }
  }
  return { path: normalized, key }
}

/** Closed data objects cannot carry authority, getters or prototype-defined settings. @param {unknown} value @param {string[]} allowed @param {string[]} required @returns {Record<string, any>} */
function record(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject('object')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || Object.values(descriptors).some(item => !Object.hasOwn(item, 'value') || !item.enumerable)
    || required.some(key => !Object.hasOwn(value, key))) reject('fields')
  return /** @type {Record<string, any>} */ (value)
}
/** @param {unknown} value @param {string} field @returns {string} */
function id(value, field) { if (typeof value !== 'string' || !ID.test(value)) reject(field); return value }
/** @param {unknown} value @param {string} field @returns {string} */
function digest(value, field) { if (typeof value !== 'string' || !DIGEST.test(value)) reject(field); return value }
/** @param {unknown} value @param {string} field @returns {number} */
function revision(value, field) { if (!Number.isSafeInteger(value) || Number(value) < 0) reject(field); return Number(value) }
/** @param {unknown} value @param {string} field @param {number} max @param {boolean} [empty] @returns {string} */
function text(value, field, max, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || new TextEncoder().encode(value).length > max || value.includes('\0')) reject(field)
  return value
}
/** @param {unknown} value @param {string} field @param {(value:any, field:string)=>string} validate @returns {string[]} */
function strings(value, field, validate = id) {
  dataArray(value, field, 256)
  const items = value.map(item => validate(item, field))
  if (new Set(items).size !== items.length) reject(field)
  return items.sort()
}
/** Arrays must be dense JSON data, not accessors or hidden state. @param {unknown} value @param {string} field @param {number} max @returns {asserts value is any[]} */
function dataArray(value, field, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) reject(field)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== value.length + 1 || Object.entries(descriptors).some(([key, item]) => key !== 'length'
    && (!/^\d+$/u.test(key) || !Object.hasOwn(item, 'value') || !item.enumerable))) reject(field)
}
/** Browser-safe hashing is supplied by the trusted caller; no crypto implementation is duplicated here. @param {unknown} value @param {(text:string)=>string} sha256Hex */
function hashed(value, sha256Hex) {
  let bytes
  try { bytes = canonicalJson(value) } catch { reject('canonical_json') }
  const output = sha256Hex(bytes)
  if (!SHA.test(output)) reject('hash')
  return `sha256:${output}`
}

/** Exact artifact coordinate only, not a replacement for native peer/semver validation. @param {unknown} value @returns {string} */
export function canonicalExtensionCoordinate(value) {
  const item = record(value, ['kind', 'name', 'version', 'repository', 'commit', 'subdirectory'], ['kind'])
  if (item.kind === 'npm') {
    record(item, ['kind', 'name', 'version'])
    if (typeof item.name !== 'string' || item.name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(item.name)
      || typeof item.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(item.version)) reject('coordinate')
    return `npm:${item.name}@${item.version}`
  }
  if (item.kind === 'github') {
    record(item, ['kind', 'repository', 'commit', 'subdirectory'], ['kind', 'repository', 'commit'])
    if (typeof item.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(item.repository)
      || typeof item.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(item.commit)) reject('coordinate')
    const subdir = item.subdirectory
    if (subdir !== undefined && (typeof subdir !== 'string' || !subdir || subdir.length > 200
      || subdir.split('/').some(part => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(part) || part === '.' || part === '..'))) reject('subdirectory')
    return `github:${item.repository.toLowerCase()}@${item.commit}${subdir === undefined ? '' : `#${subdir}`}`
  }
  return reject('coordinate_kind')
}

/** No principal, credential, proof or executable can be imported as installation authority. @param {unknown} value @returns {ExtensionInstallRequest} */
export function validateExtensionInstallRequest(value) {
  const item = record(value, ['coordinate', 'scope', 'projectId', 'idempotencyKey'], ['coordinate', 'scope', 'idempotencyKey'])
  canonicalExtensionCoordinate(item.coordinate)
  if (!['project', 'library'].includes(item.scope) || (item.scope === 'project') !== Object.hasOwn(item, 'projectId')) reject('scope')
  if (item.scope === 'project') id(item.projectId, 'projectId')
  id(item.idempotencyKey, 'idempotencyKey')
  return { coordinate: { ...item.coordinate }, scope: item.scope, idempotencyKey: item.idempotencyKey,
    ...(item.scope === 'project' ? { projectId: item.projectId } : {}) }
}

/** Explicit authored content; archive/frontmatter parsing remains the native provider's job. @param {unknown} value */
export function validateSkillWriteRequest(value) {
  const item = record(value, ['expectedRevision', 'title', 'description', 'instructions'])
  return { expectedRevision: revision(item.expectedRevision, 'expectedRevision'), title: text(item.title, 'title', 240),
    description: text(item.description, 'description', 2048, true), instructions: text(item.instructions, 'instructions', 262144) }
}

/** Stable native identity never derives from an editable display title. @param {string} ownerId @param {string} skillId @param {(text:string)=>string} sha256Hex */
export function personalSkillName(ownerId, skillId, sha256Hex) {
  id(ownerId, 'ownerId'); id(skillId, 'skillId')
  return `personal-${hashed(ownerId, sha256Hex).slice(7, 23)}-${hashed(skillId, sha256Hex).slice(7, 39)}`
}

/** Trusted server scope is separate from generation content. Never obtain expectedScope from a request body.
 * @param {unknown} value @param {{ownerId:string,projectId:string}} expectedScope @param {(text:string)=>string} sha256Hex */
export function extensionGenerationIdentity(value, expectedScope, sha256Hex) {
  const item = record(value, ['ownerId', 'projectId', 'baseRuntimeImageDigest', 'adapterRevision', 'permissionProfileRevision', 'selections', 'skills'])
  id(item.ownerId, 'ownerId'); id(item.projectId, 'projectId')
  if (item.ownerId !== expectedScope.ownerId || item.projectId !== expectedScope.projectId) reject('scope')
  for (const key of ['baseRuntimeImageDigest', 'adapterRevision', 'permissionProfileRevision']) digest(item[key], key)
  dataArray(item.selections, 'selections', 128)
  dataArray(item.skills, 'skills', 256)
  const selections = item.selections.map(selection => {
    const row = record(selection, ['extensionId', 'artifactDigest', 'configRevision', 'configDigest', 'connectionRefs'])
    return { extensionId: id(row.extensionId, 'extensionId'), artifactDigest: digest(row.artifactDigest, 'artifactDigest'),
      configRevision: revision(row.configRevision, 'configRevision'), configDigest: digest(row.configDigest, 'configDigest'),
      connectionRefs: strings(row.connectionRefs, 'connectionRefs') }
  }).sort((a, b) => a.extensionId < b.extensionId ? -1 : a.extensionId > b.extensionId ? 1 : 0)
  const skills = item.skills.map(skill => {
    const row = record(skill, ['skillId', 'revision', 'digest'])
    const version = revision(row.revision, 'revision'); if (version === 0) reject('skill_revision')
    return { skillId: id(row.skillId, 'skillId'), revision: version, digest: digest(row.digest, 'skill_digest') }
  }).sort((a, b) => a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0)
  if (new Set(selections.map(row => row.extensionId)).size !== selections.length || new Set(skills.map(row => row.skillId)).size !== skills.length) reject('duplicate_generation_entry')
  return hashed({ ...item, selections, skills }, sha256Hex)
}

/** A registry/private artifact may have no Git commit; its content integrity is always required. @param {unknown} value @returns {ExtensionProofIdentity} */
export function validateExtensionProofIdentity(value) {
  const item = record(value, IDENTITY_KEYS)
  for (const key of ['packageIntegrity', 'adapterRevision', 'runtimeImageDigest', 'permissionProfileRevision', 'suiteRevision']) digest(item[key], key)
  if ((item.sourceCommit !== null && (typeof item.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(item.sourceCommit))) || item.dshVersion !== '0.1.7-rc.2'
    || !EXTENSION_EXECUTION_CLASSES.includes(item.executionClass)) reject('proof_identity')
  return { packageIntegrity: item.packageIntegrity, sourceCommit: item.sourceCommit, adapterRevision: item.adapterRevision,
    dshVersion: item.dshVersion, runtimeImageDigest: item.runtimeImageDigest, executionClass: item.executionClass,
    permissionProfileRevision: item.permissionProfileRevision, suiteRevision: item.suiteRevision }
}

/** Binds the full externally observed outcome, not a package's self-health claim. @param {unknown} value @param {(text:string)=>string} sha256Hex */
export function extensionProofDigest(value, sha256Hex) {
  const proof = record(value, ['schemaVersion', 'identity', 'cases', 'receiptDigest'], ['schemaVersion', 'identity', 'cases'])
  if (proof.schemaVersion !== 1 || !Array.isArray(proof.cases) || proof.cases.length > 64) reject('proof_shape')
  validateExtensionProofIdentity(proof.identity)
  dataArray(proof.cases, 'cases', 64)
  const cases = proof.cases.map(outcome => {
    const row = record(outcome, ['caseId', 'status', 'observationDigests', 'artifactDigests', 'reason'], ['caseId', 'status', 'observationDigests', 'artifactDigests'])
    return { caseId: id(row.caseId, 'caseId'), status: text(row.status, 'status', 32),
      observationDigests: strings(row.observationDigests, 'observationDigests', digest), artifactDigests: strings(row.artifactDigests, 'artifactDigests', digest),
      ...(Object.hasOwn(row, 'reason') ? { reason: text(row.reason, 'reason', 4000, true) } : {}) }
  })
  return hashed({ schemaVersion: 1, identity: proof.identity, cases }, sha256Hex)
}

/** Pure verification against authority supplied ONLY by a trusted server/harness store.
 * Receipt hashes and surfaces must never come from a client, runtime, package or account import.
 * @param {unknown} value @param {unknown} currentIdentity
 * @param {{sha256Hex:(text:string)=>string,trustedReceiptDigests:ReadonlySet<string>,trustedSurfaces:{client:boolean,browser:boolean,externalActions:boolean,descriptorDigest:string}}} authority */
export function qualifyExtensionProof(value, currentIdentity, authority) {
  const proof = record(value, ['schemaVersion', 'identity', 'cases', 'receiptDigest'])
  const received = extensionProofDigest(proof, authority.sha256Hex)
  if (proof.receiptDigest !== received || !authority.trustedReceiptDigests.has(received)) reject('receipt', 'extension_proof_untrusted')
  const current = validateExtensionProofIdentity(currentIdentity)
  if (canonicalJson(proof.identity) !== canonicalJson(current)) reject('identity', 'extension_proof_stale')
  if (current.executionClass === 'local-only') reject('execution_class', 'extension_proof_incomplete')
  const surfaces = record(authority.trustedSurfaces, ['client', 'browser', 'externalActions', 'descriptorDigest'])
  if (['client', 'browser', 'externalActions'].some(key => typeof surfaces[key] !== 'boolean')) reject('surfaces')
  digest(surfaces.descriptorDigest, 'descriptorDigest')
  const seen = new Set()
  for (const outcome of proof.cases) {
    const row = record(outcome, ['caseId', 'status', 'observationDigests', 'artifactDigests', 'reason'], ['caseId', 'status', 'observationDigests', 'artifactDigests'])
    if (!EXTENSION_SAAS_CASE_IDS.includes(row.caseId) || seen.has(row.caseId)) reject('cases', 'extension_proof_incomplete')
    seen.add(row.caseId)
    const observations = strings(row.observationDigests, 'observationDigests', digest)
    strings(row.artifactDigests, 'artifactDigests', digest)
    if (!observations.length) reject('observations', 'extension_proof_incomplete')
    if (row.status === 'pass') continue
    const unreachable = (['SAAS-09', 'SAAS-10', 'SAAS-11'].includes(row.caseId) && !surfaces.client)
      || (row.caseId === 'SAAS-15' && !surfaces.browser) || (row.caseId === 'SAAS-20' && !surfaces.externalActions)
    if (row.status !== 'not-applicable' || !unreachable || !observations.includes(surfaces.descriptorDigest)
      || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 1000) reject('case_outcome', 'extension_proof_incomplete')
  }
  if (seen.size !== EXTENSION_SAAS_CASE_IDS.length) reject('missing_cases', 'extension_proof_incomplete')
  return { qualified: true, receiptDigest: received, identity: current }
}
