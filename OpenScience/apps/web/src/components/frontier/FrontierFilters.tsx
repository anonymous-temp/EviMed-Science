import { Star } from "lucide-react";
import { cn } from "@/lib/cn";
import { FRONTIER_LANES, FRONTIER_SPECIALTIES, FRONTIER_WINDOWS, type FrontierWindow } from "@/lib/frontierClient";

/** The pill every filter row in the product wears (知识库, 科研工具). */
const PILL = "flex h-8 items-center gap-1.5 rounded-full border px-3 text-ui transition-colors duration-fast";
const PILL_ON = "border-text bg-surface-2 font-medium text-text";
const PILL_OFF = "border-border bg-surface text-muted hover:border-strong hover:text-text";

const WINDOW_LABELS: Record<FrontierWindow, string> = { "24h": "24 小时", "3d": "3 天", "7d": "7 天", "30d": "30 天" };

export interface FrontierFilterValue {
  lane: string;
  specialty: string;
  starred: boolean;
  window: FrontierWindow | "";
}

/**
 * The filter row (plan §4.2): the eight lanes as one single choice, the
 * specialty as a dropdown, 「只看收藏」, and — in 全部 only — the time window.
 * Every name is a reader's word; none is the implementation's.
 */
export function FrontierFilters({ value, showWindow, onChange }: {
  value: FrontierFilterValue;
  showWindow: boolean;
  onChange: (next: Partial<FrontierFilterValue>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="radiogroup" aria-label="栏目" className="flex flex-wrap items-center gap-1.5">
        {[{ key: "", label: "全部栏目" }, ...FRONTIER_LANES].map((lane) => {
          const selected = value.lane === lane.key;
          return (
            <button key={lane.key || "all"} type="button" role="radio" aria-checked={selected}
              onClick={() => onChange({ lane: lane.key })} className={cn(PILL, selected ? PILL_ON : PILL_OFF)}>
              {lane.label}
            </button>
          );
        })}
      </div>
      <label>
        <span className="sr-only">专科</span>
        <select value={value.specialty} onChange={(event) => onChange({ specialty: event.target.value })}
          className={cn(PILL, value.specialty ? PILL_ON : PILL_OFF)}>
          <option value="">全部专科</option>
          {FRONTIER_SPECIALTIES.map((specialty) => <option key={specialty.key} value={specialty.key}>{specialty.label}</option>)}
        </select>
      </label>
      <button type="button" aria-pressed={value.starred} onClick={() => onChange({ starred: !value.starred })}
        className={cn(PILL, value.starred ? PILL_ON : PILL_OFF)}>
        <Star size={16} aria-hidden="true" fill={value.starred ? "currentColor" : "none"} />只看收藏
      </button>
      {showWindow && (
        <div role="radiogroup" aria-label="时间范围" className="flex flex-wrap items-center gap-1.5">
          {(["", ...FRONTIER_WINDOWS] as const).map((window) => {
            const selected = value.window === window;
            return (
              <button key={window || "any"} type="button" role="radio" aria-checked={selected}
                onClick={() => onChange({ window })} className={cn(PILL, selected ? PILL_ON : PILL_OFF)}>
                {window ? WINDOW_LABELS[window] : "不限时间"}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
