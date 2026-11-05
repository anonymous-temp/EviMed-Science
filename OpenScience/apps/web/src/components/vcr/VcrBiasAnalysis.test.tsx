import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readVcrComparator, type VcrBiasAnalysisCard, type VcrTrimCard } from "@/lib/vcrClient";
import { VcrBiasAnalysis } from "./VcrBiasAnalysis";
import { VcrTrimRestatement } from "./VcrTrimRestatement";
import payloads from "./__fixtures__/biasAnalysisPayloads.json";

/**
 * 偏倚分析 and 修剪后的人群: the cards of a comparison, drawn from what the server's presenters make of real engine results
 * (`__fixtures__/biasAnalysisPayloads.json`). The web places the numbers it is sent; it computes none of them.
 */

afterEach(cleanup);

const sample = (key: "bias-ratio" | "bias-null" | "bias-difference"): VcrBiasAnalysisCard => {
  const card = readVcrComparator({ biasAnalysis: payloads[key] }).biasAnalysis;
  if (!card) throw new Error(`the ${key} sample did not read`);
  return card;
};
const trimSample = (): VcrTrimCard => {
  const trim = readVcrComparator({ trim: payloads.trim }).trim;
  if (!trim) throw new Error("the trim sample did not read");
  return trim;
};
const part = (root: ParentNode, name: string) => root.querySelector(`[data-vcr-bias-part='${name}']`) as HTMLElement | null;

describe("偏倚分析 · the card", () => {
  it("opens with the question as its title, then the estimate analysed and the tipping sentence with its two numbers", () => {
    const { container } = render(<VcrBiasAnalysis card={sample("bias-ratio")} />);
    const card = container.querySelector("[data-vcr-bias-analysis]") as HTMLElement;
    expect(within(card).getByRole("heading", { name: "未测混杂要造成多大的偏移，结论才翻？" })).toBeInTheDocument();
    expect(card.querySelector("[data-vcr-bias-estimate]")).toHaveTextContent("被分析的估计：风险比（HR） 0.7（95% 区间 0.5–0.98）");
    expect(card.querySelector("[data-vcr-bias-tipping]")).toHaveTextContent("偏倚要把效应夸大 1.02 倍，区间靠近无效线（1）的那一端才碰到无效线（1），结论就翻");
    const tipping = part(card, "tipping") as HTMLElement;
    expect(within(tipping).getByText("使区间碰到无效线的偏倚").closest("div")).toHaveTextContent("1.02");
    expect(within(tipping).getByText("使估计值碰到无效线的偏倚").closest("div")).toHaveTextContent("1.43");
  });

  it("puts the direction last, as one caption, and draws no banner or disclaimer of its own", () => {
    const { container } = render(<VcrBiasAnalysis card={sample("bias-ratio")} />);
    const direction = container.querySelector("[data-vcr-bias-direction]") as HTMLElement;
    expect(direction).toHaveTextContent("这里的偏倚都是把效应夸大的偏倚：去掉它，估计值向无效线靠近。");
    expect(direction.nextElementSibling).toBeNull();
    expect(direction.className).toContain("text-text-3");
    expect(container.querySelector("[role='alert'], [role='status']")).toBeNull();
  });

  it("draws the shifted null as a table: the assumed bias, the adjusted estimate and interval, the one-sided P value and the verdict in words", () => {
    const { container } = render(<VcrBiasAnalysis card={sample("bias-ratio")} />);
    const block = part(container, "shifted-null") as HTMLElement;
    expect(within(block).getByRole("heading", { name: "如果偏倚真有这么大，效应还站得住吗？" })).toBeInTheDocument();
    const table = within(block).getByRole("table");
    for (const header of ["假设的偏倚", "校正后的估计", "校正后的区间", "单侧 P 值", "结论"]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    const row = table.querySelector("tr[data-vcr-bias-shifted='1.1 倍']") as HTMLElement;
    expect(row).toHaveTextContent("0.77");
    expect(row).toHaveTextContent("0.55–1.08");
    expect(row).toHaveTextContent("0.064");
    expect(row).toHaveTextContent("去掉1.1 倍的偏倚后，区间已含无效线（1），结论站不住");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(block).toHaveTextContent("检验的是“效应不超过这个偏倚”（单侧）");
  });

  it("falls back to the two words the flag stands for when a row has no sentence", () => {
    const card = sample("bias-ratio");
    const rows = card.shiftedNull!.rows.map((row, index) => ({ ...row, sentence: "", holds: index === 0 }));
    const { container } = render(<VcrBiasAnalysis card={{ ...card, shiftedNull: { ...card.shiftedNull!, rows } }} />);
    const verdicts = [...container.querySelectorAll("[data-vcr-bias-holds]")].map((node) => node.textContent);
    expect(verdicts).toEqual(["仍不含无效线", "已含无效线", "已含无效线"]);
  });

  it("draws the confounder as a table: the association, and the sentence each flip needs", () => {
    const { container } = render(<VcrBiasAnalysis card={sample("bias-ratio")} />);
    const block = part(container, "confounder") as HTMLElement;
    expect(within(block).getByRole("heading", { name: "要多不均衡、多强的混杂因素，才能把结论翻过来？" })).toBeInTheDocument();
    const table = within(block).getByRole("table");
    for (const header of ["与结局的关联", "翻转估计值", "翻转区间"]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("1.5");
    expect(rows[0]).toHaveTextContent("该混杂因素在对照组要比另一组多 90 个百分点（100%）");
    expect(rows[0]).toHaveTextContent("该混杂因素在对照组要比另一组多 4.29 个百分点（14.3%）");
    expect(block).toHaveTextContent("另一组中该因素的比例按 10% 计");
  });

  it("drops the flip-the-interval column when no row has one, and says in words where no such confounder can exist", () => {
    const { container, rerender } = render(<VcrBiasAnalysis card={sample("bias-null")} />);
    const block = part(container, "confounder") as HTMLElement;
    expect(within(block).queryByRole("columnheader", { name: "翻转区间" })).toBeNull();
    expect(within(block).getByRole("columnheader", { name: "翻转估计值" })).toBeInTheDocument();
    expect(block).toHaveTextContent("该混杂因素在试验组要比另一组多 40 个百分点（40%）");

    rerender(<VcrBiasAnalysis card={sample("bias-difference")} />);
    const infeasible = [...(part(container, "confounder") as HTMLElement).querySelectorAll("[data-vcr-bias-feasible='false']")];
    expect(infeasible.length).toBeGreaterThan(0);
    expect(infeasible[0]).toHaveTextContent("需要的比例超过 100%，这样的混杂因素不存在");
  });

  it("draws a dash for a cell the call did not compute, in a row beside one it did", () => {
    const card = sample("bias-ratio");
    const rows = card.confounder!.rows.map((row, index) => (index === 0 ? { ...row, limit: null } : row));
    const { container } = render(<VcrBiasAnalysis card={{ ...card, confounder: { ...card.confounder!, rows } }} />);
    const first = (part(container, "confounder") as HTMLElement).querySelector("tbody tr") as HTMLElement;
    expect(first).toHaveTextContent("—");
    expect(first).not.toHaveTextContent("4.29 个百分点");
  });

  it("draws the probabilistic part as facts: what was stated, the adjusted estimate with its interval, how likely the effect stays, the bias-only range and the draws", () => {
    const { container } = render(<VcrBiasAnalysis card={sample("bias-ratio")} />);
    const block = part(container, "probabilistic") as HTMLElement;
    expect(within(block).getByRole("heading", { name: "按你设定的偏倚范围，校正后的效应和区间是多少？" })).toBeInTheDocument();
    const row = (label: string) => within(block).getByText(label).closest("div") as HTMLElement;
    expect(row("设定的偏倚")).toHaveTextContent("混杂因素在试验组的比例三角分布，0.3 到 0.5，最可能 0.4");
    expect(row("校正后的估计")).toHaveTextContent("0.6154");
    expect(block.querySelector("[data-vcr-bias-adjusted-range]")).toHaveTextContent("0.4286–0.8769");
    expect(row("校正后效应仍在原方向的概率")).toHaveTextContent("99.63");
    expect(row("只含偏倚的区间")).toHaveTextContent("0.53–0.68（中位数 0.62）");
    expect(row("模拟次数")).toHaveTextContent("100,000");
    expect(block.querySelector("[data-vcr-bias-interrupted]")).toBeNull();
    // the adjusted estimate has a run behind it: it opens
    expect(within(block).getByRole("button", { name: /校正后的估计/ })).toBeInTheDocument();
  });

  it("says a truncated simulation was truncated", () => {
    const card = sample("bias-ratio");
    const { container } = render(<VcrBiasAnalysis card={{ ...card, probabilistic: { ...card.probabilistic!, interrupted: "模拟被计算预算截断，只用了跑完的几批" } }} />);
    expect(container.querySelector("[data-vcr-bias-interrupted]")).toHaveTextContent("模拟被计算预算截断");
  });

  it("draws a part that was not asked for as nothing: the tipping bias alone is a whole card", () => {
    const { container } = render(<VcrBiasAnalysis card={{ ...sample("bias-null"), confounder: null }} />);
    expect(part(container, "shifted-null")).toBeNull();
    expect(part(container, "confounder")).toBeNull();
    expect(part(container, "probabilistic")).toBeNull();
    expect(container.querySelector("[data-vcr-bias-tipping]")).toHaveTextContent("这个估计的区间本来就包含无效线（1），不需要任何偏倚结论就站不住");
    expect(container.querySelector("table")).toBeNull();
    const { container: none } = render(<VcrBiasAnalysis card={null} />);
    expect(none).toBeEmptyDOMElement();
  });

  it("reads the difference scale with its null at 0, and its bias as an amount", () => {
    const { container } = render(<VcrBiasAnalysis card={sample("bias-difference")} />);
    expect(container.querySelector("[data-vcr-bias-estimate]")).toHaveTextContent("差值 -2.4（95% 区间 -3.9–-0.9）");
    expect(container.querySelector("[data-vcr-bias-tipping]")).toHaveTextContent("无效线（0）");
    expect(container.querySelector("tr[data-vcr-bias-shifted='0.5']")).toHaveTextContent("去掉0.5的偏倚后，区间仍不含无效线（0）");
    expect(container.querySelector("[data-vcr-bias-direction]")).toHaveTextContent("向 0 靠近");
    expect(part(container, "probabilistic")).toHaveTextContent("偏倚量在 0 到 1 之间均匀分布");
  });
});

describe("修剪后的人群 · the restatement", () => {
  it("opens with the sentence, then the arms and what the removed were like beside the kept", () => {
    const { container } = render(<VcrTrimRestatement trim={trimSample()} />);
    const root = container.querySelector("[data-vcr-trim]") as HTMLElement;
    expect((root.firstElementChild as HTMLElement)).toHaveAttribute("data-vcr-trim-sentence");
    expect(root.firstElementChild).toHaveTextContent("结论只适用于留下的人，不再是全部试验人群。");

    const arms = within(root).getByRole("table", { name: "按倾向评分去掉的人数" });
    for (const header of ["组别", "人数", "留下", "去掉", "去掉的比例"]) expect(within(arms).getByRole("columnheader", { name: header })).toBeInTheDocument();
    const treated = arms.querySelector("tr[data-vcr-trim-arm='试验组']") as HTMLElement;
    expect(treated).toHaveTextContent("546");
    expect(treated).toHaveTextContent("503");
    expect(treated).toHaveTextContent("43");
    expect(treated).toHaveTextContent("7.88%");
    expect(arms.querySelector("tr[data-vcr-trim-arm='对照组']")).toHaveTextContent("13.5%");

    expect(within(root).getByRole("heading", { name: "被去掉的人与留下的人" })).toBeInTheDocument();
    const covariates = within(root).getByRole("table", { name: "被去掉的人与留下的人" });
    for (const header of ["特征", "试验组·留下", "试验组·去掉", "对照组·留下", "对照组·去掉"]) expect(within(covariates).getByRole("columnheader", { name: header })).toBeInTheDocument();
    const rows = [...covariates.querySelectorAll("tbody tr")];
    expect(rows[0]).toHaveTextContent("x10.4491.71-0.216-1.81");
    expect(rows[1]).toHaveTextContent("x258.1%62.8%54.1%33%");
    expect(root.querySelector("[data-vcr-trim-population]")).toHaveTextContent("估计针对的是留下的人");
  });

  it("draws a dash, never a zero, for a group the server did not state (one to nine people)", () => {
    const trim = trimSample();
    const hidden = { ...trim, removed: null, kept: null, arms: [{ arm: "试验组", n: 546, kept: null, removed: null, share: "—" }, trim.arms[1]] };
    const { container } = render(<VcrTrimRestatement trim={hidden} />);
    const treated = container.querySelector("tr[data-vcr-trim-arm='试验组']") as HTMLElement;
    expect(treated).toHaveTextContent("546");
    expect(treated).toHaveTextContent("——");
    expect(container.querySelector("[data-vcr-trim-population]")).toHaveTextContent("估计针对的是留下的人");
  });

  it("draws no covariate table and no caption where nobody was removed, and nothing at all for no trimming", () => {
    const trim = trimSample();
    const { container } = render(<VcrTrimRestatement trim={{ ...trim, trimmed: false, removed: 0, covariates: [], sentence: "修剪规则（倾向评分低于 0.1 或高于 0.9）没有去掉任何人，结论仍适用于全部人群。" }} />);
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelector("[data-vcr-trim-population]")).toBeNull();
    expect(container.querySelector("[data-vcr-trim-sentence]")).toHaveTextContent("结论仍适用于全部人群");
    const { container: none } = render(<VcrTrimRestatement trim={null} />);
    expect(none).toBeEmptyDOMElement();
  });
});

describe("读取 · the comparator payload", () => {
  it("keeps the cards the server sent, number for number", () => {
    const read = readVcrComparator({ biasAnalysis: payloads["bias-ratio"], trim: payloads.trim });
    expect(read.biasAnalysis?.tipping.limit?.value).toBe(1.02040816);
    expect(read.biasAnalysis?.shiftedNull?.rows).toHaveLength(3);
    expect(read.biasAnalysis?.confounder?.rows[0].estimate?.feasible).toBe(true);
    expect(read.biasAnalysis?.probabilistic?.draws).toBe(100000);
    expect(read.biasAnalysis?.probabilistic?.adjusted.interval?.kind).toBe("monte_carlo");
    expect(read.trim?.rule).toBe("fixed");
    expect(read.trim?.arms.map((arm) => arm.removed)).toEqual([43, 88]);
    expect(read.trim?.covariates[1].control.removed).toBe("33%");
    expect(readVcrComparator({ biasAnalysis: payloads["bias-null"] }).biasAnalysis).toMatchObject({ shiftedNull: null, probabilistic: null });
  });

  it("reads anything of an unknown shape as nothing, and a malformed part as a part that is not there", () => {
    for (const garbage of [undefined, null, 7, "x", [], {}, { question: "q" }, { question: "q", tipping: { sentence: 3 } }]) {
      const read = readVcrComparator({ biasAnalysis: garbage, trim: garbage });
      expect(read.biasAnalysis).toBeNull();
      expect(read.trim).toBeNull();
    }
    const broken = { ...payloads["bias-ratio"], shiftedNull: { rows: "none" }, confounder: { rows: [{ association: 3, estimate: { feasible: true } }] }, probabilistic: { adjusted: 1 } };
    expect(readVcrComparator({ biasAnalysis: broken }).biasAnalysis).toMatchObject({ shiftedNull: null, confounder: null, probabilistic: null });
    // a value that is not a value reads as a dash, never as a zero
    const noNumbers = { ...payloads["bias-ratio"], tipping: { ...payloads["bias-ratio"].tipping, limit: "high", estimate: null } };
    expect(readVcrComparator({ biasAnalysis: noNumbers }).biasAnalysis?.tipping).toMatchObject({ limit: null, estimate: null });
    const trim = readVcrComparator({ trim: { sentence: "s", arms: [{ arm: "试验组" }, { arm: "对照组", n: 4, kept: 3, removed: 1 }], covariates: [{ treated: {} }] } }).trim;
    // a count the server did not state is not a zero: the arm is still there, with dashes in its cells
    expect(trim?.arms).toEqual([{ arm: "试验组", n: null, kept: null, removed: null, share: "—" }, { arm: "对照组", n: 4, kept: 3, removed: 1, share: "—" }]);
    expect(trim?.covariates).toEqual([]);
  });
});
