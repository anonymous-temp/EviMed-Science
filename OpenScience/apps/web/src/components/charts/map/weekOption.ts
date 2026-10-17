import type { EChartsCoreOption } from "echarts/core";
import { escapeTooltip } from "../echartsBase";
import { CHANGE_KINDS, CHANGE_NAMES, weekIndexRange, weekLabels, type ChangeKind, type WeekCounts } from "./changeWeeks";
import type { MapPalette } from "./palette";

/**
 * The weekly bars of the time view: 记下 / 合并 / 忘记 stacked in each week, over the whole span the account has been remembering,
 * with the window the page is narrowed to held by a slider at the top of the card — the one entry for the time window on this view.
 *
 * Three hues at most, as everywhere on the map: what was written is the brand blue, what was replaced the grey of a replaced mark,
 * and what was forgotten the lighter grey of the line between marks; a week's counts are in its tooltip and in the list under the
 * chart, never told by colour alone. Where nothing happened in a week nothing is drawn.
 */

/** The colour of each count, from the map's palette. */
export function changeColors(palette: MapPalette): Record<ChangeKind, string> {
  return { noted: palette.current, merged: palette.replaced, forgotten: palette.line };
}

export interface WeekInput {
  weeks: readonly WeekCounts[];
  /** The window the slider is set to; null is the whole span. */
  window: { from: string; to: string } | null;
  palette: MapPalette;
  /** A calendar day as the page words it (「9月15日」). */
  formatDay: (day: string) => string;
}

/** A week's tooltip: the days it spans, then each count that is not zero. */
export function weekTooltip(week: WeekCounts, formatDay: (day: string) => string): string {
  const counts = CHANGE_KINDS.filter((kind) => week[kind] > 0).map((kind) => `${CHANGE_NAMES[kind]} ${week[kind]}`);
  return `<div>${escapeTooltip(`${formatDay(week.start)} ～ ${formatDay(week.end)}`)}</div><div>${escapeTooltip(counts.join(" · ") || "这一周没有变化")}</div>`;
}

export function weekOption({ weeks, window, palette, formatDay }: WeekInput): EChartsCoreOption {
  const labels = weekLabels(weeks);
  const colors = changeColors(palette);
  const held = weekIndexRange(weeks, window) ?? { first: 0, last: Math.max(0, weeks.length - 1) };
  const top = Math.max(1, ...weeks.map((week) => week.noted + week.merged + week.forgotten));
  return {
    animation: false,
    // The slider is the card's header: it stands at the top of the canvas, over the plot, not under the axis.
    // Fixed room for the axes' labels: `containLabel` is a legacy feature of the library that the map does not register.
    grid: { left: 36, right: 18, top: 52, bottom: 28 },
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" }, confine: true,
      formatter: (params: Array<{ dataIndex?: number }> | { dataIndex?: number }) => {
        const index = (Array.isArray(params) ? params[0] : params)?.dataIndex;
        const week = typeof index === "number" ? weeks[index] : undefined;
        return week ? weekTooltip(week, formatDay) : "";
      },
    },
    xAxis: { type: "category", data: labels, axisTick: { show: false }, axisLine: { lineStyle: { color: palette.grid } }, axisLabel: { color: palette.textFaint, hideOverlap: true } },
    yAxis: { type: "value", min: 0, max: top < 4 ? 4 : undefined, minInterval: 1, splitLine: { lineStyle: { color: palette.grid } }, axisLabel: { color: palette.textFaint } },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, startValue: held.first, endValue: held.last, filterMode: "none", zoomLock: false },
      {
        type: "slider", xAxisIndex: 0, startValue: held.first, endValue: held.last, filterMode: "none", height: 24, top: 8, brushSelect: false,
        borderColor: palette.grid, textStyle: { color: palette.textFaint }, showDetail: false,
      },
    ],
    series: CHANGE_KINDS.map((kind) => ({
      type: "bar", name: CHANGE_NAMES[kind], stack: "changes", barMaxWidth: 28, itemStyle: { color: colors[kind], borderRadius: 0 },
      data: weeks.map((week) => week[kind]),
    })),
  };
}
