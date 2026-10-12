import type { EChartsCoreOption } from "echarts/core";
import type { MapDimension } from "@/lib/memoryMapClient";
import { escapeTooltip } from "../echartsBase";
import type { MapPalette } from "./palette";

/**
 * A radar is only honest when its axes mean something (spec §2, V3): here they are fixed, named and the researcher's own words —
 * the kinds of work the platform has done for them, and the aspects of them it remembers — never the top subjects of the month,
 * which would change who is on an axis. The number is printed at every vertex, because a radar's worst fault is that its values
 * cannot be read; the polygon one period back is a ghost behind it, on the same scale, so what changed is a change of shape.
 *
 * It is not drawn when it would say nothing: too few things counted, or all of them under one or two axes, where the polygon is a
 * needle. The page then says so in a sentence in its place.
 */

/** Fewer things counted than this, or fewer axes with something on them, and there is no shape to draw. */
export const RADAR_MIN_TOTAL = 6;
export const RADAR_MIN_AXES = 3;

export interface RadarState {
  drawable: boolean;
  /** The sentence that stands in the radar's place when it is not drawn. */
  sentence: string;
}

export function radarState(dimension: MapDimension): RadarState {
  const used = dimension.axes.filter((axis) => axis.count > 0).length;
  if (dimension.total >= RADAR_MIN_TOTAL && used >= RADAR_MIN_AXES) return { drawable: true, sentence: "" };
  return {
    drawable: false,
    sentence: dimension.id === "work"
      ? (dimension.total < RADAR_MIN_TOTAL ? "最近 30 天的对话还不多，这里先不画图。" : "最近 30 天的对话大多是同一类事，画出来只是一根针，这里先不画图。")
      : "记下的内容还不多，再多聊几次，这里会长出各方面的分布。",
  };
}

/** A value as it is printed at its vertex. @param {MapDimension["scale"]} scale */
export function radarValue(scale: MapDimension["scale"], value: number): string {
  return scale === "share" ? `${Math.round(value * 100)}%` : String(Math.round(value));
}

/** One scale for both polygons: the larger of the two, with room, rounded to a number a reader can find on the rings. */
export function radarMax(dimension: MapDimension): number {
  const top = Math.max(0, ...dimension.axes.flatMap((axis) => [axis.value, axis.previousValue]));
  if (dimension.scale === "share") return Math.min(1, Math.max(0.25, (Math.ceil((top * 1.15) / 0.05) * 5) / 100));
  return Math.max(4, Math.ceil(top * 1.15));
}

export function radarOption(dimension: MapDimension, palette: MapPalette): EChartsCoreOption {
  const max = radarMax(dimension);
  const printed = (value: number) => radarValue(dimension.scale, value);
  return {
    animation: false,
    tooltip: {
      confine: true,
      formatter: () => dimension.axes.map((axis) => `<div>${escapeTooltip(axis.label)}　${escapeTooltip(printed(axis.value))}　<span>${escapeTooltip(dimension.previous)} ${escapeTooltip(printed(axis.previousValue))}</span></div>`).join(""),
    },
    radar: {
      center: ["50%", "54%"], radius: "62%", shape: "polygon", splitNumber: 4, triggerEvent: true,
      indicator: dimension.axes.map((axis) => ({ name: axis.label, max })),
      axisName: { color: palette.text, fontSize: 12 },
      axisLine: { lineStyle: { color: palette.grid } },
      splitLine: { lineStyle: { color: palette.grid } },
      splitArea: { show: false },
    },
    series: [{
      type: "radar",
      data: [
        // The ghost first: it sits behind and takes no label.
        { name: dimension.previous, value: dimension.axes.map((axis) => axis.previousValue),
          lineStyle: { color: palette.replaced, width: 1.2, type: "dashed" }, itemStyle: { color: palette.replaced }, symbol: "none", areaStyle: { color: palette.replaced, opacity: 0.08 }, label: { show: false }, z: 1 },
        { name: "现在", value: dimension.axes.map((axis) => axis.value),
          lineStyle: { color: palette.current, width: 2.5 }, itemStyle: { color: palette.current }, symbol: "circle", symbolSize: 6,
          areaStyle: { color: palette.current, opacity: 0.16 },
          label: { show: true, formatter: (params: { value?: number }) => printed(Number(params.value) || 0), color: palette.text, fontSize: 12, fontWeight: 600, distance: 4 }, z: 2 },
      ],
    }],
  };
}
