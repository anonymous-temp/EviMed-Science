import { describe, expect, it } from "vitest";
import { frontierItem } from "./__fixtures__/frontierItems";
import {
  TOP_THINGS,
  archiveEntryName,
  archiveMonths,
  dayInMonth,
  issuedStamp,
  monthKey,
  monthLabel,
  recordMoment,
  sectionsBelow,
  topThings,
} from "./frontierRecord";

const entry = (day: string, itemCount = 10) => ({ day, title: null, itemCount, generatedAt: null });

describe("the archive by month", () => {
  it("cuts the issues into months, newest month first, each month's issues in the order given", () => {
    const months = archiveMonths([entry("2026-10-27"), entry("2026-10-26"), entry("2026-09-30"), entry("2026-09-02"), entry("2026-08-31")]);
    expect(months.map((month) => [month.key, month.label, month.entries.map((issue) => issue.day)])).toEqual([
      ["2026-10", "2026年10月", ["2026-10-27", "2026-10-26"]],
      ["2026-09", "2026年9月", ["2026-09-30", "2026-09-02"]],
      ["2026-08", "2026年8月", ["2026-08-31"]],
    ]);
  });

  it("puts the months in order whatever order the issues arrive in, and a year apart is two months", () => {
    expect(archiveMonths([entry("2025-12-31"), entry("2026-01-01"), entry("2026-12-31")]).map((month) => month.label)).toEqual(["2026年12月", "2026年1月", "2025年12月"]);
  });

  it("leaves out a row whose day cannot be read rather than file it under a wrong month", () => {
    expect(archiveMonths([entry("not-a-day"), entry("2026-10-27")]).flatMap((month) => month.entries.map((issue) => issue.day))).toEqual(["2026-10-27"]);
    expect(archiveMonths([])).toEqual([]);
  });

  it("names a month, a day inside it and a row for a screen reader", () => {
    expect(monthKey("2026-10-27")).toBe("2026-10");
    expect(monthKey("2026-1-7")).toBeNull();
    expect(monthLabel("2026-09")).toBe("2026年9月");
    expect(dayInMonth("2026-10-26")).toBe("26日 周一");
    expect(archiveEntryName(entry("2026-10-26", 12))).toBe("10月26日 周一，12 条");
    expect(archiveEntryName(entry("2026-10-26", 0))).toBe("10月26日 周一");
  });
});

describe("先看三件事", () => {
  const item = (id: string, score: number | null) => frontierItem({ id, title: `${id} 标题`, summary: `${id} 速读`, score });
  const lane = (key: string, items: ReturnType<typeof item>[]) => ({ lane: key, laneLabel: key, items });
  const lead = { item: item("lead", 10), text: "头条的话", event: { id: "ev", title: "事件" } };

  it("is the lead, then the items the lanes score highest, with the issue's own sentences", () => {
    const things = topThings({ lead, sections: [lane("a", [item("a1", 40), item("a2", 91)]), lane("b", [item("b1", 77)])] })!;
    expect(things.map((thing) => thing.item.id)).toEqual(["lead", "a2", "b1"]);
    expect(things.map((thing) => thing.text)).toEqual(["头条的话", "a2 速读", "b1 速读"]);
    expect(things[0].event).toEqual({ id: "ev", title: "事件" });
    expect(things[1].event).toBeNull();
    expect(things).toHaveLength(TOP_THINGS);
  });

  it("falls back to the lead item's own summary when the issue wrote no text for it", () => {
    const things = topThings({ lead: { ...lead, text: null }, sections: [lane("a", [item("a1", 1), item("a2", 2)])] })!;
    expect(things[0].text).toBe("lead 速读");
  });

  it("keeps the issue's order for items that score alike, unscored ones last, and counts the lead once", () => {
    const things = topThings({ lead, sections: [lane("a", [item("a1", null), item("a2", 50), item("lead", 99)]), lane("b", [item("b1", 50), item("b2", null)])] })!;
    expect(things.map((thing) => thing.item.id)).toEqual(["lead", "a2", "b1"]);
  });

  it("takes all three from the lanes when there is no lead", () => {
    expect(topThings({ lead: null, sections: [lane("a", [item("a1", 5), item("a2", 9), item("a3", 7), item("a4", 1)])] })!.map((thing) => thing.item.id)).toEqual(["a2", "a3", "a1"]);
  });

  it("is nothing for fewer than three: two things are not a list of three", () => {
    expect(topThings({ lead, sections: [lane("a", [item("a1", 5)])] })).toBeNull();
    expect(topThings({ lead: null, sections: [lane("a", [item("a1", 5), item("a2", 6)])] })).toBeNull();
    expect(topThings({ lead: null, sections: [] })).toBeNull();
    // The lead is also in a lane: it is one thing, not two.
    expect(topThings({ lead, sections: [lane("a", [item("lead", 5), item("a2", 6)])] })).toBeNull();
  });

  it("makes no score of its own: an item the server did not score is never ahead of one it did", () => {
    const things = topThings({ lead: null, sections: [lane("a", [item("u1", null), item("u2", null), item("s", 0)])] })!;
    expect(things[0].item.id).toBe("s");
  });

  it("leaves the lanes below without the items shown above, and without a lane that had nothing else", () => {
    const sections = [lane("a", [item("a1", 40), item("a2", 91)]), lane("b", [item("b1", 77)]), lane("c", [item("c1", 10), item("c2", 5)])];
    const things = topThings({ lead, sections })!;
    expect(things.map((thing) => thing.item.id)).toEqual(["lead", "a2", "b1"]);
    expect(sectionsBelow({ sections }, things).map((section) => [section.lane, section.items.map((one) => one.id)])).toEqual([["a", ["a1"]], ["c", ["c1", "c2"]]]);
    // the issue's own lanes are not changed, and with no three things they are the lanes as they were
    expect(sections[0].items).toHaveLength(2);
    expect(sectionsBelow({ sections }, null)).toBe(sections);
  });
});

describe("the freshness stamps", () => {
  it("says an issue's clock in Beijing time and names the zone once", () => {
    // 07:31 in Beijing on the 27th is 23:31 UTC on the 26th.
    expect(issuedStamp("2026-10-26T23:31:00.000Z", "2026-10-27")).toBe("07:31 发布（北京时间）");
  });

  it("names the date as well when the issue was written on another Beijing day than its own", () => {
    expect(issuedStamp("2026-10-27T16:05:00.000Z", "2026-10-27")).toBe("10月28日 00:05 发布（北京时间）");
  });

  it("is nothing for an issue that does not say, or says something that is not a time", () => {
    expect(issuedStamp(null, "2026-10-27")).toBeNull();
    expect(issuedStamp("yesterday", "2026-10-27")).toBeNull();
  });
});

describe("an event's record", () => {
  const NOW = Date.parse("2026-10-26T04:00:00.000Z");

  it("says a moment as its Beijing date and clock, the year first before this one's", () => {
    expect(recordMoment("2026-09-22T10:01:00.000Z", NOW)).toBe("9月22日 18:01");
    // The year is Beijing's too: 17:30 UTC on 31 December is already the new year there.
    expect(recordMoment("2025-12-31T17:30:00.000Z", NOW)).toBe("1月1日 01:30");
    expect(recordMoment("2025-12-31T15:30:00.000Z", NOW)).toBe("2025年12月31日 23:30");
    expect(recordMoment("2025-06-01T01:00:00.000Z", NOW)).toBe("2025年6月1日 09:00");
  });

  it("gives a moment that stands for a day the day alone, and nothing for a time it cannot read", () => {
    // The last millisecond of 14 September in Beijing: a source that stated a day and no hour.
    expect(recordMoment("2026-09-14T15:59:59.999Z", NOW)).toBe("9月14日");
    expect(recordMoment(null, NOW)).toBe("");
    expect(recordMoment("soon", NOW)).toBe("");
  });
});
