import { MemoryRouter } from "react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LearningOverview } from "./LearningOverview";
import type { LearningSummary } from "@/lib/methodsClient";

const summary: LearningSummary = { methods: { approved: 2 }, uses: {}, lessons: { byTrigger: {}, succeeded: 0, failed: 0 }, results: {}, handbookCandidates: 9, spend24hCny: null,
  handbooks: { dispositions: { queued: 9 }, applied: 1, unmeasured: 1, evaluated: 0, verifiedImprovement: 0, attached: 1, used: 0, outcomes: 0,
    recent: [{ id: "h", title: "分母核对", capabilityId: "geo-content", version: 1, verification: "unmeasured", appliedAt: "2026-09-30T00:00:00Z", source: { projectId: "p", runId: "r" } }] } };
describe("LearningOverview", () => {
  it("shows applied handbook changes without calling unused unmeasured changes improvements", () => {
    render(<MemoryRouter><LearningOverview summary={summary} onViewMethods={() => {}} /></MemoryRouter>);
    expect(screen.getByText("能力经验")).toBeInTheDocument();
    expect(screen.getByText("分母核对")).toBeInTheDocument();
    expect(screen.getByText("效果待观察")).toBeInTheDocument();
    expect(screen.queryByText("已验证改善")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /批准|审核|同意/ })).not.toBeInTheDocument();
  });
  it("does not turn unavailable handbook metrics into zero", () => {
    render(<MemoryRouter><LearningOverview summary={{ ...summary, handbooks: null }} onViewMethods={() => {}} /></MemoryRouter>);
    expect(screen.queryByText("能力经验")).not.toBeInTheDocument();
  });
});
