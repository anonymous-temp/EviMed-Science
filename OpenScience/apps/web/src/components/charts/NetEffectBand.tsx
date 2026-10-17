import { useMemo } from "react";
import { LineChart } from "echarts/charts";
import { GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import type { EChartsCoreOption } from "echarts/core";
import { CHART_STROKES } from "@evimed/design-tokens";
import { canPaintChart, echarts, resolvedColor, useEChart } from "./echartsBase";
import { BAND_COLOR, OWN_COLOR, rivalColor, TARGET_COLOR } from "./trendModel";

echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent]);

/**
 * 「投了有没有用」 as one picture (R19, audit C §2.7 `NetEffectBand`): the question groups we worked on against the control groups we
 * only watched, each as its **change since the first round measured over the same things**, and around the control line the band
 * the platform's own measurement says is noise. A pilot line that stays inside the band is 「持平」; one that leaves it is an effect —
 * the verdict is the platform's (`arms.netEffect`, the same rule), this only lets the reader see it.
 *
 * The arms are lines of an index (the pilot ours, the control grey, the rule the whole product follows); what we did — the first
 * article placed, the first time an engine cited one — is a dashed rule on its round. A round measured over other engines or
 * questions than the first is not drawn: a change across it is not a change (R14 N-4), and the line breaks there rather than
 * guessing.
 */

export interface ArmPoint {
  date: string;
  value: number | null;
  /** What the round measured; a reading is compared to the first one's only where the keys are equal. */
  coverage?: string | null;
}

export interface NetEffectInput {
  /** One label per round, oldest first; the arms' points are matched to them by date. */
  labels: readonly string[];
  dates: readonly string[];
  pilot: readonly ArmPoint[];
  control: readonly ArmPoint[];
  /** The fluctuation the platform judged a change against, on the index's own scale; null before it is known. */
  band: number | null;
  markers?: ReadonlyArray<{ index: number; label: string }>;
}

export interface NetEffectModel {
  mode: "empty" | "series";
  labels: string[];
  /** The change since the first round both arms were read over the same things: null where there is no reading, or it is not comparable. */
  pilot: Array<number | null>;
  control: Array<number | null>;
  /** The round the changes are from. */
  baseIndex: number | null;
  band: number | null;
  markers: Array<{ index: number; label: string }>;
}

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

export function netEffectModel(input: NetEffectInput): NetEffectModel {
  const at = (points: readonly ArmPoint[], date: string) => points.find((point) => point.date === date) ?? null;
  const readings = input.dates.map((date) => ({ pilot: at(input.pilot, date), control: at(input.control, date) }));
  const base = readings.findIndex((row) => finite(row.pilot?.value) && finite(row.control?.value));
  if (base < 0) {
    return { mode: "empty", labels: [...input.labels], pilot: input.dates.map(() => null), control: input.dates.map(() => null), baseIndex: null, band: null, markers: [] };
  }
  const baseCoverage = readings[base].pilot?.coverage ?? readings[base].control?.coverage ?? null;
  const same = (point: ArmPoint | null) => finite(point?.value)
    && (baseCoverage === null || point?.coverage === undefined || point?.coverage === null || point.coverage === baseCoverage);
  const pilotBase = readings[base].pilot?.value as number;
  const controlBase = readings[base].control?.value as number;
  return {
    mode: "series",
    labels: [...input.labels],
    pilot: readings.map((row, index) => (index >= base && same(row.pilot) ? (row.pilot?.value as number) - pilotBase : null)),
    control: readings.map((row, index) => (index >= base && same(row.control) ? (row.control?.value as number) - controlBase : null)),
    baseIndex: base,
    band: finite(input.band) && input.band > 0 ? input.band : null,
    markers: (input.markers ?? []).filter((marker) => marker.index >= 0 && marker.index < input.labels.length && marker.label).map((marker) => ({ ...marker })),
  };
}

const changeText = (value: number) => {
  const rounded = Math.round(value * 10) / 10;
  return rounded > 0 ? `+${rounded}` : String(rounded);
};

export function netEffectOption(model: NetEffectModel): EChartsCoreOption {
  const own = resolvedColor(OWN_COLOR);
  const grey = resolvedColor(rivalColor(0));
  const rule = resolvedColor(TARGET_COLOR);
  const band = model.band;
  // A stacked band is drawn over values of one sign (the library stacks positives on positives and negatives on negatives), and a
  // change since the first round is negative as often as it is positive: every value is lifted by `lift` so the stack is of
  // positives, and the axis, the tooltip and the rules write the value less the lift.
  const raw = [...model.pilot, ...model.control, ...model.control.map((value) => (value === null || band === null ? null : value - band)),
    ...model.control.map((value) => (value === null || band === null ? null : value + band)), 0].filter((value): value is number => value !== null);
  const low = Math.floor(Math.min(...raw) - 1);
  const high = Math.ceil(Math.max(...raw) + 1);
  const lift = -low;
  const up = (value: number | null) => (value === null ? null : value + lift);
  const lower = band === null ? null : model.control.map((value) => (value === null ? null : value - band + lift));
  const width = band === null ? null : model.control.map((value) => (value === null ? null : band * 2));
  return {
    animation: false,
    grid: { left: 8, right: 48, top: model.markers.length > 0 ? 32 : 16, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: (value: unknown) => (typeof value === "number" ? changeText(value - lift) : "—") },
    xAxis: { type: "category", boundaryGap: false, data: model.labels },
    yAxis: { type: "value", min: 0, max: high + lift, axisLabel: { formatter: (value: number) => changeText(value - lift) } },
    series: [
      ...(lower && width ? [
        { type: "line", stack: "noise", silent: true, symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, data: lower, z: 1 },
        { type: "line", stack: "noise", silent: true, symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: resolvedColor(BAND_COLOR) }, data: width, z: 1, tooltip: { show: false } },
      ] : []),
      {
        type: "line",
        name: "投放的语义群",
        symbol: "circle",
        symbolSize: CHART_STROKES.marker,
        connectNulls: false,
        lineStyle: { color: own, width: CHART_STROKES.own, cap: "round" },
        itemStyle: { color: own },
        data: model.pilot.map(up),
        z: 3,
        markLine: {
          silent: true,
          symbol: "none",
          data: [
            { yAxis: lift, label: { show: true, position: "insideEndTop", formatter: "起点", color: rule }, lineStyle: { color: rule, width: 1, type: "dotted" } },
            ...model.markers.map((marker) => ({
              xAxis: marker.index,
              label: { show: true, position: "end", rotate: 0, distance: 4, formatter: marker.label, color: rule, align: marker.index / Math.max(1, model.labels.length - 1) > 0.5 ? "right" : "left" },
              lineStyle: { color: resolvedColor("var(--text-graphic)"), width: 1, type: "dashed" },
            })),
          ],
        },
      },
      {
        type: "line",
        name: "对照组",
        symbol: "none",
        connectNulls: false,
        lineStyle: { color: grey, width: CHART_STROKES.other },
        itemStyle: { color: grey },
        endLabel: { show: true, formatter: "对照组", color: grey, distance: 4 },
        data: model.control.map(up),
        z: 2,
      },
    ],
  };
}

export function NetEffectBand({
  input,
  label,
  height = 220,
  className,
}: {
  input: NetEffectInput;
  /** The chart's accessible name: the conclusion it shows. */
  label: string;
  height?: number;
  className?: string;
}) {
  const model = useMemo(() => netEffectModel(input), [input]);
  const option = useMemo(() => (model.mode === "empty" ? null : netEffectOption(model)), [model]);
  const host = useEChart(option);
  return (
    <figure data-chart="net-effect" data-chart-mode={model.mode} data-chart-band={model.band ?? undefined} className={`m-0 min-w-0 ${className ?? ""}`}>
      <div ref={host} role="img" aria-label={label} style={{ height }} className="w-full" />
      {!canPaintChart() && model.mode === "series" && (
        <figcaption className="text-caption tabular-nums text-text-3">
          {`投放的语义群 ${model.pilot.map((value) => (value === null ? "—" : changeText(value))).join(" / ")}；对照组 ${model.control.map((value) => (value === null ? "—" : changeText(value))).join(" / ")}`}
        </figcaption>
      )}
    </figure>
  );
}
