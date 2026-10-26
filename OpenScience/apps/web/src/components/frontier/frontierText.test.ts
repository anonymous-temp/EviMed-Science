import { describe, expect, it } from "vitest";
import { frontierItem } from "./__fixtures__/frontierItems";
import { FEED_TIME_ZONE, ago, cardEyebrow, clock, dailyMeta, dateClock, dayHeading, evidenceTag, feedDay, feedDayKey, groupByDay, hotBoardStamp, hotRowMeta, institutionsLine, itemMarkdown, primaryHeld, rankChangeLabel, rankLabel, rankTone, askDraft, itemClock, itemLine, researchDraft, topicAskDraft, metaTime, originalLinkLabel, sameAddress, scoreBand, scoreBreakdown, shortDate, shortUrl, sparkline, splitUrls, stamp, statedDayKey, trimUrl, isStatedDayEnd, sinceText } from "./frontierText";
import type { FrontierItem } from "@/lib/frontierClient";

// The feed reads Beijing time whatever the machine's zone is (UTC+8, no daylight saving): `at` is the instant of a Beijing wall clock,
// so a test says what a reader in Beijing sees and holds in every zone it is run in (CI is UTC; run it under TZ=America/Los_Angeles too).
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 8, day, hour - 8, minute, 0)).toISOString();
const NOW = Date.parse(at(22, 12));

describe("when a card says it came", () => {
  it("is, in a list not cut into days, the clock today and the date before — never 「昨天」 in a narrow column", () => {
    expect(metaTime(frontierItem({ timelineAt: at(22, 8, 30) }), NOW)).toBe("08:30");
    expect(metaTime(frontierItem({ timelineAt: at(21, 8, 30) }), NOW)).toBe("9月21日");
    expect(metaTime(frontierItem({ timelineAt: at(18, 8, 30) }), NOW)).toBe("9月18日");
    expect(metaTime(frontierItem({ timelineAt: new Date(Date.UTC(2025, 11, 30, 1)).toISOString() }), NOW)).toBe("2025年12月30日");
  });

  it("says when something was last read: the clock today, the date before", () => {
    expect(stamp(at(22, 7, 40), NOW)).toBe("07:40");
    expect(stamp(at(20, 7, 40), NOW)).toBe("9月20日 07:40");
    expect(stamp(null, NOW)).toBe("");
  });
});

describe("Beijing time, whatever the browser's zone is", () => {
  it("reads the clock, the date and the day of a moment in the feed's zone", () => {
    expect(FEED_TIME_ZONE).toBe("Asia/Shanghai");
    // The production case: posted 11:00Z, 19:00 in Beijing.
    expect(clock("2026-10-25T11:00:00Z")).toBe("19:00");
    expect(dateClock("2026-10-25T11:00:00Z")).toBe("10月25日 19:00");
    expect(feedDayKey("2026-10-25T11:00:00Z")).toBe("2026-10-25");
    // 16:30Z is half past midnight, the next Beijing day.
    expect(clock("2026-10-25T16:30:00Z")).toBe("00:30");
    expect(dateClock("2026-10-25T16:30:00Z")).toBe("10月26日 00:30");
    expect(feedDayKey("2026-10-25T16:30:00Z")).toBe("2026-10-26");
    // The day turns at 16:00Z, and midnight reads 00:00, never 24:00.
    expect(clock("2026-10-25T15:59:59Z")).toBe("23:59");
    expect(feedDayKey("2026-10-25T15:59:59Z")).toBe("2026-10-25");
    expect(clock("2026-10-25T16:00:00Z")).toBe("00:00");
    expect(feedDayKey("2026-10-25T16:00:00Z")).toBe("2026-10-26");
    // A year end crosses in Beijing first.
    expect(dateClock("2026-12-31T17:00:00Z")).toBe("1月1日 01:00");
    expect(feedDayKey(Date.parse("2026-12-31T17:00:00Z"))).toBe("2027-01-01");
  });

  it("says nothing for what is not a time", () => {
    for (const bad of [null, "", "soon", "2026-13-45T00:00:00Z"]) {
      expect(clock(bad)).toBe("");
      expect(dateClock(bad)).toBe("");
      expect(feedDayKey(bad)).toBeNull();
      expect(statedDayKey(bad)).toBeNull();
      expect(feedDay(bad)).toBe("");
    }
  });

  it("takes today, and the day a stamp is under, from the Beijing day", () => {
    const justAfterMidnight = Date.parse("2026-10-25T17:00:00Z"); // 10月26日 01:00 in Beijing
    expect(stamp("2026-10-25T16:30:00Z", justAfterMidnight)).toBe("00:30");
    expect(stamp("2026-10-25T11:00:00Z", justAfterMidnight)).toBe("10月25日 19:00");
    const [today] = groupByDay([frontierItem({ id: "a", timelineAt: "2026-10-25T16:30:00Z" })]);
    expect(dayHeading(today, false, justAfterMidnight)).toBe("今天 · 10月26日 周一");
    expect(dayHeading(today, false, Date.parse("2026-10-25T15:00:00Z"))).toBe("10月26日 周一");
  });

  it("cuts the list into Beijing days: 11:00Z and 16:30Z of one UTC day are two", () => {
    const days = groupByDay([
      frontierItem({ id: "late", timelineAt: "2026-10-25T16:30:00Z" }),
      frontierItem({ id: "evening", timelineAt: "2026-10-25T11:00:00Z" }),
      frontierItem({ id: "early", timelineAt: "2026-10-24T16:00:00Z" }),
    ]);
    expect(days.map((day) => [day.key, day.label, day.items.map((item) => item.id).join()])).toEqual([
      ["2026-10-26", "10月26日 周一", "late"],
      ["2026-10-25", "10月25日 周日", "evening,early"],
    ]);
  });

  it("takes the weekday from the key itself", () => {
    expect(shortDate("2026-10-25")).toBe("10月25日 周日");
    expect(shortDate("2026-10-26")).toBe("10月26日 周一");
    expect(shortDate("2026-01-01")).toBe("1月1日 周四");
    expect(shortDate("2026-02-30")).toBe("2026-02-30");
    expect(shortDate("tomorrow")).toBe("tomorrow");
  });

  it("names the day a source stated by the date it is stored at", () => {
    expect(statedDayKey("2026-10-25T00:00:00Z")).toBe("2026-10-25");
    expect(statedDayKey("2026-10-25T00:00:00.000+00:00")).toBe("2026-10-25");
  });

  it("dates a day the way a list does: the month within this year, the full date before it", () => {
    const now = Date.parse("2026-10-26T04:00:00Z");
    expect(feedDay("2026-10-25T16:30:00Z", now)).toBe("10月26日");
    expect(feedDay("2025-12-31T17:00:00Z", now)).toBe("1月1日");
    expect(feedDay("2025-09-22T12:00:00Z", now)).toBe("2025-09-22");
    // The year turns in Beijing, not in the reader's zone.
    expect(feedDay("2026-12-31T17:00:00Z", Date.parse("2026-12-31T17:30:00Z"))).toBe("1月1日");
  });

  it("gives how long ago for a day, and the Beijing date past it", () => {
    const now = Date.parse("2026-10-26T04:00:00Z");
    expect(ago("2026-10-26T02:00:00Z", now)).toBe("2 小时前");
    expect(ago("2026-10-25T16:30:00Z", now)).toBe("11 小时前");
    expect(ago("2026-10-24T16:30:00Z", now)).toBe("10月25日");
    expect(ago(null, now)).toBe("");
    expect(ago("soon", now)).toBe("");
  });
});

describe("an item whose source gave a day and no hour", () => {
  const day = (over: Partial<FrontierItem> = {}) => frontierItem({ datePrecision: "day", timelineAt: at(22, 9, 15), ...over });

  it("has no clock in a day group, and says 「今天」 today and the date before in a list that is not cut into days", () => {
    expect(itemClock(day())).toBe("");
    expect(metaTime(day(), NOW)).toBe("今天");
    expect(metaTime(day({ timelineAt: at(21, 23, 59) }), NOW)).toBe("9月21日");
  });

  it("keeps the clock of an instant, and of an item we only dated ourselves", () => {
    expect(itemClock(frontierItem({ datePrecision: "instant", timelineAt: at(22, 9, 15) }))).toBe("09:15");
    expect(itemClock(frontierItem({ datePrecision: "inferred", timelineAt: at(22, 9, 15) }))).toBe("09:15");
    expect(metaTime(frontierItem({ datePrecision: "instant", timelineAt: at(22, 9, 15) }), NOW)).toBe("09:15");
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

  it("are headed 「今天 · 9月22日 周二 · 2 条」 — 今天 only for today, the count only for a whole day", () => {
    const [today, before] = groupByDay([frontierItem({ id: "a", timelineAt: at(22, 9) }), frontierItem({ id: "b", timelineAt: at(22, 8) }), frontierItem({ id: "c", timelineAt: at(21, 9) })]);
    expect(dayHeading(today, true, NOW)).toBe("今天 · 9月22日 周二 · 2 条");
    expect(dayHeading(before, true, NOW)).toBe("9月21日 周一 · 1 条");
    expect(dayHeading(before, false, NOW)).toBe("9月21日 周一");
  });
});

describe("what a card carries", () => {
  it("has one evidence tag, and none where the card already says it", () => {
    expect(evidenceTag(frontierItem())).toBe("RCT");
    expect(evidenceTag(frontierItem({ evidenceType: "other", evidenceTypeLabel: "其他" }))).toBeNull();
    expect(evidenceTag(frontierItem({ evidenceType: "safety-notice", evidenceTypeLabel: "安全通告", safetyAlert: true }))).toBeNull();
    expect(evidenceTag(frontierItem({ evidenceType: "press-release", evidenceTypeLabel: "企业新闻稿", flags: [{ key: "press-release", label: "企业新闻稿·数据未发表" }] }))).toBeNull();
  });

  it("has one eyebrow: a paper's evidence type, else its genre, and none on a safety alert, which says 安全警示 first", () => {
    expect(cardEyebrow(frontierItem())).toBe("RCT");
    expect(cardEyebrow(frontierItem({ evidenceType: null, evidenceTypeLabel: null }))).toBe("研究论文");
    expect(cardEyebrow(frontierItem({ evidenceType: null, evidenceTypeLabel: null, lane: "regulatory", laneLabel: "审批监管", genre: "policy", genreLabel: "政策法规" }))).toBe("政策法规");
    // An older server sends no genre: code's own answer from the item's fields (a company's release is industry news).
    expect(cardEyebrow(frontierItem({ sourceType: "company", evidenceType: "press-release", evidenceTypeLabel: "企业新闻稿" }))).toBe("行业动态");
    expect(cardEyebrow(frontierItem({ safetyAlert: true, evidenceType: "safety-notice", evidenceTypeLabel: "安全通告" }))).toBeNull();
  });

  it("reads the score in the server's tier, or in the fixed tiers (76, 60) without one, and nothing without a score", () => {
    expect(scoreBand({ score: 86, scoreBand: "high" })).toBe("high");
    expect(scoreBand({ score: 76, scoreBand: null })).toBe("high");
    expect(scoreBand({ score: 75, scoreBand: null })).toBe("medium");
    expect(scoreBand({ score: 60, scoreBand: null })).toBe("medium");
    expect(scoreBand({ score: 59, scoreBand: null })).toBe("low");
    expect(scoreBand({ score: null, scoreBand: null })).toBeNull();
  });

  it("breaks the score into its four parts with their maxima, and into nothing without them", () => {
    expect(scoreBreakdown(frontierItem({ score: 86, scoreParts: { authority: 27, impact: 25, novelty: 18, relevance: 16 } }))).toEqual([
      { key: "impact", label: "实践影响", value: 25, max: 30 },
      { key: "authority", label: "权威性", value: 27, max: 30 },
      { key: "novelty", label: "新颖性", value: 18, max: 20 },
      { key: "relevance", label: "国内相关性", value: 16, max: 20 },
    ]);
    expect(scoreBreakdown(frontierItem({ score: 86 }))).toEqual([]);
  });

  it("opens an article as 「打开原文」 and a post on its platform", () => {
    expect(originalLinkLabel({ platform: null })).toBe("打开原文");
    expect(originalLinkLabel({ platform: "wechat" })).toBe("打开原文");
    expect(originalLinkLabel({ platform: "x" })).toBe("在 X 查看原帖");
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
    // The stamp states a clock, so it says whose: Beijing time, once.
    expect(hotBoardStamp("current", at(22, 22, 40))).toBe("近 72 小时 · 22:40 更新（北京时间）");
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

  it("draws a flat line in the middle", () => {
    expect(sparkline(points([5, 5]), 96, 28)!.path).toBe("M2 14 L94 14");
  });

  // §11.2: a gap is shown, never joined over. The missing reading keeps its place on the time axis and the line is two segments.
  it("breaks at a missing reading: two segments, nothing drawn across the gap", () => {
    const line = sparkline(points([10, 20, null, 30, 40]), 96, 28)!;
    expect(line.path).toBe("M2 26 L25 18 M71 10 L94 2");
    expect(line.path.match(/M/g)).toHaveLength(2);
    expect(line.dots).toEqual([]);
    expect(line.last).toEqual({ x: 94, y: 2 });
    // The same readings without the gap are one line.
    expect(sparkline(points([10, 20, 25, 30, 40]), 96, 28)!.path.match(/M/g)).toHaveLength(1);
  });

  it("breaks at every gap, however long, and leaves a reading with a gap on both sides as a dot, not a line", () => {
    const line = sparkline(points([10, null, null, 20, 30, null, 40]), 96, 28)!;
    expect(line.path.match(/M/g)).toHaveLength(1);
    expect(line.path).toBe("M48 18 L63.3 10");
    expect(line.dots).toEqual([{ x: 2, y: 26 }, { x: 94, y: 2 }]);
    expect(line.last).toEqual({ x: 94, y: 2 });
    // Two readings with nothing between them drawn are still two readings: dots, and no path to stroke.
    const apart = sparkline(points([10, null, 30]), 96, 28)!;
    expect(apart.path).toBe("");
    expect(apart.dots).toEqual([{ x: 2, y: 26 }, { x: 94, y: 2 }]);
  });

  it("still says nothing is drawn from fewer than two readings, gaps or not", () => {
    expect(sparkline(points([null, null, 12, null]), 96, 28)).toBeNull();
    expect(sparkline(points([]), 96, 28)).toBeNull();
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
    expect(primaryHeld({ primary: null, hasPrimary: false, items: [{ ...frontierItem(), role: "report" }] })).toBe("暂无");
  });
});

describe("the daily's header", () => {
  it("says how many items and, where the server counted it, how long they take", () => {
    expect(dailyMeta({ itemCount: 52, readingMinutes: 9 })).toBe("52 条 · 约 9 分钟");
    expect(dailyMeta({ itemCount: 3, readingMinutes: 0 })).toBe("3 条");
  });
});

describe("the 深入研究 draft", () => {
  it("is the question that fits the item and the item's line: its title, source, day, id for the assistant, and the original", () => {
    const item = frontierItem({ flags: [{ key: "preprint", label: "未经同行评议" }], pmid: "40000001" });
    const draft = researchDraft(item);
    expect(draft.startsWith("这项研究可靠吗？")).toBe(true);
    expect(draft).toContain("它对临床实践和我的研究意味着什么");
    expect(draft.endsWith(itemLine(item))).toBe(true);
    expect(itemLine(item)).toBe(`“${item.title}”（${item.source.name} · ${item.publishedAt!.slice(0, 10)}） frontier:${item.id}\n原文：${item.url}`);
    // What the assistant needs of the item it reads through its id, not the draft's.
    for (const absent of [item.titleRaw, "DOI：", "PMID：", "导读：", "注意："]) expect(draft).not.toContain(absent);
  });

  it("asks the first question the item can answer: a design for a study, grounds for the rest", () => {
    const first = (fields: Partial<FrontierItem>) => researchDraft(frontierItem(fields)).split("？")[0];
    expect(first({ evidenceType: "rct" })).toBe("这项研究可靠吗");
    expect(first({ evidenceType: null, sourceType: "preprint" })).toBe("这项研究可靠吗");
    expect(first({ evidenceType: "guideline" })).toBe("这份指南的推荐依据是什么");
    expect(first({ evidenceType: "safety-notice", sourceType: "regulator" })).toBe("这项决定依据什么");
    expect(first({ evidenceType: "other", sourceType: "media" })).toBe("这条消息的依据是什么");
  });
});

describe("就此提问 drafts", () => {
  const item = { id: "k7q2m9x4t1b8", title: "口服 PCSK9 抑制剂降低心血管事件", source: { name: "NEJM" }, publishedAt: "2026-09-20T00:00:00.000Z", url: "https://www.nejm.org/x" };

  it("a question is followed by the item's line, and the reader's own question is the line alone", () => {
    expect(askDraft(item, "安全性数据有哪些？")).toBe("安全性数据有哪些？\n\n“口服 PCSK9 抑制剂降低心血管事件”（NEJM · 2026-09-20） frontier:k7q2m9x4t1b8\n原文：https://www.nejm.org/x");
    expect(askDraft(item, null)).toBe("“口服 PCSK9 抑制剂降低心血管事件”（NEJM · 2026-09-20） frontier:k7q2m9x4t1b8\n原文：https://www.nejm.org/x");
  });

  it("names what it is not given nothing for: no source or day, no address", () => {
    expect(itemLine({ id: "k7q2m9x4t1b8", title: "T" })).toBe("“T” frontier:k7q2m9x4t1b8");
    expect(itemLine({ id: "k7q2m9x4t1b8", title: "T", source: { name: "NEJM" } })).toBe("“T”（NEJM） frontier:k7q2m9x4t1b8");
  });

  it("a topic's draft is its question and its title; a topic whose question is its title says it once", () => {
    expect(topicAskDraft({ title: "某药安全吗", question: "某药的心血管风险有多大？" })).toBe("某药的心血管风险有多大？\n\n前沿动态热点话题：“某药安全吗”");
    expect(topicAskDraft({ title: "某药安全吗", question: "某药安全吗" })).toBe("某药安全吗\n\n前沿动态热点话题");
  });
});

describe("an address in a text", () => {
  it("leaves out what the sentence put after it: punctuation and a bracket it did not open", () => {
    expect(trimUrl("https://fda.gov/a.")).toBe("https://fda.gov/a");
    expect(trimUrl("https://fda.gov/a),")).toBe("https://fda.gov/a");
    expect(trimUrl("https://en.wikipedia.org/wiki/Aspirin_(drug)")).toBe("https://en.wikipedia.org/wiki/Aspirin_(drug)");
  });

  it("cuts a text into its words and its addresses, a full-width bracket or comma ending the address", () => {
    expect(splitUrls("详见 https://www.fda.gov/news/x。另见（https://nmpa.gov.cn/a）")).toEqual([
      "详见 ", { url: "https://www.fda.gov/news/x" }, "。另见（", { url: "https://nmpa.gov.cn/a" }, "）",
    ]);
    expect(splitUrls("没有地址的一句话")).toEqual(["没有地址的一句话"]);
  });

  it("is shown as its site and the start of its path, at most 40 characters", () => {
    expect(shortUrl("https://www.fda.gov/vaccines-blood-biologics/safety-availability-biologics/important-information-about-x")).toBe("fda.gov/vaccines-blood-biologics/…");
    expect(shortUrl("https://www.nejm.org/doi/x")).toBe("nejm.org/doi/x");
    expect(shortUrl("https://example.org/?utm_source=a")).toBe("example.org");
    expect(shortUrl("https://a.example.org/a-very-long-first-segment-of-a-path-that-goes-on/x").length).toBeLessThanOrEqual(40);
  });

  it("is the item's own address whatever its scheme, its www., its trailing slash or its fragment", () => {
    expect(sameAddress("http://www.fda.gov/a/", "https://fda.gov/a#top")).toBe(true);
    expect(sameAddress("https://fda.gov/a", "https://fda.gov/b")).toBe(false);
  });
});

describe("a moment that stands for a day and no hour (c4 review: the made-up 23:59)", () => {
  // frontierTimelineAt places a day-precision item that reached us after its day at 23:59:59.999 Beijing time: 15:59:59.999Z.
  const dayEnd = "2026-10-25T15:59:59.999Z";
  const now = Date.parse("2026-10-26T03:00:00.000Z"); // 11:00 on the 26th in Beijing
  it("is recognised by its exact last millisecond in Beijing time, and nothing else is", () => {
    expect(isStatedDayEnd(dayEnd)).toBe(true);
    expect(isStatedDayEnd("2026-10-25T15:59:59.000Z")).toBe(false);
    expect(isStatedDayEnd("2026-10-25T15:58:59.999Z")).toBe(false);
    expect(isStatedDayEnd("2026-10-25T23:59:59.999Z")).toBe(false);
    expect(isStatedDayEnd(null)).toBe(false);
    expect(isStatedDayEnd("not a time")).toBe(false);
  });
  it("has no clock, and its date and how long ago are said in days", () => {
    expect(clock(dayEnd)).toBe("");
    expect(dateClock(dayEnd)).toBe("10月25日");
    expect(ago(dayEnd, now)).toBe("昨天");
    expect(sinceText(dayEnd, now)).toBe("昨天");
    expect(ago("2026-10-22T15:59:59.999Z", now)).toBe("4 天前");
    expect(sinceText("2026-08-01T15:59:59.999Z", now)).toBe("");
    // An ordinary moment keeps its clock and its hours.
    expect(clock("2026-10-25T11:00:00.000Z")).toBe("19:00");
    expect(sinceText("2026-10-25T23:00:00.000Z", now)).toBe("4 小时前");
  });
});
