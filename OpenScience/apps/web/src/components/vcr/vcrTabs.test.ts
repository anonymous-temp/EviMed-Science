import { VCR_STEP_LABELS_ZH, VCR_STEPS, VCR_TAB_LABELS_ZH, VCR_TABS } from "@evimed/domain";
import { describe, expect, it } from "vitest";
import type { VcrStepKey, VcrStepStatus, VcrStudy } from "@/lib/vcrClient";
import { hasDefinition, isVcrTab, resolveVcrTab, stepsOfTab, tabDot, VCR_RAIL_STEPS, VCR_STEP_TABS, VCR_TAB_ITEMS, vcrTabPath } from "./vcrTabs";

const steps = (status: Partial<Record<VcrStepKey, VcrStepStatus>>, extra: Partial<Record<VcrStepKey, Record<string, unknown>>> = {}): VcrStudy["steps"] =>
  Object.fromEntries(VCR_STEPS.map((step) => [step, { status: status[step as VcrStepKey] ?? "none", ...(extra[step as VcrStepKey] ?? {}) }])) as VcrStudy["steps"];

describe("the study page's tabs", () => {
  it("is the domain's set with the domain's names, in the page's reading order", () => {
    expect(VCR_TAB_ITEMS.map((tab) => tab.key).sort()).toEqual([...VCR_TABS].sort());
    expect(VCR_TAB_ITEMS.map((tab) => tab.label)).toEqual(["总览", "定义与证据", "人群", "虚拟患者", "对照", "试验", "匹配与招募"]);
    for (const tab of VCR_TAB_ITEMS) {
      expect(tab.label).toBe((VCR_TAB_LABELS_ZH as Record<string, string>)[tab.key]);
    }
  });

  // The design spec caps a page at seven tabs; the vocabulary is what holds
  // the line, and this is the assertion that notices if it stops.
  it("is at most seven", () => {
    expect(VCR_TAB_ITEMS.length).toBeLessThanOrEqual(7);
  });

  it("names the seven steps from the domain too", () => {
    expect(VCR_RAIL_STEPS.map((step) => step.key)).toEqual([...VCR_STEPS]);
    for (const step of VCR_RAIL_STEPS) {
      expect(step.label).toBe((VCR_STEP_LABELS_ZH as Record<string, string>)[step.key]);
    }
  });

  it("gives every step a tab its result can be read on, and puts 定义 and 证据 on one", () => {
    for (const step of VCR_STEPS) {
      expect(isVcrTab(VCR_STEP_TABS[step as VcrStepKey])).toBe(true);
    }
    expect(VCR_STEP_TABS.definition).toBe("data");
    expect(VCR_STEP_TABS.evidence).toBe("data");
    expect(stepsOfTab("data")).toEqual(["definition", "evidence"]);
    expect(stepsOfTab("overview")).toEqual([]);
  });
});

describe("a tab's dot", () => {
  it("is absent on 总览: it is the study as a whole, not a stage", () => {
    expect(tabDot({ steps: steps({ definition: "done" }) }, "overview")).toBeUndefined();
  });

  it("is todo for a stage nothing has touched, active while it runs or queues, and done when every step it holds is", () => {
    const study = { steps: steps({ definition: "done", evidence: "done", population: "running", patients: "queued", comparator: "minimal" }) };
    expect(tabDot(study, "data")).toBe("done");
    expect(tabDot(study, "population")).toBe("active");
    expect(tabDot(study, "patients")).toBe("active");
    expect(tabDot(study, "comparator")).toBe("done");
    expect(tabDot(study, "trial")).toBe("todo");
    expect(tabDot(study, "matching")).toBe("todo");
  });

  it("is active for a tab with some of its steps done and the rest not started: the study is not finished there", () => {
    expect(tabDot({ steps: steps({ definition: "done" }) }, "data")).toBe("active");
  });

  it("needs the reader when a step did not finish, a result went stale or the allowance refused the start", () => {
    expect(tabDot({ steps: steps({ trial: "failed" }) }, "trial")).toBe("attention");
    expect(tabDot({ steps: steps({ population: "stale" }) }, "population")).toBe("attention");
    expect(tabDot({ steps: steps({ patients: "queued" }, { patients: { waiting: "allowance" } }) }, "patients")).toBe("attention");
    // A failure outranks work under way in the same tab.
    expect(tabDot({ steps: steps({ definition: "running", evidence: "failed" }) }, "data")).toBe("attention");
  });
});

describe("whether a study has been described", () => {
  it("is said by the definition step's status and nothing else", () => {
    expect(hasDefinition({ steps: steps({}) })).toBe(false);
    expect(hasDefinition({ steps: steps({ definition: "queued" }) })).toBe(false);
    expect(hasDefinition({ steps: steps({ definition: "running" }) })).toBe(false);
    expect(hasDefinition({ steps: steps({ definition: "done" }) })).toBe(true);
    expect(hasDefinition({ steps: steps({ definition: "minimal" }) })).toBe(true);
    expect(hasDefinition({ steps: steps({ definition: "stale" }) })).toBe(true);
    expect(hasDefinition({ steps: {} })).toBe(false);
  });
});

describe("an address", () => {
  it("means 总览 when it names no tab, and says so is not a move", () => {
    expect(resolveVcrTab(undefined)).toEqual({ tab: "overview", moved: false });
    expect(resolveVcrTab("population")).toEqual({ tab: "population", moved: false });
  });

  it("resolves a step name to the tab that holds it, and says the address moved", () => {
    expect(resolveVcrTab("evidence")).toEqual({ tab: "data", moved: true });
    expect(resolveVcrTab("definition")).toEqual({ tab: "data", moved: true });
  });

  it("lands an address that never existed on 总览 rather than nowhere", () => {
    expect(resolveVcrTab("no-such-tab")).toEqual({ tab: "overview", moved: true });
  });

  it("makes 总览 the study's own address, and encodes an id that needs it", () => {
    expect(vcrTabPath("std_1", "overview")).toBe("/app/virtual-research/std_1");
    expect(vcrTabPath("std_1", "trial")).toBe("/app/virtual-research/std_1/trial");
    expect(vcrTabPath("a/b", "overview")).toBe("/app/virtual-research/a%2Fb");
  });
});
