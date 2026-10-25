/** Attendance authority crosses a writable workspace as an Ed25519 signature.
 * Only the control plane receives the seed secret. Runtime consumers receive the public verifier alone. */
import { Buffer } from 'node:buffer'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

const DOMAIN = 'evimed-run-context-attendance-v1'
const SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
/** How many receipts one session's file keeps: a session's inputs are claimed within its next turn, so this bounds a queue, not a history. */
export const ATTENDANCE_RECEIPTS_KEPT = 32
const DIGEST = /^[a-f0-9]{64}$/
let lastIssuedAtMs = 0

/** @param {unknown} value @returns {Record<string, any>|null} */
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string,any>} */ (value) : null
}
/** @param {unknown} value @returns {string|null} */
function identity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? value : null
}
/** @param {string} signingSecret */
function privateKey(signingSecret) {
  if (typeof signingSecret !== 'string' || !signingSecret) throw new TypeError('Run-context signing requires a control-plane secret.')
  const seed = createHash('sha256').update(`${DOMAIN}\0${signingSecret}`).digest()
  return createPrivateKey({ key: Buffer.concat([SEED_PREFIX, seed]), type: 'pkcs8', format: 'der' })
}
/** @param {Record<string,any>} index @param {Record<string,any>} envelope */
function claimsOf(index, envelope) {
  const { userId, projectId, issuedAtMs } = envelope
  if (envelope.version !== 1 || !Number.isSafeInteger(index.protocol) || index.protocol <= 0
    || ![index.runId, index.sessionId, index.contextRevision, userId, projectId].every(value => identity(value) !== null)
    || (index.unattended !== undefined && typeof index.unattended !== 'boolean')
    || (index.inputDigest !== undefined && (typeof index.inputDigest !== 'string' || !DIGEST.test(index.inputDigest)))
    || !Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0) return null
  return { protocol: index.protocol, runId: String(index.runId), sessionId: String(index.sessionId), contextRevision: String(index.contextRevision),
    userId: String(userId), projectId: String(projectId), unattended: index.unattended === true, issuedAtMs: Number(issuedAtMs),
    inputDigest: typeof index.inputDigest === 'string' ? index.inputDigest : null }
}
/** Ordered fields survive JSONB/property-order changes without making unbound metadata authoritative.
 * @param {NonNullable<ReturnType<typeof claimsOf>>} claims */
function canonical(claims) {
  // The input digest is signed when the claim carries one, after the original fields: a receipt signed without it keeps its bytes,
  // and none can gain or lose a digest without breaking its signature.
  return Buffer.from(JSON.stringify([DOMAIN, claims.protocol, claims.runId, claims.sessionId, claims.contextRevision,
    claims.userId, claims.projectId, claims.unattended, claims.issuedAtMs, ...(claims.inputDigest ? [claims.inputDigest] : [])]), 'utf8')
}

/** The digest a receipt binds an input by: SHA-256 of the input's text as the kernel hands it to the runtime (`nativeInputText`).
 * @param {string} text @returns {string} */
export function attendanceInputDigest(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** One bounded receipts file per session, independent of optional learning or routing snapshots: it holds the signed receipts
 * of the session's latest inputs (at most `ATTENDANCE_RECEIPTS_KEPT`), so receipts never accumulate per request.
 * @param {string} sessionId @returns {string} */
export function attendanceReceiptsFileFor(sessionId) {
  if (!identity(sessionId)) throw new TypeError('Attendance receipts require a session identity.')
  const digest = createHash('sha256').update(JSON.stringify([sessionId])).digest('hex')
  return `.evimed-brief/attendance/${digest}.json`
}

/** The receipts file after one more signed receipt: an earlier receipt of the same request is replaced, the oldest fall off.
 * An unreadable or foreign file is replaced, never trusted.
 * @param {unknown} previous the parsed file, or null @param {Record<string,any>} receipt a signed index @returns {{sessionId:string,receipts:Record<string,any>[]}} */
export function appendAttendanceReceipt(previous, receipt) {
  const file = record(previous)
  const kept = file && file.sessionId === receipt.sessionId && Array.isArray(file.receipts)
    ? file.receipts.filter(item => record(item) && item.contextRevision !== receipt.contextRevision) : []
  return { sessionId: receipt.sessionId, receipts: [...kept, receipt].slice(-ATTENDANCE_RECEIPTS_KEPT) }
}

/** The receipt a session's file holds for one request, unverified, or null. @param {unknown} file @param {string} requestId */
export function attendanceReceiptFor(file, requestId) {
  const value = record(file)
  if (!value || !Array.isArray(value.receipts)) return null
  const receipts = value.receipts.slice(-ATTENDANCE_RECEIPTS_KEPT)
  for (let index = receipts.length - 1; index >= 0; index -= 1) if (record(receipts[index])?.contextRevision === requestId) return receipts[index]
  return null
}

/** @param {string} signingSecret @returns {string} Base64url DER SubjectPublicKeyInfo. */
export function runContextAuthorityPublicKey(signingSecret) {
  return createPublicKey(privateKey(signingSecret).export({ type: 'pkcs8', format: 'pem' })).export({ type: 'spki', format: 'der' }).toString('base64url')
}

/** The caller appends this envelope as index.attendanceAuthority before committing the index.
 * @param {Record<string,any>} index
 * @param {{signingSecret:string,userId:string,projectId:string,issuedAtMs?:number}} options */
export function signRunContextAuthority(index, { signingSecret, userId, projectId, issuedAtMs = undefined }) {
  const issued = issuedAtMs ?? Math.max(Date.now(), lastIssuedAtMs + 1)
  const envelope = { version: 1, userId, projectId, issuedAtMs: issued }
  const claims = claimsOf(index, envelope)
  if (!claims) throw new TypeError('Run-context attendance identity is incomplete or invalid.')
  const signature = sign(null, canonical(claims), privateKey(signingSecret)).toString('base64url')
  lastIssuedAtMs = Math.max(lastIssuedAtMs, issued)
  return { ...envelope, signature }
}

/** No unverified field may change attendance, including a field that would clear an existing restriction.
 * The caller retains the greatest accepted issuedAtMs to reject replayed older authority.
 * @param {unknown} value
 * @param {{publicKey:string,userId:string,projectId:string,sessionId:string}} expected
 * @returns {ReturnType<typeof claimsOf>} */
export function verifyRunContextAuthority(value, expected) {
  try {
    const index = record(value), envelope = record(index?.attendanceAuthority)
    if (!index || !envelope || !identity(expected.userId) || !identity(expected.projectId) || !identity(expected.sessionId)
      || envelope.userId !== expected.userId || envelope.projectId !== expected.projectId || index.sessionId !== expected.sessionId
      || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)
      || typeof expected.publicKey !== 'string' || !/^[A-Za-z0-9_-]+$/.test(expected.publicKey)) return null
    const claims = claimsOf(index, envelope)
    if (!claims) return null
    const keyBytes = Buffer.from(expected.publicKey, 'base64url')
    if (keyBytes.toString('base64url') !== expected.publicKey) return null
    const signature = Buffer.from(envelope.signature, 'base64url')
    if (signature.toString('base64url') !== envelope.signature) return null
    const key = createPublicKey({ key: keyBytes, type: 'spki', format: 'der' })
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, canonical(claims), key, signature)) return null
    return claims
  } catch { return null }
}
