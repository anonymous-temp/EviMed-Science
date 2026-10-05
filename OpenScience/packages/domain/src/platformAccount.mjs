/**
 * The platform's own publishing account (「EviMed 证据中心」, evidence-flywheel plan §5.1, B2).
 *
 * Hidden knowledge:
 *
 * - **Platform-published evidence used to hang off a person.** The official evidence zones were
 *   imported under whichever operator account the importer named, and the zone and card tables
 *   reference the account with ON DELETE CASCADE: deleting that operator would have deleted the
 *   platform's published evidence with it (plan §3.3). Content the platform publishes belongs to
 *   an account that is nobody's: it cannot sign in, cannot be registered, renamed into, deleted
 *   or exported, and so cannot be lost by anything a person does.
 * - **One id, written once.** The control-plane migration that makes the account
 *   (`controlPlaneDatabase.mjs`), the importer that moves the earlier zones to it, the usage
 *   ledger's internal project and every refusal read this constant. A second spelling is an
 *   account nobody refuses.
 * - **Its auth type is its own.** `platform` is not a kind of sign-in: no credential of any kind
 *   exists for it, and the account table's constraints (id and type imply each other, no
 *   password) say so where code cannot be forgotten.
 *
 * @module platformAccount
 */

/** The account every official zone, card and platform-programme row belongs to. */
export const PLATFORM_PUBLISHER_USER_ID = 'evimed-evidence-center'

/** What readers see as the publisher of an official zone. */
export const PLATFORM_PUBLISHER_NAME = 'EviMed 证据中心'

/** The `evimed_control.users.auth_type` of the platform account, and of no other. */
export const PLATFORM_ACCOUNT_AUTH_TYPE = 'platform'

/** @param {unknown} id @returns {boolean} whether `id` is the platform publisher account's id */
export function isPlatformAccountId(id) {
  return typeof id === 'string' && id.trim().toLowerCase() === PLATFORM_PUBLISHER_USER_ID
}

/**
 * Whether a display name would pass for the publisher's. A person who registers under that name
 * would be shown as 「EviMed 证据中心」 beside a zone's cards, so the name is the publisher's alone.
 * Compared the way a reader compares: compatibility-normalized, case-folded, whitespace removed.
 * @param {unknown} name @returns {boolean}
 */
export function isPlatformAccountName(name) {
  if (typeof name !== 'string') return false
  const fold = (/** @type {string} */ value) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  return fold(name) === fold(PLATFORM_PUBLISHER_NAME)
}
