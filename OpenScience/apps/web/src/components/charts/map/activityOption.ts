import type { EChartsCoreOption } from "echarts/core";
import type { MapDay } from "@/lib/memoryMapClient";
import { escapeTooltip } from "../echartsBase";
import type { MapPalette } from "./palette";

/**
 * The calendar of the last year: how busy each day was, in six steps of one hue, empty days a neutral grey.
 *
 * What it is for is the sense of having built something up — and so it is the opposite of a streak: nothing counts days in a row,
 * an empty day is not marked as missed (it is the lightest step, the same grey as the page's grid), and nobody is ranked. A day is
 * counted in the researcher's own time zone, which the page says beside the legend. A day is a button: choosing it narrows the map
 * to that day, and the list under it says what was remembered then.
 */

/** A day's number is the memories remembered or changed, the conversations, the methods learned and the corrections made. */
export function dayTotal(day: MapDay): number {
  return day.memory + day.run + day.method + day.feedback;
}

/** Which of the six steps a day's total falls in: 0 for none, then five by its share of the busiest day. */
export function heatStep(total: number, busiest: number): number {
  if (total <= 0 || busiest <= 0) return 0;
  return Math.max(1, Math.min(5, Math.ceil((total / busiest) * 5)));
}

/** The first and last day of the year ending on `to`, as the library's calendar range. @param to YYYY-MM-DD */
export function calendarRange(to: string): [string, string] {
  const end = new Date(`${to}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364);
  return [start.toISOString().slice(0, 10), to];
}

/** What a day's tooltip says: only the kinds that happened. Numbers only, so nothing to escape but the day itself. */
export function dayTooltip(day: MapDay): string {
  const parts = [
    day.memory ? `记忆 ${day.memory}` : "", day.run ? `对话 ${day.run}` : "", day.method ? `学会做法 ${day.method}` : "", day.feedback ? `修改与纠正 ${day.feedback}` : "",
  ].filter(Boolean);
  return `<div>${escapeTooltip(day.t)}</div><div>${escapeTooltip(parts.join(" · ") || "这天没有记录")}</div>`;
}

export interface ActivityInput {
  series: readonly MapDay[];
  /** Today, in the researcher's zone: the last day of the calendar. YYYY-MM-DD. */
  today: string;
  palette: MapPalette;
}

export function activityOption({ series, today, palette }: ActivityInput): EChartsCoreOption {
  const busiest = Math.max(0, ...series.map(dayTotal));
  const byDay = new Map(series.map((day) => [day.t, day]));
  const [from, to] = calendarRange(today);
  const data = series.filter((day) => day.t >= from && day.t <= to).map((day) => {
    const step = heatStep(dayTotal(day), busiest);
    return { value: [day.t, dayTotal(day)], itemStyle: { color: palette.heat[step], borderColor: day.t === today ? palette.text : palette.surface, borderWidth: day.t === today ? 2 : 1 } };
  });
  // Today is marked whether or not anything happened.
  if (!byDay.has(today)) data.push({ value: [today, 0], itemStyle: { color: palette.heat[0], borderColor: palette.text, borderWidth: 2 } });
  return {
    animation: false,
    tooltip: {
      confine: true,
      formatter: (params: { value?: [string, number] }) => {
        const day = byDay.get(String(params.value?.[0] ?? ""));
        return day ? dayTooltip(day) : `<div>${escapeTooltip(params.value?.[0])}</div><div>这天没有记录</div>`;
      },
    },
    calendar: {
      top: 28, left: 30, right: 8, bottom: 8, range: [from, to], cellSize: ["auto", 14],
      itemStyle: { color: palette.heat[0], borderColor: palette.surface, borderWidth: 1 },
      splitLine: { show: false },
      yearLabel: { show: false },
      monthLabel: { nameMap: "cn", color: palette.text, fontSize: 12 },
      dayLabel: { firstDay: 1, nameMap: "cn", color: palette.textFaint, fontSize: 11 },
    },
    series: [{ type: "heatmap", coordinateSystem: "calendar", data, emphasis: { itemStyle: { borderColor: palette.text, borderWidth: 2 } } }],
  };
}
