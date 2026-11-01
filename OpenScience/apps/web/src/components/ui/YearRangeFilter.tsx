import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { FilterChip } from "@/components/ui/FilterChips";
import { Input } from "@/components/ui/Input";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";

export interface YearRangeFilterProps {
  label?: string;
  distribution?: readonly { year: number; count: number }[];
  startYear?: number;
  endYear?: number;
  onChange: (startYear: number | undefined, endYear: number | undefined) => void;
  busy?: boolean;
}

const MIN_YEAR = 1800;
const QUICK_YEARS = [1, 3, 5, 10] as const;

/** Vue's distribution uses three or four intervals, with integer shares totalling 100%. */
function bucketShares(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total) return values.map(() => 0);
  const shares = values.map(value => value > 0 ? Math.max(1, Math.floor(value / total * 100)) : 0);
  let assigned = shares.reduce((sum, value) => sum + value, 0);
  if (assigned > 100) {
    const ascending = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    for (const { index } of ascending) {
      while (assigned > 100 && shares[index] > 1) { shares[index]--; assigned--; }
    }
  } else {
    const remainders = values.map((value, index) => ({ value, index, remainder: value / total * 100 % 1 }))
      .filter(item => item.value > 0).sort((a, b) => b.remainder - a.remainder);
    for (let index = 0; assigned < 100; index++, assigned++) shares[remainders[index % remainders.length].index]++;
  }
  return shares;
}

function readYear(value: string): number | undefined {
  const text = value.trim();
  return !text ? undefined : /^\d{4}$/.test(text) ? Number(text) : NaN;
}

/** A compact year facet: every gesture edits a draft; only Apply or Clear requests results. */
export function YearRangeFilter({
  label = "发表年份", distribution, startYear, endYear, onChange, busy = false,
}: YearRangeFilterProps) {
  const id = useId();
  const currentYear = new Date().getFullYear();
  const maxYear = currentYear + 1;
  const [start, setStart] = useState(startYear?.toString() ?? "");
  const [end, setEnd] = useState(endYear?.toString() ?? "");
  const [error, setError] = useState("");

  useEffect(() => {
    setStart(startYear?.toString() ?? "");
    setEnd(endYear?.toString() ?? "");
    setError("");
  }, [startYear, endYear]);

  const buckets = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of distribution ?? []) {
      if (Number.isInteger(item.year) && item.year >= MIN_YEAR && item.year <= maxYear
        && Number.isFinite(item.count) && item.count >= 0) {
        counts.set(item.year, (counts.get(item.year) ?? 0) + item.count);
      }
    }
    const years = [...counts.keys()].sort((a, b) => a - b);
    if (!years.length) return [];
    // Keep the same ten-year lead-in and span-based grouping as TimelineFilter.vue.
    const first = Math.max(MIN_YEAR, years[0] - 10), last = years[years.length - 1];
    const span = last - first + 1;
    const bucketCount = Math.min(4, Math.max(3, Math.ceil(span / 24)));
    const step = Math.ceil(span / bucketCount);
    const result: { start: number; end: number; count: number }[] = [];
    for (let from = first; from <= last; from += step) {
      const to = Math.min(last, from + step - 1);
      let count = 0;
      for (let year = from; year <= to; year++) count += counts.get(year) ?? 0;
      result.push({ start: from, end: to, count });
    }
    const shares = bucketShares(result.map(bucket => bucket.count));
    return result.map((bucket, index) => ({ ...bucket, percent: shares[index] }));
  }, [distribution, maxYear]);

  const firstYear = buckets[0]?.start ?? Math.max(MIN_YEAR, currentYear - 25);
  const lastYear = buckets[buckets.length - 1]?.end ?? currentYear;
  const validYear = (value: number | undefined) => value !== undefined && Number.isInteger(value) && value >= MIN_YEAR && value <= maxYear;
  const parsedStart = readYear(start), parsedEnd = readYear(end);
  const sliderMin = Math.min(firstYear, validYear(parsedStart) ? parsedStart! : firstYear, validYear(parsedEnd) ? parsedEnd! : firstYear);
  const sliderStart = validYear(parsedStart) ? parsedStart! : sliderMin;
  const sliderMax = Math.max(lastYear, validYear(parsedStart) ? parsedStart! : lastYear, validYear(parsedEnd) ? parsedEnd! : lastYear);
  const sliderEnd = validYear(parsedEnd) ? parsedEnd! : sliderMax;
  const hasRange = startYear !== undefined || endYear !== undefined || start !== "" || end !== "";

  const draft = (from: string, to: string) => { setStart(from); setEnd(to); setError(""); };
  const apply = () => {
    if (busy) return;
    if ((parsedStart !== undefined && !validYear(parsedStart)) || (parsedEnd !== undefined && !validYear(parsedEnd))) {
      setError(`请输入 ${MIN_YEAR}—${maxYear} 之间的整数年份`);
      return;
    }
    if (parsedStart !== undefined && parsedEnd !== undefined && parsedStart > parsedEnd) {
      setError("开始年份不能晚于结束年份");
      return;
    }
    setError("");
    onChange(parsedStart, parsedEnd);
  };

  return (
    <fieldset className="min-w-0 space-y-3 border-t border-border pt-3 [&_label]:mb-1" aria-busy={busy || undefined}>
      <legend className="mb-3 text-ui font-semibold text-text">{label}</legend>
      <div role="group" aria-label="快捷年份" className="grid grid-cols-4 gap-1">
        {QUICK_YEARS.map((years) => <FilterChip key={years}
          aria-label={`近 ${years} 年`}
          pressed={parsedStart === Math.max(firstYear, lastYear - years + 1) && parsedEnd === lastYear}
          className="min-w-0 justify-center rounded px-1"
          onClick={() => draft(String(Math.max(firstYear, lastYear - years + 1)), String(lastYear))}>
          {years} 年
        </FilterChip>)}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Input label="开始年份" inputMode="numeric" placeholder="不限" maxLength={4}
            value={start} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
            className="h-sm px-2 tabular-nums" onChange={(event) => draft(event.target.value, end)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }} />
          <input type="range" aria-label="调整开始年份" min={sliderMin} max={sliderMax} step={1}
            aria-valuetext={`${sliderStart} 年`} value={sliderStart}
            onChange={(event) => draft(String(Math.min(Number(event.target.value), sliderEnd)), end || String(sliderEnd))}
            className="mt-1 block h-5 w-full cursor-ew-resize accent-accent" />
        </div>
        <div>
          <Input label="结束年份" inputMode="numeric" placeholder="不限" maxLength={4}
            value={end} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
            className="h-sm px-2 tabular-nums" onChange={(event) => draft(start, event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }} />
          <input type="range" aria-label="调整结束年份" min={sliderMin} max={sliderMax} step={1}
            aria-valuetext={`${sliderEnd} 年`} value={sliderEnd}
            onChange={(event) => draft(start || String(sliderStart), String(Math.max(Number(event.target.value), sliderStart)))}
            className="mt-1 block h-5 w-full cursor-ew-resize accent-accent" />
        </div>
      </div>
      {buckets.length > 0 && <div role="group" aria-label="按年份分布选择范围" className="space-y-1">
        <div className="text-ui font-semibold text-text">年份分布</div>
        {buckets.map((bucket) => {
          const selected = bucket.start >= (parsedStart ?? firstYear) && bucket.end <= (parsedEnd ?? lastYear);
          const years = bucket.start === bucket.end ? `${bucket.start} 年` : `${bucket.start}—${bucket.end} 年`;
          return <Tooltip key={bucket.start} content={`${years}：${bucket.count.toLocaleString("zh-CN")} 条（${bucket.percent}%）`}><Button variant="text" size="sm"
            aria-label={`选择 ${years}，共 ${bucket.count.toLocaleString("zh-CN")} 条`}
            aria-pressed={parsedStart === bucket.start && parsedEnd === bucket.end}
            onClick={() => draft(String(bucket.start), String(bucket.end))}
            className={cn("w-full min-w-0 justify-start gap-2 px-1", selected && "bg-accent-soft")}>
            <span className="w-20 shrink-0 text-left text-caption tabular-nums">{bucket.start}—{bucket.end}</span>
            <span aria-hidden="true" className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3" data-year-bar="">
              <span className={cn("block h-full rounded-full", selected ? "bg-accent" : "bg-text-graphic")}
                style={{ width: `${bucket.percent}%` }} />
            </span>
            <span className="w-10 shrink-0 text-right text-caption tabular-nums text-text-3">{bucket.percent}%</span>
          </Button></Tooltip>;
        })}
      </div>}
      {error && <p id={`${id}-error`} role="alert" className="text-caption text-error">{error}</p>}
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" className="min-w-0 flex-1" disabled={busy} onClick={apply}>应用年份</Button>
        <Button variant="text" size="sm" className="px-2" disabled={busy || !hasRange}
          onClick={() => { draft("", ""); onChange(undefined, undefined); }}>不限年份</Button>
      </div>
    </fieldset>
  );
}
