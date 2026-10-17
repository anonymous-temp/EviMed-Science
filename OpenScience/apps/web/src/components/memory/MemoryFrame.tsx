import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { PageShell } from "@/components/layout/PageShell";
import type { HeadlineProps } from "@/components/ui/Headline";
import type { ScopeMenuProps } from "@/components/ui/ScopeMenu";
import type { TabItem } from "@/components/ui/Tabs";
import type { ToolbarProps } from "@/components/ui/Toolbar";

/** The memory page's three lists. */
export type MemoryTab = "self" | "project" | "methods";
/** The page's tab bar also holds 地图, which is a page of its own (`/app/memory/map`) read as one more tab of this one. */
export type MemoryPageTab = MemoryTab | "map";

export const MEMORY_TAB_NAMES: Record<MemoryPageTab, string> = { self: "关于你", project: "项目", methods: "做法", map: "地图" };
const ORDER: readonly MemoryPageTab[] = ["self", "project", "methods", "map"];

/** Where a tab goes: the lists are tabs of the memory page, the map is its own address. */
export function memoryTabAddress(tab: MemoryPageTab): string {
  return tab === "map" ? "/app/memory/map" : `/app/memory?tab=${tab}`;
}

/** The map's time view — where the 「成长」 tab went (`?tab=growth` still arrives here). */
export const MEMORY_TIME_ADDRESS = "/app/memory/map?view=time";

/**
 * The tabs of 记忆胶囊: 关于你 · 项目 · 做法 · 地图. 地图 is drawn where the deployment draws the map (`useMemoryMapFeature`), and always
 * on the map page itself, where it is the tab in force. A tab with nothing in it carries no number.
 */
export function memoryTabItems(value: MemoryPageTab, { map, counts = {} }: { map: boolean; counts?: Partial<Record<MemoryTab, number | undefined>> }): TabItem<MemoryPageTab>[] {
  return ORDER.filter((tab) => tab !== "map" || map || value === "map")
    .map((tab) => ({ value: tab, label: MEMORY_TAB_NAMES[tab], count: tab === "map" ? undefined : counts[tab] || undefined }));
}

/**
 * 「记忆胶囊」's one frame (R19, plan §2.1, §5.5): the lists and the map are two routes and read as one page, so both draw it — the
 * same title, the same four tabs in the sticky band, one toolbar row under them, in one column. The tab bar was once drawn by each of
 * the two pages in its own container (`page` 1040 on one, `wide` 1200 on the other) and the title and the tabs stepped 80 px sideways
 * as the researcher moved from 做法 to 地图.
 *
 * Whatever belongs to one tab is passed in: the toolbar (the lists' search; the map's views, filters and search), the project scope in
 * the header (the 项目 tab's, and the map's), the header's actions and the map's one-sentence headline. `onTab` is the page's own way
 * of moving between tabs; without it the frame navigates to the tab's address.
 */
export function MemoryFrame({ tab, counts, map, onTab, toolbar, scope, actions, headline, documentTitle, children }: {
  tab: MemoryPageTab;
  counts?: Partial<Record<MemoryTab, number | undefined>>;
  /** Whether the map's tab is offered. */
  map: boolean;
  onTab?: (tab: MemoryPageTab) => void;
  toolbar: ToolbarProps;
  scope?: ScopeMenuProps;
  actions?: ReactNode;
  headline?: HeadlineProps;
  documentTitle?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <PageShell
      title="记忆胶囊"
      documentTitle={documentTitle}
      scope={scope}
      actions={actions}
      tabs={{ label: "记忆", items: memoryTabItems(tab, { map, counts }), value: tab, onChange: onTab ?? ((next) => navigate(memoryTabAddress(next))), panelId: "memory-panel" }}
      toolbar={toolbar}
      headline={headline}
    >
      {children}
    </PageShell>
  );
}
