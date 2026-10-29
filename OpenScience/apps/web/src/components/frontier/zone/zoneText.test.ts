import { describe, expect, it } from "vitest";
import { frontierItem } from "@/components/frontier/__fixtures__/frontierItems";
import {
  EMPTY_ITEMS_VIEW,
  inWeek,
  itemsHref,
  itemsParams,
  progressText,
  readItemsView,
  roleOptions,
  weekEnd,
  weekLabel,
  weekWindow,
  zoneOwnerLine,
  zonePath,
  zoneResearchDraft,
  zoneSpecialties,
  zoneTabOf,
} from "./zoneText";
import { overview } from "./__fixtures__/zones";

describe("a zone's address", () => {
  it("is its readable name when it has one and its id when not, each path-safe", () => {
    expect(zonePath({ id: "ez_1", slug: "glp1-obesity" })).toBe("/app/frontier/zones/s/glp1-obesity");
    expect(zonePath({ id: "ez 1/x", slug: null })).toBe("/app/frontier/zones/ez%201%2Fx");
  });

  it("names the tab, and a tab that is not offered or not known is the overview", () => {
    expect(zoneTabOf("items", false)).toBe("items");
    expect(zoneTabOf("cards", true)).toBe("cards");
    expect(zoneTabOf("cards", false)).toBe("overview");
    expect(zoneTabOf("elsewhere", true)).toBe("overview");
    expect(zoneTabOf(null, true)).toBe("overview");
  });
});

describe("the 动态 tab's filters in the address", () => {
  it("are written when set and not when not, and read back as the same view", () => {
    expect(itemsHref("/app/frontier/zones/z", {})).toBe("/app/frontier/zones/z?tab=items");
    const view = { role: "guideline" as const, picked: true, window: "90d" as const, q: "司美格鲁肽", week: "2026-10-19" };
    const href = itemsHref("/app/frontier/zones/z", view);
    expect(href).toBe("/app/frontier/zones/z?tab=items&role=guideline&picked=1&window=90d&q=%E5%8F%B8%E7%BE%8E%E6%A0%BC%E9%B2%81%E8%82%BD&week=2026-10-19");
    expect(readItemsView(new URL(href, "https://x.test").searchParams)).toEqual(view);
    expect(readItemsView(itemsParams(EMPTY_ITEMS_VIEW))).toEqual(EMPTY_ITEMS_VIEW);
  });

  it("ignore a value that is not in the vocabulary, a week that is not a day and a search past 200 characters", () => {
    const view = readItemsView(new URLSearchParams({ role: "gossip", window: "forever", week: "last week", q: "x".repeat(300), picked: "yes" }));
    expect(view).toEqual({ ...EMPTY_ITEMS_VIEW, q: "x".repeat(200) });
  });
});

describe("a week of the chart", () => {
  it("ends six days after it begins, across a month", () => {
    expect(weekEnd("2026-10-26")).toBe("2026-11-01");
    expect(weekEnd("2026-12-28")).toBe("2027-01-03");
  });

  it("asks for the narrowest window the server offers that holds it", () => {
    const now = Date.parse("2026-10-29T08:00:00Z");
    expect(weekWindow("2026-10-26", now)).toBe("7d");
    expect(weekWindow("2026-10-19", now)).toBe("30d");
    expect(weekWindow("2026-09-14", now)).toBe("90d");
    expect(weekWindow("2026-06-01", now)).toBe("all");
    expect(weekWindow("not a day", now)).toBe("all");
  });

  it("holds an item by its Beijing day, the first and the last day of the week included", () => {
    const at = (timelineAt: string) => frontierItem({ timelineAt });
    // 2026-10-26 00:30 in Beijing is still the 25th in UTC.
    expect(inWeek(at("2026-10-25T16:30:00.000Z"), "2026-10-26")).toBe(true);
    expect(inWeek(at("2026-10-25T15:30:00.000Z"), "2026-10-26")).toBe(false);
    expect(inWeek(at("2026-11-01T15:00:00.000Z"), "2026-10-26")).toBe(true);
    expect(inWeek(at("2026-11-01T16:30:00.000Z"), "2026-10-26")).toBe(false);
  });

  it("is named by the day it begins: 「10月26日起一周」", () => {
    expect(weekLabel("2026-10-26", Date.parse("2026-10-29T08:00:00Z"))).toBe("10月26日起一周");
  });
});

describe("whose zone it is", () => {
  it("says it for a reader's own zone and for a published one of someone else's — never for a platform zone", () => {
    expect(zoneOwnerLine({ kind: "official", canEdit: false, published: true, creator: null })).toBeNull();
    expect(zoneOwnerLine({ kind: "user", canEdit: true, published: false, creator: "我" })).toBe("我的专区");
    expect(zoneOwnerLine({ kind: "user", canEdit: true, published: true, creator: "我" })).toBe("我的专区 · 已公开");
    expect(zoneOwnerLine({ kind: "user", canEdit: false, published: true, creator: "王研究" })).toBe("王研究 创建");
    expect(zoneOwnerLine({ kind: "user", canEdit: false, published: true, creator: null })).toBe("读者创建");
  });

  it("lists the specialties in the reader's words", () => {
    expect(zoneSpecialties({ specialties: [{ key: "a", label: "内分泌" }, { key: "b", label: "心血管" }] })).toBe("内分泌、心血管");
    expect(zoneSpecialties({ specialties: [] })).toBe("");
  });
});

describe("the kinds of item the 动态 tab offers", () => {
  it("are 全部 and each kind that holds items, in the vocabulary's order, with its count", () => {
    expect(roleOptions({ news: 4, research: 12, guideline: 0 }, 16)).toEqual([
      { value: "", label: "全部", count: 16 },
      { value: "research", label: "研究", count: 12 },
      { value: "news", label: "资讯观点", count: 4 },
    ]);
    expect(roleOptions({}, null)).toEqual([{ value: "", label: "全部" }]);
  });
});

describe("深入研究", () => {
  const zone = { title: "GLP-1 受体激动剂减重", scope: "成人减重的疗效与安全性" };

  it("takes the marks out of 最新进展, which point at a list the draft does not hold", () => {
    expect(progressText({ text: "获批新适应症[1]，安全性更新[2]。" })).toBe("获批新适应症，安全性更新。");
  });

  it("asks about the zone, with its scope, what is new and the key updates by the line the assistant reads them through", () => {
    const draft = zoneResearchDraft(zone, overview());
    expect(draft).toContain("请围绕“GLP-1 受体激动剂减重”做一次深入研究");
    expect(draft).toContain("范围：成人减重的疗效与安全性");
    expect(draft).toContain("最新进展：司美格鲁肽获批新适应症，替尔泊肽的安全性数据更新，不是引用。");
    expect(draft).toContain("重要更新：");
    expect(draft).toContain("frontier:k1");
    expect(draft).toContain("frontier:k2");
  });

  it("still names the zone and its scope while the overview has not come", () => {
    expect(zoneResearchDraft(zone, null)).toBe("请围绕“GLP-1 受体激动剂减重”做一次深入研究：近期有哪些重要进展，证据有多强，指南和监管有什么变化，对临床实践和我的研究意味着什么。\n\n范围：成人减重的疗效与安全性");
  });
});
