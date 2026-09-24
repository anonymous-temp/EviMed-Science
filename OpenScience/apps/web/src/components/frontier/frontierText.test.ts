import { describe, expect, it } from "vitest";
import { frontierItem } from "./__fixtures__/frontierItems";
import {
  cardTags,
  dailyMeta,
  evidenceTag,
  groupByDay,
  hotBoardStamp,
  hotRowMeta,
  institutionsLine,
  itemMarkdown,
  primaryHeld,
  rankChangeLabel,
  rankLabel,
  rankTone,
  researchDraft,
  researchIntents,
  scoreBand,
  sparkline,
  stamp,
  timeColumn,
} from "./frontierText";
import type { FrontierItem } from "@/lib/frontierClient";

// Local noon, so "today" and "yesterday" do not depend on the test machine's zone.
const NOW = new Date(2026, 8, 22, 12, 0, 0).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute, 0).toISOString();

describe("the time column", () => {
  it("is the clock inside a day group", () => {
    expect(timeColumn(frontierItem({ timelineAt: at(21, 9, 5) }), true, NOW)).toBe("09:05");
  });

  it("is the clock today and the day before, where the list is not cut into days", () => {
    expect(timeColumn(frontierItem({ timelineAt: at(22, 8, 30) }), false, NOW)).toBe("08:30");
    expect(timeColumn(frontierItem({ timelineAt: at(21, 8, 30) }), false, NOW)).toBe("昨天");
    expect(timeColumn(frontierItem({ timelineAt: at(18, 8, 30) }), false, NOW)).toBe("9月18日");
  });

  it("says when something was last read: the clock today, the date before", () => {
    expect(stamp(at(22, 7, 40), NOW)).toBe("07:40");
    expect(stamp(at(20, 7, 40), NOW)).toBe("9月20日 07:40");
    expect(stamp(null, NOW)).toBe("");
  });
});

describe("the day groups", () => {
  it("follow the list's own axis and are headed by the date alone", () => {
    const days = groupByDay([
      frontierItem({ id: "a", timelineAt: at(22, 9) }),
      frontierItem({ id: "b", timelineAt: at(22, 8) }),
      frontierItem({ id: "c", timelineAt: at(21, 20) }),
      frontierItem({ id: "d", timelineAt: at(19, 7) }),
    ]);
    expect(days.map((day) => [day.label, day.items.map((item) => item.id).join("")])).toEqual([
      ["9月22日 周二", "ab"],
      ["9月21日 周一", "c"],
      ["9月19日 周六", "d"],
    ]);
  });
});

describe("what a card carries", () => {
  it("has one evidence tag, and none where the card already says it", () => {
    expect(evidenceTag(frontierItem())).toBe("RCT");
    expect(evidenceTag(frontierItem({ evidenceType: "other", evidenceTypeLabel: "其他" }))).toBeNull();
    expect(evidenceTag(frontierItem({ evidenceType: "safety-notice", evidenceTypeLabel: "安全通告", safetyAlert: true }))).toBeNull();
    expect(evidenceTag(frontierItem({ evidenceType: "press-release", evidenceTypeLabel: "企业新闻稿", flags: [{ key: "press-release", label: "企业新闻稿·数据未发表" }] }))).toBeNull();
  });

  it("tags the specialties first and then the diseases, three in all", () => {
    const item = frontierItem({
      specialties: [{ key: "gastroenterology", label: "消化" }, { key: "oncology", label: "肿瘤" }, { key: "surgery", label: "外科" }],
      entities: { drugs: ["阿司匹林"], trials: [], orgs: [], diseases: ["结直肠癌", "腺瘤"] },
    });
    expect(cardTags(item)).toEqual([
      { kind: "specialty", key: "gastroenterology", label: "消化" },
      { kind: "specialty", key: "oncology", label: "肿瘤" },
      { kind: "term", key: "结直肠癌", label: "结直肠癌" },
    ]);
  });

  it("reads the score in the server's band, at most 「中」 without one, and nothing without a score", () => {
    expect(scoreBand({ score: 86, scoreBand: "high" })).toBe("high");
    expect(scoreBand({ score: 80, scoreBand: null })).toBe("medium");
    expect(scoreBand({ score: 42, scoreBand: null })).toBe("low");
    expect(scoreBand({ score: null, scoreBand: null })).toBeNull();
  });

  it("copies as Markdown: the title linked to the original, what it says, who said it", () => {
    expect(itemMarkdown(frontierItem({ title: "口服 PCSK9 [抑制剂]" }))).toBe([
      "**[口服 PCSK9 \\[抑制剂\\]](https://www.nejm.org/doi/full/10.1056/example)**",
      "",
      "多中心双盲试验纳入 12000 例患者。",
      "",
      "NEJM · RCT · 2026-09-22",
    ].join("\n"));
  });
});

describe("the hot list's words", () => {
  const base = { sourceCount72h: 2, primary: "paper" as const, hasPrimary: true, lastAt: at(22, 9), period: null };

  it("says how many institutions, whether the parties' own texts are there, and when it moved", () => {
    expect(hotRowMeta(base, NOW)).toBe("2 家机构报道 · 含原始论文 · 3 小时前更新");
    expect(hotRowMeta({ ...base, primary: null, hasPrimary: false }, NOW)).toBe("2 家机构报道 · 3 小时前更新");
    expect(hotRowMeta({ ...base, primary: null, hasPrimary: true, lastAt: null }, NOW)).toBe("2 家机构报道 · 含一手材料");
  });

  it("says what a week's or a month's ranking counted instead", () => {
    expect(hotRowMeta({ ...base, primary: "official", period: { institutions: 9, reports: 14, hoursOnList: 31, bestRank: 2 } }, NOW))
      .toBe("9 家机构报道 · 含官方公告 · 在榜 31 小时 · 最高第 2 名");
    expect(hotRowMeta({ ...base, primary: null, hasPrimary: false, period: { institutions: 3, reports: 3, hoursOnList: null, bestRank: null } }, NOW))
      .toBe("3 家机构报道");
  });

  it("says a rise and a first appearance, and never a fall", () => {
    expect(rankChangeLabel(2)).toBe("↑2");
    expect(rankChangeLabel("new")).toBe("新");
    expect(rankChangeLabel(0)).toBeNull();
    expect(rankChangeLabel(-3)).toBeNull();
    expect(rankChangeLabel(null)).toBeNull();
  });

  it("sets ranks in two digits and colours the first three — none of them red", () => {
    expect([1, 9, 10].map(rankLabel)).toEqual(["01", "09", "10"]);
    const tones = [1, 2, 3].map(rankTone);
    expect(new Set(tones).size).toBe(3);
    for (const tone of tones) expect(tone).not.toMatch(/danger|error/);
    expect(rankTone(4)).toBe("text-text-3");
  });

  it("stamps a ranking with its span and the time it was taken", () => {
    expect(hotBoardStamp("current", at(22, 22, 40))).toBe("近 72 小时 · 22:40 更新");
    expect(hotBoardStamp("week", null)).toBe("近 7 天");
  });
});

describe("a trend line", () => {
  const points = (values: Array<number | null>) => values.map((heat, index) => ({ at: at(22, index), heat }));

  it("is not drawn from fewer than two readings", () => {
    expect(sparkline(points([12]), 96, 28)).toBeNull();
    expect(sparkline(points([null, 12, null]), 96, 28)).toBeNull();
  });

  it("runs from the oldest reading to the newest, highest at the top, and marks the last", () => {
    const line = sparkline(points([10, 20, 30]), 96, 28)!;
    expect(line.path).toBe("M2 26 L48 14 L94 2");
    expect(line.last).toEqual({ x: 94, y: 2 });
  });

  it("keeps a missing reading's place on the time axis, and draws a flat line in the middle", () => {
    expect(sparkline(points([10, null, 30]), 96, 28)!.path).toBe("M2 26 L94 2");
    expect(sparkline(points([5, 5]), 96, 28)!.path).toBe("M2 14 L94 14");
  });
});

describe("the event page's side column", () => {
  it("counts the institutions by kind, else their number, else says nothing", () => {
    expect(institutionsLine({ sourceCount72h: 2, institutions72h: { total: 2, byType: [{ type: "journal", label: "期刊", count: 1 }, { type: "media", label: "媒体", count: 1 }] } }))
      .toBe("期刊 1 · 媒体 1");
    expect(institutionsLine({ sourceCount72h: 7 })).toBe("7 家");
    expect(institutionsLine({ sourceCount72h: 0, institutions72h: { total: 0, byType: [] } })).toBeNull();
  });

  it("says whether the parties' own texts are among the reports", () => {
    expect(primaryHeld({ primary: "paper", items: [] })).toBe("有论文原文");
    expect(primaryHeld({ primary: null, hasPrimary: true, items: [] })).toBe("有一手材料");
    expect(primaryHeld({ items: [{ ...frontierItem(), role: "primary" }] })).toBe("有一手材料");
    expect(primaryHeld({ primary: null, hasPrimary: false, items: [{ ...frontierItem(), role: "report" }] })).toBe("无");
  });
});

describe("the daily's header", () => {
  it("says how many items and, where the server counted it, how long they take", () => {
    expect(dailyMeta({ itemCount: 52, readingMinutes: 9 })).toBe("52 条 · 约 9 分钟");
    expect(dailyMeta({ itemCount: 3, readingMinutes: 0 })).toBe("3 条");
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
