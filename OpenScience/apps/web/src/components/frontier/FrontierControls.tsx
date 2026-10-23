import type { ReactNode } from "react";
import { X } from "lucide-react";
import type { FrontierHotBoard, FrontierHotWindow } from "@/lib/frontierClient";
import { Button } from "@/components/ui/Button";
import type { TabItem } from "@/components/ui/Tabs";
import type { ToolbarFilter, ToolbarProps, ToolbarSearch } from "@/components/ui/Toolbar";
import type { FollowControls } from "./FollowingView";
import { feedFilters, type ChosenTag, type FrontierFilterValue, type HotTags } from "./FrontierFilters";
import { hotWindowFilter } from "./FrontierHot";

/** What the page is showing. `weekly` is the 简报 tab's second period, `daily` its first. */
export type PageView = "selected" | "hot" | "daily" | "all" | "foryou" | "following" | "weekly" | "zones";

/** The peer views, in the order a reader looks for them. 简报 is the daily and the weekly. */
const VIEWS: readonly TabItem<PageView>[] = [
  { value: "selected", label: "精选" },
  { value: "all", label: "全部" },
  { value: "zones", label: "证据专区" },
  { value: "hot", label: "热榜" },
  { value: "foryou", label: "与我相关" },
  { value: "following", label: "关注" },
  { value: "daily", label: "简报" },
];

/**
 * The page's controls, as the `Toolbar` of the page shell takes it (plan 2026-10-07 §4; R19, audit D C1d; owner, 2026-10-23): the peer
 * views as underlined tabs with the search at their right, and under them — only where the open view has any — a second row of the
 * view's controls (`controlsBelow`):
 *
 *  - 精选 / 全部: the feed's filters (`feedFilters`: 栏目, 专科, 更多筛选, the chosen tag);
 *  - 热榜: 当前 · 本周 · 本月 and when the ranking was taken;
 *  - 简报: 日报 · 周报, and the issue's own 分类, 往期 and 复制 (`issue`);
 *  - 关注: the same filters and 「管理关注」 (with 「全部关注」 while one follow narrows the feed) — the filters only while a topic is
 *    followed, 「管理关注」 while anything is, and nothing while the reader follows nothing (`follow`);
 *  - 证据专区: 全部专区 · 我创建的 · 我关注的, the count of a search's matches and, for a reader who may make one, 「新建专区」 (`zones`);
 *  - 与我相关: nothing.
 *
 * The search is the feed's, in every view; in 证据专区 it searches the zones. The rows are in the shell's sticky band, so they stay at the
 * top while a feed of six thousand pixels scrolls under them — they used to scroll away, and a reader at the bottom of the 精选 feed had
 * to go back up to change the view. Below 640 px the search drops under the tabs, and on the second row the 栏目 chips scroll and
 * everything else is behind one 「筛选」 sheet.
 */
export function frontierToolbar({
  view, onView, filters, onFilters, showWindow, searching, search, tag, hotTags, hot, follow, narrowedFollow, onAllFollows, onManageFollows, issue, zones, onClear, onReset,
}: {
  view: PageView;
  onView: (view: PageView) => void;
  /** The feed's filter values and how they change (`FrontierFilters`). */
  filters: FrontierFilterValue;
  onFilters: (change: Partial<FrontierFilterValue>) => void;
  showWindow: boolean;
  searching: boolean;
  search: ToolbarSearch;
  /** The chosen tag, for its chip and its 「关注」. */
  tag: ChosenTag | null;
  /** The 「专科」 panel's 热门标签. */
  hotTags: HotTags;
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
  /** The directory's own controls (`zoneDirectoryControls`) and 「新建专区」, for the 证据专区 tab. */
  zones: { filters: ToolbarFilter[]; summary: string | undefined; onCreate: (() => void) | null };
  /** Lets go of the feed's filters and the search. */
  onClear: () => void;
  /** Lets go of the feed's filters, not the search (the 「筛选」 sheet's 「重置」). */
  onReset: () => void;
}): ToolbarProps {
  const feed = feedFilters({ value: filters, showWindow, searching, onChange: onFilters, tag, hotTags });
  let controls: ToolbarFilter[] = [];
  let actions: ReactNode;
  let summary: string | undefined;
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
        actions = <Button variant="text" size="sm" onClick={onManageFollows}>管理关注</Button>;
      }
      break;
    case "zones":
      controls = zones.filters;
      summary = zones.summary;
      if (zones.onCreate) actions = <Button variant="text" size="sm" onClick={zones.onCreate}>新建专区</Button>;
      break;
    default:
      break;
  }
  return {
    label: "动态筛选与搜索",
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
    onReset: clearable || view === "following" ? onReset : undefined,
    search,
    summary,
    actions,
    controlsBelow: true,
  };
}
