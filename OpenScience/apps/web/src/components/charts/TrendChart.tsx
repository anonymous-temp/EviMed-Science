import { useMemo } from "react";
import { LineChart } from "echarts/charts";
import { GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import type { EChartsCoreOption } from "echarts/core";
import { CHART_STROKES } from "@evimed/design-tokens";
import { useColorScheme } from "@/lib/colorScheme";
import { canPaintChart, echarts, resolvedColor, useEChart } from "./echartsBase";
import { BAND_COLOR, TARGET_COLOR, trendModel, type TrendInput, type TrendModel } from "./trendModel";

// The line chart and the three things it needs, and nothing else in the
// library: no bar, pie, map, graph, data zoom or toolbox reaches the bundle.
echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent]);

/**
 * “投了有没有用” — the one chart that answers it (fusion plan §4.8).
 *
 * Ours is a thick brand line, every rival a grey, the target a dark dashed
 * rule, the measured fluctuation a pale ribbon around our line, and what we
 * did — the first articles going live, the placements taking effect — vertical
 * dashed markers, so a rise can be read against the thing that caused it. The
 * date of the next measurement is a slot of its own at the right, which is how
 * a chart with two readings still looks like a plan rather than a stub.
 *
 * With one reading it draws that reading against the target and the next
 * date, and the reading's level as a reference line labelled “基线 44” at its
 * right end (spec §32.7): a label on the point itself sat on the y axis, over
 * the tick numbers. There is no state in which this component paints an empty
 * frame.
 *
 * Line weights are the token table's (`CHART_STROKES`): ours 2.5, every other
 * line 1.5; a reference rule is a 1 px dash.
 *
 * Every line is told apart by its label at its end, not by colour alone; for
 * a reader who asked for more contrast, `useEChart` also gives each line a
 * dash and a marker shape of its own (spec §32.13 rule 4, `LINE_PATTERNS`).
 * Ours is the first line in the option so it keeps the solid stroke and the
 * circles; the drawing order is the series' `z`, not their order.
 */
export function TrendChart({
  input,
  format = (value: number) => String(Math.round(value)),
  height = 240,
  label,
  integer = false,
  unpainted,
}: {
  input: TrendInput;
  /** The value as a reader says it: “61”“15%”. */
  format?: (value: number) => string;
  height?: number;
  /** The chart's accessible name; its numbers are stated in the page around it. */
  label: string;
  /** A count: the axis steps by whole numbers, so a small one never reads “0, 1, 1, 2”. */
  integer?: boolean;
  /** What the figure says where no canvas can be painted; its measurements by default. */
  unpainted?: string;
}) {
  const model = useMemo(() => trendModel(input), [input]);
  // The scheme is a dependency of the option, not only of the instance: the
  // colours are resolved to literals before they reach the canvas.
  const scheme = useColorScheme();
  // `scheme` is not read in the body but is read through it: `chartOption`
  // resolves the palette's custom properties against the live document, and a
  // theme flip changes every one of them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const option = useMemo(() => (model.mode === "empty" ? null : chartOption(model, format, { integer })), [model, format, integer, scheme]);
  const host = useEChart(option);
  const plot = model.mode === "baseline" ? Math.min(height, 176) : height;
  return (
    <figure
      data-chart="trend"
      data-chart-mode={model.mode}
      data-chart-readings={model.readings}
      data-chart-rivals={model.rivals.length}
      className="m-0 min-w-0"
    >
      <div ref={host} role="img" aria-label={label} style={{ height: plot }} className="w-full" />
      {!canPaintChart() && (
        // Where a canvas cannot be painted (a test, a printed page), the chart
        // still says what it holds rather than leaving a blank box.
        <figcaption className="text-caption text-text-3">
          {unpainted ?? (model.mode === "baseline" ? "只有一次测量：基线。" : `${model.readings} 次测量。`)}
        </figcaption>
      )}
    </figure>
  );
}

/** A rule's label, inside the plot and clear of the axis numbers (spec §32.7: at least 8 px). */
const RULE_LABEL_GAP = 8;
/** The band above the plot a marker's label is written in. */
const MARKER_BAND = 32;
/** How far a marker's label on the latest reading stops short of that reading's number. */
const LAST_VALUE_CLEARANCE = 36;

/** Which way a marker's label runs from its rule: rightwards in the left half, leftwards in the right. */
export function markerAlign(index: number, slots: number): "left" | "right" {
  return slots > 1 && index / (slots - 1) > 0.5 ? "right" : "left";
}

/** The latest reading is the hollow dot, drawn larger than a plain point so its ring reads. */
const LAST_MARKER = CHART_STROKES.marker + 4;

/**
 * Where each horizontal rule writes its label. The right end is the default
 * (spec §32.7); the target moves to the left end when the right is taken —
 * by the rivals' own names at their line ends, or by the baseline's label —
 * and when both rules are drawn, the lower one writes under its line so the
 * two labels can never meet however close the values are.
 */
export function ruleLabelPlaces(model: TrendModel): { target: string; baseline: string } {
  const rightTaken = model.rivals.length > 0 || model.baseline !== null;
  const end = rightTaken ? "insideStart" : "insideEnd";
  if (model.baseline === null || model.target === null) return { target: `${end}Top`, baseline: "insideEndTop" };
  const targetHigher = model.target >= model.baseline.value;
  return { target: `${end}${targetHigher ? "Top" : "Bottom"}`, baseline: `insideEnd${targetHigher ? "Bottom" : "Top"}` };
}

/** The ECharts option, built from the model so the drawing has no decisions left. */
export function chartOption(
  model: TrendModel,
  format: (value: number) => string,
  { integer = false }: { integer?: boolean } = {},
): EChartsCoreOption {
  const own = resolvedColor(model.own.color);
  const target = resolvedColor(TARGET_COLOR);
  const band = model.band;
  const lower = band === null ? null : model.own.values.map((value) => (value === null ? null : value - band));
  const width = band === null ? null : model.own.values.map((value) => (value === null ? null : band * 2));
  const places = ruleLabelPlaces(model);
  const markLines = [
    ...(model.target === null ? [] : [{
      yAxis: model.target,
      label: {
        show: true,
        position: places.target,
        distance: RULE_LABEL_GAP,
        formatter: model.targetLabel ?? `目标 ${format(model.target)}`,
      },
      lineStyle: { color: target, width: 1, type: "dashed" as const },
    }]),
    ...(model.baseline === null ? [] : [{
      yAxis: model.baseline.value,
      label: {
        show: true,
        position: places.baseline,
        distance: RULE_LABEL_GAP,
        formatter: `基线 ${format(model.baseline.value)}`,
        color: own,
        fontWeight: 600,
      },
      lineStyle: { color: own, width: 1, type: "dotted" as const },
    }]),
    ...model.markers.map((marker) => ({
      xAxis: marker.index,
      // A vertical rule's label is drawn along it unless it is told not to.
      // It sits at the rule's top (spec §32.7 rule 4): at its foot it met the
      // axis dates. A rule in the right half writes its label leftwards from
      // itself, so the label never runs off the plot or over the latest value.
      label: {
        show: true, position: "end" as const, rotate: 0, distance: 4, formatter: marker.label, color: target,
        align: markerAlign(marker.index, model.labels.length),
        // On the latest reading, the reading's own number is written above
        // the same point: the label stops short of it.
        padding: marker.index === model.lastIndex && model.baseline === null ? [0, LAST_VALUE_CLEARANCE, 0, 0] : 0,
      },
      // An action is a 1 px dashed rule in the graphics grey (spec §32.7).
      lineStyle: { color: resolvedColor("var(--text-graphic)"), width: 1, type: "dashed" as const },
    })),
    ...(model.nextIndex === null ? [] : [{
      xAxis: model.nextIndex,
      label: { show: false },
      lineStyle: { color: target, width: 1, type: "dashed" as const },
    }]),
  ];

  return {
    animation: false,
    // A marker's label is written above the plot, so the plot starts lower.
    grid: { left: 8, right: 8, top: model.markers.length > 0 ? MARKER_BAND : 16, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: (value: unknown) => (typeof value === "number" ? format(value) : "—") },
    xAxis: { type: "category", boundaryGap: false, data: model.labels },
    yAxis: { type: "value", scale: true, ...(integer ? { minInterval: 1 } : {}), axisLabel: { formatter: (value: number) => format(value) } },
    series: [
      // The fluctuation band: an invisible floor and a pale ribbon stacked on
      // it, so the band is drawn to size rather than guessed at.
      ...(lower && width ? [
        { type: "line", stack: "band", silent: true, symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, data: lower, z: 1 },
        { type: "line", stack: "band", silent: true, symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: resolvedColor(BAND_COLOR) }, data: width, z: 1 },
      ] : []),
      // Ours before the rivals: under patterns the first line is the solid
      // one with circles (`LINE_PATTERNS`). `z` still draws it on top.
      {
        type: "line",
        name: model.own.name,
        symbol: "circle",
        symbolSize: CHART_STROKES.marker,
        connectNulls: false,
        lineStyle: { color: own, width: CHART_STROKES.own, cap: "round" },
        itemStyle: { color: own },
        data: model.own.values.map((value, index) => {
          if (value === null) return null;
          const last = index === model.lastIndex;
          // A single reading is labelled by its reference line, not on the
          // point: the point sits on the y axis, and a label there covers the
          // axis numbers (G12). In a series the latest value is labelled.
          const labelled = last && model.baseline === null;
          return {
            value,
            symbolSize: last ? LAST_MARKER : CHART_STROKES.marker,
            itemStyle: last ? { color: resolvedColor("var(--bg)"), borderColor: own, borderWidth: CHART_STROKES.own } : undefined,
            label: labelled
              ? { show: true, position: "top" as const, formatter: format(value), color: own, fontWeight: 600 }
              : undefined,
          };
        }),
        markLine: markLines.length === 0 ? undefined : { silent: true, symbol: "none", data: markLines },
        z: 3,
      },
      ...model.rivals.map((line) => ({
        type: "line" as const,
        name: line.name,
        symbol: "none" as const,
        connectNulls: false,
        lineStyle: { color: resolvedColor(line.color), width: CHART_STROKES.other },
        itemStyle: { color: resolvedColor(line.color) },
        // Directly labelled at the line's end: a legend a reader has to look
        // up is what makes a five-line chart unreadable.
        endLabel: { show: true, formatter: line.name, color: resolvedColor(line.color), distance: 4 },
        data: line.values,
        z: 2,
      })),
    ],
  };
}
