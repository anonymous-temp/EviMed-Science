import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readStcComparison, readVcrComparator } from "@/lib/vcrClient";
import { VcrStcComparison } from "./VcrStcComparison";
import payloads from "./__fixtures__/stcPayloads.json";

/**
 * 简化的间接比较 (the simulated treatment comparison): drawn from what the server's presenter makes of the engine's real results
 * (`__fixtures__/stcPayloads.json`). The web places the numbers and words it is sent; it computes and rewrites none of them.
 */

afterEach(cleanup);

const sample = (key: "stc-anchored" | "stc-unanchored") => {
  const card = readStcComparison(payloads[key]);
  if (!card) throw new Error(`the ${key} sample did not read`);
  return card;
};

describe("间接比较的卡片 · the card", () => {
  it("opens with the question and the sentence, then the estimate with its interval and its ratio form", () => {
    const { container } = render(<VcrStcComparison card={sample("stc-anchored")} />);
    const root = container.querySelector("[data-vcr-stc]") as HTMLElement;
    expect(within(root).getByRole("heading", { name: "放到对方试验的人群上，我们的治疗和对方的治疗相比，差多少？" })).toBeInTheDocument();
    expect(root.querySelector("[data-vcr-stc-sentence]")).toHaveTextContent("这个估计针对的是对方试验的人群");
    expect(root.querySelector("[data-vcr-stc-estimate]")).toHaveTextContent("0.01");
    expect(root.querySelector("[data-vcr-stc-estimate]")).toHaveTextContent("95% 置信区间 -0.428–0.449");
    expect(root.querySelector("[data-vcr-stc-ratio]")).toHaveTextContent("1.01");
    expect(root).toHaveTextContent("比值比（OR）");
    expect(root.querySelector("[data-vcr-stc-scale]")).toHaveTextContent("估计所在的尺度：对数比值比（log OR）");
  });

  it("sets the conditional effect apart with its own note, beside the marginal one and the other trial's figure", () => {
    const { container } = render(<VcrStcComparison card={sample("stc-anchored")} />);
    expect(container.querySelector("[data-vcr-stc-row='marginal']")).toHaveTextContent("-0.24");
    expect(container.querySelector("[data-vcr-stc-row='aggregate']")).toHaveTextContent("-0.25");
    const conditional = container.querySelector("[data-vcr-stc-row='conditional']") as HTMLElement;
    expect(conditional).toHaveTextContent("-0.5");
    expect(conditional).toHaveTextContent("不能直接和对方的汇总数相减");
    expect(container.querySelector("[data-vcr-stc-outside]")).toHaveTextContent("超出了我们数据的范围");
  });

  it("an unanchored comparison says it is not an effect and shows the levels as percentages", () => {
    const { container } = render(<VcrStcComparison card={sample("stc-unanchored")} />);
    expect(container.querySelector("[data-vcr-stc-sentence]")).toHaveTextContent("不是治疗效应");
    expect(container.querySelector("[data-vcr-stc-row='expected']")).toHaveTextContent("51");
    expect(container.querySelector("[data-vcr-stc-row='expected']")).toHaveTextContent("%");
    expect(container.querySelector("[data-vcr-stc-row='conditional']")).toBeNull();
  });

  it("reads inside the comparator payload, and anything of an unknown shape is nothing", () => {
    expect(readVcrComparator({ stcComparison: payloads["stc-anchored"] }).stcComparison?.anchored).toBe(true);
    for (const garbage of [undefined, null, 7, "x", [], {}, { question: "q" }, { question: "q", sentence: "s" }, { question: "q", sentence: "s", estimate: { value: null } }]) {
      expect(readStcComparison(garbage)).toBeNull();
    }
    const { container } = render(<VcrStcComparison card={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
