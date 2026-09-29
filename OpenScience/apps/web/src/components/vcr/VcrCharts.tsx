import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tag } from "@/components/ui/Tag";
import type { VcrCurve, VcrIntervalKind, VcrSeries, VcrValueSource } from "@/lib/vcrClient";
import { markKindOf, SeriesLegend, seriesColor } from "./VcrMarks";
import { intervalLabel } from "./vcrText";
import { bandPath, linePath, posX, posY, scaleOf, spanRect, stepPath, type Point, type VcrScale } from "./vcrScale";

/**
 * The time-series charts of 「虚拟临研」, and the one rule they all obey.
 *
 * **The source decides the shape** (plan §8.3, §9.6), for a trajectory and a
 * survival curve alike:
 *
 *  - an observation (and the three things derived from one) is the only solid
 *    line — the one mark that means somebody measured a real person;
 *  - a literature aggregate or a curve reconstructed out of a published figure
 *    is dashed. A reconstructed Kaplan-Meier is dashed on every chart in the
 *    module, always, even after it passed its quality control;
 *  - a model's prediction or a synthetic record is a thin dashed mean inside
 *    its light band — a distribution a model generated is never drawn as a KM
 *    somebody observed, and a line alone would hide the spread that is the
 *    model's whole answer;
 *  - an assumption is dashed and carries 「假设」 in the legend.
 *
 * A band is drawn only when it has a name (`bandKind`): an interval without a
 * name is not an interval (plan §9.6), and the legend takes that name from
 * the data rather than writing 「80% 预测区间」 whatever the data say. Our own
 * arm is the brand blue; every comparator is a grey, darkest first, so a
 * reader finds their own arm without reading a legend.
 *
 * Geometry: the plot is `viewBox="0 0 100 100"` with `preserveAspectRatio
 * ="none"` and non-scaling strokes, so the lines stretch to the column while
 * the labels — HTML placed by percentage — keep their 12 px at any width
 * (`vcrScale.ts`). No chart library: none of this needs one, and the bundle
 * every page loads is the price of pretending otherwise.
 */

/** How a line of a given source is drawn. */
export interface VcrStroke {
  /** `undefined` is solid. */
  dash: string | undefined;
  width: number;
  /** Whether the light band behind it belongs to the mark. */
  band: boolean;
}

/**
 * The stroke a source demands (plan §9.6). Solid is earned: only the
 * observed family gets it, and the server's `dashed` can only take it away.
 */
export function strokeOf(series: { source: VcrValueSource | null | undefined; dashed?: boolean; ours?: boolean }): VcrStroke {
  const kind = markKindOf(series.source);
  if (kind === "solid") return { dash: series.dashed ? "4 3" : undefined, width: series.ours ? 2.2 : 1.6, band: false };
  if (kind === "dashed") return { dash: "4 3", width: series.ours ? 2 : 1.6, band: false };
  if (kind === "band") return { dash: "3 2", width: series.ours ? 1.6 : 1.2, band: true };
  return { dash: "6 3", width: 1.4, band: false };
}

/** A band's own name, from the data: 「预测区间」, 「80% 预测区间」 when the level is sent. */
export function bandName(kind: VcrIntervalKind | null | undefined, level?: number | null): string {
  const name = intervalLabel(kind);
  if (!name) return "";
  return typeof level === "number" && Number.isFinite(level) ? `${level}% ${name}` : name;
}

/** The server may say what level a band is; the page never assumes one. */
function bandLevelOf(series: object): number | null {
  const level = (series as { bandLevel?: unknown }).bandLevel;
  return typeof level === "number" && Number.isFinite(level) ? level : null;
}

/**
 * A chart's legend, from its series: each one in its own colour and mark, an
 * assumption tagged 「假设」, then — once per name — the bands the chart
 * actually draws, and the unobserved periods when there are any.
 */
export function VcrSeriesLegend({ series }: {
  /** Trajectories and survival curves alike: what the legend reads is their common part. */
  series: ReadonlyArray<Pick<VcrSeries, "key" | "label" | "source" | "ours" | "points"> & Partial<Pick<VcrSeries, "bandKind" | "unobserved">>>;
}) {
  const bands = new Map<string, boolean>();
  for (const line of series) {
    if (!line.bandKind || !line.points.some((point) => typeof point.low === "number" && typeof point.high === "number")) continue;
    const name = bandName(line.bandKind, bandLevelOf(line));
    if (name) bands.set(name, bands.get(name) === true || Boolean(line.ours));
  }
  const unobserved = series.some((line) => (line.unobserved ?? []).length > 0);
  return (
    <>
      {series.map((line, index) => (
        <span key={line.key} data-vcr-legend={line.key}>
          <SeriesLegend label={line.label} source={line.source} ours={line.ours} tone={((index % 3) + 1) as 1 | 2 | 3}>
            {markKindOf(line.source) === "assumed" && <Tag>假设</Tag>}
          </SeriesLegend>
        </span>
      ))}
      {[...bands].map(([name, ours]) => (
        <span key={`band-${name}`} data-vcr-legend-band={name} className="inline-flex items-center gap-1.5 text-caption text-text-2">
          <span
            aria-hidden="true"
            data-forced-colors="preserve"
            className="inline-block h-2.5 w-4 rounded-tag"
            style={{ background: ours ? "var(--chart-own)" : "var(--chart-rival-2)", opacity: 0.28 }}
          />
          {name}
        </span>
      ))}
      {unobserved && (
        <span data-vcr-legend-unobserved="" className="inline-flex items-center gap-1.5 text-caption text-text-2">
          <span aria-hidden="true" data-forced-colors="preserve" className="inline-block h-2.5 w-4 rounded-tag bg-surface-2" />
          未观察时段
        </span>
      )}
    </>
  );
}

/** The plot's frame: y ticks and their gridlines, x labels, and the SVG itself. */
export function VcrPlot({
  x,
  y,
  xLabels,
  yLabel,
  xLabel,
  formatY = (value: number) => String(value),
  height = 220,
  children,
  overlay,
  className,
}: {
  x: VcrScale;
  y: VcrScale;
  /** One label per x tick, in the tick order. */
  xLabels?: readonly string[];
  yLabel?: string | null;
  xLabel?: string | null;
  formatY?: (value: number) => string;
  height?: number;
  /** Paths, in the 0–100 box. */
  children: ReactNode;
  /** HTML placed over the plot by percentage: dots, end labels, markers. */
  overlay?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("w-full", className)}>
      {yLabel && <p className="mb-1 text-caption text-text-3">{yLabel}</p>}
      <div className="relative ml-10" style={{ height }}>
        {y.ticks.map((tick) => (
          <span
            key={`y-${tick}`}
            className="absolute -left-10 w-9 -translate-y-1/2 text-right text-meta tabular-nums text-text-3"
            style={{ top: `${posY(tick, y)}%` }}
          >
            {formatY(tick)}
          </span>
        ))}
        <svg
          aria-hidden="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible"
        >
          {y.ticks.map((tick) => (
            <line
              key={`grid-${tick}`}
              x1={0}
              x2={100}
              y1={posY(tick, y)}
              y2={posY(tick, y)}
              className="text-chart-grid"
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {children}
        </svg>
        {overlay}
      </div>
      {(xLabels?.length || xLabel) && (
        <div className="relative ml-10 mt-1 h-5">
          {xLabels?.map((label, index) => (
            <span
              key={`${label}-${index}`}
              className="absolute -translate-x-1/2 whitespace-nowrap text-meta tabular-nums text-text-3"
              style={{ left: `${x.ticks.length > 1 ? posX(x.ticks[Math.min(index, x.ticks.length - 1)], x) : 50}%` }}
            >
              {label}
            </span>
          ))}
          {xLabel && <span className="absolute right-0 whitespace-nowrap text-meta text-text-3">{xLabel}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Mean lines with their bands, the thin individual trajectories behind them
 * when the server sends them, and — shaded apart from the rest — the periods
 * nobody could observe (plan §5.2).
 */
export function VcrTrajectoryChart({
  series,
  xLabels,
  xLabel,
  yLabel,
  formatY,
  domain = null,
  height = 260,
  className,
}: {
  series: readonly VcrSeries[];
  xLabels?: readonly string[];
  xLabel?: string | null;
  yLabel?: string | null;
  formatY?: (value: number) => string;
  domain?: readonly [number, number] | null;
  height?: number;
  className?: string;
}) {
  const xs = series.flatMap((line) => [
    ...line.points.map((point) => point.x),
    ...(line.individuals ?? []).flatMap((trace) => trace.map((point) => point.x)),
  ]);
  const ys = series.flatMap((line) => [
    ...line.points.map((point) => point.y),
    ...line.points.map((point) => point.low ?? null),
    ...line.points.map((point) => point.high ?? null),
    ...(line.individuals ?? []).flatMap((trace) => trace.map((point) => point.y)),
  ]);
  const x = scaleOf(xs);
  const y = scaleOf(ys, domain);
  if (!x || !y) return <ChartBlank height={height} />;
  const spans = series.flatMap((line) => (line.unobserved ?? []).map((span) => spanRect(span.from, span.to, x)))
    .filter((rect): rect is { x: number; width: number } => rect !== null);
  return (
    <VcrPlot x={x} y={y} xLabels={xLabels} xLabel={xLabel} yLabel={yLabel} formatY={formatY} height={height} className={className}
      overlay={(
        <>
          {series.map((line, index) => {
            const last = [...line.points].reverse().find((point) => typeof point.y === "number" && Number.isFinite(point.y));
            if (!last || !line.endLabel) return null;
            return (
              <span
                key={`end-${line.key}`}
                data-vcr-series-end={line.key}
                className="absolute -translate-y-1/2 whitespace-nowrap pl-2 text-caption font-medium"
                style={{ left: `${posX(last.x, x)}%`, top: `${posY(last.y as number, y)}%`, color: seriesColor(Boolean(line.ours), index) }}
              >
                {line.endLabel}
                {line.endNote && <span className="ml-1 font-normal text-text-3">{line.endNote}</span>}
              </span>
            );
          })}
        </>
      )}
    >
      {spans.map((rect, index) => (
        <rect
          key={`unobserved-${index}`}
          data-vcr-unobserved=""
          x={rect.x}
          y={0}
          width={rect.width}
          height={100}
          className="text-surface-2"
          fill="currentColor"
        />
      ))}
      {series.map((line, index) => {
        const color = seriesColor(Boolean(line.ours), index);
        const stroke = strokeOf(line);
        // A band is drawn only with its name; an unnamed spread is not an interval.
        const band = line.bandKind ? bandPath(line.points as Point[], x, y) : "";
        return (
          <g key={line.key} data-vcr-series={line.key} data-vcr-series-source={line.source} data-vcr-mark={markKindOf(line.source)}>
            {band && <path d={band} fill={color} opacity={0.16} data-vcr-band={line.bandKind ?? ""} />}
            {(line.individuals ?? []).map((trace, traceIndex) => (
              <path
                key={`trace-${traceIndex}`}
                d={linePath(trace as Point[], x, y)}
                fill="none"
                stroke={color}
                strokeWidth={0.8}
                opacity={0.3}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path
              data-vcr-series-line={line.key}
              d={linePath(line.points as Point[], x, y)}
              fill="none"
              stroke={color}
              strokeWidth={stroke.width}
              strokeDasharray={stroke.dash}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </VcrPlot>
  );
}

/**
 * Kaplan-Meier curves. Every curve is a step function, and its source decides
 * its stroke like every other series here: a reconstructed curve is dashed —
 * the module's single hardest visual rule (plan §3.5) — and a curve a model
 * predicted is a thin dashed step inside its band, never a KM.
 *
 * The numbers at risk go under the plot, because a survival curve without them
 * is a picture whose tail nobody can weigh.
 */
export function VcrSurvivalChart({
  curves,
  rmst,
  xLabel = "随机后月数",
  yLabel = "无进展生存率",
  height = 260,
  className,
}: {
  curves: readonly VcrCurve[];
  /** The τ the restricted mean is taken to, shaded under the pooled curve. */
  rmst?: { tau: number | null; label?: string | null } | null;
  xLabel?: string;
  yLabel?: string;
  height?: number;
  className?: string;
}) {
  const xs = curves.flatMap((curve) => curve.points.map((point) => point.x));
  const x = scaleOf(xs, [0, 0]);
  const y = scaleOf([0, 1], [0, 1]);
  if (!x || !y || curves.length === 0) return <ChartBlank height={height} />;
  const ticks = x.ticks;
  return (
    <div className={className}>
      <VcrPlot
        x={x}
        y={y}
        xLabels={ticks.map((tick) => String(tick))}
        xLabel={xLabel}
        yLabel={yLabel}
        formatY={(value) => `${Math.round(value * 100)}%`}
        height={height}
        overlay={rmst?.tau != null ? (
          <span
            data-vcr-tau=""
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-meta text-accent-strong"
            style={{ left: `${posX(rmst.tau, x)}%` }}
          >
            {rmst.label ?? `τ = ${rmst.tau}`}
          </span>
        ) : null}
      >
        {rmst?.tau != null && (
          <>
            <rect
              x={0}
              y={0}
              width={posX(rmst.tau, x)}
              height={100}
              className="text-chart-band"
              fill="currentColor"
              opacity={0.7}
              data-vcr-rmst-area=""
            />
            <line
              x1={posX(rmst.tau, x)}
              x2={posX(rmst.tau, x)}
              y1={0}
              y2={100}
              className="text-accent"
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
        {curves.map((curve, index) => {
          const color = seriesColor(Boolean(curve.ours), index);
          const stroke = strokeOf(curve);
          const kind = markKindOf(curve.source);
          const bandKind = (curve as VcrCurve & { bandKind?: VcrIntervalKind | null }).bandKind ?? null;
          const band = stroke.band && bandKind ? bandPath(curve.points as Point[], x, y, { step: true }) : "";
          return (
            <g key={curve.key}>
              {band && <path d={band} fill={color} opacity={0.16} data-vcr-band={bandKind ?? ""} />}
              <path
                data-vcr-curve={curve.key}
                data-vcr-curve-source={curve.source}
                data-vcr-mark={kind}
                d={stepPath(curve.points as Point[], x, y)}
                fill="none"
                stroke={color}
                strokeWidth={curve.pooled || curve.ours ? Math.max(stroke.width, 2) : Math.min(stroke.width, 1.3)}
                // A reconstructed curve is dashed wherever it is drawn: it was
                // digitised out of a figure, not measured. The pooled one gets
                // the longer dash so the two stay apart.
                strokeDasharray={kind === "dashed" ? (curve.pooled ? "5 3" : "3 3") : stroke.dash}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </VcrPlot>
      {curves.some((curve) => curve.atRisk?.length) && (
        <table className="mt-3 w-full border-collapse text-caption tabular-nums">
          <caption className="mb-1 text-left text-caption text-text-3">风险人数</caption>
          <tbody>
            {curves.filter((curve) => curve.atRisk?.length).map((curve) => (
              <tr key={`risk-${curve.key}`} data-vcr-at-risk={curve.key}>
                <th scope="row" className="whitespace-nowrap py-0.5 pr-3 text-left font-normal text-text-3">{curve.label}</th>
                {(curve.atRisk ?? []).map((entry) => (
                  <td key={entry.x} className="py-0.5 text-center text-text-2">{entry.n}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Predicted enrolment against actual: the median as a thin dashed line inside
 * its prediction band, and what has actually happened so far as the one solid
 * line, stopping at today. The two are different kinds of number and are
 * drawn as different kinds of mark (the rule at the top of this file).
 */
export function VcrForecastChart({
  target,
  actual = [],
  median = [],
  band = [],
  markers = [],
  xLabels,
  height = 260,
  className,
}: {
  target?: number | null;
  actual?: ReadonlyArray<{ x: number; y: number | null }>;
  median?: ReadonlyArray<{ x: number; y: number | null }>;
  band?: ReadonlyArray<{ x: number; low: number | null; high: number | null }>;
  markers?: ReadonlyArray<{ x: number; label: string }>;
  xLabels?: readonly string[];
  height?: number;
  className?: string;
}) {
  const xs = [...actual, ...median, ...band].map((point) => point.x);
  const ys = [
    ...actual.map((point) => point.y),
    ...median.map((point) => point.y),
    ...band.flatMap((point) => [point.low, point.high]),
    target ?? null,
  ];
  const x = scaleOf(xs);
  const y = scaleOf(ys, [0, 0]);
  if (!x || !y) return <ChartBlank height={height} />;
  return (
    <VcrPlot
      x={x}
      y={y}
      xLabels={xLabels}
      yLabel="累计随机例数"
      height={height}
      className={className}
      overlay={(
        <>
          {markers.map((marker) => (
            <span
              key={marker.label}
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-meta text-text-3"
              style={{ left: `${posX(marker.x, x)}%` }}
            >
              {marker.label}
            </span>
          ))}
        </>
      )}
    >
      {band.length > 1 && (
        <path
          data-vcr-band="prediction"
          d={bandPath(band.map((point) => ({ x: point.x, y: null, low: point.low, high: point.high })), x, y)}
          fill="var(--chart-own)"
          opacity={0.16}
        />
      )}
      {target != null && (
        <line
          data-vcr-target=""
          x1={0}
          x2={100}
          y1={posY(target, y)}
          y2={posY(target, y)}
          className="text-chart-target"
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {median.length > 1 && (
        <path
          data-vcr-series="median"
          data-vcr-series-source="predicted"
          d={linePath(median as Point[], x, y)}
          fill="none"
          stroke="var(--chart-own)"
          strokeWidth={strokeOf({ source: "predicted", ours: true }).width}
          strokeDasharray={strokeOf({ source: "predicted", ours: true }).dash}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {actual.length > 1 && (
        <path
          data-vcr-series="actual"
          data-vcr-series-source="observed"
          d={linePath(actual as Point[], x, y)}
          fill="none"
          stroke="var(--chart-rival-1)"
          strokeWidth={2.2}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </VcrPlot>
  );
}

/** A plot with nothing drawable in it keeps its height and says so once. */
export function ChartBlank({ height = 220, text = "还没有可以画出来的结果。" }: { height?: number; text?: string }) {
  return <p data-vcr-chart-blank="" className="py-6 text-ui text-text-3" style={{ minHeight: height / 2 }}>{text}</p>;
}
