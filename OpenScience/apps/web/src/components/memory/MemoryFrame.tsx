import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Link } from "react-router";
import { PAGE_TITLE_CLASS } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { cn } from "@/lib/cn";
import type { HeadlineProps } from "@/components/ui/Headline";
import { navItemClasses } from "@/components/ui/NavItem";
import type { ToolbarProps } from "@/components/ui/Toolbar";
import { MemoryControls } from "./MemoryControls";

/** The memory page's three lists: what is about the person (the memories of a project among them), what was learned, what was received. */
export type MemoryTab = "self" | "methods" | "received";
/**
 * The navigation also holds 总览, which is a page of its own (`/app/memory/overview`) read as the first section of this one: the capsule as one
 * data page, and the lists are what each of its numbers opens. The map that was a tab of its own until 2026-10-27 is part of it now.
 * 项目 was a section until 2026-10-28: a person has one capsule and a project is a label on a memory, so a project's memories are a group
 * of 关于你, each row naming its project.
 */
export type MemoryPageTab = MemoryTab | "overview";

export const MEMORY_TAB_NAMES: Record<MemoryPageTab, string> = { overview: "总览", self: "关于你", methods: "做法", received: "收到的" };
const ORDER: readonly MemoryPageTab[] = ["overview", "self", "methods", "received"];

/** Where a section goes: the lists are one page that reads `?tab=`, the overview is its own address. */
export function memoryTabAddress(tab: MemoryPageTab): string {
  return tab === "overview" ? MEMORY_OVERVIEW_ADDRESS : `/app/memory?tab=${tab}`;
}

/** Where 记忆胶囊 opens: the overview — the capsule as one data page, from the first day. */
export const MEMORY_OVERVIEW_ADDRESS = "/app/memory/overview";

/** One entry of the navigation: where it goes and what it holds, when it holds something. */
export interface MemoryNavItem {
  tab: MemoryPageTab;
  label: string;
  /** Absent for a section with nothing in it, or whose number is not known yet: 「做法 0」 is a statistic about an empty list, which its empty state already says. */
  count: number | undefined;
}

/**
 * 总览 leads 记忆胶囊, followed by its three lists. It is drawn where the deployment draws the map (`useMemoryMapFeature`: it reads the map's
 * document), and always on its own page, where it is the section in force.
 */
export function memoryNavItems(value: MemoryPageTab, { overview, counts = {} }: { overview: boolean; counts?: Partial<Record<MemoryTab, number | undefined>> }): MemoryNavItem[] {
  return ORDER.filter((tab) => tab !== "overview" || overview || value === tab)
    .map((tab) => ({ tab, label: MEMORY_TAB_NAMES[tab], count: tab === "overview" ? undefined : counts[tab] || undefined }));
}

/** What the navigation takes: the capsule's own controls, which the pages answer — a drawer to open, or the page to read again. */
export type MemoryFrameControls = Omit<ComponentProps<typeof MemoryControls>, "children">;

/** The left column's width, and the least the content is given: the two together are the page's own width from which they stand side by side. */
const NAV_WIDTH = 240;
const CONTENT_MIN = 640;

/**
 * 「记忆胶囊」's one frame (2026-10-28): the lists and the overview are two routes and read as one page, so both draw it — a left column and,
 * beside it, the section. The page used to stack a title, five tabs, a toolbar and a column of lists, and every section looked like the same long
 * page; now where the researcher is, what the capsule holds and the capsule's own controls stay put on the left while the section scrolls on the right.
 *
 * ```
 * ┌ 记忆胶囊 ──────┐ 关于你                                  (the section's heading, `PageShell`'s title)
 * │ 记忆 ●━        │ ┌ band ─────────────────────────────┐  (sticky: the section's one toolbar row)
 * │ 总览           │ │ 搜索记忆                          │
 * │ 关于你  23     │ └───────────────────────────────────┘
 * │ 做法    8      │ headline (总览's one sentence)
 * │ 收到的  2      │ body
 * │                │
 * │ 记住这一条  ⋯  │
 * └────────────────┘
 * ```
 *
 * The column holds the title, the 「记忆」 switch, the navigation — links, not tabs: each section is an address — and, at its foot, the
 * 「记住这一条」 button and the 「⋯」 menu. It has its own scroll, the section has its own (`PageShell`'s), and the section's controls
 * stay `PageShell`'s: the toolbar in the band, the headline over the body, `[data-page-body]` where the content starts.
 *
 * Beside or above is decided by the room the page itself has (the sidebar of the shell takes up to 340 px of the window), as `MasterDetail`
 * decides it: without room for both the column folds to one row above the section — the title with the controls, and the navigation under
 * them. One set of controls either way.
 */
export function MemoryFrame({ tab, counts, overview, controls, toolbar, headline, children }: {
  tab: MemoryPageTab;
  counts?: Partial<Record<MemoryTab, number | undefined>>;
  /** Whether 总览 is offered. */
  overview: boolean;
  controls: MemoryFrameControls;
  /** The section's row of controls: the lists' search, 收到的's one action, the overview's range, filters and search. */
  toolbar: ToolbarProps;
  /** The overview's one sentence. */
  headline?: HeadlineProps;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[entries.length - 1]?.contentRect.width;
      if (typeof next === "number") setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const split = width >= NAV_WIDTH + CONTENT_MIN;
  const name = MEMORY_TAB_NAMES[tab];

  return (
    <div ref={root} data-memory-frame={split ? "split" : "folded"} className={cn("flex h-full min-h-0 bg-bg", !split && "flex-col")}>
      <MemoryControls {...controls}>
        {({ remember, memorySwitch, menu }) => (
          <div
            data-memory-nav={split ? "column" : "row"}
            className={split
              ? "flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border px-4 py-6"
              : "flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3"}
          >
            <div className={cn("flex min-h-8 items-center", !split && "flex-wrap gap-x-3 gap-y-2")}>
              <p className={cn(PAGE_TITLE_CLASS, "min-w-0 line-clamp-1")}>记忆胶囊</p>
              {!split && <div className="ml-auto flex flex-wrap items-center gap-2">{memorySwitch}{remember}{menu}</div>}
            </div>
            {split && memorySwitch}
            <nav aria-label="记忆">
              <ul className={cn("flex gap-1", split ? "flex-col" : "overflow-x-auto")}>
                {memoryNavItems(tab, { overview, counts }).map((item) => (
                  <li key={item.tab} className="shrink-0">
                    <Link
                      to={memoryTabAddress(item.tab)}
                      aria-current={item.tab === tab ? "page" : undefined}
                      className={navItemClasses({ current: item.tab === tab, className: cn("justify-between whitespace-nowrap", !split && "gap-3") })}
                    >
                      <span>{item.label}</span>
                      {item.count !== undefined && <span className="text-caption tabular-nums text-text-3">{item.count}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            {split && <div className="mt-auto flex items-center gap-2 pt-4">{remember}{menu}</div>}
          </div>
        )}
      </MemoryControls>
      <div className="min-h-0 min-w-0 flex-1">
        <PageShell title={name} documentTitle={`记忆胶囊 · ${name}`} toolbar={toolbar} headline={headline}>
          {children}
        </PageShell>
      </div>
    </div>
  );
}
