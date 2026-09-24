import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type {
  FrontierDaily,
  FrontierHotBoard,
  FrontierHotEvent,
  FrontierItem,
  FrontierItemsPage,
  FrontierItemsQuery,
  FrontierStatus,
} from "@/lib/frontierClient";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
import { frontierItem } from "@/components/frontier/__fixtures__/frontierItems";
import { FrontierPage } from "./FrontierPage";

const client = vi.hoisted(() => ({
  useFrontierFeature: vi.fn(),
  fetchFrontierStatus: vi.fn(),
  listFrontierItems: vi.fn(),
  fetchFrontierForYou: vi.fn(),
  fetchFrontierHotBoard: vi.fn(),
  listFrontierDailies: vi.fn(),
  fetchFrontierDaily: vi.fn(),
  fetchFrontierSources: vi.fn(),
  starFrontierItem: vi.fn(),
  unstarFrontierItem: vi.fn(),
  hideFrontierItem: vi.fn(),
  unhideFrontierItem: vi.fn(),
  markFrontierItemRead: vi.fn(),
  saveFrontierItemToLibrary: vi.fn(),
}));
// Partial: the vocabulary, the parsers and the error words stay real.
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  ...client,
}));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  getWebProjectId: () => "project-one",
}));

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
// Day groups are the reader's calendar days, so the fixtures sit on known days
// whatever hour the suite runs at: "today" a second ago, the rest before midnight.
const MIDNIGHT = new Date().setHours(0, 0, 0, 0);
const beforeMidnight = (hours: number) => new Date(MIDNIGHT - hours * HOUR).toISOString();

function status(overrides: Partial<FrontierStatus> = {}): FrontierStatus {
  return {
    enabled: true, audience: "all",
    plugin: { state: "ok", lastPullAt: ago(0) },
    lastPublishedAt: ago(1), lastDailyDay: null,
    sources: { total: 753, enabled: 267, healthy: 250, degraded: 10, unreadable: 7, drifted: 0, planned: 486 },
    counts: { today: 40, selectedToday: 18 },
    personalization: "available",
    capabilities: { saveToLibrary: true, abstractZh: true, forYou: true, hot: true, daily: true },
    versions: { content: "1", hot: null, daily: null },
    ...overrides,
  };
}

function page(items: FrontierItem[], overrides: Partial<FrontierItemsPage> = {}): FrontierItemsPage {
  return { items, nextCursor: null, version: "1", mode: "list", restarted: false, ...overrides };
}

function hotEvent(rank: number, overrides: Partial<FrontierHotEvent> = {}): FrontierHotEvent {
  return {
    rank, id: `ev${rank}`, title: `热点事件 ${rank}`, latest: null, sourceCount72h: 2, reportCount: 3, primary: null, hasPrimary: false,
    firstAt: ago(30), lastAt: ago(3), status: "developing", heat: 40 - rank * 3, rankChange: null, badge: null,
    trend: [20, 22, 25, 27, 30, 33, 37].map((heat, index) => ({ at: ago(24 - index * 4), heat })), period: null,
    ...overrides,
  };
}

function board(events: FrontierHotEvent[], overrides: Partial<FrontierHotBoard> = {}): FrontierHotBoard {
  return { window: "current", takenAt: ago(0.2), since: ago(72.2), events, ...overrides };
}

const today = frontierItem({ id: "today-1", title: "今天的一条 RCT", timelineAt: new Date(Date.now() - 1000).toISOString(), score: 86, scoreBand: "high" });
const yesterday = frontierItem({ id: "yesterday-1", title: "昨天的一条指南", timelineAt: beforeMidnight(6) });
const alert = frontierItem({ id: "alert-1", title: "I 级召回：葡萄糖注射液含不锈钢颗粒", safetyAlert: true, lane: "safety", laneLabel: "药物安全",
  evidenceType: "safety-notice", evidenceTypeLabel: "安全通告", source: { id: "fda-recalls", name: "FDA" }, timelineAt: ago(2) });
const alert2 = frontierItem({ id: "alert-2", title: "氯巴占口服混悬液条形码错误", safetyAlert: true, source: { id: "mhra", name: "英国 MHRA" }, timelineAt: ago(30) });
const oldAlert = frontierItem({ id: "alert-old", title: "三天前的召回", safetyAlert: true, source: { id: "fda-recalls", name: "FDA" }, timelineAt: ago(60) });
/** Newer than `today`, for what arrives above the top of the list. */
const newer = frontierItem({ id: "newer-1", title: "刚发布的一条", timelineAt: new Date().toISOString() });

/** The main list; the strip's safety notices are asked with `safety`. */
let feed: (query: FrontierItemsQuery) => Promise<FrontierItemsPage>;
let alerts: () => Promise<FrontierItemsPage>;
const feedQueries = () => client.listFrontierItems.mock.calls.map(([query]) => query as FrontierItemsQuery).filter((query) => !query.safety);
const lastFeedQuery = () => feedQueries().at(-1);

function Probe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderPage(path = "/app/frontier") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/frontier" element={<><FrontierPage /><Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
      <Toaster />
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId("location").textContent ?? "";

beforeEach(() => {
  Object.values(client).forEach((mock) => mock.mockReset());
  useToastStore.setState({ toasts: [] });
  client.useFrontierFeature.mockReturnValue("on");
  client.fetchFrontierStatus.mockResolvedValue(status());
  feed = async () => page([today, yesterday]);
  alerts = async () => page([alert, alert2, oldAlert]);
  client.listFrontierItems.mockImplementation(async (query: FrontierItemsQuery) => (query.safety ? alerts() : feed(query)));
  client.fetchFrontierForYou.mockResolvedValue(null);
  client.fetchFrontierHotBoard.mockResolvedValue(null);
  client.listFrontierDailies.mockResolvedValue(null);
  client.fetchFrontierDaily.mockResolvedValue(null);
  client.starFrontierItem.mockResolvedValue({ starred: true, hidden: false, read: false });
  client.unstarFrontierItem.mockResolvedValue({ starred: false, hidden: false, read: false });
  client.hideFrontierItem.mockResolvedValue({ starred: false, hidden: true, read: false });
  client.unhideFrontierItem.mockResolvedValue({ starred: false, hidden: false, read: false });
  client.markFrontierItemRead.mockResolvedValue({ starred: false, hidden: false, read: true });
});

describe("where the module is not offered", () => {
  it("says one sentence and reads nothing", async () => {
    client.useFrontierFeature.mockReturnValue("off");
    renderPage();
    expect(screen.getByText("前沿动态还没有在这个工作空间开放。")).toBeInTheDocument();
    expect(client.listFrontierItems).not.toHaveBeenCalled();
    expect(client.fetchFrontierStatus).not.toHaveBeenCalled();
  });

  it("turns into that sentence when the server answers frontier_not_enabled", async () => {
    client.fetchFrontierStatus.mockRejectedValue(new WebApiError("off", { status: 404, code: "frontier_not_enabled" }));
    renderPage();
    expect(await screen.findByText("前沿动态还没有在这个工作空间开放。")).toBeInTheDocument();
  });
});

describe("the page and its views", () => {
  it("opens on 精选 under a one-line header — the title and the search box, no sentence under it", async () => {
    renderPage();
    const title = screen.getByRole("heading", { level: 1, name: "前沿动态" });
    expect(title.closest("header")).toContainElement(screen.getByRole("searchbox", { name: "搜索" }));
    await screen.findByText("今天的一条 RCT");
    expect(screen.queryByText(/每天替你读/)).not.toBeInTheDocument();
    expect(title.closest("header")?.querySelector("p")).toBeNull();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["精选", "热榜", "日报", "全部", "与我相关"]);
    expect(screen.getByRole("tab", { name: "精选" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", screen.getByRole("tab", { name: "精选" }).id);
    expect(lastFeedQuery()).toMatchObject({ view: "selected", q: null, lane: null, starred: false });
  });

  it("switches views through the tabs and keeps them in the address", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "热榜" }));
    expect(location()).toBe("/app/frontier?view=hot");
    expect(screen.getByRole("tab", { name: "热榜" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "与我相关" }));
    expect(location()).toBe("/app/frontier?view=foryou");
    await userEvent.click(screen.getByRole("tab", { name: "精选" }));
    expect(location()).toBe("/app/frontier");
  });

  it.each([
    ["/app/frontier?view=hot", "热榜"],
    ["/app/frontier?view=daily&day=2026-09-20", "日报"],
    ["/app/frontier?view=all", "全部"],
    ["/app/frontier?view=selected", "精选"],
    ["/app/frontier?view=foryou", "与我相关"],
    ["/app/frontier?view=unknown", "精选"],
  ])("lands %s — an address older pages and notifications carry — on %s", async (path, tab) => {
    renderPage(path);
    expect(screen.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    // The view's own read settles before the page goes away.
    await waitFor(() => expect(screen.getByRole("tabpanel").querySelector(".animate-pulse")).toBeNull());
    await waitFor(() => expect(client.fetchFrontierStatus).toHaveBeenCalled());
  });
});

describe("the filter row", () => {
  it("is one row: 全部 and five lanes, the rest under 「更多」, then 专科 and 收藏", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    const lanes = screen.getByRole("group", { name: "栏目" });
    expect(within(lanes).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部", "临床证据", "指南共识", "药物安全", "审批监管", "研发产业", "更多"]);
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
    const row = lanes.parentElement!;
    expect(within(row).getByRole("button", { name: "专科" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "收藏" })).toHaveAttribute("aria-pressed", "false");
    // The time range is a filter of 全部 only.
    expect(within(row).queryByRole("button", { name: "时间" })).not.toBeInTheDocument();
  });

  it("narrows by lane, specialty and stars, and keeps them in the address", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.click(screen.getByRole("button", { name: "药物安全" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ lane: "safety" }));
    await userEvent.click(screen.getByRole("button", { name: "专科" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "心血管" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ lane: "safety", specialty: "cardiology" }));
    await userEvent.click(within(screen.getByRole("group", { name: "栏目" }).parentElement!).getByRole("button", { name: "收藏" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ lane: "safety", specialty: "cardiology", starred: true }));
    expect(location()).toContain("lane=safety&specialty=cardiology&starred=1");
    expect(screen.getByRole("button", { name: "专科：心血管" })).toHaveAttribute("aria-haspopup", "menu");
  });

  it("offers the time range in 全部", async () => {
    renderPage("/app/frontier?view=all");
    await screen.findByText("今天的一条 RCT");
    await userEvent.click(screen.getByRole("button", { name: "时间" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "7 天" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ view: "all", window: "7d" }));
  });

  it("filters by a card's specialty tag and searches for its disease tag", async () => {
    feed = async () => page([frontierItem({ id: "tagged", title: "带标签的一条", timelineAt: ago(0.1), entities: { drugs: [], trials: [], orgs: [], diseases: ["心衰"] } })]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "#心血管" }));
    await waitFor(() => expect(location()).toBe("/app/frontier?specialty=cardiology"));
    await userEvent.click(await screen.findByRole("button", { name: "#心衰" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ view: "all", q: "心衰" }));
  });
});

describe("search", () => {
  it("searches the whole feed, orders it by time on request, and goes back where it began", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索" }), "司美格鲁肽");
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ view: "all", q: "司美格鲁肽" }));
    const results = await screen.findByRole("region", { name: "搜索结果" });
    expect(within(results).getAllByRole("article")).toHaveLength(2);
    // 精选 is the dot and words for a screen reader, not a chip.
    expect(within(results).getAllByText("精选")[0]).toHaveClass("sr-only");
    await userEvent.click(screen.getByRole("button", { name: "按时间" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ q: "司美格鲁肽", sort: "time" }));
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索" }));
    await waitFor(() => expect(location()).toBe("/app/frontier"));
    expect(screen.getByRole("tab", { name: "精选" })).toHaveAttribute("aria-selected", "true");
  });

  it("says in one sentence that nothing matched", async () => {
    feed = async (query) => (query.q ? page([]) : page([today]));
    renderPage("/app/frontier?view=all&q=%E6%97%A0%E6%AD%A4%E8%8D%AF");
    expect(await screen.findByText("没有找到和「无此药」相关的动态")).toBeInTheDocument();
  });
});

describe("精选's safety strip", () => {
  it("leads 精选 with the last 48 hours' alerts: how many, the newest, who issued it, and the rest on request", async () => {
    renderPage();
    const strip = await screen.findByRole("region", { name: "安全警示" });
    expect(strip).toHaveTextContent("安全警示 2");
    const newest = within(strip).getByRole("link", { name: /I 级召回：葡萄糖注射液含不锈钢颗粒/ });
    expect(newest).toHaveTextContent("· FDA · 2 小时前");
    expect(newest).toHaveAttribute("target", "_blank");
    // Every lane's alerts, three days of them, cut to 48 hours here.
    expect(client.listFrontierItems).toHaveBeenCalledWith({ view: "all", safety: true, window: "3d", limit: 50 });
    expect(strip).not.toHaveTextContent("三天前的召回");
    expect(strip).not.toHaveTextContent("氯巴占");
    await userEvent.click(within(strip).getByRole("button", { name: "全部 ›" }));
    expect(within(strip).getByRole("link", { name: /氯巴占口服混悬液条形码错误/ })).toHaveTextContent("英国 MHRA");
    // It stands above the filters' reach and above the hot list.
    const hot = screen.queryByRole("heading", { name: "当前热点" });
    if (hot) expect(strip.compareDocumentPosition(hot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is not there when nothing was issued in the last 48 hours", async () => {
    alerts = async () => page([oldAlert]);
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await waitFor(() => expect(client.listFrontierItems).toHaveBeenCalledWith(expect.objectContaining({ safety: true })));
    expect(screen.queryByRole("region", { name: "安全警示" })).not.toBeInTheDocument();
  });

  it("says so when the alerts could not be read, rather than looking like there are none", async () => {
    let fail = true;
    alerts = async () => {
      if (fail) throw new WebApiError("down", { status: 503, code: null });
      return page([alert]);
    };
    renderPage();
    const failed = await screen.findByText("安全警示读取失败");
    fail = false;
    await userEvent.click(within(failed.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("region", { name: "安全警示" })).toHaveTextContent("安全警示 1");
  });

  it("stays in 精选 whatever the filters say", async () => {
    renderPage("/app/frontier?lane=pipeline");
    expect(await screen.findByRole("region", { name: "安全警示" })).toBeInTheDocument();
  });
});

describe("当前热点", () => {
  it("shows the five hottest with their heat and how they moved, and opens the whole list", async () => {
    client.fetchFrontierHotBoard.mockResolvedValue(board([
      hotEvent(1, { title: "不饱和磷脂脂质体实现亲水药物超缓释", heat: 38, rankChange: 2 }),
      hotEvent(2, { heat: 31, rankChange: -1 }),
      hotEvent(3, { heat: 27, rankChange: "new" }),
      hotEvent(4), hotEvent(5), hotEvent(6), hotEvent(7),
    ]));
    renderPage();
    const card = (await screen.findByRole("heading", { name: "当前热点" })).closest("section")!;
    expect(client.fetchFrontierHotBoard).toHaveBeenCalledWith("current");
    const rows = within(card).getAllByRole("link");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveAttribute("href", "/app/frontier/events/ev1");
    expect(rows[0]).toHaveTextContent("1不饱和磷脂脂质体实现亲水药物超缓释38 热度↑2");
    // A fall is not said; a first appearance is.
    expect(rows[1]).toHaveTextContent(/31 热度$/);
    expect(rows[2]).toHaveTextContent(/27 热度新$/);
    expect(within(card).queryByText("热点事件 6")).not.toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "完整热榜 ›" }));
    expect(location()).toBe("/app/frontier?view=hot");
  });

  it("is not there without hot events, nor while the feed is narrowed", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    expect(screen.queryByRole("heading", { name: "当前热点" })).not.toBeInTheDocument();
    client.fetchFrontierHotBoard.mockResolvedValue(board([hotEvent(1)]));
    await userEvent.click(screen.getByRole("button", { name: "临床证据" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ lane: "evidence" }));
    expect(screen.queryByRole("heading", { name: "当前热点" })).not.toBeInTheDocument();
  });
});

describe("the feed", () => {
  it("falls into days headed by the date, counting a day once it is whole", async () => {
    feed = async () => page([today, yesterday], { nextCursor: "c1" });
    renderPage();
    const headings = await screen.findAllByRole("heading", { level: 2, name: /^\d+月\d+日 周./ });
    // Today is whole (the next page cannot reach back to it); the last day may continue.
    expect(headings[0]).toHaveTextContent(/1 条$/);
    expect(headings[1]).not.toHaveTextContent("条");
    const lists = headings.map((heading) => heading.closest("section")!.querySelector("ul")!);
    expect(within(lists[0]).getByRole("heading", { level: 3 })).toHaveAttribute("data-row-title");
  });

  it("restarts from page one, quietly, when the list changed under a stale cursor", async () => {
    feed = async (query) => (query.cursor
      ? page([newer, today], { restarted: true, version: "2" })
      : page([today, yesterday], { nextCursor: "c1" }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("刚发布的一条")).toBeInTheDocument();
    expect(screen.queryByText("昨天的一条指南")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("appends the next page when the cursor still holds", async () => {
    const older = frontierItem({ id: "older-1", title: "三天前的一条", timelineAt: beforeMidnight(60) });
    feed = async (query) => (query.cursor ? page([older]) : page([today], { nextCursor: "c1" }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("三天前的一条")).toBeInTheDocument();
    expect(screen.getByText("今天的一条 RCT")).toBeInTheDocument();
    expect(lastFeedQuery()).toMatchObject({ cursor: "c1" });
  });

  it("says how many new items arrived above the list when the content version moves", async () => {
    let calls = 0;
    feed = async () => {
      calls += 1;
      return calls === 1 ? page([today], { version: "1" }) : page([newer, today], { version: "2" });
    };
    client.fetchFrontierStatus.mockResolvedValue(status({ versions: { content: "2", hot: null, daily: null } }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "有 1 条新的" }));
    expect(await screen.findByText("刚发布的一条")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /条新的/ })).not.toBeInTheDocument();
  });

  it("says when the plugin stopped being read, as the time after the title", async () => {
    client.fetchFrontierStatus.mockResolvedValue(status({ plugin: { state: "unreachable", lastPullAt: new Date(new Date().setHours(8, 5, 0, 0)).toISOString() } }));
    renderPage();
    const header = screen.getByRole("heading", { level: 1, name: "前沿动态" }).closest("header")!;
    expect(await within(header).findByText("08:05 更新")).toBeInTheDocument();
  });
});

describe("the four states", () => {
  it("shows the feed's skeleton while the first page is on its way", async () => {
    feed = () => new Promise(() => {});
    const { container } = renderPage();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    // Everything around the list still arrives; the list alone is waiting.
    expect(await screen.findByRole("region", { name: "安全警示" })).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it.each([
    ["on a first run", { lastPublishedAt: null }, "/app/frontier", "暂无内容"],
    ["when a filter found nothing", {}, "/app/frontier?lane=safety", "没有结果"],
    ["when nothing is selected yet", {}, "/app/frontier", "暂无精选"],
  ])("says so in one sentence %s", async (_case, overrides, path, sentence) => {
    feed = async () => page([]);
    client.fetchFrontierStatus.mockResolvedValue(status(overrides));
    renderPage(path);
    expect(await screen.findByText(sentence)).toBeInTheDocument();
  });

  it("offers a retry when nothing could be read", async () => {
    let fail = true;
    feed = async () => {
      if (fail) throw new WebApiError("down", { status: 503, code: null });
      return page([today]);
    };
    renderPage();
    const alertBox = await screen.findByRole("alert");
    fail = false;
    await userEvent.click(within(alertBox).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("今天的一条 RCT")).toBeInTheDocument();
  });

  it("keeps the last content on screen when a refresh fails", async () => {
    let calls = 0;
    feed = async () => {
      calls += 1;
      if (calls === 3) throw new WebApiError("down", { status: 503, code: null });
      return page([today]);
    };
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.click(screen.getByRole("tab", { name: "全部" }));
    await waitFor(() => expect(calls).toBe(2));
    await userEvent.click(screen.getByRole("tab", { name: "精选" }));
    expect(await screen.findByText("未能刷新")).toBeInTheDocument();
    expect(screen.getByText("今天的一条 RCT")).toBeInTheDocument();
  });
});

describe("the actions on a card", () => {
  it("stars an item, and puts the star back when the server refuses", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(within(card).getByRole("button", { name: "收藏" }));
    expect(client.starFrontierItem).toHaveBeenCalledWith("today-1");
    expect(within(card).getByRole("button", { name: "收藏" })).toHaveAttribute("aria-pressed", "true");
    client.unstarFrontierItem.mockRejectedValue(new WebApiError("down", { status: 503, code: null }));
    await userEvent.click(within(card).getByRole("button", { name: "收藏" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "收藏" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("hides an item with a toast that can undo it", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(within(card).getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "不感兴趣" }));
    expect(screen.queryByRole("article", { name: "今天的一条 RCT" })).not.toBeInTheDocument();
    expect(client.hideFrontierItem).toHaveBeenCalledWith("today-1");
    expect(screen.getByText("已隐藏")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(await screen.findByRole("article", { name: "今天的一条 RCT" })).toBeInTheDocument();
    await waitFor(() => expect(client.unhideFrontierItem).toHaveBeenCalledWith("today-1"));
  });

  it("saves to the knowledge base, and stops offering it where the server has no such route", async () => {
    client.saveFrontierItemToLibrary.mockResolvedValueOnce({ kind: "md", path: "knowledge-base/frontier/x.md", note: null }).mockResolvedValueOnce(null);
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(within(card).getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "存入知识库" }));
    expect(client.saveFrontierItemToLibrary).toHaveBeenCalledWith("today-1", "project-one");
    expect(await screen.findByText("已存入知识库")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "存入知识库" }));
    expect(await screen.findByText("暂时不能存入知识库")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "更多操作" }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "存入知识库" })).not.toBeInTheDocument();
  });

  it("does not offer 存入知识库 until /status names it among the deployment's capabilities", async () => {
    client.fetchFrontierStatus.mockResolvedValue(status({ capabilities: { saveToLibrary: false, abstractZh: false, forYou: false, hot: true, daily: true } }));
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await waitFor(() => expect(client.fetchFrontierStatus).toHaveBeenCalled());
    await userEvent.click(within(card).getByRole("button", { name: "更多操作" }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "存入知识库" })).not.toBeInTheDocument();
  });

  it("greys the title of an item once its original was opened", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    expect(within(card).getByRole("heading", { level: 3 })).toHaveClass("text-text");
    await userEvent.click(within(card).getByRole("link", { name: "原文" }));
    expect(client.markFrontierItemRead).toHaveBeenCalledWith("today-1");
    expect(within(card).getByRole("heading", { level: 3 })).toHaveClass("text-text-2");
  });

  it("shows the editorial total and never a dimension's number", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    expect(within(card).getByTitle("编辑评分 · 满分 100")).toHaveTextContent("86");
    // The fixture carries scoreTotal 87 and scores 29 / 17 / 13, which the contract never sends.
    for (const number of ["87", "29", "17", "13"]) expect(card.textContent).not.toContain(number);
  });
});

describe("热榜", () => {
  const events = [
    hotEvent(1, { title: "不饱和磷脂脂质体实现亲水药物超缓释", heat: 38, primary: "paper", hasPrimary: true }),
    hotEvent(2, { heat: 31 }),
    hotEvent(3, { heat: 27, badge: "new", trend: null }),
    hotEvent(4, { heat: 24, badge: "rising" }),
  ];

  it("ranks the events with their heat over a 24-hour trend, and folds how heat is counted", async () => {
    client.fetchFrontierHotBoard.mockResolvedValue(board(events, { takenAt: new Date(new Date().setHours(22, 40, 0, 0)).toISOString() }));
    renderPage("/app/frontier?view=hot");
    const list = await screen.findByRole("list", { name: "热榜" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("01");
    expect(within(rows[0]).getByRole("link", { name: "不饱和磷脂脂质体实现亲水药物超缓释" })).toHaveAttribute("href", "/app/frontier/events/ev1");
    expect(rows[0]).toHaveTextContent("2 家机构报道 · 含原始论文 · 3 小时前更新");
    expect(rows[0]).toHaveTextContent("38热度");
    expect(rows[0].querySelector("svg[data-sparkline] path")).not.toBeNull();
    expect(within(rows[2]).getByText("新")).toHaveClass("bg-accent-soft");
    expect(within(rows[2]).getByText("暂无走势")).toBeInTheDocument();
    expect(within(rows[3]).getByText("升温")).toHaveClass("bg-warn-soft");
    // One title edge: every row's title link carries the marker the release walk measures.
    for (const row of rows) expect(row.querySelector("[data-row-title]")).not.toBeNull();
    expect(screen.getByText("近 72 小时 · 22:40 更新")).toBeInTheDocument();
    await userEvent.click(screen.getByText("热度怎么算"));
    expect(screen.getByText(/热度衡量关注程度，不衡量证据强弱/)).toBeVisible();
    expect(document.body.textContent).not.toContain("爆");
  });

  it("reads this week's ranking when asked, with each row's own count", async () => {
    client.fetchFrontierHotBoard.mockImplementation(async (window: string) => (window === "week"
      ? board([hotEvent(1, { heat: null, trend: null, period: { institutions: 9, reports: 14, hoursOnList: 31, bestRank: 2 }, primary: "official", hasPrimary: true })], { window: "week" })
      : board(events)));
    renderPage("/app/frontier?view=hot");
    await screen.findByRole("list", { name: "热榜" });
    expect(screen.getByRole("button", { name: "当前" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "本周" }));
    await waitFor(() => expect(client.fetchFrontierHotBoard).toHaveBeenLastCalledWith("week"));
    expect(location()).toBe("/app/frontier?view=hot&window=week");
    expect(await screen.findByText("9 家机构报道 · 含官方公告 · 在榜 31 小时 · 最高第 2 名")).toBeInTheDocument();
    expect(screen.queryByText("热度")).not.toBeInTheDocument();
  });

  it("leaves out what a server that stamps no ranking cannot back: the window chips and the heat", async () => {
    client.fetchFrontierHotBoard.mockResolvedValue(board(events.map((event) => ({ ...event, heat: null, trend: null })), { takenAt: null }));
    renderPage("/app/frontier?view=hot");
    await screen.findByRole("list", { name: "热榜" });
    expect(screen.queryByRole("button", { name: "本周" })).not.toBeInTheDocument();
    expect(screen.queryByText("热度怎么算")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无走势")).not.toBeInTheDocument();
  });

  it("says it is still being prepared where the server has no hot list", async () => {
    renderPage("/app/frontier?view=hot");
    expect(await screen.findByText("热榜还在准备")).toBeInTheDocument();
  });
});

describe("日报", () => {
  function issue(day: string, overrides: Partial<FrontierDaily> = {}): FrontierDaily {
    return {
      day, windowStart: ago(53), windowEnd: ago(29), generatedAt: ago(28),
      lead: { item: frontierItem({ id: "lead", title: "FDA 发布新方法学（NAMs）专题" }), text: "FDA 发布直接最终规则。", event: { id: "ev1", title: "x" } },
      sections: [{ lane: "evidence", laneLabel: "临床证据", items: [today, yesterday] }],
      safety: [alert, alert2], aiMinute: null, markdown: `# EviMed 医学前沿日报 ${day}`, itemCount: 52,
      readingMinutes: 9, previousDay: null, nextDay: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    client.listFrontierDailies.mockResolvedValue([
      { day: "2026-09-21", title: "口服 PCSK9 抑制剂拿到硬终点证据", itemCount: 18, generatedAt: ago(5) },
      { day: "2026-09-20", title: "FDA 批准皮下注射阿尔茨海默病抗体", itemCount: 9, generatedAt: ago(29) },
      { day: "2026-09-19", title: "医保目录初审", itemCount: 12, generatedAt: ago(53) },
    ]);
    client.fetchFrontierDaily.mockImplementation(async (day: string) => issue(day));
  });

  it("opens the issue a notification names: the day, its size and reading time, the lead and its event", async () => {
    renderPage("/app/frontier?view=daily&day=2026-09-20");
    const header = await screen.findByRole("heading", { level: 2, name: "9月20日 周日" });
    expect(client.fetchFrontierDaily).toHaveBeenCalledWith("2026-09-20");
    expect(header.parentElement).toHaveTextContent("52 条 · 约 9 分钟");
    expect(screen.getByRole("heading", { level: 3, name: "FDA 发布新方法学（NAMs）专题" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "事件页 ›" })).toHaveAttribute("href", "/app/frontier/events/ev1");
  });

  it("puts the safety alerts first, names institutions and never an interface, and starts every title on one line", async () => {
    renderPage("/app/frontier?view=daily&day=2026-09-20");
    const safety = await screen.findByRole("list", { name: "安全警示" });
    const sections = screen.getAllByRole("list").filter((list) => list.tagName === "OL");
    expect(sections[0]).toBe(safety);
    expect(within(safety).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^01I 级召回：葡萄糖注射液含不锈钢颗粒FDA·原文/),
      expect.stringMatching(/^02氯巴占口服混悬液条形码错误英国 MHRA·原文/),
    ]);
    expect(document.body.textContent).not.toMatch(/API|openFDA/);
    for (const list of sections) {
      for (const row of within(list).getAllByRole("listitem")) {
        // A fixed number column, then the title first in its own column: nothing of variable width before it.
        const [number, column] = [...row.children];
        expect(number).toHaveClass("w-8", "tabular-nums");
        expect(column.firstElementChild).toHaveAttribute("data-row-title");
      }
    }
  });

  it("copies the issue, and moves by 往期 and by 前一日 / 后一日", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage("/app/frontier?view=daily&day=2026-09-20");
    await screen.findByRole("heading", { level: 2, name: "9月20日 周日" });
    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith("# EviMed 医学前沿日报 2026-09-20");
    expect(await screen.findByText("已复制")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "往期" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "9月21日 周一" }));
    await waitFor(() => expect(client.fetchFrontierDaily).toHaveBeenLastCalledWith("2026-09-21"));
    // From the archive's neighbours, where the server names none.
    await userEvent.click(await screen.findByRole("button", { name: "‹ 前一日" }));
    await waitFor(() => expect(client.fetchFrontierDaily).toHaveBeenLastCalledWith("2026-09-20"));
    await userEvent.click(await screen.findByRole("button", { name: "‹ 前一日" }));
    await waitFor(() => expect(client.fetchFrontierDaily).toHaveBeenLastCalledWith("2026-09-19"));
    expect(location()).toBe("/app/frontier?view=daily&day=2026-09-19");
  });

  it("leaves out the reading time a server has not counted", async () => {
    client.fetchFrontierDaily.mockImplementation(async (day: string) => issue(day, { readingMinutes: 0 }));
    renderPage("/app/frontier?view=daily&day=2026-09-20");
    const header = await screen.findByRole("heading", { level: 2, name: "9月20日 周日" });
    expect(header.parentElement).toHaveTextContent("52 条");
    expect(header.parentElement).not.toHaveTextContent("分钟");
  });

  it("says in one sentence where there is no daily yet", async () => {
    client.listFrontierDailies.mockResolvedValue(null);
    renderPage("/app/frontier?view=daily");
    expect(await screen.findByText("暂无日报")).toBeInTheDocument();
  });
});

describe("与我相关", () => {
  it("groups the items under the reader's own topics, and no card says why", async () => {
    client.fetchFrontierForYou.mockResolvedValue({
      state: "available", basis: "vector",
      items: [
        { item: frontierItem({ id: "fy-1", title: "SGLT2 抑制剂用于射血分数保留的心衰" }), reason: { text: "因为你在做：SGLT2 与心衰的 Meta 分析", topic: "SGLT2 与心衰的 Meta 分析", memoryId: "m1" } },
        { item: frontierItem({ id: "fy-2", title: "替尔泊肽心衰结局试验" }), reason: { text: "因为你在做：SGLT2 与心衰的 Meta 分析", topic: "SGLT2 与心衰的 Meta 分析", memoryId: "m1" } },
        // A server that sends only the sentence: the topic is what follows 「因为你关注：」.
        { item: frontierItem({ id: "fy-3", title: "阿司匹林一级预防" }), reason: { text: "因为你关注：老年人阿司匹林", topic: null, memoryId: "m2" } },
      ],
    });
    renderPage("/app/frontier?view=foryou");
    const first = await screen.findByRole("heading", { level: 2, name: "SGLT2 与心衰的 Meta 分析" });
    expect(within(first.closest("section")!).getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 2, name: "老年人阿司匹林" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("因为你");
  });

  it("says in one sentence that there is nothing for the reader yet", async () => {
    client.fetchFrontierForYou.mockResolvedValue({ state: "available", basis: "tags", items: [] });
    renderPage("/app/frontier?view=foryou");
    expect(await screen.findByText("暂无与你相关的动态")).toBeInTheDocument();
  });
});

describe("the sources", () => {
  it("are a quiet link at the end of 全部, read only when opened, one row per institution with its selections", async () => {
    client.fetchFrontierSources.mockResolvedValue({
      mirroredAt: ago(1), counts: { planned: 486 },
      sources: [
        { id: "nejm", name: "NEJM Crossref", displayName: "新英格兰医学杂志", homepage: "https://www.nejm.org", lane: "evidence", laneLabel: "临床证据", sourceType: "journal", sourceTypeLabel: "期刊", access: "crossref-issn", health: "healthy", healthLabel: "正常", lastOkAt: ago(2), lastNewEntryAt: ago(2), entries7d: 40, selected30d: 12, enabled: true, retired: false },
        { id: "fda-recalls", name: "openFDA 药品召回（enforcement）API", displayName: "FDA", homepage: null, lane: "safety", laneLabel: "药物安全", sourceType: "regulator", sourceTypeLabel: "监管", access: "json-api", health: "healthy", healthLabel: "正常", lastOkAt: ago(1), lastNewEntryAt: ago(1), entries7d: 9, selected30d: 7, enabled: true, retired: false },
        { id: "fda-shortage", name: "openFDA 药品短缺 API", displayName: "FDA", homepage: "https://www.fda.gov", lane: "safety", laneLabel: "药物安全", sourceType: "regulator", sourceTypeLabel: "监管", access: "json-api", health: "healthy", healthLabel: "正常", lastOkAt: ago(1), lastNewEntryAt: ago(1), entries7d: 3, selected30d: 8, enabled: true, retired: false },
        { id: "nmpa", name: "国家药监局", displayName: "国家药监局", homepage: null, lane: "regulatory", laneLabel: "审批监管", sourceType: "regulator", sourceTypeLabel: "监管", access: "browser-list", health: "disabled", healthLabel: "已停用", lastOkAt: null, lastNewEntryAt: null, entries7d: 0, selected30d: 0, enabled: false, retired: false },
      ],
    });
    renderPage("/app/frontier?view=all");
    await screen.findByText("今天的一条 RCT");
    const link = screen.getByRole("button", { name: "我们在读的信源（267）" });
    expect(client.fetchFrontierSources).not.toHaveBeenCalled();
    await userEvent.click(link);
    const drawer = await screen.findByRole("dialog", { name: "我们在读的信源" });
    const list = await within(drawer).findByRole("list", { name: "信源" });
    expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "FDA近 30 天精选 15 条",
      "新英格兰医学杂志近 30 天精选 12 条",
    ]);
    expect(drawer).not.toHaveTextContent(/API|读法|状态|国家药监局/);
    await userEvent.click(within(drawer).getByRole("button", { name: "按名称" }));
    expect(within(list).getAllByRole("listitem").map((row) => row.textContent?.split("近")[0])).toEqual(["FDA", "新英格兰医学杂志"].sort((a, b) => a.localeCompare(b, "zh")));
  });
});
