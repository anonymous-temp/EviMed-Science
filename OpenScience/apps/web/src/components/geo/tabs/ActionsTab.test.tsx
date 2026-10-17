import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoArticle, GeoProject } from "@/lib/geoClient";
import { distributionFilled, geoProject, monitoringFilled } from "../__fixtures__/geoTabs";
import {
  ACTION_BRAND,
  ACTION_EFFECT,
  ACTION_PROJECT,
  ACTION_SAFETY,
  actionFixture,
  actionsFilled,
  clustersFilled,
  clusterViewFixture,
  G_BRAND,
  G_CONTROL,
  G_EFFECT,
  G_SAFETY,
} from "../__fixtures__/geoSpine";
import { GeoFrameHarness } from "../__fixtures__/geoFrameHarness";
import { ActionsTab } from "./ActionsTab";

const client = vi.hoisted(() => ({
  getGeoActions: vi.fn(),
  getGeoClusters: vi.fn(),
  getGeoCluster: vi.fn(),
  skipGeoAction: vi.fn(),
  chooseGeoActionSource: vi.fn(),
  createGeoOwnedLink: vi.fn(),
  getGeoArticles: vi.fn(),
  getGeoArticleText: vi.fn(),
  withdrawGeoArticle: vi.fn(),
  releaseGeoArticle: vi.fn(),
  getGeoDistribution: vi.fn(),
  cancelGeoOrder: vi.fn(),
  getGeoMonitoring: vi.fn(),
  runGeoStep: vi.fn(),
  unmeasureGeoQuestion: vi.fn(),
}));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  ...client,
}));

const store = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_geo_1" }], select: store.select, load: store.load }) },
}));

const conversation = vi.hoisted(() => ({ open: vi.fn(async () => true) }));
vi.mock("../useOpenGeoConversation", () => ({ useOpenGeoConversation: () => conversation.open }));

function Probe() {
  const location = useLocation();
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <div data-testid="search">{location.search}</div>
    </>
  );
}

const openPanel = vi.fn();

function renderTab(project: GeoProject = geoProject(), path = "/app/geo/geo_1/actions") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/app/geo/geo_1/actions"
          element={<><GeoFrameHarness project={project} tab="actions" openPanel={openPanel}><ActionsTab geoId="geo_1" project={project} /></GeoFrameHarness><Probe /></>}
        />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function article(id: string, overrides: Partial<GeoArticle> = {}): GeoArticle {
  return {
    id, layer: "popular", title: `稿件 ${id}`, groupId: null, question: null, status: "draft", gate: "passed", safety: "clear",
    path: `articles/${id}.md`, runId: "run_1", claimCount: 2, placements: 0, cited: false, ...overrides,
  };
}

const ARTICLES: GeoArticle[] = [
  article("art_effect", { title: "适应症与疗程说明稿", layer: "deep", groupId: G_EFFECT, channel: "zhihu" }),
  article("art_safety", { title: "禁忌与必须就医的情形", groupId: G_SAFETY, status: "published", cited: true, channel: "wechat_mp" }),
  article("art_project", { title: "产品说明总稿", layer: "deep", groupId: null, status: "publishable", channel: "wechat_mp" }),
  article("art_held", { title: "合并 2 型糖尿病的人能不能用？", layer: "card", groupId: G_BRAND, safety: "open" }),
  article("art_orphan", { title: "停药后体重会反弹吗？", layer: "qa", groupId: G_CONTROL, groupIsControl: true }),
];

/** The page's row for an action, or null; `findRow` waits for it. */
const rowOf = (key: string): HTMLElement | null => ([...document.querySelectorAll("[data-geo-action]")].find((node) => node.getAttribute("data-geo-action") === key) as HTMLElement | undefined) ?? null;
const findRow = (key: string) => waitFor(() => {
  const row = rowOf(key);
  if (!row) throw new Error(`no row for ${key}`);
  return row;
});

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  conversation.open.mockClear();
  openPanel.mockClear();
  store.select.mockClear();
  const project = actionsFilled;
  client.getGeoActions.mockResolvedValue(project);
  client.getGeoClusters.mockResolvedValue(clustersFilled);
  client.getGeoCluster.mockImplementation(async (_geoId: string, id: string) => clusterViewFixture(id));
  client.getGeoArticles.mockResolvedValue({
    articles: ARTICLES.map((entry) => (entry.id === "art_effect" ? { ...entry } : entry)),
  });
  client.getGeoDistribution.mockResolvedValue({ ...distributionFilled, market: { configured: false }, budget: null, orders: [], ownedLinks: [] });
  client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
  client.skipGeoAction.mockResolvedValue({ key: "x", skipped: true, sourceDomain: null, updatedAt: null, cleared: false });
  client.chooseGeoActionSource.mockResolvedValue({ key: "x", skipped: false, sourceDomain: null, updatedAt: null, cleared: true });
  client.createGeoOwnedLink.mockResolvedValue({ id: "gol_9", registered: ["gol_9"], notices: [] });
  client.runGeoStep.mockResolvedValue({ sessionId: "ses_geo_1" });
  client.releaseGeoArticle.mockResolvedValue({});
  client.withdrawGeoArticle.mockResolvedValue({});
  client.cancelGeoOrder.mockResolvedValue({});
});

describe("行动: the lead", () => {
  it("says the arms' verdict and how many groups still wait, and each figure opens what it counts", async () => {
    renderTab();
    const lead = await screen.findByRole("heading", { name: /已行动的问句群比对照多涨/ });
    expect(lead).toHaveTextContent("已行动的问句群比对照多涨 4.2 个点（波动 ±3）；另有 2 个群的缺口还没有行动");
    // The figure of the groups waiting narrows the list to exactly those groups' actions.
    await userEvent.click(within(lead).getByRole("button", { name: "2" }));
    expect(rowOf(ACTION_BRAND.key)).toBeInTheDocument();
    expect(rowOf(ACTION_EFFECT.key)).toBeInTheDocument();
    expect(rowOf(ACTION_SAFETY.key)).toBeNull();
    // …and the toolbar says so, and lets go of it.
    await userEvent.click(screen.getByRole("button", { name: "只看还没行动的群 ×" }));
    expect(rowOf(ACTION_SAFETY.key)).toBeInTheDocument();
  });

  it("draws the picture of the two arms, and leaves an empty frame out where nothing was measured", async () => {
    renderTab();
    await screen.findByRole("heading", { name: /已行动的问句群/ });
    expect(document.querySelector("[data-chart='net-effect']")).not.toBeNull();
    client.getGeoMonitoring.mockResolvedValue({ ...monitoringFilled, arms: { ...monitoringFilled.arms, pilot: [], control: [] } });
    const second = renderTab();
    await waitFor(() => expect(within(second.container).getByText("首批稿件上线后，这里会把投放的问题群和对照组放在一起比。")).toBeInTheDocument());
  });
});

describe("行动: the list is by question group", () => {
  it("keeps the run's order, gives a group with two actions a heading, and names the project's own block 全项目", async () => {
    renderTab();
    await findRow(ACTION_BRAND.key);
    const blocks = [...document.querySelectorAll("[data-geo-cluster-block]")].map((node) => node.getAttribute("data-geo-cluster-block"));
    expect(blocks).toEqual([G_BRAND, G_EFFECT, G_SAFETY, "-"].sort((a, b) => [G_BRAND, G_EFFECT, G_SAFETY, "-"].indexOf(a) - [G_BRAND, G_EFFECT, G_SAFETY, "-"].indexOf(b)));
    // The effect group has two actions (one written, one set aside): its heading says how many.
    const effect = document.querySelector(`[data-geo-cluster-block="${G_EFFECT}"]`) as HTMLElement;
    expect(within(effect).getByText("2 条行动")).toBeInTheDocument();
    expect(within(effect).getAllByRole("listitem")).toHaveLength(2);
    // A project-level action has no group to open: its name is text, not a link.
    const project = await findRow(ACTION_PROJECT.key);
    expect(within(project).getByText("全项目")).toBeInTheDocument();
    expect(within(project).queryByRole("link", { name: "全项目" })).not.toBeInTheDocument();
  });

  it("gives every group's name as a link that opens the same drawer over the page, and the address says so", async () => {
    renderTab();
    const brand = await findRow(ACTION_BRAND.key);
    await userEvent.click(within(brand).getByRole("link", { name: "品牌身份、规格与厂家" }));
    expect(screen.getByTestId("search")).toHaveTextContent(`?group=${G_BRAND}`);
    const drawer = await screen.findByRole("dialog", { name: "品牌身份、规格与厂家" });
    // The counts of what the engines said, and the wrong one marked; a thin group has no percentage anywhere.
    expect(within(drawer).getByText("信尔美是什么药？")).toBeInTheDocument();
    expect(within(drawer).getByText("11/12")).toBeInTheDocument();
    expect(drawer.textContent).not.toMatch(/92%|91\.7/);
    // The list is where it was; closing takes the parameter out of the address.
    await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("search")).toHaveTextContent("");
  });
});

describe("行动: one row", () => {
  it("says what to do, what is written for it, the lead source with its conditions, and what is expected — counts, never a withheld rate", async () => {
    renderTab();
    const row = await findRow(ACTION_BRAND.key);
    await within(row).findByText("纠正讲错");
    expect(row).toHaveTextContent("把信尔美说成需要每天注射一次");
    expect(within(row).getByText(/订正稿件|纠错材料|针对 DeepSeek、豆包/)).toBeInTheDocument();
    // The lead source, the three conditions holding, the others as a count, and where it goes while there is no market.
    expect(within(row).getByText("丁香园")).toBeInTheDocument();
    expect(within(row).getByText("三项条件满足")).toBeInTheDocument();
    expect(within(row).getByText("+2")).toBeInTheDocument();
    expect(within(row).getByText("等媒介集市接通")).toBeInTheDocument();
    // Accuracy read over 12 answers: the counts and the word for a thin sample; the target is the pool's number.
    expect(row).toHaveTextContent("事实准确率 11/12");
    expect(row).toHaveTextContent("样本不足");
    expect(row).toHaveTextContent("池目标 98%");
    expect(row.textContent).not.toMatch(/92%|91\.7/);
  });

  it("a group already at its pool's target says so, with the rate the server sent, and what is left to close", async () => {
    renderTab();
    const row = await findRow(ACTION_SAFETY.key);
    expect(within(row).getByText(/补上缺口 · 只讲获益不讲安全/)).toBeInTheDocument();
    expect(row).toHaveTextContent("已达池目标 58%");
    expect(row).toHaveTextContent("关闭 1 条严重讲错");
    expect(within(row).getByText("已发布")).toBeInTheDocument();
  });

  it("marks a source the person chose, and has 打开稿件 only where there is an article to open", async () => {
    renderTab();
    const safety = await findRow(ACTION_SAFETY.key);
    await within(safety).findByText("科普中国");
    expect(within(safety).getByRole("button", { name: "打开稿件" })).toBeInTheDocument();
    // Nothing is written for the brand's correction yet: no button that would open nothing.
    expect(within(await findRow(ACTION_BRAND.key)).queryByRole("button", { name: "打开稿件" })).not.toBeInTheDocument();
    await userEvent.click(within(safety).getByRole("button", { name: "打开稿件" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/runs/run_1/files/articles/art_safety.md"));
    expect(store.select).toHaveBeenCalledWith("prj_geo_1", expect.any(Function));
  });

  it("sets an action aside and takes it back, from the row's own ⋯, and says so", async () => {
    renderTab();
    const row = await findRow(ACTION_BRAND.key);
    await userEvent.click(await within(row).findByRole("button", { name: /这条行动的更多操作/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "跳过这条行动" }));
    await waitFor(() => expect(client.skipGeoAction).toHaveBeenCalledWith("geo_1", ACTION_BRAND.key, true));
    const skipped = await findRow(actionsFilled.actions[4].key);
    await userEvent.click(within(skipped).getByRole("button", { name: /这条行动的更多操作/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "恢复这条行动" }));
    await waitFor(() => expect(client.skipGeoAction).toHaveBeenCalledWith("geo_1", actionsFilled.actions[4].key, false));
  });

  it("sends an action to another source from the row, and back to the recommendation", async () => {
    renderTab();
    const brand = await findRow(ACTION_BRAND.key);
    await userEvent.click(await within(brand).findByRole("button", { name: "换信源" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "好大夫在线" }));
    await waitFor(() => expect(client.chooseGeoActionSource).toHaveBeenCalledWith("geo_1", ACTION_BRAND.key, "haodf.com"));
    // A source the person already chose offers the way back.
    const safety = await findRow(ACTION_SAFETY.key);
    await userEvent.click(within(safety).getByRole("button", { name: "换信源" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "恢复推荐" }));
    await waitFor(() => expect(client.chooseGeoActionSource).toHaveBeenCalledWith("geo_1", ACTION_SAFETY.key, null));
  });

  it("asks the project's conversation to rewrite, in a fresh conversation, with a draft and nothing sent", async () => {
    renderTab();
    const row = await findRow(ACTION_EFFECT.key);
    await userEvent.click(await within(row).findByRole("button", { name: /这条行动的更多操作/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "让 AI 重写" }));
    await waitFor(() => expect(conversation.open).toHaveBeenCalled());
    const [target, draft] = conversation.open.mock.calls[0] as unknown as [{ projectId: string; sessionId: string | null }, string];
    expect(target).toEqual({ projectId: "prj_geo_1", sessionId: null });
    expect(draft).toContain("效果怎么样、要打多久");
  });
});

describe("行动: the toolbar", () => {
  it("is the band's: a chip for each stage anyone is in, with its count, and none for a stage nobody is in", async () => {
    renderTab();
    await findRow(ACTION_BRAND.key);
    const group = screen.getByRole("group", { name: "进展" });
    expect(within(group).getByRole("button", { name: /全部/ })).toHaveTextContent("5");
    expect(within(group).getByRole("button", { name: /待写/ })).toHaveTextContent("3");
    expect(within(group).getByRole("button", { name: /已发/ })).toHaveTextContent("1");
    expect(within(group).getByRole("button", { name: /已跳过/ })).toHaveTextContent("1");
    expect(within(group).queryByRole("button", { name: /待发/ })).not.toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: /被引/ })).not.toBeInTheDocument();
    // Nothing that filters is drawn under the list.
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    const list = document.querySelector("[data-geo-actions]") as HTMLElement;
    expect(toolbar.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("narrows by stage and keeps it in the address; a search finds an action by the group, the article or a source", async () => {
    renderTab();
    await findRow(ACTION_BRAND.key);
    await userEvent.click(within(screen.getByRole("group", { name: "进展" })).getByRole("button", { name: /已发/ }));
    expect(screen.getByTestId("search")).toHaveTextContent("?show=live");
    expect(rowOf(ACTION_SAFETY.key)).toBeInTheDocument();
    expect(rowOf(ACTION_BRAND.key)).toBeNull();
    await userEvent.click(within(screen.getByRole("group", { name: "进展" })).getByRole("button", { name: /全部/ }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索行动" }), "丁香园");
    expect(rowOf(ACTION_BRAND.key)).toBeInTheDocument();
    expect(rowOf(ACTION_EFFECT.key)).toBeInTheDocument();
    expect(rowOf(ACTION_SAFETY.key)).toBeNull();
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索行动" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索行动" }), "没有这个词");
    expect(await screen.findByText("没有符合的行动。")).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("region", { name: "行动" })).getByRole("button", { name: "清除筛选" }));
    expect(rowOf(ACTION_BRAND.key)).toBeInTheDocument();
  });
});

describe("行动: letting go", () => {
  it("lets go of the stage and the group in one step, whichever the address carried", async () => {
    renderTab(geoProject(), `/app/geo/geo_1/actions?show=live&cluster=${G_SAFETY}`);
    await findRow(ACTION_SAFETY.key);
    await userEvent.click(within(document.querySelector("[data-toolbar]") as HTMLElement).getByRole("button", { name: "清除筛选" }));
    const search = screen.getByTestId("search").textContent ?? "";
    expect(search).not.toContain("show=");
    expect(search).not.toContain("cluster=");
    expect(rowOf(ACTION_BRAND.key)).toBeInTheDocument();
  });
});

describe("行动: the action's drawer", () => {
  it("opens from the row with the questions, the gap and what an answer must say, the article, the ranked sources and what is expected", async () => {
    renderTab();
    await userEvent.click(await within(await findRow(ACTION_BRAND.key)).findByRole("button", { name: /纠正讲错/ }));
    expect(screen.getByTestId("search")).toHaveTextContent(`?action=${encodeURIComponent(ACTION_BRAND.key)}`);
    const drawer = await screen.findByRole("dialog", { name: "纠正讲错" });
    // Questions with what each engine's latest answer did.
    expect(await within(drawer).findByText("信尔美是什么药？")).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: /DeepSeek：讲错了，看回答/ })).toHaveAttribute("href", "/app/geo/geo_1/answers/s_3");
    // The gap, in the run's words, and what an answer must say.
    expect(within(drawer).getByText(/三个引擎里有一个把用法说成每天注射一次/)).toBeInTheDocument();
    expect(within(drawer).getByText("信尔美为每周一次皮下注射给药。")).toBeInTheDocument();
    // Sources ranked, each with why; the three conditions where they are known.
    const sources = within(drawer).getByRole("list", { name: "推荐的信源" });
    expect(within(sources).getAllByRole("listitem")).toHaveLength(3);
    expect(within(sources).getByText("医疗垂直站，规格与厂家口径的规范文本落点")).toBeInTheDocument();
    expect(within(sources).getByText("✓ 三项条件满足")).toBeInTheDocument();
    expect(within(sources).getByText(/现在投不了：不接医疗稿/)).toBeInTheDocument();
    // Expected, as counts; the sample's word beside it.
    expect(within(drawer).getByText(/事实准确率 11\/12/)).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
    expect(screen.getByTestId("search")).toHaveTextContent("");
  });

  it("swaps a source from its row in the drawer, and goes back to the recommendation", async () => {
    renderTab(geoProject(), `/app/geo/geo_1/actions?action=${encodeURIComponent(ACTION_SAFETY.key)}`);
    const drawer = await screen.findByRole("dialog", { name: "补上缺口 · 只讲获益不讲安全" });
    const sources = within(drawer).getByRole("list", { name: "推荐的信源" });
    const chosen = within(sources).getByText("科普中国").closest("li") as HTMLElement;
    expect(within(chosen).getByText("你换的")).toBeInTheDocument();
    await userEvent.click(within(chosen).getByRole("button", { name: "恢复推荐" }));
    await waitFor(() => expect(client.chooseGeoActionSource).toHaveBeenCalledWith("geo_1", ACTION_SAFETY.key, null));
  });

  it("for the brand's own channel, copies the article and registers the page's address with the article it is", async () => {
    client.getGeoArticleText.mockResolvedValue({ articleId: "art_project", layer: "deep", aiGenerated: true, markdown: "# 产品说明总稿\n\n正文" });
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    renderTab(geoProject(), `/app/geo/geo_1/actions?action=${encodeURIComponent(ACTION_PROJECT.key)}`);
    const drawer = await screen.findByRole("dialog", { name: "补上缺口 · 信源弱" });
    await userEvent.click(await within(drawer).findByRole("button", { name: "复制稿件" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("# 产品说明总稿\n\n正文"));
    await userEvent.click(within(drawer).getByRole("button", { name: "我已发布，贴链接" }));
    await userEvent.type(within(drawer).getByLabelText("发布后的页面链接"), "https://mp.weixin.qq.com/s/xyz");
    await userEvent.click(within(drawer).getByRole("button", { name: "登记" }));
    await waitFor(() => expect(client.createGeoOwnedLink).toHaveBeenCalledWith("geo_1", {
      url: "https://mp.weixin.qq.com/s/xyz",
      platform: "wechat_mp",
      articleId: "art_project",
    }));
  });

  it("opens the action's own conversation as a draft, never sent, in a fresh conversation", async () => {
    renderTab(geoProject(), `/app/geo/geo_1/actions?action=${encodeURIComponent(ACTION_EFFECT.key)}`);
    const drawer = await screen.findByRole("dialog", { name: "补上缺口 · 缺证据" });
    await userEvent.click(within(drawer).getByRole("button", { name: "在对话中调整" }));
    await waitFor(() => expect(conversation.open).toHaveBeenCalled());
    const [target, draft] = conversation.open.mock.calls[0] as unknown as [{ sessionId: string | null }, string];
    expect(target.sessionId).toBeNull();
    expect(draft).toContain("效果怎么样、要打多久");
    expect(draft).toContain("0/12");
  });

  it("says plainly when the action is no longer there, and leaves the way back", async () => {
    renderTab(geoProject(), `/app/geo/geo_1/actions?action=${encodeURIComponent("fill_gap:ggr_gone:wrong")}`);
    expect(await screen.findByRole("dialog", { name: "这条行动已经不在了" })).toBeInTheDocument();
  });
});

describe("行动: what stands apart from the actions", () => {
  it("holds the articles stopped for a safety finding at the top, 放行 after a person has looked", async () => {
    renderTab();
    const block = await screen.findByRole("region", { name: "等你放行的稿件" });
    expect(block).toHaveAttribute("id", "geo-review");
    expect(within(block).getByText("合并 2 型糖尿病的人能不能用？")).toBeInTheDocument();
    await userEvent.click(within(block).getByRole("button", { name: "放行" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "放行" }));
    await waitFor(() => expect(client.releaseGeoArticle).toHaveBeenCalledWith("geo_1", "art_held"));
  });

  it("lists the articles no action holds, so nothing a person wrote is out of sight, and 撤回 asks first", async () => {
    client.withdrawGeoArticle.mockResolvedValue({});
    renderTab();
    const other = await screen.findByRole("region", { name: "其他稿件" });
    await userEvent.click(within(other).getByText("其他稿件 1 篇"));
    expect(within(other).getByText("停药后体重会反弹吗？")).toBeInTheDocument();
    expect(within(other).getByText("对照群")).toBeInTheDocument();
    await userEvent.click(within(other).getByRole("button", { name: "撤回" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "撤回" }));
    await waitFor(() => expect(client.withdrawGeoArticle).toHaveBeenCalledWith("geo_1", "art_orphan"));
  });

  it("collapses the control groups: how many, and which one has already been written for", async () => {
    renderTab();
    const control = await screen.findByRole("region", { name: "对照组" });
    await userEvent.click(within(control).getByText("对照组 1 个，只监测"));
    expect(within(control).getByRole("link", { name: "对照一" })).toBeInTheDocument();
    expect(within(control).getByText("已写 1 篇，不再是对照")).toBeInTheDocument();
  });

  it("says what the evidence cards wait for and does it: the producer's panel, the reviewer's", async () => {
    renderTab(geoProject({}, { cards: { blockedBy: "producer" } }));
    await userEvent.click(await screen.findByRole("button", { name: "设置出品方" }));
    expect(openPanel).toHaveBeenCalledWith("producer");
    expect(screen.getByText("设置出品方后，已核实的结论会成为证据卡片。")).toBeInTheDocument();
  });

  it("shows the budget where a market is connected, with the way to change it, and nothing where none is", async () => {
    client.getGeoDistribution.mockResolvedValue(distributionFilled);
    renderTab(geoProject());
    const budget = await screen.findByRole("region", { name: "投放预算" });
    expect(budget).toHaveAttribute("id", "geo-budget");
    expect(budget).toHaveTextContent("预算 8,000 灵豆");
    await userEvent.click(within(budget).getByRole("button", { name: "修改" }));
    expect(openPanel).toHaveBeenCalledWith("budget");
  });

  it("draws no budget with no market, and no sentence about the market: each source says it for itself", async () => {
    renderTab(geoProject({}, { market: { configured: false } }));
    await findRow(ACTION_BRAND.key);
    expect(screen.queryByRole("region", { name: "投放预算" })).not.toBeInTheDocument();
    expect(screen.queryByText(/投放要等媒介集市接通/)).not.toBeInTheDocument();
  });
});

describe("行动: states", () => {
  it("is a recipe when there is nothing yet, with the one button that starts the step and keeps the person here", async () => {
    client.getGeoActions.mockResolvedValue({ ...actionsFilled, actions: [], control: [], counts: { total: 0, byKind: {}, byStatus: {}, gapsWithoutEntry: 0 } });
    client.getGeoArticles.mockResolvedValue({ articles: [] });
    renderTab(geoProject({ content: "done" }));
    const button = await screen.findByRole("button", { name: "写第一批稿件" });
    await userEvent.click(button);
    await waitFor(() => expect(client.runGeoStep).toHaveBeenCalledWith("geo_1", "content"));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/actions");
  });

  it("says which step a step asked for early waits for, and offers nothing to press", async () => {
    client.getGeoActions.mockResolvedValue({ ...actionsFilled, actions: [], control: [] });
    client.getGeoArticles.mockResolvedValue({ articles: [] });
    const project = geoProject({});
    project.steps.content = { status: "none", requested: true };
    renderTab(project);
    expect(await screen.findByText("写第一批稿件，排队中")).toBeInTheDocument();
    expect(screen.getByText("“信源”做完后自动开始。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "写第一批稿件" })).not.toBeInTheDocument();
  });

  it("says what it kept and offers to go on when the step did not finish", async () => {
    client.getGeoActions.mockResolvedValue({ ...actionsFilled, actions: [], control: [] });
    client.getGeoArticles.mockResolvedValue({ articles: [] });
    renderTab(geoProject({ content: "failed" }));
    expect(await screen.findByText("写第一批稿件没有完成")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "接着做" }));
    await waitFor(() => expect(client.runGeoStep).toHaveBeenCalledWith("geo_1", "content"));
  });

  it("names what the step uses as links to where each is read, and what it gives", async () => {
    client.getGeoActions.mockResolvedValue({ ...actionsFilled, actions: [], control: [] });
    client.getGeoArticles.mockResolvedValue({ articles: [] });
    renderTab(geoProject({ content: "done" }));
    await screen.findByRole("button", { name: "写第一批稿件" });
    expect(screen.getByRole("link", { name: "信源分析" })).toHaveAttribute("href", "/app/geo/geo_1/sources");
    expect(screen.getByText("得到 面向各问题群的稿件")).toBeInTheDocument();
  });

  it("shows a read that failed with 重试, and the page comes after it", async () => {
    client.getGeoActions.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(actionsFilled);
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: /重试/ }));
    expect(await findRow(ACTION_BRAND.key)).toBeInTheDocument();
  });

  it("does not draw an action's article button for a viewer, and offers nothing to change", async () => {
    const viewer = geoProject({}, { access: { roles: ["viewer"], abilities: ["read"], owner: false } });
    renderTab(viewer);
    const row = await findRow(ACTION_BRAND.key);
    await within(row).findByText("纠正讲错");
    expect(within(row).queryByRole("button", { name: "换信源" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /这条行动的更多操作/ })).not.toBeInTheDocument();
  });
});

// A fixture factory outside the suite keeps the typed shapes honest for the rest of the package's tests.
void actionFixture;
