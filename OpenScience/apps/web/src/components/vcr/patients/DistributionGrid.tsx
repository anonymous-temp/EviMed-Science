import { CircleCheck, TriangleAlert } from "lucide-react";
import type { VcrGeneratedRow } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { declaredCentre, declaredShare, expectedCounts, limitState } from "./distribution";
import { numberText } from "../vcrText";

/**
 * Each generated variable against what the study declared for it, as small multiples (R19, plan §5.3 人群 / 虚拟患者; audit B §4.4).
 *
 * A continuous variable is its histogram in the engine's own bins, with the declared distribution's counts drawn as a tick on every
 * bar (`expectedCounts`: the same shape on the same area, so a bounded variable is not blamed for being bounded); a categorical or
 * binary one is a bar per level, with the declared share marked when there was one. Under it, in numbers: what came out, what was
 * declared, and — from the engine's count, never worked out here — whether any record broke the variable's limits.
 *
 * Hidden knowledge:
 *  - **A withheld level stays withheld.** A synthetic table made from real people hides a level a handful of them share; its row
 *    says 「小样本已隐藏」 where a share would be, and no bar is drawn for it.
 *  - **The mark is the engine's.** ✓ is `violations === 0` (limits declared, none broken), ⚠ is `violations > 0` or the
 *    values passing a declared bound. A variable that declared no limit has neither: nothing was checked.
 *  - Decoration for a screen reader: the bars are `aria-hidden`; the numbers beside them say the same in words.
 */
export function DistributionGrid({ rows, className }: { rows: readonly VcrGeneratedRow[]; className?: string }) {
  const drawn = rows.filter((row) => row.histogram || (row.levels && row.levels.length > 0));
  if (drawn.length === 0) return null;
  return (
    <div data-vcr-distributions="" className={cn("grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2", className)}>
      {drawn.map((row) => <DistributionCard key={row.key} row={row} />)}
    </div>
  );
}

function DistributionCard({ row }: { row: VcrGeneratedRow }) {
  const state = limitState(row);
  const continuous = row.kind === "continuous" || (row.histogram !== null && !row.levels);
  const stats = continuous
    ? [row.mean !== null ? `均数 ${numberText(row.mean)}` : null, row.sd !== null ? `标准差 ${numberText(row.sd)}` : null].filter(Boolean).join(" · ")
    : row.levels && row.levels.length > 0 ? "" : row.result ?? "";
  return (
    <section data-vcr-distribution={row.variable} className="min-w-0">
      <h4 className="truncate text-ui font-semibold text-text">{row.label}</h4>
      <div className="mt-2">{continuous && row.histogram ? <Bins row={row} /> : <Levels row={row} />}</div>
      {stats && <p className="mt-1.5 text-caption tabular-nums text-text-2">{stats}</p>}
      {row.missing && <p className="text-caption tabular-nums text-text-3">{row.missing}</p>}
      {row.declared && (
        <p data-vcr-declared="" className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-caption text-text-3">
          <span>{`设定 ${row.declared}`}</span>
          {state && (
            <span data-vcr-limit={state.ok ? "ok" : "broken"} className={cn("inline-flex items-center gap-1", state.ok ? "text-ok" : "text-warn-strong")}>
              {state.ok ? <CircleCheck size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}
              {state.text}
            </span>
          )}
        </p>
      )}
      {!row.declared && state && (
        <p className={cn("mt-0.5 inline-flex items-center gap-1 text-caption", state.ok ? "text-ok" : "text-warn-strong")}>
          {state.ok ? <CircleCheck size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}
          {state.text}
        </p>
      )}
    </section>
  );
}

/** The histogram: a bar per bin, the tallest as high as the plot, and the declaration's own count for the bin as a tick on it. */
function Bins({ row }: { row: VcrGeneratedRow }) {
  const histogram = row.histogram;
  if (!histogram) return null;
  const total = histogram.counts.reduce((sum, count) => sum + count, 0);
  const expected = expectedCounts(row.declaredSpec, histogram.breaks, total);
  const tallest = Math.max(1, ...histogram.counts, ...(expected ?? []));
  const centre = declaredCentre(row.declaredSpec);
  const first = histogram.breaks[0];
  const last = histogram.breaks[histogram.breaks.length - 1];
  const span = last - first;
  const marker = centre !== null && span > 0 && centre >= first && centre <= last ? ((centre - first) / span) * 100 : null;
  return (
    <div className="relative">
      <div aria-hidden="true" data-vcr-bins={histogram.counts.length} data-forced-colors="preserve" className="flex h-16 items-end gap-px">
        {histogram.counts.map((count, index) => (
          <span key={index} className="relative flex h-full flex-1 items-end">
            <span className="block w-full rounded-t-sm bg-accent" style={{ height: `${Math.max(count > 0 ? 4 : 1, Math.round((count / tallest) * 100))}%` }} />
            {expected && (
              <span data-vcr-expected="" className="absolute inset-x-0 h-0.5 bg-text-2" style={{ bottom: `${Math.min(100, Math.round((expected[index] / tallest) * 100))}%` }} />
            )}
          </span>
        ))}
      </div>
      {marker !== null && <span aria-hidden="true" data-vcr-target="" className="absolute inset-y-0 w-px bg-text-2" style={{ left: `${marker}%` }} />}
      <div className="mt-1 flex justify-between text-meta tabular-nums text-text-3">
        <span>{numberText(first)}</span>
        <span>{numberText(last)}</span>
      </div>
    </div>
  );
}

/** A categorical or binary variable: a bar per level, the declared share marked on a binary one. */
function Levels({ row }: { row: VcrGeneratedRow }) {
  const levels = row.levels ?? [];
  const share = row.kind === "binary" ? declaredShare(row.declaredSpec) : null;
  return (
    <ul data-vcr-levels="" className="flex flex-col gap-1.5">
      {levels.map((level) => (
        <li key={level.level} className="flex items-center gap-2 text-caption">
          <span className="w-12 shrink-0 truncate text-text-2">{level.label}</span>
          {level.suppressed || level.percent === null ? (
            <span className="text-text-3">小样本已隐藏</span>
          ) : (
            <>
              <span aria-hidden="true" data-forced-colors="preserve" className="relative h-2 min-w-0 flex-1 rounded-full bg-surface-2">
                <span className="block h-2 rounded-full bg-accent" style={{ width: `${Math.max(2, Math.min(100, level.percent))}%` }} />
                {share !== null && level.level === "1" && (
                  <span data-vcr-target="" className="absolute -inset-y-0.5 w-px bg-text-2" style={{ left: `${Math.min(100, share)}%` }} />
                )}
              </span>
              <span className="w-12 shrink-0 text-right tabular-nums text-text">{`${level.percent}%`}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
