import { VCR_CAPABILITIES } from "@evimed/domain";

/** The 「循证 GEO」 capabilities, by id. The VCR ones are the domain's `VCR_CAPABILITIES`. */
export const GEO_CAPABILITY_IDS = Object.freeze(["geo-insight", "geo-strategy", "geo-content", "geo-proposal"]);

/**
 * The module a capability is opened from, or null for an ordinary one. These
 * capabilities stay public (a bound conversation needs them) but are reachable
 * only from their module, so a module that is off or closed to the account
 * makes the capability itself unavailable rather than merely limited, and an
 * ordinary request is never routed to one (`routeOpenDomain`).
 *
 * Its own small file so that routing can read the marker without the
 * deployment's composition (the runtime manager, the module services) behind it.
 * @param {string} capabilityId @returns {"geo" | "vcr" | null}
 */
export function moduleOfCapability(capabilityId) {
  if (GEO_CAPABILITY_IDS.includes(capabilityId)) return "geo";
  if (VCR_CAPABILITIES.includes(capabilityId)) return "vcr";
  return null;
}
