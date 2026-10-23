import { useCallback } from "react";
import { useLocation } from "react-router";
import { geoReadScopeFromSearch, geoReadScopeQuery } from "@/lib/geoReadScope";
import { geoDestinationPath } from "./geoTabs";

/** Carry analytical context inside this project only; a destination's own narrowing takes precedence. */
export function geoPathWithContext(path: string, from: { pathname: string; search: string }): string {
  const target = new URL(path, "https://geo.invalid");
  const sourceParts = from.pathname.split("/");
  const targetParts = target.pathname.split("/");
  if (sourceParts[2] !== "geo" || targetParts[2] !== "geo" || !sourceParts[3] || sourceParts[3] !== targetParts[3]) return path;
  const kept = new URLSearchParams(geoReadScopeQuery(geoReadScopeFromSearch(from.search)));
  const session = new URLSearchParams(from.search).get("session");
  if (session) kept.set("session", session);
  for (const [alias, canonical] of [["engine", "engines"], ["cluster", "groupIds"], ["pool", "pools"]]) {
    if (target.searchParams.has(alias) || target.searchParams.has(canonical)) { kept.delete(alias); kept.delete(canonical); kept.delete("selectionRef"); }
  }
  for (const key of new Set(target.searchParams.keys())) {
    kept.delete(key);
    for (const value of target.searchParams.getAll(key)) kept.append(key, value);
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
