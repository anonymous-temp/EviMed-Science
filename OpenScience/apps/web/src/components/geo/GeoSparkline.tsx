import { cn } from "@/lib/cn";

/**
 * A GEO trend: one line in the accent, the last reading marked by a hollow dot
 * — the frontier feed's sparkline — plus the target as a dashed hairline when
 * there is one. The scale spans the readings and the target together, so the
 * gap between them is drawn to size. With fewer than two readings nothing is
 * drawn; the number beside it is the fact.
 *
 * A picture of numbers the page states in words, so it is hidden from
 * assistive technology.
 */
export function geoSparkline(
  values: ReadonlyArray<number | null>,
  target: number | null,
  width: number,
  height: number,
  inset = 3,
): { path: string; last: { x: number; y: number }; target: number | null } | null {
  const read = values.flatMap((value, index) => (value === null || !Number.isFinite(value) ? [] : [{ index, value }]));
  if (read.length < 2) return null;
  const span = Math.max(1, values.length - 1);
  const levels = [...read.map((point) => point.value), ...(target !== null && Number.isFinite(target) ? [target] : [])];
  const low = Math.min(...levels);
  const high = Math.max(...levels);
  const round = (value: number) => Math.round(value * 10) / 10;
  const x = (index: number) => round(inset + (index / span) * (width - inset * 2));
  const y = (value: number) => round(high === low ? height / 2 : inset + (1 - (value - low) / (high - low)) * (height - inset * 2));
  const coords = read.map((point) => ({ x: x(point.index), y: y(point.value) }));
  return {
    path: coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" "),
    last: coords[coords.length - 1],
    target: target !== null && Number.isFinite(target) ? y(target) : null,
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
          className="text-text-3"
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      )}
      <path d={line.path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={line.last.x} cy={line.last.y} r={2.5} className="fill-bg" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
