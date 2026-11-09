import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readDoseResponseCards, readVcrData, type VcrDoseResponseCard } from "@/lib/vcrClient";
import { ratioAxis, VcrDoseResponse } from "./VcrDoseResponse";
import payloads from "./__fixtures__/evidenceSynthesisPayloads.json";

/**
 * 剂量反应荟萃分析: the card drawn from what the server's presenter makes of the engine's real results
 * (`__fixtures__/evidenceSynthesisPayloads.json`). The curve and the table are the engine's own numbers placed on a log axis.
 */

afterEach(cleanup);

const sample = (key: "dose-linear" | "dose-spline"): VcrDoseResponseCard => {
  const [card] = readDoseResponseCards([payloads[key]]);
  if (!card) throw new Error(`the ${key} sample did not read`);
  return card;
};
const draw = (card: VcrDoseResponseCard) => {
  const view = render(<VcrDoseResponse cards={[card]} />);
  return { ...view, root: view.container.querySelector("[data-vcr-dose-response]") as HTMLElement };
};
const follows = (earlier: Element, later: Element) => Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("剂量反应 · the card", () => {
  it("opens with the title, the question and the headline sentence", () => {
    const { root } = draw(sample("dose-linear"));
    const title = within(root).getByRole("heading", { name: "剂量反应：alcohol and colorectal cancer" });
    const question = root.querySelector("[data-vcr-evidence-question]") as HTMLElement;
    const headline = root.querySelector("[data-vcr-dose-headline]") as HTMLElement;
    expect(question).toHaveTextContent("从多大剂量开始有效？随着剂量增加，是一直上升还是趋于平缓？");
    expect(headline).toHaveTextContent("剂量每增加 12 g/day，相对危险度变为 1.08");
    expect(follows(title, question)).toBe(true);
    expect(follows(question, headline)).toBe(true);
    expect(follows(headline, root.querySelector("[data-vcr-dose-curve]") as Element)).toBe(true);
  });

  it("draws the curve with its band on a log axis: the null line at 1 is labelled, the labels are ratios and the doses are the predicted ones", () => {
    const { root } = draw(sample("dose-spline"));
    const curve = root.querySelector("[data-vcr-dose-curve]") as HTMLElement;
    expect(curve.querySelector("path[data-vcr-series-line]")?.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+ L/);
    expect(curve.querySelector("path[data-vcr-band='confidence']")?.getAttribute("d")).toMatch(/Z$/);
    expect(curve.querySelector("line[data-vcr-null-line]")).not.toBeNull();
    // the ratio axis: round ratios, 1 among them, with its scale named
    expect(curve).toHaveTextContent("相对危险度（对数刻度）");
    const ticks = [...curve.querySelectorAll("span.text-right")].map((tick) => tick.textContent);
    expect(ticks).toContain("1");
    expect(ticks.every((tick) => /^\d+(\.\d+)?$/.test(tick ?? ""))).toBe(true);
    // the x axis: the doses the card predicted at, and the unit
    expect(curve).toHaveTextContent("剂量（g/day）");
    const doses = [...curve.querySelectorAll("span.-translate-x-1\\/2.whitespace-nowrap")].map((label) => label.textContent);
    expect(doses).toEqual(["0", "12", "24", "36", "48", "60"]);
    // a dot at each predicted dose
    expect(curve.querySelectorAll("[data-vcr-dose-point]")).toHaveLength(6);
  });

  it("puts 1 at the same height as the null line and the reference dose at 1: the log axis is a straight reading of the ratios", () => {
    const { root } = draw(sample("dose-spline"));
    const line = root.querySelector("line[data-vcr-null-line]") as SVGLineElement;
    const reference = root.querySelector("[data-vcr-dose-point='0']") as HTMLElement;
    const nullAt = Number(line.getAttribute("y1"));
    expect(reference.style.top).toBe(`${nullAt}%`);
    // 1.53 sits higher up the plot than 1 (a smaller y), 0.947 lower
    const top = (dose: number) => Number.parseFloat((root.querySelector(`[data-vcr-dose-point='${dose}']`) as HTMLElement).style.top);
    expect(top(60)).toBeLessThan(nullAt);
    expect(top(12)).toBeGreaterThan(nullAt);
  });

  it("names the band by its level and draws the curve dashed, as every pooled estimate is", () => {
    const { root } = draw(sample("dose-spline"));
    expect(root.querySelector("[data-vcr-legend-band]")).toHaveTextContent("95% 置信区间");
    expect(root.querySelector("[data-vcr-legend-source='aggregate']")).toHaveTextContent("虚线 = 汇总数据");
    expect(root.querySelector("path[data-vcr-series-line]")?.getAttribute("stroke-dasharray")).toBe("4 3");
  });

  it("lists the predictions in a small table with the reference dose marked and no interval claimed for it", () => {
    const { root } = draw(sample("dose-spline"));
    const table = within(root).getByRole("table", { name: "剂量反应：alcohol and colorectal cancer：各剂量的估计" });
    expect(within(table).getByRole("columnheader", { name: "剂量（g/day）" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "相对危险度" })).toBeInTheDocument();
    const rows = [...table.querySelectorAll("tbody tr")] as HTMLElement[];
    expect(rows.map((row) => row.getAttribute("data-vcr-dose-row"))).toEqual(["0", "12", "24", "36", "48", "60"]);
    expect(rows[0]).toHaveAttribute("data-vcr-dose-reference");
    expect(rows[0]).toHaveTextContent("参照");
    expect(rows[0]).not.toHaveTextContent("置信区间");
    expect(within(table).getAllByText("参照")).toHaveLength(1);
    expect(rows[5]).toHaveTextContent("1.53");
    expect(rows[5]).toHaveTextContent("95% 置信区间 1.251–1.877");
    expect(rows[1]).toHaveTextContent("0.947");
  });

  it("says where the curve first leaves 1, then the tests that are there, the heterogeneity and the note, then the premises", () => {
    const { root } = draw(sample("dose-spline"));
    const first = root.querySelector("[data-vcr-first-dose]") as HTMLElement;
    expect(first).toHaveTextContent("从大约 30.1 g/day 起");
    expect(first).toHaveTextContent("不是数据确定下来的起效剂量");
    expect(root.querySelector("[data-vcr-dose-test='overall']")).toHaveTextContent("剂量与效应有关的总体检验 P = 0.00000305");
    expect(root.querySelector("[data-vcr-dose-test='nonlinearity']")).toHaveTextContent("非线性检验 P = 0.078");
    expect(root.querySelector("[data-vcr-dose-heterogeneity]")).toHaveTextContent("研究之间的差异：I² = 0%（Q 检验 P = 0.486）。");
    const note = root.querySelector("[data-vcr-dose-note]") as HTMLElement;
    expect(note).toHaveTextContent("不是对某一个人的预测");
    const premises = within(root).getByRole("heading", { name: "这个结论的前提" }).closest("section") as HTMLElement;
    expect(follows(first, root.querySelector("[data-vcr-dose-test='overall']") as Element)).toBe(true);
    expect(follows(note, premises)).toBe(true);
    expect(premises.querySelector("[data-vcr-premise='model']")).toHaveTextContent("样条");
  });

  it("has no nonlinearity test for a straight line, and says the step of dose in the headline instead", () => {
    const { root } = draw(sample("dose-linear"));
    expect(root.querySelector("[data-vcr-dose-test='nonlinearity']")).toBeNull();
    expect(root.querySelector("[data-vcr-dose-test='overall']")).toHaveTextContent("总体检验");
    expect(root.querySelector("[data-vcr-first-dose]")).toHaveTextContent("从大约 0.305 g/day 起");
  });

  it("names the studies the model could not take in as a plain line, and not otherwise", () => {
    const { root, rerender } = draw({ ...sample("dose-linear"), excluded: ["S2", "S7"] });
    expect(root.querySelector("[data-vcr-dose-excluded]")).toHaveTextContent("没能纳入的研究：S2、S7");
    rerender(<VcrDoseResponse cards={[sample("dose-linear")]} />);
    expect(document.querySelector("[data-vcr-dose-excluded]")).toBeNull();
  });

  it("draws no banner or disclaimer of its own, and no back-office word", () => {
    const { root } = draw(sample("dose-spline"));
    expect(root.querySelector("[role='alert'], [role='status']")).toBeNull();
    expect(root.textContent).not.toMatch(/dosresmeta|evidence\.|diagnostics|引擎|job_/);
  });
});

describe("剂量反应 · what is not there", () => {
  it("draws nothing for no cards", () => {
    const { container } = render(<VcrDoseResponse cards={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws the table without a chart when the curve is missing, and the chart without a table when no dose was predicted", () => {
    const card = sample("dose-spline");
    const noCurve = draw({ ...card, curve: [] });
    expect(noCurve.root.querySelector("[data-vcr-dose-curve]")).toBeNull();
    expect(noCurve.root.querySelectorAll("tbody tr")).toHaveLength(6);
    cleanup();
    const noTable = draw({ ...card, predictions: [] });
    expect(noTable.root.querySelector("[data-vcr-dose-curve]")).not.toBeNull();
    expect(noTable.root.querySelector("table")).toBeNull();
    // the x axis then falls back to a round scale over the curve
    expect(noTable.root.querySelectorAll("[data-vcr-dose-point]")).toHaveLength(0);
  });

  it("labels at most seven doses on the axis however many the card predicted at", () => {
    const card = sample("dose-spline");
    const many = Array.from({ length: 15 }, (_, index) => ({ ...card.predictions[1], dose: index * 4, isReference: index === 0 }));
    const { root } = draw({ ...card, predictions: many });
    const doses = [...root.querySelectorAll("[data-vcr-dose-curve] span.-translate-x-1\\/2.whitespace-nowrap")].map((label) => label.textContent);
    expect(doses.length).toBeLessThanOrEqual(7);
    expect(doses[0]).toBe("0");
    // every predicted dose still has its dot and its row
    expect(root.querySelectorAll("[data-vcr-dose-point]")).toHaveLength(15);
    expect(root.querySelectorAll("tr[data-vcr-dose-row]")).toHaveLength(15);
  });

  it("does not draw a point a log axis cannot place, and no chart when fewer than two remain", () => {
    const card = sample("dose-spline");
    const { root } = draw({ ...card, curve: card.curve.map((point, index) => (index === 0 ? { ...point, lower: 0 } : point)) });
    expect(root.querySelector("path[data-vcr-series-line]")).not.toBeNull();
    cleanup();
    const none = draw({ ...card, curve: card.curve.map((point) => ({ ...point, lower: 0 })) });
    expect(none.root.querySelector("[data-vcr-dose-curve]")).toBeNull();
  });

  it("draws only what was sent: no tests, no heterogeneity, no note, no premises", () => {
    const card = sample("dose-spline");
    const { root } = draw({ ...card, headline: null, firstDose: null, tests: { overall: null, nonlinearity: null }, heterogeneity: null, note: null, premises: [] });
    expect(root.querySelector("[data-vcr-dose-headline], [data-vcr-first-dose], [data-vcr-dose-test], [data-vcr-dose-heterogeneity], [data-vcr-dose-note]")).toBeNull();
    expect(within(root).queryByRole("heading", { name: "这个结论的前提" })).toBeNull();
    expect(root.querySelector("[data-vcr-dose-curve]")).not.toBeNull();
  });
});

describe("剂量反应 · the ratio axis", () => {
  const labels = (scale: ReturnType<typeof ratioAxis>) => scale?.ticks.map((tick) => Number(Math.exp(tick).toPrecision(3)));

  it("is in natural logs with round ratios as ticks, 1 always one of them and few enough to read", () => {
    for (const [values, expected] of [
      [[0.837, 1.877], [0.8, 1, 1.2, 1.4, 1.8]],
      [[0.99, 1.05], [0.9, 1, 1.1]],
      [[0.3, 12], [0.5, 1, 2, 4, 8]],
    ] as const) {
      const scale = ratioAxis(values);
      expect(labels(scale)).toEqual(expected);
      expect(scale!.ticks.length).toBeLessThanOrEqual(5);
    }
    const scale = ratioAxis([0.19, 0.6, 1.4])!;
    expect(labels(scale)).toContain(1);
    // the scale covers every value it was given
    expect(Math.exp(scale.low)).toBeLessThanOrEqual(0.19);
    expect(Math.exp(scale.high)).toBeGreaterThanOrEqual(1.4);
  });

  it("still has a span when every ratio is exactly 1, and places nothing for no ratio at all", () => {
    const flat = ratioAxis([1, 1, 1])!;
    expect(flat.high).toBeGreaterThan(flat.low);
    expect(labels(flat)).toContain(1);
    expect(ratioAxis([])).toBeNull();
    expect(ratioAxis([null, undefined, 0, -2, Number.NaN])).toBeNull();
  });
});

describe("读取 · the payload", () => {
  it("keeps the curve, the predictions and the tests as sent", () => {
    const [card] = readDoseResponseCards([payloads["dose-spline"]]);
    expect(card.curve).toHaveLength(41);
    expect(card.curve[0]).toEqual({ dose: 0, ratio: 1, lower: 1, upper: 1 });
    expect(card.predictions.map((row) => row.dose)).toEqual([0, 12, 24, 36, 48, 60]);
    expect(card.predictions[0].isReference).toBe(true);
    expect(card.predictions[5].value.interval).toMatchObject({ kind: "confidence", low: 1.251, high: 1.877, level: 95 });
    expect(card.tests.nonlinearity?.value).toBe(0.07845148);
    expect(card.referenceDose).toBe(0);
    expect(card.doseUnit).toBe("g/day");
  });

  it("reads anything of an unknown shape as no card, and a malformed part as a part that is not there", () => {
    for (const garbage of [undefined, null, 7, "x", {}, [], [null], [{}], [{ id: "a" }]]) expect(readDoseResponseCards(garbage)).toEqual([]);
    const broken = {
      ...payloads["dose-spline"], curve: [{ dose: 1 }, { dose: "a", ratio: 1, lower: 1, upper: 1 }, null], predictions: [{ dose: 1, value: 3 }, { value: {} }],
      tests: { overall: "x", nonlinearity: {} }, excluded: [{ levels: 1 }, { studyId: "S9" }], premises: 4, firstDose: "none", heterogeneity: [],
    };
    const [card] = readDoseResponseCards([broken]);
    expect(card.curve).toEqual([]);
    expect(card.predictions).toEqual([]);
    expect(card.tests).toEqual({ overall: null, nonlinearity: null });
    expect(card.excluded).toEqual(["S9"]);
    expect(card).toMatchObject({ premises: [], firstDose: null, heterogeneity: null });
  });

  it("comes through the evidence tab's reader as a list, empty when the server sent none", () => {
    expect(readVcrData({ doseResponses: [payloads["dose-linear"]] }).doseResponses?.map((card) => card.id)).toEqual(["res_dose-linear"]);
    for (const junk of [undefined, null, "x", {}, 5]) expect(readVcrData({ doseResponses: junk }).doseResponses).toEqual([]);
  });
});
