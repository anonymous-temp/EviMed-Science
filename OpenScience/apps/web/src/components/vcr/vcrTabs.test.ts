import { VCR_STEP_LABELS_ZH, VCR_STEPS, VCR_TAB_LABELS_ZH, VCR_TABS } from "@evimed/domain";
import { describe, expect, it } from "vitest";
import { isVcrTab, resolveVcrTab, VCR_RAIL_STEPS, VCR_STEP_TABS, VCR_TAB_ITEMS, vcrTabPath } from "./vcrTabs";

describe("the study page's tabs", () => {
  it("is the domain's list, in the domain's order, with the domain's names", () => {
    expect(VCR_TAB_ITEMS.map((tab) => tab.key)).toEqual([...VCR_TABS]);
    for (const tab of VCR_TAB_ITEMS) {
      expect(tab.label).toBe((VCR_TAB_LABELS_ZH as Record<string, string>)[tab.key]);
      expect(tab.label).not.toBe("");
    }
  });

  // The design spec caps a page at seven tabs; the vocabulary is what holds
  // the line, and this is the assertion that notices if it stops.
  it("is at most seven", () => {
    expect(VCR_TAB_ITEMS.length).toBeLessThanOrEqual(7);
  });

  it("names the seven steps of the rail from the domain too", () => {
    expect(VCR_RAIL_STEPS.map((step) => step.key)).toEqual([...VCR_STEPS]);
    for (const step of VCR_RAIL_STEPS) {
      expect(step.label).toBe((VCR_STEP_LABELS_ZH as Record<string, string>)[step.key]);
    }
  });

  it("gives every step a tab its result can be read on", () => {
    for (const step of VCR_STEPS) {
      const tab = VCR_STEP_TABS[step as keyof typeof VCR_STEP_TABS];
      expect(isVcrTab(tab)).toBe(true);
    }
  });
});

describe("an address", () => {
  it("means 总览 when it names no tab, and says so is not a move", () => {
    expect(resolveVcrTab(undefined)).toEqual({ tab: "overview", moved: false });
    expect(resolveVcrTab("population")).toEqual({ tab: "population", moved: false });
  });

  it("resolves a step name to the tab that holds it, and says the address moved", () => {
    expect(resolveVcrTab("evidence")).toEqual({ tab: "data", moved: true });
    expect(resolveVcrTab("definition")).toEqual({ tab: "overview", moved: true });
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
