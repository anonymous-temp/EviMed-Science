/**
 * The memory capsule's vocabulary and its portable container's schema.
 *
 * Hidden knowledge: what a capsule is, and what it is not.
 *
 * It is **context, never permission**. It shapes how work is done; it can never
 * loosen a contract, relax a safety rule, or reach a host the gateway would
 * not. That is why the methods it carries are text the model reads, and why
 * nothing in this module is consulted by the delivery gate.
 *
 * The container answers a narrower question honestly: "is a capsule just a JSON
 * anyone can read?" No — and the reason is worth stating, because the obvious
 * alternatives are both wrong. Encrypting it end to end would make the working
 * copy unsearchable, which is the whole product. Leaving it plain would mean a
 * backup leak is a capsule leak. So there are three forms: the working copy is
 * structured plaintext inside our boundary (and we say so rather than claiming
 * zero knowledge), the backup copy is encrypted under a per-capsule key, and
 * the portable copy is a signed, recipient-encrypted container whose *inner*
 * formats are open — Markdown and JSONL, with the methods directory being a
 * valid skill root. "Anyone can read it" is false; "anyone can understand it"
 * stays true.
 *
 * @module @evimed/domain/capsule
 */

/** Container format version. Readers accept N and N-1. */
export const CAPSULE_FORMAT_VERSION = '1.0'

/** The five layers a capsule holds. */
export const CAPSULE_LAYERS = Object.freeze(['sources', 'knowledge', 'profile', 'methods', 'episodes'])

/**
 * Kinds of fact a capsule records.
 *
 * `tension` is deliberate: a contradiction between two things a person believes
 * is a signal, not an error to be resolved away. Recording it lets a reply say
 * "you argue X in trials and Y in practice; this follows X" instead of silently
 * picking one.
 */
export const CAPSULE_FACT_KINDS = Object.freeze([
  'profile',
  'preference',
  'behavior',
  'project_fact',
  'analysis',
  'decision',
  'correction',
  'follow_up',
  'stance',
  'expertise',
  'method_preference',
  'writing_style',
  'tooling',
  'tension',
])

/** How a fact came to be known; it decides how much weight it carries. */
export const CAPSULE_FACT_ORIGINS = Object.freeze(['explicit', 'inferred', 'system'])

/** A fact's lifecycle. Retired facts are kept: "was true once" is a fact too. */
export const CAPSULE_FACT_STATES = Object.freeze(['candidate', 'approved', 'retired'])

/** What a share may contain. The default is the workstyle pack. */
export const CAPSULE_SHARE_SCOPES = Object.freeze(['workstyle', '+profile', '+knowledge', '+documents'])

/** How a received pack is activated. */
export const CAPSULE_ACTIVATION_MODES = Object.freeze(['own', 'guest', 'blend'])

/** Timeline event kinds. */
export const CAPSULE_TIMELINE_EVENT_TYPES = Object.freeze([
  'upload',
  'fact_added',
  'fact_retired',
  'method_created',
  'method_revised',
  'run',
  'reflection',
  'share',
  'deidentification',
  'signoff',
])

/**
 * Layers that never leave, whatever scope was chosen.
 *
 * Enforced server-side rather than in the sharing wizard: a rule that lives in
 * a UI is a rule that a second UI does not have.
 */
export const NEVER_SHARED_LAYERS = Object.freeze(['sources'])

/**
 * The container's declared payload entries, by scope.
 *
 * A workstyle pack is "how I work", which is why identity, current projects and
 * personal corrections are absent from the default: they are "who I am and what
 * I am doing", and sharing those was never what the sender meant.
 */
export const SHARE_SCOPE_ENTRIES = Object.freeze({
  workstyle: [
    'standards.jsonl',
    'methods/',
    'knowledge/claims.jsonl',
    'exemplars/',
    'lessons.jsonl',
    'timeline.jsonl',
    'provenance.json',
  ],
  '+profile': ['profile.md'],
  '+knowledge': ['knowledge/chunks.jsonl'],
  '+documents': ['documents/'],
})

/** The AEAD and key-agreement scheme the container uses. */
export const CAPSULE_ENCRYPTION_SCHEME = 'x25519-hkdf-sha256+aes-256-gcm'
export const CAPSULE_SIGNATURE_ALG = 'ed25519'

/** @typedef {{ path: string, sha256: string, bytes: number, mime: string, layer: string }} CapsuleEntry */

/**
 * @typedef {object} CapsuleManifest
 * @property {string} formatVersion
 * @property {string} capsuleId
 * @property {number} version
 * @property {string} createdAt
 * @property {{ userId: string, signingKeyId: string }} issuer
 * @property {readonly string[]} scope
 * @property {readonly string[]} layers
 * @property {string} [license]
 * @property {string} [attribution]
 * @property {readonly CapsuleEntry[]} entries
 * @property {string} merkleRoot
 * @property {string | null} prevManifestSha256
 * @property {{ scheme: string, recipients: readonly { encKeyId: string, ephemeralPub: string, wrappedPackKey: string }[] }} [encryption]
 * @property {{ alg: string, keyId: string, value: string }} [signature]
 */

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Validates a manifest's shape. Signature and digest verification need crypto
 * and a filesystem, so they live with the packer; this is the part a browser
 * can check before it offers to open anything.
 * @param {unknown} value
 * @returns {{ ok: boolean, manifest: CapsuleManifest | null, issues: { code: string, message: string }[] }}
 */
export function validateCapsuleManifest(value) {
  /** @type {{ code: string, message: string }[]} */
  const issues = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      manifest: null,
      issues: [{ code: 'capsule_manifest_invalid', message: 'manifest.json must be a JSON object.' }],
    }
  }
  const raw = /** @type {Record<string, any>} */ (value)
  const formatVersion = String(raw.formatVersion ?? '')
  const major = Number(formatVersion.split('.')[0])
  const currentMajor = Number(CAPSULE_FORMAT_VERSION.split('.')[0])
  // Readers accept N and N-1 so a sender on a newer build can still reach a
  // receiver who has not updated; anything older gets a migrator, not silence.
  if (!Number.isFinite(major) || major > currentMajor || major < currentMajor - 1) {
    issues.push({ code: 'capsule_format_unsupported', message: `unsupported container formatVersion "${formatVersion}".` })
  }
  if (!String(raw.capsuleId ?? '').trim()) {
    issues.push({ code: 'capsule_manifest_invalid', message: 'capsuleId is required.' })
  }
  if (!Number.isSafeInteger(raw.version) || raw.version < 1) {
    issues.push({ code: 'capsule_manifest_invalid', message: 'version must be a positive integer.' })
  }
  const issuer = raw.issuer && typeof raw.issuer === 'object' ? raw.issuer : {}
  if (!String(issuer.userId ?? '').trim() || !String(issuer.signingKeyId ?? '').trim()) {
    issues.push({ code: 'capsule_manifest_invalid', message: 'issuer must name a userId and a signingKeyId.' })
  }
  const scope = Array.isArray(raw.scope) ? raw.scope.map(String) : []
  for (const entry of scope) {
    if (!CAPSULE_SHARE_SCOPES.includes(/** @type {any} */ (entry))) {
      issues.push({ code: 'capsule_manifest_invalid', message: `unknown share scope "${entry}".` })
    }
  }
  if (!scope.includes('workstyle')) {
    issues.push({
      code: 'capsule_manifest_invalid',
      message: 'every share includes the workstyle pack; the additions are optional, it is not.',
    })
  }
  const entries = Array.isArray(raw.entries) ? raw.entries : []
  if (!entries.length) {
    issues.push({ code: 'capsule_manifest_invalid', message: 'a container with no entries carries nothing.' })
  }
  // Two entries naming the same path is not merely untidy: whichever one the
  // unpacker keeps is an implementation detail, so a signature covering both
  // does not say which content the recipient actually receives — the exact
  // ambiguity a duplicate ZIP entry has been used to smuggle content past a
  // verifier that checked a different entry than the one that landed on disk.
  const seenPaths = new Set()
  for (const entry of entries) {
    const record = entry && typeof entry === 'object' ? entry : {}
    const path = String(record.path ?? '')
    if (!path || path.includes('..') || path.startsWith('/')) {
      issues.push({ code: 'capsule_manifest_invalid', message: `entry path "${path}" must be relative and inside the container.` })
    } else if (seenPaths.has(path)) {
      issues.push({ code: 'capsule_manifest_invalid', message: `entry path "${path}" is listed more than once.` })
    } else {
      seenPaths.add(path)
    }
    if (!SHA256_PATTERN.test(String(record.sha256 ?? ''))) {
      issues.push({ code: 'capsule_manifest_invalid', message: `entry "${path}" has no plaintext digest.` })
    }
    if (NEVER_SHARED_LAYERS.includes(String(record.layer ?? ''))) {
      issues.push({ code: 'capsule_restricted_content', message: `entry "${path}" is from the ${record.layer} layer, which never leaves.` })
    }
  }
  if (!SHA256_PATTERN.test(String(raw.merkleRoot ?? ''))) {
    issues.push({
      code: 'capsule_manifest_invalid',
      message: 'merkleRoot is required: it is what makes a one-byte change detectable.',
    })
  }
  if (raw.prevManifestSha256 != null && !SHA256_PATTERN.test(String(raw.prevManifestSha256))) {
    issues.push({ code: 'capsule_manifest_invalid', message: 'prevManifestSha256 must be a digest or null.' })
  }
  if (raw.encryption != null) {
    const encryption = raw.encryption && typeof raw.encryption === 'object' ? raw.encryption : {}
    if (encryption.scheme !== CAPSULE_ENCRYPTION_SCHEME) {
      issues.push({ code: 'capsule_manifest_invalid', message: `unsupported encryption scheme "${encryption.scheme}".` })
    }
    const recipients = Array.isArray(encryption.recipients) ? encryption.recipients : []
    if (!recipients.length) {
      issues.push({ code: 'capsule_manifest_invalid', message: 'an encrypted container must list at least one recipient.' })
    }
    for (const recipient of recipients) {
      const record = recipient && typeof recipient === 'object' ? recipient : {}
      if (
        !String(record.encKeyId ?? '').trim()
        || !BASE64_PATTERN.test(String(record.ephemeralPub ?? ''))
        || !BASE64_PATTERN.test(String(record.wrappedPackKey ?? ''))
      ) {
        issues.push({
          code: 'capsule_manifest_invalid',
          message: 'each recipient needs a key id, an ephemeral public key and a wrapped pack key.',
        })
      }
    }
  }
  if (raw.signature != null) {
    const signature = raw.signature && typeof raw.signature === 'object' ? raw.signature : {}
    if (signature.alg !== CAPSULE_SIGNATURE_ALG) {
      issues.push({ code: 'capsule_manifest_invalid', message: `unsupported signature algorithm "${signature.alg}".` })
    }
    if (!BASE64_PATTERN.test(String(signature.value ?? ''))) {
      issues.push({ code: 'capsule_manifest_invalid', message: 'signature value must be base64.' })
    }
  }
  return { ok: issues.length === 0, manifest: /** @type {any} */ (raw), issues }
}

/**
 * Canonical JSON, per RFC 8785.
 *
 * A signature is over bytes, and two serializations of the same object are two
 * different byte strings, so "sign the manifest" is meaningless without one
 * canonical form. Key order is lexicographic, which is what the RFC specifies
 * and what a default sort produces.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot represent a non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value)
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new TypeError(`canonical JSON cannot represent ${typeof value}`)
}

/**
 * The bytes a manifest's signature covers: everything but the signature itself.
 * @param {CapsuleManifest} manifest
 * @returns {string}
 */
export function signablePayload(manifest) {
  const { signature: _signature, ...rest } = /** @type {Record<string, any>} */ (manifest)
  return canonicalJson(rest)
}

/**
 * The Merkle root over the entries' plaintext digests.
 *
 * A flat list of digests would already detect a changed file. The tree is what
 * lets a receiver verify one entry without holding all of them, which is what a
 * partial download or a selective re-share needs.
 *
 * @param {readonly CapsuleEntry[]} entries
 * @param {(input: string) => string} sha256Hex
 * @returns {string}
 */
export function merkleRoot(entries, sha256Hex) {
  const leaves = [...entries]
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((entry) => sha256Hex(`${entry.path} ${entry.sha256}`))
  if (!leaves.length) return sha256Hex('')
  let level = leaves
  while (level.length > 1) {
    /** @type {string[]} */
    const next = []
    for (let index = 0; index < level.length; index += 2) {
      // An odd node is carried up rather than duplicated: duplicating it makes
      // two different trees share a root, which is a known Merkle pitfall.
      next.push(index + 1 < level.length ? sha256Hex(level[index] + level[index + 1]) : level[index])
    }
    level = next
  }
  return level[0]
}

/**
 * What the container's README says. Plain text, because the first thing someone
 * does with an unfamiliar file is open it in whatever they have.
 * @param {CapsuleManifest} manifest
 * @returns {string}
 */
export function containerReadme(manifest) {
  const lines = [
    'EviMed 记忆胶囊容器（.evimedcap）',
    '',
    `格式版本：${manifest.formatVersion}`,
    `胶囊：${manifest.capsuleId} 第 ${manifest.version} 版`,
    `签发：${manifest.issuer.userId}（签名密钥 ${manifest.issuer.signingKeyId}）`,
    `范围：${manifest.scope.join('、')}`,
    '',
    'manifest.json 是明文，其余内容在 payload/ 下，按 manifest 里列出的路径逐个存放。',
    manifest.encryption
      ? '内容已加密：包密钥按接收者用 X25519 封装，只有 manifest 里列出的接收者能解开。'
      : '内容未加密：这是一个自用导出包，仍然带签名。',
    '',
    '解开之后里面是开放格式：Markdown 与 JSONL。methods/ 目录本身就是一个合法的技能根，',
    '放进任何采用 Agent Skills 标准的工具里即刻可用。',
    '',
    '这个包是一个快照。它记录了发出者当时的工作方式，不会随对方的后续修改而变化。',
  ]
  return lines.join('\n')
}
