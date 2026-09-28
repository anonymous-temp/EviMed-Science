/**
 * Whether this account is offered 「前沿动态」.
 *
 * Its own module because the sidebar asks on every page and the feed's client
 * (`frontierClient.ts`, which re-exports these) carries the feed's parsers
 * and the domain's frontier vocabulary: imported from there, the sidebar put
 * all of it into the bundle every page loads before its first paint.
 */
import { useEffect, useState } from "react";
import { fetchWebMe, type WebMe } from "./apiClient";

/** Whether `/api/me` offers this account the module. A missing `features` is off. */
export function frontierOffered(me: WebMe | null): boolean {
  const features = (me as (WebMe & { features?: unknown }) | null)?.features;
  return Boolean(features && typeof features === "object" && !Array.isArray(features)
    && (features as Record<string, unknown>).frontier === true);
}

/** `error`: `/api/me` could not be read, which is not the same as being told no. */
export type FrontierFeature = "loading" | "on" | "off" | "error";

/**
 * The account's answer, read once per mount from the shared `/api/me`.
 *
 * Presentation only, like `useOperator`: the routes authorize themselves, so a
 * browser that flips this gains a navigation row, never the data behind it.
 */
export function useFrontierFeature(): FrontierFeature {
  const [feature, setFeature] = useState<FrontierFeature>("loading");
  useEffect(() => {
    let active = true;
    // Through a promise even for a synchronous throw, so one failure path.
    Promise.resolve()
      .then(() => fetchWebMe())
      .then(
        (me) => { if (active) setFeature(frontierOffered(me) ? "on" : "off"); },
        () => { if (active) setFeature("error"); },
      );
    return () => { active = false; };
  }, []);
  return feature;
}
