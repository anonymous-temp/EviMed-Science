/**
 * Whether this deployment draws 「记忆地图」 (`OPEN_SCIENCE_MEMORY_MAP_ENABLED`, which follows the memory subsystem's own switch).
 *
 * Its own module, like `capsuleShareFeature.ts`: the memory page's tab bar asks, and `/api/me` is what answers. Presentation only: the
 * map's routes answer 503 `memory_map_disabled` themselves, so a browser that flips this gains a tab that says so, never the data.
 */
import { useEffect, useState } from "react";
import { fetchWebMe, type WebMe } from "./apiClient";

/** Whether `/api/me` offers the map. A missing `features` is off. */
export function memoryMapOffered(me: WebMe | null): boolean {
  const features = (me as (WebMe & { features?: unknown }) | null)?.features;
  return Boolean(features && typeof features === "object" && !Array.isArray(features)
    && (features as Record<string, unknown>).memoryMap === true);
}

/** `error`: `/api/me` could not be read, which is not the same as being told no. */
export type MemoryMapFeature = "loading" | "on" | "off" | "error";

/** The answer, read once per mount from the shared `/api/me`. */
export function useMemoryMapFeature(): MemoryMapFeature {
  const [feature, setFeature] = useState<MemoryMapFeature>("loading");
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => fetchWebMe())
      .then(
        (me) => { if (active) setFeature(memoryMapOffered(me) ? "on" : "off"); },
        () => { if (active) setFeature("error"); },
      );
    return () => { active = false; };
  }, []);
  return feature;
}
