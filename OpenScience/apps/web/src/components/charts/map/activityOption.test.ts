import { describe, expect, it } from "vitest";
import { TEST_PALETTE } from "./palette";
import { activityOption, calendarRange, dayTooltip, dayTotal, heatStep } from "./activityOption";

const day = (t: string, memory = 0, run = 0, method = 0, feedback = 0) => ({ t, memory, run, method, feedback });

describe("the calendar", () => {
  it("is the year ending today", () => {
    expect(calendarRange("2026-10-12")).toEqual(["2025-10-13", "2026-10-12"]);
  });
  it("steps a day's total by its share of the busiest, and an empty day is the first step, never a warning", () => {
    expect([0, 1, 5, 10, 20].map((total) => heatStep(total, 20))).toEqual([0, 1, 2, 3, 5]);
    expect(heatStep(3, 0)).toBe(0);
    expect(dayTotal(day("2026-10-01", 1, 2, 3, 4))).toBe(10);
  });
  it("colours each day by its step and marks today whether or not anything happened", () => {
    const option: any = activityOption({ series: [day("2026-10-01", 4), day("2026-10-02", 1), day("2026-10-12", 2)], today: "2026-10-12", palette: TEST_PALETTE });
    const cells = Object.fromEntries(option.series[0].data.map((cell: any) => [cell.value[0], cell]));
    expect(cells["2026-10-01"].itemStyle.color).toBe("#h5");
    expect(cells["2026-10-02"].itemStyle.color).toBe("#h2");
    expect(cells["2026-10-12"].itemStyle.borderColor).toBe("#text");
    const quiet: any = activityOption({ series: [day("2026-10-01", 1)], today: "2026-10-12", palette: TEST_PALETTE });
    expect(quiet.series[0].data.find((cell: any) => cell.value[0] === "2026-10-12").itemStyle.color).toBe("#h0");
    expect(option.calendar.dayLabel.firstDay).toBe(1);
    expect(option.calendar.itemStyle.color).toBe("#h0");
  });
  it("leaves out the days before the year", () => {
    const option: any = activityOption({ series: [day("2024-01-01", 9), day("2026-10-01", 1)], today: "2026-10-12", palette: TEST_PALETTE });
    expect(option.series[0].data.map((cell: any) => cell.value[0])).toEqual(["2026-10-01", "2026-10-12"]);
  });
  it("says what happened that day, and only that, with no streak and no judgement of a quiet one", () => {
    expect(dayTooltip(day("2026-10-01", 3, 2))).toContain("记忆 3 · 对话 2");
    expect(dayTooltip(day("2026-10-02"))).toContain("这天没有记录");
    const text = JSON.stringify(activityOption({ series: [day("2026-10-01", 3)], today: "2026-10-12", palette: TEST_PALETTE }));
    expect(text).not.toMatch(/连续|streak|断/u);
  });
});
