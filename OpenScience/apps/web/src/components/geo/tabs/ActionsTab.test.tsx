import type { ReactElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoArticle, GeoProject } from "@/lib/geoClient";
import { articlesFilled, distributionFilled, geoProject, monitoringFilled } from "../__fixtures__/geoTabs";
import { ActionsTab } from "./ActionsTab";
import { ContentTab } from "./ContentTab";
import { Distribution, hasDistribution } from "./DistributionTab";

const client = vi.hoisted(() => ({
  getGeoArticles: vi.fn(),
  getGeoArticleText: vi.fn(),
  withdrawGeoArticle: vi.fn(),
  releaseGeoArticle: vi.fn(),
  getGeoDistribution: vi.fn(),
  setGeoBudget: vi.fn(),
  cancelGeoOrder: vi.fn(),
  getGeoMonitoring: vi.fn(),
  runGeoStep: vi.fn(),
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

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderTab(tab: ReactElement) {
  return render(
    <MemoryRouter initialEntries={["/app/geo/geo_1/tab"]}>
      <Routes>
        <Route path="/app/geo/geo_1/tab" element={<>{tab}<Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const props = (project: GeoProject = geoProject()) => ({ geoId: "geo_1", project });

function article(index: number, extra: Partial<GeoArticle> = {}): GeoArticle {
  return {
    id: `art_${index}`, layer: "popular", title: `稿件${index}`, groupId: "gq_1", question: null, status: "publishable", gate: "passed",
    safety: "clear", path: `articles/art_${index}.md`, runId: "run_1", claimCount: 3, placements: 0, cited: false, ...extra,
  };
}

/** The row of the list an article is in. */
const rowOf = (title: string) => screen.getByText(title).closest("li") as HTMLElement;

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  store.select.mockClear();
  client.runGeoStep.mockResolvedValue({ sessionId: "ses_geo_1" });
  client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
});

describe("行动: the stage counts", () => {
  it("counts each article in one stage only, and leaves the total to the list", async () => {
    client.getGeoArticles.mockResolvedValue({
      articles: [
        article(1), article(2),
        article(3, { status: "placed" }),
        article(4, { status: "published", cited: true }),
        article(5, { status: "draft", path: null, runId: null }),
        article(6, { status: "withdrawn" }),
      ],
    });
    client.getGeoDistribution.mockResolvedValue({ ...distributionFilled, orders: [], ownedLinks: [] });
    renderTab(<ActionsTab {...props()} />);
    const band = await screen.findByRole("region", { name: "稿件流水线" });
    expect(band.textContent).toContain("可发布2篇投放中1篇已上线1篇被 AI 引用1篇");
    expect(band.textContent).not.toContain("已写好");
    expect(screen.getByText("6 篇")).toBeInTheDocument();
  });

  it("says in the footnote how many are held for a safety question", async () => {
    client.getGeoArticles.mockResolvedValue(articlesFilled);
    client.getGeoDistribution.mockResolvedValue(distributionFilled);
    renderTab(<ActionsTab {...props()} />);
    expect(await screen.findByText("其中 1 篇等你看过安全问题后才能投放")).toBeInTheDocument();
  });
});

describe("行动: the market", () => {
  it("says what placing waits for directly under the counts, above the list, and draws no empty 投放 section", async () => {
    client.getGeoArticles.mockResolvedValue({ articles: [article(1), article(2)] });
    client.getGeoDistribution.mockResolvedValue({ ...distributionFilled, budget: null, orders: [], ownedLinks: [], market: { configured: false } });
    renderTab(<ActionsTab {...props()} />);
    const sentence = await screen.findByText("投放要等媒介集市接通：接通之前不会下单，写好的稿件先留在这里。");
    const band = screen.getByRole("region", { name: "稿件流水线" });
    const list = document.querySelector("[data-geo-tab='content'] ul") as HTMLElement;
    expect(band.compareDocumentPosition(sentence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sentence.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "投放" })).not.toBeInTheDocument();
    // It asks for nothing: no budget, no "wait for you".
    expect(screen.queryByRole("button", { name: "设置投放预算" })).not.toBeInTheDocument();
    expect(screen.queryByText(/等你/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "效果" })).toBeInTheDocument();
  });

  it("shows the brand's own pages even with no order and no market, under a 投放 heading", async () => {
    client.getGeoArticles.mockResolvedValue({ articles: [article(1)] });
    client.getGeoDistribution.mockResolvedValue({ ...distributionFilled, budget: null, orders: [], market: { configured: false } });
    renderTab(<ActionsTab {...props()} />);
    expect(await screen.findByText("减重针常见问题 10 问")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "投放" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "订单" })).not.toBeInTheDocument();
    expect(screen.getByText(/投放要等媒介集市接通/)).toBeInTheDocument();
  });

  it("with a market connected, the 投放 section is there and the sentence is not", async () => {
    client.getGeoArticles.mockResolvedValue({ articles: [article(1)] });
    client.getGeoDistribution.mockResolvedValue(distributionFilled);
    renderTab(<ActionsTab {...props()} />);
    expect(await screen.findByRole("heading", { name: "投放" })).toBeInTheDocument();
    expect(screen.queryByText(/投放要等媒介集市接通/)).not.toBeInTheDocument();
  });

  it("a placement read that fails is said in its own section, with 重试, and the articles stay", async () => {
    client.getGeoArticles.mockResolvedValue({ articles: [article(1)] });
    client.getGeoDistribution.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(distributionFilled);
    renderTab(<ActionsTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: /重试/ }));
    expect(await screen.findByText("2,460 灵豆")).toBeInTheDocument();
    expect(screen.getByText("稿件1")).toBeInTheDocument();
  });

  it("hasDistribution is false only when there is no market, no budget, no order and no page of the brand's own", () => {
    expect(hasDistribution({ ...distributionFilled, budget: null, orders: [], ownedLinks: [], market: { configured: false } })).toBe(false);
    expect(hasDistribution({ ...distributionFilled, budget: null, orders: [], ownedLinks: [], market: { configured: true } })).toBe(true);
    expect(hasDistribution({ ...distributionFilled, budget: null, ownedLinks: [], market: { configured: false } })).toBe(true);
    expect(hasDistribution(null)).toBe(false);
  });
});

describe("行动: the articles", () => {
  it("has one visible action per row, and 撤回 in the row's ⋯", async () => {
    client.getGeoArticles.mockResolvedValue(articlesFilled);
    client.getGeoDistribution.mockResolvedValue(distributionFilled);
    client.withdrawGeoArticle.mockResolvedValue({});
    renderTab(<ContentTab {...props()} />);
    await screen.findByText("3 篇");
    expect(screen.queryByRole("button", { name: "撤回" })).not.toBeInTheDocument();
    // art_1 is published: 打开. art_2 is held for safety: 放行. art_3 is withdrawn: nothing to do to it.
    const actionsIn = (row: HTMLElement) => within(row).queryAllByRole("button").filter((button) => /^(打开|查看|放行|撤回)$/.test(button.textContent ?? ""));
    expect(actionsIn(rowOf("打了减重针一直恶心，要不要停药？")).map((button) => button.textContent)).toEqual(["打开"]);
    expect(actionsIn(rowOf("合并 2 型糖尿病的人能不能用？")).map((button) => button.textContent)).toEqual(["放行"]);
    expect(actionsIn(rowOf("停药后体重会反弹吗？"))).toHaveLength(0);
    expect(within(rowOf("停药后体重会反弹吗？")).queryByRole("button", { name: /的操作/ })).not.toBeInTheDocument();

    await userEvent.click(within(rowOf("打了减重针一直恶心，要不要停药？")).getByRole("button", { name: /的操作/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "撤回" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "撤回" }));
    await waitFor(() => expect(client.withdrawGeoArticle).toHaveBeenCalledWith("geo_1", "art_1"));
  });

  it("holds the safety one for 放行 and opens another in the reader", async () => {
    client.getGeoArticles.mockResolvedValue(articlesFilled);
    client.releaseGeoArticle.mockResolvedValue({});
    renderTab(<ContentTab {...props()} />);
    expect(await screen.findByText("3 篇")).toBeInTheDocument();
    expect(screen.getByText("已发布 · 已被 AI 引用")).toBeInTheDocument();
    expect(screen.getByText("安全待复核")).toHaveClass("text-danger-strong");

    await userEvent.click(screen.getByRole("button", { name: "放行" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "放行" }));
    await waitFor(() => expect(client.releaseGeoArticle).toHaveBeenCalledWith("geo_1", "art_2"));

    await userEvent.click(screen.getByRole("button", { name: "打开" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/runs/run_1/files/articles/art_1.md"));
    expect(store.select).toHaveBeenCalledWith("prj_geo_1", expect.any(Function));
  });

  it("shows 10 of 37 articles, then 显示更多 with how many are left, and finds one by a word of its title", async () => {
    client.getGeoArticles.mockResolvedValue({ articles: Array.from({ length: 37 }, (_, index) => article(index + 1, { title: `稿件${index + 1}${index === 20 ? " 饭后服用" : ""}` })) });
    renderTab(<ContentTab {...props()} />);
    expect(await screen.findByText("37 篇")).toBeInTheDocument();
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(10);
    await userEvent.click(screen.getByRole("button", { name: "显示更多 · 还有 27 篇" }));
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(30);
    await userEvent.click(screen.getByRole("button", { name: "显示更多 · 还有 7 篇" }));
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(37);
    expect(screen.queryByRole("button", { name: /显示更多/ })).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索稿件" }), "饭后");
    expect(screen.getByText("匹配 1 篇")).toBeInTheDocument();
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索稿件" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索稿件" }), "没有的词");
    expect(screen.getByText("没有包含“没有的词”的稿件。")).toBeInTheDocument();
  });

  it("says in the article's own line what the evidence chain found: a cited conclusion since updated, a reference that does not resolve, a paid label", async () => {
    client.getGeoArticles.mockResolvedValue({
      articles: [
        { ...articlesFilled.articles[0], title: "被引更新的稿件", staleReferences: [{ cardId: "ec_1", claimId: "dose", revision: 1, category: "correction", summary: "修正", occurredAt: "2026-10-07T00:00:00Z" }], placementLabel: "commercial_cooperation", placements: 1 },
        { ...articlesFilled.articles[0], id: "art_9", title: "对不上的稿件", referenceStatus: "unresolved", placements: 0 },
        { ...articlesFilled.articles[0], id: "art_8", title: "平常的稿件", referenceStatus: "resolved", staleReferences: [], placementLabel: null, placements: 0 },
      ],
    });
    renderTab(<ContentTab {...props()} />);
    expect(await screen.findByText("科普稿件 · 投放 1 家 · 商业合作 · 被引结论已更新")).toBeInTheDocument();
    expect(screen.getByText("科普稿件 · 引用的结论对不上")).toBeInTheDocument();
    // A notice is a line of text, not a stop: the article still opens as before.
    expect(screen.getAllByRole("button", { name: "打开" })).toHaveLength(3);
  });

  it("a card-layer article has no file, so it is read as the card renders it: 查看 shows the text the platform would publish", async () => {
    client.getGeoArticles.mockResolvedValue({
      articles: [{ ...articlesFilled.articles[1], id: "art_card", path: null, runId: null, cardId: "ec_1", cardRevision: 2, safety: "clear", title: "用药后体重能降多少？" }],
    });
    client.getGeoArticleText.mockResolvedValue({ articleId: "art_card", layer: "card", aiGenerated: true, markdown: "# 用药后体重能降多少？\n\n出品方：某某制药\n\n本文由 AI 辅助生成。\n" });
    renderTab(<ContentTab {...props()} />);
    await screen.findByText("用药后体重能降多少？");
    expect(screen.queryByRole("button", { name: "打开" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(client.getGeoArticleText).toHaveBeenCalledWith("geo_1", "art_card");
    const dialog = await screen.findByRole("dialog", { name: "用药后体重能降多少？" });
    expect(within(dialog).getByText(/出品方：某某制药/)).toBeInTheDocument();
    expect(within(dialog).getByText(/本文由 AI 辅助生成/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a read that failed with 重试", async () => {
    client.getGeoArticles.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(articlesFilled);
    renderTab(<ContentTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: /重试/ }));
    expect(await screen.findByText("打了减重针一直恶心，要不要停药？")).toBeInTheDocument();
  });
});

describe("行动: 投放", () => {
  const withData = (data: typeof distributionFilled) => renderTab(<Distribution {...props()} data={data} onChanged={vi.fn()} />);

  it("asks for the budget when unset, with the suggestion prefilled, and saves it", async () => {
    client.setGeoBudget.mockResolvedValue({});
    withData({ ...distributionFilled, budget: null, orders: [], market: { configured: true } });
    await userEvent.click(await screen.findByRole("button", { name: "设置投放预算" }));
    const dialog = screen.getByRole("dialog", { name: "设置投放预算" });
    expect(within(dialog).getByLabelText("总预算（灵豆）")).toHaveValue("8000");
    expect(within(dialog).getByLabelText("每天最多（灵豆）")).toHaveValue("800");
    await userEvent.clear(within(dialog).getByLabelText("每天最多（灵豆）"));
    await userEvent.type(within(dialog).getByLabelText("每天最多（灵豆）"), "9000");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(within(dialog).getByText("每天最多花的钱不能超过总预算。")).toBeInTheDocument();
    expect(client.setGeoBudget).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByLabelText("每天最多（灵豆）"));
    await userEvent.type(within(dialog).getByLabelText("每天最多（灵豆）"), "500");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.setGeoBudget).toHaveBeenCalledWith("geo_1", { totalCny: 8000, dailyCny: 500 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("offers 撤单 only before the outlet accepted", async () => {
    client.cancelGeoOrder.mockResolvedValue({});
    withData(distributionFilled);
    await screen.findByText("2,460 灵豆");
    const submitted = document.querySelector("[data-geo-order='ord_3']") as HTMLElement;
    const accepted = document.querySelector("[data-geo-order='ord_2']") as HTMLElement;
    const verified = document.querySelector("[data-geo-order='ord_1']") as HTMLElement;
    expect(screen.getAllByRole("button", { name: "撤单" })).toHaveLength(1);
    expect(within(accepted).queryByRole("button", { name: "撤单" })).not.toBeInTheDocument();
    expect(within(accepted).getByText("媒体已接单")).toBeInTheDocument();
    expect(within(verified).getByRole("link", { name: /查看/ })).toHaveAttribute("href", "https://39.net/a");
    expect(screen.queryByText(/媒介集市/)).not.toBeInTheDocument();
    await userEvent.click(within(submitted).getByRole("button", { name: "撤单" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "撤单" }));
    await waitFor(() => expect(client.cancelGeoOrder).toHaveBeenCalledWith("geo_1", "ord_3"));
  });

  it("lists the pages the brand published itself beside the orders: platform, which engines cite it, and a retired one as 已下线", async () => {
    withData(distributionFilled);
    await screen.findByRole("heading", { name: "自有发布" });
    const live = document.querySelector("[data-geo-owned-link='gol_1']") as HTMLElement;
    const retired = document.querySelector("[data-geo-owned-link='gol_2']") as HTMLElement;
    expect(within(live).getByRole("rowheader")).toHaveTextContent("百家号");
    expect(live).toHaveTextContent("DeepSeek、Kimi");
    expect(within(live).getByRole("link", { name: /查看/ })).toHaveAttribute("href", "https://baijiahao.baidu.com/s?id=1");
    expect(within(live).queryByText("已下线")).not.toBeInTheDocument();
    expect(within(retired).getByRole("rowheader")).toHaveTextContent("微信公众号");
    expect(within(retired).getByText("已下线")).toBeInTheDocument();
    expect(screen.queryByText("wechat_mp")).not.toBeInTheDocument();
  });
});
