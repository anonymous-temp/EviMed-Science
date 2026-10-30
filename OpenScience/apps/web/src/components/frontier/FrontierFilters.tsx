import type { FilterOption } from "@/components/ui/FilterChips";
import type { ToolbarAction, ToolbarFilter, ToolbarPanel, ToolbarToken } from "@/components/ui/Toolbar";
import {
  FRONTIER_CHANNEL_FILTERS,
  FRONTIER_EVIDENCE_TYPES,
  FRONTIER_INDUSTRY_KIND_OPTIONS,
  FRONTIER_LANES,
  FRONTIER_SPECIALTIES,
  FRONTIER_SPECIALTY_GROUPS,
  FRONTIER_WINDOWS,
  readSpecialtyKey,
  type FrontierChannelFilter,
  type FrontierIndustryKind,
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
/**
 * The kinds of 行业动态 (c5-biz 2026-10-26), one more choice of the panel: choosing one narrows to 行业动态 of that kind. 「其他」 is
 * a kind an item has and the list says nothing of (its card shows no kind), so it is not one to ask for: it would be the rest of
 * the genre with a name that says nothing, and the genre itself (栏目) already is that.
 */
const FILTER_INDUSTRY_KINDS = Object.freeze(FRONTIER_INDUSTRY_KIND_OPTIONS.filter((kind) => kind.key !== "other"));
const INDUSTRY_KIND_OPTIONS: readonly FilterOption[] = Object.freeze([{ value: "", label: "全部" }, ...FILTER_INDUSTRY_KINDS.map((kind) => ({ value: kind.key, label: kind.label }))]);
const INDUSTRY_KIND_KEYS: ReadonlySet<string> = new Set(FILTER_INDUSTRY_KINDS.map((kind) => kind.key));
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

/** The kind of 行业动态 a link names (`?kind=`), or none; 「其他」 is not one a link can ask for (`FILTER_INDUSTRY_KINDS`). */
export function readIndustryKind(value: string | null): FrontierIndustryKind | "" {
  return value && INDUSTRY_KIND_KEYS.has(value) ? value as FrontierIndustryKind : "";
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
  /** One kind of 行业动态 (it implies the genre); every item when empty. */
  industryKind: FrontierIndustryKind | "";
  starred: boolean;
  /** Only what this reader has not opened. */
  unread: boolean;
  window: FrontierWindow | "";
  /** A search in time order rather than by relevance. */
  byTime: boolean;
}

/** Every filter let go of (the search is the page's). */
export const NO_FILTERS: Omit<FrontierFilterValue, "byTime"> = Object.freeze({
  channel: "", lane: "", specialties: [], tag: "", evidence: "", industryKind: "", starred: false, unread: false, window: "",
}) as Omit<FrontierFilterValue, "byTime">;

/** 「专科」's token: the one chosen (「肿瘤」), or the first and how many (「肿瘤 等 3 个」). */
export function specialtyChoice(specialties: readonly string[]): string | undefined {
  if (specialties.length === 0) return undefined;
  const first = SPECIALTY_LABELS[specialties[0]] ?? specialties[0];
  return specialties.length === 1 ? first : `${first} 等 ${specialties.length} 个`;
}

/** A specialty's name as the reader sees it. */
export function specialtyLabel(key: string): string {
  return SPECIALTY_LABELS[key] ?? key;
}

/** 专科's second level: the chosen specialties' tags most used in 30 days — still being read, or read. */
export interface HotTags {
  loading: boolean;
  tags: readonly FrontierTagCount[];
}

/** The chosen tag's token and its 「关注」. */
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
 * The feed's filters (owner, 2026-10-25: 「不要横着罗列着，顶上弄好几行」), declared for the page's `Toolbar`, which keeps every one of
 * them inside its one 「筛选」 (`folded`) and says what is on as tokens on the views' own row. The panel, in the order a reader narrows
 * by (NN/g: the general first):
 *
 *  - 栏目, one choice that applies at once, and — beside it — 行业动态, the kinds of business news (交易与授权, 融资与上市, 人事与组织,
 *    公司经营, 研发管线; c5-biz), one choice that applies at once and narrows to 行业动态 of that kind, said on the row as
 *    「行业动态 · 融资与上市」;
 *  - 专科, the thirty grouped as the domain groups them, several at once, each chosen one with its 「关注」 / 「已关注」
 *    (`specialtyFollow`); once one is chosen their 热门标签 (one at once, which sets the tag — the page's own token, so the group is
 *    quiet);
 *  - 来源, 证据类型, 时间 (in 全部) and the switch 只看收藏.
 *
 * 只看未读 is not here: it is on the list's first day header (`FeedList`), as AIHOT's timeline has it. While searching, 「按时间」 is a
 * toggle on the row. The chosen tag is the page's token (`tagToken`), with its 「关注」.
 */
export function feedFilters({ value, showWindow, searching, onChange, hotTags, specialtyFollow }: {
  value: FrontierFilterValue;
  showWindow: boolean;
  searching: boolean;
  onChange: (next: Partial<FrontierFilterValue>) => void;
  hotTags: HotTags;
  /** A chosen specialty's 「关注」, or null where the reader's follows are not known. */
  specialtyFollow?: (key: string) => ToolbarAction | null;
}): ToolbarFilter[] {
  const hot = hotTags.tags.map((entry) => ({ value: entry.slug, label: `#${entry.name}` }));
  const specialty: ToolbarPanel = {
    kind: "panel",
    label: "专科",
    folded: true,
    groups: [
      { kind: "chips", multi: true, label: "专科", options: SPECIALTY_OPTIONS, sections: SPECIALTY_SECTIONS, value: value.specialties,
        onChange: (specialties: string[]) => onChange({ specialties }), chosenAction: specialtyFollow },
      ...(value.specialties.length > 0 ? [{
        kind: "chips" as const,
        label: "热门标签",
        options: hot,
        quiet: true,
        // Pressed only where it is one of them: a tag chosen elsewhere is the row's own token.
        value: hot.some((option) => option.value === value.tag) ? value.tag : "",
        neutral: "",
        placeholder: hotTags.loading ? "正在读取" : "暂无热门标签",
        onChange: (next: string) => onChange({ tag: next }),
      }] : []),
    ],
    onClear: () => onChange({ specialties: [], tag: "" }),
  };
  return [
    { kind: "chips", label: "栏目", folded: true, options: LANE_OPTIONS, value: value.lane, neutral: "", onChange: (lane) => onChange({ lane }) },
    { kind: "chips", label: "行业动态", tokenPrefix: "行业动态", folded: true, options: INDUSTRY_KIND_OPTIONS, value: value.industryKind, neutral: "",
      onChange: (industryKind: string) => onChange({ industryKind: readIndustryKind(industryKind) }) },
    specialty,
    { kind: "chips", label: "来源", folded: true, options: CHANNEL_OPTIONS, value: value.channel, neutral: "", onChange: (channel: string) => onChange({ channel: readChannel(channel) }) },
    { kind: "chips", label: "证据类型", folded: true, options: EVIDENCE_OPTIONS, value: value.evidence, neutral: "", onChange: (evidence: string) => onChange({ evidence: readEvidence(evidence) }) },
    ...(showWindow ? [{ kind: "chips" as const, label: "时间", folded: true, options: WINDOW_OPTIONS, value: value.window, neutral: "",
      onChange: (window: string) => onChange({ window: (FRONTIER_WINDOWS.includes(window as FrontierWindow) ? window : "") as FrontierWindow | "" }) }] : []),
    { kind: "toggle", label: "只看收藏", folded: true, pressed: value.starred, onChange: (starred: boolean) => onChange({ starred }) },
    ...(searching ? [{ kind: "toggle" as const, label: "按时间", pressed: value.byTime, onChange: (pressed: boolean) => onChange({ byTime: pressed }) }] : []),
  ];
}

/** The chosen tag as the row's token: a press lets go of it, and 「关注」 / 「已关注」 beside it once the reader's follows are known. */
export function tagToken(tag: ChosenTag, onRemove: () => void): ToolbarToken {
  return {
    label: `#${tag.name}`,
    filter: true,
    onRemove,
    action: tag.followed === null ? undefined : { label: tag.followed ? "已关注" : "关注", disabled: tag.followed || tag.following, onClick: tag.onFollow },
  };
}
