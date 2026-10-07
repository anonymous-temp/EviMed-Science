/**
 * Whether this deployment shares capsules between accounts (`OPEN_SCIENCE_CAPSULE_SHARE_ENABLED`, off until turned on).
 *
 * Its own module, like `frontierFeature.ts`: the share panel asks, and `/api/me` is what answers. Presentation only: the share
 * routes answer 404 `capsule_share_not_enabled` themselves, so a browser that flips this gains a panel that says so, never the data.
 */
import { useEffect, useState } from "react";
import { fetchWebMe, type WebMe } from "./apiClient";

/** Whether `/api/me` offers this account sharing. A missing `features` is off. */
export function capsuleShareOffered(me: WebMe | null): boolean {
  const features = (me as (WebMe & { features?: unknown }) | null)?.features;
  return Boolean(features && typeof features === "object" && !Array.isArray(features)
    && (features as Record<string, unknown>).capsuleShare === true);
}

/** `error`: `/api/me` could not be read, which is not the same as being told no. */
export type CapsuleShareFeature = "loading" | "on" | "off" | "error";

/** The account's answer, read once per mount from the shared `/api/me`. */
export function useCapsuleShareFeature(): CapsuleShareFeature {
  const [feature, setFeature] = useState<CapsuleShareFeature>("loading");
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => fetchWebMe())
      .then(
        (me) => { if (active) setFeature(capsuleShareOffered(me) ? "on" : "off"); },
        () => { if (active) setFeature("error"); },
      );
    return () => { active = false; };
  }, []);
  return feature;
}
