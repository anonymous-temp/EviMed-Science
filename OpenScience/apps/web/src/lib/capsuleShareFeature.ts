/**
 * Whether this deployment shares capsules between accounts (`OPEN_SCIENCE_CAPSULE_SHARE_ENABLED`, on unless an operator turns it off).
 *
 * Its own module, like `frontierFeature.ts`: the share panel asks, and `/api/me` is what answers. Presentation only: the share
 * routes answer 404 `capsule_share_not_enabled` themselves, so a browser that flips this gains a panel that says so, never the data.
 */
import type { WebMe } from "./apiClient";
import { featureOffered, useMeFeature, type MeFeature } from "./meFeature";

/** Whether `/api/me` offers it. A missing `features` is off. */
export function capsuleShareOffered(me: WebMe | null): boolean {
  return featureOffered(me, "capsuleShare");
}

/** `error`: `/api/me` could not be read, which is not the same as being told no. */
export type CapsuleShareFeature = MeFeature;

/** The answer, read once per mount from the shared `/api/me` (`useMeFeature`). */
export function useCapsuleShareFeature(): CapsuleShareFeature {
  return useMeFeature("capsuleShare");
}
