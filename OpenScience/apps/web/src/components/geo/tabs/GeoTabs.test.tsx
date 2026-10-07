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
  evidenceFilled,
  geoProject,
  journeyFilled,
  monitoringFilled,
  questionsFilled,
  sourcesFilled,
} from "../__fixtures__/geoTabs";
import { AccuracyTab } from "./AccuracyTab";
import { ContentTab } from "./ContentTab";
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

  it("shows 8 claims first, 显示更多 with how many are left, and finds one by a word of it", async () => {
    const claims = Array.from({ length: 108 }, (_, index) => ({
      ...evidenceFilled.claims[0],
      id: `clm_${index}`,
      statement: `第 ${index} 条结论：${index === 77 ? "饭后服用可减轻胃肠反应" : "按说明书使用"}。`,
    }));
    client.getGeoEvidence.mockResolvedValue({ ...evidenceFilled, claims });
    renderTab(<EvidenceTab {...props()} />);
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByText("108 条结论")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "显示更多 · 还有 100 条" }));
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(28);

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索结论" }), "饭后");
    expect(screen.getByText("匹配 1 条结论")).toBeInTheDocument();
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /显示更多/ })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索结论" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索结论" }), "没有这个词");
    expect(screen.getByText("没有包含“没有这个词”的结论。")).toBeInTheDocument();
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

  it("finds a question by a word of it, opens the groups it matches and says how many questions matched", async () => {
    client.getGeoQuestions.mockResolvedValue(questionsFilled);
    renderTab(<QuestionsTab {...props()} />);
    await screen.findByText("3 个语义群 · 2 问 · 2 条真实问法");
    expect(screen.queryByText("打了减重针一直恶心，要不要停药？")).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索问题" }), "剂量");
    // One real phrasing contains it; its group opens by itself and shows that phrasing alone.
    expect(screen.getByText("匹配 1 个问题")).toBeInTheDocument();
    expect(screen.getByText("恶心是不是说明剂量太大")).toBeInTheDocument();
    expect(screen.queryByText("打完减肥针一直吐正常吗")).not.toBeInTheDocument();
    expect(screen.queryByText("孕期、哺乳期与未成年人")).not.toBeInTheDocument();

    // A group named for the word keeps every question in it.
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索问题" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索问题" }), "恶心呕吐");
    expect(screen.getByText("打了减重针一直恶心，要不要停药？")).toBeInTheDocument();
    expect(screen.getByText("打完减肥针一直吐正常吗")).toBeInTheDocument();

    // It can still be closed by hand, and a new search starts from what it matches.
    await userEvent.click(screen.getByRole("button", { name: "恶心呕吐与胃肠反应" }));
    expect(screen.queryByText("打完减肥针一直吐正常吗")).not.toBeInTheDocument();

    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索问题" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索问题" }), "不存在的词");
    expect(screen.getByText("没有包含“不存在的词”的问题。")).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索问题" }));
    expect(screen.getByText("3 个语义群 · 2 问 · 2 条真实问法")).toBeInTheDocument();
  });

  it("a measured question opens the answer it last got; one never asked has nothing to open", async () => {
    client.getGeoQuestions.mockResolvedValue(questionsFilled);
    renderTab(<QuestionsTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: "恶心呕吐与胃肠反应" }));
    const asked = document.querySelector("[data-geo-question='q_1']") as HTMLElement;
    expect(within(asked).getByRole("link", { name: /^看回答/ })).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_doubao");
    await userEvent.click(screen.getByRole("button", { name: "停药与体重反弹" }));
    const never = document.querySelector("[data-geo-question='q_4']") as HTMLElement;
    expect(within(never).queryByRole("link", { name: /看回答/ })).not.toBeInTheDocument();
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
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `src_m${index}`,
    domain: `site${index}.example`,
    name: `站点${index}`,
    kind: null,
    layer: null,
    conditions: { icp: null, newsIndexed: null, medical: null },
    impostor: false,
    cited: { doubao: count - index },
    mentionsOurs: 0,
    wrongOurs: 0,
    market: null,
  }));
  const rowOf = (domain: string) => document.querySelector(`[data-geo-source='${domain}']`)?.closest("li") as HTMLElement;

  it("lists sources as rows that say the risk without opening: cited, wrong, named, in that order of weight; impostors are left out and counted", async () => {
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    renderTab(<SourcesTab {...props()} />);
    expect(await screen.findByText("3 个信源 · 已排除 1 个冒名站")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const list = screen.getByRole("list", { name: "信源" });
    expect(within(list).queryByText("某某时报网")).not.toBeInTheDocument();
    // Most cited first.
    expect(within(list).getAllByRole("listitem").map((row) => row.querySelector("[data-geo-source]")?.getAttribute("data-geo-source")))
      .toEqual(["dxy.com", "baike.baidu.com", "39.net"]);
    const baike = rowOf("baike.baidu.com");
    expect(baike).toHaveTextContent("被引用 33 次 · 有 1 处讲错 · 提到你 2 次");
    expect(within(baike).getByText("有 1 处讲错")).toHaveClass("text-danger");
    expect(within(baike).getByText("百科")).toBeInTheDocument();
    expect(within(rowOf("dxy.com")).getByText("健康媒体")).toBeInTheDocument();
    expect(within(rowOf("dxy.com")).getByText("覆盖")).toBeInTheDocument();
    expect(within(rowOf("39.net")).getByText("¥120/篇")).toBeInTheDocument();
    // The conditions are for opening the row, not for the first screen.
    expect(document.querySelector("[data-geo-condition]")).toBeNull();
    // What the page used to put under the list is on 方案 now.
    expect(screen.queryByText("预期匹配")).not.toBeInTheDocument();
    expect(screen.queryByText("主战场")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "档三" })).not.toBeInTheDocument();
  });

  it("opens a source in place to its conditions as words, merging the ones nobody checked", async () => {
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源 · 已排除 1 个冒名站");
    await userEvent.click(within(rowOf("baike.baidu.com")).getByRole("button", { name: /百度百科/ }));
    const detail = rowOf("baike.baidu.com").querySelector("[data-geo-source-detail]") as HTMLElement;
    expect(detail.querySelector("[data-geo-condition='icp:yes']")).not.toBeNull();
    expect(detail.querySelector("[data-geo-condition='newsIndexed:no']")).not.toBeNull();
    expect(detail).toHaveTextContent("医疗未核实");
    expect(detail.querySelector("[data-geo-condition='medical:unknown']")).toBeNull();
    expect(screen.getByText("“未核实”是平台还没核对这一项，不等于不满足。")).toBeInTheDocument();

    await userEvent.click(within(rowOf("39.net")).getByRole("button", { name: /39 健康网/ }));
    expect(rowOf("39.net").querySelector("[data-geo-source-detail]")).toHaveTextContent("单篇价格 ¥120");
    // One row open at a time.
    expect(rowOf("baike.baidu.com").querySelector("[data-geo-source-detail]")).toBeNull();
  });

  it("says “三项都未核实” once instead of three dashes", async () => {
    client.getGeoSources.mockResolvedValue({ ...sourcesFilled, sources: many(2) });
    renderTab(<SourcesTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: /站点0/ }));
    const detail = rowOf("site0.example").querySelector("[data-geo-source-detail]") as HTMLElement;
    expect(detail).toHaveTextContent("三项都未核实");
    expect(detail.querySelector("[data-geo-condition]")).toBeNull();
  });

  it("filters by engine, by what a site did to us, and by a word of its name or domain", async () => {
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源 · 已排除 1 个冒名站");
    await userEvent.click(screen.getByRole("button", { name: "豆包" }));
    expect(screen.queryByText("百度百科")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "全部引擎" }));

    await userEvent.click(screen.getByRole("button", { name: "只看" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "讲错过我方" }));
    expect(screen.getByRole("list", { name: "信源" }).querySelectorAll("li")).toHaveLength(1);
    expect(screen.getByText("百度百科")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^只看/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "全部信源" }));

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索信源" }), "39.NET");
    expect(screen.getByText("匹配 1 个信源 · 已排除 1 个冒名站")).toBeInTheDocument();
    expect(screen.getByText("39 健康网")).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索信源" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索信源" }), "不存在");
    expect(screen.getByText("没有包含“不存在”的信源。")).toBeInTheDocument();
  });

  it("shows 30 of a thousand sources, then 30 more at a time, and starts over when the query changes", async () => {
    client.getGeoSources.mockResolvedValue({ ...sourcesFilled, sources: many(1000) });
    renderTab(<SourcesTab {...props()} />);
    const list = await screen.findByRole("list", { name: "信源" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(30);
    expect(screen.getByText("1,000 个信源")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "显示更多 · 还有 970 个" }));
    expect(within(screen.getByRole("list", { name: "信源" })).getAllByRole("listitem")).toHaveLength(60);
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索信源" }), "site9");
    // site9, site90–99, site900–999: 111 matches, back to the first 30.
    expect(screen.getByText("匹配 111 个信源")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "信源" })).getAllByRole("listitem")).toHaveLength(30);
    expect(screen.getByRole("button", { name: "显示更多 · 还有 81 个" })).toBeInTheDocument();
  });

  it("says which engines' citations had no link instead of leaving them out silently (G8)", async () => {
    client.getGeoSources.mockResolvedValue({ ...sourcesFilled, linklessEngines: ["qianwen"] });
    renderTab(<SourcesTab {...props()} />);
    expect(await screen.findByText("千问的引用只有标题、没有链接，引用了哪些信源测不出")).toBeInTheDocument();
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
