import { describe, expect, it } from "vitest";
import { VCR_STEPS, VCR_STEP_LABELS_ZH, VCR_TAB_LABELS_ZH } from "@evimed/domain";
import type { VcrStudy } from "@/lib/vcrClient";
import { frameVcrOptions, isIntendedUse, isStart, startOf, VCR_STARTERS, VCR_START_OPTIONS } from "./frameVcrOptions";

const requested = (...steps: string[]) => Object.fromEntries(VCR_STEPS.map((step) => [step, { status: "none", requested: steps.includes(step) }])) as VcrStudy["steps"];
const study = (abilities: string[], steps: VcrStudy["steps"] = requested(...VCR_STEPS)): VcrStudy => ({
  id: "std_1", projectId: "p", name: "EV-201", question: null, tier: "T0", intendedUse: "design_support", status: "active",
  steps, sessionId: null, conversation: { sessionId: null, exists: false }, activity: null, stepSummaries: {},
  definition: null, abilities, budget: null, jobs: [], ceiling: null,
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

// One task, one name: the home's task, the chip's starting point and the page's tab are named from the domain's tables, so a rename
// there is a rename everywhere and the three cannot drift (the audit found 患者匹配 / 匹配 / 创建虚拟队列 for what is one thing).
describe("the names of the tasks", () => {
  it("are the tab's name on the home and the step's name on the chip", () => {
    const tabLabel = VCR_TAB_LABELS_ZH as Record<string, string>;
    const stepLabel = VCR_STEP_LABELS_ZH as Record<string, string>;
    // The comparison task is called 对照研究 as a task (owner decision of 2026-11-01); its tab and its step stay 对照.
    const taskName: Record<string, string> = { comparator: "对照研究" };
    for (const task of VCR_STARTERS) expect(task.label, task.id).toBe(taskName[task.id] ?? tabLabel[task.id]);
    const startStep: Record<string, string> = { cohort: "population", patients: "patients", comparator: "comparator", trial: "trial" };
    for (const [id, step] of Object.entries(startStep)) expect(VCR_START_OPTIONS.find((option) => option.id === id)?.label, id).toBe(stepLabel[step]);
  });
});

describe("what the chip draws", () => {
  it("is the plan's five starting points and the six starting points of a new study, in order", () => {
    expect(VCR_START_OPTIONS.map((option) => option.label)).toEqual(["自动", "人群", "患者", "对照", "试验"]);
    expect(VCR_STARTERS.map((starter) => starter.label)).toEqual(["匹配", "人群与患者", "对照研究", "试验"]);
    expect(VCR_STARTERS.map((starter) => starter.summary)).toEqual(["查找适合患者的试验，核对入排条件。", "建立研究队列，查看个体的模拟结果。", "构建对照人群，比较两组结局。", "比较不同试验方案的样本量、把握度和周期。"]);
    // Each starter is a short unsent request; the researcher supplies the details.
    for (const starter of VCR_STARTERS) {
      expect(starter.draft.length).toBeLessThanOrEqual(50);
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
    expect(frameVcrOptions("s", study(["read", "write"])).startOptions).toHaveLength(0);
    expect(frameVcrOptions("s", study(["read"]))).toMatchObject({ canSetUse: false, startOptions: [] });
    expect(frameVcrOptions("s", study(["read", "manage_study"])).canSetUse).toBe(true);
  });

  it("is the starters alone, with exploratory as the default, when there is no study", () => {
    const options = frameVcrOptions("session-a", null);
    expect(options).toMatchObject({ controls: false, canSetUse: false, start: "auto", intendedUse: "exploratory", startOptions: [] });
    expect(options.starters).toHaveLength(4);
  });

  it("knows its own closed vocabularies", () => {
    expect(isStart("trial")).toBe(true);
    expect(isStart("everything")).toBe(false);
    expect(isIntendedUse("specified_analysis")).toBe(true);
    expect(isIntendedUse("approved")).toBe(false);
  });
});
