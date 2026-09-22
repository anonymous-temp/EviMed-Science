import { describe, expect, it } from "vitest";
import { frontierItem } from "./__fixtures__/frontierItems";
import { groupByDay, hotMeta, itemWhen, researchDraft, researchIntents, verificationSentence } from "./frontierText";
import type { FrontierItem } from "@/lib/frontierClient";

// Local noon, so "today" and "yesterday" do not depend on the test machine's zone.
const NOW = new Date(2026, 8, 22, 12, 0, 0).getTime();
const at = (day: number, hour: number) => new Date(2026, 8, day, hour, 0, 0).toISOString();

describe("when an item was published", () => {
  it("is relative for a precise moment", () => {
    expect(itemWhen(frontierItem({ publishedAt: at(22, 10), datePrecision: "instant" }), NOW)).toBe("2 小时前");
  });

  it("is the day alone for a date given only to the day or inferred", () => {
    expect(itemWhen(frontierItem({ publishedAt: at(22, 0), datePrecision: "day" }), NOW)).toBe("今天");
    expect(itemWhen(frontierItem({ publishedAt: at(21, 0), datePrecision: "inferred" }), NOW)).toBe("昨天");
    expect(itemWhen(frontierItem({ publishedAt: at(18, 0), datePrecision: "day" }), NOW)).toBe("9月18日");
  });

  it("falls back to when it reached the list when the source gave no date", () => {
    expect(itemWhen(frontierItem({ publishedAt: null, timelineAt: at(22, 11) }), NOW)).toBe("1 小时前");
  });
});

describe("the day groups", () => {
  it("follow the list's own axis and name today and yesterday with their dates", () => {
    const days = groupByDay([
      frontierItem({ id: "a", timelineAt: at(22, 9) }),
      frontierItem({ id: "b", timelineAt: at(22, 8) }),
      frontierItem({ id: "c", timelineAt: at(21, 20) }),
      frontierItem({ id: "d", timelineAt: at(19, 7) }),
    ], NOW);
    expect(days.map((day) => [day.label, day.items.map((item) => item.id).join("")])).toEqual([
      ["今天 · 9月22日 周二", "ab"],
      ["昨天 · 9月21日 周一", "c"],
      ["9月19日 周六", "d"],
    ]);
  });
});

describe("the words a card uses", () => {
  it("says what the number check found, never a score", () => {
    expect(verificationSentence({ verification: "passed", summary: "x" })).toBe("导读里的数字都已在原文里核对到。");
    expect(verificationSentence({ verification: "title-only", summary: null })).toContain("只保留原标题");
  });

  it("gives the hot list three separate quantities and no heat", () => {
    expect(hotMeta({ sourceCount72h: 6, reportCount: 9, primary: "paper" })).toBe("近 72 小时 6 个来源 · 累计 9 篇报道 · 含原始论文");
    expect(hotMeta({ sourceCount72h: 5, reportCount: 5, primary: null }, true)).toBe("5 个来源");
  });
});

describe("the 深入研究 draft", () => {
  it("carries the item, its source, its link and its identifiers into the composer", () => {
    const item = frontierItem({ flags: [{ key: "preprint", label: "未经同行评议" }], pmid: "40000001" });
    const draft = researchDraft(item, "reliability");
    expect(draft.startsWith("这项研究可靠吗？")).toBe(true);
    for (const part of [item.title, item.titleRaw, "来源：NEJM（期刊 · RCT）", "注意：未经同行评议", item.url, "DOI：10.1056/example", "PMID：40000001", `导读：${item.summary}`]) {
      expect(draft).toContain(part);
    }
  });

  it("leaves the reader's own question for last", () => {
    expect(researchDraft(frontierItem(), "own").endsWith("我的问题：")).toBe(true);
  });

  it("asks the first question the item can answer: a design for a study, grounds for the rest", () => {
    const first = (fields: Partial<FrontierItem>) => researchIntents(frontierItem(fields))[0]?.label;
    expect(first({ evidenceType: "rct" })).toBe("这项研究可靠吗");
    expect(first({ evidenceType: null, sourceType: "preprint" })).toBe("这项研究可靠吗");
    expect(first({ evidenceType: "guideline" })).toBe("这份指南的推荐依据是什么");
    expect(first({ evidenceType: "safety-notice", sourceType: "regulator" })).toBe("这项决定依据什么");
    expect(first({ evidenceType: "other", sourceType: "media" })).toBe("这条消息的依据是什么");
    const policy = frontierItem({ evidenceType: "other", sourceType: "media" });
    expect(researchDraft(policy, "reliability").startsWith("这条消息的依据是什么？")).toBe(true);
    expect(researchIntents(policy).map((intent) => intent.key)).toEqual(["reliability", "my-project", "synthesis", "own"]);
  });
});
