import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A matrix — engine against metric, engine against question group — as a
 * single-hue heat grid (appendix E §4.2: one hue in six steps, never
 * red-to-green, which is invisible to one reader in twelve and means the
 * opposite in a Chinese market chart).
 *
 * The number stays printed in its cell: colour is the shape of the matrix,
 * the number is the fact. What was measured and what was not are different
 * things and are drawn differently — an engine that dropped out gets a hatched
 * row and the reason in words, never a zero and never a silent absence.
 */

/** The six steps of the single-hue ramp, coldest first. */
const STEPS = ["bg-heat-0", "bg-heat-1", "bg-heat-2", "bg-heat-3", "bg-heat-4", "bg-heat-5"] as const;
/** White reads on the top two steps; the rest carry the body colour. */
const STEP_TEXT = ["text-text", "text-text", "text-text", "text-text", "text-accent-fg", "text-accent-fg"] as const;

/** A hatched ground for 「未测」, built from the surface tokens rather than a colour. */
const HATCH = "repeating-linear-gradient(135deg, var(--surface-1) 0 6px, var(--surface-2) 6px 12px)";

export interface HeatCell {
  /** The value that decides the colour; null is 「not measurable here」. */
  value: number | null;
  /** What the cell prints: 「31」「样本不足」「—」. */
  text: string;
  /** The sample behind it, as a tooltip — never printed in the cell. */
  hint?: string;
}

export interface HeatRow {
  key: string;
  header: ReactNode;
  cells: HeatCell[];
  /** Set when the whole row was not measured: the reason, in one sentence. */
  unmeasured?: string | null;
}

/** Which of the six steps a value falls in, over the grid's own range. */
export function heatStep(value: number, low: number, high: number): number {
  if (!Number.isFinite(value) || high <= low) return 0;
  const share = (value - low) / (high - low);
  return Math.max(0, Math.min(STEPS.length - 1, Math.round(share * (STEPS.length - 1))));
}

export function HeatGrid({
  label,
  columns,
  rows,
  legend,
  className,
}: {
  /** The grid's accessible name. */
  label: string;
  columns: ReadonlyArray<{ key: string; header: string }>;
  rows: readonly HeatRow[];
  /** The ramp's ends in words: 「低」 and 「高」. */
  legend?: { low: string; high: string };
  className?: string;
}) {
  const values = rows.flatMap((row) => (row.unmeasured ? [] : row.cells))
    .map((cell) => cell.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 0;
  return (
    <div className={cn("min-w-0", className)}>
      {legend && (
        <div className="mb-2 flex items-center justify-end gap-1.5 text-meta text-text-3">
          {legend.low}
          <span aria-hidden="true" className="flex gap-0.5">
            {STEPS.map((step) => <span key={step} className={cn("h-2.5 w-3.5 rounded-tag", step)} />)}
          </span>
          {legend.high}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] border-separate border-spacing-1">
          <caption className="sr-only">{label}</caption>
          <thead>
            <tr>
              <th scope="col" className="w-28 text-left text-meta font-normal text-text-3"><span className="sr-only">行</span></th>
              {columns.map((column) => (
                <th key={column.key} scope="col" className="px-1 pb-1 text-center text-meta font-normal text-text-3">{column.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-heat-row={row.key}>
                <th scope="row" className="w-28 text-left text-compact font-medium text-text">{row.header}</th>
                {row.unmeasured ? (
                  <td colSpan={columns.length} data-heat-unmeasured="" className="rounded px-3 text-center text-caption text-text-3" style={{ background: HATCH }}>
                    {row.unmeasured}
                  </td>
                ) : row.cells.map((cell, index) => {
                  const step = cell.value === null ? null : heatStep(cell.value, low, high);
                  return (
                    <td
                      key={columns[index]?.key ?? index}
                      title={cell.hint}
                      data-heat-step={step ?? undefined}
                      className={cn(
                        "h-8 rounded text-center text-compact font-semibold tabular-nums",
                        step === null ? "bg-surface-1 font-normal text-text-3" : `${STEPS[step]} ${STEP_TEXT[step]}`,
                      )}
                    >
                      {cell.text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
