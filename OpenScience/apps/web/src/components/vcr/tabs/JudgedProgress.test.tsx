import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VcrJudgedProgress } from "@/lib/vcrClient";
import { JudgedProgressNote } from "./JudgedProgress";
import { ClauseList } from "./JudgedPair";

const progress = (extra: Partial<VcrJudgedProgress>): VcrJudgedProgress => ({ total: 3, finished: 3, failed: 0, waiting: 0, state: "done", jobId: "j", startedAt: null, cost: { ceiling: null, spent: 1, currency: "CNY" }, ...extra });
const note = (value: VcrJudgedProgress) => render(<JudgedProgressNote progress={value} noun="个试验" mayRun busy={false} onResume={vi.fn()} onStop={vi.fn()} />);

describe("a stage that did not finish", () => {
  it("reads as not done, with the clause work counted and offered", () => {
    note(progress({ state: "stopped", clauses: { wanted: 2, done: 0, left: 2 } }));
    expect(screen.getByText(/判定没有做完/)).toHaveTextContent("逐条判了 0 / 2");
    expect(screen.getByRole("button", { name: /继续判定剩下的 2 个/ })).toBeInTheDocument();
    expect(screen.queryByText(/已全部判完/)).toBeNull();
  });

  it("a whole job still reads finished", () => {
    note(progress({ clauses: { wanted: 2, done: 2, left: 0 } }));
    expect(screen.getByText(/已全部判完/)).toBeInTheDocument();
  });

  it("a count too small to show this reader is not a zero: the rest is still offered", () => {
    note(progress({ state: "stopped", total: null, finished: null, clauses: { wanted: null, done: null, left: null } }));
    expect(screen.getByRole("button", { name: "继续判定剩下的" })).toBeInTheDocument();
  });
});

describe("a clause under no section", () => {
  it("says so, and what introduces it is drawn with it", () => {
    render(<ClauseList label="逐条" mayRead={false} onOpen={vi.fn()} clauses={[{ number: 1, kind: "unsectioned", clause: "No pregnancy", lead: "Donor criteria:", label: "not_excluded", basis: "silent", display: "未见记载，按未排除", stance: "silent", reason: "", evidence: [] }]} />);
    expect(screen.getByText("未分节")).toBeInTheDocument();
    expect(screen.queryByText("入选")).toBeNull();
    expect(screen.getByText("Donor criteria:")).toBeInTheDocument();
  });
});
