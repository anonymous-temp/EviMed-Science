import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "./apiClient";
import {
  addFrontierFollow,
  fetchFrontierDaily,
  fetchFrontierEvent,
  fetchFrontierForYou,
  fetchFrontierHot,
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
  it("keeps only the fields a card renders: no score, no model name ever reaches the page", () => {
    const item = parseFrontierItem(rawItem())!;
    const text = JSON.stringify(item);
    expect(text).not.toMatch(/score|87|29|deepseek/i);
    expect(item.levels).toEqual({ authority: "high", impact: "high", novelty: "medium", relevance: "low" });
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

  it("reads the hot list without a heat value and in rank order", async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { events: [
      { rank: 1, id: "ev1", title: "口服 PCSK9 抑制剂硬终点结果公布", latest: "企业公布定价", sourceCount72h: 6, reportCount: 9, primary: "paper", lastAt: "2026-09-22T06:00:00.000Z", heat: 12.7 },
      { id: "ev2", title: "医保目录初审名单公示", sourceCount72h: 9, reportCount: 11, primary: "official" },
      { title: "no id" },
    ] } }));
    const events = await fetchFrontierHot();
    expect(events?.map((event) => [event.rank, event.id, event.primary])).toEqual([[1, "ev1", "paper"], [2, "ev2", "official"]]);
    expect(JSON.stringify(events)).not.toContain("12.7");
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

