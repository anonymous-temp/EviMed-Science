import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VcrSteps } from "@/lib/vcrClient";
import { shownSteps, VcrStepProgress } from "./VcrStepProgress";

const steps = (record: Record<string, string>): VcrSteps =>
  Object.fromEntries(Object.entries(record).map(([key, status]) => [key, { status }])) as VcrSteps;

describe("which steps a row names", () => {
  it("names the steps that are done, the one under way and the one that did not finish, in the programme's order", () => {
    expect(shownSteps(steps({ definition: "done", evidence: "minimal", population: "running", patients: "failed", comparator: "none", trial: "queued", matching: "stale" })))
      .toEqual([
        { key: "definition", state: "done", word: null },
        { key: "evidence", state: "done", word: null },
        { key: "population", state: "active", word: "进行中" },
        { key: "patients", state: "attention", word: "未完成" },
        { key: "trial", state: "active", word: "进行中" },
        { key: "matching", state: "attention", word: "已过期" },
      ]);
  });

  it("names none of what has not started: a row that listed seven words for a study that has done two read as a form", () => {
    expect(shownSteps(steps({ definition: "done", population: "done" })).map((entry) => entry.key)).toEqual(["definition", "population"]);
    expect(shownSteps({})).toEqual([]);
  });
});

describe("a study's progress in words", () => {
  it("is said to a screen reader as one sentence and drawn as a dot and a word per step", () => {
    const { container } = render(<VcrStepProgress steps={steps({ definition: "done", trial: "running" })} />);
    expect(screen.getByRole("img", { name: "定义已完成，试验 进行中" })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-vcr-step]")).toHaveLength(2);
    expect(container.querySelector("[data-vcr-step='trial']")).toHaveTextContent("试验进行中");
    // The marks differ in shape as well as colour: done is filled, under way a ring.
    expect(container.querySelector("[data-vcr-step='definition'] [data-forced-colors]")?.className).toContain("bg-accent");
    expect(container.querySelector("[data-vcr-step='trial'] [data-forced-colors]")?.className).toContain("ring-accent");
  });

  it("says 还没有开始 for a study that has not begun", () => {
    render(<VcrStepProgress steps={steps({})} />);
    expect(screen.getByRole("img", { name: "还没有开始" })).toBeInTheDocument();
  });
});
