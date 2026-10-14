import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { VcrSteps } from "@/lib/vcrClient";
import { stepsOfRow, VcrStepProgress } from "./VcrStepProgress";

const steps = (record: Record<string, string>): VcrSteps =>
  Object.fromEntries(Object.entries(record).map(([key, status]) => [key, { status }])) as VcrSteps;

function draw(props: Partial<Parameters<typeof VcrStepProgress>[0]> & { steps: VcrSteps }) {
  return render(<MemoryRouter><VcrStepProgress studyId="std_1" {...props} /></MemoryRouter>);
}

describe("which steps a row names", () => {
  it("names all seven, in the programme's order, each in the state it is in", () => {
    expect(stepsOfRow(steps({ definition: "done", evidence: "minimal", population: "running", patients: "failed", comparator: "none", trial: "queued", matching: "stale" })))
      .toEqual([
        { key: "definition", state: "done", word: null },
        { key: "evidence", state: "done", word: null },
        { key: "population", state: "active", word: "进行中" },
        { key: "patients", state: "attention", word: "未完成" },
        { key: "comparator", state: "todo", word: null },
        { key: "trial", state: "active", word: "排队中" },
        { key: "matching", state: "attention", word: "已过期" },
      ]);
  });

  it("draws a study that has not begun as seven hollow steps, not as nothing", () => {
    expect(stepsOfRow({}).map((entry) => entry.state)).toEqual(Array(7).fill("todo"));
  });
});

describe("a study's progress in its row", () => {
  it("is a dot and a word per step, every word a link to the tab that holds the step", () => {
    const { container } = draw({ steps: steps({ definition: "done", trial: "running" }) });
    const list = screen.getByRole("list", { name: /^七个步骤：定义已完成，证据未开始/ });
    const links = within(list).getAllByRole("link");
    expect(links).toHaveLength(7);
    // 定义 and 证据 are read on one tab; the others are their own.
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/app/virtual-research/std_1/data", "/app/virtual-research/std_1/data", "/app/virtual-research/std_1/population",
      "/app/virtual-research/std_1/patients", "/app/virtual-research/std_1/comparator", "/app/virtual-research/std_1/trial", "/app/virtual-research/std_1/matching",
    ]);
    expect(container.querySelector("[data-vcr-step='trial']")).toHaveTextContent("试验进行中");
    // The marks differ in shape as well as colour: done is filled, under way a ring, not started a small hollow one.
    expect(container.querySelector("[data-vcr-step='definition'] [data-forced-colors]")?.className).toContain("bg-accent");
    expect(container.querySelector("[data-vcr-step='trial'] [data-forced-colors]")?.className).toContain("ring-accent");
    expect(container.querySelector("[data-vcr-step='matching'] [data-forced-colors]")?.className).toContain("ring-border-control");
  });

  it("counts the steps done and names the next one as a link — the same step the study's page offers", () => {
    draw({ steps: steps({ definition: "done", evidence: "done", population: "done", patients: "done", comparator: "none", trial: "none", matching: "none" }) });
    expect(screen.getByText("4/7 步")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下一步：设计对照" })).toHaveAttribute("href", "/app/virtual-research/std_1/comparator");
  });

  it("offers no next step while one is under way, for a paused study, or for one nobody has described", () => {
    const first = draw({ steps: steps({ definition: "done", population: "running" }) });
    expect(screen.queryByText(/下一步/)).toBeNull();
    first.unmount();
    const paused = draw({ steps: steps({ definition: "done" }), paused: true });
    expect(screen.queryByText(/下一步/)).toBeNull();
    paused.unmount();
    draw({ steps: steps({}), described: false });
    expect(screen.queryByText(/下一步/)).toBeNull();
  });
});
