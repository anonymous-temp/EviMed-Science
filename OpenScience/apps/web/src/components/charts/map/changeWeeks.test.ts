import { describe, expect, it } from "vitest";
import type { MapEvent } from "@/lib/memoryMapClient";
import {
  chartsFrom, CHANGE_KINDS, changeKindOf, MAP_EVENT_CAP, totalsOf, weekIndexRange, weekLabels, weeklyChanges, weekStart, windowOfWeeks,
} from "./changeWeeks";

const event = (change: string, at: string, type: MapEvent["type"] = "memory"): Pick<MapEvent, "type" | "change" | "at"> => ({ type, change, at });
const ZONE = "Asia/Shanghai";

describe("the weekly count of what happened to the memories (the 「成长」 line, replaced)", () => {
  it("counts a memory written, a method learned and a forgotten memory brought back as 记下; a replaced statement as 合并; an archived memory and a retired method as 忘记", () => {
    expect(changeKindOf(event("created", "2026-10-01T00:00:00Z"))).toBe("noted");
    expect(changeKindOf(event("learned", "2026-10-01T00:00:00Z", "method"))).toBe("noted");
    expect(changeKindOf(event("restored", "2026-10-01T00:00:00Z"))).toBe("noted");
    expect(changeKindOf(event("superseded", "2026-10-01T00:00:00Z"))).toBe("merged");
    expect(changeKindOf(event("archived", "2026-10-01T00:00:00Z"))).toBe("forgotten");
    expect(changeKindOf(event("retired", "2026-10-01T00:00:00Z", "method"))).toBe("forgotten");
  });

  it("does not count what leaves the account holding the same: an update, a confirmation, a status change, a method taking effect", () => {
    for (const change of ["updated", "confirmed", "status", "approved"]) expect(changeKindOf(event(change, "2026-10-01T00:00:00Z"))).toBeNull();
  });

  it("does not count a conversation or a correction of a delivery, whatever it is called", () => {
    expect(changeKindOf(event("created", "2026-10-01T00:00:00Z", "run"))).toBeNull();
    expect(changeKindOf(event("archived", "2026-10-01T00:00:00Z", "feedback"))).toBeNull();
  });

  it("begins a week on Monday", () => {
    expect(weekStart("2026-10-14")).toBe("2026-10-12"); // a Wednesday
    expect(weekStart("2026-10-12")).toBe("2026-10-12"); // the Monday itself
    expect(weekStart("2026-10-18")).toBe("2026-10-12"); // the Sunday closes the week
    expect(weekStart("2026-10-19")).toBe("2026-10-19");
  });

  it("lists every week from the first day to today, the quiet ones too, and counts each event on its day in the researcher's zone", () => {
    const weeks = weeklyChanges([
      event("created", "2026-09-22T01:00:00Z"), event("created", "2026-09-23T01:00:00Z"), event("superseded", "2026-09-24T01:00:00Z"),
      event("archived", "2026-10-12T20:00:00Z"), // 04:00 on the 13th in Shanghai: the week of the 12th
      event("created", "2026-10-11T17:00:00Z"), // 01:00 on the 12th in Shanghai: the Monday, so the week of the 12th, not the one before
    ], { from: "2026-09-22", to: "2026-10-14", timeZone: ZONE });
    expect(weeks.map((week) => week.start)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(weeks[0]).toMatchObject({ noted: 2, merged: 1, forgotten: 0, end: "2026-09-27" });
    expect(weeks[1]).toMatchObject({ noted: 0, merged: 0, forgotten: 0 });
    expect(weeks[2]).toMatchObject({ noted: 0, merged: 0, forgotten: 0 });
    expect(weeks[3]).toMatchObject({ noted: 1, merged: 0, forgotten: 1 });
  });

  it("adds up to what the headline says: the totals are the sum of the bars, so the chart and its sentence cannot disagree", () => {
    const weeks = weeklyChanges([event("created", "2026-10-06T00:00:00Z"), event("created", "2026-10-13T00:00:00Z"), event("superseded", "2026-10-13T00:00:00Z"), event("updated", "2026-10-13T00:00:00Z")], { from: "2026-10-01", to: "2026-10-14", timeZone: ZONE });
    expect(totalsOf(weeks)).toEqual({ noted: 2, merged: 1, forgotten: 0 });
    expect(CHANGE_KINDS.map((kind) => totalsOf(weeks)[kind])).toEqual([2, 1, 0]);
  });

  it("draws nothing for a span that is not one", () => {
    expect(weeklyChanges([], { from: "2026-10-14", to: "2026-10-01", timeZone: ZONE })).toEqual([]);
    expect(weeklyChanges([], { from: "nonsense", to: "2026-10-01", timeZone: ZONE })).toEqual([]);
  });

  it("ignores an event with no readable time rather than throwing", () => {
    expect(totalsOf(weeklyChanges([event("created", "not a time")], { from: "2026-10-01", to: "2026-10-14", timeZone: ZONE }))).toEqual({ noted: 0, merged: 0, forgotten: 0 });
  });

  it("begins the axis at the oldest event that arrived where the server cut its list, and at the account's first day otherwise", () => {
    const few = [{ at: "2026-09-22T00:00:00Z" }];
    expect(chartsFrom("2026-09-01", few, ZONE)).toBe("2026-09-01");
    const cut = Array.from({ length: MAP_EVENT_CAP }, (_, index) => ({ at: `2026-09-${String(10 + (index % 10)).padStart(2, "0")}T12:00:00Z` }));
    expect(chartsFrom("2026-01-01", cut, ZONE)).toBe("2026-09-10");
    // …and never earlier than the first day the account has.
    expect(chartsFrom("2026-09-20", cut, ZONE)).toBe("2026-09-20");
  });

  it("names the weeks by their Monday, with the year on the first label and where a new year begins", () => {
    expect(weekLabels([{ start: "2026-09-21" }, { start: "2026-09-28" }])).toEqual(["9月21日", "9月28日"]);
    expect(weekLabels([{ start: "2025-12-22" }, { start: "2025-12-29" }, { start: "2026-01-05" }])).toEqual(["2025年12月22日", "12月29日", "2026年1月5日"]);
  });

  it("finds the weeks a window covers, and the window a zoom chose", () => {
    const weeks = weeklyChanges([], { from: "2026-09-01", to: "2026-10-14", timeZone: ZONE });
    expect(weeks).toHaveLength(7);
    expect(weekIndexRange(weeks, null)).toEqual({ first: 0, last: 6 });
    expect(weekIndexRange(weeks, { from: "2026-09-16", to: "2026-09-30" })).toEqual({ first: 2, last: 4 });
    expect(weekIndexRange(weeks, { from: "2027-01-01", to: "2027-01-31" })).toBeNull();
    // 100 % of the axis is the whole span, which is no window at all.
    expect(windowOfWeeks(weeks, { start: 0, end: 100 }, "2026-10-14")).toBeNull();
    expect(windowOfWeeks(weeks, { start: 0, end: 50 }, "2026-10-14")).toEqual({ from: "2026-08-31", to: "2026-09-27" });
    // The last chosen week ends on its Sunday, but never after today.
    expect(windowOfWeeks(weeks, { start: 50, end: 100 }, "2026-10-14")).toEqual({ from: "2026-09-21", to: "2026-10-14" });
    expect(windowOfWeeks(weeks, { batch: [{ start: 50, end: 100 }] }, "2026-10-14")).toEqual({ from: "2026-09-21", to: "2026-10-14" });
    expect(windowOfWeeks([], { start: 0, end: 50 }, "2026-10-14")).toBeNull();
  });
});
