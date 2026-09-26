import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

/**
 * A chart and the sentence it proves (fusion plan §5.9: every chart's heading
 * is a conclusion — 「元宝对信尔美提及最多」 — and never 「图 1」).
 *
 * The card owns the four states a read can be in, so no chart has to invent
 * them: a skeleton the size of the plot, one sentence when there is nothing
 * to draw, an error with 重试, and the chart. **`empty` is a sentence, never
 * an empty frame**: a fixed-height box with no line in it is what made the
 * monitoring page look broken, and a chart with one reading draws that
 * reading rather than reporting itself as empty.
 *
 * `footnote` is where a block declares its denominator, once — 「按 4 个引擎、
 * 264 次有效回答计算」 — instead of repeating it in every cell.
 */

export type ChartCardState = "content" | "loading" | "empty" | "error";

export function ChartCard({
  title,
  meta,
  legend,
  footnote,
  state = "content",
  emptyText,
  errorMessage,
  onRetry,
  height,
  className,
  children,
}: {
  /** The conclusion this chart shows, as a sentence. */
  title: ReactNode;
  /** A count or a link at the heading's right end. */
  meta?: ReactNode;
  /** The series legend, under the heading on a narrow screen and beside it otherwise. */
  legend?: ReactNode;
  /** The denominator and anything else true of every number in the card. */
  footnote?: ReactNode;
  state?: ChartCardState;
  /** The one sentence shown when there is nothing to draw. */
  emptyText?: string;
  errorMessage?: string;
  onRetry?: () => void;
  /** The plot's height in px, used by the skeleton and the empty state too. */
  height?: number;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col rounded-card border border-border bg-surface p-4", className)}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="min-w-0 text-section font-semibold text-text">{title}</h3>
        {meta != null && <span className="shrink-0 text-caption tabular-nums text-text-3">{meta}</span>}
      </header>
      {legend != null && <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">{legend}</div>}
      <div className="mt-3 min-w-0 flex-1">
        {state === "loading" ? (
          <div aria-hidden="true" className="animate-pulse rounded bg-surface-1" style={{ height: height ?? 176 }} />
        ) : state === "error" ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded border border-danger bg-danger-soft px-3 py-2 text-ui text-danger-strong">
            <span className="min-w-0 flex-1 break-words">{errorMessage ?? "暂时无法读取，请稍后重试。"}</span>
            {onRetry && (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                <RefreshCw size={16} aria-hidden="true" />重试
              </Button>
            )}
          </div>
        ) : state === "empty" ? (
          <p data-chart-empty="" className="py-6 text-ui text-text-3">{emptyText ?? "还没有可以画出来的测量。"}</p>
        ) : children}
      </div>
      {footnote != null && state === "content" && <p className="mt-3 text-caption text-text-3">{footnote}</p>}
    </section>
  );
}

/**
 * One entry of a chart's legend: the mark in the series' own colour, then its
 * name. The colour is a CSS custom property from the data palette, so a rival
 * can never pick up the brand by accident — `LegendMark` takes the role, not
 * a colour.
 */
export function LegendMark({
  color,
  shape = "line",
  children,
  series,
}: {
  /** A `var(--chart-…)` reference from the data palette. */
  color: string;
  shape?: "line" | "dash" | "band";
  children: ReactNode;
  /** `own` or `rival-1…3` — what the walk and the tests read off the mark. */
  series?: string;
}) {
  return (
    <span data-legend-role={series} className="inline-flex items-center gap-1.5 text-caption text-text-2">
      <span
        aria-hidden="true"
        data-legend-mark={series}
        className={cn("inline-block shrink-0", shape === "band" ? "h-2.5 w-4 rounded-tag" : "h-0.5 w-4 rounded-full")}
        style={shape === "dash"
          ? { backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` }
          : { background: color }}
      />
      {children}
    </span>
  );
}
