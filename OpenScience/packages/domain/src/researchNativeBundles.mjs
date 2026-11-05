import { canonicalExtensionCoordinate } from './extensions.mjs'
import { canonicalJson } from './capsule.mjs'

const methods = ['describe', 'start', 'read', 'cancel', 'report']
/** The only native research bundles the hosted deployment may admit. */
export const RESEARCH_NATIVE_BUNDLES = Object.freeze(Object.fromEntries([
  ['virtual-trial', 'virtual_trial'], ['virtual-cohort', 'virtual_cohort'],
  ['virtual-patient', 'virtual_patient'], ['synthetic-control', 'synthetic_control'],
  ['virtual-research-suite', null],
].map(([id, prefix]) => [id, Object.freeze({
  name: `@evimed/${id}`, row: `evimed-${id}`,
  tools: Object.freeze(prefix ? methods.map(method => `${prefix}_${method}`) : ['virtual_research_available']),
})])))
const DIGEST = /^sha256:[a-f0-9]{64}$/u
/** Validate a receipt's complete content before hashing it. Hash is injected to keep domain browser-safe.
 * @param {any} receipt @param {(value:string)=>string} digest */
export function researchNativeReceiptDigest(receipt, digest) {
  const spec = RESEARCH_NATIVE_BUNDLES[receipt?.id]
  if (!spec || Object.keys(receipt).sort().join(',') !== 'closureDigest,coordinate,id,integrity,row,schemaVersion,tools' ||
      receipt.schemaVersion !== 1 || receipt.coordinate?.kind !== 'npm' || receipt.coordinate.name !== spec.name ||
      receipt.coordinate.version !== '0.1.0' || receipt.row !== spec.row ||
      canonicalJson(receipt.tools) !== canonicalJson(spec.tools) || !DIGEST.test(receipt.integrity) || !DIGEST.test(receipt.closureDigest)) throw new Error('extension_contract_invalid')
  canonicalExtensionCoordinate(receipt.coordinate)
  return digest(canonicalJson(receipt))
}
/** Bind artifact to the approved receipt and adapter revision.
 * @param {any} bundle @param {(value:string)=>string} digest */
export function researchNativeArtifactDigest(bundle, digest) {
  return digest(canonicalJson({ receiptDigest: bundle.receiptDigest, adapterRevision: bundle.adapterRevision }))
}

/** A generation row names only a fixed native package, never a caller-supplied path.
 * @param {any} row */
export function nativeResearchToolProfileHolds(row) {
  const spec = RESEARCH_NATIVE_BUNDLES[row?.extensionId]
  if (!spec || row.executionClass !== 'managed-native' || row.coordinate?.kind !== 'npm' ||
      row.coordinate.name !== spec.name || row.coordinate.version !== '0.1.0' ||
      !DIGEST.test(row.integrity ?? '') || !DIGEST.test(row.artifactDigest ?? '') || typeof row.enabled !== 'boolean' ||
      !row.settings || typeof row.settings !== 'object' || Array.isArray(row.settings) || Object.keys(row.settings).length !== 0 ||
      !Array.isArray(row.connectionRefs) || row.connectionRefs.length !== 0) return false
  try { canonicalExtensionCoordinate(row.coordinate); return true } catch { return false }
}
/** The deployment descriptor is protected and validated independently by extensionDeployment.
 * @param {any} row @param {any} descriptor */
export function nativeResearchRowIsAdmitted(row, descriptor) {
  if (!nativeResearchToolProfileHolds(row) || !descriptor || descriptor.id !== row.extensionId ||
      descriptor.integrity !== row.integrity || descriptor.artifactDigest !== row.artifactDigest) return false
  try { return canonicalExtensionCoordinate(descriptor.coordinate) === canonicalExtensionCoordinate(row.coordinate) } catch { return false }
}
