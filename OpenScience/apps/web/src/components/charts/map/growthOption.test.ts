// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SVGRenderer } from "echarts/renderers";
import { echarts } from "../echartsBase";
import "./register";
import { growthOf, type GrowthEvent, type Lane } from "@/components/memory/overview/memoryOverviewModel";
import { TEST_PALETTE } from "./palette";
import { dotTooltip, growthDots, growthOption, laneOffset, LANE_SYMBOLS, weekCellTooltip } from "./growthOption";

const formatDay = (day: string) => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
const event = (lane: Lane, day: string, title: string | null = null): GrowthEvent => ({ lane, day, title, open: null });
const input = (events: GrowthEvent[], today = "2026-10-12") => ({ growth: growthOf(events, today, formatDay), events, timeZone: "UTC", palette: TEST_PALETTE, formatDay });
const draw = (option: unknown) => {
  echarts.use([SVGRenderer]);
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 640, height: 220 });
  chart.setOption(option as never);
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg;
};

describe("the growth strip", () => {
  it("draws nothing for a capsule that has gained nothing", () => {
    expect(growthOption(input([]))).toBeNull();
  });

  it("is one dot for each gain in a lane for each kind that has any, a shape for each lane and the brand blue for all", () => {
    const events = [event("noted", "2026-09-22"), event("noted", "2026-09-30"), event("learned", "2026-10-02", "先给结论"), event("documents", "2026-10-02"), event("received", "2026-10-09")];
    const option = growthOption(input(events)) as { series: Array<{ type: string; name: string; symbol: string; data: Array<{ value: number[]; event: number }>; itemStyle: { color: string } }>; yAxis: { data: string[]; inverse: boolean }; xAxis: { type: string } };
    expect(option.yAxis.data).toEqual(["● 记下", "▲ 学会", "■ 资料", "◆ 收下"]);
    expect(option.yAxis.inverse).toBe(true);
    expect(option.xAxis.type).toBe("time");
    expect(option.series.map((series) => [series.name, series.type, series.symbol, series.data.length])).toEqual([
      ["记下", "scatter", "circle", 2], ["学会", "scatter", "triangle", 1], ["资料", "scatter", "rect", 1], ["收下", "scatter", "diamond", 1],
    ]);
    expect(new Set(option.series.map((series) => series.itemStyle.color))).toEqual(new Set([TEST_PALETTE.current]));
    expect(Object.values(LANE_SYMBOLS)).toEqual(["circle", "triangle", "rect", "diamond"]);
    // Each dot knows the event it is, so a press finds what it opens.
    expect(option.series[1]!.data[0]!.event).toBe(2);
  });

  it("has no row for a lane with no gain: an account that has only documents has one lane", () => {
    const option = growthOption(input([event("documents", "2026-10-01"), event("documents", "2026-10-03")])) as { yAxis: { data: string[] }; series: unknown[] };
    expect(option.yAxis.data).toEqual(["■ 资料"]);
    expect(option.series).toHaveLength(1);
  });

  it("stands several gains of one day and lane in a column rather than one on top of another", () => {
    const events = [event("documents", "2026-10-01"), event("documents", "2026-10-01"), event("documents", "2026-10-01"), event("noted", "2026-10-01")];
    const dots = growthDots(events, ["noted", "documents"], "UTC");
    const documents = dots.filter((dot) => dot.lane === "documents").map((dot) => dot.value[1]);
    expect(new Set(documents).size).toBe(3);
    expect(documents.every((row) => row >= 1 - 0.31 && row <= 1 + 0.31)).toBe(true);
    expect(dots.find((dot) => dot.lane === "noted")!.value[1]).toBe(0);
    expect([laneOffset(0, 1), laneOffset(0, 2), laneOffset(1, 2), laneOffset(1, 3)]).toEqual([0, -0.3, 0.3, 0]);
    // The same day is the same x: the day's middle in the researcher's zone.
    expect(new Set(dots.map((dot) => dot.value[0])).size).toBe(1);
  });

  it("counts weeks past thirty: a cell for each week and lane with its count in it, in the heat of one hue", () => {
    const events = [...Array.from({ length: 20 }, (_unused, index) => event("noted", `2026-09-${String(1 + (index % 28)).padStart(2, "0")}`)), ...Array.from({ length: 12 }, () => event("documents", "2026-09-29"))];
    const built = input(events);
    expect(built.growth.shape).toBe("weeks");
    const option = growthOption(built) as { series: Array<{ type: string; data: Array<{ value: number[] }> }>; xAxis: { type: string; data: string[] }; yAxis: { data: string[] } };
    expect(option.yAxis.data).toEqual(["● 记下", "■ 资料"]);
    expect(option.series).toHaveLength(1);
    expect(option.series[0]!.type).toBe("custom");
    expect(option.xAxis.data).toHaveLength(built.growth.weeks.length);
    const cells = option.series[0]!.data;
    expect(cells).toHaveLength(built.growth.weeks.length * 2);
    expect(cells.reduce((sum, cell) => sum + cell.value[2]!, 0)).toBe(32);
    // The busiest cell is the deepest of the six steps, an empty one the lightest.
    expect(cells.find((cell) => cell.value[2] === 12)!.value[3]).toBe(5);
    expect(cells.find((cell) => cell.value[2] === 0)!.value[3]).toBe(0);
    expect(cells.every((cell) => cell.value[3]! >= 0 && cell.value[3]! <= 5)).toBe(true);
  });

  it("says a dot by its thing or its lane, and a cell by its week and what each lane gained", () => {
    expect(dotTooltip(event("learned", "2026-10-02", "先给结论"), formatDay)).toContain("先给结论");
    expect(dotTooltip(event("learned", "2026-10-02", "先给结论"), formatDay)).toContain("学会 · 10月2日");
    expect(dotTooltip(event("documents", "2026-10-02"), formatDay)).toContain("放进了一份资料");
    expect(dotTooltip(event("noted", "2026-10-02", "<img src=x onerror=1>"), formatDay)).not.toContain("<img");
    const week = { start: "2026-09-21", end: "2026-09-27", counts: { noted: 2, learned: 0, documents: 1, received: 0 } };
    expect(weekCellTooltip(week, formatDay)).toContain("9月21日 ～ 9月27日");
    expect(weekCellTooltip(week, formatDay)).toContain("记下 2 · 资料 1");
    expect(weekCellTooltip({ ...week, counts: { noted: 0, learned: 0, documents: 0, received: 0 } }, formatDay)).toContain("这一周没有新增");
  });

  it("is drawn by the map's registrations: a scatter or a heatmap that is not registered is silently nothing", () => {
    const dots = draw(growthOption(input([event("noted", "2026-09-22"), event("learned", "2026-10-02"), event("documents", "2026-10-05")])));
    expect(dots).toContain(TEST_PALETTE.current);
    const events = [...Array.from({ length: 31 }, (_unused, index) => event("noted", `2026-09-${String(1 + (index % 28)).padStart(2, "0")}`))];
    const weeks = draw(growthOption(input(events)));
    expect(TEST_PALETTE.heat.some((step) => weeks.includes(step))).toBe(true);
  });

  it("uses no colour but the map's palette", () => {
    const text = JSON.stringify(growthOption(input([event("noted", "2026-09-22"), event("documents", "2026-10-01")])));
    expect(text.match(/#[0-9a-f]{3,8}\b/giu)?.filter((hex) => !Object.values(TEST_PALETTE).flat().includes(hex)) ?? []).toEqual([]);
  });
});
