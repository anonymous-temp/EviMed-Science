import { describe, expect, it } from "vitest";
import type { MapEvent } from "@/lib/memoryMapClient";
import { changeKindOf, weekLabels, weekStart } from "./changeWeeks";

const event = (change: string, at: string, type: MapEvent["type"] = "memory"): Pick<MapEvent, "type" | "change" | "at"> => ({ type, change, at });

describe("what the change chart counts of what happened to the memories", () => {
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

  it("begins a week on Monday", () => {
    expect(weekStart("2026-10-14")).toBe("2026-10-12"); // a Wednesday
    expect(weekStart("2026-10-12")).toBe("2026-10-12"); // the Monday itself
    expect(weekStart("2026-10-18")).toBe("2026-10-12"); // the Sunday closes the week
    expect(weekStart("2026-10-19")).toBe("2026-10-19");
  });

  it("names the weeks by their Monday, with the year on the first label and where a new year begins", () => {
    expect(weekLabels([{ start: "2026-09-21" }, { start: "2026-09-28" }])).toEqual(["9月21日", "9月28日"]);
    expect(weekLabels([{ start: "2025-12-22" }, { start: "2025-12-29" }, { start: "2026-01-05" }])).toEqual(["2025年12月22日", "12月29日", "2026年1月5日"]);
  });
});
