import { createContext, useContext, useLayoutEffect } from "react";
import type { GeoProject, GeoStepKey } from "@/lib/geoClient";
import type { ToolbarProps } from "@/components/ui/Toolbar";
import type { GeoDataCache } from "./geoProjectData";
import type { GeoTabKey } from "./geoTabs";
import type { GeoReadScope } from "@/lib/geoReadScope";

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
  /**
   * The conversation the page holds: the one on screen or named in the address (`?session=`), else the project's own — what the
   * conversation bar opens, and every 「让 AI …」 below it that names none.
   */
  conversation: string | null;
  /** The business workbench currently viewed; unrelated background work never overrides it. */
  step?: GeoStepKey | null;
  refreshError?: string;
  /** The project's refresh met a saved selection that changed since (409): 重试 would send it again, `refreshScope` leaves it. */
  refreshStale?: boolean;
  /** One analytical scope; work queues and publication state remain current state. */
  scope?: GeoReadScope;
  scopePending?: boolean;
  scopeError?: string;
  /** Read the project again now: after a start, a budget, a tier, anything that moves the rail or the to-dos. */
  reload(): void;
  /** Explicitly leave an outdated saved selection, keeping its resolved range, then read current observations. */
  refreshScope?(): void;
  /** Open the existing range/comparison dialog from a scoped analytical action. */
  openAnalysisScope?(): void;
  /**
   * Open one of the page's own panels over the tab: the project's name, its members, who speaks for the product, the budget. A tab
   * that asks does not own the dialog, and the layout does not navigate for it.
   */
  openPanel(panel: GeoPanel): void;
  /** What the project's tabs read — diagnosis, monitoring, the value analysis — shared, so a tab switch does not fetch it again. */
  data: GeoDataCache;
  /** `useGeoToolbar`'s door; a tab does not call it. */
  setToolbar(toolbar: ToolbarProps | null | undefined): void;
  /** `useGeoAnswerBack`'s door: where the band's way back goes from an answer opened by a link. Absent outside a layout. */
  setAnswerBack?(back: GeoAnswerBack | null): void;
}

/**
 * Where the way back from one answer goes when the reader did not come from inside the app: the tab that holds the finding, named
 * for the link's label. The answer knows which (it has findings, or not); the band draws the one back control of the page.
 */
export type GeoAnswerBack = "accuracy" | "questions" | "overview";
export const GEO_ANSWER_BACK_NAMES: Readonly<Record<GeoAnswerBack, string>> = Object.freeze({ accuracy: "准确与安全", questions: "问题与回答", overview: "总览" });

/** The panels the layout opens: the header's 「⋯」 dialogs, the budget's, the settings drawer and the AI-run record. */
export type GeoPanel = "members" | "producer" | "rename" | "budget" | "settings" | "runs";

export const GeoFrameContext = createContext<GeoFrameApi | null>(null);

/**
 * Whether the account may open the project's conversation, or hand it a draft: the module's descriptor takes run and edit, so a role
 * without them (只读, 医学审核) would only be refused. Such a role is offered the conversation kept, read-only, where there is one.
 */
export function geoMayConverse(project: Pick<GeoProject, "access"> | null | undefined): boolean {
  const abilities = project?.access?.abilities;
  return !abilities || abilities.includes("run") && abilities.includes("edit");
}

/** The layout this component is in, or null outside one. */
export function useGeoFrame(): GeoFrameApi | null {
  return useContext(GeoFrameContext);
}

export function useGeoReadScope(): GeoReadScope | undefined {
  return useContext(GeoFrameContext)?.scope;
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

/**
 * The answer says where its way back goes (`GeoAnswerBack`); the band draws it. An answer used to draw a back arrow of its own under a
 * band whose back said 项目总览, two controls with two targets for one page. Registered while the answer is on the page and withdrawn
 * with it, so the next page finds the band's usual back.
 */
export function useGeoAnswerBack(back: GeoAnswerBack): void {
  const set = useContext(GeoFrameContext)?.setAnswerBack;
  useLayoutEffect(() => {
    set?.(back);
    return () => set?.(null);
  }, [set, back]);
}
