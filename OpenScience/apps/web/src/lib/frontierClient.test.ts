import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "./apiClient";
import {
  addFrontierFollow,
  fetchFrontierDaily,
  fetchFrontierEvent,
  fetchFrontierForYou,
  fetchFrontierHot,
  fetchFrontierHotBoard,
  fetchFrontierSources,
  fetchFrontierDigestSwitch,
  fetchFrontierStatus,
  frontierAbsence,
  frontierOffered,
  hideFrontierItem,
  listFrontierDailies,
  listFrontierFollows,
  listFrontierItems,
  operateFrontierItem,
  parseFacts,
  parseFrontierItem,
  saveFrontierItemToLibrary,
  setFrontierDigestSwitch,
  starFrontierItem,
} from "./frontierClient";
import { rawFrontierItem as rawItem } from "@/components/frontier/__fixtures__/frontierItems";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const requested = () => fetchMock.mock.calls.map(([input, init]) => ({ url: String(input), method: init?.method ?? "GET" }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the items list", () => {
  it("asks with every filter named and the page size bounded", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { items: [rawItem()], nextCursor: "c2", version: 41, mode: "keyword" } }));
    const page = await listFrontierItems({ view: "all", lane: "safety", specialty: "pharmacy", window: "7d", q: " 司美格鲁肽 ", starred: true, cursor: "c1", limit: 500 });
    const url = new URL(requested()[0].url, "http://localhost");
    expect(url.pathname).toBe("/api/frontier/items");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      view: "all", by: "timeline", lane: "safety", specialty: "pharmacy", window: "7d", q: "司美格鲁肽", starred: "1", cursor: "c1", limit: "50",
    });
    expect(page).toMatchObject({ nextCursor: "c2", version: "41", mode: "keyword", restarted: false });
    expect(page.items).toHaveLength(1);
  });

  it("starts over from page one when the cursor has gone stale, and says it did", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(400, { error: "The cursor no longer matches.", code: "invalid_cursor" }))
      .mockResolvedValueOnce(reply(200, { data: { items: [rawItem()], nextCursor: null, version: 42, mode: "list" } }));
    const page = await listFrontierItems({ view: "selected", cursor: "stale" });
    expect(page.restarted).toBe(true);
    expect(page.items).toHaveLength(1);
    const [first, second] = requested().map((call) => new URL(call.url, "http://localhost").searchParams);
    expect(first.get("cursor")).toBe("stale");
    expect(second.has("cursor")).toBe(false);
  });

  it("does not hide an invalid cursor on page one: there is nothing to restart from", async () => {
    fetchMock.mockResolvedValue(reply(400, { error: "bad", code: "invalid_cursor" }));
    await expect(listFrontierItems({ view: "selected" })).rejects.toBeInstanceOf(WebApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("reading an item", () => {
  it("keeps only the fields a card renders: the editorial total, never a dimension's number or a model name", () => {
    const item = parseFrontierItem(rawItem({ score: 86, scoreBand: "high" }))!;
    expect([item.score, item.scoreBand]).toEqual([86, "high"]);
    const text = JSON.stringify(item);
    expect(text).not.toMatch(/scoreTotal|"scores"|87|29|deepseek/i);
    expect(item.levels).toEqual({ authority: "high", impact: "high", novelty: "medium", relevance: "low" });
  });

  it("reads a score only as a whole 0–100 with a known band, and never on a safety alert", () => {
    expect([parseFrontierItem(rawItem())!.score, parseFrontierItem(rawItem())!.scoreBand]).toEqual([null, null]);
    expect(parseFrontierItem(rawItem({ score: 64.4, scoreBand: "medium" }))).toMatchObject({ score: 64, scoreBand: "medium" });
    expect(parseFrontierItem(rawItem({ score: 140, scoreBand: "high" }))).toMatchObject({ score: null, scoreBand: null });
    expect(parseFrontierItem(rawItem({ score: "80", scoreBand: "gold" }))).toMatchObject({ score: null, scoreBand: null });
    expect(parseFrontierItem(rawItem({ score: 90, scoreBand: "high", safetyAlert: true }))).toMatchObject({ score: null, scoreBand: null });
  });

  it("counts the other institutions from the server, and a server that sends no count named them all", () => {
    const mentions = [{ sourceId: "mhra", sourceName: "英国 MHRA", url: "https://mhra.example.org/1" }];
    expect(parseFrontierItem(rawItem({ alsoReportedBy: mentions, alsoReportedCount: 7 }))!.alsoReportedCount).toBe(7);
    expect(parseFrontierItem(rawItem({ alsoReportedBy: mentions }))!.alsoReportedCount).toBe(1);
    expect(parseFrontierItem(rawItem())!.alsoReportedCount).toBe(0);
  });

  it("drops an item without a readable link, and never keeps a script link", () => {
    expect(parseFrontierItem(rawItem({ url: "javascript:alert(1)" }))).toBeNull();
    expect(parseFrontierItem(rawItem({ url: "/relative/path" }))).toBeNull();
    const item = parseFrontierItem(rawItem({ openAccess: { status: "gold", pdfUrl: "javascript:alert(1)" }, source: { id: "x", name: "X", homepage: "data:text/html,hi" } }))!;
    expect(item.openAccess).toEqual({ status: "gold", pdfUrl: null });
    expect(item.source.homepage).toBeNull();
  });

  it("drops what a card cannot stand without, and fills words the server left out", () => {
    expect(parseFrontierItem(rawItem({ id: "" }))).toBeNull();
    expect(parseFrontierItem(rawItem({ source: { id: "x" } }))).toBeNull();
    expect(parseFrontierItem(rawItem({ timelineAt: "not a time", visibleAt: null, publishedAt: null }))).toBeNull();
    const item = parseFrontierItem(rawItem({
      flags: [{ key: "preprint" }, { key: "press-release", label: "企业新闻稿·数据未发表" }, { key: "made-up-flag" }],
      levels: { authority: "very-high", impact: 30 },
      datePrecision: "sometime",
    }))!;
    expect(item.flags).toEqual([
      { key: "preprint", label: "未经同行评议" },
      { key: "press-release", label: "企业新闻稿·数据未发表" },
    ]);
    expect(item.levels).toEqual({ authority: null, impact: null, novelty: null, relevance: null });
    expect(item.datePrecision).toBe("instant");
  });
});

describe("status", () => {
  it("reads versions as strings, so a number and its string are one version", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: {
      enabled: true, audience: "all", plugin: { state: "unreachable", lastPullAt: "2026-09-22T02:42:00.000Z" },
      lastPublishedAt: null, sources: { total: 753, enabled: 267, planned: 486 }, counts: { today: 40, selectedToday: 18 },
      personalization: "off", versions: { content: 12, hot: null, daily: 3 },
    } }));
    const status = await fetchFrontierStatus();
    expect(status.versions).toEqual({ content: "12", hot: null, daily: "3" });
    expect(status.sources.enabled).toBe(267);
    expect(status.plugin.state).toBe("unreachable");
  });

  it("reads what the deployment offers, and a server that does not say offers nothing", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { data: { personalization: "available",
      capabilities: { saveToLibrary: true, abstractZh: "yes", forYou: true, hot: true } } }));
    const status = await fetchFrontierStatus();
    expect(status.personalization).toBe("available");
    expect(status.capabilities).toEqual({ saveToLibrary: true, abstractZh: false, forYou: true, hot: true, daily: false });
    fetchMock.mockResolvedValueOnce(reply(200, { data: {} }));
    expect((await fetchFrontierStatus()).capabilities).toEqual({ saveToLibrary: false, abstractZh: false, forYou: false, hot: false, daily: false });
  });
});

describe("the safety rail and the knowledge base", () => {
  it("asks for safety alerts by their own filter, from every lane", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { items: [], nextCursor: null, version: 1, mode: "list" } }));
    await listFrontierItems({ view: "all", safety: true, window: "7d", limit: 50 });
    const params = new URL(requested()[0].url, "http://localhost").searchParams;
    expect(params.get("safety")).toBe("1");
    expect(params.has("lane")).toBe(false);
  });

  it("reads which copy was saved, and why a record stands where a PDF was expected", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { saved: { kind: "md", path: "knowledge-base/frontier/a.md", note: "开放获取全文暂时下载不了，先存了题录和链接。" } } }));
    await expect(saveFrontierItemToLibrary("item", "project")).resolves.toEqual({ kind: "md", path: "knowledge-base/frontier/a.md",
      note: "开放获取全文暂时下载不了，先存了题录和链接。" });
    expect(requested()[0]).toEqual({ url: expect.stringContaining("/api/frontier/items/item/save-to-library"), method: "POST" });
  });
});

describe("the daily's switch", () => {
  const preferences = { quietHours: { start: "22:00", end: "08:00" }, digestTime: "08:00",
    switches: { notify: true, question: true, review: true, frontier: true }, channels: ["in-app", "feishu"], revision: 4 };

  it("reads on unless the inbox says off, and a server that has not stored it reads as on", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { data: preferences }));
    await expect(fetchFrontierDigestSwitch()).resolves.toBe(true);
    fetchMock.mockResolvedValueOnce(reply(200, { data: { ...preferences, switches: { notify: true, question: true, review: true } } }));
    await expect(fetchFrontierDigestSwitch()).resolves.toBe(true);
    fetchMock.mockResolvedValueOnce(reply(200, { data: { ...preferences, switches: { ...preferences.switches, frontier: false } } }));
    await expect(fetchFrontierDigestSwitch()).resolves.toBe(false);
  });

  it("writes through the inbox's own route, with everything else as it was", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, { data: preferences }))
      .mockResolvedValueOnce(reply(200, { data: { ...preferences, switches: { ...preferences.switches, frontier: false }, revision: 5 } }));
    await expect(setFrontierDigestSwitch(false)).resolves.toBe(false);
    const [, patch] = fetchMock.mock.calls;
    expect(String(patch[0])).toContain("/api/inbox/preferences");
    expect(patch[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(patch[1]?.body))).toEqual({ quietHours: preferences.quietHours, digestTime: "08:00",
      switches: { notify: true, question: true, review: true, frontier: false }, channels: ["in-app", "feishu"], expectedRevision: 4 });
  });
});

describe("the routes of the second wave", () => {
  it("answer null, not an error, where the route does not exist yet or the module is off", async () => {
    fetchMock.mockImplementation(async () => reply(404, { error: "Frontier route not found.", code: "not_found" }));
    await expect(fetchFrontierHot()).resolves.toBeNull();
    await expect(fetchFrontierForYou()).resolves.toBeNull();
    await expect(listFrontierDailies()).resolves.toBeNull();
    await expect(fetchFrontierDaily("2026-09-21")).resolves.toBeNull();
    await expect(saveFrontierItemToLibrary("item", "project")).resolves.toBeNull();
    fetchMock.mockImplementation(async () => reply(404, { error: "off", code: "frontier_not_enabled" }));
    await expect(fetchFrontierHot()).resolves.toBeNull();
  });

  it("still fail loudly on a real failure", async () => {
    fetchMock.mockResolvedValue(reply(500, { error: "boom", code: "internal_error" }));
    await expect(fetchFrontierHot()).rejects.toBeInstanceOf(WebApiError);
  });

  it("keeps an event's own 404 apart from a route that is missing", async () => {
    fetchMock.mockResolvedValueOnce(reply(404, { error: "gone", code: "frontier_event_not_found" }));
    const missing = await fetchFrontierEvent("e1").catch((error: unknown) => error);
    expect(frontierAbsence(missing)).toBeNull();
    fetchMock.mockResolvedValueOnce(reply(404, { error: "no route", code: "not_found" }));
    expect(frontierAbsence(await fetchFrontierEvent("e1").catch((error: unknown) => error))).toBe("not-offered");
    fetchMock.mockResolvedValueOnce(reply(404, { error: "off", code: "frontier_not_enabled" }));
    expect(frontierAbsence(await fetchFrontierEvent("e1").catch((error: unknown) => error))).toBe("off");
  });

  it("reads the hot list in rank order, each row with its shown heat, change, badge and trend", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { window: "current", takenAt: "2026-09-23T14:40:00.000Z", since: "2026-09-20T14:40:00.000Z", events: [
      { rank: 1, id: "ev1", title: "口服 PCSK9 抑制剂硬终点结果公布", latest: "企业公布定价", sourceCount72h: 6, reportCount: 9, primary: "paper",
        lastAt: "2026-09-22T06:00:00.000Z", firstAt: "2026-09-21T06:00:00.000Z", heat: 38, rankChange: 2, badge: "rising",
        trend: [{ at: "2026-09-22T14:40:00.000Z", heat: 20 }, { at: "not a time", heat: 30 }, { at: "2026-09-23T14:40:00.000Z", heat: 38 }], period: null },
      { id: "ev2", title: "医保目录初审名单公示", sourceCount72h: 9, reportCount: 11, primary: "official", heat: 12.7, rankChange: "new", badge: "爆", trend: null },
      { title: "no id" },
    ] } }));
    const events = await fetchFrontierHot();
    expect(events?.map((event) => [event.rank, event.id, event.primary, event.hasPrimary])).toEqual([[1, "ev1", "paper", true], [2, "ev2", "official", true]]);
    expect(events?.[0]).toMatchObject({ heat: 38, rankChange: 2, badge: "rising", firstAt: "2026-09-21T06:00:00.000Z", period: null,
      trend: [{ at: "2026-09-22T14:40:00.000Z", heat: 20 }, { at: "2026-09-23T14:40:00.000Z", heat: 38 }] });
    // A badge outside the two is not shown; no trend is 「暂无走势」.
    expect(events?.[1]).toMatchObject({ heat: 13, rankChange: "new", badge: null, trend: null });
    expect(requested()[0].url).toBe("/api/frontier/hot");
  });

  it("reads a week's ranking with the time it was taken and each row's period", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { window: "week", takenAt: "2026-09-23T14:41:00.000Z", since: "2026-09-16T14:41:00.000Z", events: [
      { rank: 1, id: "ev1", title: "司美格鲁肽心衰结果", sourceCount72h: 0, reportCount: 14, primary: null, hasPrimary: false, heat: null, rankChange: null,
        badge: null, trend: null, period: { institutions: 9, reports: 14, hoursOnList: 31, bestRank: 2 } },
    ] } }));
    const board = await fetchFrontierHotBoard("week");
    expect(requested()[0].url).toBe("/api/frontier/hot?window=week");
    expect(board).toMatchObject({ window: "week", takenAt: "2026-09-23T14:41:00.000Z", since: "2026-09-16T14:41:00.000Z" });
    expect(board?.events[0].period).toEqual({ institutions: 9, reports: 14, hoursOnList: 31, bestRank: 2 });
    expect(board?.events[0].heat).toBeNull();
  });

  it("reads the event page's side column: the heat, the first-hand material, the institutions by kind, the trend", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { event: { id: "ev1", title: "不饱和磷脂脂质体实现亲水药物超缓释", heat: 38, hasPrimary: true, primary: "paper",
      institutions72h: { total: 2, byType: [{ type: "journal", label: "期刊", count: 1 }, { type: "media", label: "媒体", count: 1 }, { type: "x", count: 1 }] },
      trend: [{ at: "2026-09-23T10:00:00.000Z", heat: 31 }, { at: "2026-09-23T11:00:00.000Z", heat: 38 }], items: [], related: [] } } }));
    const event = await fetchFrontierEvent("ev1");
    expect(event).toMatchObject({ heat: 38, hasPrimary: true, primary: "paper",
      institutions72h: { total: 2, byType: [{ type: "journal", label: "期刊", count: 1 }, { type: "media", label: "媒体", count: 1 }] } });
    expect(event.trend).toHaveLength(2);
    fetchMock.mockResolvedValue(reply(200, { data: { event: { id: "ev2", title: "旧服务器的事件", items: [], related: [] } } }));
    expect(await fetchFrontierEvent("ev2")).toMatchObject({ heat: null, hasPrimary: false, primary: null, institutions72h: { total: 0, byType: [] }, trend: null });
  });

  it("reads the daily's header and footer: the items it shows, the minutes to read them, the issues on either side", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { daily: { day: "2026-09-23", sections: [], safety: [], markdown: "# 日报", itemCount: 52,
      readingMinutes: 9, previousDay: "2026-09-22", nextDay: null } } }));
    expect(await fetchFrontierDaily("2026-09-23")).toMatchObject({ itemCount: 52, readingMinutes: 9, previousDay: "2026-09-22", nextDay: null });
    fetchMock.mockResolvedValue(reply(200, { data: { daily: { day: "2026-09-21", sections: [], safety: [], markdown: "", itemCount: 3 } } }));
    expect(await fetchFrontierDaily("2026-09-21")).toMatchObject({ readingMinutes: 1, previousDay: null, nextDay: null });
  });

  it("reads each reason's topic alone, what 「与我相关」 groups by", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { state: "available", basis: "vector", items: [
      { item: rawItem(), reason: { text: "因为你在做：SGLT2 抑制剂与心衰", topic: "SGLT2 抑制剂与心衰", memoryId: "m1" } },
      { item: rawItem({ id: "b2" }), reason: { text: "因为你关注：心内科临床", memoryId: "m2" } },
    ] } }));
    const forYou = await fetchFrontierForYou();
    expect(forYou?.items.map((entry) => entry.reason.topic)).toEqual(["SGLT2 抑制剂与心衰", null]);
  });
});

describe("the sources list", () => {
  it("reads each feed with the institution a reader knows it by and its selected items of 30 days", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { sources: [
      { id: "openfda-drug-enforcement-api", name: "openFDA 药品召回（enforcement）API", displayName: "FDA", selected30d: 7 },
      { id: "nejm", name: "新英格兰医学杂志 NEJM" },
    ] } }));
    const listing = await fetchFrontierSources();
    expect(listing.sources.map((source) => [source.name, source.displayName, source.selected30d])).toEqual([
      ["openFDA 药品召回（enforcement）API", "FDA", 7], ["新英格兰医学杂志 NEJM", "新英格兰医学杂志 NEJM", 0],
    ]);
  });
});

describe("searching by time", () => {
  it("names the order only when it is time, and only with words to search", async () => {
    fetchMock.mockImplementation(async () => reply(200, { data: { items: [], nextCursor: null, version: 1, mode: "keyword" } }));
    await listFrontierItems({ view: "all", q: "司美格鲁肽", sort: "time" });
    await listFrontierItems({ view: "all", q: "司美格鲁肽", sort: "relevance" });
    await listFrontierItems({ view: "all", sort: "time" });
    const sorts = requested().map((call) => new URL(call.url, "http://localhost").searchParams.get("sort"));
    expect(sorts).toEqual(["time", null, null]);
  });
});

describe("state changes", () => {
  it("post to the item's own action and read back the reader's state", async () => {
    fetchMock.mockImplementation(async () => reply(200, { data: { state: { starred: true, hidden: false, read: true } } }));
    await expect(starFrontierItem("item/1")).resolves.toEqual({ starred: true, hidden: false, read: true });
    await hideFrontierItem("item/1");
    expect(requested()).toEqual([
      { url: "/api/frontier/items/item%2F1/star", method: "POST" },
      { url: "/api/frontier/items/item%2F1/hide", method: "POST" },
    ]);
  });
});

describe("whether the module is offered", () => {
  it("is off unless /api/me says so in so many words", () => {
    const me = { user: { id: "u", name: "u" }, project: { id: "p", name: "p" }, projects: [] };
    expect(frontierOffered(null)).toBe(false);
    expect(frontierOffered(me)).toBe(false);
    expect(frontierOffered({ ...me, features: { frontier: "yes" } } as never)).toBe(false);
    expect(frontierOffered({ ...me, features: { frontier: true } } as never)).toBe(true);
  });
});

describe("follows and operator actions", () => {
  it("reads a follow back from the envelope and posts exactly the declared fields", async () => {
    fetchMock.mockImplementation(async () => reply(200, { data: { follow: { id: 7, kind: "specialty", key: "cardiology", label: "心血管", muted: false, createdAt: "x" } } }));
    await expect(addFrontierFollow({ kind: "specialty", key: "cardiology", label: "心血管" }))
      .resolves.toEqual({ id: "7", kind: "specialty", key: "cardiology", label: "心血管", muted: false });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ kind: "specialty", key: "cardiology", label: "心血管", muted: false });
    fetchMock.mockImplementation(async () => reply(200, { data: { follows: [{ id: "7", kind: "specialty", key: "cardiology", label: "心血管" }, { id: "8", kind: "unknown", key: "x" }] } }));
    await expect(listFrontierFollows()).resolves.toEqual([{ id: "7", kind: "specialty", key: "cardiology", label: "心血管", muted: false }]);
  });

  it("names the operator action in the path and sends the reason", async () => {
    fetchMock.mockImplementation(async () => reply(200, { data: { item: { id: "a1" } } }));
    await operateFrontierItem("a1", "withdraw", "来源更正");
    expect(requested()).toEqual([{ url: "/api/frontier/ops/items/a1/withdraw", method: "POST" }]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ reason: "来源更正" });
  });
});

describe("the card's facts on the wire", () => {
  it("keeps words, numbers, yes/no, lists and small records, and drops what a card cannot show", () => {
    expect(parseFacts({
      journal: "NEJM", impact_factor: 78.5, open: true, tags: ["a", "", 3, "b"], trial_facts: { phase: "PHASE3", nested: { x: 1 }, enrollment: 500 },
      "Bad Key": "x", empty: "  ", infinite: Number.POSITIVE_INFINITY, deep: [["x"]],
    })).toEqual({ journal: "NEJM", impact_factor: 78.5, open: true, tags: ["a", "b"], trial_facts: { phase: "PHASE3", enrollment: 500 } });
    expect(parseFacts(null)).toEqual({});
    expect(Object.keys(parseFacts(Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`key_${index}`, index])))).length).toBe(12);
  });
});

