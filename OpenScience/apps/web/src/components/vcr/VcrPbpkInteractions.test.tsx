import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readPbpkInteractionCards, type VcrPbpkInteractionCard } from "@/lib/vcrClient";
import { VcrPbpkInteractions } from "./VcrPbpkInteractions";
import payloads from "./__fixtures__/pbpkPayloads.json";

/**
 * 合用药物后的暴露变化: the card drawn from what the server's presenter makes of the engine's real results (`__fixtures__/pbpkPayloads.json`).
 * The ratio first and in words, the curves alone and after, and the premises that say whose values these are.
 */

afterEach(cleanup);

const sample = (key: "oral" | "iv"): VcrPbpkInteractionCard => {
  const [card] = readPbpkInteractionCards([payloads[key]]);
  if (!card) throw new Error(`the ${key} sample did not read`);
  return card;
};
const draw = (card: VcrPbpkInteractionCard) => {
  const view = render(<VcrPbpkInteractions cards={[card]} />);
  return { ...view, root: view.container.querySelector("[data-vcr-pbpk]") as HTMLElement };
};

describe("合用药物后的暴露变化 · the card", () => {
  it("opens with the question and a sentence that says what the ratio is and that it is a typical healthy adult's", () => {
    const { root } = draw(sample("oral"));
    expect(within(root).getByRole("heading", { name: "利福平合用后，咪达唑仑的暴露会怎样变化" })).toBeInTheDocument();
    expect(root.querySelector("[data-vcr-pbpk-lead]")).toHaveTextContent(/合用后，咪达唑仑的曲线下面积降到单用时的 24\.\d%.*典型健康成人/);
    expect(within(root).getByText(/曲线下面积之比（合用 ÷ 单用）/)).toBeInTheDocument();
  });

  it("draws the two curves and tabulates every sampled concentration with its unit", () => {
    const card = sample("oral");
    const { root } = draw(card);
    expect(card.series).toHaveLength(2);
    expect(within(root).getByText("血药浓度随时间的变化")).toBeInTheDocument();
    expect(within(root).getByText("单用咪达唑仑")).toBeInTheDocument();
    expect(within(root).getByText("利福平合用后")).toBeInTheDocument();
    expect(within(root).getByRole("table", { name: /各时间点的浓度/ })).toBeInTheDocument();
    expect(card.table.length).toBeGreaterThanOrEqual(10);
  });

  it("states the model, the person, the regimen and the doses outside the authors' range as premises, with no back-office word", () => {
    const { root } = draw(sample("iv"));
    const text = root.textContent ?? "";
    expect(text).toMatch(/已发表的全身生理药代动力学模型/);
    expect(text).toMatch(/70 kg 的典型健康成人/);
    expect(text).toMatch(/静脉滴注 0\.5 小时/);
    expect(text).toMatch(/利福平的剂量超出了论文拟合过的范围/);
    expect(text).not.toMatch(/mrgsolve|\.cpp|pk_interaction|pk\.interaction|deSolve|Metrum/);
  });

  it("leaves out a card that is not of the known form", () => {
    expect(readPbpkInteractionCards([{ ...payloads.oral, form: "other" }, { ...payloads.oral, id: "" }, null, 3])).toEqual([]);
  });
});
