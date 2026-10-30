import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { VcrResearchProgress } from "./VcrResearchProgress";
import type { VcrResearchProgress as Progress } from "@/lib/vcrClient";

const progress: Progress = { populationId: "p1", populationVersion: 1, definition: "saved", input: "unknown", calculation: "none", resultId: null, resultStale: false,
  counts: { sourcePatients: 78, realPatients: null, observations: 4407, generatedRecords: 200, reconstructedPseudoPatients: null },
  profileStatistics: [{ column: "年龄", mean: 66, median: 71, direction: "mean_below_median" }] };
function draw(value: Progress) { return render(<MemoryRouter><VcrResearchProgress progress={value} studyId="s1" /></MemoryRouter>); }
describe("VcrResearchProgress", () => {
  it("keeps a saved definition, unknown input and distinct data counts separate", () => {
    draw(progress); expect(screen.getByText("已保存")).toBeInTheDocument(); expect(screen.getByText("待检查")).toBeInTheDocument();
    expect(screen.getByText("尚无计算结果")).toBeInTheDocument(); expect(screen.getByText("78 人")).toBeInTheDocument();
    expect(screen.getByText("4,407 条")).toBeInTheDocument(); expect(screen.getByText("200 条")).toBeInTheDocument();
    expect(screen.getByText("均值 66，中位数 71")).toBeInTheDocument(); expect(screen.queryByText(/右偏|选择偏倚/)).not.toBeInTheDocument();
  });
  it("distinguishes a subject-table source from the resulting cohort", () => {
    draw({ ...progress, counts: { ...progress.counts, sourcePatients: 80, realPatients: 52, observations: null } });
    expect(screen.getByText("80 人")).toBeInTheDocument(); expect(screen.getByText("52 人")).toBeInTheDocument();
  });
  it("shows failed computation and keeps the conversation accessible", () => {
    draw({ ...progress, input: "missing", calculation: "failed" }); expect(screen.getByText("计算未完成")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回研究对话" })).toBeInTheDocument();
  });
  it("does not call stale results current", () => {
    draw({ ...progress, calculation: "stale" }); expect(screen.getByText("结果已过期，需重新计算")).toBeInTheDocument();
  });
});
