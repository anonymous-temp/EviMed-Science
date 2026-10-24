import { X } from "lucide-react";
import type { FilterOption } from "@/components/ui/FilterChips";
import type { ToolbarFilter, ToolbarPanel } from "@/components/ui/Toolbar";
import {
  FRONTIER_CHANNEL_FILTERS,
  FRONTIER_EVIDENCE_TYPES,
  FRONTIER_LANES,
  FRONTIER_SPECIALTIES,
  FRONTIER_SPECIALTY_GROUPS,
  FRONTIER_WINDOWS,
  readSpecialtyKey,
  type FrontierChannelFilter,
  type FrontierTagCount,
  type FrontierWindow,
} from "@/lib/frontierClient";

/**
 * The lanes in the order a reader looks for them (plan 2026-09-23 §6.2):
 * 临床证据, 指南共识, 药物安全, 审批监管, 研发产业, then the rest.
 */
const LANE_ORDER = ["evidence", "guideline", "safety", "regulatory", "pipeline"];
const LANE_OPTIONS: readonly FilterOption[] = Object.freeze([
  { value: "", label: "全部" },
  ...[...FRONTIER_LANES]
    .sort((a, b) => rank(a.key) - rank(b.key))
    .map((lane) => ({ value: lane.key, label: lane.label })),
]);
const SPECIALTY_OPTIONS: readonly FilterOption[] = Object.freeze(FRONTIER_SPECIALTIES.map((specialty) => ({ value: specialty.key, label: specialty.label })));
const SPECIALTY_SECTIONS = Object.freeze(FRONTIER_SPECIALTY_GROUPS.map((group) => ({ label: group.label, values: group.specialties })));
const SPECIALTY_LABELS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(FRONTIER_SPECIALTIES.map((specialty) => [specialty.key, specialty.label])));
const WINDOW_LABELS: Record<FrontierWindow, string> = { "24h": "24 小时", "3d": "3 天", "7d": "7 天", "30d": "30 天" };
const WINDOW_OPTIONS: readonly FilterOption[] = Object.freeze([{ value: "", label: "不限" }, ...FRONTIER_WINDOWS.map((window) => ({ value: window, label: WINDOW_LABELS[window] }))]);
/** The kinds of outlet a reader tells apart (owner, 2026-10-22): which outlets each holds is the server's mapping. */
const CHANNEL_LABELS: Record<FrontierChannelFilter, string> = { literature: "文献", news: "资讯", social: "社媒", official: "官方" };
const CHANNEL_OPTIONS: readonly FilterOption[] = Object.freeze([{ value: "", label: "全部" }, ...FRONTIER_CHANNEL_FILTERS.map((channel) => ({ value: channel, label: CHANNEL_LABELS[channel] }))]);
const EVIDENCE_OPTIONS: readonly FilterOption[] = Object.freeze([{ value: "", label: "全部" }, ...FRONTIER_EVIDENCE_TYPES.map((type) => ({ value: type.key, label: type.label }))]);
const EVIDENCE_KEYS: ReadonlySet<string> = new Set(FRONTIER_EVIDENCE_TYPES.map((type) => type.key));
/** A tag's slug as an address carries it (the server's form: lower-case letters, digits and dashes); anything else names no tag. */
const TAG_SLUG = /^[a-z0-9][a-z0-9-]{1,79}$/;

function rank(lane: string): number {
  const index = LANE_ORDER.indexOf(lane);
  return index === -1 ? LANE_ORDER.length : index;
}

/** The channel a link names (`?channel=`), or none. */
export function readChannel(value: string | null): FrontierChannelFilter | "" {
  return FRONTIER_CHANNEL_FILTERS.includes(value as FrontierChannelFilter) ? value as FrontierChannelFilter : "";
}

/**
 * The specialties a link names (`?specialty=a,b`, or the single one of an older link): each read through `readSpecialtyKey`, so a
 * retired key is its successor or nothing; each once, in the order given.
 */
export function readSpecialties(value: string | null): string[] {
  const keys: string[] = [];
  for (const part of (value ?? "").split(",")) {
    const key = readSpecialtyKey(part.trim());
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** The evidence type a link names (`?evidence=`), or none. */
export function readEvidence(value: string | null): string {
  return value && EVIDENCE_KEYS.has(value) ? value : "";
}

/** The tag a link names (`?tag=<slug>`), or none. */
export function readTag(value: string | null): string {
  const slug = value?.trim() ?? "";
  return TAG_SLUG.test(slug) ? slug : "";
}

export interface FrontierFilterValue {
  /** 文献, 资讯, 社媒 or 官方; every outlet when empty. */
  channel: FrontierChannelFilter | "";
  lane: string;
  /** Any of these specialties; every one when empty. */
  specialties: string[];
  /** One tag's slug; none when empty. */
  tag: string;
  /** One evidence type; every one when empty. */
  evidence: string;
  starred: boolean;
  /** Only what this reader has not opened. */
  unread: boolean;
  window: FrontierWindow | "";
  /** A search in time order rather than by relevance. */
  byTime: boolean;
}

/** Every filter let go of (the search is the page's). */
export const NO_FILTERS: Omit<FrontierFilterValue, "byTime"> = Object.freeze({
  channel: "", lane: "", specialties: [], tag: "", evidence: "", starred: false, unread: false, window: "",
}) as Omit<FrontierFilterValue, "byTime">;

/** 「专科」's chip: the one chosen (「肿瘤」), or the first and how many (「肿瘤 等 3 个」). */
export function specialtyChoice(specialties: readonly string[]): string | undefined {
  if (specialties.length === 0) return undefined;
  const first = SPECIALTY_LABELS[specialties[0]] ?? specialties[0];
  return specialties.length === 1 ? first : `${first} 等 ${specialties.length} 个`;
}

/** The 「专科」 panel's second level: the chosen specialties' tags most used in 30 days — still being read, or read. */
export interface HotTags {
  loading: boolean;
  tags: readonly FrontierTagCount[];
}

/** The chosen tag's chip and its 「关注」. */
export interface ChosenTag {
  slug: string;
  /** Its name, once known; the slug until then. */
  name: string;
  /** Whether the reader follows it; null while that is not known, and no 「关注」 is offered. */
  followed: boolean | null;
  following: boolean;
  onFollow: () => void;
}

/**
 * The feed's filters (owner, 2026-10-23), declared for the page's `Toolbar`, which draws them on the band's second row:
 *
 *  - 栏目 as a row of chips, one choice that applies at once — all nine in sight on a wide screen, a row that scrolls on a phone;
 *  - 「专科 ▾」, a panel of the thirty specialties grouped as the domain groups them (several at once) and, once one is chosen, their
 *    「热门标签」 (one at once, which sets the tag); the chip reads the choice (「肿瘤 等 3 个」) and the panel has its 「清除」;
 *  - 「更多筛选 ▾」, a panel of 来源 (the old 全部渠道), 证据类型, 时间 (in 全部) and the switches 只看收藏 and 只看未读;
 *  - the chosen tag, 「#肝细胞癌 ×」 (a press lets go of it), with 「关注」 beside it;
 *  - while searching, 「按时间」.
 *
 * On a phone the 栏目 row and the chosen tag stay on the row and the rest fold into the toolbar's one 「筛选」 sheet, where 专科 keeps
 * its groups and 热门标签, 来源, 证据类型, 时间 and the switches follow.
 */
export function feedFilters({ value, showWindow, searching, onChange, tag, hotTags }: {
  value: FrontierFilterValue;
  showWindow: boolean;
  searching: boolean;
  onChange: (next: Partial<FrontierFilterValue>) => void;
  /** The chosen tag, or null. */
  tag: ChosenTag | null;
  hotTags: HotTags;
}): ToolbarFilter[] {
  const hot = hotTags.tags.map((entry) => ({ value: entry.slug, label: `#${entry.name}` }));
  const specialty: ToolbarPanel = {
    kind: "panel",
    label: "专科",
    chosen: specialtyChoice(value.specialties),
    groups: [
      { kind: "chips", multi: true, label: "专科", options: SPECIALTY_OPTIONS, sections: SPECIALTY_SECTIONS, value: value.specialties, onChange: (specialties: string[]) => onChange({ specialties }) },
      ...(value.specialties.length > 0 ? [{
        kind: "chips" as const,
        label: "热门标签",
        options: hot,
        // Pressed only where it is one of them: a tag chosen elsewhere is its own chip on the row.
        value: hot.some((option) => option.value === value.tag) ? value.tag : "",
        neutral: "",
        placeholder: hotTags.loading ? "正在读取" : "暂无热门标签",
        onChange: (next: string) => onChange({ tag: next }),
      }] : []),
    ],
    onClear: () => onChange({ specialties: [], tag: "" }),
  };
  const more: ToolbarPanel = {
    kind: "panel",
    label: "更多筛选",
    groups: [
      { kind: "chips", label: "来源", options: CHANNEL_OPTIONS, value: value.channel, neutral: "", onChange: (channel: string) => onChange({ channel: readChannel(channel) }) },
      { kind: "chips", label: "证据类型", options: EVIDENCE_OPTIONS, value: value.evidence, neutral: "", onChange: (evidence: string) => onChange({ evidence: readEvidence(evidence) }) },
      ...(showWindow ? [{ kind: "chips" as const, label: "时间", options: WINDOW_OPTIONS, value: value.window, neutral: "", onChange: (window: string) => onChange({ window: (FRONTIER_WINDOWS.includes(window as FrontierWindow) ? window : "") as FrontierWindow | "" }) }] : []),
      { kind: "toggle", label: "只看收藏", pressed: value.starred, onChange: (starred: boolean) => onChange({ starred }) },
      { kind: "toggle", label: "只看未读", pressed: value.unread, onChange: (unread: boolean) => onChange({ unread }) },
    ],
    onClear: () => onChange({ channel: "", evidence: "", window: "", starred: false, unread: false }),
  };
  return [
    // Pinned: on a phone the nine chips stay on the row as a row that scrolls, and only the panels fold.
    { kind: "chips", label: "栏目", pinned: true, scroll: true, options: LANE_OPTIONS, value: value.lane, neutral: "", onChange: (lane) => onChange({ lane }) },
    specialty,
    more,
    ...(tag ? [{
      kind: "toggle" as const,
      label: `#${tag.name}`,
      icon: X,
      iconEnd: true,
      pressed: true,
      pinned: true,
      onChange: () => onChange({ tag: "" }),
      action: tag.followed === null ? undefined : { label: tag.followed ? "已关注" : "关注", disabled: tag.followed || tag.following, onClick: tag.onFollow },
    }] : []),
    ...(searching ? [{ kind: "toggle" as const, label: "按时间", pressed: value.byTime, onChange: (pressed: boolean) => onChange({ byTime: pressed }) }] : []),
  ];
}
