/**
 * Whether this deployment draws 「记忆地图」 (`OPEN_SCIENCE_MEMORY_MAP_ENABLED`, which follows the memory subsystem's own switch).
 *
 * Its own module, like `capsuleShareFeature.ts`: the memory page's tab bar asks, and `/api/me` is what answers. Presentation only: the
 * map's routes answer 503 `memory_map_disabled` themselves, so a browser that flips this gains a tab that says so, never the data.
 */
import type { WebMe } from "./apiClient";
import { featureOffered, useMeFeature, type MeFeature } from "./meFeature";

/** Whether `/api/me` offers it. A missing `features` is off. */
export function memoryMapOffered(me: WebMe | null): boolean {
  return featureOffered(me, "memoryMap");
}

/** `error`: `/api/me` could not be read, which is not the same as being told no. */
export type MemoryMapFeature = MeFeature;

/** The answer, read once per mount from the shared `/api/me` (`useMeFeature`). */
export function useMemoryMapFeature(): MemoryMapFeature {
  return useMeFeature("memoryMap");
}
