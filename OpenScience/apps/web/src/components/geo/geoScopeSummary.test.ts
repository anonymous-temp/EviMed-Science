import { expect, it } from "vitest";
import { geoScopeSummary } from "./geoScopeSummary";

it("describes the selected time, comparison, models and question groups", () => {
  expect(geoScopeSummary({ from: "2026-10-01", to: "2026-10-31", compareFrom: "2026-09-01", compareTo: "2026-09-30", engines: ["kimi"], groupIds: ["a", "b"] }).map(item => item.label)).toEqual([
    "时间 · 2026-10-01–2026-10-31", "对比 · 2026-09-01–2026-09-30", "AI · Kimi", "问题群 · 2 个",
  ]);
});

it("does not call an unresolved saved selection all observations", () => {
  expect(geoScopeSummary({ selectionRef: "gsel_opaque" }).map(item => item.label)).toEqual([
    "时间 · 已保存范围", "对比 · 已保存范围", "AI · 已保存范围", "问题群 · 已保存范围",
  ]);
  expect(geoScopeSummary({ round: "r1" })[0].label).toBe("时间 · 指定轮次");
});
