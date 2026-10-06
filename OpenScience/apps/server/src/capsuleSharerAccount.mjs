/**
 * A pack's sharer, as the account that received it may read it (flywheel review 2026-10-06).
 *
 * Hidden knowledge:
 *
 * - **The sharer's account id is kept, and kept private.** Importing a pack writes `authorId` (the sharer's account) under the new
 *   capsule's `transfer` and under `share` on the capsule and on every fact it brought: the take-down by author and the corroboration
 *   count both match on it (`capsuleTransferService.mjs`, `capsuleShareTrust.mjs`). The id of a local account is its login name, so it
 *   is not something the recipient is told; they are told the sharer's display name (`authorName`), which is what 「来自 … 的分享」 shows.
 * - **One funnel.** Every capsule route answers through `capsuleRoutes.mjs`'s one `reply`, so the id is dropped there, from every
 *   record that carries it, old rows included — a row written before this rule is not rewritten.
 *
 * @module capsuleSharerAccount
 */

/** The objects under which `authorId` names the sharer's account. */
const SHARER_PARENTS = new Set(["transfer", "share"]);

/**
 * The same value with every sharer account id left out.
 * @param {unknown} value @param {string} [parent] the key the value sits under
 * @returns {any}
 */
export function withoutSharerAccount(value, parent = "") {
  if (Array.isArray(value)) return value.map((entry) => withoutSharerAccount(entry, parent));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "authorId" && SHARER_PARENTS.has(parent)) continue;
    out[key] = withoutSharerAccount(inner, key);
  }
  return out;
}
