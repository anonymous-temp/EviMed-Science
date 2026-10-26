import { expect, it } from "vitest";
import { hasDefinition, resolveVcrTab, VCR_TAB_ITEMS, vcrStepPath, vcrTabPath } from "./vcrTabs";
it("keeps six saved-result destinations and compatible evidence steps", () => {
  expect(VCR_TAB_ITEMS.map(row => row.key)).toEqual(["overview", "matching", "population", "comparator", "trial", "data"]);
  expect(resolveVcrTab("evidence")).toEqual({ tab: "data", moved: true });
  expect(vcrTabPath("study", "overview")).toBe("/app/virtual-research/study");
  expect(vcrStepPath("study", "patients")).toBe("/app/virtual-research/study/population?step=patients&level=individual");
  expect(hasDefinition({ steps: { definition: { status: "done" } } })).toBe(true);
});
