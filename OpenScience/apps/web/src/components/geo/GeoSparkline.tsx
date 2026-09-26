import { cn } from "@/lib/cn";

/**
 * A metric's trend beside its number: one brand line, the latest reading a
 * hollow dot, the target a dashed hairline. The scale spans the readings and
 * the target together, so the distance between them is drawn to size.
 *
 * **One reading is drawn, not dropped.** A single measurement is a baseline
 * against a target, which is exactly what a reader wants to see in the first
 * week of a programme; leaving the box blank is what made the old board look
 * broken (appendix E §4.5). Only a metric with nothing measured at all draws
 * nothing, and then the number beside it already says 「—」.
 *
 * A picture of numbers the page states in words, so it is hidden from
 * assistive technology. Action markers belong on the main trend chart and
 * never here.
 */

export interface SparklineShape {
  path: string;
  points: Array<{ x: number; y: number }>;
  last: { x: number; y: number };
  target: number | null;
}

export function geoSparkline(
  values: ReadonlyArray<number | null>,
  target: number | null,
  width: number,
  height: number,
  inset = 3,
): SparklineShape | null {
  const read = values.flatMap((value, index) => (value === null || !Number.isFinite(value) ? [] : [{ index, value }]));
  if (read.length === 0) return null;
  const span = Math.max(1, values.length - 1);
  const targeted = target !== null && Number.isFinite(target);
  const levels = [...read.map((point) => point.value), ...(targeted ? [target as number] : [])];
  const low = Math.min(...levels);
  const high = Math.max(...levels);
  const round = (value: number) => Math.round(value * 10) / 10;
  // A single reading sits where it would sit in a series — at its own index —
  // so the space to its right reads as the measurements still to come.
  const x = (index: number) => round(inset + (read.length === 1 ? 0 : index / span) * (width - inset * 2));
  const y = (value: number) => round(high === low ? height / 2 : inset + (1 - (value - low) / (high - low)) * (height - inset * 2));
  const points = read.map((point) => ({ x: x(point.index), y: y(point.value) }));
  return {
    path: points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" "),
    points,
    last: points[points.length - 1],
    target: targeted ? y(target as number) : null,
  };
}

export function GeoSparkline({
  values,
  target = null,
  width = 152,
  height = 32,
  className,
}: {
  values: ReadonlyArray<number | null>;
  target?: number | null;
  width?: number;
  height?: number;
  className?: string;
}) {
  const line = geoSparkline(values, target, width, height);
  if (!line) return <span aria-hidden="true" className={cn("inline-block", className)} style={{ width, height }} />;
  return (
    <svg
      aria-hidden="true"
      data-geo-sparkline=""
      data-geo-readings={line.points.length}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("block shrink-0 overflow-visible text-accent", className)}
    >
      {line.target !== null && (
        <line
          data-geo-target=""
          x1={0}
          x2={width}
          y1={line.target}
          y2={line.target}
          className="text-chart-target"
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      )}
      {line.points.length > 1 && (
        <path d={line.path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      )}
      <circle cx={line.last.x} cy={line.last.y} r={2.5} className="fill-bg" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
