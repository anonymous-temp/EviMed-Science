import type { ReactElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoProject } from "@/lib/geoClient";
import {
  articlesFilled,
  cell,
  diagnosisFilled,
  distributionFilled,
  evidenceFilled,
  geoProject,
  journeyFilled,
  monitoringFilled,
  questionsFilled,
  sourcesFilled,
} from "../__fixtures__/geoTabs";
import { AccuracyTab } from "./AccuracyTab";
import { ContentTab } from "./ContentTab";
import { DistributionTab } from "./DistributionTab";
import { EffectSection } from "./EffectSection";
import { EvidenceTab } from "./EvidenceTab";
import { JourneyTab } from "./JourneyTab";
import { QuestionsTab } from "./QuestionsTab";
import { SourcesTab } from "./SourcesTab";
import { VisibilityTab } from "./VisibilityTab";

const client = vi.hoisted(() => ({
  getGeoEvidence: vi.fn(),
  getGeoJourney: vi.fn(),
  getGeoQuestions: vi.fn(),
  unmeasureGeoQuestion: vi.fn(),
  getGeoDiagnosis: vi.fn(),
  getGeoSources: vi.fn(),
  setGeoTier: vi.fn(),
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

const download = vi.hoisted(() => ({ downloadArtifact: vi.fn(async () => undefined) }));
vi.mock("@/lib/artifactFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifactFile")>()),
  ...download,
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

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  store.select.mockClear();
  download.downloadArtifact.mockClear();
  client.runGeoStep.mockResolvedValue({ sessionId: "ses_geo_1" });
});

describe("a tab with nothing yet", () => {
  it("says one quiet line while the step is being worked on", async () => {
    client.getGeoEvidence.mockResolvedValue({ product: {}, competitors: [], claims: [] });
    renderTab(<EvidenceTab {...props(geoProject({ evidence: "running" }))} />);
    expect(await screen.findByText("正在进行，做完会显示在这里。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
  });

  it("says when a step asked for but waiting on the one before it will start, and offers nothing to press", async () => {
    client.getGeoArticles.mockResolvedValue({ articles: [] });
    const project = geoProject({});
    project.steps.content = { status: "none", requested: true };
    renderTab(<ContentTab {...props(project)} />);
    expect(await screen.findByText("信源分析做完后开始写稿。")).toBeInTheDocument();
    expect(screen.queryByText("正在进行，做完会显示在这里。")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
  });

  it.each([
    ["evidence", EvidenceTab, () => client.getGeoEvidence.mockResolvedValue({ product: {}, competitors: [], claims: [] })],
    ["journey", JourneyTab, () => client.getGeoJourney.mockResolvedValue({ subtypes: [], personas: [], stages: [], careNodes: [], files: [] })],
    ["questions", QuestionsTab, () => client.getGeoQuestions.mockResolvedValue({ sets: [], version: null, groups: [] })],
    ["sources", SourcesTab, () => client.getGeoSources.mockResolvedValue({ sources: [], expectations: [], battlefield: null, tiers: [], chosenTier: null })],
    ["content", ContentTab, () => client.getGeoArticles.mockResolvedValue({ articles: [] })],
  ] as const)("%s: a finished step with nothing to show offers 让 AI 做", async (step, Tab, arrange) => {
    arrange();
    renderTab(<Tab {...props(geoProject({ [step]: "done" }))} />);
    const button = await screen.findByRole("button", { name: "让 AI 做" });
    await userEvent.click(button);
    await waitFor(() => expect(client.runGeoStep).toHaveBeenCalledWith("geo_1", step));
  });

  it("shows a read that failed with 重试", async () => {
    client.getGeoArticles.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(articlesFilled);
    renderTab(<ContentTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: /重试/ }));
    expect(await screen.findByText("打了减重针一直恶心，要不要停药？")).toBeInTheDocument();
  });
});

describe("证据", () => {
  it("shows who the product is and the claims with source, level, label scope and check date", async () => {
    client.getGeoEvidence.mockResolvedValue(evidenceFilled);
    renderTab(<EvidenceTab {...props()} />);
    expect(await screen.findByText("信达生物制药（苏州）有限公司")).toBeInTheDocument();
    expect(screen.getByText("司美格鲁肽、替尔泊肽")).toBeInTheDocument();
    expect(screen.getByText("处方药")).toBeInTheDocument();
    expect(screen.getByText("2 条结论")).toBeInTheDocument();
    expect(screen.queryByText("已撤下的旧说法。")).not.toBeInTheDocument();
    expect(screen.getByText("说明书 · 玛仕度肽注射液说明书（国家药监局 2025） · 成人 · 9月22日核对")).toBeInTheDocument();
    expect(screen.getByText(/证据等级 A/)).toBeInTheDocument();
    expect(screen.getByText("说明书内")).toBeInTheDocument();
  });

  it("a claim past its validity is marked 待重核, not shown as current", async () => {
    const [first, ...rest] = evidenceFilled.claims;
    client.getGeoEvidence.mockResolvedValue({ ...evidenceFilled, claims: [{ ...first, validUntil: "2026-01-01T00:00:00.000Z", status: "expired" }, ...rest] });
    renderTab(<EvidenceTab {...props()} />);
    expect(await screen.findByText("待重核")).toBeInTheDocument();
    expect(screen.queryByText("已过期")).not.toBeInTheDocument();
  });

  it("filters by source kind and opens a claim's quote in place", async () => {
    client.getGeoEvidence.mockResolvedValue(evidenceFilled);
    renderTab(<EvidenceTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: "临床试验" }));
    expect(screen.queryByText("每周一次皮下注射，从低剂量起始，按说明书逐步增加剂量。")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "全部" }));
    await userEvent.click(screen.getByRole("button", { name: "每周一次皮下注射，从低剂量起始，按说明书逐步增加剂量。" }));
    expect(screen.getByText("本品每周注射一次。")).toBeInTheDocument();
  });
});

describe("旅程", () => {
  it("carries the four columns only, with the emotion under the stage", async () => {
    client.getGeoJourney.mockResolvedValue(journeyFilled);
    renderTab(<JourneyTab {...props()} />);
    const table = await screen.findByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual(["阶段", "在想什么", "会问 AI 的问题", "从哪里看信息"]);
    expect(within(table).getByText("情绪 3/10")).toBeInTheDocument();
    expect(within(table).getByText("焦虑")).toBeInTheDocument();
    expect(within(table).getByText("BMI 28 算肥胖吗；减肥针是什么")).toBeInTheDocument();
    expect(within(table).getByText("小红书、抖音")).toBeInTheDocument();
    expect(document.querySelector("[data-geo-chart-series='emotion']")).not.toBeNull();
  });

  it("shows the care nodes and downloads the full matrix from the project", async () => {
    client.getGeoJourney.mockResolvedValue(journeyFilled);
    renderTab(<JourneyTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: "就医节点" }));
    expect(screen.getByText("持续剧烈腹痛")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "完整旅程图" }));
    await waitFor(() => expect(download.downloadArtifact).toHaveBeenCalledWith("outputs/journey/journey-matrix.xlsx", "workspace"));
    expect(store.select).toHaveBeenCalledWith("prj_geo_1");
  });
});

describe("问题", () => {
  it("names a platform in words, strips a group's internal number, and counts every real phrasing (G18)", async () => {
    const group = questionsFilled.groups[0];
    client.getGeoQuestions.mockResolvedValue({
      ...questionsFilled,
      groups: [{
        ...group,
        name: "P2-03 恶心呕吐与胃肠反应",
        questions: [
          ...group.questions.map((question) => (question.id === "q_2" ? { ...question, platform: "xhs" } : question)),
          { id: "q_9", text: "打针后恶心能吃止吐药吗", kind: "real" as const, platform: "douyin", sourceUrl: null, isMeasured: true },
        ],
      }],
    });
    renderTab(<QuestionsTab {...props()} />);
    const row = (await screen.findByRole("button", { name: "恶心呕吐与胃肠反应" })).closest("[data-geo-group]") as HTMLElement;
    expect(row).not.toHaveTextContent("P2-03");
    expect(row).toHaveTextContent("3 条原话");
    await userEvent.click(within(row).getByRole("button", { name: "恶心呕吐与胃肠反应" }));
    expect(screen.getByRole("link", { name: "小红书" })).toBeInTheDocument();
    expect(screen.getByText(/真实问法 · 抖音/)).toBeInTheDocument();
    expect(screen.queryByText(/xhs|douyin/)).not.toBeInTheDocument();
  });

  it("files groups under pools, marks control groups and opens a group to its phrasings", async () => {
    client.getGeoQuestions.mockResolvedValue(questionsFilled);
    renderTab(<QuestionsTab {...props()} />);
    expect(await screen.findByText("3 个语义群 · 2 问 · 2 条真实问法")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "增量" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "风险监测" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "存量" })).not.toBeInTheDocument();
    const control = document.querySelector("[data-geo-group='gq_2']") as HTMLElement;
    expect(within(control).getByText("对照组")).toBeInTheDocument();
    expect(within(control).getByText(/无信号/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "恶心呕吐与胃肠反应" }));
    expect(screen.getByRole("link", { name: "小红书" })).toHaveAttribute("href", "https://www.xiaohongshu.com/explore/1");
    expect(screen.getByText("恶心是不是说明剂量太大")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "风险监测" }));
    expect(screen.queryByText("恶心呕吐与胃肠反应")).not.toBeInTheDocument();
    expect(screen.getByText("孕期、哺乳期与未成年人")).toBeInTheDocument();
  });

  it("removes a question from measurement with the row's own action, always visible", async () => {
    client.getGeoQuestions.mockResolvedValue(questionsFilled);
    client.unmeasureGeoQuestion.mockResolvedValue({});
    renderTab(<QuestionsTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: "恶心呕吐与胃肠反应" }));
    const row = document.querySelector("[data-geo-question='q_1']") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "移出测量问句" }));
    await waitFor(() => expect(client.unmeasureGeoQuestion).toHaveBeenCalledWith("geo_1", "q_1"));
    await waitFor(() => expect(client.getGeoQuestions).toHaveBeenCalledTimes(2));
  });
});

describe("信源", () => {
  it("lists sources with the three conditions, leaves impostors out and says how many", async () => {
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    renderTab(<SourcesTab {...props()} />);
    expect(await screen.findByText("已排除 1 个冒名站")).toBeInTheDocument();
    const table = screen.getAllByRole("table")[0];
    expect(within(table).queryByText("某某时报网")).not.toBeInTheDocument();
    expect(within(table).getAllByText("健康媒体", { selector: "span" })).toHaveLength(2);
    expect(within(table).getByText("有 1 处讲错")).toHaveClass("text-danger");
    expect(within(table).getByText("¥120")).toBeInTheDocument();
    expect(document.querySelector("[data-geo-source='baike.baidu.com'] [data-geo-condition='newsIndexed:no']")).not.toBeNull();
    expect(document.querySelector("[data-geo-source='baike.baidu.com'] [data-geo-condition='medical:unknown']")).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "豆包" }));
    expect(within(screen.getAllByRole("table")[0]).queryByText("百度百科")).not.toBeInTheDocument();
  });

  it("says which engines' citations had no link instead of leaving them out silently (G8)", async () => {
    client.getGeoSources.mockResolvedValue({ ...sourcesFilled, linklessEngines: ["qianwen"] });
    renderTab(<SourcesTab {...props()} />);
    expect(await screen.findByText("千问的引用只有标题、没有链接，引用了哪些信源测不出")).toBeInTheDocument();
  });

  it("shows each engine's expectation, the battlefield and the tiers, and switches the tier", async () => {
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    client.setGeoTier.mockResolvedValue({});
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("证据最硬、竞品最弱。");
    const expectation = document.querySelector("[data-geo-expectation='deepseek']") as HTMLElement;
    expect(within(expectation).getByText("锚点 + 覆盖")).toBeInTheDocument();
    expect(within(document.querySelector("[data-geo-expectation='baidu']") as HTMLElement).getByText("只测提及")).toBeInTheDocument();
    expect(screen.getByText("证据最硬、竞品最弱。")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "档二（已选）" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "品牌提及率（增量）" })).toBeInTheDocument();
    expect(screen.getByText("¥15,000")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "档三" }));
    await waitFor(() => expect(client.setGeoTier).toHaveBeenCalledWith("geo_1", "3"));
  });
});

describe("内容", () => {
  it("lists articles by layer with their status, holds the safety one for 放行, and opens one in the reader", async () => {
    client.getGeoArticles.mockResolvedValue(articlesFilled);
    client.releaseGeoArticle.mockResolvedValue({});
    renderTab(<ContentTab {...props()} />);
    expect(await screen.findByText("3 篇 · 已发布 1")).toBeInTheDocument();
    expect(screen.getByText("已发布 · 已被 AI 引用")).toBeInTheDocument();
    expect(screen.getByText("安全待复核")).toHaveClass("text-danger-strong");

    await userEvent.click(screen.getByRole("button", { name: "放行" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "放行" }));
    await waitFor(() => expect(client.releaseGeoArticle).toHaveBeenCalledWith("geo_1", "art_2"));

    await userEvent.click(screen.getAllByRole("button", { name: "打开" })[0]);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/runs/run_1/files/articles/art_1.md"));
    expect(store.select).toHaveBeenCalledWith("prj_geo_1", expect.any(Function));
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
    // A notice is a line of text, not a stop: the article still opens and withdraws as before.
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

  it("withdraws after asking, and a withdrawn article has no 撤回", async () => {
    client.getGeoArticles.mockResolvedValue(articlesFilled);
    client.withdrawGeoArticle.mockResolvedValue({});
    renderTab(<ContentTab {...props()} />);
    await screen.findByText("3 篇 · 已发布 1");
    expect(screen.getAllByRole("button", { name: "撤回" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "撤回" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "撤回" }));
    await waitFor(() => expect(client.withdrawGeoArticle).toHaveBeenCalledWith("geo_1", "art_1"));
  });
});

describe("投放", () => {
  it("without a media market, asks for nothing and says what placing waits for (G20)", async () => {
    client.getGeoDistribution.mockResolvedValue({ ...distributionFilled, budget: null, orders: [], market: { configured: false } });
    renderTab(<DistributionTab {...props()} />);
    expect(await screen.findByText(/投放要等媒介集市接通/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设置投放预算" })).not.toBeInTheDocument();
    expect(screen.queryByText(/等你/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
  });

  it("asks for the budget when unset, with the suggestion prefilled, and saves it", async () => {
    client.getGeoDistribution.mockResolvedValue({ ...distributionFilled, budget: null, orders: [], market: { configured: true } });
    client.setGeoBudget.mockResolvedValue({});
    renderTab(<DistributionTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: "设置投放预算" }));
    const dialog = screen.getByRole("dialog", { name: "设置投放预算" });
    expect(within(dialog).getByLabelText("总预算（元）")).toHaveValue("8000");
    expect(within(dialog).getByLabelText("每天最多（元）")).toHaveValue("800");
    await userEvent.clear(within(dialog).getByLabelText("每天最多（元）"));
    await userEvent.type(within(dialog).getByLabelText("每天最多（元）"), "9000");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(within(dialog).getByText("每天最多花的钱不能超过总预算。")).toBeInTheDocument();
    expect(client.setGeoBudget).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByLabelText("每天最多（元）"));
    await userEvent.type(within(dialog).getByLabelText("每天最多（元）"), "500");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.setGeoBudget).toHaveBeenCalledWith("geo_1", { totalCny: 8000, dailyCny: 500 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("offers 撤单 only before the outlet accepted", async () => {
    client.getGeoDistribution.mockResolvedValue(distributionFilled);
    client.cancelGeoOrder.mockResolvedValue({});
    renderTab(<DistributionTab {...props()} />);
    await screen.findByText("¥2,460");
    const submitted = document.querySelector("[data-geo-order='ord_3']") as HTMLElement;
    const accepted = document.querySelector("[data-geo-order='ord_2']") as HTMLElement;
    const verified = document.querySelector("[data-geo-order='ord_1']") as HTMLElement;
    expect(screen.getAllByRole("button", { name: "撤单" })).toHaveLength(1);
    expect(within(accepted).queryByRole("button", { name: "撤单" })).not.toBeInTheDocument();
    expect(within(accepted).getByText("媒体已接单")).toBeInTheDocument();
    expect(within(verified).getByRole("link", { name: /查看/ })).toHaveAttribute("href", "https://39.net/a");
    expect(screen.queryByText(/媒介集市/)).not.toBeInTheDocument();
    expect(screen.getByText("¥2,460")).toBeInTheDocument();
    await userEvent.click(within(submitted).getByRole("button", { name: "撤单" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "撤单" }));
    await waitFor(() => expect(client.cancelGeoOrder).toHaveBeenCalledWith("geo_1", "ord_3"));
  });

  it("lists the pages the brand published itself beside the orders: platform, which engines cite it, and a retired one as 已下线", async () => {
    client.getGeoDistribution.mockResolvedValue(distributionFilled);
    renderTab(<DistributionTab {...props()} />);
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

  it("shows the brand's own pages even with no order and no market", async () => {
    client.getGeoDistribution.mockResolvedValue({ ...distributionFilled, budget: null, orders: [], market: { configured: false } });
    renderTab(<DistributionTab {...props()} />);
    expect(await screen.findByText("减重针常见问题 10 问")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "订单" })).not.toBeInTheDocument();
  });
});

describe("准确与安全", () => {
  it("leads with the accuracy rate, grades every wrong statement and groups them by handling", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    renderTab(<AccuracyTab {...props()} />);
    const accuracy = await screen.findByRole("region", { name: "事实准确率" });
    expect(accuracy).toHaveTextContent("92");
    expect(accuracy).toHaveTextContent("目标 98%");
    // The denominator is declared once for the whole band.
    expect(within(screen.getByRole("region", { name: "准确与安全" })).getAllByText(/次有效回答计算/)).toHaveLength(1);

    // The grade is said as the level, its colour and its consequence.
    const graded = document.querySelector("[data-severity='S2']") as HTMLElement;
    // Printed beside the grade, so not repeated as a tooltip (spec §22.8 rule 4).
    expect(graded.parentElement).toHaveTextContent("需监测或干预");
    expect(graded).not.toHaveAttribute("title");
    expect(screen.getByText(/它需要每天注射一次/)).toBeInTheDocument();
    // Red is the badge and the ✗ — not the sentence.
    expect(screen.getByText(/它需要每天注射一次/)).not.toHaveClass("text-danger");
    expect(screen.getByRole("link", { name: "看回答" })).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_deepseek");
  });

  it("opens the conversation with the correction brief, and never asks about a single number", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    renderTab(<AccuracyTab {...props()} />);
    await screen.findByRole("region", { name: "事实准确率" });
    expect(screen.queryByRole("button", { name: "问 AI" })).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "写纠错稿" })[0]);
    await waitFor(() => expect(store.select).toHaveBeenCalledWith("prj_geo_1", expect.any(Function)));
  });
});

describe("可见度", () => {
  it("draws the trend against the target, each engine, and the pools — hiding a column nothing fills", async () => {
    client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    renderTab(<VisibilityTab {...props()} />);
    await screen.findByRole("heading", { name: /综合可见度指数 38，比上次高 9/ });
    expect(document.querySelector("[data-chart='trend']")).toHaveAttribute("data-chart-mode", "series");
    expect(document.querySelector("[data-geo-engine-trend='kimi']")).not.toBeNull();

    const pools = screen.getByRole("table", { name: "按问句池的品牌提及率" });
    const headers = within(pools).getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toContain("头部竞品");
    expect(headers).toContain("主要问题");
  });

  it("gives the risk pool its own line, and says a main issue shared by every pool once (G19)", async () => {
    client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    client.getGeoDiagnosis.mockResolvedValue({
      ...diagnosisFilled,
      byPool: [
        ...diagnosisFilled.byPool.map((row) => ({ ...row, mainIssue: "漏提我方" })),
        { pool: "P4" as const, mention: cell(null, null, null, { status: "absent" }), topCompetitor: null, mainIssue: "漏提我方" },
      ],
      more: [...diagnosisFilled.more, { metricId: "M-15", name: "风险问句被推荐率", cell: cell(3, 2, 62) }],
    });
    renderTab(<VisibilityTab {...props()} />);
    const pools = await screen.findByRole("table", { name: "按问句池的品牌提及率" });
    expect(document.querySelector("[data-geo-pool='P4']")).toBeNull();
    expect(within(pools).getAllByRole("columnheader").map((header) => header.textContent)).not.toContain("主要问题");
    expect(screen.getByText("各类问题的主要问题都是“漏提我方”")).toBeInTheDocument();
    const risk = document.querySelector("[data-geo-risk-line]") as HTMLElement;
    expect(risk).toHaveTextContent("风险监测问题里，风险问句被推荐率");
    expect(risk).toHaveTextContent("3%");
    expect(risk).toHaveTextContent("越低越好");
  });

  it("draws the rivals as grey lines on the mention trend, which is over their questions too (G15)", async () => {
    client.getGeoMonitoring.mockResolvedValue({
      ...monitoringFilled,
      series: [{ key: "mention", points: [{ date: "2026-09-22", value: 15, n: 310, k: 47 }, { date: "2026-10-13", value: 21, n: 310, k: 65 }] }],
      rivals: [
        { name: "穆峰达", points: [{ date: "2026-09-22", value: 12, n: 310, k: 37 }] },
        { name: "诺和盈", points: [{ date: "2026-09-22", value: 30, n: 310, k: 93 }, { date: "2026-10-13", value: 31, n: 310, k: 96 }] },
        { name: "谊生泰", points: [] },
      ],
    });
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    renderTab(<VisibilityTab {...props()} />);
    await screen.findByRole("heading", { name: /品牌提及率 21%/ });
    expect(document.querySelector("[data-chart='trend']")).toHaveAttribute("data-chart-rivals", "2");
  });

  it("hides a column that would be “—” in every row", async () => {
    client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    client.getGeoDiagnosis.mockResolvedValue({
      ...diagnosisFilled,
      byPool: diagnosisFilled.byPool.map((row) => ({ ...row, topCompetitor: null, mainIssue: null })),
    });
    renderTab(<VisibilityTab {...props()} />);
    const pools = await screen.findByRole("table", { name: "按问句池的品牌提及率" });
    const headers = within(pools).getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).not.toContain("头部竞品");
    expect(headers).not.toContain("主要问题");
    expect(within(pools).queryByText("—")).not.toBeInTheDocument();
  });

  it("draws a baseline rather than an empty frame when there is one measurement", async () => {
    client.getGeoMonitoring.mockResolvedValue({
      ...monitoringFilled,
      series: [{ key: "gvi", points: [{ date: "2026-09-22", value: 24, n: 310, k: null }] }],
    });
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    renderTab(<VisibilityTab {...props()} />);
    await screen.findByText(/综合可见度指数基线 24/);
    const chart = document.querySelector("[data-chart='trend']") as HTMLElement;
    expect(chart).toHaveAttribute("data-chart-mode", "baseline");
    expect(chart).toHaveAttribute("data-chart-readings", "1");
    expect(document.querySelector("[data-chart-empty]")).toBeNull();
  });

  it("says why a metric has nothing to draw instead of drawing an empty frame", async () => {
    client.getGeoMonitoring.mockResolvedValue({ ...monitoringFilled, series: [], byEngine: [] });
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    renderTab(<VisibilityTab {...props()} />);
    expect(await screen.findByText("还没有开始持续监测，第一次复测后这里会画出趋势。")).toBeInTheDocument();
  });
});

describe("效果", () => {
  it("compares the placed groups with the control, and never paints the control in the brand colour", async () => {
    client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    renderTab(<EffectSection project={geoProject()} />);
    await screen.findByText(/投放的语义群比对照组多涨 12/);
    const own = document.querySelector("[data-legend-mark='own']") as HTMLElement;
    const control = document.querySelector("[data-legend-mark='rival-1']") as HTMLElement;
    expect(own.style.background).toBe("var(--chart-own)");
    expect(control.style.background).toBe("var(--chart-rival-1)");
    expect(control.style.background).not.toBe(own.style.background);
    expect(screen.getByText("豆包、元宝")).toBeInTheDocument();
  });

  it("a week measured on other engines than the baseline says so instead of a number", async () => {
    client.getGeoMonitoring.mockResolvedValue({
      ...monitoringFilled,
      arms: { ...monitoringFilled.arms, netEffect: { ...monitoringFilled.arms.netEffect, value: null, status: "not_measurable", reason: "engines_differ" } },
    });
    renderTab(<EffectSection project={geoProject()} />);
    expect(await screen.findByText("这次复测和基线测的引擎不同，净效应不可比")).toBeInTheDocument();
    expect(screen.getByText("引擎不同，不可比")).toBeInTheDocument();
  });

  it("a net effect inside the fluctuation band is 持平", async () => {
    client.getGeoMonitoring.mockResolvedValue({
      ...monitoringFilled,
      arms: { ...monitoringFilled.arms, netEffect: { ...monitoringFilled.arms.netEffect, value: 2 } },
    });
    renderTab(<EffectSection project={geoProject()} />);
    expect(await screen.findByText("持平")).toBeInTheDocument();
    expect(screen.getByText(/还在波动范围内/)).toBeInTheDocument();
  });
});
