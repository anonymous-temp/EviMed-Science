import type { ReactNode } from "react";
import type { FrontierHotBoard, FrontierHotWindow } from "@/lib/frontierClient";
import { Button } from "@/components/ui/Button";
import { FilterChip, FilterChips, type FilterOption } from "@/components/ui/FilterChips";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import type { FollowControls } from "./FollowingView";
import { HotWindowChips } from "./FrontierHot";

/** What the page is showing. `weekly` is the 简报 tab's second period, `daily` its first. */
export type PageView = "selected" | "hot" | "daily" | "all" | "foryou" | "following" | "weekly";

/** The six views, in the order a reader looks for them. 简报 is the daily and the weekly. */
const VIEWS: readonly TabItem<PageView>[] = [
  { value: "selected", label: "精选" },
  { value: "all", label: "全部" },
  { value: "hot", label: "热榜" },
  { value: "foryou", label: "与我相关" },
  { value: "following", label: "关注" },
  { value: "daily", label: "简报" },
];

const BRIEF_PERIODS: readonly FilterOption<"daily" | "weekly">[] = [
  { value: "daily", label: "日报" },
  { value: "weekly", label: "周报" },
];

/**
 * The page's one control row (plan 2026-10-07 §4): the six views as underlined
 * tabs on the left and, at the right, the controls of the view that is open —
 *
 *  - 精选 / 全部: the feed's filters (`filters`);
 *  - 热榜: 当前 · 本周 · 本月 and when the ranking was taken;
 *  - 简报: 日报 · 周报;
 *  - 关注: the same filters and 「管理关注」 (with 「全部关注」 while one follow
 *    narrows the feed) — the filters only while a topic is followed, 「管理关注」
 *    while anything is, and nothing while the reader follows nothing (`follow`);
 *  - 与我相关: nothing.
 *
 * Until now the same choices were a nav row, a row of pill chips and a third
 * row of filters, two banners above the first item (332cc01cf split the one
 * row of tabs into three controls). Below 640 px the right-hand controls drop
 * under the tabs, which is the only second row there is.
 */
export function FrontierControls({
  view, onView, filters, hotWindow, hotBoard, hotWindows, onHotWindow, follow, narrowedFollow, onAllFollows, onManageFollows,
}: {
  view: PageView;
  onView: (view: PageView) => void;
  /** The feed's filter controls (`FrontierFilters`), for 精选, 全部 and 关注. */
  filters: ReactNode;
  hotWindow: FrontierHotWindow;
  /** The ranking on screen, for the time it was taken. */
  hotBoard: FrontierHotBoard | null;
  /** Whether the server stamps its rankings, so that 本周 and 本月 mean something. */
  hotWindows: boolean;
  onHotWindow: (window: FrontierHotWindow) => void;
  /** What the 关注 view has to control: a feed to filter, only the way to add a follow, or nothing. */
  follow: FollowControls;
  /** One followed topic narrows the 关注 feed; 「全部关注」 widens it again. */
  narrowedFollow: boolean;
  onAllFollows: () => void;
  onManageFollows: () => void;
}) {
  const trailing = (() => {
    switch (view) {
      case "selected":
      case "all":
        return filters;
      case "hot":
        return hotWindows ? <HotWindowChips window={hotWindow} board={hotBoard} onWindow={onHotWindow} /> : null;
      case "daily":
      case "weekly":
        return <FilterChips label="简报周期" options={BRIEF_PERIODS} value={view} onChange={onView} />;
      case "following":
        if (follow === "none") return null;
        return (
          <>
            {narrowedFollow && <FilterChip onClick={onAllFollows}>全部关注</FilterChip>}
            {follow === "full" && filters}
            <Button variant="secondary" size="sm" onClick={onManageFollows}>管理关注</Button>
          </>
        );
      default:
        return null;
    }
  })();
  return (
    <Tabs
      label="动态视图"
      items={VIEWS}
      value={view === "weekly" ? "daily" : view}
      // The 简报 tab is the daily and the weekly: pressing it on the weekly stays there.
      onChange={(next) => { if (!(next === "daily" && view === "weekly")) onView(next); }}
      panelId="frontier-view"
      trailing={trailing}
    />
  );
}
