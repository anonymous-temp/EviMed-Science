import type { FrontierTrendPoint } from "@/lib/frontierClient";
import { cn } from "@/lib/cn";
import { sparkline } from "./frontierText";

/**
 * A heat trend: one line in the accent, the last reading marked by a hollow
 * dot — the hot list's 96 × 28 (seven points, 24 hours) and the event page's
 * wider 72 hours. Neutral on purpose: the market's red-up / green-down is not
 * used, because red is the safety alerts' colour (plan §6.4). With fewer than
 * two readings it says 「暂无走势」 rather than drawing a guess.
 *
 * A picture of numbers the row already states in words, so it is hidden from
 * assistive technology; the heat itself is the text beside it.
 */
export function Sparkline({ points, width = 96, height = 28, className }: {
  points: readonly FrontierTrendPoint[] | null | undefined;
  width?: number;
  height?: number;
  className?: string;
}) {
  const line = points ? sparkline(points, width, height) : null;
  if (!line) return <p className={cn("text-caption text-text-3", className)}>暂无走势</p>;
  return (
    <svg
      aria-hidden="true"
      data-sparkline=""
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("block overflow-visible text-accent", className)}
    >
      <path d={line.path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={line.last.x} cy={line.last.y} r={2.5} className="fill-bg" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
