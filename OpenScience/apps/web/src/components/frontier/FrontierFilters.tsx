import { Star } from "lucide-react";
import { FilterChip, FilterChips, FilterSelect, type FilterOption } from "@/components/ui/FilterChips";
import { FRONTIER_LANES, FRONTIER_SPECIALTIES, FRONTIER_WINDOWS, type FrontierWindow } from "@/lib/frontierClient";

/**
 * The lanes in the order a reader looks for them (plan 2026-09-23 §6.2):
 * the five the row shows — 临床证据, 指南共识, 药物安全, 审批监管, 研发产业 —
 * then the rest, which 「更多 ▾」 holds.
 */
const LANE_ORDER = ["evidence", "guideline", "safety", "regulatory", "pipeline"];
const LANE_OPTIONS: readonly FilterOption[] = Object.freeze([
  { value: "", label: "全部" },
  ...[...FRONTIER_LANES]
    .sort((a, b) => rank(a.key) - rank(b.key))
    .map((lane) => ({ value: lane.key, label: lane.label })),
]);
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
 * The filter row (plan §6.2): one row of quiet chips — 全部 and five lanes,
 * the rest in 「更多 ▾」 — and at its end 「专科 ▾」, in 全部 「时间 ▾」, and
 * 「☆ 收藏」. While searching, 「按时间」 orders the results newest first
 * instead of by relevance. One dimension, one control; nothing wraps into a
 * second row.
 */
export function FrontierFilters({ value, showWindow, searching, onChange }: {
  value: FrontierFilterValue;
  showWindow: boolean;
  searching: boolean;
  onChange: (next: Partial<FrontierFilterValue>) => void;
}) {
  return (
    <FilterChips
      label="栏目"
      options={LANE_OPTIONS}
      value={value.lane}
      onChange={(lane) => onChange({ lane })}
      trailing={(
        <>
          {searching && <FilterChip pressed={value.byTime} onClick={() => onChange({ byTime: !value.byTime })}>按时间</FilterChip>}
          <FilterSelect label="专科" allLabel="全部专科" options={SPECIALTY_OPTIONS} value={value.specialty || null}
            onChange={(specialty) => onChange({ specialty: specialty ?? "" })} />
          {showWindow && (
            <FilterSelect label="时间" allLabel="不限时间" options={WINDOW_OPTIONS} value={value.window || null}
              onChange={(window) => onChange({ window: window ?? "" })} />
          )}
          <FilterChip icon={Star} pressed={value.starred} onClick={() => onChange({ starred: !value.starred })}>收藏</FilterChip>
        </>
      )}
    />
  );
}
