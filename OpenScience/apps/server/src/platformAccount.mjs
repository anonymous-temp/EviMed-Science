import { PLATFORM_ACCOUNT_AUTH_TYPE, PLATFORM_PUBLISHER_USER_ID, isPlatformAccountId, isPlatformAccountName } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/**
 * The platform's own publishing account (`@evimed/domain` platformAccount.mjs, evidence-flywheel B2,
 * 2026-10-05) belongs to no person: no credential reaches it and nothing a person does may touch it.
 *
 * The refusals live in one place so that no route, store or export can reach it by a path nobody listed:
 * the stores check them at sign-in, registration, external identity and deletion (`store.mjs`), the
 * account routes at export and deletion, and the integration-key route when a key resolves to it.
 *
 * @module platformAccount
 */

export { PLATFORM_PUBLISHER_USER_ID };

/** @param {{ id?: unknown, authType?: unknown } | null | undefined} user @returns {boolean} */
export function isPlatformAccount(user) {
  return Boolean(user) && (user?.authType === PLATFORM_ACCOUNT_AUTH_TYPE || isPlatformAccountId(user?.id));
}

/** What no one may do as, or to, the platform account: sign in as it, delete it, export it. */
export function platformAccountProtected() {
  return new HttpError(403, "platform_account_protected", "This is the platform's publishing account; it cannot be signed in to, deleted or exported.");
}

/** What no one may become: register its id or its display name. */
export function platformAccountReserved() {
  return new HttpError(409, "platform_account_reserved", "This account name is reserved for the platform's publishing account.");
}

/** @param {{ id?: unknown, authType?: unknown } | null | undefined} user */
export function assertNotPlatformAccount(user) {
  if (isPlatformAccount(user)) throw platformAccountProtected();
}

/** Whether a name or an id a person typed would pass for the publisher's: refused at registration.
 *  @param {unknown} id @param {unknown} name @returns {boolean} */
export function isReservedAccountIdentity(id, name) {
  return isPlatformAccountId(id) || isPlatformAccountName(name);
}

/** The display name an external identity is kept under: the identity provider's own, unless it is the publisher's.
 *  @param {unknown} name @returns {string} */
export function externalDisplayName(name) {
  const named = typeof name === "string" && name.trim() ? name.trim().slice(0, 128) : "EviMed User";
  return isPlatformAccountName(named) ? "EviMed User" : named;
}
