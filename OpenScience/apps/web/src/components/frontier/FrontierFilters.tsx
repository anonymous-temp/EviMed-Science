import { useEffect, useState } from "react";
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

/** Below Tailwind's `sm`: a phone, where six lane chips and the row's end do not fit on one line. */
const NARROW = "(max-width: 639px)";

function useNarrow(): boolean {
  const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [narrow, setNarrow] = useState(() => supported && window.matchMedia(NARROW).matches);
  useEffect(() => {
    if (!supported) return;
    const media = window.matchMedia(NARROW);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [supported]);
  return narrow;
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
 * second row — on a phone the lanes fold into one chip that names the lane
 * chosen (「全部 ▾」), since six chips clipped at the screen's edge would
 * hide 「更多」 and every lane behind it.
 */
export function FrontierFilters({ value, showWindow, searching, onChange }: {
  value: FrontierFilterValue;
  showWindow: boolean;
  searching: boolean;
  onChange: (next: Partial<FrontierFilterValue>) => void;
}) {
  const narrow = useNarrow();
  return (
    <FilterChips
      label="栏目"
      options={LANE_OPTIONS}
      value={value.lane}
      maxVisible={narrow ? 0 : 6}
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
