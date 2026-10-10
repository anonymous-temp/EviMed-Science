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
 *   record that carries it, old rows included — a row written before this rule is not rewritten. The account archive is the other
 *   way these rows leave, and it drops the id the same way (`receivedPackForExport`).
 *
 * @module capsuleSharerAccount
 */

import { senderDisplayName } from "./capsuleShareLabel.mjs";

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

/**
 * A received pack's capsule, or one of its entries, as the account's own archive carries it (review C-9). The archive used to
 * carry these rows as stored, with the sharer's account id on them, which is their login name: the recipient who exported their
 * account was handed the login name of everyone who had shared with them. The id is dropped, as in every answer of the capsule
 * routes, and the name that stands for the sharer is the one the app shows (`senderDisplayName`): the display name the pack was
 * signed with, or the neutral label when that was their login name or held an address — the id is read for that comparison,
 * and then it is gone. A record that is not a received pack's is returned as it is.
 * @param {any} payload
 */
export function receivedPackForExport(payload) {
  if (!payload?.share && !payload?.transfer) return payload;
  const authorId = payload.share?.authorId ?? payload.transfer?.authorId ?? null;
  const clean = withoutSharerAccount(payload);
  /** @param {unknown} name */
  const shown = (name) => (typeof name === "string" && name.trim() ? senderDisplayName(name, authorId) : name);
  if (clean.share && Object.hasOwn(clean.share, "authorName")) clean.share = { ...clean.share, authorName: shown(clean.share.authorName) };
  if (clean.card && Object.hasOwn(clean.card, "author")) clean.card = { ...clean.card, author: shown(clean.card.author) };
  return clean;
}

/**
 * A snapshot the account sent, as its archive carries it: the accounts it was sealed for are counted, not named. The ids are
 * login names the sender may have reached only by a display name, and the app's own view of a snapshot has always shown the
 * count (`recipientCount`) and not the ids. Any other record is returned as it is.
 * @param {any} payload
 */
export function sentSnapshotForExport(payload) {
  if (payload?.recordType !== "capsule-snapshot" || !Array.isArray(payload.recipients)) return payload;
  const { recipients, ...rest } = payload;
  return { ...rest, recipientCount: recipients.length };
}
