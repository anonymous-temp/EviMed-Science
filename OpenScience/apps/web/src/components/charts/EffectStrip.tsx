import { useMemo } from "react";
import { BarChart } from "echarts/charts";
import { GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import type { EChartsCoreOption } from "echarts/core";
import { canPaintChart, echarts, escapeTooltip, resolvedColor, useEChart } from "./echartsBase";
import { BAND_COLOR, OWN_COLOR, TARGET_COLOR } from "./trendModel";

// The bar and the three things it needs, on top of what the trend chart registers; nothing else of the library is pulled in.
echarts.use([BarChart, GridComponent, TooltipComponent, MarkLineComponent]);

/**
 * One group's effect, as counts (R19, audit C §2.7 「群轨迹小多图 + 事件标记」): for each round, the answers that named the
 * product (`k`, the brand) out of the answers there were (`n`, the pale remainder above it), with what we did marked on the rounds.
 *
 * It draws counts and never a rate: a group has about a dozen answers a round, under the platform's floor for a percentage, and a
 * bar of 5 out of 12 says exactly what is known. "Did it work" is not drawn here at all — it is the arms' net effect, said beside
 * this chart in a sentence — because a bar of one group moving cannot tell a rise from the noise.
 *
 * The rounds' labels carry the count under the date, so the numbers are in the chart and not only in its tooltip; the host is an
 * image with the same numbers as its name. Where no canvas can be painted (a test, a printed page) the figure says them in a caption.
 */

export interface EffectPoint {
  /** The round's day as a reader says it: 「10月5日」. */
  label: string;
  /** Answers that named us, and answers; null where the round has no reading for this group. */
  k: number | null;
  n: number | null;
}

export interface EffectMarker {
  /** Which round it sits on. */
  index: number;
  /** What happened: 「稿件发布」「首次被引用」. */
  label: string;
}

export function effectSummary(points: readonly EffectPoint[]): string {
  return points.map((point) => `${point.label} ${point.k === null || point.n === null ? "未测" : `${point.k}/${point.n}`}`).join("，");
}

/** The option, built from the points so the drawing has no decisions left. Exported for the test that reads it without a canvas. */
export function effectStripOption(points: readonly EffectPoint[], markers: readonly EffectMarker[]): EChartsCoreOption {
  const own = resolvedColor(OWN_COLOR);
  const rest = resolvedColor(BAND_COLOR);
  const rule = resolvedColor(TARGET_COLOR);
  const labels = points.map((point) => (point.k === null || point.n === null ? `${point.label}\n未测` : `${point.label}\n${point.k}/${point.n}`));
  const named = points.map((point) => (point.k === null || point.n === null ? null : point.k));
  const others = points.map((point) => (point.k === null || point.n === null ? null : Math.max(0, point.n - point.k)));
  const top = points.reduce((max, point) => Math.max(max, point.n ?? 0), 0);
  return {
    animation: false,
    grid: { left: 8, right: 8, top: markers.length > 0 ? 32 : 12, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (rows: unknown) => {
        const first = Array.isArray(rows) ? (rows[0] as { dataIndex?: number } | undefined) : undefined;
        const point = first?.dataIndex !== undefined ? points[first.dataIndex] : undefined;
        if (!point) return "";
        return `${escapeTooltip(point.label)}<br/>${point.k === null || point.n === null ? "未测" : `${point.n} 个回答里 ${point.k} 个提到了`}`;
      },
    },
    xAxis: { type: "category", data: labels, axisTick: { show: false }, axisLabel: { interval: 0, lineHeight: 16 } },
    yAxis: { type: "value", minInterval: 1, max: Math.max(top, 1), splitNumber: 2, axisLabel: { formatter: (value: number) => String(Math.round(value)) } },
    series: [
      { type: "bar", name: "提到了", stack: "answers", barMaxWidth: 28, data: named, itemStyle: { color: own }, z: 3 },
      {
        type: "bar",
        name: "没提到",
        stack: "answers",
        barMaxWidth: 28,
        data: others,
        itemStyle: { color: rest },
        z: 2,
        markLine: markers.length === 0 ? undefined : {
          silent: true,
          symbol: "none",
          data: markers.map((marker) => ({
            xAxis: marker.index,
            label: { show: true, position: "end", rotate: 0, distance: 4, formatter: marker.label, color: rule },
            lineStyle: { color: resolvedColor("var(--text-graphic)"), width: 1, type: "dashed" },
          })),
        },
      },
    ],
  };
}

export function EffectStrip({
  label,
  points,
  markers = [],
  height = 132,
  className,
}: {
  /** What it is: 「这个群每轮被提到的回答数」. */
  label: string;
  points: readonly EffectPoint[];
  markers?: readonly EffectMarker[];
  height?: number;
  className?: string;
}) {
  const option = useMemo(() => (points.length === 0 ? null : effectStripOption(points, markers)), [points, markers]);
  const host = useEChart(option);
  if (points.length === 0) return null;
  return (
    <figure data-chart="effect-strip" data-chart-points={points.length} className={`m-0 min-w-0 ${className ?? ""}`}>
      <div ref={host} role="img" aria-label={`${label}：${effectSummary(points)}`} style={{ height }} className="w-full" />
      {!canPaintChart() && <figcaption className="text-caption tabular-nums text-text-3">{effectSummary(points)}</figcaption>}
    </figure>
  );
}
