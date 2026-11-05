import { cleanup, render, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { readVcrTrial, type VcrBayesianCard, type VcrValue } from "@/lib/vcrClient";
import { VcrBayesianDesigns } from "./VcrBayesianDesigns";

const exact = (value: number, unit: string): VcrValue => ({ value, text: null, unit, source: "calculated", interval: null, mcse: null, review: "ai_set", precision: 1, reason: null, stale: false, detail: null });

afterEach(cleanup);

const simon = (n1: number, r1: number, n: number, r: number) => ({
  rule: `第一阶段 ${n1} 人，有效不超过 ${r1} 例则停止；共 ${n} 人，有效超过 ${r} 例则成功`,
  typeOneError: exact(4.9, "%"), power: exact(80.3, "%"), expectedNull: exact(15.4, "例"), expectedAlt: exact(26.1, "例"),
});

const phaseTwo = (): VcrBayesianCard => ({
  id: "res_b1", version: 1, form: "bop2", design: "bop2", title: "贝叶斯最优 II 期设计（BOP2）",
  question: "单臂 II 期每隔几人看一次，何时停，比 Simon 两阶段设计少多少人",
  headline: [
    { key: "type_one_error", label: "I 类错误（无效应时仍判成功的概率）", value: exact(3.9, "%") },
    { key: "power", label: "功效（有效应时判成功的概率）", value: exact(81.6, "%") },
  ],
  looks: [
    { look: 1, size: 10, rule: "累计有效不超过 0 例则停止（无效）" },
    { look: 2, size: 20, rule: "累计有效不超过 2 例则停止（无效）" },
    { look: 3, size: 30, rule: "有效达到 6 例及以上则成功，否则失败" },
  ],
  operating: {
    rows: [
      { role: "null", label: "无效应时（有效率 10%）", cells: { success: exact(3.9, "%"), expected: exact(24.6, "例"), futility: exact(70.3, "%"), efficacy: null } },
      { role: "alternative", label: "有效应时（有效率 30%）", cells: { success: exact(81.6, "%"), expected: exact(29.1, "例"), futility: exact(5.2, "%"), efficacy: null } },
    ],
    stops: [
      { look: 1, size: 10, nullFutility: exact(34.9, "%"), alternativeFutility: exact(2.8, "%") },
      { look: 2, size: 20, nullFutility: exact(35.4, "%"), alternativeFutility: null },
    ],
  },
  found: "λ = 0.91，γ = 1.15（在网格上搜索得到）",
  reachedPower: true,
  simon: { optimal: simon(10, 1, 29, 5), minimax: simon(15, 1, 25, 5), saving: exact(-9.6, "例") },
  calibration: null,
  premises: [{ key: "rates", label: "无效应与有效应时的有效率", value: "10% 与 30%", source: "assumed", decisive: true, reason: null }],
  limited: null,
});

const calibration = (): VcrBayesianCard => ({
  id: "res_b3", version: 1, form: "calibration", design: "threshold_calibration", title: "成功阈值的校准",
  question: "用这个先验和阈值，I 类错误和功效是多少，要把 I 类错误校到规定水平，阈值应取多少",
  headline: [{ key: "calibrated_threshold", label: "校准后的成功阈值", value: exact(97.4, "%") }],
  looks: [], operating: null, found: null, reachedPower: false, simon: null,
  calibration: {
    endpoint: "二分类终点（率差）", discrete: true,
    note: "二项数据只有有限种结果，I 类错误随阈值呈阶梯形变化。",
    rows: [
      { kind: "calibrated", label: "校准后的阈值（I 类错误不超过规定水平的最小阈值）", threshold: exact(97.4, "%"), typeOneError: exact(2.4, "%"), power: exact(66, "%") },
      { kind: "stated", label: "你给的阈值", threshold: exact(95, "%"), typeOneError: exact(6.1, "%"), power: exact(75.2, "%") },
    ],
  },
  premises: [{ key: "alpha", label: "规定的 I 类错误（单侧）", value: "2.5%", source: "default", decisive: true, reason: null }],
  limited: null,
});

it("prints a phase II design as its question, the lead numbers, the rule it found and the rule of each look", () => {
  const { container } = render(<VcrBayesianDesigns designs={[phaseTwo()]} />);
  const card = container.querySelector('[data-vcr-bayes="bop2"]') as HTMLElement;
  expect(card).not.toBeNull();
  expect(within(card).getByRole("heading", { name: "贝叶斯最优 II 期设计（BOP2）" })).toBeInTheDocument();
  expect(card.querySelector("[data-vcr-bayes-question]")).toHaveTextContent("比 Simon 两阶段设计少多少人");
  expect(card.querySelector('[data-vcr-card-measure="power"]')).toHaveTextContent("81.6%");
  // An exact number carries no simulation error.
  expect(card).not.toHaveTextContent("±");
  expect(card.querySelector("[data-vcr-bayes-found]")).toHaveTextContent("得到的设计：λ = 0.91，γ = 1.15（在网格上搜索得到）");
  expect(card.querySelector("[data-vcr-bayes-unreached]")).toBeNull();

  const looks = within(card).getByRole("table", { name: "贝叶斯最优 II 期设计（BOP2）：各次分析的规则" });
  const second = looks.querySelector('tr[data-vcr-bayes-look="2"]') as HTMLElement;
  expect(second).toHaveTextContent("第 2 次");
  expect(second).toHaveTextContent("20 人");
  expect(second).toHaveTextContent("累计有效不超过 2 例则停止（无效）");
  expect(looks.querySelector('tr[data-vcr-bayes-look="3"]')).toHaveTextContent("有效达到 6 例及以上则成功，否则失败");
});

it("names the success probability the type I error under no effect and the power under the planned one, and drops a column nobody fills", () => {
  const { container } = render(<VcrBayesianDesigns designs={[phaseTwo()]} />);
  const card = container.querySelector('[data-vcr-bayes="bop2"]') as HTMLElement;
  const table = within(card).getByRole("table", { name: "贝叶斯最优 II 期设计（BOP2）：无效应与有效应时的运行特征" });
  // (A selector with the value "null" matches the wrong row in jsdom, so the rows are listed and found.)
  const rowOf = (role: string) => [...table.querySelectorAll("tr[data-vcr-bayes-scenario]")].find((row) => row.getAttribute("data-vcr-bayes-scenario") === role) as HTMLElement;
  const none = rowOf("null");
  expect(none).toHaveTextContent("无效应时（有效率 10%）");
  expect(none).toHaveTextContent("3.9%");
  expect(none).toHaveTextContent("I 类错误");
  expect(none).toHaveTextContent("24.6");
  const alternative = rowOf("alternative");
  expect(alternative).toHaveTextContent("81.6%");
  expect(alternative).toHaveTextContent("功效");
  expect(within(table).getByRole("columnheader", { name: "中途因无效停止的概率" })).toBeInTheDocument();
  expect(within(table).queryByRole("columnheader", { name: "中途提前宣布成功的概率" })).toBeNull();

  const stops = within(card).getByRole("table", { name: "贝叶斯最优 II 期设计（BOP2）：每次分析因无效而停止的概率" });
  expect(stops.querySelector('tr[data-vcr-bayes-stop="1"]')).toHaveTextContent("34.9%");
  // A look the engine gave no number for is a dash.
  expect(within(stops.querySelector('tr[data-vcr-bayes-stop="2"]') as HTMLElement).getAllByRole("cell").at(-1)).toHaveTextContent("—");
});

it("reads Simon's two designs beside it and says the saving in one sentence, more patients when the saving is negative", () => {
  const { container, rerender } = render(<VcrBayesianDesigns designs={[phaseTwo()]} />);
  const card = container.querySelector('[data-vcr-bayes="bop2"]') as HTMLElement;
  const table = within(card).getByRole("table", { name: "贝叶斯最优 II 期设计（BOP2）：与 Simon 两阶段设计相比" });
  const optimal = table.querySelector('tr[data-vcr-bayes-simon="optimal"]') as HTMLElement;
  expect(optimal).toHaveTextContent("最优设计");
  expect(optimal).toHaveTextContent("第一阶段 10 人，有效不超过 1 例则停止；共 29 人，有效超过 5 例则成功");
  expect(optimal).toHaveTextContent("80.3%");
  expect(table.querySelector('tr[data-vcr-bayes-simon="minimax"]')).toHaveTextContent("最小最大设计");
  const sentence = card.querySelector("[data-vcr-bayes-saving]") as HTMLElement;
  expect(sentence).toHaveTextContent("无效应时，这个设计的期望样本量比 Simon 最优设计多");
  expect(sentence).toHaveTextContent("9.6");
  expect(sentence.textContent).not.toContain("-");
  expect(sentence.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const fewer = phaseTwo();
  if (fewer.simon) fewer.simon.saving = exact(7.3, "例");
  rerender(<VcrBayesianDesigns designs={[fewer]} />);
  expect(container.querySelector("[data-vcr-bayes-saving]")).toHaveTextContent("比 Simon 最优设计少");
  expect(container.querySelector("[data-vcr-bayes-saving]")).toHaveTextContent("7.3");
});

it("says when the power asked for was not reached, and states the premises after everything", () => {
  const card = phaseTwo();
  card.reachedPower = false;
  const { container } = render(<VcrBayesianDesigns designs={[card]} />);
  expect(container.querySelector("[data-vcr-bayes-unreached]")).toHaveTextContent("功效没有达到要求");
  const premises = container.querySelector("[data-vcr-premises]") as HTMLElement;
  expect(premises).toHaveTextContent("无效应与有效应时的有效率");
  for (const table of container.querySelectorAll("table")) expect(table.compareDocumentPosition(premises) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("prints predictive monitoring's final rule and its early-success column when the design can stop for success", () => {
  const card = phaseTwo();
  card.form = "predictive";
  card.design = "predictive_monitoring";
  card.title = "预测概率监测";
  card.found = "最终有效达到 8 例及以上则成功；最终后验概率阈值取在 (90.8%，96.2%] 内，得到的规则都一样";
  if (card.operating) card.operating.rows[0].cells.efficacy = exact(1.2, "%");
  const { container } = render(<VcrBayesianDesigns designs={[card]} />);
  expect(container.querySelector('[data-vcr-bayes="predictive"]')).not.toBeNull();
  expect(container.querySelector("[data-vcr-bayes-found]")).toHaveTextContent("最终后验概率阈值取在 (90.8%，96.2%] 内");
  expect(within(container).getByRole("columnheader", { name: "中途提前宣布成功的概率" })).toBeInTheDocument();
});

it("draws no Simon block when the card has no Simon design, and no stop table when no look stops", () => {
  const card = phaseTwo();
  card.simon = null;
  if (card.operating) card.operating.stops = [];
  const { container } = render(<VcrBayesianDesigns designs={[card]} />);
  expect(container.querySelector("[data-vcr-bayes-saving]")).toBeNull();
  expect(container.querySelectorAll("table")).toHaveLength(2);
});

it("prints a calibration as the thresholds side by side, with the endpoint and the note", () => {
  const { container } = render(<VcrBayesianDesigns designs={[calibration()]} />);
  const card = container.querySelector('[data-vcr-bayes="calibration"]') as HTMLElement;
  expect(card).not.toBeNull();
  expect(card).toHaveTextContent("二分类终点（率差）");
  expect(card.querySelector('[data-vcr-card-measure="calibrated_threshold"]')).toHaveTextContent("97.4%");
  const table = within(card).getByRole("table", { name: "成功阈值的校准：不同阈值下的 I 类错误与功效" });
  for (const header of ["阈值", "成功阈值（后验概率）", "I 类错误", "功效"]) {
    expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
  }
  const stated = table.querySelector('tr[data-vcr-bayes-threshold="stated"]') as HTMLElement;
  expect(stated).toHaveTextContent("你给的阈值");
  expect(stated).toHaveTextContent("95.0%");
  expect(stated).toHaveTextContent("6.1%");
  expect(card).toHaveTextContent("I 类错误随阈值呈阶梯形变化");
  // A calibration has no looks and nothing to compare with Simon's.
  expect(card.querySelectorAll("table")).toHaveLength(1);
  expect(card.querySelector("[data-vcr-bayes-unreached]")).toBeNull();
});

it("draws nothing for an empty list", () => {
  const { container } = render(<VcrBayesianDesigns designs={[]} />);
  expect(container).toBeEmptyDOMElement();
});

it("reads the server's payload defensively: garbage becomes empty, a malformed card is left out", () => {
  const trial = readVcrTrial({
    bayesianDesigns: [
      "nonsense",
      { id: "bad" },
      { id: "res_x", title: "未知", form: "mystery" },
      {
        id: "res_9", form: "bop2", title: "贝叶斯最优 II 期设计（BOP2）", question: 7,
        headline: [{ key: "x" }, { key: "power", label: "功效", value: 80 }],
        looks: [{ look: "a" }, { look: 1, size: 10 }],
        operating: { rows: [{ role: "null", cells: {} }, { label: "无效应时", cells: { success: null, expected: "x" } }], stops: [{ look: 1, nullFutility: { value: 3, source: "calculated" } }, { size: 4 }] },
        simon: { optimal: { rule: "" }, minimax: null, saving: 3 },
        calibration: { rows: [] },
      },
    ],
  });
  expect(trial.bayesianDesigns).toHaveLength(1);
  const [card] = trial.bayesianDesigns ?? [];
  expect(card).toMatchObject({ id: "res_9", version: 1, question: "", found: null, limited: null, reachedPower: true, simon: null, calibration: null, premises: [] });
  expect(card.headline).toHaveLength(1);
  expect(card.looks).toEqual([{ look: 1, size: 10, rule: "" }]);
  expect(card.operating?.rows).toHaveLength(1);
  expect(card.operating?.rows[0].cells).toEqual({ success: null, expected: null, futility: null, efficacy: null });
  expect(card.operating?.stops).toHaveLength(1);
  expect(card.operating?.stops[0].alternativeFutility).toBeNull();
  expect(readVcrTrial({}).bayesianDesigns).toEqual([]);
});

it("reads an explicit false for the power as not reached, and anything else as nothing to say", () => {
  const read = (reachedPower: unknown) => readVcrTrial({ bayesianDesigns: [{ id: "r", form: "predictive", title: "预测概率监测", reachedPower }] }).bayesianDesigns?.[0].reachedPower;
  expect(read(false)).toBe(false);
  expect(read(true)).toBe(true);
  expect(read(undefined)).toBe(true);
});
