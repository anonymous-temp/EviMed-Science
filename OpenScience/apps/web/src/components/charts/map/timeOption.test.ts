import { describe, expect, it } from "vitest";
import type { MapEvent, MapLane } from "@/lib/memoryMapClient";
import { TEST_PALETTE } from "./palette";
import { barShape, eventSymbol, eventTooltip, segmentTooltip, timeExtent, timeOption, timeRows } from "./timeOption";
import { dayEndMs, dayIn, dayStartMs } from "./zone";

const lane = (id: string, label: string, segments: MapLane["segments"]): MapLane => ({ id, label, projectId: "p", segments });
const lineage = lane("lineage:a", "纳入 ≥18 岁", [
  { recordId: "v1", text: "纳入 ≥16 岁", from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z", state: "replaced", conflict: false },
  { recordId: "v2", text: "纳入 ≥18 岁", from: "2026-09-01T00:00:00.000Z", to: null, state: "current", conflict: true },
]);
const event = (id: string, over: Partial<MapEvent> = {}): MapEvent => ({ id, at: "2026-09-10T03:00:00.000Z", type: "memory", change: "created", ref: `memory:${id}`, lane: "project:p", kind: "project_fact", text: `事 ${id}`, ...over });
const events = [event("a", { kind: "decision" }), event("b", { kind: "correction", lane: "account" }), event("c", { type: "method", kind: "method", lane: "account" }), event("d", { change: "superseded" })];
const palette = TEST_PALETTE;
const formatDay = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

describe("the days of a zone", () => {
  it("counts a day where the researcher is", () => {
    expect(dayIn(Date.parse("2026-10-11T17:30:00Z"), "Asia/Shanghai")).toBe("2026-10-12");
    expect(dayIn(Date.parse("2026-10-11T17:30:00Z"), "UTC")).toBe("2026-10-11");
    expect(dayStartMs("2026-10-12", "Asia/Shanghai")).toBe(Date.parse("2026-10-11T16:00:00Z"));
    expect(dayEndMs("2026-10-12", "Asia/Shanghai")).toBe(Date.parse("2026-10-12T15:59:59.999Z"));
    expect(dayStartMs("2026-10-12", "UTC")).toBe(Date.parse("2026-10-12T00:00:00Z"));
    expect(dayStartMs("2026-07-01", "America/New_York")).toBe(Date.parse("2026-07-01T04:00:00Z"));
  });
});

describe("the rows", () => {
  it("are the lineages first, then one row for each project that had events and one for the account", () => {
    const rows = timeRows([lineage], events, (id) => (id === "p" ? "心衰随访" : id));
    expect(rows).toEqual([
      { key: "lineage:a", label: "纳入 ≥18 岁", kind: "lane" }, { key: "project:p", label: "心衰随访", kind: "events" }, { key: "account", label: "你自己", kind: "events" },
    ]);
    expect(timeRows([], [], (id) => id)).toEqual([]);
  });
  it("are bounded", () => {
    const many = Array.from({ length: 30 }, (_, index) => lane(`lineage:${index}`, `l${index}`, []));
    expect(timeRows(many, [], (id) => id)).toHaveLength(10);
  });
});

describe("the axis and the shared window", () => {
  it("runs from the first thing remembered to today, and never collapses to a day", () => {
    expect(timeExtent({ since: "2026-08-01", lanes: [], events: [], today: "2026-10-12" }, "UTC")).toEqual({ from: "2026-08-01", to: "2026-10-12" });
    expect(timeExtent({ since: null, lanes: [lineage], events: [], today: "2026-10-12" }, "UTC").from).toBe("2026-08-01");
    expect(timeExtent({ since: "2026-10-12", lanes: [], events: [], today: "2026-10-12" }, "UTC").from).toBe("2026-09-12");
    expect(timeExtent({ since: null, lanes: [], events: [], today: "2026-10-12" }, "UTC")).toEqual({ from: "2026-09-12", to: "2026-10-12" });
  });
});

describe("the option", () => {
  const rows = timeRows([lineage], events, () => "心衰随访");
  const input = { lanes: [lineage], events, rows, extent: { from: "2026-07-01", to: "2026-10-12" }, window: null, timeZone: "UTC", now: Date.parse("2026-10-12T00:00:00Z"), palette, formatDay };
  const option: any = timeOption(input);

  it("draws a bar for every version and a mark for every event, each on its own row", () => {
    const [bars, marks] = option.series;
    expect(bars.data.map((bar: any) => [bar.value[0], bar.value[3], bar.value[4], bar.recordId])).toEqual([[0, "replaced", 0, "v1"], [0, "current", 1, "v2"]]);
    expect(bars.data[1].value[2]).toBe(input.now);
    expect(marks.data.map((mark: any) => [mark.value[1], mark.symbol === "diamond" ? "◆" : mark.symbol === "triangle" ? "▲" : mark.symbol === "circle" ? "●" : "✕"])).toEqual([[1, "◆"], [2, "✕"], [2, "▲"], [1, "●"]]);
    expect(marks.data[3].itemStyle.color).toBe("#grey");
    expect(option.yAxis.data).toEqual(["纳入 ≥18 岁", "心衰随访", "你自己"]);
    expect(option.yAxis.inverse).toBe(true);
  });
  it("has no slider of its own, and its axis is the window the page is narrowed to — the whole span when there is none", () => {
    expect(option.dataZoom).toBeUndefined();
    expect(option.xAxis.min).toBe(Date.parse("2026-07-01T00:00:00Z"));
    expect(option.xAxis.max).toBe(Date.parse("2026-10-12T23:59:59.999Z"));
    const windowed: any = timeOption({ ...input, window: { from: "2026-09-01", to: "2026-09-30" } });
    expect(windowed.xAxis.min).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(windowed.xAxis.max).toBe(Date.parse("2026-09-30T23:59:59.999Z"));
  });
  it("draws a bar inside the plot, at least as wide as a sliver", () => {
    const plot = { x: 100, y: 0, width: 400, height: 200 };
    expect(barShape(50, 130, 40, 16, plot)).toEqual({ x: 100, y: 32, width: 30, height: 16 });
    expect(barShape(480, 900, 40, 16, plot)).toEqual({ x: 480, y: 32, width: 20, height: 16 });
    expect(barShape(200, 200, 40, 16, plot)?.width).toBe(3);
    expect(barShape(520, 600, 40, 16, plot)).toBeNull();
  });
  it("tells an event's shape by its kind", () => {
    expect(eventSymbol({ kind: "decision", type: "memory" })).toBe("diamond");
    expect(eventSymbol({ kind: "method", type: "method" })).toBe("triangle");
    expect(eventSymbol({ kind: "preference", type: "memory" })).toBe("circle");
    expect(eventSymbol({ kind: "correction", type: "memory" })).toMatch(/^path:\/\//u);
  });
  it("escapes what a memory says in the tooltip", () => {
    const html = eventTooltip(event("x", { text: "<img src=x onerror=alert(1)>" }), (iso) => iso.slice(0, 10));
    expect(html).not.toContain("<img");
    expect(segmentTooltip(lane("l", "x", [{ recordId: "r", text: "<b>x</b>", from: null, to: null, state: "current", conflict: true }]), 0, formatDay)).toContain("&lt;b&gt;");
    expect(segmentTooltip(lineage, 1, formatDay)).toContain("至今");
    expect(segmentTooltip(lineage, 1, formatDay)).toContain("和另一条说法不一致");
  });
});
