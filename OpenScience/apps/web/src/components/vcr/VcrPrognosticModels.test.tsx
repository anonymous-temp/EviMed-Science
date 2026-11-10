import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readVcrComparator, type VcrPrognosticModelCard } from "@/lib/vcrClient";
import { VcrPrognosticModels } from "./VcrPrognosticModels";
import payloads from "./__fixtures__/trainedAndProgressionPayloads.json";

/**
 * 用自己的历史数据训练的预后模型: drawn from what the server's presenter makes of real engine results (`__fixtures__/trainedAndProgressionPayloads.json`).
 * The web places the numbers it is sent; it computes none of them.
 */

afterEach(cleanup);

const sample = (key: "cox" | "linear" | "refused"): VcrPrognosticModelCard => {
  const card = readVcrComparator({ prognosticModels: [payloads.prognostic[key]] }).prognosticModels?.[0];
  if (!card) throw new Error(`the ${key} sample did not read`);
  return card;
};

describe("预后模型 · the card", () => {
  it("says what the model is before it shows a number, and the figures are out of fold", () => {
    const { container } = render(<VcrPrognosticModels cards={[sample("cox")]} />);
    const card = container.querySelector("[data-vcr-prognostic='trained']") as HTMLElement;
    expect(card.querySelector("[data-vcr-prognostic-label]")).toHaveTextContent("用你自己的数据训练，没有在别的人群验证过");
    expect(within(card).getByText(/每个人的预测来自没见过他的模型/)).toBeInTheDocument();
    const measures = Array.from(card.querySelectorAll("[data-vcr-card-measure]")).map((node) => node.getAttribute("data-vcr-card-measure"));
    expect(measures).toEqual(["out_of_fold_c_index", "calibration_slope", "calibration_in_the_large", "prognostic_correlation"]);
    expect(card.querySelector("[data-vcr-prognostic-correlation]")).toHaveTextContent("近似");
  });

  it("shows the sample-size saving under every discount as a compact table, at the estimate and at the lower end of the correlation", () => {
    const { container } = render(<VcrPrognosticModels cards={[sample("cox")]} />);
    const rows = Array.from(container.querySelectorAll("[data-vcr-prognostic-discount]")).map((row) => row.getAttribute("data-vcr-prognostic-discount"));
    expect(rows).toHaveLength(12);
    expect(rows).toContain("0.5:1.25");
    const table = container.querySelector("table") as HTMLTableElement;
    expect(within(table).getByRole("columnheader", { name: "按相关的置信下限，可节省" })).toBeInTheDocument();
    expect(container.querySelector("[data-vcr-prognostic-discount='1:1']")).toHaveTextContent("%");
  });

  it("the forest is a comparison and says it is not the model; the equation's terms are one row each", () => {
    const { container } = render(<VcrPrognosticModels cards={[sample("cox")]} />);
    expect(container.querySelector("[data-vcr-prognostic-forest]")).toHaveTextContent("保存和应用的是回归方程");
    expect(container.querySelectorAll("table")).toHaveLength(2);
    expect(container).toHaveTextContent("每增加 1 个单位，风险比");
  });

  it("a model that was not trained says why in a sentence and shows no number", () => {
    const { container } = render(<VcrPrognosticModels cards={[sample("refused")]} />);
    const card = container.querySelector("[data-vcr-prognostic='refused']") as HTMLElement;
    expect(card.querySelector("[data-vcr-prognostic-refusal]")).toHaveTextContent("太少");
    expect(card.querySelector("table")).toBeNull();
    expect(card.querySelector("[data-vcr-card-measure]")).toBeNull();
  });

  it("a payload of another shape reads as nothing", () => {
    expect(readVcrComparator({ prognosticModels: [{ id: "x" }, null, "a", { id: "y", title: "t", form: "other" }] }).prognosticModels).toEqual([]);
    const { container } = render(<VcrPrognosticModels cards={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
