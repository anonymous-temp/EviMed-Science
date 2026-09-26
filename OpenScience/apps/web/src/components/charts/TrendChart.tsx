import { useMemo } from "react";
import { LineChart } from "echarts/charts";
import { GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import type { EChartsCoreOption } from "echarts/core";
import { useColorScheme } from "@/lib/colorScheme";
import { canPaintChart, echarts, resolvedColor, useEChart } from "./echartsBase";
import { BAND_COLOR, TARGET_COLOR, trendModel, type TrendInput, type TrendModel } from "./trendModel";

// The line chart and the three things it needs, and nothing else in the
// library: no bar, pie, map, graph, data zoom or toolbox reaches the bundle.
echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent]);

/**
 * 「投了有没有用」 — the one chart that answers it (fusion plan §4.8).
 *
 * Ours is a thick brand line, every rival a grey, the target a dark dashed
 * rule, the measured fluctuation a pale ribbon around our line, and what we
 * did — the first articles going live, the placements taking effect — vertical
 * dashed markers, so a rise can be read against the thing that caused it. The
 * date of the next measurement is a slot of its own at the right, which is how
 * a chart with two readings still looks like a plan rather than a stub.
 *
 * With one reading it draws that reading, labelled 「基线」, against the target
 * and the next date. There is no state in which this component paints an empty
 * frame.
 */
export function TrendChart({
  input,
  format = (value: number) => String(Math.round(value)),
  height = 240,
  label,
}: {
  input: TrendInput;
  /** The value as a reader says it: 「61」「15%」. */
  format?: (value: number) => string;
  height?: number;
  /** The chart's accessible name; its numbers are stated in the page around it. */
  label: string;
}) {
  const model = useMemo(() => trendModel(input), [input]);
  // The scheme is a dependency of the option, not only of the instance: the
  // colours are resolved to literals before they reach the canvas.
  const scheme = useColorScheme();
  // `scheme` is not read in the body but is read through it: `chartOption`
  // resolves the palette's custom properties against the live document, and a
  // theme flip changes every one of them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const option = useMemo(() => (model.mode === "empty" ? null : chartOption(model, format)), [model, format, scheme]);
  const host = useEChart(option);
  const plot = model.mode === "baseline" ? Math.min(height, 176) : height;
  return (
    <figure
      data-chart="trend"
      data-chart-mode={model.mode}
      data-chart-readings={model.readings}
      className="m-0 min-w-0"
    >
      <div ref={host} role="img" aria-label={label} style={{ height: plot }} className="w-full" />
      {!canPaintChart() && (
        // Where a canvas cannot be painted (a test, a printed page), the chart
        // still says what it holds rather than leaving a blank box.
        <figcaption className="text-caption text-text-3">
          {model.mode === "baseline" ? "只有一次测量：基线。" : `${model.readings} 次测量。`}
        </figcaption>
      )}
    </figure>
  );
}

/** The ECharts option, built from the model so the drawing has no decisions left. */
function chartOption(model: TrendModel, format: (value: number) => string): EChartsCoreOption {
  const own = resolvedColor(model.own.color);
  const target = resolvedColor(TARGET_COLOR);
  const band = model.band;
  const lower = band === null ? null : model.own.values.map((value) => (value === null ? null : value - band));
  const width = band === null ? null : model.own.values.map((value) => (value === null ? null : band * 2));
  const markLines = [
    ...(model.target === null ? [] : [{
      yAxis: model.target,
      label: {
        show: true,
        position: "insideEndTop" as const,
        formatter: model.targetLabel ?? `目标 ${format(model.target)}`,
      },
      lineStyle: { color: target, width: 1.2, type: "dashed" as const },
    }]),
    ...model.markers.map((marker) => ({
      xAxis: marker.index,
      // A vertical rule's label is drawn along it unless it is told not to.
      label: { show: true, position: "start" as const, rotate: 0, formatter: marker.label, color: target, padding: [0, 0, 2, 0] },
      lineStyle: { color: own, width: 1, type: "dotted" as const },
    })),
    ...(model.nextIndex === null ? [] : [{
      xAxis: model.nextIndex,
      label: { show: false },
      lineStyle: { color: target, width: 1, type: "dashed" as const },
    }]),
  ];

  return {
    animation: false,
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: (value: unknown) => (typeof value === "number" ? format(value) : "—") },
    xAxis: { type: "category", boundaryGap: false, data: model.labels },
    yAxis: { type: "value", scale: true, axisLabel: { formatter: (value: number) => format(value) } },
    series: [
      // The fluctuation band: an invisible floor and a pale ribbon stacked on
      // it, so the band is drawn to size rather than guessed at.
      ...(lower && width ? [
        { type: "line", stack: "band", silent: true, symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, data: lower, z: 1 },
        { type: "line", stack: "band", silent: true, symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: resolvedColor(BAND_COLOR) }, data: width, z: 1 },
      ] : []),
      ...model.rivals.map((line) => ({
        type: "line" as const,
        name: line.name,
        symbol: "none" as const,
        connectNulls: false,
        lineStyle: { color: resolvedColor(line.color), width: 1.8 },
        itemStyle: { color: resolvedColor(line.color) },
        // Directly labelled at the line's end: a legend a reader has to look
        // up is what makes a five-line chart unreadable.
        endLabel: { show: true, formatter: line.name, color: resolvedColor(line.color), distance: 4 },
        data: line.values,
        z: 2,
      })),
      {
        type: "line",
        name: model.own.name,
        symbol: "circle",
        symbolSize: 7,
        connectNulls: false,
        lineStyle: { color: own, width: 3, cap: "round" },
        itemStyle: { color: own },
        data: model.own.values.map((value, index) => {
          if (value === null) return null;
          // 「基线」 names the first reading only while it is the only one; in a
          // series the axis already says which end is the start, and the label
          // sat on top of the first date.
          const baseline = model.mode === "baseline" && index === model.baselineIndex;
          const last = index === model.lastIndex;
          return {
            value,
            symbolSize: last ? 9 : 7,
            itemStyle: last ? { color: resolvedColor("var(--bg)"), borderColor: own, borderWidth: 2.5 } : undefined,
            label: baseline || last
              ? {
                show: true,
                position: "top" as const,
                formatter: baseline ? `基线 ${format(value)}` : format(value),
                color: own,
                fontWeight: 600,
              }
              : undefined,
          };
        }),
        markLine: markLines.length === 0 ? undefined : { silent: true, symbol: "none", data: markLines },
        z: 3,
      },
    ],
  };
}
