import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { parseFrontierTopic, type FrontierTopicPage as TopicPageData, type FrontierTopicSummary } from "@/lib/frontierClient";
import { frontierItem } from "@/components/frontier/__fixtures__/frontierItems";
import { HotBoard, HotCard, HotTopics } from "@/components/frontier/FrontierHot";
import { FrontierTopicPage, overviewParts } from "./FrontierTopicPage";

const client = vi.hoisted(() => ({ useFrontierFeature: vi.fn(), fetchFrontierTopic: vi.fn(), fetchFrontierTopics: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  ...client,
}));

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

function topic(overrides: Partial<FrontierTopicSummary> = {}): FrontierTopicSummary {
  return {
    id: "a1b2c3d4e5f6a7b8",
    title: "运动会诱发心源性猝死吗？风险有多大",
    question: "健康成年人跑步等运动时发生心源性猝死的风险有多大，谁需要先做检查？",
    peg: { text: "据其公司讣告，一位知名教育博主于3月24日因心源性猝死离世。", source: { name: "微博热搜", url: "https://s.weibo.com/weibo?q=x", date: "2026-03-24" } },
    domain: "public-figure", domainLabel: "公众人物", surge: true,
    firstSeenAt: ago(5), acceptedAt: ago(4), status: "active", itemCount: 3,
    overview: { text: "长跑比赛中心脏骤停的发生率约为每10万名参赛者0.60例[1]，胸痛时应及时就医[2]，[9]不是引用。",
      refs: [{ n: 1, itemId: "p1", title: "长跑比赛中的心脏骤停", sourceName: "JAMA" }, { n: 2, itemId: "r1", title: "猝死前身体的3个求救信号", sourceName: "健康时报" }] },
    ...overrides,
  };
}

function page(overrides: Partial<TopicPageData> = {}): TopicPageData {
  return {
    topic: topic(),
    items: [
      { role: "report", item: frontierItem({ id: "r1", title: "猝死前身体的3个求救信号", source: { id: "jksb", name: "健康时报" } }) },
      { role: "evidence", item: frontierItem({ id: "p1", title: "Cardiac Arrest During Long-Distance Running Races", source: { id: "jama", name: "JAMA" } }) },
      { role: "background", item: frontierItem({ id: "b1", title: "中国心脏骤停与心肺复苏报告", source: { id: "x", name: "中华医学杂志" } }) },
    ],
    ...overrides,
  };
}

function Probe() {
  const location = useLocation();
  const intent = (location.state as { runtimeUiIntent?: { draft?: string; originReference?: unknown } } | null)?.runtimeUiIntent;
  return <div data-testid="location" data-origin={intent?.originReference ? "yes" : undefined} data-draft={intent?.draft}>{location.pathname}</div>;
}

function renderTopic(id = "a1b2c3d4e5f6a7b8") {
  return render(
    <MemoryRouter initialEntries={[`/app/frontier/topics/${id}`]}>
      <Routes>
        <Route path="/app/frontier/topics/:topicId" element={<FrontierTopicPage />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  client.useFrontierFeature.mockReset().mockReturnValue("on");
  client.fetchFrontierTopic.mockReset().mockResolvedValue(page());
  client.fetchFrontierTopics.mockReset().mockResolvedValue([topic()]);
});

describe("a topic page", () => {
  it("offers 就此提问: the topic's question in the composer as a draft, the topic named under it, and no origin (a topic is not an item the assistant reads)", async () => {
    renderTopic();
    await userEvent.click(await screen.findByRole("button", { name: "就此提问" }));
    const where = screen.getByTestId("location");
    expect(where).toHaveTextContent("/app/chat");
    expect(where.getAttribute("data-draft")).toBe("健康成年人跑步等运动时发生心源性猝死的风险有多大，谁需要先做检查？\n\n前沿动态热点话题：“运动会诱发心源性猝死吗？风险有多大”");
    expect(where).not.toHaveAttribute("data-origin");
  });

  it("heads the page with the question, the field and the way back; the event is one attributed line", async () => {
    renderTopic();
    expect(await screen.findByRole("heading", { level: 1, name: "运动会诱发心源性猝死吗？风险有多大" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前沿动态" })).toHaveAttribute("href", "/app/frontier?view=hot");
    expect(screen.getByText("公众人物")).toHaveClass("rounded-tag");
    expect(screen.getByText("据其公司讣告，一位知名教育博主于3月24日因心源性猝死离世。").closest("figure")).toHaveTextContent("微博热搜 · 2026-03-24");
    expect(screen.getByRole("link", { name: /微博热搜/ })).toHaveAttribute("href", "https://s.weibo.com/weibo?q=x");
    expect(screen.queryByRole("link", { name: "查看证据卡片" })).toBeNull();
    // No back office: how it was made, run states, budgets.
    for (const gone of ["AI 生成于", "运行", "预算", "热榜第", "subject"]) expect(document.body).not.toHaveTextContent(gone);
  });

  it("labels the overview like the items' AI blocks, each mark a link to the item it cites, and lists what it cites", async () => {
    renderTopic();
    const overview = await screen.findByRole("region", { name: "AI 概览" });
    expect(within(overview).getByRole("heading", { name: "AI 概览" })).toHaveClass("text-accent");
    const [mark, row] = within(overview).getAllByRole("link", { name: /长跑比赛中的心脏骤停/ });
    expect(mark).toHaveTextContent("[1]");
    expect(mark).toHaveAttribute("href", "/app/frontier/items/p1");
    expect(row).toHaveAttribute("href", "/app/frontier/items/p1");
    expect(overview).toHaveTextContent("[9]不是引用");
    const cited = within(overview).getByRole("list", { name: "概览引用的报道与研究" });
    expect(within(cited).getAllByRole("listitem")).toHaveLength(2);
  });

  it("groups the items 各方报道 · 研究证据 · 背景资料 as the feed's cards", async () => {
    renderTopic();
    for (const name of ["各方报道", "研究证据", "背景资料"]) expect(await screen.findByRole("heading", { level: 2, name })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "研究证据" })).toHaveTextContent("Cardiac Arrest During Long-Distance Running Races");
  });

  it("says a topic with nothing gathered yet in one sentence, its way on a link underlined like the reader's in-text links", async () => {
    client.fetchFrontierTopic.mockResolvedValue(page({ items: [], topic: topic({ overview: null, itemCount: 0 }) }));
    renderTopic();
    const link = await screen.findByRole("link", { name: "看全部动态" });
    expect(link.parentElement).toHaveTextContent("暂无报道与研究。看全部动态");
    expect(link).toHaveAttribute("href", "/app/frontier?view=all");
    // Told from the words around it by more than its colour (WCAG 1.4.1): axe's link-in-text-block on the release walk of
    // evimed-5ae53861dc26-1.
    expect(link).toHaveClass("underline");
    expect(link.className).not.toMatch(/(?:^|\s)hover:underline(?:\s|$)/);
  });

  it("says a missing topic is gone, with the way to 热榜", async () => {
    client.fetchFrontierTopic.mockRejectedValue(new WebApiError("gone", { status: 404, code: "frontier_topic_not_found" }));
    renderTopic("zzzzzzzzzzzzzzzz");
    expect(await screen.findByRole("heading", { level: 1, name: "这个话题已不存在" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看热榜" })).toHaveAttribute("href", "/app/frontier?view=hot");
  });
});

describe("热点话题 in 热榜 and 当前热点", () => {
  it("lists each topic as its question, its field, the event in one line, the count and the time, the whole title a link", () => {
    render(<MemoryRouter><HotTopics topics={[topic(), topic({ id: "b1b2c3d4e5f6a7b8", title: "高温中暑如何识别和急救", peg: null, surge: false, domainLabel: "环境气候", itemCount: 0 })]} /></MemoryRouter>);
    const rows = within(screen.getByRole("list", { name: "热搜里的健康问题" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole("link", { name: "运动会诱发心源性猝死吗？风险有多大" })).toHaveAttribute("href", "/app/frontier/topics/a1b2c3d4e5f6a7b8");
    expect(rows[0]).toHaveTextContent("公众人物3 篇");
    expect(within(rows[0]).getByText(/^据其公司讣告/)).toHaveClass("truncate");
    expect(rows[0]).toHaveTextContent("3 篇");
    expect(rows[1]).not.toHaveTextContent("篇");
  });

  it("draws nothing when no topic is active", () => {
    const { container } = render(<MemoryRouter><HotTopics topics={[]} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });

  it("sits under 热榜's current ranking, which stands first as 「医学热点」 with its count, and not under a week's (owner, 2026-10-27)", async () => {
    const events = [{ rank: 1, id: "ev1", title: "某事件", latest: null, sourceCount72h: 4, reportCount: 5, primary: null, hasPrimary: false,
      firstAt: ago(30), lastAt: ago(3), status: "developing" as const, heat: 30, rankChange: null, badge: null, trend: null, period: null }];
    const { unmount } = render(<MemoryRouter><HotBoard state={{ board: { window: "current", takenAt: ago(0.2), since: ago(72), events }, error: null }} onRetry={vi.fn()} /></MemoryRouter>);
    const topics = await screen.findByRole("list", { name: "热搜里的健康问题" });
    const ranking = screen.getByRole("list", { name: "热榜" });
    expect(ranking.compareDocumentPosition(topics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Two headed sections, the ranking's first: the same Section component, the heading with its count.
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["医学热点", "热搜里的健康问题"]);
    expect(screen.getByRole("region", { name: "医学热点" })).toContainElement(ranking);
    expect(screen.getByRole("region", { name: "医学热点" })).toHaveTextContent("医学热点1");
    expect(screen.queryByRole("heading", { name: /^热点话题/ })).toBeNull();
    unmount();
    render(<MemoryRouter><HotBoard state={{ board: { window: "week", takenAt: ago(0.2), since: ago(168), events }, error: null }} onRetry={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(client.fetchFrontierTopics).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("list", { name: "热搜里的健康问题" })).toBeNull();
    // A week's ranking is the ranking alone, as it was.
    expect(screen.getByRole("list", { name: "热榜" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /医学热点/ })).toBeNull();
  });

  it("lets one active surge topic lead 当前热点, two events after it", async () => {
    const events = [1, 2, 3].map((rank) => ({ rank, id: `ev${rank}`, title: `事件 ${rank}`, latest: null, sourceCount72h: 4, reportCount: 5, primary: null, hasPrimary: false,
      firstAt: ago(30), lastAt: ago(3), status: "developing" as const, heat: 30, rankChange: null, badge: null, trend: null, period: null }));
    render(<MemoryRouter><HotCard events={events} onOpenAll={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByRole("link", { name: /运动会诱发心源性猝死吗/ })).toHaveAttribute("href", "/app/frontier/topics/a1b2c3d4e5f6a7b8");
    const rows = within(screen.getByRole("list", { name: "当前热点" })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("运动会诱发心源性猝死吗？风险有多大话题");
    expect(within(rows[0]).getByText("话题").closest("a")).toBeNull();
  });
});

describe("the client's reading of a topic", () => {
  it("keeps the contract's fields, reads no card (the platform writes none) and never reads a name field", () => {
    const parsed = parseFrontierTopic({ ...topic(), subjectNames: ["某人"], card: { id: "ec_1", title: "t", href: "/app/frontier/zones/x" } });
    expect(parsed).not.toHaveProperty("card");
    expect(JSON.stringify(parsed)).not.toContain("某人");
    expect(parseFrontierTopic({ id: "BAD", title: "t" })).toBeNull();
    expect(parseFrontierTopic({ ...topic(), peg: { text: "据讣告…", source: { name: "微博热搜", url: "javascript:alert(1)", date: null } } })?.peg?.source.url).toBeNull();
  });

  it("reads the overview's marks as citations only where a ref names them", () => {
    const parts = overviewParts("a[1]b[3]c", [{ n: 1, itemId: "x", title: "t", sourceName: "s" }]);
    expect(parts).toEqual(["a", { n: 1, itemId: "x", title: "t", sourceName: "s" }, "b[3]c"]);
  });
});
