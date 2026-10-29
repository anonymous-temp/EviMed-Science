import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { PageShell } from "@/components/layout/PageShell";
import type { HeadlineProps } from "@/components/ui/Headline";
import type { ScopeMenuProps } from "@/components/ui/ScopeMenu";
import type { TabItem } from "@/components/ui/Tabs";
import type { ToolbarProps } from "@/components/ui/Toolbar";

/** The memory page's three lists. */
export type MemoryTab = "self" | "project" | "methods";
/**
 * The page's tab bar also holds 总览 and 地图, which are pages of their own (`/app/memory/overview`, `/app/memory/map`) read as two more tabs
 * of this one: 总览 is the capsule as six parts, 地图 the explorer it drills into, and the lists are what each of them opens.
 */
export type MemoryPageTab = MemoryTab | "overview" | "map";

export const MEMORY_TAB_NAMES: Record<MemoryPageTab, string> = { overview: "总览", map: "地图", self: "关于你", project: "项目", methods: "做法" };
const ORDER: readonly MemoryPageTab[] = ["overview", "map", "self", "project", "methods"];
/** The tabs that are pictures of the capsule, offered where the deployment draws them (`OPEN_SCIENCE_MEMORY_MAP_ENABLED`): they read the map's document. */
const PICTURES: ReadonlySet<MemoryPageTab> = new Set(["overview", "map"]);

/** Where a tab goes: the lists are tabs of the memory page, the overview and the map are their own addresses. */
export function memoryTabAddress(tab: MemoryPageTab): string {
  return tab === "map" ? "/app/memory/map" : tab === "overview" ? MEMORY_OVERVIEW_ADDRESS : `/app/memory?tab=${tab}`;
}

/** Where 记忆胶囊 opens: the overview — the capsule as one picture, from the first day. */
export const MEMORY_OVERVIEW_ADDRESS = "/app/memory/overview";

/**
 * 总览 and 地图 lead 记忆胶囊, followed by its three editable lists. They are drawn where the deployment draws the map (`useMemoryMapFeature`),
 * and always on their own page, where each is the tab in force. A tab with nothing in it carries no number.
 */
export function memoryTabItems(value: MemoryPageTab, { map, counts = {} }: { map: boolean; counts?: Partial<Record<MemoryTab, number | undefined>> }): TabItem<MemoryPageTab>[] {
  return ORDER.filter((tab) => !PICTURES.has(tab) || map || value === tab)
    .map((tab) => ({ value: tab, label: MEMORY_TAB_NAMES[tab], count: PICTURES.has(tab) ? undefined : counts[tab as MemoryTab] || undefined }));
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
  /** The tab's row of controls; `null` where the tab has none, so the band keeps the height it has on the tabs that do. */
  toolbar: ToolbarProps | null;
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
