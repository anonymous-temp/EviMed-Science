/**
 * `delivery-receipt.json` — the proof of what was delivered.
 *
 * Hidden knowledge: what makes a receipt worth trusting. Three things. It is
 * written by exactly one caller (`evimed_submit_deliverable`) and the path
 * guard makes it unwritable by anyone else; it carries the sha256 of every file
 * it names, so the control plane can prove the artifacts it fetched are the
 * artifacts that were graded; and it carries the bundle and domain versions, so
 * a package graded by a different rule set than the one the image declares
 * fails loudly instead of passing quietly.
 */

/** Receipt format version. Appears in every receipt; readers accept N-1. */
export const RECEIPT_FORMAT_VERSION = 1

/**
 * @typedef {object} ReceiptFile
 * @property {string} path
 * @property {string} sha256
 * @property {number} bytes
 */

/**
 * @typedef {object} DeliveryReceiptEntry
 * @property {string} deliverableId
 * @property {string} contractKind
 * @property {string} capability
 * @property {readonly ReceiptFile[]} files
 * @property {string} acceptedAt
 * @property {number} attempt
 * @property {readonly string[]} notices
 */

/**
 * @typedef {object} DeliveryReceipt
 * @property {number} formatVersion
 * @property {string} runId
 * @property {string} bundleVersion
 * @property {string} domainVersion
 * @property {readonly DeliveryReceiptEntry[]} entries
 */

const SHA256_PATTERN = /^[0-9a-f]{64}$/

/**
 * @param {unknown} value
 * @returns {{ ok: boolean, receipt: DeliveryReceipt | null, issues: { code: string, message: string }[] }}
 */
export function validateDeliveryReceipt(value) {
  /** @type {{ code: string, message: string }[]} */
  const issues = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, receipt: null, issues: [{ code: 'receipt_invalid', message: 'delivery-receipt.json must be a JSON object.' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  const formatVersion = Number(raw.formatVersion ?? 0)
  if (formatVersion !== RECEIPT_FORMAT_VERSION && formatVersion !== RECEIPT_FORMAT_VERSION - 1) {
    issues.push({ code: 'receipt_invalid', message: `unsupported receipt formatVersion ${formatVersion}.` })
  }
  const runId = String(raw.runId ?? '').trim()
  if (!runId) issues.push({ code: 'receipt_invalid', message: 'receipt must name its runId.' })
  const bundleVersion = String(raw.bundleVersion ?? '').trim()
  const domainVersion = String(raw.domainVersion ?? '').trim()
  if (!bundleVersion) issues.push({ code: 'receipt_invalid', message: 'receipt must name the bundle version.' })
  if (!domainVersion) issues.push({ code: 'receipt_invalid', message: 'receipt must name the domain version.' })
  const rawEntries = Array.isArray(raw.entries) ? raw.entries : []
  /** @type {DeliveryReceiptEntry[]} */
  const entries = []
  for (const item of rawEntries) {
    if (!item || typeof item !== 'object') {
      issues.push({ code: 'receipt_invalid', message: 'each receipt entry must be an object.' })
      continue
    }
    const entry = /** @type {Record<string, unknown>} */ (item)
    const deliverableId = String(entry.deliverableId ?? '').trim()
    if (!deliverableId) {
      issues.push({ code: 'receipt_invalid', message: 'each receipt entry must name its deliverableId.' })
      continue
    }
    const files = Array.isArray(entry.files) ? entry.files : []
    /** @type {ReceiptFile[]} */
    const normalizedFiles = []
    for (const file of files) {
      const record = /** @type {Record<string, unknown>} */ (file ?? {})
      const path = String(record.path ?? '').trim()
      const sha256 = String(record.sha256 ?? '').trim().toLowerCase()
      const bytes = Number(record.bytes ?? -1)
      if (!path || !SHA256_PATTERN.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 0) {
        issues.push({ code: 'receipt_invalid', message: `receipt entry "${deliverableId}" has a malformed file record.` })
        continue
      }
      normalizedFiles.push({ path, sha256, bytes })
    }
    if (!normalizedFiles.length) {
      issues.push({ code: 'receipt_invalid', message: `receipt entry "${deliverableId}" names no files.` })
    }
    entries.push({
      deliverableId,
      contractKind: String(entry.contractKind ?? '').trim(),
      capability: String(entry.capability ?? '').trim(),
      files: Object.freeze(normalizedFiles),
      acceptedAt: String(entry.acceptedAt ?? '').trim(),
      attempt: Number(entry.attempt ?? 1),
      notices: Object.freeze(Array.isArray(entry.notices) ? entry.notices.map((n) => String(n)) : []),
    })
  }
  if (!entries.length) issues.push({ code: 'receipt_invalid', message: 'receipt names no deliverables.' })
  /** @type {DeliveryReceipt} */
  const receipt = {
    formatVersion: RECEIPT_FORMAT_VERSION,
    runId,
    bundleVersion,
    domainVersion,
    entries: Object.freeze(entries),
  }
  return { ok: issues.length === 0, receipt, issues }
}

/**
 * The version check §8.2 point 2 demands: a receipt graded by a different rule
 * set than the image declares is not a receipt, it is an unrelated document.
 * @param {DeliveryReceipt} receipt
 * @param {{ bundleVersion: string, domainVersion: string }} expected
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
export function checkReceiptVersions(receipt, expected) {
  if (receipt.bundleVersion !== expected.bundleVersion) {
    return {
      ok: false,
      code: 'runtime_bundle_version_mismatch',
      message: `receipt bundle ${receipt.bundleVersion} != image ${expected.bundleVersion}`,
    }
  }
  if (receipt.domainVersion !== expected.domainVersion) {
    return {
      ok: false,
      code: 'runtime_domain_version_mismatch',
      message: `receipt domain ${receipt.domainVersion} != image ${expected.domainVersion}`,
    }
  }
  return { ok: true }
}
