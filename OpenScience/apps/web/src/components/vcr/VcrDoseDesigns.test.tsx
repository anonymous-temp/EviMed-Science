import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { readVcrTrial, type VcrDoseCard, type VcrValue } from "@/lib/vcrClient";
import { VcrDoseDesigns } from "./VcrDoseDesigns";

const num = (value: number, unit: string, source: VcrValue["source"], extra: Partial<VcrValue> = {}): VcrValue => ({ value, text: null, unit, source, interval: null, mcse: null, review: "ai_set", precision: 1, reason: null, stale: false, detail: null, ...extra });
const simulated = (value: number, unit: string, mcse: number) => num(value, unit, "synthetic", { mcse });
const calculated = (value: number, unit: string) => num(value, unit, "calculated");

afterEach(cleanup);

const finding = (): VcrDoseCard => ({
  id: "res_d1", version: 1, form: "dose_finding", design: "boin", title: "BOIN 与 3+3 的对比",
  question: "在这条毒性曲线下，几种设计选对最大耐受剂量的概率、超量给药的人数差多少",
  trials: 4000, askedLabel: "BOIN", target: 30,
  doses: [{ dose: 1, toxicity: 10, mtd: false }, { dose: 2, toxicity: 30, mtd: true }, { dose: 3, toxicity: 50, mtd: false }],
  headline: [
    { key: "correct_dose_probability", label: "选对最大耐受剂量的概率", value: simulated(44.8, "%", 0.8) },
    { key: "patients_above_mtd", label: "超过最大耐受剂量的患者数（平均）", value: simulated(3.2, "例", 0.05) },
  ],
  // The engine lists the compared design first; the card puts the asked one on top.
  table: {
    columns: [
      { key: "correct_dose_probability", label: "选对最大耐受剂量的概率" },
      { key: "patients_above_mtd", label: "超过最大耐受剂量的患者数（平均）" },
      { key: "select_none_probability", label: "没有选出剂量的概率" },
    ],
    rows: [
      { kind: "three_plus_three", label: "3+3", role: "compared", cells: { correct_dose_probability: simulated(41.2, "%", 0.8), patients_above_mtd: simulated(2.1, "例", 0.05), select_none_probability: null } },
      { kind: "boin", label: "BOIN", role: "asked", cells: { correct_dose_probability: simulated(44.8, "%", 0.8), patients_above_mtd: simulated(3.2, "例", 0.05), select_none_probability: null } },
    ],
  },
  differences: {
    columns: [{ key: "correct_dose_probability", label: "选对概率之差（百分点）" }, { key: "patients_above_mtd", label: "超量患者数之差" }],
    rows: [{ kind: "three_plus_three", label: "3+3 比 BOIN", cells: { correct_dose_probability: simulated(-3.6, "%", 0.9), patients_above_mtd: simulated(-1.1, "例", 0.05) } }],
    note: "各设计用同一批患者的耐受性模拟，差值的误差按逐次试验的差值计算。",
  },
  perDose: [
    { kind: "three_plus_three", label: "3+3", select: [simulated(20, "%", 0.6), simulated(41.2, "%", 0.8), simulated(30, "%", 0.7)], patients: [simulated(9, "例", 0.1), simulated(10, "例", 0.1), null] },
    { kind: "boin", label: "BOIN", select: [simulated(10.1, "%", 0.5), simulated(44.8, "%", 0.8), simulated(35, "%", 0.7)], patients: [simulated(8, "例", 0.1), simulated(12, "例", 0.1), simulated(5, "例", 0.1)] },
  ],
  premises: [{ key: "curve", label: "各剂量的真实毒性率（共 3 个剂量）", value: "10% / 30% / 50%", source: "assumed", decisive: true, reason: null }],
  limited: null, selection: null,
});

const selection = (): VcrDoseCard => ({
  id: "res_d2", version: 1, form: "dose_selection", design: "randomized_selection", title: "随机分组的剂量选择",
  question: "每个剂量各多少人，才有把握选到更低而不差的剂量",
  trials: null, askedLabel: "", target: null, doses: [], table: null, differences: null, perDose: [],
  headline: [
    { key: "per_arm", label: "每个剂量的患者数", value: calculated(289, "例") },
    { key: "total_patients", label: "患者总数", value: calculated(578, "例") },
  ],
  premises: [{ key: "rates", label: "各情形里各剂量的真实缓解率", value: "30% / 30%；30% / 50%", source: "assumed", decisive: true, reason: null }],
  limited: null,
  selection: {
    perArm: 289, totalPatients: 578, doses: 2, margin: 10, targetProbability: 90, requiredFirst: 289, requiredStable: 313,
    note: "第一次达到的人数是每个剂量 289 人；从每个剂量 313 人起此后每个人数都达到要求。",
    scenarios: [
      { label: "情形 1", rates: [30, 30], rightDose: 1, correct: calculated(99.5, "%"), select: [calculated(99.5, "%"), calculated(0.5, "%")] },
      { label: "情形 2", rates: [30, 50], rightDose: 2, correct: calculated(91.2, "%"), select: [calculated(8.8, "%"), calculated(91.2, "%")] },
    ],
  },
});

it("puts the asked design first in the comparison and names it, under the question and the lead numbers", () => {
  const { container } = render(<VcrDoseDesigns designs={[finding()]} />);
  const card = container.querySelector('[data-vcr-dose="dose_finding"]') as HTMLElement;
  expect(card).not.toBeNull();
  expect(within(card).getByRole("heading", { name: "BOIN 与 3+3 的对比" })).toBeInTheDocument();
  expect(card.querySelector("[data-vcr-dose-question]")).toHaveTextContent("几种设计选对最大耐受剂量的概率");
  expect(card).toHaveTextContent("每种设计模拟 4,000 次");

  const headline = card.querySelector("[data-vcr-card-headline]") as HTMLElement;
  expect(card).toHaveTextContent("BOIN 的主要结果");
  expect(headline.querySelector('[data-vcr-card-measure="correct_dose_probability"]')).toHaveTextContent("44.8%");

  const designs = within(card).getByRole("table", { name: "BOIN 与 3+3 的对比：各种设计的结果" });
  const rows = [...designs.querySelectorAll("tr[data-vcr-dose-design]")];
  expect(rows.map((row) => row.getAttribute("data-vcr-dose-design"))).toEqual(["boin", "three_plus_three"]);
  expect(rows[0]).toHaveTextContent("所问的设计");
  expect(rows[0]).toHaveTextContent("44.8%");
  expect(rows[1]).not.toHaveTextContent("所问的设计");
  // A measure no design has is not a column.
  expect(within(designs).queryByRole("columnheader", { name: "没有选出剂量的概率" })).toBeNull();
  expect(within(designs).getByRole("columnheader", { name: "超过最大耐受剂量的患者数（平均）" })).toBeInTheDocument();
});

it("prints the differences with their note, and the dose-by-dose allocation with the true toxicity and the maximum tolerated dose marked", () => {
  const { container } = render(<VcrDoseDesigns designs={[finding()]} />);
  const card = container.querySelector('[data-vcr-dose="dose_finding"]') as HTMLElement;
  const differences = within(card).getByRole("table", { name: "BOIN 与 3+3 的对比：设计之间的差" });
  const row = differences.querySelector('tr[data-vcr-dose-difference="three_plus_three"]') as HTMLElement;
  expect(row).toHaveTextContent("3+3 比 BOIN");
  expect(row).toHaveTextContent("-3.6");
  expect(card).toHaveTextContent("差值的误差按逐次试验的差值计算");

  const allocation = within(card).getByRole("table", { name: "BOIN 与 3+3 的对比：各剂量被选中的概率与给药的患者数" });
  const headers = within(allocation).getAllByRole("columnheader").map((header) => header.textContent ?? "");
  expect(headers.slice(2)).toEqual(["第 1 剂量真实毒性 10%", "第 2 剂量真实毒性 30%最大耐受剂量", "第 3 剂量真实毒性 50%"]);
  // Two rows a design: the probability of being chosen and the patients given the dose.
  const bodyRows = [...allocation.querySelectorAll("tr[data-vcr-dose-allocation]")];
  expect(bodyRows.map((entry) => entry.getAttribute("data-vcr-dose-allocation"))).toEqual(["boin:select", "boin:patients", "three_plus_three:select", "three_plus_three:patients"]);
  expect(bodyRows[0]).toHaveTextContent("选中的概率");
  expect(bodyRows[0]).toHaveTextContent("44.8%");
  expect(bodyRows[1]).toHaveTextContent("患者数（平均）");
  // A dose nobody was given is a dash, never a zero.
  expect(within(bodyRows[3] as HTMLElement).getAllByRole("cell").at(-1)).toHaveTextContent("—");
  expect(screen.getAllByText("最大耐受剂量")).toHaveLength(1);
});

it("states the premises last, after every table", () => {
  const { container } = render(<VcrDoseDesigns designs={[finding()]} />);
  const premises = container.querySelector("[data-vcr-premises]") as HTMLElement;
  expect(premises).toHaveTextContent("各剂量的真实毒性率（共 3 个剂量）");
  const tables = [...container.querySelectorAll("table")];
  expect(tables).toHaveLength(3);
  for (const table of tables) expect(table.compareDocumentPosition(premises) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("draws one design alone with no comparison, no difference table and no mark on the design", () => {
  const card = finding();
  card.title = "BOIN 的运行特征";
  card.table = card.table && { ...card.table, rows: card.table.rows.filter((row) => row.role === "asked") };
  card.differences = null;
  card.perDose = card.perDose.filter((row) => row.kind === "boin");
  const { container } = render(<VcrDoseDesigns designs={[card]} />);
  expect(container).not.toHaveTextContent("所问的设计");
  expect(screen.queryByRole("table", { name: /设计之间的差/ })).toBeNull();
  expect(screen.getAllByRole("table")).toHaveLength(2);
});

it("says that only part of the simulation was done, before the tables", () => {
  const card = finding();
  card.limited = "只模拟完了一部分试验（1500 次，原定 4000 次），数字按已完成的给出。";
  const { container } = render(<VcrDoseDesigns designs={[card]} />);
  const limited = container.querySelector("[data-vcr-dose-limited]") as HTMLElement;
  expect(limited).toHaveTextContent("只模拟完了一部分试验");
  expect(limited.compareDocumentPosition(container.querySelector("table") as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("prints a randomised dose selection as scenarios: the rates, the right dose, the chance of each dose, and the note", () => {
  const { container } = render(<VcrDoseDesigns designs={[selection()]} />);
  const card = container.querySelector('[data-vcr-dose="dose_selection"]') as HTMLElement;
  expect(card).not.toBeNull();
  // Exact numbers: no simulation count in the heading.
  expect(card).not.toHaveTextContent("模拟");
  expect(card.querySelector('[data-vcr-card-measure="per_arm"]')).toHaveTextContent("289");
  const table = within(card).getByRole("table", { name: "随机分组的剂量选择：各情形下的选择结果" });
  for (const header of ["情形", "各剂量的真实缓解率", "选对的剂量", "选中第 1 剂量的概率", "选中第 2 剂量的概率", "选对的概率"]) {
    expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
  }
  const second = table.querySelector('tr[data-vcr-dose-scenario="情形 2"]') as HTMLElement;
  expect(second).toHaveTextContent("30% / 50%");
  expect(second).toHaveTextContent("第 2 剂量");
  expect(second).toHaveTextContent("91.2%");
  expect(card).toHaveTextContent("从每个剂量 313 人起此后每个人数都达到要求");
  expect(card.querySelector("[data-vcr-premises]")).toHaveTextContent("各情形里各剂量的真实缓解率");
});

it("draws nothing for an empty list", () => {
  const { container } = render(<VcrDoseDesigns designs={[]} />);
  expect(container).toBeEmptyDOMElement();
});

it("reads the server's payload defensively: garbage becomes empty, a malformed card is left out, positions are kept", () => {
  const trial = readVcrTrial({
    doseDesigns: [
      "nonsense",
      { id: "bad" },
      { id: "res_x", title: "未知形式", form: "mystery" },
      {
        id: "res_9", version: 2, form: "dose_finding", title: "BOIN 的运行特征", trials: "many", target: 30,
        doses: [{ dose: 1, toxicity: 10 }, { dose: "x" }],
        headline: [{ key: "x" }, { key: "correct_dose_probability", label: "选对", value: 40 }],
        table: { columns: [{ key: "correct_dose_probability", label: "选对" }], rows: [{ label: "BOIN", cells: { correct_dose_probability: null, other: "x" } }, { cells: {} }] },
        differences: { columns: [], rows: [] },
        perDose: [{ label: "BOIN", select: [null, "x", { value: 5, source: "calculated" }], patients: "none" }],
        premises: [{ key: "k" }],
      },
    ],
    bayesianDesigns: "none",
  });
  expect(trial.doseDesigns).toHaveLength(1);
  const [card] = trial.doseDesigns ?? [];
  expect(card).toMatchObject({ id: "res_9", version: 2, form: "dose_finding", trials: null, question: "", askedLabel: "", limited: null, selection: null, differences: null, premises: [] });
  expect(card.doses).toEqual([{ dose: 1, toxicity: 10, mtd: false }]);
  expect(card.headline).toHaveLength(1);
  expect(card.table?.rows).toHaveLength(1);
  expect(card.table?.rows[0].cells.correct_dose_probability).toBeNull();
  expect(card.perDose[0].select).toHaveLength(3);
  expect(card.perDose[0].select[0]).toBeNull();
  expect(card.perDose[0].select[2]?.value).toBe(5);
  expect(card.perDose[0].patients).toEqual([]);
  expect(readVcrTrial({}).doseDesigns).toEqual([]);
  expect(readVcrTrial({ doseDesigns: {} }).doseDesigns).toEqual([]);
  expect(readVcrTrial({ bayesianDesigns: "none" }).bayesianDesigns).toEqual([]);
});
