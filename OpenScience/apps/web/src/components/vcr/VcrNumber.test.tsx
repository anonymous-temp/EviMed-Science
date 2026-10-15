import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { VcrCountsBand, VcrCountsLine } from "./VcrCounts";
import { markKindOf, SourceTag } from "./VcrMarks";
import { VcrNumber, VcrStat, VcrValueText } from "./VcrNumber";
import { counts, value } from "./__fixtures__/vcrValues";

describe("a number on a page", () => {
  it("prints its unit and its Monte-Carlo standard error beside it", () => {
    render(<VcrValueText value={value({ value: 71, unit: "%", source: "predicted", mcse: 0.4 })} />);
    expect(screen.getByText("71.0")).toBeInTheDocument();
    expect(screen.getByText("%")).toBeInTheDocument();
    expect(screen.getByText("±0.40")).toBeInTheDocument();
  });

  it("is plain text when there is nothing behind it to open", () => {
    render(<VcrNumber value={value({ value: 180, source: "assumed" })} label="样本量" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  // Every number can be drilled into: a simulated one opens its run's
  // configuration, its seed and its Monte-Carlo error (plan §9.5).
  it("opens the run that produced it: the seed, the replicates and the error", async () => {
    render(
      <VcrNumber
        label="方案 B 成功把握"
        value={value({
          value: 71, unit: "%", source: "predicted", mcse: 0.4,
          detail: {
            kind: "run",
            title: "运行 #12 · 方案 B",
            fields: [{ label: "种子", value: "20260928" }, { label: "备择情景重复", value: "16,000 次" }],
          },
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /方案 B 成功把握/ }));
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("运行 #12 · 方案 B")).toBeInTheDocument();
    expect(within(drawer).getByText("20260928")).toBeInTheDocument();
    expect(within(drawer).getByText("16,000 次")).toBeInTheDocument();
    expect(within(drawer).getByText(/蒙特卡洛标准误/)).toBeInTheDocument();
  });

  // An aggregate opens the sentence it was read out of, not a run.
  it("opens the sentence an aggregate was read out of", async () => {
    render(
      <VcrNumber
        label="对照组中位 PFS"
        value={value({
          value: 4.1, unit: "个月", source: "aggregate", review: "ai_set",
          interval: { kind: "prediction", low: 3.0, high: 5.6 },
          detail: { kind: "assumption", quote: "多西他赛组中位 PFS 为 4.0 个月", quoteSource: "某试验 2024，第 6 页，表 2" },
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /对照组中位 PFS/ }));
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("“多西他赛组中位 PFS 为 4.0 个月”")).toBeInTheDocument();
    expect(within(drawer).getByText("— 某试验 2024，第 6 页，表 2")).toBeInTheDocument();
    // The interval keeps its name and the value keeps its source; who set the value is not on it (owner ruling 2026-10-10).
    expect(within(drawer).getByText("预测区间 3.0–5.6")).toBeInTheDocument();
    expect(within(drawer).getByText("汇总")).toBeInTheDocument();
    expect(within(drawer).queryByText("AI 设定")).not.toBeInTheDocument();
  });
});

describe("a tile", () => {
  it("shows an AI-set value with its source and no label about who set it, rather than withholding it", () => {
    render(<VcrStat label="目标 HR" value={value({ value: 0.6, source: "assumed", review: "ai_set" })} />);
    // A hazard ratio prints two decimals, as the design renders write it.
    expect(screen.getByText("0.6")).toBeInTheDocument();
    expect(screen.queryByText("AI 设定")).not.toBeInTheDocument();
    expect(screen.getByText("假设")).toBeInTheDocument();
  });

  it("gives a word standing in for a number the placeholder size, not the metric size", () => {
    render(<VcrStat label="真实外部对照" value={value({ value: null, text: "不可估计", source: "observed" })} />);
    const printed = screen.getByText("不可估计");
    expect(printed.closest("[data-stat-value]")).toHaveClass("text-heading");
    expect(printed.closest("[data-stat-value]")).not.toHaveClass("text-metric");
  });
});

describe("the counts", () => {
  // They are separate numbers and not one: generating records narrows no interval.
  it("draws only the counts the study has, each under the name of what it counts — never a placeholder for the rest", () => {
    render(<MemoryRouter><VcrCountsBand counts={counts({ realPatients: 0, events: null, effectiveSampleSize: null, generatedRecords: 6_480_000 })} /></MemoryRouter>);
    for (const label of ["真实患者数", "生成记录数"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // A zero that is the truth is drawn; a count nobody has is not there at all.
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByText("事件数")).not.toBeInTheDocument();
    expect(screen.queryByText("有效样本量")).not.toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    expect(screen.getByText("约 648 万")).toBeInTheDocument();
  });

  it("is one tile at T0, where one count exists, and nothing where none does", () => {
    const { container, rerender } = render(<MemoryRouter><VcrCountsBand counts={counts({ realPatients: null, generatedRecords: 1_000 })} /></MemoryRouter>);
    expect(container.querySelectorAll("[data-vcr-count]")).toHaveLength(1);
    expect(screen.getByText("1,000")).toBeInTheDocument();
    rerender(<MemoryRouter><VcrCountsBand counts={counts({ realPatients: null, generatedRecords: null })} /></MemoryRouter>);
    expect(container.querySelector("[data-vcr-counts]")).toBeNull();
  });

  it("adds the two optional counts only when their route was used", () => {
    const { rerender } = render(<MemoryRouter><VcrCountsBand counts={counts({ realPatients: null, generatedRecords: 1_000 })} /></MemoryRouter>);
    expect(screen.queryByText("重建伪个体数")).not.toBeInTheDocument();
    rerender(<MemoryRouter><VcrCountsBand counts={counts({ realPatients: null, generatedRecords: 1_000, reconstructedPseudoPatients: 801 })} /></MemoryRouter>);
    expect(screen.getByText("重建伪个体数")).toBeInTheDocument();
    expect(screen.getByText("801")).toBeInTheDocument();
  });

  it("makes each number a link to the tab that holds what it counts, and writes no sentence under it", () => {
    const { container } = render(
      <MemoryRouter>
        <VcrCountsBand counts={counts({ realPatients: 240, generatedRecords: 212_382_000, notes: { generatedRecords: "模拟生成的记录，不是患者" }, note: "设计阶段：尚无真实患者" })} tabOf={(key) => `/tab/${key}`} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /真实患者数 240/ })).toHaveAttribute("href", "/tab/realPatients");
    expect(screen.getByRole("link", { name: /生成记录数/ })).toHaveAttribute("href", "/tab/generatedRecords");
    // The count's own name is its honesty: a note under it, and a line over the band, are not written.
    expect(container.textContent).not.toMatch(/不是患者|设计阶段/);
  });

  it("says the same counts on one line where a card has no room for the band", () => {
    render(<VcrCountsLine counts={counts({ events: 138 })} />);
    expect(screen.getByText("事件数")).toBeInTheDocument();
    expect(screen.getByText("138")).toBeInTheDocument();
  });
});

describe("the provenance encoding", () => {
  // One mark per family, and the rule that a reconstructed value can never
  // wear an observation's mark.
  it("gives an observation a solid mark and a reconstruction a dashed one", () => {
    expect(markKindOf("observed")).toBe("solid");
    expect(markKindOf("extracted")).toBe("solid");
    expect(markKindOf("aggregate")).toBe("dashed");
    expect(markKindOf("reconstructed")).toBe("dashed");
    expect(markKindOf("predicted")).toBe("band");
    expect(markKindOf("synthetic")).toBe("band");
    expect(markKindOf("assumed")).toBe("assumed");
  });

  it("prints the domain's own word beside the mark", () => {
    const { container } = render(<SourceTag source="reconstructed" />);
    expect(screen.getByText("重建")).toBeInTheDocument();
    expect(container.querySelector("[data-vcr-mark='dashed']")).not.toBeNull();
  });
});
