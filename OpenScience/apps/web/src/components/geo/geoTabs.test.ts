import { describe, expect, it } from "vitest";
import { GEO_STEP_KEYS } from "@/lib/geoClient";
import { GEO_TABS, geoTabPath, isGeoTab, resolveGeoTab } from "./geoTabs";

/**
 * The rebuild moved every tab. What must not move is an address: a bookmark, a
 * link inside a delivered report and the conversation frame's own 「打开诊断」
 * all name one of the nine old tabs, and each of them still has to land
 * somewhere a reader recognises.
 */
describe("the project page's tabs", () => {
  it("is seven views, by the question a reader arrives with", () => {
    expect(GEO_TABS.map((tab) => tab.key)).toEqual(["overview", "visibility", "accuracy", "questions", "sources", "actions", "plan"]);
    expect(GEO_TABS.map((tab) => tab.label)).toEqual(["总览", "可见度", "准确与安全", "问题与回答", "信源", "行动", "方案"]);
  });

  it("resolves every one of the eight step addresses, and says the address moved", () => {
    const landings: Record<string, string> = {
      evidence: "plan",
      journey: "plan",
      questions: "questions",
      diagnosis: "accuracy",
      sources: "sources",
      content: "actions",
      distribution: "actions",
      monitoring: "visibility",
    };
    for (const step of GEO_STEP_KEYS) {
      const resolved = resolveGeoTab(step);
      expect(resolved.tab).toBe(landings[step]);
      // 问题 and 信源 kept their subject, so they kept their address too.
      expect(resolved.moved).toBe(landings[step] !== step);
      expect(isGeoTab(step)).toBe(true);
    }
  });

  it("leaves a current address alone", () => {
    for (const tab of GEO_TABS) {
      expect(resolveGeoTab(tab.key)).toEqual({ tab: tab.key, moved: false });
    }
    expect(resolveGeoTab(undefined)).toEqual({ tab: "overview", moved: false });
  });

  it("sends an address it does not know to 总览 rather than to a blank page", () => {
    expect(resolveGeoTab("whatever")).toEqual({ tab: "overview", moved: true });
    expect(isGeoTab("whatever")).toBe(false);
  });

  it("writes 总览 as the project's own address", () => {
    expect(geoTabPath("geo_1", "overview")).toBe("/app/geo/geo_1");
    expect(geoTabPath("geo/1", "accuracy")).toBe("/app/geo/geo%2F1/accuracy");
  });
});
