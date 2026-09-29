import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { OverviewTab } from "./OverviewTab";
import { PopulationTab } from "./PopulationTab";
import { PatientsTab, VCR_COUNTERFACTUAL_SENTENCE } from "./PatientsTab";
import { ComparatorTab } from "./ComparatorTab";
import { TrialTab } from "./TrialTab";
import { EMPTY_STUDY_ID, fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { VCR_STEP_WAITING } from "../vcrText";

/**
 * The five design tabs, rendered from what the server sends.
 *
 * Every payload here is a fixture under `apps/server/test/fixtures/vcr-views/`
 * — the bytes the real presenter produces for the seeded EV-201 study — read
 * through the real `vcrClient` readers and route functions. Only
 * `productRequest` is doubled; a test that needs a variant edits its own copy
 * of the fixture, never a shape of its own invention.
 */

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const store = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }, { id: "prj_empty" }], select: store.select, load: store.load }) },
}));

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);
const ev201 = (): VcrStudy => readVcrStudy(fixture("ev201/study.json"));
const emptyStudy = (): VcrStudy => readVcrStudy(fixture("empty/study.json"));
/** The empty study with nothing asked for yet: every step offers 「让 AI 做」. */
const unaskedStudy = (): VcrStudy => {
  const raw = fixture("empty/study.json");
  for (const step of Object.values(raw.steps) as Array<{ requested: boolean }>) step.requested = false;
  return readVcrStudy(raw);
};
const tab = (name: string) => `GET /vcr/studies/${STUDY_ID}/${name}`;
const gets = (name: string) => network.productRequest.mock.calls.filter(([path, method]) => path === `/vcr/studies/${STUDY_ID}/${name}` && (method ?? "GET") === "GET");

/** The element at `selector`, once the tab has read its route; a miss fails the test with the selector. */
const found = (root: ParentNode, selector: string) => waitFor(() => {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`nothing at ${selector}`);
  return node as HTMLElement;
});
/** The trial tab has read its route and drawn its grid. */
const trialDrawn = () => screen.findByRole("heading", { name: "方案的运行特征" });

/** Every 「区间」 on screen carries its name (plan §9.6). */
const BARE_INTERVAL = /(?<!预测|置信|可信|蒙特卡洛)区间/;

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  store.select.mockClear();
  installVcrServer(network.productRequest);
});

describe("总览", () => {
  it("leads with the study's own sentence and gives each number its source and named interval", () => {
    draw(<OverviewTab studyId={STUDY_ID} study={ev201()} />);
    expect(screen.getByText("已模拟 3 个方案，成功把握 58%～74%；真实外部对照不可估计，缺 3 项数据。")).toBeInTheDocument();
    expect(screen.getAllByText("对照组中位 PFS").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/80% 预测区间 3\.0–5\.6/).length).toBeGreaterThan(0);
    // A route that cannot be estimated is a tile with its word, not a blank or a zero.
    expect(screen.getByText("不可估计")).toBeInTheDocument();
  });

  it("fixes the four counts in the band, with the design they are of", () => {
    const { container } = draw(<OverviewTab studyId={STUDY_ID} study={ev201()} />);
    const band = container.querySelector("[data-vcr-counts]") as HTMLElement;
    expect(within(band).getByText("方案 B")).toBeInTheDocument();
    expect(band.querySelector("[data-vcr-count='realPatients']")).toHaveTextContent("0");
    expect(band.querySelector("[data-vcr-count='events']")).toHaveTextContent("138");
    expect(band.querySelector("[data-vcr-count='effectiveSampleSize']")).toHaveTextContent("—");
    expect(band.querySelector("[data-vcr-count='generatedRecords']")).toHaveTextContent("约 648 万");
  });

  it("links an attention line to the tab the server named, and gives the budget line no link of its own", () => {
    draw(<OverviewTab studyId={STUDY_ID} study={ev201()} />);
    expect(screen.getByRole("link", { name: "去复核" })).toHaveAttribute("href", `/app/virtual-research/${STUDY_ID}/data`);
    expect(screen.getByRole("link", { name: "查看缺口" })).toHaveAttribute("href", `/app/virtual-research/${STUDY_ID}/comparator`);
    const budget = screen.getByText("1 项计算在等你确认计算预算").closest("li") as HTMLElement;
    expect(within(budget).queryByRole("link")).not.toBeInTheDocument();
  });

  it("prints the scatter's numbers as the server sent them, with their error and the cost's unit", () => {
    const { container } = draw(<OverviewTab studyId={STUDY_ID} study={ev201()} />);
    const scatter = container.querySelector("[data-vcr-scatter]") as HTMLElement;
    const b = scatter.querySelector("[data-vcr-scatter-label='B']") as HTMLElement;
    expect(b).toHaveTextContent("71.0%");
    expect(b).toHaveTextContent("±0.40");
    expect(b).toHaveTextContent("3,900 万元");
    // 71 is already a percentage: nothing on the axis was multiplied again.
    expect(scatter.textContent).not.toMatch(/7,?100%/);
    // The brand follows the recorded decision (B), and only it.
    expect(scatter.querySelectorAll("[data-vcr-chosen]")).toHaveLength(1);
    expect(scatter.querySelector("[data-vcr-scatter-point='B']")).toHaveAttribute("data-vcr-chosen");
    // D has no numbers to place it by; it is named with the design that beats it.
    expect(scatter.querySelector("[data-vcr-scatter-dominated='D']")).toHaveTextContent("被 C 占优");
  });

  it("names the stale tiles in a bar above the band", () => {
    const raw = fixture("ev201/study.json");
    raw.overview.metrics[0].value.stale = true;
    draw(<OverviewTab studyId={STUDY_ID} study={readVcrStudy(raw)} />);
    expect(document.querySelector("[data-vcr-stale]")).toHaveTextContent("对照组中位 PFS · 输入已变更，这些数字可能已过期");
  });

  it("is the definition step's own state before the study is defined", () => {
    draw(<OverviewTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />);
    expect(screen.getByText(VCR_STEP_WAITING.definition)).toBeInTheDocument();
  });

  it("offers 让 AI 做 for the definition, which starts it in the study's conversation", async () => {
    draw(<OverviewTab studyId={EMPTY_STUDY_ID} study={unaskedStudy()} />);
    await userEvent.click(screen.getByRole("button", { name: "让 AI 做" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${EMPTY_STUDY_ID}/run`, "POST", { step: "definition" }));
  });
});

describe("人群", () => {
  it("shows the server's own counts: kept, excluded and undecidable apart, and the three outcomes", async () => {
    const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    const outcome = await found(container, "[data-vcr-outcome]");
    expect(outcome).toHaveTextContent("57 符合");
    expect(outcome).toHaveTextContent("612 可能符合");
    expect(outcome).toHaveTextContent("2,743 不符合");
    expect(screen.getByText("按方案 v1，3,412 人中 57 人全部满足、612 人至少 1 条无法判断。")).toBeInTheDocument();
    const i3 = container.querySelector("[data-vcr-rule='I3']") as HTMLElement;
    expect(i3.querySelector("[data-vcr-rule-kept]")).toHaveTextContent("1,855");
    expect(i3.querySelector("[data-vcr-rule-excluded]")).toHaveTextContent("611");
    expect(i3.querySelector("[data-vcr-rule-unknown]")).toHaveTextContent("22");
    // A rule nobody counted is a dash, never a zero.
    expect((container.querySelector("[data-vcr-rule='E2'] [data-vcr-rule-kept]") as HTMLElement).textContent).toBe("—");
  });

  it("keeps a stale population on screen, greyed, under the bar that says a recomputation is queued", async () => {
    const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    await screen.findByText("逐条筛选");
    expect(container.querySelector("[data-vcr-stale]")).toHaveTextContent("入排条件已变更 · 输入已变更，排队重算中");
    const greyed = container.querySelector("[data-vcr-stale-block] .opacity-disabled") as HTMLElement;
    expect(greyed).not.toBeNull();
    expect(within(greyed).getByText("逐条筛选")).toBeInTheDocument();
    expect(greyed.querySelector("[data-vcr-outcome]")).toHaveTextContent("2,743");
  });

  it("carries a quality report of values, tagged exploratory, and no verdict", async () => {
    const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    const report = (await found(container, "[data-vcr-quality]")).closest("section") as HTMLElement;
    expect(within(report).getByText("质量报告")).toBeInTheDocument();
    expect(within(report).getByText("合成 · 探索性")).toBeInTheDocument();
    for (const group of ["fidelity", "utility", "leakage"]) {
      expect(report.querySelector(`[data-vcr-quality-group='${group}']`)).not.toBeNull();
    }
    expect(within(report).getByText("成员推断 AUC").closest("div")).toHaveTextContent("0.52");
    expect(within(report).getByText("训练记录 3,412 条 · 合成 1 份")).toBeInTheDocument();
    expect(report.textContent).not.toMatch(/安全|匿名|合格/);
  });

  it("puts two versions side by side as each stored them, and computes nothing between them", async () => {
    const { container } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    const table = await found(container, "[data-vcr-version-compare]");
    expect(within(table).getByText("人群 v1")).toBeInTheDocument();
    expect(within(table).getByText("人群 v2")).toBeInTheDocument();
    expect(table.querySelector("[data-vcr-version-count='realPatients']")).toHaveTextContent("3,390");
    expect(table.querySelector("[data-vcr-version-count='realPatients']")).toHaveTextContent("3,412");
    // The composition rows exist on one side only in this study: not a comparison.
    expect(table.querySelectorAll("[data-vcr-version-row]")).toHaveLength(0);
    expect(table.textContent).not.toContain("SMD");
  });

  it("fixes the four counts at the foot, and keeps them when nothing has counted yet", async () => {
    const { container, unmount } = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    await screen.findByText("逐条筛选");
    expect(container.querySelector("[data-vcr-counts] [data-vcr-count='realPatients']")).toHaveTextContent("3,412");
    expect(container.querySelector("[data-vcr-counts] [data-vcr-count='generatedRecords']")).toHaveTextContent("0");
    unmount();

    const raw = fixture("ev201/population.json");
    raw.counts = null;
    installVcrServer(network.productRequest, { [tab("population")]: raw });
    const again = draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    await screen.findByText("逐条筛选");
    const band = again.container.querySelector("[data-vcr-counts]") as HTMLElement;
    expect(within(band).getByText("尚无运行")).toBeInTheDocument();
    expect(band.querySelectorAll("[data-vcr-count]")).toHaveLength(4);
  });

  it("flags a covariate past the balance floor", async () => {
    draw(<PopulationTab studyId={STUDY_ID} study={ev201()} />);
    expect(await screen.findByRole("img", { name: /既往免疫治疗 标准化差异 0.31，超过界值/ })).toBeInTheDocument();
  });

  it("is the step's waiting line on an empty study, and 让 AI 做 when nothing was asked", async () => {
    const { unmount } = draw(<PopulationTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />);
    expect(await screen.findByText(VCR_STEP_WAITING.population)).toBeInTheDocument();
    unmount();
    draw(<PopulationTab studyId={EMPTY_STUDY_ID} study={unaskedStudy()} />);
    await userEvent.click(await screen.findByRole("button", { name: "让 AI 做" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${EMPTY_STUDY_ID}/run`, "POST", { step: "population" }));
  });
});

describe("虚拟患者", () => {
  it("says which model, its tier, the label its output has earned and how far it may be carried — never 数字孪生", async () => {
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const model = await found(container, "[data-vcr-model]");
    expect(within(model).getByText("文献模型")).toBeInTheDocument();
    expect(within(model).getByText("二线 NSCLC 多西他赛组 PFS · Weibull")).toBeInTheDocument();
    expect(model.querySelector("[data-vcr-twin]")).toHaveTextContent("基线条件化预测");
    expect(within(model).getByText("研究设计支持")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("数字孪生");
  });

  it("measures the tornado against the base case the result sent, and invents none without it", async () => {
    const { container, unmount } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const tornado = await found(container, "[data-vcr-tornado]");
    expect(tornado.querySelector("[data-vcr-tornado-base]")).not.toBeNull();
    expect(tornado).toHaveTextContent("基准0.41");
    unmount();

    const raw = fixture("ev201/patients.json");
    raw.sensitivity.base = null;
    installVcrServer(network.productRequest, { [tab("patients")]: raw });
    const again = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const bare = await found(again.container, "[data-vcr-tornado]");
    expect(bare.querySelector("[data-vcr-tornado-base]")).toBeNull();
    expect(bare.textContent).not.toContain("基准");
    // The bars are still the server's ranges.
    expect(within(bare).getByRole("img", { name: "目标 HR：0.33 到 0.49" })).toBeInTheDocument();
  });

  it("says the step did not finish, above the part it kept — and keeps showing that part", async () => {
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const failed = await found(container, "[data-vcr-step-failed='patients']");
    expect(within(failed).getByText("这一步未完成")).toBeInTheDocument();
    expect(failed.querySelector("[data-vcr-partial]")).toHaveTextContent("已算完 1,200 / 2,000 次重复的结果");
    expect(within(failed).getByRole("button", { name: "从检查点续跑" })).toBeInTheDocument();
    // The data are still there, under it.
    const example = screen.getByText("VP-0412");
    expect(failed.compareDocumentPosition(example) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("这次运行的结果")).toBeInTheDocument();
    expect(container.querySelector("[data-vcr-counts] [data-vcr-count='generatedRecords']")).toHaveTextContent("2,000");
    expect(screen.queryByRole("button", { name: "让 AI 做" })).not.toBeInTheDocument();
  });

  it("draws a model's output as a thin dashed mean, with a band only where the band has a name", async () => {
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const treatment = await found(container, "[data-vcr-series='treatment']");
    expect(treatment.querySelector("[data-vcr-band='prediction']")).not.toBeNull();
    expect(treatment.querySelector("[data-vcr-series-line]")?.getAttribute("stroke-dasharray")).toBeTruthy();
    // Both scenarios name their spread (a prediction interval, at 80%), so both bands are drawn ...
    const control = container.querySelector("[data-vcr-series='control']") as SVGElement;
    expect(control.querySelector("[data-vcr-band='prediction']")).not.toBeNull();
    // ... and the legend names it from the data, level included, once.
    expect(container.querySelectorAll("[data-vcr-legend-band]")).toHaveLength(1);
    expect(container.querySelector("[data-vcr-legend-band]")).toHaveTextContent("80% 预测区间");
  });

  it("draws a spread nobody named as no band at all: an unnamed range is not an interval", async () => {
    const raw = fixture("ev201/patients.json");
    for (const line of raw.trajectories.series) { line.bandKind = null; line.bandLevel = null; }
    installVcrServer(network.productRequest, { [tab("patients")]: raw });
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    await found(container, "[data-vcr-series='control']");
    expect(container.querySelector("[data-vcr-band]")).toBeNull();
    expect(container.querySelector("[data-vcr-legend-band]")).toBeNull();
  });

  it("prints what two scenarios of one patient are whenever they are drawn, and shades what nobody could observe", async () => {
    const raw = fixture("ev201/patients.json");
    const series = raw.trajectories.series;
    raw.example.scenarios = { note: null, difference: "12 个月差 0.23", series };
    raw.trajectories.series[1].unobserved = [{ from: 6, to: 12 }];
    installVcrServer(network.productRequest, { [tab("patients")]: raw });
    const { container } = draw(<PatientsTab studyId={STUDY_ID} study={ev201()} />);
    const scenarios = await found(container, "[data-vcr-scenarios]");
    expect(scenarios.querySelector("[data-vcr-counterfactual]")).toHaveTextContent(VCR_COUNTERFACTUAL_SENTENCE);
    // Said once, even though the server's note says the same.
    expect(screen.getAllByText(VCR_COUNTERFACTUAL_SENTENCE)).toHaveLength(1);
    expect(container.querySelector("[data-vcr-unobserved]")).not.toBeNull();
    expect(screen.getAllByText("未观察时段").length).toBeGreaterThan(0);
  });

  it("is the step's waiting line on an empty study", async () => {
    draw(<PatientsTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />);
    expect(await screen.findByText(VCR_STEP_WAITING.patients)).toBeInTheDocument();
  });
});

describe("对照", () => {
  it("rates all ten comparability dimensions, each with its own word and reason", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const table = await found(container, "[data-vcr-dimensions]");
    expect(within(table.closest("section") as HTMLElement).getByText("可比性逐项评估")).toBeInTheDocument();
    expect(table.querySelectorAll("[data-vcr-dimension]")).toHaveLength(10);
    const period = table.querySelector("[data-vcr-dimension='time_period']") as HTMLElement;
    expect(period).toHaveTextContent("近似");
    expect(period).toHaveTextContent("来源试验早于 2020 年");
    expect(table.querySelector("[data-vcr-dimension='geography']")).toHaveTextContent("精确模拟");
    expect(table.querySelector("[data-vcr-dimension='diagnosis']")).toHaveTextContent("未评估");
  });

  it("writes the external control as a not-estimable card with its gaps, while another route is the selected one", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const card = await found(container, "[data-vcr-not-estimable]");
    expect(within(card).getByText("真实外部对照：不可估计")).toBeInTheDocument();
    expect(within(card).getByText("缺 3 项数据")).toBeInTheDocument();
    expect(within(card).getByText("ECOG 缺失 38%")).toBeInTheDocument();
    expect(within(card).getByText("把 ECOG 纳入熵平衡")).toBeInTheDocument();
    expect(within(card).getByText("判定依据：加权后有效样本量低于下限")).toBeInTheDocument();
    expect(container.querySelector("[data-vcr-route='literature_control']")?.className).toContain("bg-accent-soft");
    expect(container.querySelector("[data-vcr-route='external_control']")).toHaveTextContent("缺 3 项数据，见下方清单");
  });

  it("names the five routes in plan order with the state each has at this tier", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    await screen.findByText("对照路线");
    const routes = [...container.querySelectorAll("[data-vcr-route]")].map((node) => node.getAttribute("data-vcr-route"));
    expect(routes).toEqual(["prognostic_adjustment", "external_control", "literature_control", "model_comparator", "hybrid_control"]);
    expect(container.querySelector("[data-vcr-route='prognostic_adjustment']")).toHaveTextContent("不适用");
    expect(container.querySelector("[data-vcr-route='prognostic_adjustment']")).toHaveTextContent("需要 T3 随机试验个体数据");
  });

  it("puts the weight diagnostics and the balance before and after weighting on the page", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const diagnostics = await found(container, "[data-vcr-diagnostics]");
    expect(within(diagnostics.closest("section") as HTMLElement).getByText("权重与重叠诊断")).toBeInTheDocument();
    expect(within(diagnostics).getByText("重叠系数").closest("div")).toHaveTextContent("0.82");
    expect(within(diagnostics).getByText("最大权重").closest("div")).toHaveTextContent("6.2");
    const balance = container.querySelector("[data-vcr-balance-row='既往免疫治疗']") as HTMLElement;
    expect(balance.querySelector("[data-vcr-smd-before]")).toHaveTextContent("0.42");
    expect(balance).toHaveTextContent("0.31");
    expect(screen.getByText("加权前 |SMD|")).toBeInTheDocument();
  });

  it("draws a reconstructed curve dashed, always, and a curve of any other source by its own rule", async () => {
    const { container, unmount } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const s1 = await found(container, "[data-vcr-curve='s1']");
    expect(s1.getAttribute("data-vcr-curve-source")).toBe("reconstructed");
    expect(s1.getAttribute("stroke-dasharray")).toBe("3 3");
    expect(container.querySelector("[data-vcr-curve='pooled']")?.getAttribute("stroke-dasharray")).toBe("5 3");
    expect(screen.getByText("虚线为从已发表图表重建的伪个体数据，不是观察到的曲线。")).toBeInTheDocument();
    unmount();

    const raw = fixture("ev201/comparator.json");
    raw.curves[0].source = "observed";
    raw.curves[1].source = "assumed";
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const again = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const observed = await found(again.container, "[data-vcr-curve='s1']");
    // Solid is earned by an observation, and only by one.
    expect(observed.getAttribute("stroke-dasharray")).toBeNull();
    expect(again.container.querySelector("[data-vcr-curve='pooled']")?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(again.container.querySelector("[data-vcr-legend='pooled']")).toHaveTextContent("假设");
  });

  it("fixes the four counts, and the reconstructed pseudo-patients beside them when that route was used", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const band = await found(container, "[data-vcr-counts]");
    expect(band.querySelector("[data-vcr-count='realPatients']")).toHaveTextContent("0");
    expect(band.querySelector("[data-vcr-count='events']")).toHaveTextContent("812");
    expect(band.querySelector("[data-vcr-count='effectiveSampleSize']")).toHaveTextContent("—");
    expect(band.querySelector("[data-vcr-count='reconstructedPseudoPatients']")).toHaveTextContent("801");
  });

  it("says the method's conclusion and the review state apart", async () => {
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const verdict = await found(container, "[data-vcr-verdict]");
    expect(verdict).toHaveTextContent("有限制地估计");
    expect(verdict).toHaveTextContent("AI 设定");
    expect(verdict).toHaveTextContent("未复核");
  });

  it("prints 1.04 as 1.04, not as 1.0", async () => {
    const raw = fixture("ev201/comparator.json");
    raw.diagnostics[1].value.value = 1.04;
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const { container } = draw(<ComparatorTab studyId={STUDY_ID} study={ev201()} />);
    const diagnostics = await found(container, "[data-vcr-diagnostics]");
    expect(within(diagnostics).getByText("最大权重").closest("div")).toHaveTextContent("1.04");
  });

  it("is the step's waiting line on an empty study, not a rail of routes nobody ran", async () => {
    const { container } = draw(<ComparatorTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />);
    expect(await screen.findByText(VCR_STEP_WAITING.comparator)).toBeInTheDocument();
    expect(container.querySelector("[data-vcr-route]")).toBeNull();
  });
});

describe("试验", () => {
  it("lists every design, greys the dominated one with the server's own sentence and no numbers", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const codes = [...container.querySelectorAll("tr[data-vcr-design]")].map((row) => row.getAttribute("data-vcr-design"));
    expect(codes).toEqual(["A", "B", "C", "D"]);
    const d = container.querySelector("tr[data-vcr-design='D']") as HTMLElement;
    expect(d).toHaveAttribute("data-vcr-dominated");
    expect(d.querySelector("[data-vcr-dominated-note]")).toHaveTextContent("在比较目标的全部指标上都不优于 C");
    expect(d.querySelectorAll("[data-vcr-measure]")).toHaveLength(0);
    expect(d.textContent).not.toContain("%");
  });

  it("puts a Monte-Carlo error beside every simulated number in the grid", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const simulated = [...container.querySelectorAll("tr[data-vcr-design] [data-vcr-measure][data-vcr-source='predicted']")];
    // Prove the walk walked: A has four simulated measures, B and C five each
    // (sample size and cost are set, not simulated).
    expect(simulated).toHaveLength(14);
    for (const cell of simulated) expect(cell.querySelector("[data-vcr-mcse]")).not.toBeNull();
    const b = container.querySelector("tr[data-vcr-design='B'] [data-vcr-measure='assurance']") as HTMLElement;
    expect(b).toHaveTextContent("71.0");
    expect(b.querySelector("[data-vcr-mcse]")).toHaveTextContent("±0.40");
  });

  it("names the prediction interval under the last-patient-in cell, and writes no bare 区间", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const duration = container.querySelector("tr[data-vcr-design='B'] [data-vcr-measure='duration_months']") as HTMLElement;
    expect(duration.querySelector("[data-vcr-interval]")).toHaveTextContent("80% 预测区间 13.90–19.30");
    expect(container.querySelector("tr[data-vcr-design='B'] [data-vcr-measure='cost']")).toHaveTextContent("3,900");
    expect(screen.getByText("成本（万元）")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(BARE_INTERVAL);
  });

  it("keeps the error and the cost's unit on the trade-off scatter's labels", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    const label = await found(container, "[data-vcr-scatter-label='C']");
    expect(label).toHaveTextContent("74.0%");
    expect(label).toHaveTextContent("±0.40");
    expect(label).toHaveTextContent("4,600 万元");
  });

  it("draws each design's last patient in as a point inside its named prediction interval", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    const timeline = await found(container, "[data-vcr-milestones]");
    expect([...timeline.querySelectorAll("[data-vcr-milestone]")].map((row) => row.getAttribute("data-vcr-milestone"))).toEqual(["A", "B", "C"]);
    const b = timeline.querySelector("[data-vcr-milestone='B']") as HTMLElement;
    expect(b).toHaveTextContent("末例入组");
    expect(b).toHaveTextContent("16.40");
    expect(b).toHaveTextContent("80% 预测区间 13.90–19.30");
  });

  it("registers each forecast with its hash and freezing time, and sets it beside the actual once there is one", async () => {
    const { container, unmount } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    const forecast = await found(container, "[data-vcr-forecast='fct_1']");
    expect(within(forecast.closest("section") as HTMLElement).getByText("预测登记")).toBeInTheDocument();
    expect(forecast).toHaveTextContent("入组预测");
    expect(forecast).toHaveTextContent("v1");
    expect(forecast.querySelector("[data-vcr-forecast-hash]")).toHaveTextContent("哈希 HASH");
    expect(forecast).toHaveTextContent("冻结于 今天 09:07");
    expect(forecast.querySelector("[data-vcr-forecast-line='last_patient_in_months']")).toHaveTextContent("14.2 个月");
    expect(within(forecast).queryByText("实际")).not.toBeInTheDocument();
    unmount();

    const raw = fixture("ev201/trial.json");
    raw.forecasts[0].lines[0].actual = "15.1 个月";
    raw.forecasts[0].comparedAt = "今天 12:00";
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const again = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    const compared = await found(again.container, "[data-vcr-forecast='fct_1']");
    expect(within(compared).getByText("实际")).toBeInTheDocument();
    expect(compared.querySelector("[data-vcr-forecast-line='last_patient_in_months']")).toHaveTextContent("14.2 个月15.1 个月");
    expect(compared).toHaveTextContent("与实际对照于 今天 12:00");
  });

  it("highlights only the design a recorded decision chose, and starts the card from that record", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const ours = [...container.querySelectorAll("tr[data-row-ours]")].map((row) => row.getAttribute("data-vcr-design"));
    expect(ours).toEqual(["B"]);
    expect(screen.getByLabelText("比较目标")).toHaveValue("在成功把握尽量高、样本量尽量少的目标下选哪个方案");
    expect(screen.getByRole("radio", { name: "B" })).toBeChecked();
    expect(screen.getByLabelText("选择理由")).toHaveValue("成功把握与样本量的折中；方案 C 周期更长。");
    expect(screen.getByText("平台不自动选定方案。")).toBeInTheDocument();
    expect(screen.getByText("上次记录于 今天 09:07")).toBeInTheDocument();
  });

  it("writes nothing until a goal is written and a design chosen, then posts the exact decision and re-reads", async () => {
    const raw = fixture("ev201/trial.json");
    raw.decision = null;
    for (const design of raw.designs) design.chosen = false;
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const save = screen.getByRole("button", { name: "写入决策记录" });
    expect(save).toBeDisabled();
    // Nobody chose: every design is a grey.
    expect(container.querySelectorAll("tr[data-row-ours]")).toHaveLength(0);
    expect(screen.getByRole("radio", { name: "D" })).toBeDisabled();

    await userEvent.click(screen.getByRole("radio", { name: "B" }));
    expect(save).toBeDisabled();
    // Choosing on the card is not a recorded decision: still no brand.
    expect(container.querySelectorAll("tr[data-row-ours]")).toHaveLength(0);

    await userEvent.type(screen.getByLabelText("比较目标"), "成功把握不低于 70%");
    expect(save).toBeEnabled();
    await userEvent.type(screen.getByLabelText("选择理由"), "样本量更少");
    await userEvent.click(save);

    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/decisions`, "POST", {
      question: "成功把握不低于 70%",
      chosen: { id: "scn_2", code: "B", label: "方案 B 2:1 随机" },
      alternatives: [{ code: "A", label: "方案 A 单臂 + 文献对照" }, { code: "C", label: "方案 C 1:1 随机 + 一次期中分析" }],
      rationale: "样本量更少",
    }));
    expect(toasts.success).toHaveBeenCalledWith("已写入决策记录。");
    // The tab is read again, so the highlight comes back from the server.
    await waitFor(() => expect(gets("trial")).toHaveLength(2));
  });

  it("sends one decision while the first is still being written", async () => {
    let release: (value: unknown) => void = () => {};
    installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/decisions`]: () => new Promise((resolve) => { release = resolve; }),
    });
    draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const save = screen.getByRole("button", { name: "写入决策记录" });
    await userEvent.click(save);
    await userEvent.click(save);
    expect(network.productRequest.mock.calls.filter(([path, method]) => String(path).endsWith("/decisions") && method === "POST")).toHaveLength(1);
    expect(save).toBeDisabled();
    release({});
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
  });

  it("keeps a stale result on screen under its bar, and leaves the decision card usable", async () => {
    const raw = fixture("ev201/trial.json");
    raw.stale = { reason: "假设卡已变更", queued: false, since: null };
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    expect(container.querySelector("[data-vcr-stale]")).toHaveTextContent("假设卡已变更 · 输入已变更，这些数字可能已过期");
    const greyed = container.querySelector("[data-vcr-stale-block] .opacity-disabled") as HTMLElement;
    expect(greyed.querySelector("tr[data-vcr-design='B']")).not.toBeNull();
    expect(greyed.querySelector("[data-vcr-decision]")).toBeNull();
    expect(screen.getByRole("button", { name: "写入决策记录" })).toBeEnabled();
  });

  it("fixes the four counts at the foot, with 尚无运行 when nothing has counted", async () => {
    const raw = fixture("ev201/trial.json");
    raw.counts = null;
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={ev201()} />);
    await trialDrawn();
    const band = container.querySelector("[data-vcr-counts]") as HTMLElement;
    expect(within(band).getByText("尚无运行")).toBeInTheDocument();
    for (const key of ["realPatients", "events", "effectiveSampleSize", "generatedRecords"]) {
      expect(band.querySelector(`[data-vcr-count='${key}']`)).toHaveTextContent("—");
    }
  });

  it("is the step's waiting line on an empty study", async () => {
    draw(<TrialTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />);
    expect(await screen.findByText(VCR_STEP_WAITING.trial)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "写入决策记录" })).not.toBeInTheDocument();
  });
});
