/**
 * The bundle's hash, in one place.
 *
 * Hidden knowledge: WebCrypto rather than `node:crypto`, and that is not a
 * style choice — the consistency suite refuses any `node:` import under
 * `plugins/` and `src/`, because a plugin that reaches a builtin directly stops
 * loading the moment the kernel runs it somewhere that is not Node. `crypto.subtle`
 * is present in every runtime we target.
 *
 * It moved out of `run-policy.mjs` when a second caller appeared. Three places
 * now compute the digest of a skill body — the capsule mount that registers a
 * method, the delegation receipt that records what was injected, and the
 * control plane that counts uses against `(method, contentDigest)` — and if any
 * two disagreed, a method would reset its own usage counters on every run and
 * could never cross the threshold that earns it an evaluation. The hash
 * function differs between the control plane and here; what may not differ is
 * what is fed to it, which is why the normalisation comes from
 * `@evimed/domain`.
 *
 * @module @evimed/dsh-socket/src/digest
 */

import { normalizeSkillBody } from '@evimed/domain'

/**
 * @param {string} text
 * @returns {Promise<string>} lower-case hex
 */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The digest of a skill or method body, in the form the ledger stores.
 * @param {string} body
 * @returns {Promise<string>}
 */
export async function skillBodyDigestAsync(body) {
  return `sha256:${await sha256Hex(normalizeSkillBody(body))}`
}
