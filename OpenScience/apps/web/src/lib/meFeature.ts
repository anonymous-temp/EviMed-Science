/**
 * Whether `/api/me` offers this account an optional module (`features.<name>`), and the hook a component asks before it calls the module.
 *
 * A component of an optional module does not find out that the module is off by calling it and reading the 404: that refusal is a failed
 * request on every page that draws it (the walk counts it, the browser logs it), and the server has already said so in `/api/me`. Ask
 * first; call only when the answer is yes. Presentation only: the module's routes keep refusing by name, so a browser that flips this
 * gains a control that says so, never the data.
 */
import { useEffect, useState } from "react";
import { fetchWebMe, type WebMe } from "./apiClient";

/** The names `/api/me` answers under `features` (server.mjs, `GET /api/me`). */
export type MeFeatureName = "frontier" | "review" | "knowledgePages" | "capsuleShare" | "zoneSubscription" | "evidenceCommunity" | "geo" | "vcr" | "memoryMap" | "openList";

/** Whether `/api/me` offers the module. A missing `features` is off. */
export function featureOffered(me: WebMe | null, name: MeFeatureName): boolean {
  const features = (me as (WebMe & { features?: unknown }) | null)?.features;
  return Boolean(features && typeof features === "object" && !Array.isArray(features)
    && (features as Record<string, unknown>)[name] === true);
}

/** `error`: `/api/me` could not be read, which is not the same as being told no. */
export type MeFeature = "loading" | "on" | "off" | "error";

/** The account's answer for one module, read once per mount from the shared `/api/me`. */
export function useMeFeature(name: MeFeatureName): MeFeature {
  const [feature, setFeature] = useState<MeFeature>("loading");
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => fetchWebMe())
      .then(
        (me) => { if (active) setFeature(featureOffered(me, name) ? "on" : "off"); },
        () => { if (active) setFeature("error"); },
      );
    return () => { active = false; };
  }, [name]);
  return feature;
}
