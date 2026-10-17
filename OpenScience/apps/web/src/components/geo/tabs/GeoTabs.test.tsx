import type { ReactElement } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoProject } from "@/lib/geoClient";
import { useToastStore } from "@/lib/toast";
import {
  cell,
  diagnosisFilled,
  diagnosisWith,
  evidenceFilled,
  geoProject,
  journeyFilled,
  monitoringFilled,
  questionsFilled,
  sourceDetailOf,
  sourceHistoryOf,
  sourcePagesOf,
  sourcesFilled,
  valueFilled,
  VALUE_TITLES,
} from "../__fixtures__/geoTabs";
import { GeoFrameHarness } from "../__fixtures__/geoFrameHarness";
import { AccuracyTab } from "./AccuracyTab";
import { EvidenceTab } from "./EvidenceTab";
import { JourneyTab } from "./JourneyTab";
import { OverviewTab } from "./OverviewTab";
import { QuestionsTab } from "./QuestionsTab";
import { SourcesTab } from "./SourcesTab";
import { VisibilityTab } from "./VisibilityTab";

const client = vi.hoisted(() => ({
  getGeoValue: vi.fn<(geoId: string) => Promise<unknown>>(async () => ({ version: 0, data: {}, research: [], impacts: [], observations: [], coverage: { assessed: 0, value: null } })),
  getGeoEvidence: vi.fn(),
  getGeoJourney: vi.fn(),
  getGeoQuestions: vi.fn(),
  getGeoClusters: vi.fn(),
  getGeoActions: vi.fn(),
  unmeasureGeoQuestion: vi.fn(),
  getGeoDiagnosis: vi.fn(),
  getGeoSources: vi.fn(),
  getGeoSource: vi.fn(),
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
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <div data-testid="search">{location.search}</div>
      <div data-testid="state">{JSON.stringify(location.state ?? null)}</div>
    </>
  );
}

/** The tab in the place the layout gives it: its toolbar above it, its reads through the project's cache. */
function renderTab(tab: ReactElement) {
  const project = (tab.props as { project?: GeoProject }).project ?? geoProject();
  return render(
    <MemoryRouter initialEntries={["/app/geo/geo_1/tab"]}>
      <Routes>
        <Route path="/app/geo/geo_1/tab" element={<><GeoFrameHarness project={project}>{tab}</GeoFrameHarness><Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const props = (project: GeoProject = geoProject()) => ({ geoId: "geo_1", project });

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.getGeoValue.mockResolvedValue({ version: 0, data: {}, research: [], impacts: [], observations: [], coverage: { assessed: 0, value: null } });
  store.select.mockClear();
  download.downloadArtifact.mockClear();
  client.runGeoStep.mockResolvedValue({ sessionId: "ses_geo_1" });
  // 问题与回答 reads the groups' counts beside the question set: here, groups nobody has counted yet.
  client.getGeoClusters.mockResolvedValue({ version: 1, locked: true, floor: 30, round: null, engines: [], groups: [] });
  // 准确与安全 reads the actions beside the errors, to say where a claim's correction stands: here, none yet; and the question set,
  // to say which group a claim was told in.
  client.getGeoQuestions.mockResolvedValue({ sets: [], version: null, groups: [] });
  client.getGeoActions.mockResolvedValue({ version: null, tier: "2", round: null, floor: 30, headline: { actedGroups: 0, gapGroupsNotActedOn: 0, arm: null, sentence: "" }, counts: { total: 0, byKind: {}, byStatus: {}, gapsWithoutEntry: 0 }, actions: [], control: [], noAction: [], unmatched: [] });
});

describe("a tab with nothing yet", () => {
  it("says what is being done while the step is being worked on, and offers nothing to press", async () => {
    client.getGeoEvidence.mockResolvedValue({ product: {}, competitors: [], claims: [] });
    renderTab(<EvidenceTab {...props(geoProject({ evidence: "running" }))} />);
    expect(await screen.findByText("正在整理产品证据")).toBeInTheDocument();
    expect(screen.queryByText("正在进行，做完会显示在这里。")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "整理产品证据" })).not.toBeInTheDocument();
  });

  // An empty state is a recipe (rule 8): what the step uses — each a way to the thing — what it gives, and one button naming the work.
  it.each([
    ["evidence", "整理产品证据", EvidenceTab, () => client.getGeoEvidence.mockResolvedValue({ product: {}, competitors: [], claims: [] })],
    ["journey", "绘制患者旅程", JourneyTab, () => client.getGeoJourney.mockResolvedValue({ subtypes: [], personas: [], stages: [], careNodes: [], files: [] })],
    ["questions", "列出测量问题", QuestionsTab, () => client.getGeoQuestions.mockResolvedValue({ sets: [], version: null, groups: [] })],
    ["sources", "分析引用的信源", SourcesTab, () => client.getGeoSources.mockResolvedValue({ sources: [], expectations: [], battlefield: null, tiers: [], chosenTier: null })],
  ] as const)("%s: a finished step with nothing to show is a recipe with one button, %s, which starts it and keeps the person here", async (step, verb, Tab, arrange) => {
    arrange();
    renderTab(<Tab {...props(geoProject({ [step]: "done" }))} />);
    const button = await screen.findByRole("button", { name: verb });
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
    await userEvent.click(button);
    await waitFor(() => expect(client.runGeoStep).toHaveBeenCalledWith("geo_1", step));
    // Starting work takes nobody anywhere: no conversation is opened and the address does not change.
    expect(store.select).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/tab");
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

  it("filters by source kind, and opens a claim in a drawer with its quotation and what it stands on", async () => {
    client.getGeoEvidence.mockResolvedValue(evidenceFilled);
    renderTab(<EvidenceTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: "临床试验" }));
    expect(screen.queryByText("每周一次皮下注射，从低剂量起始，按说明书逐步增加剂量。")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "全部" }));
    await userEvent.click(screen.getByRole("button", { name: /每周一次皮下注射，从低剂量起始，按说明书逐步增加剂量。/ }));
    const drawer = screen.getByRole("dialog", { name: "结论" });
    expect(within(drawer).getByText("本品每周注射一次。")).toBeInTheDocument();
    expect(within(drawer).getByText("出处类型")).toBeInTheDocument();
    // The list under the drawer does not carry the quotation in place any more.
    expect(screen.getAllByText("本品每周注射一次。")).toHaveLength(1);
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

  it("shows the people the server stores as objects, and still reads an older journey's plain strings", async () => {
    client.getGeoJourney.mockResolvedValue({
      ...journeyFilled,
      subtypes: [{ name: "BMI≥28 的成人肥胖", definition: "合并至少一种代谢并发症", size: "约 30%", sizeQuality: "估计" }, "旧版写法的分型", { definition: "没有名字的分型" }],
      personas: [{ name: "王女士", age: "35", situation: ["上班族", "想减重又怕副作用"], voice: "打了会不会一直恶心" }],
    });
    renderTab(<JourneyTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: "人群" }));
    expect(screen.getByText("BMI≥28 的成人肥胖")).toBeInTheDocument();
    expect(screen.getByText("合并至少一种代谢并发症 · 约 30% · 估计")).toBeInTheDocument();
    expect(screen.getByText("旧版写法的分型")).toBeInTheDocument();
    expect(screen.queryByText("没有名字的分型")).toBeNull();
    expect(screen.getByText("王女士")).toBeInTheDocument();
    expect(screen.getByText("35 · 上班族；想减重又怕副作用 · “打了会不会一直恶心”")).toBeInTheDocument();
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

  const header = () => screen.getByRole("group", { name: "按数字排序" });
  const order = () => within(screen.getByRole("list", { name: "信源" })).getAllByRole("listitem")
    .map((row) => row.querySelector("[data-geo-source]")?.getAttribute("data-geo-source"));
  const cellOf = (domain: string, key: string) => rowOf(domain).querySelector(`[data-list-cell='${key}']`) as HTMLElement;
  const valueOf = (domain: string, key: string) => cellOf(domain, key).querySelector("[data-list-value]")?.textContent;

  it("lists sources as rows of a name, a kind and a domain with three counted columns under named headers; impostors are left out", async () => {
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    renderTab(<SourcesTab {...props()} />);
    // The count line says one thing; the impostor site is in the fold at the foot of the page.
    expect(await screen.findByText("3 个信源")).toBeInTheDocument();
    expect(screen.queryByText(/已排除/)).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const list = screen.getByRole("list", { name: "信源" });
    expect(within(list).queryByText("某某时报网")).not.toBeInTheDocument();
    expect(screen.getByText("冒名站")).toBeInTheDocument();
    // Most cited first, the headers naming the three columns in the rows' order.
    expect(order()).toEqual(["dxy.com", "baike.baidu.com", "39.net"]);
    expect(within(header()).getAllByRole("button").map((button) => button.textContent)).toEqual(["被引用", "讲错的回答", "提到你"]);
    const baike = rowOf("baike.baidu.com");
    expect(["cited", "wrong", "mentions"].map((key) => valueOf("baike.baidu.com", key))).toEqual(["33", "1", "2"]);
    // Red is one count, and only when there is something in it.
    expect(cellOf("baike.baidu.com", "wrong")).toHaveClass("text-danger");
    expect(cellOf("dxy.com", "wrong")).not.toHaveClass("text-danger");
    expect(cellOf("dxy.com", "wrong")).not.toBeInstanceOf(HTMLButtonElement);
    expect(cellOf("baike.baidu.com", "wrong")).toBeInstanceOf(HTMLButtonElement);
    // The old sentence that read as the site's doing is gone; the name, the kind and the domain share the line.
    expect(baike).not.toHaveTextContent("处讲错");
    expect(within(baike).getByText("百科")).toBeInTheDocument();
    expect(within(baike).getByText("baike.baidu.com")).toHaveClass("text-text-3");
    expect(within(rowOf("dxy.com")).getByText("健康媒体")).toBeInTheDocument();
    // Tier words and prices are the drawer's; the row keeps 自有 alone.
    expect(within(rowOf("dxy.com")).queryByText("覆盖")).not.toBeInTheDocument();
    expect(within(rowOf("39.net")).queryByText("120 灵豆/篇")).not.toBeInTheDocument();
    expect(document.querySelector("[data-geo-condition]")).toBeNull();
    // A row that opens something says so, and shows it under the pointer.
    expect(rowOf("baike.baidu.com").className).toMatch(/hover:bg-surface-2/);
    // What the page used to put under the list is on 方案 now.
    expect(screen.queryByText("预期匹配")).not.toBeInTheDocument();
    expect(screen.queryByText("主战场")).not.toBeInTheDocument();
  });

  it("marks a site of our own with 自有 on its row and names no other layer there", async () => {
    client.getGeoSources.mockResolvedValue({ ...sourcesFilled, sources: [{ ...sourcesFilled.sources[0], layer: "owned" }, sourcesFilled.sources[2]] });
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("2 个信源");
    expect(within(rowOf("dxy.com")).getByText("自有")).toBeInTheDocument();
    expect(within(rowOf("39.net")).queryByText("覆盖")).not.toBeInTheDocument();
  });

  it("opens a source in a drawer listing the answers its row counts: as many misstating answers as the red number, each the way into its page", async () => {
    const baike = sourcesFilled.sources[1];
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    client.getGeoSource.mockResolvedValue(sourceDetailOf(baike));
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
    const rowWrong = Number(valueOf("baike.baidu.com", "wrong"));
    await userEvent.click(within(rowOf("baike.baidu.com")).getByRole("button", { name: /百度百科/ }));
    const dialog = await screen.findByRole("dialog", { name: "百度百科" });
    expect(client.getGeoSource).toHaveBeenCalledWith("geo_1", "src_2", null);
    // Header: the site, its domain as an outside link, its kind.
    const link = within(dialog).getByRole("link", { name: /baike\.baidu\.com/ });
    expect(link).toHaveAttribute("href", "https://baike.baidu.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(dialog).toHaveTextContent("百科");
    // The count the drawer shows, the answers it lists and the number on the row are one number.
    const wrongSection = (await within(dialog).findByRole("region", { name: "讲错的回答" }));
    expect(wrongSection.querySelector("[data-geo-source-count='wrong']")).toHaveTextContent(String(rowWrong));
    expect(wrongSection.querySelectorAll("[data-geo-source-answer]")).toHaveLength(rowWrong);
    // Misstating answers lead; each is “引擎 · 问题 · 日期”, the wrong sentence under it drawn as the answer page draws it.
    const first = wrongSection.querySelector("[data-geo-source-answer]") as HTMLElement;
    expect(first).toHaveTextContent("DeepSeek · 第 1 个问题 · 10月13日");
    expect(first).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_src_2_0");
    const sentence = wrongSection.querySelector("[data-geo-source-wrong]") as HTMLElement;
    expect(sentence).toHaveTextContent("第 1 句讲错的话");
    expect(sentence).toHaveClass("underline", "decoration-danger", "decoration-wavy");
    expect(within(wrongSection).getByText("出自这个站")).toBeInTheDocument();
    // The other answers follow, the ones that name us marked, every one a link to its page.
    const others = within(dialog).getByRole("region", { name: "其他回答" });
    expect(others.querySelector("[data-geo-source-count='others']")).toHaveTextContent(String(33 - rowWrong));
    expect(within(others).getAllByText("提到你")).toHaveLength(1);
    for (const answer of dialog.querySelectorAll("[data-geo-source-answer]")) expect(answer.getAttribute("href")).toMatch(/^\/app\/geo\/geo_1\/answers\/snap_src_2_/);
    // 显示更多 keeps a long list short.
    expect(others.querySelectorAll("[data-geo-source-answer]")).toHaveLength(10);
    // The last thing it says: the conditions the platform knows, as words. A condition it has not checked is not listed, and nothing says so
    // (owner ruling 2026-10-10: "not verified" is the platform's bookkeeping, not a line on a site's page).
    const conditions = dialog.querySelector("[data-geo-source-detail]") as HTMLElement;
    expect(conditions.querySelector("[data-geo-condition='icp:yes']")).not.toBeNull();
    expect(conditions.querySelector("[data-geo-condition='newsIndexed:no']")).not.toBeNull();
    expect(conditions.querySelector("[data-geo-condition='medical:unknown']")).toBeNull();
    expect(dialog).not.toHaveTextContent(/未核实/);
    expect(within(dialog).getByRole("button", { name: "在对话中处理" })).toBeInTheDocument();
    // The expansion in the row is gone.
    expect(rowOf("baike.baidu.com").querySelector("[data-geo-source-detail]")).toBeNull();
  });

  it("pressing the red count opens the same drawer and rests on the answers it counts", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      client.getGeoSources.mockResolvedValue(sourcesFilled);
      client.getGeoSource.mockResolvedValue(sourceDetailOf(sourcesFilled.sources[1]));
      renderTab(<SourcesTab {...props()} />);
      await screen.findByText("3 个信源");
      await userEvent.click(within(rowOf("baike.baidu.com")).getByRole("button", { name: /讲错的回答/ }));
      const dialog = await screen.findByRole("dialog", { name: "百度百科" });
      const section = await within(dialog).findByRole("region", { name: "讲错的回答" });
      await waitFor(() => expect(scrolled.mock.contexts).toContain(section));
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("lists the answers that cite a site nothing misstated, with its conditions after them", async () => {
    const dxy = sourcesFilled.sources[0];
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    client.getGeoSource.mockResolvedValue(sourceDetailOf(dxy));
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
    await userEvent.click(within(rowOf("dxy.com")).getByRole("button", { name: /丁香医生/ }));
    const dialog = await screen.findByRole("dialog", { name: "丁香医生" });
    const all = await within(dialog).findByRole("region", { name: "引用它的回答" });
    expect(all.querySelectorAll("[data-geo-source-answer]").length).toBeGreaterThan(0);
    expect(within(dialog).queryByRole("region", { name: "讲错的回答" })).not.toBeInTheDocument();
    expect(dialog.querySelector("[data-geo-source-wrong]")).toBeNull();
    expect(dialog.querySelector("[data-geo-source-tier]")).toHaveTextContent("层级 覆盖");
    expect(dialog.querySelector("[data-geo-source-counts]")).toHaveTextContent("48 个回答引用了这个站，其中 0 个讲错了信尔美");
  });

  it("says so when the latest round has no answer citing the site, and when nothing has been measured", async () => {
    const dxy = sourcesFilled.sources[0];
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    client.getGeoSource.mockResolvedValue({ ...sourceDetailOf(dxy), counts: { cited: 0, wrongOurs: 0, mentionsOurs: 0 }, answers: [] });
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
    await userEvent.click(within(rowOf("dxy.com")).getByRole("button", { name: /丁香医生/ }));
    expect(await screen.findByText("最近一轮测量（10月13日）里，没有回答引用这个站。")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    client.getGeoSource.mockResolvedValue({ ...sourceDetailOf(dxy), round: null, counts: { cited: 0, wrongOurs: 0, mentionsOurs: 0 }, answers: [] });
    await userEvent.click(within(rowOf("dxy.com")).getByRole("button", { name: /丁香医生/ }));
    expect(await screen.findByText(/还没有完成的测量/)).toBeInTheDocument();
    // The conditions are still the last thing it says.
    expect(within(screen.getByRole("dialog")).getByRole("region", { name: "投放条件" })).toBeInTheDocument();
  });

  it("hands a draft with the domain and the wrong sentences to the project's conversation, and sends nothing", async () => {
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    client.getGeoSource.mockResolvedValue(sourceDetailOf(sourcesFilled.sources[1]));
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
    await userEvent.click(within(rowOf("baike.baidu.com")).getByRole("button", { name: /百度百科/ }));
    const dialog = await screen.findByRole("dialog", { name: "百度百科" });
    await within(dialog).findByRole("region", { name: "讲错的回答" });
    await userEvent.click(within(dialog).getByRole("button", { name: "在对话中处理" }));
    await waitFor(() => expect(store.select).toHaveBeenCalledWith("prj_geo_1", expect.any(Function)));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
    // The draft waits in the composer: the intent carries it, and nothing asks the model.
    const state = JSON.parse(screen.getByTestId("state").textContent ?? "null") as { runtimeUiIntent?: { draft?: string } } | null;
    const draft = state?.runtimeUiIntent?.draft ?? "";
    expect(draft).toContain("baike.baidu.com");
    expect(draft).toContain("第 1 句讲错的话");
    expect(draft).toContain("1 个讲错了信尔美");
    expect(client.runGeoStep).not.toHaveBeenCalled();
  });

  it("lists the pages of the site that were cited, an outside link each with its title and how many answers cited it; the most cited eight, then all", async () => {
    const baike = sourcesFilled.sources[1];
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    client.getGeoSource.mockResolvedValue({ ...sourceDetailOf(baike), pages: sourcePagesOf("baike.baidu.com", 11), pagesTotal: 11 });
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
    await userEvent.click(within(rowOf("baike.baidu.com")).getByRole("button", { name: /百度百科/ }));
    const dialog = await screen.findByRole("dialog", { name: "百度百科" });
    const section = await within(dialog).findByRole("region", { name: "被引用的页面" });
    expect(section.querySelector("[data-geo-source-count='pages']")).toHaveTextContent("11");
    // Eight to begin with, in the order the server gave: the most cited first.
    const links = () => [...section.querySelectorAll<HTMLAnchorElement>("a[data-geo-source-page]")];
    expect(links()).toHaveLength(8);
    expect(links()[0]).toHaveAttribute("href", "https://www.baike.baidu.com/p/1");
    expect(links()[0]).toHaveAttribute("target", "_blank");
    expect(links()[0]).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    expect(links()[0]).toHaveTextContent("第 1 个页面");
    // A page with no title is its address; one with a title keeps its address under it.
    expect(links()[2]).toHaveTextContent("baike.baidu.com/p/3");
    expect(links()[2]).not.toHaveTextContent("第 3 个页面");
    expect(section.querySelector("[data-geo-source-page='https://www.baike.baidu.com/p/1']")?.closest("li")).toHaveTextContent("baike.baidu.com/p/1");
    // How many answers cited a page, and how many of those misstated us: the two columns the drawer's lists use.
    const first = section.querySelector("[data-geo-source-page='https://www.baike.baidu.com/p/1']")?.closest("li") as HTMLElement;
    expect(first.querySelector("[data-list-cell='cited'] [data-list-value]")).toHaveTextContent("11");
    expect(first.querySelector("[data-list-cell='wrong'] [data-list-value]")).toHaveTextContent("2");
    expect(first.querySelector("[data-list-cell='wrong']")).toHaveClass("text-danger");
    expect(section.querySelectorAll("[data-list-cell='wrong'].text-danger")).toHaveLength(1);
    await userEvent.click(within(section).getByRole("button", { name: "显示全部 11 个" }));
    expect(links()).toHaveLength(11);
    await userEvent.click(within(section).getByRole("button", { name: "收起" }));
    expect(links()).toHaveLength(8);
  });

  it("draws no page list for a site with no cited page, and says when the list is only the most cited of more", async () => {
    const dxy = sourcesFilled.sources[0];
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    client.getGeoSource.mockResolvedValue({ ...sourceDetailOf(dxy), pages: [], pagesTotal: 0 });
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
    await userEvent.click(within(rowOf("dxy.com")).getByRole("button", { name: /丁香医生/ }));
    const dialog = await screen.findByRole("dialog", { name: "丁香医生" });
    await within(dialog).findByRole("region", { name: "引用它的回答" });
    expect(within(dialog).queryByRole("region", { name: "被引用的页面" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    client.getGeoSource.mockResolvedValue({ ...sourceDetailOf(dxy), pages: sourcePagesOf("dxy.com", 3), pagesTotal: 250 });
    await userEvent.click(within(rowOf("dxy.com")).getByRole("button", { name: /丁香医生/ }));
    expect(await screen.findByText("只列出被引用最多的 3 个，共 250 个页面。")).toBeInTheDocument();
  });

  it("shows the site's counts across the last rounds, and compares only the rounds measured over the same thing: a rule where the engine set changed, no change stated across it", async () => {
    const baike = sourcesFilled.sources[1];
    const two = "v1|P1,P2|deepseek,kimi|web";
    const three = "v1|P1,P2|deepseek,doubao,kimi|web";
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    client.getGeoSource.mockResolvedValue({ ...sourceDetailOf(baike), history: sourceHistoryOf([["07", 12, 1, two], ["14", 14, 2, two], ["21", 30, 5, three], ["28", 33, 1, three]]) });
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
    await userEvent.click(within(rowOf("baike.baidu.com")).getByRole("button", { name: /百度百科/ }));
    const dialog = await screen.findByRole("dialog", { name: "百度百科" });
    const section = await within(dialog).findByRole("region", { name: "近几轮" });
    const table = within(section).getByRole("table");
    const cells = (kind: string) => [...table.querySelectorAll(`[data-geo-history='${kind}']`)].map((cell) => cell.textContent);
    expect(cells("cited")).toEqual(["12", "14", "30", "33"]);
    expect(cells("wrong")).toEqual(["1", "2", "5", "1"]);
    expect([...table.querySelectorAll("thead th[data-geo-history-round]")].map((head) => head.firstChild?.textContent)).toEqual(["9月7日", "9月14日", "9月21日", "9月28日"]);
    // The rule stands before the round whose coverage differs, and the screen reader hears why; no other column has one.
    const heads = [...table.querySelectorAll("thead th[data-geo-history-round]")];
    expect(heads.map((head) => head.className.includes("border-l"))).toEqual([false, false, true, false]);
    expect(heads[2]).toHaveTextContent("测量范围有变化，不与前一轮比较");
    expect(section.querySelector("[data-geo-history-break]")).toHaveTextContent("竖线两侧的轮次测量范围不同，不互相比较。");
    // The latest round against the one before it — the same coverage — is compared, by the one reading.
    expect(section.querySelector("[data-geo-history-note]")).toHaveTextContent("较上一轮（9月21日）：被引用多 3 个，讲错的回答少 4 个");
  });

  it("states that the latest round is not compared when the engine set changed in it, and never writes a change across it", async () => {
    const baike = sourcesFilled.sources[1];
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    client.getGeoSource.mockResolvedValue({ ...sourceDetailOf(baike), history: sourceHistoryOf([["14", 14, 2, "v1|P1|deepseek,kimi|web"], ["21", 30, 5, "v1|P1|deepseek,doubao,kimi|web"]]) });
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
    await userEvent.click(within(rowOf("baike.baidu.com")).getByRole("button", { name: /百度百科/ }));
    const section = await within(await screen.findByRole("dialog", { name: "百度百科" })).findByRole("region", { name: "近几轮" });
    expect(section.querySelector("[data-geo-history-note]")).toHaveTextContent("引擎范围有变化，不与上一轮比较");
    expect(section.textContent).not.toMatch(/较上一轮|多 \d+ 个|少 \d+ 个/);
  });

  it("draws no trend from a single round, or for a site no round cited", async () => {
    const dxy = sourcesFilled.sources[0];
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    client.getGeoSource.mockResolvedValue({ ...sourceDetailOf(dxy), history: sourceHistoryOf([["21", 48, 0, "v1|P1|deepseek|web"]]) });
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
    await userEvent.click(within(rowOf("dxy.com")).getByRole("button", { name: /丁香医生/ }));
    const dialog = await screen.findByRole("dialog", { name: "丁香医生" });
    await within(dialog).findByRole("region", { name: "引用它的回答" });
    expect(within(dialog).queryByRole("region", { name: "近几轮" })).not.toBeInTheDocument();
  });

  it("sorts by a column header: the most cited first, then the most misstating, again to reverse; the paging starts over", async () => {
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
    expect(within(header()).getByRole("button", { name: /按被引用排序，当前从多到少/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(header()).getByRole("button", { name: "按讲错的回答排序" }));
    // The one that misstated us leads; the rest keep the order of how often they were cited.
    expect(order()).toEqual(["baike.baidu.com", "dxy.com", "39.net"]);
    expect(within(header()).getByRole("button", { name: /按讲错的回答排序，当前从多到少/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(header()).getByRole("button", { name: /按讲错的回答排序/ }));
    expect(order()).toEqual(["dxy.com", "39.net", "baike.baidu.com"]);
    await userEvent.click(within(header()).getByRole("button", { name: "按提到你排序" }));
    expect(order()[0]).toBe("baike.baidu.com");
  });

  it("narrows every column and the drawer to the engine the page is filtered to", async () => {
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    client.getGeoSource.mockResolvedValue(sourceDetailOf(sourcesFilled.sources[1], { engine: "deepseek" }));
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
    await userEvent.click(screen.getByRole("button", { name: "DeepSeek" }));
    expect(order()).toEqual(["baike.baidu.com", "dxy.com"]);
    expect([valueOf("dxy.com", "cited"), valueOf("dxy.com", "wrong")]).toEqual(["18", "0"]);
    await userEvent.click(within(rowOf("baike.baidu.com")).getByRole("button", { name: /百度百科/ }));
    await screen.findByRole("dialog", { name: "百度百科" });
    expect(client.getGeoSource).toHaveBeenCalledWith("geo_1", "src_2", "deepseek");
    expect(await screen.findByText(/只看 ?DeepSeek/)).toBeInTheDocument();
  });

  it("lists no condition the platform has not checked, and says nothing of it, in the drawer", async () => {
    const rows = many(2);
    client.getGeoSources.mockResolvedValue({ ...sourcesFilled, sources: rows });
    client.getGeoSource.mockResolvedValue(sourceDetailOf(rows[0] as never));
    renderTab(<SourcesTab {...props()} />);
    await userEvent.click(await screen.findByRole("button", { name: /站点0/ }));
    const dialog = await screen.findByRole("dialog", { name: "站点0" });
    expect(dialog).not.toHaveTextContent(/未核实/);
    expect(dialog.querySelector("[data-geo-condition]")).toBeNull();
  });

  it("filters by engine, by what a site did to us, and by a word of its name or domain", async () => {
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
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
    expect(screen.getByText("匹配 1 个信源")).toBeInTheDocument();
    expect(screen.getByText("39 健康网")).toBeInTheDocument();
    // The box can be emptied from itself: the clear button, and Escape.
    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getByText("3 个信源")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索信源" }), "不存在");
    expect(screen.getByText("没有包含“不存在”的信源。")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByText("3 个信源")).toBeInTheDocument();
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

/** A project whose index fell from 46.4 to 44 between two full measurements, the mention rate by two points (inside its ±3 band). */
function fallingProject() {
  const base = geoProject();
  return geoProject({}, {
    overview: {
      ...base.overview,
      metrics: [
        { key: "gvi", cell: cell(44, null, 310), target: 50, trend: [{ date: "2026-09-25", value: 46.4, n: 310 }, { date: "2026-10-12", value: 44, n: 310 }] },
        { key: "mention", cell: cell(23, 71, 310), target: 35, trend: [{ date: "2026-09-25", value: 21, n: 310 }, { date: "2026-10-12", value: 23, n: 310 }] },
        { key: "accuracy", cell: cell(92, 285, 310), target: 98, trend: [] },
        { key: "citation", cell: cell(6, 2, 24), target: 20, trend: [{ date: "2026-09-25", value: 30, n: 120 }, { date: "2026-10-12", value: 6, n: 24 }] },
      ],
    },
  });
}
const fallingMonitoring = {
  ...monitoringFilled,
  series: [
    { key: "gvi", points: [{ date: "2026-09-25", value: 46.4, n: 310, k: null }, { date: "2026-10-12", value: 44, n: 310, k: null }] },
    { key: "mention", points: [{ date: "2026-09-25", value: 21, n: 310, k: 65 }, { date: "2026-10-12", value: 23, n: 310, k: 71 }] },
  ],
  next: { date: "2026-10-19", kind: "weekly" },
};

/** The same fall, but the engines that answered changed between the two rounds: 豆包 joined the sample (R14 N-4). */
const TWO_ENGINES = "v1|P1,P2,P3,P4|deepseek,kimi|web";
const THREE_ENGINES = "v1|P1,P2,P3,P4|deepseek,doubao,kimi|web";
function enginesChangedProject() {
  const base = fallingProject();
  const withKeys = (trend: Array<{ date: string; value: number | null; n?: number | null }>) => trend.map((point, index) => ({ ...point, coverage: index === trend.length - 1 ? THREE_ENGINES : TWO_ENGINES }));
  return geoProject({}, {
    overview: {
      ...base.overview,
      metrics: base.overview.metrics.map((metric) => ({
        ...metric,
        // The accuracy rate has two readings here, so its tile has a change to state — or not to state.
        trend: withKeys(metric.key === "accuracy" ? [{ date: "2026-09-25", value: 95, n: 310 }, { date: "2026-10-12", value: 92, n: 310 }] : metric.trend),
      })),
    },
  });
}
const enginesChangedMonitoring = {
  ...fallingMonitoring,
  series: fallingMonitoring.series.map((line) => ({ ...line, points: line.points.map((point, index) => ({ ...point, coverage: index === line.points.length - 1 ? THREE_ENGINES : TWO_ENGINES })) })),
};
const NOT_COMPARED = "引擎范围有变化，不与上一轮比较";

describe("准确与安全：事实准确率", () => {
  it("an engine-set change leaves the accuracy tile with no arrow and the band with one plain statement", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    renderTab(<AccuracyTab {...props(enginesChangedProject())} />);
    const accuracy = await screen.findByRole("group", { name: "事实准确率" });
    expect(accuracy.querySelector("[data-delta]")).toBeNull();
    const band = screen.getByRole("region", { name: "准确与安全" });
    expect(band.textContent?.split(NOT_COMPARED).length).toBe(2);
    expect(document.body.textContent).not.toMatch(/[▲▼]/);
  });
});

describe("总览", () => {
  it("says one change in one word wherever it says it: the sentence, the tile, the chart's heading, and 可见度 (G02)", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(fallingMonitoring);
    const overview = renderTab(<OverviewTab {...props(fallingProject())} />);
    expect(await screen.findByText(/综合可见度 44，比上次低 2，目标 50/)).toBeInTheDocument();
    const tile = screen.getByRole("group", { name: "综合可见度指数" });
    expect(tile.querySelector("[data-delta='down']")).toHaveTextContent("2");
    const title = await screen.findByRole("heading", { name: "综合可见度指数 44，比上次低 2" });
    // The chart says which readings it compares and when the next is.
    expect(title.parentElement).toHaveTextContent("上次 9月25日 · 下次 10月19日");
    // The mention rate moved two points inside its measured band of ±3: flat, on its tile.
    expect(screen.getByRole("group", { name: "品类问题可见率" }).querySelector("[data-delta='flat']")).not.toBeNull();
    overview.unmount();

    renderTab(<VisibilityTab {...props(fallingProject())} />);
    const same = await screen.findByRole("heading", { name: /综合可见度指数 44，/ });
    expect(same).toHaveTextContent("综合可见度指数 44，比上次低 2");
    expect(same.parentElement).toHaveTextContent("上次 9月25日 · 下次 10月19日");
  });

  it("an engine-set change shows no ▲ or ▼ anywhere on 总览: not on a tile, not in the sentence, the chart or the band — one plain statement instead", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(enginesChangedMonitoring);
    renderTab(<OverviewTab {...props(enginesChangedProject())} />);
    // The sentence at the top, and the chart's heading, say it in the place a change would stand.
    expect(await screen.findByText(new RegExp(`综合可见度 44，${NOT_COMPARED}，目标 50`))).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: `综合可见度指数 44，${NOT_COMPARED}` })).toBeInTheDocument();
    // No tile has a change: no ▲ or ▼, no 持平 either (it is not a comparison that came out level).
    expect(document.querySelectorAll("[data-delta]")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/[▲▼]/);
    expect(document.body.textContent).not.toMatch(/比上次(高|低)|与上次持平/);
    // The band says it once, with its denominator, in the same words.
    const band = screen.getByRole("region", { name: "本轮指标" });
    expect(band.textContent?.split(NOT_COMPARED).length).toBe(2);
    // A tile's line starts where the coverage changed: the one reading measured over what the latest was, not a line across the change.
    expect(screen.getByRole("group", { name: "品类问题可见率" }).querySelector("[data-geo-readings]")?.getAttribute("data-geo-readings")).toBe("1");
  });

  it("an engine-set change on 可见度 titles the chart with the statement, and no arrow is drawn", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(enginesChangedMonitoring);
    renderTab(<VisibilityTab {...props(enginesChangedProject())} />);
    const title = await screen.findByRole("heading", { name: /综合可见度指数 44，/ });
    expect(title).toHaveTextContent(`综合可见度指数 44，${NOT_COMPARED}`);
    expect(title.parentElement).toHaveTextContent("上次 9月25日 · 下次 10月19日");
    await userEvent.click(screen.getByRole("button", { name: "品类问题可见率" }));
    expect(await screen.findByRole("heading", { name: `品类问题可见率 23%，${NOT_COMPARED}` })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[▲▼]/);
  });

  it("the same two readings with the same engines are still compared: the arrow is there", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(fallingMonitoring);
    const base = fallingProject();
    const same = geoProject({}, { overview: { ...base.overview, metrics: base.overview.metrics.map((metric) => ({ ...metric, trend: metric.trend.map((point) => ({ ...point, coverage: TWO_ENGINES })) })) } });
    renderTab(<OverviewTab {...props(same)} />);
    expect(await screen.findByText(/综合可见度 44，比上次低 2，目标 50/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "综合可见度指数" }).querySelector("[data-delta='down']")).not.toBeNull();
    expect(document.body.textContent).not.toContain(NOT_COMPARED);
  });

  it("applies the mention rate's band to the mention rate on 可见度 as well, and to nothing else", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(fallingMonitoring);
    renderTab(<VisibilityTab {...props(fallingProject())} />);
    await screen.findByRole("heading", { name: /综合可见度指数 44/ });
    await userEvent.click(screen.getByRole("button", { name: "品类问题可见率" }));
    expect(await screen.findByRole("heading", { name: "品类问题可见率 23%，与上次持平" })).toBeInTheDocument();
  });

  it("draws no line for a tile that reads 样本不足 — the words and a falling line would say two things", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(fallingMonitoring);
    renderTab(<OverviewTab {...props(fallingProject())} />);
    const citation = await screen.findByRole("group", { name: "引用命中率" });
    expect(citation).toHaveTextContent("样本不足");
    expect(citation.querySelector("[data-geo-sparkline]")).toBeNull();
    expect(screen.getByRole("group", { name: "品类问题可见率" }).querySelector("[data-geo-sparkline]")).not.toBeNull();
  });

  it("holds the sentence's line until the open errors are counted, so no 「还有 N 条」 pops in under a quiet page", async () => {
    let release: (value: typeof diagnosisFilled) => void = () => undefined;
    client.getGeoDiagnosis.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    client.getGeoMonitoring.mockResolvedValue(fallingMonitoring);
    renderTab(<OverviewTab {...props(fallingProject())} />);
    expect(await screen.findByRole("status", { name: "正在读取" })).toBeInTheDocument();
    expect(screen.queryByText(/综合可见度 44/)).not.toBeInTheDocument();
    release(diagnosisWith([{ ...diagnosisFilled.errors[0], severity: "S3", status: "open" }]));
    expect(await screen.findByText(/综合可见度 44，比上次低 2，目标 50.*；还有 1 条严重讲错待处理。/)).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "正在读取" })).not.toBeInTheDocument();
  });

  // R19 audit C 1.5: 「下一步」 listed what was DONE. 「需要你」 is what the server asks of the person — a verb and the object it opens.
  it("lists what is asked of the person before the trend: the budget, the articles to release, the worst wrong statements, the client's to-dos", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(fallingMonitoring);
    const asked = fallingProject();
    asked.needsYou = [
      { kind: "set_budget", key: "budget", verb: "set", object: { type: "budget", id: "geo_1" }, target: { tab: "actions", section: "budget" } },
      { kind: "release_articles", key: "release", verb: "review", object: { type: "articles", ids: ["art_1", "art_2"] }, count: 2, target: { tab: "actions", section: "review" } },
      { kind: "correct_severe_error", key: "error:err_9", verb: "correct", object: { type: "error", id: "err_9" }, severity: "S3", engine: "deepseek",
        statement: "每天注射一次", target: { tab: "accuracy", errorId: "err_9", snapshotId: "snap_9" } },
      { kind: "client_action", key: "client:0a1b2c3d", verb: "do", object: { type: "client_action" }, text: "开通并认证自有微信公众号", target: { tab: "plan", section: "client_actions" } },
    ];
    renderTab(<OverviewTab {...props(asked)} />);
    const heading = await screen.findByRole("heading", { name: "需要你" });
    const list = within(heading.closest("section") as HTMLElement).getByRole("list", { name: "需要你处理的事" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(list).getByRole("button", { name: /设置投放预算/ })).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: /放行 2 篇稿件/ })).toHaveAttribute("href", "/app/geo/geo_1/actions#geo-review");
    expect(within(list).getByRole("link", { name: /每天注射一次/ })).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_9");
    expect(within(list).getByRole("link", { name: /开通并认证自有微信公众号/ })).toHaveAttribute("href", "/app/geo/geo_1/plan#geo-client-actions");
    // Nothing that is done is listed: no 「已完成」, no 「下一步」.
    expect(screen.queryByRole("heading", { name: "下一步" })).not.toBeInTheDocument();
    expect(within(list).queryByText(/已完成/)).not.toBeInTheDocument();
    // It comes before the trend.
    const trend = await screen.findByRole("heading", { name: /综合可见度指数 44，/ });
    expect(heading.compareDocumentPosition(trend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The wrong statement carries its correction, with the sentence in the draft; the project's conversation is opened with it unsent.
    await userEvent.click(within(list).getByRole("button", { name: "写纠错稿" }));
    await waitFor(() => expect(store.select).toHaveBeenCalled());
    expect(await screen.findByTestId("state")).toHaveTextContent("每天注射一次");
  });

  it("draws no 「需要你」 where nothing is asked, and no list of the wrong statements: those are 准确与安全's", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(fallingMonitoring);
    renderTab(<OverviewTab {...props(fallingProject())} />);
    await screen.findByRole("heading", { name: /综合可见度指数 44，/ });
    expect(screen.queryByRole("heading", { name: "需要你" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-geo-error]")).toBeNull();
    // The engine matrix is 可见度's, and the value analysis is 依据's.
    expect(document.querySelector("[data-heat-row]")).toBeNull();
    expect(screen.queryByRole("heading", { name: "药品价值与机会" })).not.toBeInTheDocument();
  });

  it("says each number as where it began, where it is and where it is meant to be — a target already passed reads as reached", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(fallingMonitoring);
    const project = fallingProject();
    // 品类问题可见率 stands at 21 against a target of 12.
    project.overview.metrics = project.overview.metrics.map((metric) => (metric.key === "mention"
      ? { ...metric, target: 12, cell: cell(21, 65, 310), trend: [{ date: "2026-09-25", value: 9, n: 310 }, { date: "2026-10-12", value: 21, n: 310 }] }
      : metric));
    renderTab(<OverviewTab {...props(project)} />);
    const tile = await screen.findByRole("group", { name: "品类问题可见率" });
    expect(tile).toHaveTextContent("基线 9% · 9月25日");
    expect(tile).toHaveTextContent("已达到目标 12%");
    // A figure opens the tab that holds what it counts.
    expect(within(tile).getByRole("link", { name: /品类问题可见率 21，查看/ })).toHaveAttribute("href", "/app/geo/geo_1/visibility");
    expect(within(screen.getByRole("group", { name: "事实准确率" })).getByRole("link")).toHaveAttribute("href", "/app/geo/geo_1/accuracy");
  });

  it("draws no empty card for a ranking nobody measured, and gives the trend its width", async () => {
    client.getGeoDiagnosis.mockResolvedValue({ ...diagnosisFilled, byPool: diagnosisFilled.byPool.map((row) => ({ ...row, topCompetitor: null })), more: [] });
    client.getGeoMonitoring.mockResolvedValue(fallingMonitoring);
    renderTab(<OverviewTab {...props(fallingProject())} />);
    const trend = await screen.findByRole("heading", { name: /综合可见度指数 44，/ });
    expect(screen.queryByRole("table", { name: "同类药提及率" })).not.toBeInTheDocument();
    expect(screen.queryByText("这一轮还没有测到同类药的提及率。")).not.toBeInTheDocument();
    expect(trend.closest("section")).toHaveClass("lg:col-span-3");
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
    await screen.findByRole("heading", { name: /品类问题可见率 21%/ });
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

describe("可见度：每个引擎", () => {
  const engines = {
    ...monitoringFilled,
    byEngine: [
      { engine: "doubao", points: [{ date: "2026-09-22", value: 30, n: 62, k: null }, { date: "2026-10-13", value: 44, n: 62, k: null }] },
      // The latest round has no stated reading: what is left is history, and is not drawn as if it were today's.
      { engine: "deepseek", points: [{ date: "2026-09-22", value: 35, n: 62, k: null }, { date: "2026-10-13", value: null, n: 62, k: null }] },
      { engine: "yuanbao", points: [{ date: "2026-09-22", value: 40, n: 62, k: null }, { date: "2026-10-13", value: null, n: 62, k: null }] },
      // A round it was not read in at all.
      { engine: "kimi", points: [{ date: "2026-09-22", value: 20, n: 62, k: null }] },
    ],
  };

  it("draws a line only for an engine with a reading in the latest round, and says why for the rest", async () => {
    client.getGeoMonitoring.mockResolvedValue(engines);
    const round = { ...diagnosisFilled.round!, absent: [{ engine: "yuanbao", reason: "login" }] };
    client.getGeoDiagnosis.mockResolvedValue({ ...diagnosisFilled, round });
    renderTab(<VisibilityTab {...props()} />);
    const row = async (engine: string) => (await waitFor(() => {
      const found = document.querySelector(`[data-geo-engine-trend='${engine}']`) as HTMLElement | null;
      if (!found) throw new Error("not yet");
      return found;
    }));
    expect((await row("doubao")).querySelector("[data-geo-sparkline]")).not.toBeNull();
    const deepseek = await row("deepseek");
    expect(deepseek.querySelector("[data-geo-sparkline]")).toBeNull();
    expect(deepseek).toHaveTextContent("上次 35 · 9月22日");
    // The round's own reason when the engine did not answer.
    const yuanbao = await row("yuanbao");
    expect(yuanbao.querySelector("[data-geo-sparkline]")).toBeNull();
    expect(yuanbao).toHaveTextContent("本轮未测：探测账号需要重新登录");
    // An engine the latest round never read is not "now": a dash and its last reading, never its old line.
    const kimi = await row("kimi");
    expect(kimi.querySelector("[data-geo-sparkline]")).toBeNull();
    expect(kimi).toHaveTextContent("上次 20 · 9月22日");
  });

  it("draws no empty ranking card where no rival was measured", async () => {
    client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    client.getGeoDiagnosis.mockResolvedValue({ ...diagnosisFilled, byPool: diagnosisFilled.byPool.map((row) => ({ ...row, topCompetitor: null })), more: [] });
    renderTab(<VisibilityTab {...props()} />);
    await screen.findByRole("heading", { name: /综合可见度指数 38，比上次高 9/ });
    await screen.findByRole("table", { name: "按问句池的品牌提及率" });
    expect(screen.queryByRole("table", { name: "同类药提及率" })).not.toBeInTheDocument();
    expect(screen.queryByText("这一轮还没有测到同类药的提及率。")).not.toBeInTheDocument();
  });
});

// R19 audit C 1.9: the drug-value analysis was a block in seven tabs, each with a title of its own. It is 依据's second view and
// nowhere else; the other tabs link to it from the object it is about.
describe("药品价值分析只在依据里", () => {
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const FOLLOWS = Node.DOCUMENT_POSITION_FOLLOWING;

  /** Each of the other tabs, with the data its own tests give it and a sign that its own content is drawn. */
  const TABS: ReadonlyArray<{ tab: string; render: () => ReactElement; ready: () => Promise<unknown> }> = [
    {
      tab: "overview",
      render: () => { client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled); client.getGeoMonitoring.mockResolvedValue(fallingMonitoring); return <OverviewTab {...props(fallingProject())} />; },
      ready: () => screen.findByRole("heading", { name: /综合可见度指数 44，/ }),
    },
    {
      tab: "visibility",
      render: () => { client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled); client.getGeoMonitoring.mockResolvedValue(monitoringFilled); return <VisibilityTab {...props()} />; },
      ready: () => screen.findByRole("heading", { name: /综合可见度指数 38，比上次高 9/ }),
    },
    {
      tab: "accuracy",
      render: () => { client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled); client.getGeoMonitoring.mockResolvedValue(monitoringFilled); return <AccuracyTab {...props()} />; },
      ready: () => screen.findByRole("heading", { name: "讲错清单，按严重度排序" }),
    },
    {
      tab: "questions",
      render: () => { client.getGeoQuestions.mockResolvedValue(questionsFilled); return <QuestionsTab {...props()} />; },
      ready: () => screen.findByText("3 个问题群 · 2 问 · 2 条真实问法"),
    },
    {
      tab: "sources",
      render: () => { client.getGeoSources.mockResolvedValue(sourcesFilled); return <SourcesTab {...props()} />; },
      ready: () => screen.findByText("3 个信源"),
    },
  ];

  it.each(TABS)("$tab: draws none of it — not its sections, not a start for it — and does not read it", async ({ render: arrange, ready }) => {
    client.getGeoValue.mockResolvedValue(valueFilled);
    renderTab(arrange());
    await ready();
    await settle();
    for (const title of VALUE_TITLES) expect(screen.queryByRole("heading", { name: title })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始药品价值分析" })).not.toBeInTheDocument();
    expect(client.getGeoValue).not.toHaveBeenCalled();
  });

  /** 依据 at its second view, in the place the layout gives it. */
  function renderEvidence(project: GeoProject = geoProject()) {
    return render(
      <MemoryRouter initialEntries={["/app/geo/geo_1/evidence?view=value"]}>
        <Routes>
          <Route path="/app/geo/geo_1/evidence" element={<><GeoFrameHarness project={project}><EvidenceTab geoId="geo_1" project={project} /></GeoFrameHarness><Probe /></>} />
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("依据: with an analysis, its parts follow one another as the reader asks, and none of them has a 问 AI button", async () => {
    client.getGeoEvidence.mockResolvedValue(evidenceFilled);
    client.getGeoValue.mockResolvedValue(valueFilled);
    renderEvidence();
    const parts = ["药品价值分析", "问题背后的决策", "下一步研究与内容", "依据与传播", "AI 如何表达药品价值"];
    const headings = await Promise.all(parts.map((name) => screen.findByRole("heading", { name })));
    headings.slice(1).forEach((heading, index) => {
      expect(headings[index].compareDocumentPosition(heading) & FOLLOWS, `${heading.textContent} follows ${headings[index].textContent}`).toBeTruthy();
    });
    expect(document.querySelector("[data-geo-ask-ai]")).toBeNull();
    // The identity comes first on the page: who the product is, then what may be said about it.
    expect(screen.getByRole("heading", { name: "产品身份" }).compareDocumentPosition(headings[0]) & FOLLOWS).toBeTruthy();
  });

  it("依据: a project with none gets one recipe with the one button that starts it, which opens the conversation with the brief, unsent", async () => {
    client.getGeoEvidence.mockResolvedValue(evidenceFilled);
    client.getGeoValue.mockResolvedValue({ version: 0, updatedAt: null, data: {}, research: [], impacts: [], observations: [],
      coverage: { assessed: 0, represented: 0, partial: 0, contradicted: 0, notAddressed: 0, uncertain: 0, notApplicable: 0, value: null } });
    renderEvidence();
    await screen.findByText("还没有药品价值分析");
    const start = screen.getAllByRole("button", { name: "开始药品价值分析" });
    expect(start).toHaveLength(1);
    expect(screen.getByRole("link", { name: "结论库" })).toHaveAttribute("href", "/app/geo/geo_1/evidence");
    expect(screen.getByText("得到 这个药的获益、风险、适用性、费用与可及性")).toBeInTheDocument();
    await userEvent.click(start[0]);
    await waitFor(() => expect(store.select).toHaveBeenCalled());
    expect(screen.getByTestId("state")).toHaveTextContent("请结合现有资料开始药品价值分析");
    // Opened with the brief in the composer; nothing was sent.
    expect(screen.getByTestId("state")).not.toHaveTextContent("\"send\":true");
  });

  it("依据: reads the analysis once for all its parts", async () => {
    client.getGeoEvidence.mockResolvedValue(evidenceFilled);
    client.getGeoValue.mockResolvedValue(valueFilled);
    renderEvidence();
    await screen.findByRole("heading", { name: "问题背后的决策" });
    expect(client.getGeoValue).toHaveBeenCalledTimes(1);
  });
});

describe("a hand-off to the conversation that fails", () => {
  beforeEach(() => useToastStore.setState({ toasts: [] }));
  const toasts = () => useToastStore.getState().toasts.map((toast) => toast.message);

  it("写纠错稿: says so in a toast and gives the button back, where it used to end in nothing", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
    store.select.mockRejectedValueOnce(new Error("project is gone"));
    renderTab(<AccuracyTab {...props()} />);
    const button = (await screen.findAllByRole("button", { name: "写纠错稿" }))[0];
    await userEvent.click(button);
    await waitFor(() => expect(toasts()).toEqual(["对话暂时无法打开，请稍后重试。"]));
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/tab");
  });

  it("在对话中处理: says so in a toast and gives the button back", async () => {
    client.getGeoSources.mockResolvedValue(sourcesFilled);
    client.getGeoSource.mockResolvedValue(sourceDetailOf(sourcesFilled.sources[1]));
    store.select.mockRejectedValueOnce(new Error("project is gone"));
    renderTab(<SourcesTab {...props()} />);
    await screen.findByText("3 个信源");
    await userEvent.click(within(document.querySelector("[data-geo-source='baike.baidu.com']")?.closest("li") as HTMLElement).getByRole("button", { name: /百度百科/ }));
    const dialog = await screen.findByRole("dialog", { name: "百度百科" });
    await within(dialog).findByRole("region", { name: "讲错的回答" });
    const button = within(dialog).getByRole("button", { name: "在对话中处理" });
    await userEvent.click(button);
    await waitFor(() => expect(toasts()).toEqual(["对话暂时无法打开，请稍后重试。"]));
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/tab");
  });
});

