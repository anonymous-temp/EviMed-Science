import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { FrontierItem, FrontierItemsPage, FrontierItemsQuery, FrontierStatus } from "@/lib/frontierClient";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
import { frontierItem } from "@/components/frontier/__fixtures__/frontierItems";
import { FrontierPage } from "./FrontierPage";

const client = vi.hoisted(() => ({
  useFrontierFeature: vi.fn(),
  fetchFrontierStatus: vi.fn(),
  listFrontierItems: vi.fn(),
  fetchFrontierForYou: vi.fn(),
  fetchFrontierHot: vi.fn(),
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
    personalization: "off",
    capabilities: { saveToLibrary: true, abstractZh: true, forYou: false, hot: true, daily: true },
    versions: { content: "1", hot: null, daily: null },
    ...overrides,
  };
}

function page(items: FrontierItem[], overrides: Partial<FrontierItemsPage> = {}): FrontierItemsPage {
  return { items, nextCursor: null, version: "1", mode: "list", restarted: false, ...overrides };
}

const today = frontierItem({ id: "today-1", title: "今天的一条 RCT", timelineAt: new Date(Date.now() - 1000).toISOString() });
const yesterday = frontierItem({ id: "yesterday-1", title: "昨天的一条指南", timelineAt: beforeMidnight(6) });
const alert = frontierItem({ id: "alert-1", title: "氟喹诺酮类说明书修订", safetyAlert: true, lane: "safety", laneLabel: "药物安全", timelineAt: beforeMidnight(3) });
/** Newer than `today`, for what arrives above the top of the list. */
const newer = frontierItem({ id: "newer-1", title: "刚发布的一条", timelineAt: new Date().toISOString() });

/** The main list, unless the call is the rail's seven days of safety notices. */
let feed: (query: FrontierItemsQuery) => Promise<FrontierItemsPage>;
const lastFeedQuery = () => client.listFrontierItems.mock.calls.map(([query]) => query as FrontierItemsQuery).filter((query) => query.limit !== 50).at(-1);

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

beforeEach(() => {
  Object.values(client).forEach((mock) => mock.mockReset());
  useToastStore.setState({ toasts: [] });
  client.useFrontierFeature.mockReturnValue("on");
  client.fetchFrontierStatus.mockResolvedValue(status());
  feed = async () => page([today, yesterday]);
  client.listFrontierItems.mockImplementation(async (query: FrontierItemsQuery) => (query.limit === 50 ? page([alert]) : feed(query)));
  client.fetchFrontierForYou.mockResolvedValue(null);
  client.fetchFrontierHot.mockResolvedValue(null);
  client.listFrontierDailies.mockResolvedValue(null);
  client.fetchFrontierDaily.mockResolvedValue(null);
  client.starFrontierItem.mockResolvedValue({ starred: true, hidden: false, read: false });
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

describe("精选, the default view", () => {
  it("opens with the one sentence, the filters and the feed by day", async () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "前沿动态" })).toBeInTheDocument();
    expect(await screen.findByText("EviMed 每天替你读 267 个医学与 AI 信源，只留下值得看的。每条都标明来源和证据类型，点开就是原文。")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "精选" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radiogroup", { name: "栏目" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "专科" })).toBeInTheDocument();
    // The window is a filter of 全部 only.
    expect(screen.queryByRole("radiogroup", { name: "时间范围" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: /^今天 · .+ · 1 条精选$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /^昨天 · .+ · 1 条精选$/ })).toBeInTheDocument();
    expect(lastFeedQuery()).toMatchObject({ view: "selected", q: null, lane: null, starred: false });
  });

  it("hides 与你相关 where it has nothing, and shows it with a reason that opens the memory", async () => {
    client.fetchFrontierStatus.mockResolvedValue(status({ personalization: "available" }));
    client.fetchFrontierForYou.mockResolvedValue({
      state: "available", basis: "vector",
      items: [{ item: frontierItem({ id: "fy-1", title: "SGLT2 抑制剂用于射血分数保留的心衰" }), reason: { text: "因为你在做：SGLT2 与心衰的 Meta 分析", memoryId: "m1" } }],
    });
    renderPage();
    const block = await screen.findByRole("region", { name: /与你相关/ });
    expect(within(block).getByRole("link", { name: "因为你在做：SGLT2 与心衰的 Meta 分析" })).toHaveAttribute("href", "/app/memory?record=m1");
  });

  it("does not show 与你相关 when the route is not there", async () => {
    client.fetchFrontierStatus.mockResolvedValue(status({ personalization: "available" }));
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await waitFor(() => expect(client.fetchFrontierForYou).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: /与你相关/ })).not.toBeInTheDocument();
  });

  it("does not even ask for 与你相关 when the status says personalisation is off", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await screen.findByText(/每天替你读 267 个/);
    expect(client.fetchFrontierForYou).not.toHaveBeenCalled();
  });

  it("says in one line that 与你相关 is unavailable when the memory service is down", async () => {
    client.fetchFrontierStatus.mockResolvedValue(status({ personalization: "unavailable" }));
    client.fetchFrontierForYou.mockResolvedValue({ state: "unavailable", basis: null, items: [] });
    renderPage();
    expect(await screen.findByText("「与你相关」暂时不可用，其余内容照常。")).toBeInTheDocument();
  });
});

describe("views and filters", () => {
  it("switches views through the control and keeps them in the address", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.click(screen.getByRole("radio", { name: "全部" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/frontier?view=all");
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ view: "all" }));
    expect(screen.getByRole("radiogroup", { name: "时间范围" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "7 天" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ view: "all", window: "7d" }));
    // In 全部 the selected ones say so.
    expect(screen.getAllByText("精选").length).toBeGreaterThan(1);
  });

  it("narrows by lane, specialty and stars", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.click(screen.getByRole("radio", { name: "药物安全" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ lane: "safety" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "专科" }), "心血管");
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ lane: "safety", specialty: "cardiology" }));
    await userEvent.click(screen.getByRole("button", { name: "只看收藏" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ lane: "safety", specialty: "cardiology", starred: true }));
    expect(screen.getByTestId("location")).toHaveTextContent("lane=safety&specialty=cardiology&starred=1");
  });

  it("searches the whole feed, says which results are 精选, and goes back where it began", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索前沿动态" }), "司美格鲁肽");
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ view: "all", q: "司美格鲁肽" }));
    const results = await screen.findByRole("region", { name: "搜索结果" });
    expect(within(results).getByText("在全部动态里搜「司美格鲁肽」，精选的已标出。")).toBeInTheDocument();
    expect(within(results).getAllByText("精选")).toHaveLength(2);
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索前沿动态" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/frontier$/));
    expect(screen.getByRole("radio", { name: "精选" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("the four states", () => {
  it("shows the card skeleton while the first page is on its way", async () => {
    feed = () => new Promise(() => {});
    const { container } = renderPage();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    // Everything around the list still arrives; the list alone is waiting.
    expect(await screen.findByText("氟喹诺酮类说明书修订")).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("says the first sources are being read on a first run", async () => {
    feed = async () => page([]);
    client.fetchFrontierStatus.mockResolvedValue(status({ lastPublishedAt: null }));
    renderPage();
    expect(await screen.findByText("正在读第一批信源，大约 20 分钟后这里会有内容。")).toBeInTheDocument();
  });

  it("says a filter found nothing, in the words of the plan", async () => {
    feed = async () => page([]);
    renderPage("/app/frontier?lane=safety");
    expect(await screen.findByText("这个条件下暂时没有，换个栏目或时间范围。")).toBeInTheDocument();
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

  it("keeps the last content on screen when a refresh fails, and says when it was read", async () => {
    let calls = 0;
    feed = async () => {
      calls += 1;
      if (calls === 3) throw new WebApiError("down", { status: 503, code: null });
      return page([today]);
    };
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.click(screen.getByRole("radio", { name: "全部" }));
    await waitFor(() => expect(calls).toBe(2));
    await userEvent.click(screen.getByRole("radio", { name: "精选" }));
    expect(await screen.findByText(/^暂时读不到，下面是上次读到的内容（更新于 \d{2}:\d{2}）。$/)).toBeInTheDocument();
    expect(screen.getByText("今天的一条 RCT")).toBeInTheDocument();
  });
});

describe("paging", () => {
  it("restarts from page one when the list changed under a stale cursor", async () => {
    feed = async (query) => (query.cursor
      ? page([newer, today], { restarted: true, version: "2" })
      : page([today, yesterday], { nextCursor: "c1" }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("刚发布的一条")).toBeInTheDocument();
    expect(screen.queryByText("昨天的一条指南")).not.toBeInTheDocument();
    expect(screen.getByText("列表有更新，已从第一页重新加载。")).toBeInTheDocument();
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
});

describe("the actions on a card", () => {
  it("stars an item and says so", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(within(card).getByRole("button", { name: "收藏" }));
    expect(client.starFrontierItem).toHaveBeenCalledWith("today-1");
    expect(within(card).getByRole("button", { name: "已收藏" })).toBeInTheDocument();
  });

  it("puts a starred item back when the server refuses", async () => {
    client.starFrontierItem.mockRejectedValue(new WebApiError("down", { status: 503, code: null }));
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(within(card).getByRole("button", { name: "收藏" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "收藏" })).toBeInTheDocument());
  });

  it("hides an item with a toast that can undo it", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(within(card).getByRole("button", { name: "不感兴趣" }));
    expect(screen.queryByRole("article", { name: "今天的一条 RCT" })).not.toBeInTheDocument();
    expect(client.hideFrontierItem).toHaveBeenCalledWith("today-1");
    expect(screen.getByText("已隐藏")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(await screen.findByRole("article", { name: "今天的一条 RCT" })).toBeInTheDocument();
    await waitFor(() => expect(client.unhideFrontierItem).toHaveBeenCalledWith("today-1"));
  });

  it("says 存入知识库 is still being prepared where the server has no such route, and stops offering it", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(await within(card).findByRole("button", { name: "存入知识库" }));
    expect(client.saveFrontierItemToLibrary).toHaveBeenCalledWith("today-1", "project-one");
    expect(await screen.findByText("存入知识库还在准备，暂时用不了。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "存入知识库" })).not.toBeInTheDocument();
  });

  it("says which kind of copy went into the knowledge base", async () => {
    client.saveFrontierItemToLibrary.mockResolvedValue({ kind: "md", path: "knowledge-base/frontier/x.md", note: null });
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(await within(card).findByRole("button", { name: "存入知识库" }));
    expect(await screen.findByText("已存入知识库：这篇没有开放获取的全文，存的是题录和链接。")).toBeInTheDocument();
  });

  it("says why a record was saved where the open-access PDF could not be had", async () => {
    client.saveFrontierItemToLibrary.mockResolvedValue({ kind: "md", path: "knowledge-base/frontier/x.md", note: "开放获取全文暂时下载不了，先存了题录和链接。" });
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(await within(card).findByRole("button", { name: "存入知识库" }));
    expect(await screen.findByText("已存入知识库：开放获取全文暂时下载不了，先存了题录和链接。")).toBeInTheDocument();
  });

  it("does not offer 存入知识库 until /status names it among the deployment's capabilities", async () => {
    client.fetchFrontierStatus.mockResolvedValue(status({ capabilities: { saveToLibrary: false, abstractZh: false, forYou: false, hot: true, daily: true } }));
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    expect(within(card).queryByRole("button", { name: "存入知识库" })).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "收藏" })).toBeInTheDocument();
  });
});

describe("the rail", () => {
  it("lists the week's safety alerts and leaves out the hot list and the AI minute until they exist", async () => {
    renderPage();
    const rail = await screen.findByRole("complementary", { name: "侧栏" });
    expect(await within(rail).findByText("氟喹诺酮类说明书修订")).toBeInTheDocument();
    // Alerts from every lane: an alert's lane is the screening model's pick, so a lane filter would miss some.
    expect(client.listFrontierItems).toHaveBeenCalledWith({ view: "all", safety: true, window: "7d", limit: 50 });
    expect(within(rail).queryByText("今日热点")).not.toBeInTheDocument();
    expect(within(rail).queryByText("AI 一分钟")).not.toBeInTheDocument();
    // No finished issue named in the status: nothing to take the AI minute from, so nothing is asked.
    expect(client.listFrontierDailies).not.toHaveBeenCalled();
  });

  it("says so when the week's safety alerts could not be read, rather than looking empty", async () => {
    client.listFrontierItems.mockImplementation(async (query: FrontierItemsQuery) => {
      if (query.limit === 50) throw new WebApiError("down", { status: 503, code: null });
      return feed(query);
    });
    renderPage();
    expect(await screen.findByText("安全警示暂时读不到，刷新页面再试。")).toBeInTheDocument();
  });

  it("shows the top five and the AI minute once they exist", async () => {
    client.fetchFrontierHot.mockResolvedValue(Array.from({ length: 7 }, (_, index) => ({
      rank: index + 1, id: `ev${index + 1}`, title: `热点事件 ${index + 1}`, latest: null,
      sourceCount72h: 6, reportCount: 9, primary: index === 0 ? "paper" : null, lastAt: ago(1), status: "developing" as const,
    })));
    client.fetchFrontierStatus.mockResolvedValue(status({ lastDailyDay: "2026-09-21" }));
    client.listFrontierDailies.mockResolvedValue([{ day: "2026-09-21", title: "头条", itemCount: 18, generatedAt: ago(5) }]);
    client.fetchFrontierDaily.mockResolvedValue({
      day: "2026-09-21", windowStart: ago(29), windowEnd: ago(5), generatedAt: ago(5), lead: null,
      sections: [], safety: [], aiMinute: "今天 AI 圈有 3 件事和你有关。", markdown: "# 日报", itemCount: 18,
    });
    renderPage();
    const rail = await screen.findByRole("complementary", { name: "侧栏" });
    expect(await within(rail).findByText("今天 AI 圈有 3 件事和你有关。")).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "热点事件 1" })).toHaveAttribute("href", "/app/frontier/events/ev1");
    expect(within(rail).queryByRole("link", { name: "热点事件 6" })).not.toBeInTheDocument();
    expect(within(rail).getByText("6 个来源 · 含原始论文")).toBeInTheDocument();
  });
});

describe("热点 and 日报", () => {
  it("say honestly that they are still being prepared where the server has neither", async () => {
    renderPage("/app/frontier?view=hot");
    expect(await screen.findByText("热点还在准备")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "日报" }));
    expect(await screen.findByText("日报还在准备")).toBeInTheDocument();
  });

  it("list the hot events with their three quantities, each opening its event page", async () => {
    client.fetchFrontierHot.mockResolvedValue([{
      rank: 1, id: "ev1", title: "FDA 批准首个皮下注射的阿尔茨海默病抗体", latest: "企业公布了患者支持计划",
      sourceCount72h: 7, reportCount: 9, primary: "official", lastAt: ago(1), status: "developing",
    }]);
    renderPage("/app/frontier?view=hot");
    const list = await screen.findByRole("list", { name: "热点" });
    expect(within(list).getByRole("link", { name: "FDA 批准首个皮下注射的阿尔茨海默病抗体" })).toHaveAttribute("href", "/app/frontier/events/ev1");
    expect(list).toHaveTextContent("近 72 小时 7 个来源 · 累计 9 篇报道 · 含官方公告");
  });

  it("open the issue a notification names, and copy it as Markdown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    client.listFrontierDailies.mockResolvedValue([
      { day: "2026-09-21", title: "口服 PCSK9 抑制剂拿到硬终点证据", itemCount: 18, generatedAt: ago(5) },
      { day: "2026-09-20", title: "FDA 批准皮下注射阿尔茨海默病抗体", itemCount: 9, generatedAt: ago(29) },
    ]);
    client.fetchFrontierDaily.mockImplementation(async (day: string) => ({
      day, windowStart: ago(53), windowEnd: ago(29), generatedAt: ago(28),
      lead: { item: frontierItem({ id: "lead", title: "FDA 批准皮下注射阿尔茨海默病抗体" }), text: "批准依据为一项桥接研究。", event: { id: "ev1", title: "x" } },
      sections: [{ lane: "evidence", laneLabel: "临床证据", items: [today] }],
      safety: [alert], aiMinute: null, markdown: `# EviMed 医学前沿日报 ${day}`, itemCount: 9,
    }));
    renderPage("/app/frontier?view=daily&day=2026-09-20");
    expect(await screen.findByRole("heading", { name: "头条：FDA 批准皮下注射阿尔茨海默病抗体" })).toBeInTheDocument();
    expect(client.fetchFrontierDaily).toHaveBeenCalledWith("2026-09-20");
    expect(screen.getByRole("heading", { name: "临床证据 · 1 条" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "安全警示" })).toHaveTextContent("氟喹诺酮类说明书修订");
    await userEvent.click(screen.getByRole("button", { name: "复制为 Markdown" }));
    expect(writeText).toHaveBeenCalledWith("# EviMed 医学前沿日报 2026-09-20");
    const archive = screen.getByRole("complementary", { name: "侧栏" });
    await userEvent.click(within(archive).getByRole("button", { name: "口服 PCSK9 抑制剂拿到硬终点证据" }));
    await waitFor(() => expect(client.fetchFrontierDaily).toHaveBeenLastCalledWith("2026-09-21"));
  });
});

describe("the sources", () => {
  it("are read only when the reader opens the list, grouped by lane", async () => {
    client.fetchFrontierSources.mockResolvedValue({
      mirroredAt: ago(1), counts: { planned: 486 },
      sources: [
        { id: "nejm", name: "NEJM", homepage: "https://www.nejm.org", lane: "evidence", laneLabel: "临床证据", sourceType: "journal", sourceTypeLabel: "期刊", access: "crossref-issn", health: "healthy", healthLabel: "正常", lastOkAt: ago(2), lastNewEntryAt: ago(2), entries7d: 40, enabled: true, retired: false },
        { id: "fda-recalls", name: "openFDA 召回", homepage: null, lane: "safety", laneLabel: "药物安全", sourceType: "regulator", sourceTypeLabel: "监管", access: "json-api", health: "unreadable", healthLabel: "暂时读不到", lastOkAt: null, lastNewEntryAt: null, entries7d: 0, enabled: true, retired: false },
        { id: "nmpa", name: "国家药监局", homepage: null, lane: "regulatory", laneLabel: "审批监管", sourceType: "regulator", sourceTypeLabel: "监管", access: "browser-list", health: "disabled", healthLabel: "已停用", lastOkAt: null, lastNewEntryAt: null, entries7d: 0, enabled: false, retired: false },
      ],
    });
    renderPage();
    await screen.findByText("今天的一条 RCT");
    expect(client.fetchFrontierSources).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("我们在读哪些信源"));
    expect(await screen.findByRole("heading", { name: "临床证据 1 个" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "药物安全 1 个" })).toBeInTheDocument();
    expect(screen.queryByText("国家药监局")).not.toBeInTheDocument();
    expect(screen.getByText("Crossref 期刊接口")).toBeInTheDocument();
    expect(screen.getByText("暂时读不到")).toBeInTheDocument();
    expect(screen.getByText("还没读到")).toBeInTheDocument();
    expect(screen.getByText("另有 486 个信源在接入中。")).toBeInTheDocument();
  });
});

describe("no score is ever on the page", () => {
  it("renders levels in words only, even from items that carry numbers", async () => {
    // The fixture items carry scoreTotal 87 and scores 29 / 17 / 13; day precision keeps
    // relative hours out of the text this reads.
    const day = { publishedAt: ago(30), datePrecision: "day" };
    feed = async () => page([frontierItem({ ...day, id: "s1", title: "第一条动态" }), frontierItem({ ...day, id: "s2", title: "另一条", timelineAt: ago(2) })]);
    client.fetchFrontierStatus.mockResolvedValue(status({ sources: { total: 0, enabled: 0, healthy: 0, degraded: 0, unreadable: 0, drifted: 0, planned: 0 } }));
    renderPage();
    for (const card of await screen.findAllByRole("article")) {
      await userEvent.click(within(card).getByText("为什么入选"));
      expect(within(card).getByRole("list", { name: "四个维度" })).toHaveTextContent("来源权威 高");
      for (const score of ["87", "29", "17", "13", "分"]) expect(card.textContent).not.toContain(score);
    }
  });
});
