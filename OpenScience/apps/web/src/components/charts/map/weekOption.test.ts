// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SVGRenderer } from "echarts/renderers";
import { echarts } from "../echartsBase";
import "./register";
import { weeklyChanges } from "./changeWeeks";
import { TEST_PALETTE } from "./palette";
import { changeColors, weekOption, weekTooltip } from "./weekOption";

const weeks = weeklyChanges([
  { type: "memory", change: "created", at: "2026-09-22T01:00:00Z" }, { type: "memory", change: "created", at: "2026-09-23T01:00:00Z" },
  { type: "memory", change: "superseded", at: "2026-09-24T01:00:00Z" }, { type: "memory", change: "archived", at: "2026-10-13T01:00:00Z" },
], { from: "2026-09-22", to: "2026-10-14", timeZone: "Asia/Shanghai" });
const input = { weeks, window: null, palette: TEST_PALETTE, formatDay: (day: string) => day.slice(5) };

describe("the weekly bars", () => {
  it("stacks three series, 记下 then 合并 then 忘记, one value for each week, in three colours of the map's own palette", () => {
    const option = weekOption(input) as { series: Array<{ name: string; stack: string; data: number[]; itemStyle: { color: string } }> };
    expect(option.series.map((series) => series.name)).toEqual(["记下", "合并", "忘记"]);
    expect(new Set(option.series.map((series) => series.stack))).toEqual(new Set(["changes"]));
    expect(option.series.map((series) => series.data)).toEqual([[2, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 1]]);
    expect(option.series.map((series) => series.itemStyle.color)).toEqual([TEST_PALETTE.current, TEST_PALETTE.replaced, TEST_PALETTE.line]);
    expect(changeColors(TEST_PALETTE)).toEqual({ noted: TEST_PALETTE.current, merged: TEST_PALETTE.replaced, forgotten: TEST_PALETTE.line });
  });

  it("holds the window the page is narrowed to in one slider at the top, and the whole span when there is no window", () => {
    const whole = weekOption(input) as { dataZoom: Array<{ type: string; startValue: number; endValue: number; top?: number }> };
    expect(whole.dataZoom.map((zoom) => [zoom.type, zoom.startValue, zoom.endValue])).toEqual([["inside", 0, 3], ["slider", 0, 3]]);
    expect(whole.dataZoom.find((zoom) => zoom.type === "slider")?.top).toBeLessThan(20);
    const narrowed = weekOption({ ...input, window: { from: "2026-10-05", to: "2026-10-14" } }) as { dataZoom: Array<{ startValue: number; endValue: number }> };
    expect(narrowed.dataZoom.map((zoom) => [zoom.startValue, zoom.endValue])).toEqual([[2, 3], [2, 3]]);
  });

  it("tells a week by its days and the counts that are not zero", () => {
    expect(weekTooltip(weeks[0]!, input.formatDay)).toContain("09-21 ～ 09-27");
    expect(weekTooltip(weeks[0]!, input.formatDay)).toContain("记下 2 · 合并 1");
    expect(weekTooltip(weeks[0]!, input.formatDay)).not.toContain("忘记");
    expect(weekTooltip(weeks[1]!, input.formatDay)).toContain("这一周没有变化");
  });

  it("is drawn by the map's registrations: a bar series that is not registered is silently nothing", () => {
    echarts.use([SVGRenderer]);
    const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 640, height: 260 });
    chart.setOption(weekOption(input));
    const svg = chart.renderToSVGString();
    chart.dispose();
    // Stacked bars are paths in the series' colours: the blue of 记下 is on the page, so the series were drawn.
    expect(svg).toContain(TEST_PALETTE.current);
    expect((svg.match(/<path/gu) ?? []).length).toBeGreaterThan(3);
  });
});
