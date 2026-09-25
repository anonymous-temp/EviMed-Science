import type { ReactElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoProject } from "@/lib/geoClient";
import {
  articlesFilled,
  diagnosisFilled,
  distributionFilled,
  evidenceFilled,
  geoProject,
  journeyFilled,
  monitoringFilled,
  questionsFilled,
  sourcesFilled,
} from "../__fixtures__/geoTabs";
import { ContentTab } from "./ContentTab";
import { DiagnosisTab } from "./DiagnosisTab";
import { DistributionTab } from "./DistributionTab";
import { EvidenceTab } from "./EvidenceTab";
import { JourneyTab } from "./JourneyTab";
import { MonitoringTab } from "./MonitoringTab";
import { QuestionsTab } from "./QuestionsTab";
import { SourcesTab } from "./SourcesTab";

const client = vi.hoisted(() => ({
  getGeoEvidence: vi.fn(),
  getGeoJourney: vi.fn(),
  getGeoQuestions: vi.fn(),
  unmeasureGeoQuestion: vi.fn(),
  getGeoDiagnosis: vi.fn(),
  getGeoSources: vi.fn(),
  setGeoTier: vi.fn(),
  getGeoArticles: vi.fn(),
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
    expect(await screen.findByText("AI 正在做这一步，做完会显示在这里。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
  });

  it.each([
    ["evidence", EvidenceTab, () => client.getGeoEvidence.mockResolvedValue({ product: {}, competitors: [], claims: [] })],
    ["journey", JourneyTab, () => client.getGeoJourney.mockResolvedValue({ subtypes: [], personas: [], stages: [], careNodes: [], files: [] })],
    ["questions", QuestionsTab, () => client.getGeoQuestions.mockResolvedValue({ sets: [], version: null, groups: [] })],
    ["diagnosis", DiagnosisTab, () => client.getGeoDiagnosis.mockResolvedValue({ round: null, rounds: [], byEngine: [], byPool: [], failureModes: {}, errors: [], noise: null, more: [] })],
    ["sources", SourcesTab, () => client.getGeoSources.mockResolvedValue({ sources: [], expectations: [], battlefield: null, tiers: [], chosenTier: null })],
    ["content", ContentTab, () => client.getGeoArticles.mockResolvedValue({ articles: [] })],
    ["monitoring", MonitoringTab, () => client.getGeoMonitoring.mockResolvedValue({ series: [], arms: { pilot: [], control: [], netEffect: {} }, byEngine: [], cited: [], newErrors: [], next: null })],
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
    expect(screen.getByText("2 条主张")).toBeInTheDocument();
    expect(screen.queryByText("已撤下的旧说法。")).not.toBeInTheDocument();
    expect(screen.getByText("说明书 · 玛仕度肽注射液说明书（国家药监局 2025） · 成人 · 9月22日核验")).toBeInTheDocument();
    expect(screen.getByText(/证据等级 A/)).toBeInTheDocument();
    expect(screen.getByText("说明书内")).toBeInTheDocument();
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

describe("诊断", () => {
  it("reads the round four ways, with 只测提及 for 百度 and every number opening its answers", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    renderTab(<DiagnosisTab {...props()} />);
    expect(await screen.findByText("3 个引擎 · 310 次回答 · 网页端、非深度思考、每题新对话 · 10月13日")).toBeInTheDocument();
    const modes = document.querySelector("[data-geo-failure-modes]") as HTMLElement;
    expect(within(modes).getByText("41")).toBeInTheDocument();
    const wrong = modes.querySelector("[data-geo-mode='wrongOurs']") as HTMLElement;
    expect(within(wrong).getByRole("link")).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_deepseek");
    expect(within(wrong).getByText("2")).toHaveClass("text-danger");

    const doubao = document.querySelector("[data-geo-engine='doubao']") as HTMLElement;
    expect(within(doubao).getByRole("link", { name: /22%.*14 次.*豆包的品牌提及率/ })).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_doubao");
    const baidu = document.querySelector("[data-geo-engine='baidu']") as HTMLElement;
    expect(within(baidu).getAllByText("只测提及")).toHaveLength(3);
    const kimi = document.querySelector("[data-geo-engine='kimi']") as HTMLElement;
    expect(within(kimi).getAllByText("样本不足").length).toBeGreaterThan(0);
    expect(within(kimi).getByText("未测")).toBeInTheDocument();
    for (const row of [doubao, baidu, kimi]) expect(within(row).getByRole("button", { name: "问 AI" })).toBeInTheDocument();

    expect(screen.getByText("多数回答只列司美格鲁肽")).toBeInTheDocument();
    const error = screen.getByRole("link", { name: "DeepSeek：它需要每天注射一次" });
    expect(error).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_deepseek");
    expect(screen.getByText("数字说错 · 需监测或干预 · 稳定出现 · 出处 baike.baidu.com（百科词条） · 修改百科词条 · 纠正中")).toBeInTheDocument();
  });

  it("switches rounds", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    renderTab(<DiagnosisTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: "基线 · 9月22日" }));
    await waitFor(() => expect(client.getGeoDiagnosis).toHaveBeenLastCalledWith("geo_1", "rnd_1"));
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
  it("asks for the budget when unset, with the suggestion prefilled, and saves it", async () => {
    client.getGeoDistribution.mockResolvedValue({ ...distributionFilled, budget: null, orders: [], market: { configured: false } });
    client.setGeoBudget.mockResolvedValue({});
    renderTab(<DistributionTab {...props()} />);
    expect(await screen.findByText("投放渠道未接通")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "设置投放预算" }));
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
    expect(screen.queryByText("投放渠道未接通")).not.toBeInTheDocument();
    expect(screen.getByText("¥2,460")).toBeInTheDocument();
    await userEvent.click(within(submitted).getByRole("button", { name: "撤单" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "撤单" }));
    await waitFor(() => expect(client.cancelGeoOrder).toHaveBeenCalledWith("geo_1", "ord_3"));
  });
});

describe("监测", () => {
  it("draws the trend against the target, the two arms with the net effect, each engine, cited articles and new errors", async () => {
    client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    renderTab(<MonitoringTab {...props()} />);
    expect(await screen.findByText("下次 每周复测 · 10月20日")).toBeInTheDocument();
    expect(screen.getByText("目标 55")).toBeInTheDocument();
    expect(document.querySelector("[data-geo-chart-target]")).not.toBeNull();
    const arms = document.querySelector("[data-geo-arms]") as HTMLElement;
    expect(within(arms).getByText("+14")).toBeInTheDocument();
    expect(within(arms).getByText("+2")).toBeInTheDocument();
    expect(within(arms).getByText("+12")).toBeInTheDocument();
    expect(within(arms).getByText("波动范围 ±3")).toBeInTheDocument();
    expect(document.querySelector("[data-geo-chart-series='control']")).not.toBeNull();
    const kimi = document.querySelector("[data-geo-engine-trend='kimi']") as HTMLElement;
    expect(within(kimi).getByText("样本不足")).toBeInTheDocument();
    expect(screen.getByText("豆包、元宝")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /DeepSeek：它需要每天注射一次/ })).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_deepseek");
  });

  it("says 样本不足 for a rate on fewer than 30 answers, and a net effect inside the band is flat", async () => {
    client.getGeoMonitoring.mockResolvedValue({
      ...monitoringFilled,
      arms: { ...monitoringFilled.arms, netEffect: { ...monitoringFilled.arms.netEffect, value: 2 } },
    });
    renderTab(<MonitoringTab {...props()} />);
    expect(await screen.findByText("持平")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "品牌提及率" }));
    expect(screen.getAllByText("样本不足").length).toBeGreaterThan(0);
    expect(screen.queryByText("21%")).not.toBeInTheDocument();
  });
});
