import { describe, expect, it } from "vitest";
import { VCR_STEPS } from "@evimed/domain";
import type { VcrStudy } from "@/lib/vcrClient";
import { frameVcrOptions, isIntendedUse, isStart, startOf, VCR_STARTERS, VCR_START_OPTIONS } from "./frameVcrOptions";

const requested = (...steps: string[]) => Object.fromEntries(VCR_STEPS.map((step) => [step, { status: "none", requested: steps.includes(step) }])) as VcrStudy["steps"];
const study = (abilities: string[], steps: VcrStudy["steps"] = requested(...VCR_STEPS)): VcrStudy => ({
  id: "std_1", projectId: "p", name: "EV-201", question: null, tier: "T0", intendedUse: "design_support", status: "active",
  steps, sessionId: null, definition: null, abilities, budget: null, jobs: [], ceiling: null,
  overview: { headline: null, metrics: [], counts: null, designs: [], attention: [], changes: [], reviews: [], deliverables: [] },
});

describe("where a study starts, read from what it asks for", () => {
  it("is 自动 when everything is requested, and when nothing is yet", () => {
    expect(startOf(study([]))).toBe("auto");
    expect(startOf(study([], requested()))).toBe("auto");
    expect(startOf({ steps: {} })).toBe("auto");
  });

  it("is the action whose one step is the only one requested", () => {
    expect(startOf(study([], requested("population")))).toBe("cohort");
    expect(startOf(study([], requested("patients")))).toBe("patients");
    expect(startOf(study([], requested("comparator")))).toBe("comparator");
    expect(startOf(study([], requested("trial")))).toBe("trial");
  });

  it("is 自动 for a single step no action starts from, and for several", () => {
    expect(startOf(study([], requested("matching")))).toBe("auto");
    expect(startOf(study([], requested("population", "trial")))).toBe("auto");
  });
});

describe("what the chip draws", () => {
  it("is the plan's five starting points and the six starting points of a new study, in order", () => {
    expect(VCR_START_OPTIONS.map((option) => option.label)).toEqual(["自动", "队列", "患者", "对照", "试验"]);
    expect(VCR_STARTERS.map((starter) => starter.label)).toEqual(["估算样本量", "生成合成人群", "外部对照可行性", "模拟试验方案", "找先例与参数", "匹配患者"]);
    // The bridge carries a sentence of at most 400 characters and a name of at most 24.
    for (const starter of VCR_STARTERS) {
      expect(starter.draft.length).toBeLessThanOrEqual(400);
      expect(starter.label.length).toBeLessThanOrEqual(24);
    }
  });

  it("carries the study's own start and intended use, and the four uses in the vocabulary's order", () => {
    const options = frameVcrOptions("session-a", study(["read", "write", "manage_study"], requested("trial")));
    expect(options).toMatchObject({ sessionId: "session-a", controls: true, canSetUse: true, start: "trial", intendedUse: "design_support" });
    expect(options.useOptions.map((option) => option.label)).toEqual(["探索", "研究设计支持", "指定研究分析", "申报准备"]);
  });

  it("offers each control only to the roles the routes let make the change", () => {
    expect(frameVcrOptions("s", study(["read", "write"]))).toMatchObject({ canSetUse: false });
    expect(frameVcrOptions("s", study(["read", "write"])).startOptions).toHaveLength(5);
    expect(frameVcrOptions("s", study(["read"]))).toMatchObject({ canSetUse: false, startOptions: [] });
    expect(frameVcrOptions("s", study(["read", "manage_study"])).canSetUse).toBe(true);
  });

  it("is the starters alone, with exploratory as the default, when there is no study", () => {
    const options = frameVcrOptions("session-a", null);
    expect(options).toMatchObject({ controls: false, canSetUse: false, start: "auto", intendedUse: "exploratory", startOptions: [] });
    expect(options.starters).toHaveLength(6);
  });

  it("knows its own closed vocabularies", () => {
    expect(isStart("trial")).toBe(true);
    expect(isStart("everything")).toBe(false);
    expect(isIntendedUse("specified_analysis")).toBe(true);
    expect(isIntendedUse("approved")).toBe(false);
  });
});
