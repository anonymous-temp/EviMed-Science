import type { ReactNode } from "react";
import { X } from "lucide-react";
import type { FrontierHotBoard, FrontierHotWindow } from "@/lib/frontierClient";
import { Button } from "@/components/ui/Button";
import type { TabItem } from "@/components/ui/Tabs";
import type { ToolbarFilter, ToolbarProps, ToolbarSearch } from "@/components/ui/Toolbar";
import type { FollowControls } from "./FollowingView";
import { feedFilters, type FrontierFilterValue } from "./FrontierFilters";
import { hotWindowFilter } from "./FrontierHot";

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

/**
 * The page's one row of controls, as the `Toolbar` of the page shell takes it (plan 2026-10-07 §4; R19, audit D C1d): the six views
 * as underlined tabs on the left and, at the right, the controls of the view that is open —
 *
 *  - 精选 / 全部: the feed's filters;
 *  - 热榜: 当前 · 本周 · 本月 and when the ranking was taken;
 *  - 简报: 日报 · 周报, and the issue's own 分类, 往期 and 复制 (`issue`);
 *  - 关注: the same filters and 「管理关注」 (with 「全部关注」 while one follow narrows the feed) — the filters only while a topic is
 *    followed, 「管理关注」 while anything is, and nothing while the reader follows nothing (`follow`);
 *  - 与我相关: nothing.
 *
 * The search is the feed's, in every view. The row is in the shell's sticky band, so it stays at the top while a feed of six thousand
 * pixels scrolls under it — it used to scroll away, and a reader at the bottom of the 精选 feed had to go back up to change the
 * view. Below 640 px the controls drop under the tabs and the filters fold into one chip, which is the only second row there is.
 */
export function frontierToolbar({
  view, onView, filters, onFilters, showWindow, searching, search, hot, follow, narrowedFollow, onAllFollows, onManageFollows, issue, onClear,
}: {
  view: PageView;
  onView: (view: PageView) => void;
  /** The feed's filter values and how they change (`FrontierFilters`). */
  filters: FrontierFilterValue;
  onFilters: (change: Partial<FrontierFilterValue>) => void;
  showWindow: boolean;
  searching: boolean;
  search: ToolbarSearch;
  hot: {
    window: FrontierHotWindow;
    /** The ranking on screen, for the time it was taken. */
    board: FrontierHotBoard | null;
    /** Whether the server stamps its rankings, so that 本周 and 本月 mean something. */
    windows: boolean;
    onWindow: (window: FrontierHotWindow) => void;
  };
  /** What the 关注 view has to control: a feed to filter, only the way to add a follow, or nothing. */
  follow: FollowControls;
  /** One followed topic narrows the 关注 feed; 「全部关注」 widens it again. */
  narrowedFollow: boolean;
  onAllFollows: () => void;
  onManageFollows: () => void;
  /** The issue on screen's own controls (`dailyControls`), for the 简报 tab. */
  issue: { filters: ToolbarFilter[]; actions: ReactNode };
  /** Lets go of the feed's filters and the search. */
  onClear: () => void;
}): ToolbarProps {
  const feed = feedFilters({ value: filters, showWindow, searching, onChange: onFilters });
  let controls: ToolbarFilter[] = [];
  let actions: ReactNode;
  let clearable = false;
  switch (view) {
    case "selected":
    case "all":
      controls = feed;
      clearable = true;
      break;
    case "hot":
      controls = hot.windows ? [hotWindowFilter({ window: hot.window, board: hot.board, onWindow: hot.onWindow })] : [];
      break;
    case "daily":
    case "weekly":
      controls = [
        { kind: "chips", label: "简报周期", options: [{ value: "daily", label: "日报" }, { value: "weekly", label: "周报" }], value: view, onChange: (next) => onView(next as PageView) },
        ...issue.filters,
      ];
      actions = issue.actions;
      break;
    case "following":
      if (follow !== "none") {
        controls = [
          ...(narrowedFollow ? [{ kind: "toggle" as const, label: "全部关注", icon: X, pressed: true, onChange: () => onAllFollows() }] : []),
          ...(follow === "full" ? feed : []),
        ];
        actions = <Button variant="secondary" size="sm" onClick={onManageFollows}>管理关注</Button>;
      }
      break;
    default:
      break;
  }
  return {
    label: "动态筛选与搜索",
    className: "frontier-toolbar",
    views: {
      label: "动态视图",
      items: VIEWS,
      value: view === "weekly" ? "daily" : view,
      // The 简报 tab is the daily and the weekly: pressing it on the weekly stays there.
      onChange: (next) => { if (!(next === "daily" && view === "weekly")) onView(next as PageView); },
      panelId: "frontier-view",
    },
    filters: controls,
    onClear: clearable ? onClear : undefined,
    search,
    actions,
  };
}
