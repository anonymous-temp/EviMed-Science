import { describe, expect, it } from "vitest";
import type { MemoryGrowth } from "@/lib/memoryClient";
import { GROWTH_MARKERS, cutName, growthLabels, growthMarkers, growthView } from "./growthModel";

const growth = (patch: Partial<MemoryGrowth> = {}): MemoryGrowth => ({
  unit: "week",
  first: "2026-09-08",
  fromStart: true,
  points: [
    { start: "2026-08-31", known: 0 },
    { start: "2026-09-07", known: 4 },
    { start: "2026-09-14", known: 9 },
    { start: "2026-09-21", known: 23 },
    { start: "2026-09-28", known: 24 },
  ],
  moments: [
    { day: "2026-09-16", kind: "method", title: "Meta 分析先报 GRADE 再报效应量" },
    { day: "2026-09-24", kind: "capsule", title: "李主任的工作方式" },
  ],
  timeZone: "Asia/Shanghai",
  ...patch,
});

/** What the page must never say about the capsule (DESIGN.md, the owner's 2026-09-23 ruling). */
const BACK_OFFICE = /用过|次数|已核对|置信|%|token|候选|蒸馏|采纳/;

describe("the capsule's growth line", () => {
  it("says when EviMed began, how much it holds now and what it learned — one sentence, the chart's heading", () => {
    const view = growthView(growth())!;
    expect(view.title).toBe("9月8日开始记住你，现在有 24 条记忆，学会 1 种做法");
    expect(view.title).not.toMatch(BACK_OFFICE);
    expect(view.input.own).toEqual({ name: "记忆", values: [0, 4, 9, 23, 24] });
    expect(view.input.labels).toEqual(["8月31日", "9月7日", "9月14日", "9月21日", "9月28日"]);
    // Nothing learned, nothing claimed.
    expect(growthView(growth({ moments: [] }))!.title).toBe("9月8日开始记住你，现在有 24 条记忆");
  });

  it("over a longer history says how far it moved in the months shown", () => {
    const months = (values: number[]) => growth({
      unit: "month", first: "2023-05-04", fromStart: false, moments: [],
      points: values.map((known, index) => ({ start: `2026-0${index + 4}-01`, known })),
    });
    expect(growthView(months([14, 20, 31, 38]))!.title).toBe("近 3 个月记忆从 14 条增加到 38 条");
    expect(growthView(months([40, 35, 30]))!.title).toBe("近 2 个月记忆从 40 条减少到 30 条");
    expect(growthView(months([30, 30]))!.title).toBe("近 1 个月记忆保持在 30 条");
    expect(growthView(months([9_000, 12_400]))!.title).toBe("近 1 个月记忆从 9,000 条增加到 1.2万 条");
  });

  it("stays away until there is a line: nothing, one week, or a failed read draws no chart", () => {
    expect(growthView(null)).toBeNull();
    expect(growthView(growth({ unit: null, first: null, fromStart: false, points: [], moments: [] }))).toBeNull();
    // A capsule a few days old is its list; a line from zero to five would read as a stub.
    expect(growthView(growth({ first: "2026-09-26", points: [{ start: "2026-09-21", known: 0 }, { start: "2026-09-28", known: 5 }] }))).toBeNull();
    expect(growthView(growth({ points: [{ start: "2026-09-21", known: 0 }, { start: "2026-09-28", known: 0 }] }))).toBeNull();
  });

  it("dates the axis per week or per month, and marks the year where the line crosses one", () => {
    expect(growthLabels("month", ["2026-07-01", "2026-08-01", "2026-09-01"])).toEqual(["7月", "8月", "9月"]);
    expect(growthLabels("month", ["2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01"])).toEqual(["2025年11月", "12月", "2026年1月", "2月"]);
    expect(growthLabels("week", ["2025-12-22", "2025-12-29", "2026-01-05"])).toEqual(["2025年12月22日", "12月29日", "2026年1月5日"]);
    // A beginning in another year than the line's last point says its year.
    expect(growthView(growth({ first: "2025-12-24", points: [
      { start: "2025-12-15", known: 0 }, { start: "2025-12-22", known: 3 }, { start: "2025-12-29", known: 5 }, { start: "2026-01-05", known: 6 },
    ], moments: [] }))!.title).toBe("2025年12月24日开始记住你，现在有 6 条记忆");
  });

  it("names at most three moments, kept apart, a method by its own words and a capsule by its title", () => {
    // On a short line two neighbouring moments would face each other and
    // meet: the newer is named. On a longer one both fit.
    expect(growthView(growth())!.input.markers).toEqual([{ index: 3, label: "收到“李主任的工作方式”" }]);
    const longer = growth({ points: [
      "2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24",
      "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21",
    ].map((start, index) => ({ start, known: index * 3 })), moments: [
      { day: "2026-08-05", kind: "method", title: "Meta 分析先报 GRADE 再报效应量" },
      { day: "2026-09-24", kind: "capsule", title: "李主任的工作方式" },
    ] });
    expect(growthView(longer)!.input.markers).toEqual([
      { index: 4, label: "学会“Meta 分析先报…”" },
      { index: 11, label: "收到“李主任的工作方式”" },
    ]);
    // A name is cut by the width it takes, and never inside a Latin word.
    expect(cutName("李主任的工作方式")).toBe("李主任的工作方式");
    expect(cutName("证据矩阵先行再做亚组分析")).toBe("证据矩阵先行再做…");
    expect(cutName("screen-in-batches-of-200")).toBe("screen-in…");
    const starts = Array.from({ length: 27 }, (_, index) => `2026-${String(3 + Math.floor(index / 4)).padStart(2, "0")}-${String(1 + (index % 4) * 7).padStart(2, "0")}`);
    const many = starts.slice(1).map((day, index) => ({ day, kind: "method" as const, title: `做法 ${index}` }));
    const marked = growthMarkers(starts, many);
    expect(marked).toHaveLength(GROWTH_MARKERS);
    // A phone's card holds one label; three would sit on top of each other.
    expect(growthMarkers(starts, many, 300)).toEqual([{ index: 26, label: "学会“做法 25”" }]);
    expect(growthView(growth(), 300)!.input.markers).toEqual([{ index: 3, label: "收到“李主任的工作方式”" }]);
    // The newest first, and never two within a sixth of the line of each other.
    expect(marked.at(-1)!.index).toBe(26);
    for (let index = 1; index < marked.length; index += 1) expect(marked[index].index - marked[index - 1].index).toBeGreaterThanOrEqual(5);
    // Two moments in one week are one label.
    expect(growthMarkers(["2026-09-14", "2026-09-21"], [
      { day: "2026-09-22", kind: "method", title: "甲" }, { day: "2026-09-23", kind: "method", title: "乙" },
    ])).toEqual([{ index: 1, label: "学会 2 种做法" }]);
    expect(growthMarkers(["2026-09-14", "2026-09-21"], [
      { day: "2026-09-22", kind: "method", title: "甲" }, { day: "2026-09-23", kind: "capsule", title: "乙" },
    ])).toEqual([{ index: 1, label: "学会做法 · 收到胶囊" }]);
  });
});
