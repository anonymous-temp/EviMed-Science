import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { readVcrPopulation, type VcrPopulationCheck } from "@/lib/vcrClient";
import { PopulationCheckCard } from "./PopulationCheckCard";

afterEach(cleanup);

const check = (over: Partial<VcrPopulationCheck> = {}): VcrPopulationCheck => ({
  title: "与第二份基线表独立对照", independent: true,
  sentence: "3 个变量逐个对照了各自的分布，1 个差距超过 0.1。对照表和生成这份人群用的不是同一批证据。",
  covered: "这里没有对照的部分不算验证：变量之间的相关性；分布的形状和尾部。",
  rows: [
    { key: "age", label: "年龄", ours: "62.1（SD 9.4）", theirs: "61.5（SD 10）", smd: 0.06, totalVariation: null, state: "close", stateLabel: "接近", note: null },
    { key: "male", label: "男性", ours: "55%", theirs: "40%", smd: 0.3, totalVariation: null, state: "apart", stateLabel: "有差距", note: "差距超过了两个标准误" },
    { key: "ecog", label: "ECOG", ours: "0 40% / 1 50%", theirs: "0 38% / 1 52%", smd: null, totalVariation: 0.02, state: "close", stateLabel: "接近", note: null },
    { key: "stage", label: "分期", ours: null, theirs: null, smd: null, totalVariation: null, state: "not_comparable", stateLabel: "没法对照", note: "生成的人群里没有这个变量" },
  ],
  floor: 0.1, ofEarlierVersion: false, resultId: "res_check", ...over,
});

describe("the population check card", () => {
  it("lays the generated population beside the second table, marks a row as a mark and not a verdict, and says what it did not cover", () => {
    const { container } = render(<PopulationCheckCard check={check()} />);
    const card = container.querySelector("[data-vcr-population-check]") as HTMLElement;
    expect(card).toHaveAttribute("data-vcr-independent", "true");
    expect(within(card).getByRole("heading", { name: "与第二份基线表独立对照" })).toBeInTheDocument();
    const male = card.querySelector("[data-vcr-check-row='male']") as HTMLElement;
    expect(male).toHaveAttribute("data-vcr-check-state", "apart");
    expect(male).toHaveTextContent("55%");
    expect(male).toHaveTextContent("40%");
    expect(male).toHaveTextContent("0.3");
    expect(within(male).getByRole("img", { name: "和第二份基线表有差距" })).toBeInTheDocument();
    expect(within(card.querySelector("[data-vcr-check-row='age']") as HTMLElement).getByRole("img", { name: "和第二份基线表接近" })).toBeInTheDocument();
    expect(card.querySelector("[data-vcr-check-row='ecog']")).toHaveTextContent("0.02（总变异距离）");
    const stage = card.querySelector("[data-vcr-check-row='stage']") as HTMLElement;
    expect(stage).toHaveTextContent("生成的人群里没有这个变量");
    expect(stage.querySelector("[role='img']")).toBeNull();
    expect(card).toHaveTextContent("这里没有对照的部分不算验证：变量之间的相关性；分布的形状和尾部。");
  });

  it("names a check on the same evidence as a comparison with the inputs and an earlier population version as such", () => {
    const { container } = render(<PopulationCheckCard check={check({ independent: false, title: "与第二份基线表对照", ofEarlierVersion: true,
      sentence: "3 个变量逐个对照了各自的分布，都在 0.1 以内。对照表和生成这份人群用了同一批证据，所以这只是与输入对照，不是独立对照。", covered: "没有对照：变量之间的相关性。" })} />);
    const card = container.querySelector("[data-vcr-population-check]") as HTMLElement;
    expect(card).toHaveAttribute("data-vcr-independent", "false");
    expect(card).toHaveTextContent("这只是与输入对照，不是独立对照。");
    expect(card).toHaveTextContent("对照的是人群的上一版");
    expect(card.textContent).not.toContain("验证");
  });

  it("is read from the population tab as the server sent it, and is absent when none was sent", () => {
    const sent = readVcrPopulation({ check: { ...check(), rows: [...check().rows, { label: "no key" }] }, versions: [], criteria: [], attrition: [], profile: [] });
    expect(sent.check?.rows.map((row) => row.key)).toEqual(["age", "male", "ecog", "stage"]);
    expect(sent.check?.independent).toBe(true);
    expect(readVcrPopulation({ versions: [], criteria: [], attrition: [], profile: [] }).check).toBeNull();
    expect(readVcrPopulation({ check: { title: "x", rows: [] }, versions: [], criteria: [], attrition: [], profile: [] }).check).toBeNull();
  });
});
