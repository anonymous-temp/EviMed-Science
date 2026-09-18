import { describe, expect, it } from "vitest";
import type { InboxItem } from "@/lib/inboxClient";
import { dayKey, dayLabel, isLegacyRoutineCompletion, layoutInbox, severityOf } from "./inboxGroups";

const base: InboxItem = {
  id: "x", noticeType: "notify", priority: 2, title: "研究已完成", body: "", actions: [], count: 1,
  readAt: null, resolvedAt: null, resolution: null, revision: 1, createdAt: "2026-09-18T02:00:00Z",
  source: { type: "run", id: "run_x" },
};
const item = (over: Partial<InboxItem>): InboxItem => ({ ...base, ...over });

describe("severityOf", () => {
  it("reads an item written before the field as the server does", () => {
    expect(severityOf(item({}))).toBe("info");
    expect(severityOf(item({ noticeType: "review" }))).toBe("attention");
    expect(severityOf(item({ severity: "safety" }))).toBe("safety");
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 8, 18, 15, 0).getTime();
  it("says 今天 and 昨天, then the date, with the year only when it differs", () => {
    expect(dayLabel(dayKey(now)!, now)).toBe("今天");
    expect(dayLabel(dayKey(new Date(2026, 8, 17, 23, 59))!, now)).toBe("昨天");
    expect(dayLabel("2026-09-16", now)).toBe("9月16日");
    expect(dayLabel("2025-12-31", now)).toBe("2025年12月31日");
  });
});

describe("isLegacyRoutineCompletion", () => {
  it("is a per-run completion written before the server merged them, and nothing else", () => {
    expect(isLegacyRoutineCompletion(item({}))).toBe(true);
    expect(isLegacyRoutineCompletion(item({ groupKey: "run-finished:default:2026-09-18" }))).toBe(false);
    expect(isLegacyRoutineCompletion(item({ title: "交付物未通过核验" }))).toBe(false);
    expect(isLegacyRoutineCompletion(item({ severity: "safety" }))).toBe(false);
    expect(isLegacyRoutineCompletion(item({ source: { type: "digest", id: "d" } }))).toBe(false);
  });
});

describe("layoutInbox", () => {
  const now = new Date(2026, 8, 18, 15, 0).getTime();
  const todayAt = (h: number) => new Date(2026, 8, 18, h).toISOString();

  it("puts a day's weightier items first, then the newest", () => {
    const layout = layoutInbox([
      item({ id: "info-late", title: "别的通知", createdAt: todayAt(14) }),
      item({ id: "attention", severity: "attention", title: "待复核", createdAt: todayAt(9) }),
    ], now);
    expect(layout.days[0].entries.map((entry) => entry.kind === "item" ? entry.item.id : "fold")).toEqual(["attention", "info-late"]);
  });

  it("folds two or more legacy completions, and leaves a single one as it is", () => {
    const one = layoutInbox([item({ id: "a" })], now);
    expect(one.days[0].entries).toEqual([{ kind: "item", item: expect.objectContaining({ id: "a" }) }]);
    const two = layoutInbox([item({ id: "a", createdAt: todayAt(9) }), item({ id: "b", createdAt: todayAt(10) })], now);
    expect(two.days[0].entries).toHaveLength(1);
    expect(two.days[0].entries[0]).toMatchObject({ kind: "completions" });
  });

  it("pins only unread safety, and keeps silent items out of the day's list", () => {
    const layout = layoutInbox([
      item({ id: "s-unread", severity: "safety" }),
      item({ id: "s-read", severity: "safety", readAt: todayAt(12) }),
      item({ id: "quiet", silent: true, readAt: todayAt(12) }),
    ], now);
    expect(layout.pinned.map((entry) => entry.id)).toEqual(["s-unread"]);
    const [day] = layout.days;
    expect(day.silent.map((entry) => entry.id)).toEqual(["quiet"]);
    expect(day.entries.map((entry) => entry.kind === "item" ? entry.item.id : "fold")).toEqual(["s-read"]);
  });
});
