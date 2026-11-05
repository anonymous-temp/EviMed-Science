import { cleanup, render, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { readVcrTrial, type VcrValue, type VcrWinRatioCard } from "@/lib/vcrClient";
import { VcrWinRatioDesigns } from "./VcrWinRatioDesigns";

const num = (value: number, unit: string | null, source: VcrValue["source"], extra: Partial<VcrValue> = {}): VcrValue => ({ value, text: null, unit, source, interval: null, mcse: null, review: "ai_set", precision: 1, reason: null, stale: false, detail: null, ...extra });
const simulated = (value: number, unit: string | null, mcse: number, extra: Partial<VcrValue> = {}) => num(value, unit, "synthetic", { mcse, ...extra });

afterEach(cleanup);

const columns = [
  { key: "win_proportion", label: "试验组赢的对数占比" },
  { key: "loss_proportion", label: "对照组赢的对数占比" },
  { key: "tie_proportion", label: "到这一层仍未分出胜负的对数占比" },
];
const levelCells = (win: number, loss: number, tie: number) => ({ win_proportion: simulated(win, "%", 0.08, { precision: 2 }), loss_proportion: simulated(loss, "%", 0.07, { precision: 2 }), tie_proportion: simulated(tie, "%", 0.1, { precision: 2 }) });

const power = (): VcrWinRatioCard => ({
  id: "res_w1", version: 1, form: "win_ratio", title: "死亡、事件次数、评分的分层比较（胜率比）",
  question: "这么多人的试验，判出有效的把握有多大；比较的对子里平局占多少",
  levels: [{ key: "death", label: "死亡" }, { key: "events", label: "事件次数" }, { key: "score", label: "评分" }],
  headline: [
    { key: "power", label: "判出有效的把握（检验功效）", value: simulated(63.8, "%", 1.96, { precision: 1, interval: { kind: "monte_carlo", low: 60, high: 67.7, level: 95 } }) },
    { key: "win_ratio", label: "胜率比（赢的对数 ÷ 输的对数）", value: simulated(1.294, null, 0.0057, { precision: 3, interval: { kind: "prediction", low: 1.065, high: 1.615, level: 95 } }) },
    { key: "win_difference", label: "净胜率（赢的对数占比 − 输的对数占比）", value: simulated(11.2, "%", 0.19) },
    { key: "tie_proportion", label: "平局的对数占比", value: simulated(12.71, "%", 0.065, { precision: 2 }) },
  ],
  size: null, arms: { treat: 250, control: 250 },
  table: {
    columns,
    rows: [
      { key: "death", label: "第 1 层：死亡", cells: levelCells(12.74, 9.65, 77.61) },
      { key: "events", label: "第 2 层：事件次数", cells: levelCells(26.07, 20.4, 31.15) },
      { key: "score", label: "第 3 层：评分", cells: levelCells(10.43, 8.0, 12.71) },
      { key: "total", label: "合计", cells: { win_proportion: simulated(49.24, "%", 0.2, { precision: 2 }), loss_proportion: simulated(38.05, "%", 0.2, { precision: 2 }), tie_proportion: simulated(12.71, "%", 0.065, { precision: 2 }) } },
    ],
  },
  trials: 600,
  premises: [
    { key: "followup", label: "每个人的随访时间", value: "24 个月（死亡或中途退出的人除外）", source: "given", decisive: true, reason: null },
    { key: "level_link", label: "三层之间的关联", value: "任意两层的相关 0.3（病情重的人在每一层上都更差）", source: "default", decisive: true, reason: null },
  ],
  limited: null,
});

const sized = (): VcrWinRatioCard => {
  const card = power();
  card.id = "res_w2";
  card.question = "要有 90% 的把握判出有效，每组需要多少人；这时平局占多少";
  card.size = { perArm: 189, total: 378, powerWanted: 90, verified: true };
  card.arms = { treat: 189, control: 189 };
  card.headline = [{ key: "required_per_arm", label: "每组所需患者数", value: num(189, "例", "calculated", { precision: null, detail: { kind: "run", title: "每组所需患者数", fields: [], quote: null, quoteSource: null, ref: null } }) }, ...card.headline];
  return card;
};

it("prints a result as its question, the lead numbers and the arms, with no size block when nobody asked for one", () => {
  const { container } = render(<VcrWinRatioDesigns designs={[power()]} />);
  const card = container.querySelector('[data-vcr-winratio="win_ratio"]') as HTMLElement;
  expect(card).not.toBeNull();
  expect(within(card).getByRole("heading", { name: "死亡、事件次数、评分的分层比较（胜率比）" })).toBeInTheDocument();
  expect(card.querySelector("[data-vcr-winratio-question]")).toHaveTextContent("判出有效的把握有多大");
  expect(card).toHaveTextContent("模拟 600 次");
  expect(card.querySelector("[data-vcr-winratio-arms]")).toHaveTextContent("试验组 250 人，对照组 250 人");
  expect(card.querySelector("[data-vcr-winratio-size]")).toBeNull();
  const lead = card.querySelector('[data-vcr-card-measure="power"]') as HTMLElement;
  expect(lead).toHaveTextContent("63.8%");
  // A simulated number carries its error.
  expect(lead).toHaveTextContent("±2.0");
  expect(card.querySelector('[data-vcr-card-measure="win_ratio"]')).toHaveTextContent("1.294");
  expect(card.querySelector('[data-vcr-card-measure="win_difference"]')).toHaveTextContent("11.2%");
  expect(card.querySelector('[data-vcr-card-measure="tie_proportion"]')).toHaveTextContent("12.71%");
});

it("words the win ratio's range apart from its simulation error", () => {
  const { container } = render(<VcrWinRatioDesigns designs={[power()]} />);
  const range = container.querySelector("[data-vcr-winratio-range]") as HTMLElement;
  expect(range).toHaveTextContent("换一次同样大小的试验，胜率比大致落在 1.065–1.615 之间（95% 预测区间）");
  expect(range).toHaveTextContent("“±”是模拟本身的误差，不是这个范围");
  // Another interval kind on the ratio is not a range of one trial, so nothing is said.
  const other = power();
  other.headline[1].value.interval = { kind: "monte_carlo", low: 1.2, high: 1.4, level: 95 };
  const second = render(<VcrWinRatioDesigns designs={[other]} />);
  expect(second.container.querySelector("[data-vcr-winratio-range]")).toBeNull();
});

it("prints the levels as rows with the total last, each cell a number and a missing one a dash", () => {
  const card = power();
  const level = card.table?.rows[1];
  if (level) level.cells.loss_proportion = null;
  const { container } = render(<VcrWinRatioDesigns designs={[card]} />);
  const table = within(container).getByRole("table", { name: "死亡、事件次数、评分的分层比较（胜率比）：各层分出胜负的情况" });
  for (const header of ["比较的层次", "试验组赢的对数占比", "对照组赢的对数占比", "到这一层仍未分出胜负的对数占比"]) {
    expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
  }
  const rows = [...table.querySelectorAll("tr[data-vcr-winratio-level]")];
  expect(rows.map((row) => row.getAttribute("data-vcr-winratio-level"))).toEqual(["death", "events", "score", "total"]);
  expect(rows[0]).toHaveTextContent("第 1 层：死亡");
  expect(rows[0]).toHaveTextContent("12.74%");
  expect(rows[0]).toHaveTextContent("77.61%");
  expect(rows[3]).toHaveTextContent("合计");
  expect(rows[3]).toHaveTextContent("49.24%");
  // The middle cell of the second level has no number: a dash, never a zero.
  expect(within(rows[1] as HTMLElement).getAllByRole("cell")[1]).toHaveTextContent("—");
  expect(container).toHaveTextContent("每一层只比较上一层没分出胜负的对");
});

it("leads with the people per arm and the power wanted when a size was asked, and says the power at it was simulated", () => {
  const { container } = render(<VcrWinRatioDesigns designs={[sized()]} />);
  const card = container.querySelector('[data-vcr-winratio-result="res_w2"]') as HTMLElement;
  const size = card.querySelector("[data-vcr-winratio-size]") as HTMLElement;
  expect(size).toHaveTextContent("每组 189 人，共 378 人；要有 90% 的把握判出有效。这个人数下的功效是模拟得到的，不是用公式算出的");
  // The size is not said twice: it leads the card, and is not also a cell of the numbers below.
  expect(card.querySelector('[data-vcr-card-measure="required_per_arm"]')).toBeNull();
  expect(card.querySelector('[data-vcr-card-measure="power"]')).toHaveTextContent("63.8%");
  // It is the question's answer, so the arms line is not repeated.
  expect(card.querySelector("[data-vcr-winratio-arms]")).toBeNull();
  // The number stays a number a reader can open.
  expect(within(size).getByRole("button", { name: /每组所需患者数/ })).toBeInTheDocument();
  expect(size.compareDocumentPosition(card.querySelector("[data-vcr-card-headline]") as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("does not claim the power was simulated at a size that was never checked, and says so once through the limited sentence", () => {
  const card = sized();
  if (card.size) card.size.verified = false;
  card.limited = "预算在核对这个人数之前用完了，这里的人数是用先导模拟推算的，没有再模拟一次验证功效。";
  const { container } = render(<VcrWinRatioDesigns designs={[card]} />);
  expect(container.querySelector("[data-vcr-winratio-size]")).not.toHaveTextContent("模拟得到的");
  const limited = container.querySelector("[data-vcr-winratio-limited]") as HTMLElement;
  expect(limited).toHaveTextContent("没有再模拟一次验证功效");
  expect(limited.compareDocumentPosition(container.querySelector("table") as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("states the premises last, after the table, and carries no back-office word", () => {
  const { container } = render(<VcrWinRatioDesigns designs={[power(), sized()]} />);
  const cards = container.querySelectorAll("[data-vcr-winratio]");
  expect(cards).toHaveLength(2);
  const premises = cards[0].querySelector("[data-vcr-premises]") as HTMLElement;
  expect(premises).toHaveTextContent("三层之间的关联");
  for (const table of cards[0].querySelectorAll("table")) expect(table.compareDocumentPosition(premises) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.textContent).not.toMatch(/win_ratio|vcr_|design_|res_w|「|」|\.json|\.mjs/);
});

it("draws nothing for an empty list", () => {
  const { container } = render(<VcrWinRatioDesigns designs={[]} />);
  expect(container).toBeEmptyDOMElement();
});

it("reads the server's payload defensively: garbage becomes empty, a malformed card is left out, cells keep their places", () => {
  const trial = readVcrTrial({
    winRatioDesigns: [
      "nonsense",
      { id: "bad" },
      { id: "res_x", title: "未知形式", form: "mystery" },
      {
        id: "res_9", form: "win_ratio", title: "死亡、评分的分层比较（胜率比）", question: 7, trials: "many",
        levels: [{ key: "death" }, { key: "death", label: "死亡" }],
        headline: [{ key: "x" }, { key: "power", label: "判出有效的把握", value: 60 }],
        size: { perArm: 100, powerWanted: "x" },
        arms: { treat: "x", control: 100 },
        table: { columns: [{ key: "win_proportion", label: "赢" }, { label: "无名" }], rows: [{ key: "death", label: "第 1 层：死亡", cells: { win_proportion: null, loss_proportion: "x" } }, { cells: {} }] },
        premises: [{ key: "k" }],
      },
    ],
  });
  expect(trial.winRatioDesigns).toHaveLength(1);
  const [card] = trial.winRatioDesigns ?? [];
  expect(card).toMatchObject({ id: "res_9", version: 1, form: "win_ratio", question: "", trials: null, limited: null, premises: [], arms: { treat: null, control: 100 } });
  expect(card.levels).toEqual([{ key: "death", label: "死亡" }]);
  expect(card.headline).toHaveLength(1);
  expect(card.size).toEqual({ perArm: 100, total: 200, powerWanted: null, verified: true });
  expect(card.table?.columns).toEqual([{ key: "win_proportion", label: "赢" }]);
  expect(card.table?.rows).toHaveLength(1);
  expect(card.table?.rows[0].cells).toEqual({ win_proportion: null, loss_proportion: null });
  expect(readVcrTrial({}).winRatioDesigns).toEqual([]);
  expect(readVcrTrial({ winRatioDesigns: {} }).winRatioDesigns).toEqual([]);
  expect(readVcrTrial({ winRatioDesigns: "none" }).winRatioDesigns).toEqual([]);
  // A card with no rows has no table; an explicit false for the check of the size is read as it is.
  const bare = readVcrTrial({ winRatioDesigns: [{ id: "r", form: "win_ratio", title: "t", size: { perArm: 50, total: 100, powerWanted: 80, verified: false } }] }).winRatioDesigns?.[0];
  expect(bare?.table).toBeNull();
  expect(bare?.size).toEqual({ perArm: 50, total: 100, powerWanted: 80, verified: false });
});
