import { Star } from "lucide-react";
import { FilterChip, FilterSelect, type FilterOption } from "@/components/ui/FilterChips";
import { FRONTIER_LANES, FRONTIER_SPECIALTIES, FRONTIER_WINDOWS, type FrontierWindow } from "@/lib/frontierClient";

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

function rank(lane: string): number {
  const index = LANE_ORDER.indexOf(lane);
  return index === -1 ? LANE_ORDER.length : index;
}

export interface FrontierFilterValue {
  lane: string;
  specialty: string;
  starred: boolean;
  window: FrontierWindow | "";
  /** A search in time order rather than by relevance. */
  byTime: boolean;
}

/**
 * The feed's filters, as the controls at the end of the view row (plan
 * 2026-10-07 §4): 「全部栏目 ▾」, 「全部专科 ▾」, in 全部 「时间 ▾」, and
 * 「☆ 收藏」. Each dimension is one menu — the lanes used to be a row of chips
 * of their own, the second row of controls above the first item. While
 * searching, 「按时间」 orders the results newest first instead of by
 * relevance. Fragments, not a row: the page puts them beside its tabs.
 */
export function FrontierFilters({ value, showWindow, searching, onChange }: {
  value: FrontierFilterValue;
  showWindow: boolean;
  searching: boolean;
  onChange: (next: Partial<FrontierFilterValue>) => void;
}) {
  return (
    <>
      {searching && <FilterChip pressed={value.byTime} onClick={() => onChange({ byTime: !value.byTime })}>按时间</FilterChip>}
      <FilterSelect label="全部栏目" allLabel="全部栏目" options={LANE_OPTIONS} value={value.lane || null}
        onChange={(lane) => onChange({ lane: lane ?? "" })} />
      <FilterSelect label="全部专科" allLabel="全部专科" options={SPECIALTY_OPTIONS} value={value.specialty || null}
        onChange={(specialty) => onChange({ specialty: specialty ?? "" })} />
      {showWindow && (
        <FilterSelect label="时间" allLabel="不限时间" options={WINDOW_OPTIONS} value={value.window || null}
          onChange={(window) => onChange({ window: window ?? "" })} />
      )}
      <FilterChip icon={Star} pressed={value.starred} onClick={() => onChange({ starred: !value.starred })}>收藏</FilterChip>
    </>
  );
}
