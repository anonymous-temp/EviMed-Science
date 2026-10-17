import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { ComparatorTab, VCR_ASSESS_COMPARABILITY_DRAFT } from "./ComparatorTab";
import { fakeRoom, renderTab } from "../__fixtures__/tabFrame";
import { EMPTY_STUDY_ID, fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { VCR_NO_DEFINITION } from "../vcrText";

/**
 * 对照 (R19; audit B §4.4): who this study can be compared with, as routes beside the record of the one in use — its curves with the
 * dash named in the legend, the balance as a plot, the weights, the ten dimensions as one band, the prior as a key / value list. Every
 * payload is a fixture of the server's (`vcr-views/ev201/comparator.json`); only the network is doubled.
 */

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const ev201 = (): VcrStudy => readVcrStudy(fixture("ev201/study.json"));
const emptyStudy = (): VcrStudy => readVcrStudy(fixture("empty/study.json"));
const tab = (name: string) => `GET /vcr/studies/${STUDY_ID}/${name}`;
const draw = (study: VcrStudy = ev201()) => renderTab(<ComparatorTab studyId={STUDY_ID} study={study} />);
const found = (root: ParentNode, selector: string) => waitFor(() => {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`nothing at ${selector}`);
  return node as HTMLElement;
});

let restoreRoom: () => void;
beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  installVcrServer(network.productRequest);
  restoreRoom = fakeRoom();
});
afterEach(() => restoreRoom());

describe("对照 · the routes and the record in use", () => {
  it("names the four routes this version computes, in plan order, each with the state it has at this tier — as rows that can be pressed", async () => {
    const { container } = draw();
    await screen.findByRole("list", { name: "对照路线" });
    const routes = [...container.querySelectorAll("[data-vcr-route]")].map((node) => node.getAttribute("data-vcr-route"));
    // the model-prediction comparator is not computed by this version: the server does not offer it as a route (it is listed as 暂不支持 in the method library)
    expect(routes).toEqual(["prognostic_adjustment", "external_control", "literature_control", "hybrid_control"]);
    const row = (route: string) => container.querySelector(`[data-vcr-route='${route}']`) as HTMLElement;
    expect(row("prognostic_adjustment")).toHaveTextContent("预后校正");
    expect(row("prognostic_adjustment").closest("li")).toHaveTextContent("不适用");
    expect(row("prognostic_adjustment").closest("li")).toHaveTextContent("需要 T3 随机试验个体数据");
    // What looks like a button is one: every route is a control.
    for (const route of routes) expect(row(route as string).tagName).toBe("BUTTON");
  });

  it("marks the route the study uses, and shows its record beside the list: the curves, the balance, the weights", async () => {
    const { container } = draw();
    await found(container, "[data-vcr-diagnostics]");
    const used = container.querySelector("[data-vcr-route='literature_control']") as HTMLElement;
    expect(used).toHaveAttribute("aria-current", "true");
    expect(used.closest("li")?.className).toContain("bg-accent-soft");
    expect(used.closest("li")).toHaveTextContent("采用");
    expect(container.querySelector("[data-vcr-route='external_control']")).not.toHaveAttribute("aria-current");
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "split");
    // The record is the route in use's: its curves, and the numbers they come to.
    expect(container.querySelector("[data-vcr-curve='s1']")).not.toBeNull();
    expect(container.querySelector("[data-vcr-rmst]")).toHaveTextContent("5.9");
  });

  it("opens what a route that cannot apply would need, and where to bring it in — and changes nothing the study computes", async () => {
    const { container, spies } = draw();
    await found(container, "[data-vcr-diagnostics]");
    await userEvent.click(container.querySelector("[data-vcr-route='prognostic_adjustment']") as HTMLElement);
    const record = await found(container, "[data-vcr-route-record='prognostic_adjustment']");
    expect(record).toHaveTextContent("状态不适用");
    expect(record).toHaveTextContent("需要什么需要 T3 随机试验个体数据");
    expect(container.querySelector("[data-vcr-diagnostics]")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "接入数据" }));
    expect(spies.openPanel).toHaveBeenCalledWith("intake");
    expect(network.productRequest.mock.calls.some(([, method]) => method === "POST")).toBe(false);
    // Looking is not choosing: the route in use is still the one that is marked.
    expect(container.querySelector("[data-vcr-route='literature_control']")?.closest("li")).toHaveTextContent("采用");
    // And the way back to its record is the same row.
    await userEvent.click(container.querySelector("[data-vcr-route='literature_control']") as HTMLElement);
    await found(container, "[data-vcr-diagnostics]");
  });

  it("writes the external control as a not-estimable record with its gaps, when the reader opens it", async () => {
    const { container } = draw();
    await found(container, "[data-vcr-diagnostics]");
    expect(container.querySelector("[data-vcr-route='external_control']")?.closest("li")).toHaveTextContent("缺 3 项数据，见下方清单");
    await userEvent.click(container.querySelector("[data-vcr-route='external_control']") as HTMLElement);
    const card = await found(container, "[data-vcr-not-estimable]");
    expect(within(card).getByText("真实外部对照：不可估计")).toBeInTheDocument();
    expect(within(card).getByText("缺 3 项数据")).toBeInTheDocument();
    expect(within(card).getByText("ECOG 缺失 38%")).toBeInTheDocument();
    expect(within(card).getByText("把 ECOG 纳入熵平衡")).toBeInTheDocument();
    expect(within(card).getByText("判定依据：加权后有效样本量低于下限")).toBeInTheDocument();
    // The conditions under which an external control may stand in are its record too, each met, partly met or in doubt.
    expect(screen.getByText("外部对照适用情境")).toBeInTheDocument();
    expect(screen.getByText("效应远大于自然变异").closest("div")).toHaveTextContent("部分");
  });

  it("is, on a narrow page, the record with a way to the list — and the list with a way back", async () => {
    restoreRoom();
    restoreRoom = fakeRoom(600);
    const { container } = draw();
    await found(container, "[data-vcr-diagnostics]");
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "single");
    expect(container.querySelector("[data-vcr-route]")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "全部路线" }));
    expect(container.querySelectorAll("[data-vcr-route]")).toHaveLength(4);
    expect(container.querySelector("[data-vcr-diagnostics]")).toBeNull();
    await userEvent.click(container.querySelector("[data-vcr-route='external_control']") as HTMLElement);
    await found(container, "[data-vcr-route-record='external_control']");
    expect(screen.getByRole("button", { name: "全部路线" })).toBeInTheDocument();
  });
});

describe("对照 · the record of the route in use", () => {
  it("says the method's conclusion in the sentence, and nothing of who set it or whether it was reviewed", async () => {
    const { container } = draw();
    const verdict = await found(container, "[data-vcr-verdict]");
    expect(verdict).toHaveTextContent("有限制地估计");
    expect(verdict).not.toHaveTextContent(/AI 设定|未复核|已复核/);
    expect(container.querySelector("[data-headline]")).toHaveTextContent("文献对照：有限制地估计，12 个月 RMST 5.900 个月。");
    // What the page used to say last, 「本页结论」, is the chip beside its first sentence.
    expect(container.textContent).not.toContain("本页结论");
    expect((container.querySelector("[data-headline]") as HTMLElement).compareDocumentPosition(verdict) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws a reconstructed curve dashed, always, says in the legend what the dash is, and draws a curve of any other source by its own rule", async () => {
    const { container, unmount } = draw();
    const s1 = await found(container, "[data-vcr-curve='s1']");
    expect(s1.getAttribute("data-vcr-curve-source")).toBe("reconstructed");
    expect(s1.getAttribute("stroke-dasharray")).toBe("3 3");
    expect(container.querySelector("[data-vcr-curve='pooled']")?.getAttribute("stroke-dasharray")).toBe("5 3");
    // The caveat is a legend entry, at the point of use, and not a line under the chart.
    expect(container.querySelector("[data-vcr-legend-source='reconstructed']")).toHaveTextContent("虚线 = 文献重建");
    expect(screen.queryByText("虚线为从已发表图表重建的伪个体数据，不是观察到的曲线。")).toBeNull();
    unmount();

    const raw = fixture("ev201/comparator.json");
    raw.curves[0].source = "observed";
    raw.curves[1].source = "assumed";
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const again = draw();
    const observed = await found(again.container, "[data-vcr-curve='s1']");
    // Solid is earned by an observation, and only by one.
    expect(observed.getAttribute("stroke-dasharray")).toBeNull();
    expect(again.container.querySelector("[data-vcr-curve='pooled']")?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(again.container.querySelector("[data-vcr-legend='pooled']")).toHaveTextContent("假设");
    expect(again.container.querySelector("[data-vcr-legend-source]")).toBeNull();
  });

  it("folds the reconstruction's quality check under the numbers, with how many passed", async () => {
    const { container } = draw();
    const folded = (await screen.findByText(/重建质控 \d+ \/ \d+ 通过/)).closest("details") as HTMLElement;
    expect(folded).not.toHaveAttribute("open");
    expect(container.querySelector("[data-vcr-median]")).toHaveTextContent("4.1");
  });

  it("puts the balance before and after weighting on one axis — a dot plot with the numbers beside it, not a table", async () => {
    const { container } = draw();
    const plot = await found(container, "[data-vcr-balance]");
    expect(plot.closest("section")).toHaveTextContent("与本研究人群的可比性");
    expect(plot.querySelector("table")).toBeNull();
    const row = plot.querySelector("[data-vcr-balance-row='既往免疫治疗']") as HTMLElement;
    // Before weighting 0.42, after 0.31: the distance between two dots, and the numbers in the same order beside them.
    expect(row.querySelector("[data-vcr-smd-before]")).not.toBeNull();
    expect(row).toHaveTextContent("0.42 → 0.31");
    expect(within(row).getByRole("img", { name: /既往免疫治疗 标准化差异，加权前 0.42，加权后 0.31，超过界值/ })).toBeInTheDocument();
    expect(row.querySelector("[data-vcr-smd]")).toHaveAttribute("data-vcr-smd", "over");
    expect(plot).toHaveTextContent("加权前");
    expect(plot).toHaveTextContent("界值 0.1");
    const within_ = plot.querySelector("[data-vcr-balance-row='ECOG 0–1']") as HTMLElement;
    expect(within_.querySelector("[data-vcr-smd]")).toHaveAttribute("data-vcr-smd", "under");
  });

  it("puts the weight diagnostics beside the balance, as a key / value list", async () => {
    const { container } = draw();
    const diagnostics = await found(container, "[data-vcr-diagnostics]");
    expect(diagnostics.closest("section")).toHaveTextContent("权重与重叠");
    expect(within(diagnostics).getByText("重叠系数").closest("div")).toHaveTextContent("0.82");
    expect(within(diagnostics).getByText("最大权重").closest("div")).toHaveTextContent("6.2");
    const grid = container.querySelector("[data-chart-grid]") as HTMLElement;
    for (const row of grid.querySelectorAll("[data-chart-row]")) expect(row.children.length).toBeGreaterThan(0);
  });

  it("prints 1.04 as 1.04, not as 1.0", async () => {
    const raw = fixture("ev201/comparator.json");
    raw.diagnostics[1].value.value = 1.04;
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const { container } = draw();
    const diagnostics = await found(container, "[data-vcr-diagnostics]");
    expect(within(diagnostics).getByText("最大权重").closest("div")).toHaveTextContent("1.04");
  });

  it("puts the estimand in the one key / value list, with where its target came from", async () => {
    const { container } = draw();
    await found(container, "[data-vcr-diagnostics]");
    const section = screen.getByRole("heading", { name: "估计目标" }).closest("section") as HTMLElement;
    expect(section.querySelector("[data-fact-list]")).not.toBeNull();
    expect(section).toHaveTextContent("对试验人群（ATT）");
  });

  it("has no counts band of its own: the four numbers are on 总览", async () => {
    const { container } = draw();
    await found(container, "[data-vcr-diagnostics]");
    expect(container.querySelector("[data-vcr-counts]")).toBeNull();
  });
});

describe("对照 · comparability and the prior", () => {
  it("rates all ten comparability dimensions as one band of ten cells, each with its own word and reason", async () => {
    const { container } = draw();
    const band = await found(container, "[data-vcr-dimensions]");
    expect(band.closest("section")).toHaveTextContent("可比性");
    expect(band.querySelectorAll("[data-vcr-dimension]")).toHaveLength(10);
    const period = band.querySelector("[data-vcr-dimension='time_period']") as HTMLElement;
    expect(period).toHaveTextContent("近似");
    expect(period).toHaveTextContent("来源试验早于 2020 年");
    expect(band.querySelector("[data-vcr-dimension='geography']")).toHaveTextContent("精确模拟");
    expect(band.querySelector("[data-vcr-dimension='diagnosis']")).toHaveTextContent("未评估");
    expect(container.querySelector("[data-vcr-dimensions-unassessed]")).toBeNull();
  });

  it("marks a dimension that cannot be simulated with a mark as well as a word", async () => {
    const raw = fixture("ev201/comparator.json");
    raw.dimensions[0] = { ...raw.dimensions[0], state: "not_simulable", reason: "没有这一项的数据" };
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const { container } = draw();
    const band = await found(container, "[data-vcr-dimensions]");
    const cell = band.querySelector("[data-vcr-dimension-state='not_simulable']") as HTMLElement;
    expect(cell).toHaveTextContent("无法模拟");
    expect(cell).toHaveTextContent("没有这一项的数据");
    expect(cell.querySelector("svg")).not.toBeNull();
  });

  it("is one chip and the one thing to do about it when none of the ten has been assessed — not ten identical rows and a paragraph", async () => {
    const raw = fixture("ev201/comparator.json");
    raw.dimensions = raw.dimensions.map((dimension: any) => ({ ...dimension, state: "unknown", reason: null }));
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const { container, spies } = draw();
    const note = await found(container, "[data-vcr-dimensions-unassessed]");
    expect(note).toHaveTextContent("可比性：未评估");
    expect(container.querySelector("[data-vcr-dimension]")).toBeNull();
    expect(container.textContent).not.toContain("十个维度都还没有评估");
    await userEvent.click(within(note).getByRole("button", { name: "评估可比性" }));
    expect(spies.openChat).toHaveBeenCalledWith(VCR_ASSESS_COMPARABILITY_DRAFT);
  });

  it("puts a borrowed prior's numbers in a key / value list of their own, apart from the weights — and what a prior effective sample size is, on hover", async () => {
    const raw = fixture("ev201/comparator.json");
    const row = (key: string, label: string, value: number) => ({ key, label, value: { value, text: null, unit: "例", source: "calculated", interval: null, mcse: null, review: "ai_set", precision: null, reason: null, stale: false, detail: null } });
    raw.prior = [row("prior_effective_sample_size_moment", "先验有效样本量（矩法）", 79.2), row("prior_effective_sample_size_elir", "先验有效样本量（ELIR）", 59.4)];
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const { container } = draw();
    const section = (await screen.findByText("先验借用")).closest("section") as HTMLElement;
    expect(section).toHaveTextContent("先验有效样本量（矩法）");
    expect(section).toHaveTextContent("先验有效样本量（ELIR）");
    expect(section.querySelector("[data-vcr-prior='prior_effective_sample_size_moment']")).toHaveTextContent("79.2");
    expect(container.textContent).not.toContain("“矩法”和“ELIR”是两种算法");
    await userEvent.hover(within(section).getByRole("button", { name: "先验有效样本量是什么" }));
    expect((await screen.findAllByText("先验相当于多少例本研究患者的信息量")).length).toBeGreaterThan(0);
    // The weights' card holds the weights and not the prior.
    const weights = container.querySelector("[data-vcr-diagnostics]") as HTMLElement;
    expect(weights).not.toHaveTextContent("先验");
    expect(weights.closest("section")).not.toBe(section);
  });

  it("draws no prior section when no route borrowed one", async () => {
    const { container } = draw();
    await found(container, "[data-vcr-diagnostics]");
    expect(container.querySelector("[data-vcr-prior]")).toBeNull();
    expect(screen.queryByText("先验借用")).toBeNull();
  });

  it("lists the robustness numbers and says in the row beside them that no regulator has qualified a prognostic adjustment, and that an analysis could not be computed", async () => {
    const raw = fixture("ev201/comparator.json");
    const value = (n: number) => ({ ...raw.diagnostics[1].value, value: n, interval: null, mcse: null, unit: null });
    raw.robustness = {
      rows: [{ key: "marginal_risk_difference", label: "边际风险差", value: value(0.11) }, { key: "marginal_odds_ratio", label: "边际比值比（OR）", value: value(1.9) }],
      notes: ["阴性对照结局没有算出：没有一个阴性对照结局能得出估计"],
      qualification: "二分类和事件时间终点的预后协变量调整，目前没有监管机构认可：EMA 2022 年的资格认定意见只覆盖连续终点。",
    };
    installVcrServer(network.productRequest, { [tab("comparator")]: raw });
    const { container } = draw();
    const rows = await found(container, "[data-vcr-robustness]");
    expect(within(rows.closest("section") as HTMLElement).getByText("稳健性与预后校正分析")).toBeInTheDocument();
    expect(within(rows).getByText("边际风险差").closest("div")).toHaveTextContent("0.11");
    expect(within(rows).getByText("边际比值比（OR）").closest("div")).toHaveTextContent("1.9");
    const sentence = within(rows).getByText(/目前没有监管机构认可/);
    expect(sentence).toHaveAttribute("data-vcr-qualification");
    expect(sentence.closest("section")).toBe(rows.closest("section"));
    expect(screen.getByText("阴性对照结局没有算出：没有一个阴性对照结局能得出估计")).toBeInTheDocument();
  });

  it("has no robustness section when the study declared none", async () => {
    const { container } = draw();
    await found(container, "[data-vcr-diagnostics]");
    expect(container.querySelector("[data-vcr-robustness]")).toBeNull();
    expect(screen.queryByText("稳健性与预后校正分析")).toBeNull();
  });
});

describe("对照 · before there is a comparison", () => {
  it("says the first sentence is missing on a study nobody has described, not a rail of routes nobody ran", async () => {
    installVcrServer(network.productRequest, { [tab("comparator")]: fixture("empty/comparator.json") });
    const { container } = renderTab(<ComparatorTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />, { studyId: EMPTY_STUDY_ID });
    expect(await screen.findByText(VCR_NO_DEFINITION)).toBeInTheDocument();
    expect(container.querySelector("[data-vcr-route]")).toBeNull();
  });

  it("is a recipe with one verb-and-object button for a study that has a definition and has not run the step", async () => {
    installVcrServer(network.productRequest, { [tab("comparator")]: fixture("empty/comparator.json") });
    const raw = fixture("ev201/study.json");
    raw.steps.comparator = { status: "none", requested: false };
    const { container } = draw(readVcrStudy(raw));
    const recipe = await found(container, "[data-vcr-step-empty='comparator']");
    await userEvent.click(within(recipe).getByRole("button", { name: "设计对照" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "comparator" }));
  });
});
