import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readVcrPatients, type VcrProgressionCard } from "@/lib/vcrClient";
import { VcrProgressions } from "./VcrProgressions";
import payloads from "./__fixtures__/trainedAndProgressionPayloads.json";

/**
 * 疾病进展模拟: drawn from what the server's presenter makes of real engine results (`__fixtures__/trainedAndProgressionPayloads.json`).
 * The web places the numbers it is sent; it computes none of them.
 */

afterEach(cleanup);

const sample = (key: "linear" | "emax" | "null"): VcrProgressionCard => {
  const card = readVcrPatients({ progressions: [payloads.progression[key]] }).progressions?.[0];
  if (!card) throw new Error(`the ${key} sample did not read`);
  return card;
};

describe("疾病进展模拟 · the card", () => {
  it("says it is population level before anything else, with the reason", () => {
    const { container } = render(<VcrProgressions cards={[sample("linear")]} />);
    const card = container.querySelector("[data-vcr-progression]") as HTMLElement;
    expect(card.querySelector("[data-vcr-progression-label]")).toHaveTextContent("人群层面，不是对个人的预测");
    expect(card.querySelector("[data-vcr-progression-label]")).toHaveTextContent("0.16");
    expect(within(card).getByText(/减慢 25%/)).toBeInTheDocument();
  });

  it("gives the simulated power with the closed form beside it, and the mean course by visit as a table", () => {
    const { container } = render(<VcrProgressions cards={[sample("linear")]} />);
    const power = container.querySelector("[data-vcr-progression-power]") as HTMLElement;
    expect(power).toHaveTextContent("判出有效的把握（模拟）");
    expect(power).toHaveTextContent("同一个检验用公式算出的是");
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(4);
    expect(container.querySelector("[data-vcr-series]")).not.toBeNull();
    expect(container).toHaveTextContent("线是各组的平均");
  });

  it("with no slowing the same number is the type I error", () => {
    const { container } = render(<VcrProgressions cards={[sample("null")]} />);
    expect(container.querySelector("[data-vcr-progression-power]")).toHaveTextContent("没有真实效应时误判有效的概率");
  });

  it("an Emax progression tested by the slope is named in words", () => {
    const { container } = render(<VcrProgressions cards={[sample("emax")]} />);
    expect(container).toHaveTextContent("Emax（逐渐饱和）进展");
    expect(container.querySelector("[data-vcr-progression-question]")).toHaveTextContent("斜率");
  });

  it("a payload of another shape reads as nothing", () => {
    expect(readVcrPatients({ progressions: [{ id: "x" }, null, { id: "y", title: "t", table: { rows: [] } }] }).progressions).toEqual([]);
    const { container } = render(<VcrProgressions cards={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
