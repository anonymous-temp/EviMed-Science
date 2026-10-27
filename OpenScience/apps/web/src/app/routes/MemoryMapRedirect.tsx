import { Navigate, useLocation } from "react-router";

/** `MEMORY_OVERVIEW_ADDRESS`, written out: the router loads this file with the shell, and the frame that exports it is the memory page's chunk. */
const OVERVIEW = "/app/memory/overview";

/**
 * Where an address of the retired 「记忆地图」 lands: the overview, which has its relation graph and topics. What the map's address said carries
 * over under the names the overview uses — `view=graph|topics` as `explore=`, and `project`, `q`, `open`, `look`, `topic` and a 30- or 90-day
 * `range` as they were; the map's other views (维度, 时间, 活跃) and its focus, kind and part have no counterpart and are dropped, so a bookmarked
 * link opens the overview and not a page that says it is gone.
 */
export function overviewAddressFromMap(search: string): string {
  const old = new URLSearchParams(search);
  const next = new URLSearchParams();
  const view = old.get("view");
  if (view === "graph" || view === "topics") next.set("explore", view);
  for (const name of ["project", "q", "open", "look", "topic"]) {
    const value = old.get(name);
    if (value) next.set(name, value);
  }
  const range = old.get("range");
  if (range === "30d" || range === "90d") next.set("range", range);
  const query = next.toString();
  return `${OVERVIEW}${query ? `?${query}` : ""}`;
}

export function MemoryMapRedirect() {
  const { search } = useLocation();
  return <Navigate to={overviewAddressFromMap(search)} replace />;
}
