import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { VcrCurve, VcrSeries } from "@/lib/vcrClient";
import { markKindOf, seriesColor } from "./VcrMarks";
import { bandPath, linePath, posX, posY, scaleOf, stepPath, type Point, type VcrScale } from "./vcrScale";

/**
 * The time-series charts of 「虚拟临研」, and the one rule they all obey.
 *
 * **The source decides the shape** (plan §9.6): an observation is a solid line
 * with solid dots, a literature aggregate or a curve reconstructed out of a
 * published figure is dashed, a model's output is a light band. A
 * reconstructed Kaplan-Meier is therefore dashed on every chart in the
 * module, always — it may never be drawn as a curve somebody measured. Our
 * own arm is the brand blue; every comparator is a grey, darkest first, so a
 * reader finds their own arm without reading a legend.
 *
 * Geometry: the plot is `viewBox="0 0 100 100"` with `preserveAspectRatio
 * ="none"` and non-scaling strokes, so the lines stretch to the column while
 * the labels — HTML placed by percentage — keep their 12 px at any width
 * (`vcrScale.ts`). No chart library: none of this needs one, and the bundle
 * every page loads is the price of pretending otherwise.
 */

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

/** The stroke a source demands: solid for an observation, dashed for anything reconstructed or pooled. */
function strokeOf(series: { source: VcrSeries["source"]; dashed?: boolean }): string | undefined {
  return series.dashed || markKindOf(series.source) === "dashed" ? "4 3" : undefined;
}

/**
 * Mean lines with their prediction bands, and — when the server sends them —
 * the thin individual trajectories behind. The band is named in the legend
 * (「80% 预测区间」), never as a bare 「区间」.
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
  const xs = series.flatMap((line) => line.points.map((point) => point.x));
  const ys = series.flatMap((line) => [
    ...line.points.map((point) => point.y),
    ...line.points.map((point) => point.low ?? null),
    ...line.points.map((point) => point.high ?? null),
    ...(line.individuals ?? []).flatMap((trace) => trace.map((point) => point.y)),
  ]);
  const x = scaleOf(xs);
  const y = scaleOf(ys, domain);
  if (!x || !y) return <ChartBlank height={height} />;
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
      {series.map((line, index) => {
        const color = seriesColor(Boolean(line.ours), index);
        return (
          <g key={line.key} data-vcr-series={line.key} data-vcr-series-source={line.source}>
            {bandPath(line.points as Point[], x, y) && (
              <path d={bandPath(line.points as Point[], x, y)} fill={color} opacity={0.16} data-vcr-band={line.bandKind ?? "prediction"} />
            )}
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
              d={linePath(line.points as Point[], x, y)}
              fill="none"
              stroke={color}
              strokeWidth={line.ours ? 2.2 : 1.6}
              strokeDasharray={strokeOf(line)}
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
 * Kaplan-Meier curves. Every curve is a step function, and a reconstructed one
 * is dashed — the module's single hardest visual rule (plan §3.5).
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
          return (
            <path
              key={curve.key}
              data-vcr-curve={curve.key}
              data-vcr-curve-source={curve.source}
              d={stepPath(curve.points as Point[], x, y)}
              fill="none"
              stroke={color}
              strokeWidth={curve.pooled || curve.ours ? 2 : 1.3}
              // A reconstructed curve is dashed wherever it is drawn: it was
              // digitised out of a figure, not measured.
              strokeDasharray={markKindOf(curve.source) === "dashed" ? (curve.pooled ? "5 3" : "3 3") : undefined}
              vectorEffect="non-scaling-stroke"
            />
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
 * Predicted enrolment against actual: the median as a line, the 80%
 * prediction band behind it, and what has actually happened so far as a
 * solid line that stops at today. The two are different kinds of number and
 * are drawn as different kinds of mark.
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
          d={linePath(median as Point[], x, y)}
          fill="none"
          stroke="var(--chart-own)"
          strokeWidth={1.6}
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
