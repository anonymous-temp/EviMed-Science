import { cn } from "@/lib/cn";

/**
 * The GEO tabs' one line chart, drawn the way the frontier feed draws its heat
 * trend (`components/frontier/Sparkline.tsx`): a path through the readings in
 * `currentColor`, the last reading a hollow dot, no chart library.
 *
 * It stretches to its container's width. The lines are an SVG scaled to the
 * box (a stroke that keeps its width however the box is stretched); the dots
 * and every label are HTML placed by percentage, so they keep their shape and
 * their 12 px at any width, down to 390 px.
 *
 * Every chart here is a picture of numbers the tab also states in words — the
 * latest value with its sample, a legend with each line's change — so it is
 * hidden from assistive technology.
 *
 * Colour: the first series is the accent, a second one is the quiet grey
 * (pilot vs control); a target is a dashed hairline. No red: red is for
 * 讲错我方 and safety only.
 */
export interface ChartSeries {
  key: string;
  values: ReadonlyArray<number | null>;
  tone?: "accent" | "muted";
}

export interface ChartScale {
  low: number;
  high: number;
  ticks: number[];
}

/** A round step near a quarter of the span: 1, 2, 5 × 10ⁿ. */
function niceStep(span: number): number {
  const raw = span / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

/** The vertical scale over every reading and the target, on round numbers. */
export function chartScale(
  values: ReadonlyArray<number | null>,
  target: number | null = null,
  domain: readonly [number, number] | null = null,
): ChartScale | null {
  const levels = [...values, target, ...(domain ?? [])].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (levels.length === 0) return null;
  let low = Math.min(...levels);
  let high = Math.max(...levels);
  if (high === low) {
    low -= 1;
    high += 1;
  }
  const step = niceStep(high - low);
  low = Math.floor(low / step) * step;
  high = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let tick = low; tick <= high + step / 2; tick += step) ticks.push(Math.round(tick * 1000) / 1000);
  return { low, high, ticks };
}

/** A reading's place in the box, both axes in percent (0 at the left and the top). */
function place(index: number, count: number, value: number, scale: ChartScale): { x: number; y: number } {
  const x = count <= 1 ? 50 : (index / (count - 1)) * 100;
  const y = (1 - (value - scale.low) / (scale.high - scale.low)) * 100;
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

/**
 * The path through one series. A missing reading (`null` — no answers, or too
 * few to count) breaks the line rather than being drawn as a guess.
 */
export function seriesPath(values: ReadonlyArray<number | null>, count: number, scale: ChartScale): string {
  let path = "";
  let open = false;
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      open = false;
      return;
    }
    const { x, y } = place(index, count, value, scale);
    path += `${path ? " " : ""}${open ? "L" : "M"}${x} ${y}`;
    open = true;
  });
  return path;
}

function lastReading(values: ReadonlyArray<number | null>): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null && Number.isFinite(values[index])) return index;
  }
  return -1;
}

const TONE: Record<NonNullable<ChartSeries["tone"]>, string> = {
  accent: "text-accent",
  muted: "text-text-3",
};

/** Which x labels to print: all when they fit, else about six, always the first and the last. */
function shownLabels(count: number, most: number): Set<number> {
  if (count <= most) return new Set(Array.from({ length: count }, (_, index) => index));
  const every = Math.ceil(count / 6);
  const shown = new Set<number>([0, count - 1]);
  for (let index = every; index < count - 1; index += every) shown.add(index);
  return shown;
}

export function GeoLineChart({
  series,
  labels = [],
  target = null,
  height = 176,
  axes = true,
  pointLabels = false,
  formatTick = (value: number) => String(value),
  maxLabels = 8,
  domain = null,
  className,
}: {
  series: readonly ChartSeries[];
  /** One label per reading, under the x axis (dates, stages). */
  labels?: readonly string[];
  /** A dashed hairline at the target. */
  target?: number | null;
  /** The plot's height in px. */
  height?: number;
  /** Gridlines and y ticks; off for a sparkline and for a chart that labels its points. */
  axes?: boolean;
  /** Every reading gets a dot and its value above it (the journey's emotion line). */
  pointLabels?: boolean;
  formatTick?: (value: number) => string;
  /** Past this many x labels only about six are printed. */
  maxLabels?: number;
  /** A fixed range the scale must cover (0–10 for an emotion score). */
  domain?: readonly [number, number] | null;
  className?: string;
}) {
  const count = Math.max(labels.length, ...series.map((line) => line.values.length));
  const scale = chartScale(series.flatMap((line) => line.values), target, domain);
  const drawable = scale && series.some((line) => line.values.filter((value) => value !== null).length >= (pointLabels ? 1 : 2));
  if (!scale || !drawable) {
    return <div aria-hidden="true" data-geo-chart="empty" className={className} style={{ height }} />;
  }
  const targetY = target !== null && Number.isFinite(target) ? place(0, 1, target, scale).y : null;
  const shown = shownLabels(count, maxLabels);
  // A chart that labels its points centres every label under its point, so
  // the first and last need room at the sides.
  const gutter = axes ? "ml-8" : pointLabels ? "mx-8" : undefined;

  return (
    <div aria-hidden="true" data-geo-chart="" className={cn("w-full", className)}>
      <div className={cn("relative", gutter, pointLabels && "mt-5")} style={{ height }}>
        {axes && scale.ticks.map((tick) => (
          <span
            key={`tick-${tick}`}
            className="absolute -left-8 w-7 -translate-y-1/2 text-right text-meta tabular-nums text-text-3"
            style={{ top: `${place(0, 1, tick, scale).y}%` }}
          >
            {formatTick(tick)}
          </span>
        ))}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
          {axes && scale.ticks.map((tick) => {
            const y = place(0, 1, tick, scale).y;
            return <line key={`grid-${tick}`} x1={0} x2={100} y1={y} y2={y} className="text-chart-grid" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
          })}
          {targetY !== null && (
            <line data-geo-chart-target="" x1={0} x2={100} y1={targetY} y2={targetY} className="text-text-3" stroke="currentColor" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          )}
          {series.map((line) => (
            <path
              key={line.key}
              data-geo-chart-series={line.key}
              d={seriesPath(line.values, count, scale)}
              className={TONE[line.tone ?? "accent"]}
              fill="none"
              stroke="currentColor"
              strokeWidth={line.tone === "muted" ? 1.5 : 2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {series.map((line) => line.values.map((value, index) => {
          if (value === null || !Number.isFinite(value)) return null;
          const last = index === lastReading(line.values);
          if (!pointLabels && !(last && line.tone !== "muted")) return null;
          const at = place(index, count, value, scale);
          return (
            <span key={`${line.key}-${index}`} className="absolute" style={{ left: `${at.x}%`, top: `${at.y}%` }}>
              <span className={cn("absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-current bg-bg", TONE[line.tone ?? "accent"])} />
              {pointLabels && (
                <span className="absolute -translate-x-1/2 -translate-y-6 whitespace-nowrap text-meta tabular-nums text-text-3">{formatTick(value)}</span>
              )}
            </span>
          );
        }))}
      </div>
      {labels.length > 0 && (
        <div className={cn("relative mt-2 h-5", gutter, !axes && "border-t border-chart-axis pt-1")}>
          {labels.map((label, index) => {
            if (!shown.has(index)) return null;
            const x = count <= 1 ? 50 : (index / (count - 1)) * 100;
            const edge = pointLabels || count <= 1 ? "-translate-x-1/2"
              : index === 0 ? "translate-x-0" : index === count - 1 ? "-translate-x-full" : "-translate-x-1/2";
            return (
              <span key={`label-${index}`} className={cn("absolute whitespace-nowrap text-meta text-text-3", edge)} style={{ left: `${x}%` }}>
                {label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
