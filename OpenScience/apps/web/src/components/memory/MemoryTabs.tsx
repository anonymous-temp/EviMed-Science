import { Tabs, type TabItem } from "@/components/ui/Tabs";

/** The memory page's four lists, each one list or — 成长 — the line and the days under it. */
export type MemoryTab = "self" | "project" | "methods" | "growth";
/** The page's tab bar also holds 地图, which is a page of its own (`/app/memory/map`) read as one more tab of this one. */
export type MemoryPageTab = MemoryTab | "map";

export const MEMORY_TAB_NAMES: Record<MemoryPageTab, string> = { self: "关于你", project: "项目", methods: "做法", growth: "成长", map: "地图" };
const ORDER: readonly MemoryPageTab[] = ["self", "project", "methods", "growth", "map"];

/** Where a tab goes: the lists are tabs of the memory page, the map is its own address. */
export function memoryTabAddress(tab: MemoryPageTab): string {
  return tab === "map" ? "/app/memory/map" : `/app/memory?tab=${tab}`;
}

/**
 * 「记忆胶囊」's one tab bar (2026-10-14: 「线上还是没有那些视图类的图谱类的展示」 — the map was behind a menu item and no one found it). The memory page
 * and the map page draw the same bar, so the map reads as part of the memory page and its tab is the selected one there. 地图 is
 * drawn where the deployment draws the map (`useMemoryMapFeature`), and always on the map page itself, where it is the tab in force.
 */
export function MemoryTabs({ value, counts = {}, map, onChange, className }: {
  value: MemoryPageTab;
  /** A count after a list's name, when it has one; a tab with none carries no number. */
  counts?: Partial<Record<MemoryTab, number | undefined>>;
  /** Whether the map's tab is offered. */
  map: boolean;
  onChange: (tab: MemoryPageTab) => void;
  className?: string;
}) {
  const items: TabItem<MemoryPageTab>[] = ORDER.filter((tab) => tab !== "map" || map || value === "map")
    .map((tab) => ({ value: tab, label: MEMORY_TAB_NAMES[tab], count: tab === "map" ? undefined : counts[tab] || undefined }));
  return <Tabs label="记忆" items={items} value={value} onChange={onChange} className={className} />;
}
