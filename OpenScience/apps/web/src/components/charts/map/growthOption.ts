import type { EChartsCoreOption } from "echarts/core";
import { LANE_GLYPHS, LANE_WORDS, type Growth, type GrowthEvent, type Lane } from "@/components/memory/overview/memoryOverviewModel";
import { escapeTooltip } from "../echartsBase";
import { heatStep } from "./activityOption";
import { weekLabels } from "./changeWeeks";
import type { MapPalette } from "./palette";
import { dayEndMs, dayIn, dayStartMs } from "./zone";

/**
 * The growth strip of the overview: what the capsule gained, on one axis — the only canvas of the page.
 *
 * Up to thirty gains it is **one dot for each**, in a lane for each kind that has any: 记下 ●, 学会 ▲, 资料 ■, 收下 ◆. A day with several
 * stacks its dots up the lane instead of hiding them behind one another. Past thirty a dot each is a pile, and the strip counts the weeks:
 * one cell for each week and lane, its count printed in it, in six steps of one hue. Either way it counts gains only — what was replaced or
 * forgotten is the time view's — and colours are the map's two: the brand blue for the mark and the one hue of the heat, a shape (never
 * the colour) telling the kind. Where nothing happened nothing is drawn: no line joins sparse points and no empty day is marked as missed.
 */

/** The symbol of a lane, by shape. */
export const LANE_SYMBOLS: Readonly<Record<Lane, string>> = { noted: "circle", learned: "triangle", documents: "rect", received: "diamond" };

/** How far a dot may be moved up or down inside its lane when a day has several, as a share of the lane. */
const SPREAD = 0.6;

/** A dot's place up its lane: one alone is in the middle, several stand in a column across `SPREAD` of it. */
export function laneOffset(index: number, count: number): number {
  if (count <= 1) return 0;
  return (index / (count - 1) - 0.5) * SPREAD;
}

/** A dot of the strip: where it stands and the event it is. */
export interface GrowthDot {
  /** The event's index in the list the strip was made from, so a press finds what it opens. */
  event: number;
  lane: Lane;
  /** [the day's start in ms, the lane's row plus its offset]. */
  value: [number, number];
}

/** The dots of a strip: one for each event, those of one day and lane in a column. */
export function growthDots(events: readonly GrowthEvent[], lanes: readonly Lane[], timeZone: string): GrowthDot[] {
  const dots: GrowthDot[] = [];
  const groups = new Map<string, number[]>();
  events.forEach((event, index) => {
    if (!lanes.includes(event.lane)) return;
    const key = `${event.lane}|${event.day}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  for (const members of groups.values()) {
    members.forEach((eventIndex, place) => {
      const event = events[eventIndex]!;
      dots.push({ event: eventIndex, lane: event.lane, value: [dayStartMs(event.day, timeZone) + 12 * 3_600_000, lanes.indexOf(event.lane) + laneOffset(place, members.length)] });
    });
  }
  return dots;
}

/** What a dot says when it is pointed at: the thing, or the lane's word, and the day. */
export function dotTooltip(event: GrowthEvent, formatDay: (day: string) => string): string {
  const what = event.title || { noted: "记下了一件事", learned: "学会了一个做法", documents: "放进了一份资料", received: "收下了一个胶囊" }[event.lane];
  return `<div style="max-width:260px;white-space:normal">${escapeTooltip(what)}</div><div>${escapeTooltip(`${LANE_WORDS[event.lane]} · ${formatDay(event.day)}`)}</div>`;
}

/** What a week's cell says: the days, then each lane that gained something. */
export function weekCellTooltip(week: Growth["weeks"][number], formatDay: (day: string) => string): string {
  const counts = (Object.keys(LANE_WORDS) as Lane[]).filter((lane) => week.counts[lane] > 0).map((lane) => `${LANE_WORDS[lane]} ${week.counts[lane]}`);
  return `<div>${escapeTooltip(`${formatDay(week.start)} ～ ${formatDay(week.end)}`)}</div><div>${escapeTooltip(counts.join(" · ") || "这一周没有新增")}</div>`;
}

export interface GrowthInput {
  growth: Growth;
  events: readonly GrowthEvent[];
  timeZone: string;
  palette: MapPalette;
  /** A calendar day as the page words it (「9月15日」). */
  formatDay: (day: string) => string;
}

/** The strip as a chart option; null when there is nothing to draw. */
export function growthOption({ growth, events, timeZone, palette, formatDay }: GrowthInput): EChartsCoreOption | null {
  if (growth.shape === "none" || !growth.first) return null;
  const rows = growth.lanes.map((lane) => `${LANE_GLYPHS[lane]} ${LANE_WORDS[lane]}`);
  const rowAxis = {
    type: "category" as const, inverse: true, data: rows, axisLine: { show: false }, axisTick: { show: false },
    splitLine: { show: true, lineStyle: { color: palette.grid } }, axisLabel: { color: palette.text, fontSize: 12 },
  };
  const grid = { left: 64, right: 18, top: 8, bottom: 28 };

  if (growth.shape === "dots") {
    // The axis counts days under two weeks of history and weeks after: its ticks are that many days apart, from the first day.
    const min = dayStartMs(growth.first, timeZone);
    const max = dayEndMs(growth.today, timeZone);
    const dots = growthDots(events, growth.lanes, timeZone);
    return {
      animation: false, grid,
      tooltip: { confine: true, formatter: (params: { data?: { event?: number } }) => { const event = typeof params.data?.event === "number" ? events[params.data.event] : undefined; return event ? dotTooltip(event, formatDay) : ""; } },
      xAxis: {
        type: "time", min, max, minInterval: growth.axis === "days" ? 86_400_000 : 7 * 86_400_000,
        axisLine: { lineStyle: { color: palette.grid } }, splitLine: { show: false },
        // A tick says its day the way the page does (「9月22日」), not the library's English month or a bare day number.
        axisLabel: { color: palette.textFaint, hideOverlap: true, formatter: (value: number) => formatDay(dayIn(value, timeZone)) },
      },
      yAxis: rowAxis,
      series: growth.lanes.map((lane) => ({
        type: "scatter", name: LANE_WORDS[lane], symbol: LANE_SYMBOLS[lane], symbolSize: 12, z: 3,
        itemStyle: { color: palette.current, borderColor: palette.surface, borderWidth: 1 },
        data: dots.filter((dot) => dot.lane === lane).map((dot) => ({ value: dot.value, event: dot.event })),
      })),
    };
  }

  // Weekly counts: a cell for each week and lane, its count printed in it. A custom series, not a heatmap: the library's cartesian heatmap
  // is drawn only through a visual map, and the cell's step is already decided here, one hue in six steps (`heatStep`).
  const busiest = Math.max(1, ...growth.weeks.flatMap((week) => growth.lanes.map((lane) => week.counts[lane])));
  const cells = growth.weeks.flatMap((week, weekIndex) => growth.lanes.map((lane, laneIndex) => {
    const count = week.counts[lane];
    return { value: [weekIndex, laneIndex, count, heatStep(count, busiest)] };
  }));
  return {
    animation: false, grid: { ...grid, bottom: 32 },
    tooltip: { confine: true, formatter: (params: { data?: { value?: number[] } }) => { const week = growth.weeks[params.data?.value?.[0] ?? -1]; return week ? weekCellTooltip(week, formatDay) : ""; } },
    xAxis: { type: "category", data: weekLabels(growth.weeks), axisTick: { show: false }, axisLine: { lineStyle: { color: palette.grid } }, axisLabel: { color: palette.textFaint, hideOverlap: true } },
    yAxis: { ...rowAxis, splitLine: { show: false } },
    series: [{
      type: "custom", name: "每周新增", data: cells, encode: { x: 0, y: 1 }, z: 2,
      renderItem: (_params: unknown, api: any) => {
        const [width, height] = api.size([1, 1]) as [number, number];
        const [x, y] = api.coord([api.value(0), api.value(1)]) as [number, number];
        const count = api.value(2) as number;
        return {
          type: "group",
          children: [
            { type: "rect", shape: { x: x - width / 2 + 1, y: y - height / 2 + 1, width: Math.max(1, width - 2), height: Math.max(1, height - 2), r: 2 }, style: { fill: palette.heat[api.value(3) as number] } },
            ...(count > 0 ? [{ type: "text", style: { text: String(count), x, y, textAlign: "center", textVerticalAlign: "middle", fill: palette.text, fontSize: 11 } }] : []),
          ],
        };
      },
    }],
  };
}
