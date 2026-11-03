import { useCallback } from "react";
import { useLocation } from "react-router";
import { geoReadScopeFromSearch, geoReadScopeQuery } from "@/lib/geoReadScope";
import { geoChatPath, geoSessionIdFromChatPath } from "@/lib/geoLocation";
import { geoDestinationPath, GEO_TABS } from "./geoTabs";

const GEO_RESULT_TABS: ReadonlySet<string> = new Set(GEO_TABS.map((tab) => tab.key));

/** Carry analytical context inside this project only; a destination's own narrowing takes precedence. */
export function geoPathWithContext(path: string, from: { pathname: string; search: string }): string {
  const target = new URL(path, "https://geo.invalid");
  const sourceParts = from.pathname.split("/");
  const targetParts = target.pathname.split("/");
  if (sourceParts[2] !== "geo" || targetParts[2] !== "geo" || !sourceParts[3] || sourceParts[3] !== targetParts[3]) return path;
  // An exact saved selection replaces inherited filters rather than narrowing them.
  const kept = new URLSearchParams(target.searchParams.has("selectionRef") ? "" : geoReadScopeQuery(geoReadScopeFromSearch(from.search)));
  const session = geoSessionIdFromChatPath(from.pathname) || new URLSearchParams(from.search).get("session");
  if (session) kept.set("session", session);
  if (new URLSearchParams(from.search).get("conversation") === "open" && session) kept.set("conversation", "open");
  for (const [alias, canonical] of [["engine", "engines"], ["cluster", "groupIds"], ["pool", "pools"]]) {
    if (target.searchParams.has(alias) || target.searchParams.has(canonical)) { kept.delete(alias); kept.delete(canonical); kept.delete("selectionRef"); }
  }
  for (const key of new Set(target.searchParams.keys())) {
    kept.delete(key);
    for (const value of target.searchParams.getAll(key)) kept.append(key, value);
  }
  // The conversation is open beside the results: a press in them changes what is beside it, and the conversation stays open.
  const tab = targetParts[4];
  if (session && geoSessionIdFromChatPath(from.pathname) && (!tab || GEO_RESULT_TABS.has(tab))) {
    kept.delete("session");
    kept.set("result", tab || "overview");
    return `${geoChatPath(sourceParts[3], session)}?${kept.toString()}${target.hash}`;
  }
  const query = kept.toString();
  return `${target.pathname}${query ? `?${query}` : ""}${target.hash}`;
}

export function useGeoPath() {
  const { pathname, search } = useLocation();
  return useCallback((path: string) => geoPathWithContext(path, { pathname, search }), [pathname, search]);
}

export function useGeoDestinationPath() {
  const path = useGeoPath();
  return useCallback((...args: Parameters<typeof geoDestinationPath>) => path(geoDestinationPath(...args)), [path]);
}
