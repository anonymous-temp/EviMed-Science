import { Star } from "lucide-react";
import type { FilterOption } from "@/components/ui/FilterChips";
import type { ToolbarFilter } from "@/components/ui/Toolbar";
import { FRONTIER_CHANNEL_FILTERS, FRONTIER_LANES, FRONTIER_SPECIALTIES, FRONTIER_WINDOWS, type FrontierChannelFilter, type FrontierWindow } from "@/lib/frontierClient";

/**
 * The lanes in the order a reader looks for them (plan 2026-09-23 §6.2):
 * 临床证据, 指南共识, 药物安全, 审批监管, 研发产业, then the rest.
 */
const LANE_ORDER = ["evidence", "guideline", "safety", "regulatory", "pipeline"];
const LANE_OPTIONS: readonly FilterOption[] = Object.freeze(
  [...FRONTIER_LANES]
    .sort((a, b) => rank(a.key) - rank(b.key))
    .map((lane) => ({ value: lane.key, label: lane.label })),
);
const SPECIALTY_OPTIONS: readonly FilterOption[] = Object.freeze(FRONTIER_SPECIALTIES.map((specialty) => ({ value: specialty.key, label: specialty.label })));
const WINDOW_LABELS: Record<FrontierWindow, string> = { "24h": "24 小时", "3d": "3 天", "7d": "7 天", "30d": "30 天" };
const WINDOW_OPTIONS: readonly FilterOption<FrontierWindow>[] = Object.freeze(FRONTIER_WINDOWS.map((window) => ({ value: window, label: WINDOW_LABELS[window] })));
/** The kinds of outlet a reader tells apart (owner, 2026-10-22): which outlets each holds is the server's mapping. */
const CHANNEL_LABELS: Record<FrontierChannelFilter, string> = { literature: "文献", news: "资讯", social: "社媒", official: "官方" };
const CHANNEL_OPTIONS: readonly FilterOption<FrontierChannelFilter>[] = Object.freeze(FRONTIER_CHANNEL_FILTERS.map((channel) => ({ value: channel, label: CHANNEL_LABELS[channel] })));

/** The channel a link names (`?channel=`), or none. */
export function readChannel(value: string | null): FrontierChannelFilter | "" {
  return FRONTIER_CHANNEL_FILTERS.includes(value as FrontierChannelFilter) ? value as FrontierChannelFilter : "";
}

function rank(lane: string): number {
  const index = LANE_ORDER.indexOf(lane);
  return index === -1 ? LANE_ORDER.length : index;
}

export interface FrontierFilterValue {
  /** 文献, 资讯, 社媒 or 官方; every outlet when empty. */
  channel: FrontierChannelFilter | "";
  lane: string;
  specialty: string;
  starred: boolean;
  window: FrontierWindow | "";
  /** A search in time order rather than by relevance. */
  byTime: boolean;
}

/**
 * The feed's filters, as the toolbar declares them (plan 2026-10-07 §4; R19, audit D C1): 「全部渠道 ▾」 (文献 · 资讯 · 社媒 · 官方,
 * 2026-10-22), 「全部栏目 ▾」, 「全部专科 ▾」, in 全部
 * 「时间 ▾」, and 「☆ 收藏」. Each dimension is one menu — the lanes used to be a row of chips of their own, the second row of
 * controls above the first item. While searching, 「按时间」 orders the results newest first instead of by relevance. Declared and
 * not drawn: the page's `Toolbar` draws them, in the band that stays at the top, and folds them into one chip on a phone.
 */
export function feedFilters({ value, showWindow, searching, onChange }: {
  value: FrontierFilterValue;
  showWindow: boolean;
  searching: boolean;
  onChange: (next: Partial<FrontierFilterValue>) => void;
}): ToolbarFilter[] {
  return [
    ...(searching ? [{ kind: "toggle" as const, label: "按时间", pressed: value.byTime, onChange: (pressed: boolean) => onChange({ byTime: pressed }) }] : []),
    { kind: "select", label: "全部渠道", allLabel: "全部渠道", options: CHANNEL_OPTIONS, value: value.channel || null, onChange: (channel) => onChange({ channel: readChannel(channel) }) },
    { kind: "select", label: "全部栏目", allLabel: "全部栏目", options: LANE_OPTIONS, value: value.lane || null, onChange: (lane) => onChange({ lane: lane ?? "" }) },
    { kind: "select", label: "全部专科", allLabel: "全部专科", options: SPECIALTY_OPTIONS, value: value.specialty || null, onChange: (specialty) => onChange({ specialty: specialty ?? "" }) },
    ...(showWindow ? [{ kind: "select" as const, label: "时间", allLabel: "不限时间", options: WINDOW_OPTIONS, value: value.window || null, onChange: (window: string | null) => onChange({ window: (window ?? "") as FrontierWindow | "" }) }] : []),
    { kind: "toggle", label: "收藏", icon: Star, pressed: value.starred, onChange: (pressed) => onChange({ starred: pressed }) },
  ];
}
