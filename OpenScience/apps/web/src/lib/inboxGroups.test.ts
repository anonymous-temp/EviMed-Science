import { describe, expect, it } from "vitest";
import type { InboxItem } from "@/lib/inboxClient";
import { dayKey, dayLabel, inboxWhen, orderInbox, severityOf } from "./inboxGroups";

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

describe("inboxWhen", () => {
  const now = new Date(2026, 8, 18, 15, 0).getTime();
  it("is the clock today and the day before that, never both", () => {
    expect(inboxWhen(new Date(2026, 8, 18, 8, 0).toISOString(), now)).toBe("08:00");
    expect(inboxWhen(new Date(2026, 8, 17, 20, 0).toISOString(), now)).toBe("昨天");
    expect(inboxWhen(new Date(2026, 8, 12, 9, 0).toISOString(), now)).toBe("9月12日");
    expect(inboxWhen("not a date", now)).toBe("");
  });
});

describe("orderInbox", () => {
  const todayAt = (h: number) => new Date(2026, 8, 18, h).toISOString();

  it("pins only unread safety, newest first, and keeps everything else in the server's order", () => {
    const order = orderInbox([
      item({ id: "a", createdAt: todayAt(14) }),
      item({ id: "s-old", severity: "safety", createdAt: todayAt(8) }),
      item({ id: "s-read", severity: "safety", readAt: todayAt(12), createdAt: todayAt(12) }),
      item({ id: "s-new", severity: "safety", createdAt: todayAt(13) }),
      item({ id: "read", readAt: todayAt(12), createdAt: todayAt(11) }),
    ]);
    expect(order.pinned.map((entry) => entry.id)).toEqual(["s-new", "s-old"]);
    expect(order.rest.map((entry) => entry.id)).toEqual(["a", "s-read", "read"]);
  });

  it("renders a merged or a digest item as a row like any other: nothing is folded", () => {
    const order = orderInbox([
      item({ id: "c1", title: "阿司匹林一级预防 已完成" }),
      item({ id: "c2", title: "9月18日完成 3 项研究", groupKey: "run-finished:default:2026-09-18", count: 3 }),
      item({ id: "digest", noticeType: "review", title: "主动科研简报：GLP-1", source: { type: "digest", id: "digest-1" }, readAt: todayAt(9) }),
    ]);
    expect(order.rest.map((entry) => entry.id)).toEqual(["c1", "c2", "digest"]);
  });
});
