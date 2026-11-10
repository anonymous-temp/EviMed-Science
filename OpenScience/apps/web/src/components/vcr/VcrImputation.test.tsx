import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readVcrComparator, type VcrImputationCard } from "@/lib/vcrClient";
import { VcrImputation } from "./VcrImputation";
import payloads from "./__fixtures__/imputationPayloads.json";

/**
 * 补齐缺失值: the card of a comparison, drawn from what the server's presenter makes of real engine results
 * (`__fixtures__/imputationPayloads.json`). The web places the numbers and words it is sent; it computes and rewrites none of them.
 */

afterEach(cleanup);

type Key = keyof typeof payloads;

const sample = (key: Key): VcrImputationCard => {
  const card = readVcrComparator({ imputation: payloads[key] }).imputation;
  if (!card) throw new Error(`the ${key} sample did not read`);
  return card;
};

describe("补齐缺失值 · the card", () => {
  it("opens with the question as a heading and the server's sentence, and states the premise as an ordinary sentence", () => {
    const card = sample("propensity-binary");
    const { container } = render(<VcrImputation card={card} />);
    const root = container.querySelector("[data-vcr-imputation]") as HTMLElement;
    expect(within(root).getByRole("heading", { name: "有缺失值的协变量，补齐之后结论还是这样吗？" })).toBeInTheDocument();
    expect(root.querySelector("[data-vcr-imputation-sentence]")).toHaveTextContent(card.sentence);
    const assumption = root.querySelector("[data-vcr-imputation-assumption]") as HTMLElement;
    expect(assumption).toHaveTextContent("前提是缺失与否只取决于已经看到的协变量、治疗分组和结局（随机缺失）");
    expect(assumption.className).toContain("text-text");
    expect(root.querySelector("[role='alert'], [role='status']")).toBeNull();
  });

  it("draws one table row per estimate with the filled-in and the complete-case numbers", () => {
    const card = sample("propensity-binary");
    const { container } = render(<VcrImputation card={card} />);
    const table = within(container).getByRole("table", { name: "补齐缺失值前后的结果" });
    for (const header of ["估计", "补齐后（合并）", "只用完整病例", "两者"]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(card.rows.length);
    expect(rows).toHaveLength(3);
    const effect = table.querySelector("tr[data-vcr-imputation-row='weighted_difference']") as HTMLElement;
    expect(effect).toHaveTextContent("加权后的效应差");
    expect(effect).toHaveTextContent("-0.028");
    expect(effect).toHaveTextContent("-0.034");
    expect(effect).toHaveTextContent("结论一致");
    // the complete-case number of the row is in the document
    expect(container).toHaveTextContent("-0.034");
    expect(table.querySelector("tr[data-vcr-imputation-row='weighted_risk_ratio']")).toHaveTextContent("0.913");
    expect(table.querySelector("tr[data-vcr-imputation-row='weighted_odds_ratio']")).toHaveTextContent("0.87");
  });

  it("says in words when the two answers disagree, and when they agree", () => {
    const { container } = render(<VcrImputation card={sample("cox-time-to-event")} />);
    const different = container.querySelector("tr[data-vcr-imputation-row='survival_difference_at_tau']") as HTMLElement;
    expect(different).toHaveTextContent("结论不一致");
    expect(different).not.toHaveTextContent("结论一致");
    expect(container.querySelector("tr[data-vcr-imputation-row='hazard_ratio']")).toHaveTextContent("结论一致");
    expect(container.querySelectorAll("[data-tag]").length).toBeGreaterThan(0);
  });

  it("draws a dash for a complete-case number that is not there and no word for an agreement that was not said", () => {
    const card = sample("propensity-binary");
    const rows = card.rows.map((row, index) => (index === 0 ? { ...row, completeCase: null, agreement: null } : row));
    const { container } = render(<VcrImputation card={{ ...card, rows }} />);
    const first = container.querySelector("tr[data-vcr-imputation-row='weighted_difference']") as HTMLElement;
    expect(first).toHaveTextContent("—");
    expect(first).not.toHaveTextContent("结论");
    expect(first).not.toHaveTextContent("-0.034");
  });

  it("lists who was dropped from the complete cases and the features that had gaps", () => {
    const card = sample("propensity-binary");
    const { container } = render(<VcrImputation card={card} />);
    expect(container.querySelector("[data-vcr-imputation-complete-case]")).toHaveTextContent("只用完整病例：剩 180 人，去掉 120 人。");
    const table = within(container).getByRole("table", { name: "有缺失的特征" });
    for (const header of ["特征", "缺失", "占比", "补齐方法"]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    const x1 = table.querySelector("tr[data-vcr-imputation-covariate='x1']") as HTMLElement;
    expect(x1).toHaveTextContent("73");
    expect(x1).toHaveTextContent("24.3%");
    expect(x1).toHaveTextContent("预测均值匹配");
    expect(table.querySelector("tr[data-vcr-imputation-covariate='x2']")).toHaveTextContent("按逻辑回归抽样");
  });

  it("puts the few-copies and stopped sentences in plain text and the budget and note last, as captions", () => {
    const card = sample("propensity-stopped");
    const { container } = render(<VcrImputation card={card} />);
    const few = container.querySelector("[data-vcr-imputation-few]") as HTMLElement;
    const stopped = container.querySelector("[data-vcr-imputation-stopped]") as HTMLElement;
    expect(few).toHaveTextContent("份数偏少");
    expect(stopped).toHaveTextContent("计算时间用完了：只用了 7 份（计划 14 份）合并，区间比计划的粗。");
    for (const node of [few, stopped]) {
      expect(node.className).toContain("text-text-2");
      expect(node.getAttribute("role")).toBeNull();
    }
    const budget = container.querySelector("[data-vcr-imputation-budget]") as HTMLElement;
    const note = container.querySelector("[data-vcr-imputation-note]") as HTMLElement;
    expect(budget).toHaveTextContent("区间按 Rubin 规则");
    expect(note).toHaveTextContent("平衡表、权重和生存曲线取自第一份补齐的数据。");
    for (const node of [budget, note]) {
      expect(node.className).toContain("text-caption");
      expect(node.className).toContain("text-text-3");
    }
    expect(note.nextElementSibling).toBeNull();
    // a payload without a stopped sentence draws none
    const { container: clean } = render(<VcrImputation card={sample("propensity-binary")} />);
    expect(clean.querySelector("[data-vcr-imputation-stopped]")).toBeNull();
  });

  it("draws only the sentence where nothing was missing", () => {
    const card = sample("none-missing");
    const { container } = render(<VcrImputation card={card} />);
    expect(container.querySelector("[data-vcr-imputation-sentence]")).toHaveTextContent("被分析的人里没有协变量缺失，所以没有做插补，分析照常进行。");
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("[data-vcr-imputation-assumption]")).toBeNull();
    expect(container.querySelector("[data-vcr-imputation-complete-case]")).toBeNull();
  });

  it("draws nothing for no card", () => {
    expect(render(<VcrImputation card={null} />).container).toBeEmptyDOMElement();
    expect(render(<VcrImputation card={undefined} />).container).toBeEmptyDOMElement();
  });

  it("shows no raw key: every label on the page is the server's wording", () => {
    for (const key of Object.keys(payloads) as Key[]) {
      const { container, unmount } = render(<VcrImputation card={sample(key)} />);
      const words = [...container.querySelectorAll("*")].flatMap((node) => [...node.childNodes])
        .filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "");
      for (const word of words) expect(word).not.toMatch(/[A-Za-z]+_[A-Za-z_]+/);
      unmount();
    }
  });
});

describe("读取 · the comparator payload", () => {
  it("keeps the card the server sent, number for number", () => {
    const read = readVcrComparator({ imputation: payloads["cox-time-to-event"] }).imputation;
    expect(read?.rows.map((row) => row.key)).toEqual(["hazard_ratio", "rmst_difference", "rmst_treatment", "rmst_control", "survival_difference_at_tau"]);
    expect(read?.rows[0].imputed.value).toBe(0.83325561);
    expect(read?.rows[0].imputed.source).toBe("imputed");
    expect(read?.rows[0].completeCase?.value).toBe(0.69382152);
    expect(read?.rows[4].agreement).toBe("different");
    expect(read?.completeCase).toEqual({ rows: 180, dropped: 120, sentence: "只用完整病例：剩 180 人，去掉 120 人。" });
    expect(read?.stopped).toBeNull();
    expect(readVcrComparator({ imputation: payloads["none-missing"] }).imputation).toMatchObject({ rows: [], completeCase: null, assumption: null });
  });

  it("reads anything of an unknown shape as nothing, drops a row without a readable value and reads an unknown agreement as none", () => {
    for (const garbage of [undefined, null, 7, "x", [], {}, { question: "q" }, { sentence: "s" }]) {
      expect(readVcrComparator({ imputation: garbage }).imputation).toBeNull();
    }
    const base = payloads["propensity-binary"];
    const rows = [
      { ...base.rows[0], imputed: "high" },
      { ...base.rows[1], imputed: { source: "imputed" } },
      { ...base.rows[2], agreement: "maybe" },
    ];
    const read = readVcrComparator({ imputation: { ...base, rows } }).imputation;
    expect(read?.rows.map((row) => row.key)).toEqual(["weighted_odds_ratio"]);
    expect(read?.rows[0].agreement).toBeNull();
    expect(readVcrComparator({ imputation: { ...base, completeCase: { rows: 1 } } }).imputation?.completeCase).toBeNull();
  });
});
