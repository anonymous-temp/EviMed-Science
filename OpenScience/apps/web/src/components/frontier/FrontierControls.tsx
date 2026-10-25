import type { ReactNode } from "react";
import type { FrontierHotBoard, FrontierHotWindow } from "@/lib/frontierClient";
import { Button } from "@/components/ui/Button";
import type { TabItem } from "@/components/ui/Tabs";
import type { ToolbarAction, ToolbarFilter, ToolbarProps, ToolbarSearch, ToolbarToken } from "@/components/ui/Toolbar";
import { feedFilters, tagToken, type ChosenTag, type FrontierFilterValue, type HotTags } from "./FrontierFilters";
import { hotWindowFilter } from "./FrontierHot";

/**
 * What the page is showing. `weekly` is the 简报 tab's second period, `daily` its first. 与我相关 is the first entry of 关注
 * (`?view=following&follow=foryou`, owner 2026-10-25: 「那就是订阅关注吧」); an older `?view=foryou` opens it.
 */
export type PageView = "selected" | "hot" | "daily" | "all" | "following" | "weekly" | "zones" | "track";

/**
 * The peer views (owner, 2026-10-25): the three lists of items, which share 「筛选」, first — everyone's selection, everything, the
 * reader's own — then the ranking of events, the issues and the zones, each with its few controls.
 */
export const FRONTIER_VIEWS: readonly TabItem<PageView>[] = [
  { value: "selected", label: "精选" },
  { value: "all", label: "全部" },
  { value: "following", label: "关注" },
  { value: "hot", label: "热榜" },
  { value: "track", label: "追踪" },
  { value: "daily", label: "简报" },
  { value: "zones", label: "证据专区" },
];

/** What the 关注 view has open: the ranked 与我相关, the whole of the follows, one follow (its id) or one followed zone. */
export type FollowChoice = { kind: "foryou" } | { kind: "all" } | { kind: "follow"; id: string } | { kind: "zone"; id: string };

/**
 * The page's controls, as the `Toolbar` of the page shell takes it (owner, 2026-10-25: 「不要横着罗列着，顶上弄好几行」): one row on
 * every view — the views at the left, the open view's controls at its right and the search last (`oneRow`):
 *
 *  - 精选 / 全部, and 关注 while it lists items: what is applied as tokens (the chosen tag with its 「关注」), then 「筛选」, which holds
 *    the feed's filters (`feedFilters`); while searching, 「按时间」;
 *  - 热榜: 当前 · 本周 · 本月 and when the ranking was taken;
 *  - 简报: 日报 · 周报, and the issue's own 分类, 往期 and 复制 (`issue`);
 *  - 追踪 (c3-track): 审批 · 指南 · 会议 and, where it fits, one filter (the agency, the specialty) — `trackControls`;
 *  - 证据专区: the scope menu (全部专区 · 我创建的 · 我关注的), the count of a search's matches and, for a reader who may make one,
 *    「新建专区」 (`zones`).
 *
 * The followed things are 关注's own column on a wide screen; on a phone they are the first section of the 「筛选」 sheet
 * (`followList`), and the one follow the list is narrowed to is a token (「只看：肿瘤」). On a phone the views scroll beside the
 * 「筛选」 and search icons; 热榜's window and 简报's 日报 | 周报 stay in sight on the line under them (`pinned`). The search is the
 * feed's, in every view; in 证据专区 it searches the zones. The row is in the shell's sticky band, so it stays at the top while a feed
 * of six thousand pixels scrolls under it.
 */
export function frontierToolbar({
  view, onView, filters, onFilters, showWindow, searching, search, tag, hotTags, specialtyFollow, hot, following, issue, zones, track, onClear, onReset,
}: {
  view: PageView;
  onView: (view: PageView) => void;
  /** The feed's filter values and how they change (`FrontierFilters`). */
  filters: FrontierFilterValue;
  onFilters: (change: Partial<FrontierFilterValue>) => void;
  showWindow: boolean;
  searching: boolean;
  search: ToolbarSearch;
  /** The chosen tag, for its token and its 「关注」. */
  tag: ChosenTag | null;
  /** 专科's 热门标签. */
  hotTags: HotTags;
  /** A chosen specialty's 「关注」 in the panel. */
  specialtyFollow?: (key: string) => ToolbarAction | null;
  hot: {
    window: FrontierHotWindow;
    /** The ranking on screen, for the time it was taken. */
    board: FrontierHotBoard | null;
    /** Whether the server stamps its rankings, so that 本周 and 本月 mean something. */
    windows: boolean;
    onWindow: (window: FrontierHotWindow) => void;
  };
  /** The 关注 view: whether its list has filters to offer, the token of a narrowed follow, and the list of follows for a phone's sheet. */
  following: {
    feed: boolean;
    token: ToolbarToken | null;
    followList: ((close: () => void) => ReactNode) | undefined;
  };
  /** The issue on screen's own controls (`dailyControls`), for the 简报 tab. */
  issue: { filters: ToolbarFilter[]; actions: ReactNode };
  /** The directory's own controls (`zoneDirectoryControls`) and 「新建专区」, for the 证据专区 tab. */
  zones: { filters: ToolbarFilter[]; summary: string | undefined; onCreate: (() => void) | null };
  /** The 追踪 tab's controls (`trackControls`): its segment and the one filter of that segment. */
  track: { filters: ToolbarFilter[] };
  /** Lets go of the feed's filters and the search. */
  onClear: () => void;
  /** Lets go of the feed's filters, not the search (「筛选」's 「清除」 and the sheet's 「重置」). */
  onReset: () => void;
}): ToolbarProps {
  const feed = feedFilters({ value: filters, showWindow, searching, onChange: onFilters, hotTags, specialtyFollow });
  const chosenTag = tag ? [tagToken(tag, () => onFilters({ tag: "" }))] : [];
  let controls: ToolbarFilter[] = [];
  let tokens: ToolbarToken[] = [];
  let actions: ReactNode;
  let summary: string | undefined;
  let clearable = false;
  let sheetLead: ((close: () => void) => ReactNode) | undefined;
  switch (view) {
    case "selected":
    case "all":
      controls = feed;
      tokens = chosenTag;
      clearable = true;
      break;
    case "following":
      if (following.feed) {
        controls = feed;
        tokens = chosenTag;
        clearable = true;
      }
      if (following.token) tokens = [following.token, ...tokens];
      sheetLead = following.followList;
      break;
    case "hot":
      controls = hot.windows ? [{ ...hotWindowFilter({ window: hot.window, board: hot.board, onWindow: hot.onWindow }), pinned: true }] : [];
      break;
    case "daily":
    case "weekly":
      controls = [
        { kind: "chips", label: "简报周期", pinned: true, options: [{ value: "daily", label: "日报" }, { value: "weekly", label: "周报" }], value: view, onChange: (next) => onView(next as PageView) },
        ...issue.filters,
      ];
      actions = issue.actions;
      break;
    case "track":
      controls = track.filters;
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
      items: FRONTIER_VIEWS,
      value: view === "weekly" ? "daily" : view,
      // The 简报 tab is the daily and the weekly: pressing it on the weekly stays there.
      onChange: (next) => { if (!(next === "daily" && view === "weekly")) onView(next as PageView); },
      panelId: "frontier-view",
    },
    filters: controls,
    tokens,
    sheetLead,
    onClear: clearable ? onClear : undefined,
    onReset: clearable ? onReset : undefined,
    search,
    summary,
    actions,
    oneRow: true,
    searchShortcut: true,
  };
}
