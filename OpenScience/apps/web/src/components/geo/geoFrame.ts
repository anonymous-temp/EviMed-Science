import { createContext, useContext, useLayoutEffect } from "react";
import type { GeoProject } from "@/lib/geoClient";
import type { ToolbarProps } from "@/components/ui/Toolbar";
import type { GeoDataCache } from "./geoProjectData";
import type { GeoTabKey } from "./geoTabs";

/**
 * What the project's layout (`app/routes/GeoProjectPage.tsx`) gives the tab it holds (R19, plan §5.4; audit C A.1).
 *
 * A tab is a child of the layout route and cannot hand it props, so what it needs of the page around it — the project, to read it
 * again, the one data layer of the project, and a place for its controls in the fixed band — is this context. It is also what the
 * layout hands the router's `<Outlet context>`. A tab rendered on its own (a test, a gallery) finds `null` and every hook below does
 * nothing, which is exactly what it must do: the tab keeps working, with no band above it.
 */
export interface GeoFrameApi {
  geoId: string;
  /** The project as the layout last read it: the header, the rail, the to-dos. */
  project: GeoProject;
  /** The tab that is open; the answer page keeps 问题与回答. */
  tab: GeoTabKey;
  /** Read the project again now: after a start, a budget, a tier, anything that moves the rail or the to-dos. */
  reload(): void;
  /**
   * Open one of the page's own panels over the tab: the project's name, its members, who speaks for the product, the budget. A tab
   * that asks does not own the dialog, and the layout does not navigate for it.
   */
  openPanel(panel: GeoPanel): void;
  /** What the project's tabs read — diagnosis, monitoring, the value analysis — shared, so a tab switch does not fetch it again. */
  data: GeoDataCache;
  /** `useGeoToolbar`'s door; a tab does not call it. */
  setToolbar(toolbar: ToolbarProps | null | undefined): void;
}

/** The panels the layout opens: the header's 「⋯」 dialogs, the budget's, the settings drawer and the AI-run record. */
export type GeoPanel = "members" | "producer" | "rename" | "budget" | "settings" | "runs";

export const GeoFrameContext = createContext<GeoFrameApi | null>(null);

/** The layout this component is in, or null outside one. */
export function useGeoFrame(): GeoFrameApi | null {
  return useContext(GeoFrameContext);
}

/**
 * The tab's one row of controls — its view switch, its filters, its search, its count, its buttons — drawn **in the fixed band,
 * above the body** (DESIGN.md rule 7). The layout renders it as `PageShell`'s `toolbar` slot, so it neither scrolls away nor sinks, and
 * a tab that calls nothing leaves the row reserved and empty: the band is the same height on every tab.
 *
 * A tab calls this and renders no `Toolbar` of its own, and imports no `FilterChips`, `FilterSelect`, `SearchInput` or `Tabs` (the
 * layout lint block). The tab row above is the page's one row of views, so `toolbar.views` is not for a tab: a tab's own object
 * switch (按问句池 · 按旅程 · 全部问句, 结论库 · 药品价值) is a `filters` entry of kind `chips`. On a phone the toolbar folds its filters
 * into one 「筛选」 chip.
 *
 * ```tsx
 * useGeoToolbar({
 *   filters: [{ kind: "chips", label: "出处类型", options, value: kind, onChange: setKind }],
 *   search: { label: "搜索结论", value: query, onChange: setQuery, onClear: () => setQuery("") },
 *   summary: `${matching.length} 条结论`,
 * });
 * ```
 *
 * The object is read on every render, so its handlers are always the render's own; it is cheap to build, and the layout does not
 * re-render the tab for it. Pass `null` where the tab has none for this state (a list that is empty).
 */
export function useGeoToolbar(toolbar: ToolbarProps | null): void {
  const set = useContext(GeoFrameContext)?.setToolbar;
  useLayoutEffect(() => { set?.(toolbar); });
  useLayoutEffect(() => () => { set?.(undefined); }, [set]);
}
