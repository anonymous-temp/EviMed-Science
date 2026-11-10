import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { readVcrTrial, type VcrConfirmatoryCard, type VcrValue } from "@/lib/vcrClient";
import { VcrConfirmatoryDesigns } from "./VcrConfirmatoryDesigns";

const num = (value: number, unit: string, source: VcrValue["source"], extra: Partial<VcrValue> = {}): VcrValue => ({ value, text: null, unit, source, interval: null, mcse: null, review: "ai_set", precision: 1, reason: null, stale: false, detail: null, ...extra });
const simulated = (value: number, unit: string, mcse: number) => num(value, unit, "synthetic", { mcse });
const calculated = (value: number, unit: string) => num(value, unit, "calculated", { precision: null });

afterEach(cleanup);

const reestimation = (): VcrConfirmatoryCard => ({
  id: "res_1", version: 1, design: "sample_size_reestimation", title: "样本量再估计",
  question: "效应没把握，中期加样，功效和平均要多少人", endpoint: "事件时间终点",
  headline: [
    { key: "required_events", label: "固定设计所需事件数", value: calculated(331, "个") },
    { key: "power", label: "功效（拒绝零假设的概率）", value: simulated(94.98, "%", 0.31) },
    { key: "increase_probability", label: "中期加样的概率", value: simulated(31.98, "%", 0.66) },
  ],
  premises: [{ key: "effect", label: "计划的效应（风险比）", value: "0.7", source: "assumed", decisive: true, reason: null }],
  looks: [],
  baselines: [
    { key: "fixed", label: "固定设计所需事件数", text: "331 个事件" },
    { key: "groupSequential", label: "同样分析次数的成组序贯设计最多", text: "332 个事件" },
  ],
  limited: "只算完了一部分模拟（20000 / 3200 / 5000 次，每行各自的次数见表），数字按已算完的给出。",
  table: {
    columns: [
      { key: "power", label: "功效 / I 类错误", group: "本设计" },
      { key: "increase_probability", label: "中期加样的概率", group: "本设计" },
      { key: "fixed_power", label: "功效 / I 类错误", group: "固定设计" },
      { key: "gs_size", label: "期望事件数", group: "成组序贯" },
    ],
    rows: [
      { role: "null", label: "无效应", effect: "风险比 1", iterations: 20000, cells: { power: simulated(2.455, "%", 0.11), increase_probability: simulated(96.56, "%", 0.13), fixed_power: calculated(2.5, "%"), gs_size: null } },
      { role: "assumed", label: "设想的效应", effect: "风险比 0.8", iterations: 3200, cells: { power: simulated(64.42, "%", 0.68), increase_probability: simulated(64.04, "%", 0.68), fixed_power: calculated(52.8, "%"), gs_size: calculated(321.4, "个") } },
      { role: "planned", label: "计划的效应", effect: "风险比 0.7", iterations: 5000, cells: { power: simulated(94.98, "%", 0.31), increase_probability: simulated(31.98, "%", 0.66), fixed_power: calculated(90.05, "%"), gs_size: calculated(290, "个") } },
    ],
  },
});

const futility = (): VcrConfirmatoryCard => ({
  id: "res_2", version: 2, design: "futility_group_sequential", title: "中期无效性停止",
  question: "中期发现没戏就停，能省多少人", endpoint: "连续型终点",
  headline: [{ key: "max_sample_size", label: "最多患者数", value: calculated(281, "例") }],
  premises: [],
  looks: [
    { look: 1, informationRate: 0.4, size: 112.26, efficacyBound: 3.3569, futilityBound: -0.2344, efficacyStop: simulated(10.79, "%", 0.4), futilityStop: simulated(0.93, "%", 0.1), nullFutilityStop: simulated(40.74, "%", 0.7) },
    { look: 2, informationRate: 0.7, size: 196.45, efficacyBound: 2.4445, futilityBound: 1.1228, efficacyStop: simulated(53.31, "%", 0.7), futilityStop: simulated(4, "%", 0.3), nullFutilityStop: simulated(46.45, "%", 0.7) },
    { look: 3, informationRate: 1, size: 280.64, efficacyBound: 2.0005, futilityBound: null, efficacyStop: simulated(25.9, "%", 0.6), futilityStop: null, nullFutilityStop: null },
  ],
  baselines: [{ key: "fixed", label: "固定设计所需样本量", text: "263 例" }],
  limited: null,
  table: {
    columns: [{ key: "power", label: "功效 / I 类错误", group: null }, { key: "futility_stop_probability", label: "中途因无效停止的概率", group: null }],
    rows: [{ role: "planned", label: "计划的效应", effect: "均值差 0.4", iterations: null, cells: { power: simulated(90, "%", 0.4), futility_stop_probability: simulated(4.93, "%", 0.3) } }],
  },
});

it("prints a re-estimation as its own card: the question under the title, grouped columns, units, the limited sentence and the iterations", () => {
  const { container } = render(<VcrConfirmatoryDesigns designs={[reestimation()]} />);
  const card = container.querySelector('[data-vcr-confirmatory="sample_size_reestimation"]') as HTMLElement;
  expect(card).not.toBeNull();
  const title = within(card).getByRole("heading", { name: "样本量再估计" });
  expect(card.querySelector("[data-vcr-confirmatory-question]")).toHaveTextContent("效应没把握，中期加样，功效和平均要多少人");
  expect(title.compareDocumentPosition(card.querySelector("[data-vcr-confirmatory-question]") as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(card).getByText("事件时间终点")).toBeInTheDocument();

  const limited = card.querySelector("[data-vcr-confirmatory-limited]") as HTMLElement;
  expect(limited).toHaveTextContent("只算完了一部分模拟");
  const table = within(card).getByRole("table", { name: "样本量再估计：各假设效应下的结果" });
  expect(limited.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  for (const header of ["本设计 · 功效 / I 类错误", "本设计 · 中期加样的概率", "固定设计 · 功效 / I 类错误", "成组序贯 · 期望事件数"]) {
    expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
  }
  const planned = table.querySelector('tr[data-vcr-effect="planned"]') as HTMLElement;
  expect(planned).toHaveTextContent("计划的效应");
  expect(planned).toHaveTextContent("风险比 0.7");
  expect(planned).toHaveTextContent("95.0%");
  expect(planned).toHaveTextContent("模拟 5,000 次");
  const noEffect = [...table.querySelectorAll("tr[data-vcr-effect]")].find((row) => row.getAttribute("data-vcr-effect") === "null") as HTMLElement;
  expect(noEffect).toHaveTextContent("模拟 20,000 次");
  // A cell that does not apply is a dash, never a zero.
  expect(within(noEffect).getAllByRole("cell").at(-1)).toHaveTextContent("—");
});

it("prints the headline numbers with their units, the baselines and the premises last", () => {
  const { container } = render(<VcrConfirmatoryDesigns designs={[reestimation()]} />);
  const headline = container.querySelector("[data-vcr-confirmatory-headline]") as HTMLElement;
  expect(within(headline).getByText("固定设计所需事件数")).toBeInTheDocument();
  expect(container.querySelector('[data-vcr-confirmatory-measure="power"]')).toHaveTextContent("95.0%");
  expect(container.querySelector('[data-vcr-confirmatory-measure="required_events"]')).toHaveTextContent("331个");
  const baselines = container.querySelector("[data-vcr-confirmatory-baselines]") as HTMLElement;
  expect(baselines).toHaveTextContent("固定设计所需事件数：331 个事件");
  expect(baselines).toHaveTextContent("同样分析次数的成组序贯设计最多：332 个事件");
  const premises = container.querySelector("[data-vcr-premises]") as HTMLElement;
  expect(premises).toHaveTextContent("计划的效应（风险比）");
  expect(baselines.compareDocumentPosition(premises) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("prints a futility design's look boundaries as their own table, a dash where a look has no futility bound", () => {
  const { container } = render(<VcrConfirmatoryDesigns designs={[futility()]} />);
  const card = container.querySelector('[data-vcr-confirmatory="futility_group_sequential"]') as HTMLElement;
  expect(card).not.toBeNull();
  // One kind of column in the effect table: the headers are the plain labels, with no group.
  const effects = within(card).getByRole("table", { name: "中期无效性停止：各假设效应下的结果" });
  expect(within(effects).getByRole("columnheader", { name: "功效 / I 类错误" })).toBeInTheDocument();
  expect(effects).not.toHaveTextContent("模拟");
  const looks = within(card).getByRole("table", { name: "中期无效性停止：各次分析的界值与停止概率" });
  for (const header of ["分析", "信息比例", "样本量", "达标界值（z 值）", "无效界值（z 值）", "达标停止的概率（计划的效应）", "无效停止的概率（计划的效应）", "无效停止的概率（无效应）"]) {
    expect(within(looks).getByRole("columnheader", { name: header })).toBeInTheDocument();
  }
  const first = looks.querySelector('tr[data-vcr-look="1"]') as HTMLElement;
  expect(first).toHaveTextContent("第 1 次");
  expect(first).toHaveTextContent("40%");
  expect(first).toHaveTextContent("112");
  expect(first).toHaveTextContent("3.36");
  expect(first).toHaveTextContent("-0.23");
  expect(first).toHaveTextContent("10.8%");
  const last = looks.querySelector('tr[data-vcr-look="3"]') as HTMLElement;
  expect(last).toHaveTextContent("100%");
  expect(last).toHaveTextContent("—");
});

it("counts events, not people, when the card's own columns are events", () => {
  const card = futility();
  card.table = { columns: [{ key: "expected_events", label: "期望事件数", group: null }], rows: [{ role: "planned", label: "计划的效应", effect: "风险比 0.7", iterations: null, cells: { expected_events: simulated(300, "个", 1) } }] };
  render(<VcrConfirmatoryDesigns designs={[card]} />);
  expect(screen.getByRole("columnheader", { name: "事件数" })).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "样本量" })).toBeNull();
});

it("draws no table for a count-endpoint card that has only headline numbers, and nothing for an empty list", () => {
  const card: VcrConfirmatoryCard = { ...futility(), id: "res_3", design: "count_endpoint", title: "计数终点的样本量", looks: [], table: null, premises: [], baselines: [] };
  const { container, rerender } = render(<VcrConfirmatoryDesigns designs={[card]} />);
  expect(container.querySelector('[data-vcr-confirmatory="count_endpoint"]')).not.toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  rerender(<VcrConfirmatoryDesigns designs={[]} />);
  expect(container).toBeEmptyDOMElement();
});

it("reads the server's payload defensively: an unknown shape becomes empty, a malformed card is left out", () => {
  const trial = readVcrTrial({
    confirmatoryDesigns: [
      "nonsense",
      { id: "bad" },
      { id: "res_9", version: 1, design: "enrichment", title: "人群富集", question: 7, headline: [{ key: "x" }, { key: "power", label: "功效", value: 90 }], looks: [{ look: "a" }], baselines: [{ key: "k" }], table: { columns: [{ key: "power", label: "功效" }], rows: [{ label: "无效应", cells: { power: null, other: "x" } }] } },
    ],
  });
  expect(trial.confirmatoryDesigns).toHaveLength(1);
  const [card] = trial.confirmatoryDesigns ?? [];
  expect(card).toMatchObject({ id: "res_9", question: "", endpoint: "", limited: null, premises: [], looks: [], baselines: [] });
  expect(card.headline).toHaveLength(1);
  expect(card.table?.columns[0]).toEqual({ key: "power", label: "功效", group: null });
  expect(card.table?.rows[0]).toMatchObject({ label: "无效应", iterations: null });
  expect(card.table?.rows[0].cells.power).toBeNull();
  expect(readVcrTrial({}).confirmatoryDesigns).toEqual([]);
});
