import type { EChartsCoreOption } from "echarts/core";
import type { MapEvent, MapLane } from "@/lib/memoryMapClient";
import { escapeTooltip } from "../echartsBase";
import type { MapPalette } from "./palette";
import { dayEndMs, dayIn, dayStartMs } from "./zone";

/**
 * How things changed, on one time axis (spec §2, V4).
 *
 * The upper rows are **lineages**: one row for each understanding that was replaced, a bar for every version over the interval it
 * held — blue while it held, grey once replaced, an amber mark where it disagreed with another. They are the part of the map no
 * other product has: the data (`valid_from`, `invalid_since`, `superseded_by`) is the platform's own. The lower rows are
 * **events**, one row per project and one for the account: a mark for each thing remembered, its shape telling what (a diamond a
 * decision, a cross a correction, a triangle a method learned, a dot the rest). Where nothing happened nothing is drawn — no line
 * joins sparse points.
 *
 * The slider under the axis is the map's shared time filter: moving it chooses the range, so the other views read the same
 * window. The axis itself does not move with the range (it is the whole span the account has been remembering), so the slider
 * always shows where the window is in it.
 */

export interface TimeRow {
  key: string;
  label: string;
  kind: "lane" | "events";
}

/** The most lineages drawn above the events. */
export const TIME_LANE_ROWS = 10;

/** The rows, top to bottom: lineages first, then the events' rows — only those that have an event. */
export function timeRows(lanes: readonly MapLane[], events: readonly MapEvent[], projectName: (id: string) => string): TimeRow[] {
  const rows: TimeRow[] = lanes.slice(0, TIME_LANE_ROWS).map((lane) => ({ key: lane.id, label: lane.label, kind: "lane" }));
  const present = [...new Set(events.map((event) => event.lane))];
  const keys = [...present.filter((key) => key.startsWith("project:")).sort(), ...present.filter((key) => key === "account")];
  for (const key of keys) rows.push({ key, label: key === "account" ? "你自己" : projectName(key.slice("project:".length)), kind: "events" });
  return rows;
}

/** The span the axis covers: from the first thing remembered to today. YYYY-MM-DD. */
export function timeExtent({ since, lanes, events, today }: { since: string | null; lanes: readonly MapLane[]; events: readonly MapEvent[]; today: string }, timeZone: string): { from: string; to: string } {
  const days = [since, ...lanes.flatMap((lane) => lane.segments.map((segment) => segment.from)), ...events.map((event) => event.at)]
    .filter((value): value is string => Boolean(value)).map((value) => (value.length === 10 ? value : dayIn(Date.parse(value), timeZone))).sort();
  const first = days[0] ?? today;
  // Never a span of a day: a lone memory still has an axis to stand on.
  const from = first >= today ? new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10) : first;
  return { from, to: today };
}

/** What a zoom event chose, as days; null for the whole span. */
export function windowFromZoom(params: { start?: number; end?: number; batch?: Array<{ start?: number; end?: number }> } | null | undefined,
  extent: { from: string; to: string }, timeZone: string): { from: string; to: string } | null {
  const zoom = params?.batch?.[0] ?? params;
  if (!zoom || typeof zoom.start !== "number" || typeof zoom.end !== "number") return null;
  const first = dayStartMs(extent.from, timeZone);
  const last = dayEndMs(extent.to, timeZone);
  const at = (percent: number) => first + ((last - first) * Math.max(0, Math.min(100, percent))) / 100;
  const from = dayIn(at(zoom.start), timeZone);
  const to = dayIn(at(zoom.end), timeZone);
  return from <= extent.from && to >= extent.to ? null : { from, to };
}

/** The range parameter for a window: `YYYY-MM-DD..YYYY-MM-DD`, or `all`. */
export function rangeOfWindow(window: { from: string; to: string } | null): string {
  return window ? `${window.from}..${window.to}` : "all";
}

/** The window a range parameter names, as the days the slider is set to; null for all of it. */
export function windowOfRange(range: string): { from: string; to: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/u.exec(range);
  return match ? { from: match[1], to: match[2] } : null;
}

/** The symbol of an event: its kind, by shape. */
export function eventSymbol(event: Pick<MapEvent, "kind" | "type">): string {
  if (event.kind === "decision") return "diamond";
  if (event.kind === "correction") return "path://M2,0 L5,3 L8,0 L10,2 L7,5 L10,8 L8,10 L5,7 L2,10 L0,8 L3,5 L0,2 Z";
  if (event.type === "method") return "triangle";
  return "circle";
}

const CHANGE_WORDS: Record<string, string> = {
  created: "记下", updated: "改动", superseded: "被后来的说法替代", archived: "忘记", restored: "恢复", confirmed: "确认", status: "状态变化",
  learned: "学会", approved: "开始生效", retired: "停用",
};

export function eventTooltip(event: MapEvent, formatDay: (iso: string) => string): string {
  return `<div style="max-width:260px;white-space:normal">${escapeTooltip(event.text || "")}</div><div>${escapeTooltip([CHANGE_WORDS[event.change] ?? event.change, formatDay(event.at)].join(" · "))}</div>`;
}

export function segmentTooltip(lane: MapLane, index: number, formatDay: (iso: string | null) => string): string {
  const segment = lane.segments[index];
  const held = [formatDay(segment.from), segment.to ? formatDay(segment.to) : "至今"].join(" ～ ");
  return `<div style="max-width:260px;white-space:normal">${escapeTooltip(segment.text)}</div><div>${escapeTooltip(held)}${segment.conflict ? " · 和另一条说法不一致" : ""}</div>`;
}

export interface TimeInput {
  lanes: readonly MapLane[];
  events: readonly MapEvent[];
  rows: readonly TimeRow[];
  extent: { from: string; to: string };
  /** The window the slider is set to; null is the whole span. */
  window: { from: string; to: string } | null;
  timeZone: string;
  now: number;
  palette: MapPalette;
  formatDay: (iso: string | null) => string;
}

/** A bar's box in pixels, kept inside the plot. Pure so it can be tested without a canvas. */
export function barShape(start: number, end: number, y: number, height: number, plot: { x: number; y: number; width: number; height: number }) {
  const x = Math.max(plot.x, start);
  const right = Math.min(plot.x + plot.width, Math.max(end, start + 3));
  return right <= x ? null : { x, y: y - height / 2, width: right - x, height };
}

export function timeOption(input: TimeInput): EChartsCoreOption {
  const { palette, timeZone } = input;
  const rowIndex = new Map(input.rows.map((row, position) => [row.key, position]));
  const min = dayStartMs(input.extent.from, timeZone);
  const max = dayEndMs(input.extent.to, timeZone);
  const startValue = input.window ? dayStartMs(input.window.from, timeZone) : min;
  const endValue = input.window ? dayEndMs(input.window.to, timeZone) : max;

  const bars = input.lanes.flatMap((lane, laneIndex) => {
    const row = rowIndex.get(lane.id);
    if (row === undefined) return [];
    return lane.segments.map((segment, index) => ({
      value: [row, segment.from ? Date.parse(segment.from) : min, segment.to ? Date.parse(segment.to) : input.now, segment.state, segment.conflict ? 1 : 0, laneIndex, index],
      recordId: segment.recordId,
    }));
  });
  const marks = input.events.flatMap((event) => {
    const row = rowIndex.get(event.lane);
    if (row === undefined) return [];
    const gone = event.change === "superseded" || event.change === "archived";
    return [{
      value: [Date.parse(event.at), row], symbol: eventSymbol(event), symbolSize: 11, id: event.ref, eventId: event.id,
      itemStyle: { color: gone ? palette.replaced : palette.current, borderColor: palette.surface, borderWidth: 1 },
    }];
  });

  return {
    animation: false,
    grid: { left: 132, right: 18, top: 10, bottom: 62 },
    tooltip: {
      confine: true,
      formatter: (params: { seriesType?: string; data?: { value?: number[]; eventId?: string } }) => {
        if (params.seriesType === "scatter") {
          const event = input.events.find((entry) => entry.id === params.data?.eventId);
          return event ? eventTooltip(event, (iso) => input.formatDay(iso)) : "";
        }
        const value = params.data?.value;
        const lane = typeof value?.[5] === "number" ? input.lanes[value[5]] : undefined;
        return lane && typeof value?.[6] === "number" ? segmentTooltip(lane, value[6], input.formatDay) : "";
      },
    },
    xAxis: { type: "time", min, max, axisLine: { lineStyle: { color: palette.grid } }, splitLine: { show: true, lineStyle: { color: palette.grid } }, axisLabel: { color: palette.textFaint, hideOverlap: true } },
    yAxis: {
      type: "category", inverse: true, data: input.rows.map((row) => row.label),
      axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: true, lineStyle: { color: palette.grid } },
      axisLabel: { color: palette.text, width: 118, overflow: "truncate", fontSize: 12 },
    },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, startValue, endValue, filterMode: "none" },
      { type: "slider", xAxisIndex: 0, startValue, endValue, filterMode: "none", height: 24, bottom: 10, brushSelect: false, borderColor: palette.grid, textStyle: { color: palette.textFaint } },
    ],
    series: [
      {
        type: "custom", name: "沿革", data: bars, encode: { x: [1, 2], y: 0 }, z: 2,
        renderItem: (params: any, api: any) => {
          const row = api.value(0);
          const from = api.coord([api.value(1), row]);
          const to = api.coord([api.value(2), row]);
          const height = Math.min(18, api.size([0, 1])[1] * 0.46);
          const shape = barShape(from[0], to[0], from[1], height, params.coordSys);
          if (!shape) return null;
          const replaced = api.value(3) === "replaced";
          return {
            type: "group",
            children: [
              { type: "rect", shape: { ...shape, r: 3 }, style: { fill: replaced ? palette.replaced : palette.current, opacity: replaced ? 0.5 : 0.9 } },
              ...(api.value(4) === 1 ? [{ type: "rect", shape: { x: shape.x, y: shape.y - 3, width: Math.min(shape.width, 14), height: 3 }, style: { fill: palette.check } }] : []),
            ],
          };
        },
      },
      { type: "scatter", name: "记下的事", data: marks, z: 3 },
    ],
  };
}
