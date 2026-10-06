/**
 * Where the public evidence pages are served (flywheel review 2026-10-06, `OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH`).
 *
 * Hidden knowledge:
 *
 * - **The plan fixes `/evidence/…` for the eventual domain; the test server cannot have it.** On its numeric address `/evidence/`
 *   belongs to another product (its nginx sends it elsewhere), so a deployment may serve the pages, their API, the sitemap, the
 *   stylesheet and the feed under `/evimed-evidence/…` instead. The choice is a closed set (`EVIDENCE_PUBLIC_BASE_PATHS` in the
 *   domain, which the lever is validated against and which rule 2's recogniser reads), never a free path: a free path would be an
 *   input-side wall nobody could keep a recogniser for.
 * - **One owner.** Every address the pages, the API, the sitemap, the feed and the feed's absolute card addresses write or answer is
 *   made here, so nothing holds a literal `/evidence/`. The base is set once, from the config, when the app is composed
 *   (`createWebApiApp`), and read at each use; unset it is `/evidence`, which is what every deployment before the lever served.
 * - **Only the configured base is answered.** The other member of the set is not this deployment's to answer: a request under it is
 *   not claimed by the routers and falls through like any unknown path.
 *
 * @module evidencePublicPaths
 */

import { EVIDENCE_PUBLIC_BASE_PATHS } from "@evimed/domain";

/** @type {string} */
let base = EVIDENCE_PUBLIC_BASE_PATHS[0];

/**
 * Choose where the pages are served. A value outside the closed set is refused by name, so a typo can never serve the pages somewhere nobody linked.
 * @param {unknown} value
 */
export function setEvidencePublicBase(value) {
  if (typeof value !== "string" || !EVIDENCE_PUBLIC_BASE_PATHS.includes(value)) {
    throw new TypeError(`OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH must be one of ${EVIDENCE_PUBLIC_BASE_PATHS.join(", ")}, got ${JSON.stringify(value)}.`);
  }
  base = value;
}

/** The path the pages are served under, with no trailing slash. */
export const evidencePublicBase = () => base;

/**
 * A path under the base. `suffix` is what follows it and starts with `/`, or is empty: `evidencePublicPath("/c/ec_1")`, `evidencePublicPath("/")` (the index).
 * @param {string} [suffix]
 */
export const evidencePublicPath = (suffix = "") => `${base}${suffix}`;

/**
 * What a request path holds below the base — `""` for the bare base, `"/c/ec_1"` for a card — or null when the path is not under the base
 * (including the other member of the closed set).
 * @param {string} pathname
 * @returns {string | null}
 */
export function evidencePublicSuffix(pathname) {
  if (pathname === base) return "";
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null;
}
