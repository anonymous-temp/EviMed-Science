import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { PageShell } from "@/components/layout/PageShell";
import type { HeadlineProps } from "@/components/ui/Headline";
import type { ScopeMenuProps } from "@/components/ui/ScopeMenu";
import type { TabItem } from "@/components/ui/Tabs";
import type { ToolbarProps } from "@/components/ui/Toolbar";

/** The memory page's four lists: what is about the person, what is in a project, what was learned, what was received. */
export type MemoryTab = "self" | "project" | "methods" | "received";
/**
 * The page's tab bar also holds 总览, which is a page of its own (`/app/memory/overview`) read as the first tab of this one: the capsule as one
 * data page, and the lists are what each of its numbers opens. The map that was a tab of its own until 2026-10-27 is part of it now.
 */
export type MemoryPageTab = MemoryTab | "overview";

export const MEMORY_TAB_NAMES: Record<MemoryPageTab, string> = { overview: "总览", self: "关于你", project: "项目", methods: "做法", received: "收到的" };
const ORDER: readonly MemoryPageTab[] = ["overview", "self", "project", "methods", "received"];

/** Where a tab goes: the lists are tabs of the memory page, the overview is its own address. */
export function memoryTabAddress(tab: MemoryPageTab): string {
  return tab === "overview" ? MEMORY_OVERVIEW_ADDRESS : `/app/memory?tab=${tab}`;
}

/** Where 记忆胶囊 opens: the overview — the capsule as one data page, from the first day. */
export const MEMORY_OVERVIEW_ADDRESS = "/app/memory/overview";

/**
 * 总览 leads 记忆胶囊, followed by its four lists. It is drawn where the deployment draws the map (`useMemoryMapFeature`: it reads the map's
 * document), and always on its own page, where it is the tab in force. A tab with nothing in it carries no number.
 */
export function memoryTabItems(value: MemoryPageTab, { overview, counts = {} }: { overview: boolean; counts?: Partial<Record<MemoryTab, number | undefined>> }): TabItem<MemoryPageTab>[] {
  return ORDER.filter((tab) => tab !== "overview" || overview || value === tab)
    .map((tab) => ({ value: tab, label: MEMORY_TAB_NAMES[tab], count: tab === "overview" ? undefined : counts[tab] || undefined }));
}

/**
 * 「记忆胶囊」's one frame (R19, plan §2.1, §5.5): the lists and the overview are two routes and read as one page, so both draw it — the
 * same title, the same five tabs in the sticky band, one toolbar row under them, in one column. The tab bar was once drawn by each of
 * the two pages in its own container and the title and the tabs stepped 80 px sideways as the researcher moved from one to the other.
 *
 * Whatever belongs to one tab is passed in: the toolbar (the lists' search; the overview's range, filters and search; the 收到的 tab's
 * one action), the project scope in the header (the 项目 tab's), the header's actions and the overview's one-sentence headline. `onTab` is
 * the page's own way of moving between tabs; without it the frame navigates to the tab's address.
 */
export function MemoryFrame({ tab, counts, overview, onTab, toolbar, scope, actions, headline, documentTitle, children }: {
  tab: MemoryPageTab;
  counts?: Partial<Record<MemoryTab, number | undefined>>;
  /** Whether the overview's tab is offered. */
  overview: boolean;
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
      tabs={{ label: "记忆", items: memoryTabItems(tab, { overview, counts }), value: tab, onChange: onTab ?? ((next) => navigate(memoryTabAddress(next))), panelId: "memory-panel" }}
      toolbar={toolbar}
      headline={headline}
    >
      {children}
    </PageShell>
  );
}
