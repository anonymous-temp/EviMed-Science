import { describe, expect, it } from "vitest";
import type { InboxItem } from "@/lib/inboxClient";
import { dayKey, dayLabel, groupInbox, inboxGroupTitle, inboxSourceOf, inboxWhen, orderInbox, severityOf } from "./inboxGroups";

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

  it("pins what the server found for the class even when the loaded page does not hold it, and never repeats a row", () => {
    const order = orderInbox(
      [item({ id: "a", createdAt: todayAt(14) }), item({ id: "s-loaded", severity: "safety", createdAt: todayAt(9) })],
      [item({ id: "s-far", severity: "safety", createdAt: todayAt(3) }), item({ id: "s-loaded", severity: "safety", createdAt: todayAt(9) }),
        item({ id: "s-read", severity: "safety", readAt: todayAt(4), createdAt: todayAt(4) })],
    );
    expect(order.pinned.map((entry) => entry.id)).toEqual(["s-loaded", "s-far"]);
    expect(order.rest.map((entry) => entry.id)).toEqual(["a"]);
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

describe("groupInbox", () => {
  const wrong = (id: string, over: Partial<InboxItem> = {}) => item({ id, severity: "safety", title: `引擎${id}讲错某产品：一句错话`, source: { type: "geo", id: `geo_a/answers/snap_${id}` }, projectId: "p1", createdAt: `2026-09-18T0${id}:00:00Z`, ...over });

  it("folds a module's repeating notices about one subject and kind into one row, where the first of them stood", () => {
    const entries = groupInbox([item({ id: "run1" }), wrong("1"), wrong("2"), item({ id: "run2" }), wrong("3")]);
    expect(entries.map((entry) => entry.kind)).toEqual(["item", "group", "item"]);
    const group = (entries[1] as { kind: "group"; group: ReturnType<typeof Object> }).group as import("./inboxGroups").InboxGroup;
    expect(group.key).toBe("geo:geo_a:answers:safety");
    expect(group.items.map((member) => member.id)).toEqual(["3", "2", "1"]);
    expect(group.latest.id).toBe("3");
    expect(group.unread).toBe(3);
    expect(group.safety).toBe(true);
    expect(group.projectId).toBe("p1");
  });

  it("leaves two notices as two rows, and a run's, a briefing's or a memory's notices as rows however many there are", () => {
    expect(groupInbox([wrong("1"), wrong("2")]).map((entry) => entry.kind)).toEqual(["item", "item"]);
    const runs = Array.from({ length: 5 }, (_, index) => item({ id: `r${index}`, source: { type: "run", id: `run_${index}` } }));
    expect(groupInbox(runs).every((entry) => entry.kind === "item")).toBe(true);
  });

  it("keeps different subjects, different pages and safety apart from the rest, and counts the unread ones", () => {
    const entries = groupInbox([
      wrong("1"), wrong("2"), wrong("3", { readAt: "2026-09-19T00:00:00Z" }),
      wrong("4", { source: { type: "geo", id: "geo_b/answers/snap_4" } }), wrong("5", { source: { type: "geo", id: "geo_b/answers/snap_5" } }), wrong("6", { source: { type: "geo", id: "geo_b/diagnosis" } }),
      wrong("7", { severity: "info", source: { type: "geo", id: "geo_a/answers/snap_7" } }),
    ]);
    const groups = entries.flatMap((entry) => (entry.kind === "group" ? [entry.group] : []));
    expect(groups.map((entry) => [entry.key, entry.items.length, entry.unread])).toEqual([["geo:geo_a:answers:safety", 3, 2]]);
  });

  it("is stable: the same notices fold to the same key whatever order they arrive in", () => {
    const list = [wrong("1"), wrong("2"), wrong("3")];
    const keys = (items: InboxItem[]) => groupInbox(items).flatMap((entry) => (entry.kind === "group" ? [entry.group.key] : []));
    expect(keys([...list].reverse())).toEqual(keys(list));
  });

  it("names a group by its subject, the count and what the notices are about", () => {
    const [entry] = groupInbox([wrong("1"), wrong("2"), wrong("3")]);
    const group = (entry as { kind: "group"; group: import("./inboxGroups").InboxGroup }).group;
    expect(inboxGroupTitle(group, "信尔美")).toBe("信尔美：3 条新的讲错");
    expect(inboxGroupTitle(group, null)).toBe("3 条新的讲错");
    expect(inboxGroupTitle({ ...group, page: "elsewhere" }, "信尔美")).toBe("信尔美：3 条项目动态");
    expect(inboxSourceOf(item({ source: null }))).toBe("system");
    expect(inboxSourceOf(wrong("1"))).toBe("geo");
  });
});
