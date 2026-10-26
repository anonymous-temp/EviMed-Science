import { createHash, createPublicKey, KeyObject, verify } from 'node:crypto'
import { RSI_CAMPAIGN_SURFACES, rsiCompatibilityIssues } from '../../../packages/domain/src/rsiCampaign.mjs'

const MAX_BYTES = 2 * 1024 * 1024
// In unicode mode a surrogate pair is one astral code point, so this matches unpaired surrogates only.
const LONE_SURROGATE = /\p{Cs}/u
/** RFC 8785 (JCS), byte-compatible with Python rfc8785 0.1.4: keys sorted by UTF-16 code units (the default sort),
 * ECMAScript number and string serialization. Values JCS cannot represent are refused, never coerced: non-finite
 * numbers, integral values outside +-(2^53-1) and unpaired UTF-16 surrogates in strings or keys throw a TypeError;
 * values JSON would silently discard throw too. @param {any} value @returns {string} */
export function canonicalRsiJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') { if (LONE_SURROGATE.test(value)) throw new TypeError('campaign_json_invalid'); return JSON.stringify(value) }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw new TypeError('campaign_json_invalid')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${Array.from(value, canonicalRsiJson).join(',')}]`
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('campaign_json_invalid')
  const keys = Object.keys(value).sort()
  if (keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('campaign_json_invalid')
  if (keys.some(key => LONE_SURROGATE.test(key))) throw new TypeError('campaign_json_invalid')
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalRsiJson(value[key])}`).join(',')}}`
}
/** @param {any} value */
export const rsiDigest = value => createHash('sha256').update(canonicalRsiJson(value)).digest('hex')
/** @param {any} files */
function boundedFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 64) throw new Error('campaign_files_invalid')
  const paths = new Set(); let bytes = 0
  for (const file of files) {
    if (!file || Object.keys(file).sort().join(',') !== 'content,path' || typeof file.path !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]{0,239}$/.test(file.path) || file.path.split('/').some(/** @param {string} part */ part => !part || part === '.' || part === '..') || typeof file.content !== 'string' || paths.has(file.path)) throw new Error('campaign_files_invalid')
    if (Buffer.from(file.content).toString('utf8') !== file.content) throw new Error('campaign_utf8_invalid')
    paths.add(file.path); bytes += Buffer.byteLength(file.content)
    if (bytes > MAX_BYTES) throw new Error('campaign_files_too_large')
  }
  return [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'))
}
/** Signer is injected (local ephemeral test key or deployment KMS); this module stores no private keys.
 * @param {{manifest:any,files:any,keyId:string,signer:(bytes:Buffer)=>any}} input */
export async function signRsiCampaignBundle({ manifest, files, keyId, signer }) {
  if (!manifest || typeof manifest !== 'object') throw new Error('campaign_manifest_invalid')
  const ordered = boundedFiles(files)
  const payload = canonicalRsiJson({ manifest, files: ordered, contentHashes: ordered.map(file => ({ path: file.path, sha256: createHash('sha256').update(file.content).digest('hex') })) })
  if (Buffer.byteLength(payload) > MAX_BYTES * 2) throw new Error('campaign_bundle_too_large')
  return { schemaVersion: 1, keyId, payload, signature: Buffer.from(await signer(Buffer.from(`evimed-rsi-bundle-v1\n${keyId}\n${payload}`))).toString('base64') }
}
/** No attacker-controlled manifest fields are used before signature verification. expectedIdentity and replay state are deployment-owned.
 * qualification.verifyReceipt must authenticate independent evaluator evidence, not a candidate flag.
 * @param {any} envelope @param {any} options */
export async function verifyRsiCampaignBundle(envelope, options) {
  /** @param {string[]} issues */
  const fail = issues => ({ ok: false, issues, bundleDigest: null, manifest: null, files: null })
  try {
    if (!envelope || envelope.schemaVersion !== 1 || typeof envelope.keyId !== 'string' || envelope.keyId.length > 160 || typeof envelope.payload !== 'string' || Buffer.byteLength(envelope.payload) > MAX_BYTES * 2 || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) return fail(['campaign_envelope_invalid'])
    const authority = Object.hasOwn(options.trustStore ?? {}, envelope.keyId) ? options.trustStore[envelope.keyId] : null
    if (!authority) return fail(['campaign_signer_unknown'])
    const publicKey = authority.publicKey instanceof KeyObject ? authority.publicKey : createPublicKey(authority.publicKey)
    if (publicKey.asymmetricKeyType !== 'ed25519') return fail(['campaign_signer_algorithm_invalid'])
    if (!verify(null, Buffer.from(`evimed-rsi-bundle-v1\n${envelope.keyId}\n${envelope.payload}`), publicKey, Buffer.from(envelope.signature, 'base64'))) return fail(['campaign_signature_invalid'])
    const data = JSON.parse(envelope.payload)
    if (canonicalRsiJson(data) !== envelope.payload) return fail(['campaign_canonical_invalid'])
    const { manifest: m, contentHashes } = data
    const files = boundedFiles(data.files)
    if (canonicalRsiJson(files) !== canonicalRsiJson(data.files) || canonicalRsiJson(contentHashes) !== canonicalRsiJson(files.map(file => ({ path: file.path, sha256: createHash('sha256').update(file.content).digest('hex') })))) return fail(['campaign_content_invalid'])
    if (!m || !Object.hasOwn(RSI_CAMPAIGN_SURFACES, m.surface ?? '') || RSI_CAMPAIGN_SURFACES[/** @type {keyof typeof RSI_CAMPAIGN_SURFACES} */ (m.surface)].kind !== m.kind || !authority.surfaces?.includes(m.surface) || !authority.kinds?.includes(m.kind)) return fail(['campaign_surface_forbidden'])
    const zoned = /T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
    const now = Date.parse(options.now ?? new Date().toISOString())
    if (![m.createdAt, m.expiresAt].every(value => typeof value === 'string' && zoned.test(value) && Number.isFinite(Date.parse(value))) || !Number.isFinite(now) || Date.parse(m.createdAt) > now || Date.parse(m.expiresAt) <= now || Date.parse(m.expiresAt) <= Date.parse(m.createdAt)) return fail(['campaign_bundle_expired'])
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(m.id) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(m.campaignId) || m.id !== options.expectedIdentity?.id || m.campaignId !== options.expectedIdentity?.campaignId || options.seenIds?.has(m.id) || options.seenCampaignIds?.has(m.campaignId)) return fail(['campaign_replay_identity_invalid'])
    const compatibility = rsiCompatibilityIssues(m.target, options.currentTarget)
    if (m.target?.surface !== m.surface) compatibility.push('campaign_surface_changed')
    if (compatibility.length) return fail(compatibility)
    const q = options.qualification; const v = m.verdict
    const hashes = ['candidateDigest', 'registrationDigest', 'datasetDigest', 'measurementDigest', 'consumerDigest', 'evaluatorDigest', 'procedureDigest', 'qualificationDigest', 'corpusDigest']
    if (!q || !v || v.status !== 'qualified' || hashes.some(key => !/^[a-f0-9]{64}$/.test(v[key] ?? '')) || v.candidateDigest !== rsiDigest(files) || v.scope !== m.surface || ['registrationDigest', 'datasetDigest', 'measurementDigest', 'consumerDigest', 'evaluatorDigest', 'procedureDigest', 'qualificationDigest', 'corpusDigest', 'scope'].some(key => v[key] !== q[key]) || typeof q.verifyReceipt !== 'function' || await q.verifyReceipt({ verdict: v, manifest: m, candidateDigest: rsiDigest(files) }) !== true) return fail(['campaign_qualification_untrusted'])
    return { ok: true, issues: [], bundleDigest: rsiDigest(data), manifest: m, files, contentHashes }
  } catch { return fail(['campaign_bundle_invalid']) }
}
