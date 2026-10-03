import { useLocation } from "react-router";

export const FRONTIER_LEAVING = "evimed:frontier-leaving";
export interface FrontierReadingPosition { query: string; pages: number; scroll: number; expanded?: string[] }
export function useFrontierOrigin() {
  const location = useLocation();
  const prior = (location.state as { frontierOrigin?: string } | null)?.frontierOrigin;
  return { frontierOrigin: typeof prior === "string" && (prior.startsWith("/app/frontier?") || prior === "/app/frontier") ? prior : `/app/frontier${location.search}` };
}
export function rememberFrontierPosition() {
  window.dispatchEvent(new Event(FRONTIER_LEAVING));
}

export function readFrontierPosition(value: unknown): FrontierReadingPosition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const position = value as Record<string, unknown>;
  if (typeof position.query !== "string" || position.query.length > 2000 || typeof position.pages !== "number" || !Number.isInteger(position.pages) || position.pages < 1 || position.pages > 10000 || typeof position.scroll !== "number" || !Number.isFinite(position.scroll) || position.scroll < 0 || position.scroll > 1_000_000) return undefined;
  const expanded = Array.isArray(position.expanded) ? [...new Set(position.expanded.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, 200) : [];
  return { query: position.query, pages: Math.min(position.pages, 20), scroll: position.scroll, expanded };
}
