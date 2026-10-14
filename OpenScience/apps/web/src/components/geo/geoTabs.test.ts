import { describe, expect, it } from "vitest";
import { GEO_STEP_KEYS } from "@/lib/geoClient";
import {
  GEO_MONITORING_TABS,
  GEO_STEP_HOME,
  GEO_TAB_REDIRECTS,
  GEO_TAB_STEPS,
  GEO_TABS,
  geoDestinationPath,
  geoEvidenceView,
  geoQuestionsView,
  geoSectionId,
  geoTabPath,
  isGeoTab,
  resolveGeoTab,
} from "./geoTabs";

/**
 * The rebuild moved every tab. What must not move is an address: a bookmark, a link inside a delivered report and the conversation
 * frame's own “打开诊断” all name one of the nine old tabs, and each of them still has to land somewhere a reader recognises.
 */
describe("the project page's tabs", () => {
  it("is eight views, by the question a reader arrives with — 依据 last", () => {
    expect(GEO_TABS.map((tab) => tab.key)).toEqual(["overview", "visibility", "accuracy", "questions", "sources", "actions", "plan", "evidence"]);
    expect(GEO_TABS.map((tab) => tab.label)).toEqual(["总览", "可见度", "准确与安全", "问题与回答", "信源", "行动", "方案", "依据"]);
  });

  it("resolves every one of the eight step addresses, and says the address moved", () => {
    const landings: Record<string, { tab: string; view?: string }> = {
      evidence: { tab: "evidence" },
      journey: { tab: "questions", view: "journey" },
      questions: { tab: "questions" },
      diagnosis: { tab: "accuracy" },
      sources: { tab: "sources" },
      content: { tab: "actions" },
      distribution: { tab: "actions" },
      monitoring: { tab: "visibility" },
    };
    for (const step of GEO_STEP_KEYS) {
      const resolved = resolveGeoTab(step);
      expect(resolved.tab, step).toBe(landings[step].tab);
      expect(resolved.view, step).toBe(landings[step].view);
      // 证据, 问题 and 信源 are tabs by that name, so they kept their address; the others moved.
      expect(resolved.moved, step).toBe(!GEO_TABS.some((tab) => tab.key === step));
      expect(isGeoTab(step), step).toBe(true);
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

  it("writes a destination as the tab, its view and its block, in that order, and any parameter the caller keeps", () => {
    expect(geoDestinationPath("geo_1", { tab: "questions", view: "journey" })).toBe("/app/geo/geo_1/questions?view=journey");
    expect(geoDestinationPath("geo_1", { tab: "accuracy", section: "errors" })).toBe("/app/geo/geo_1/accuracy#geo-errors");
    expect(geoDestinationPath("geo_1", { tab: "plan", section: "client_actions" })).toBe("/app/geo/geo_1/plan#geo-client-actions");
    expect(geoDestinationPath("geo_1", { tab: "questions", view: "pools" }, { group: "gq_7", engine: null })).toBe("/app/geo/geo_1/questions?view=pools&group=gq_7");
    expect(geoSectionId("client_actions")).toBe("geo-client-actions");
  });

  it("reads a bad ?view= as the tab's first view", () => {
    expect(geoQuestionsView("journey")).toBe("journey");
    expect(geoQuestionsView("nonsense")).toBe("pools");
    expect(geoQuestionsView(null)).toBe("pools");
    expect(geoEvidenceView("value")).toBe("value");
    expect(geoEvidenceView("x")).toBe("claims");
  });
});

/**
 * The step ↔ tab table (audit C A.2) is data, and these hold it: nothing in the rail points at a tab that is not there, nothing in
 * the tabs claims a step that does not come back to it, and a tab that is not 总览 is made of at least one step.
 */
describe("the step ↔ tab map", () => {
  const tabs = GEO_TABS.map((tab) => tab.key);

  it("gives every step a home that is a tab", () => {
    expect(Object.keys(GEO_STEP_HOME).sort()).toEqual([...GEO_STEP_KEYS].sort());
    for (const step of GEO_STEP_KEYS) expect(tabs, step).toContain(GEO_STEP_HOME[step].tab);
  });

  it("makes every home tab out of its own step, so the rail's click and the underline agree", () => {
    for (const step of GEO_STEP_KEYS) expect(GEO_TAB_STEPS[GEO_STEP_HOME[step].tab], step).toContain(step);
  });

  it("makes every tab but 总览 out of at least one step, and 总览 out of none", () => {
    expect(Object.keys(GEO_TAB_STEPS).sort()).toEqual([...tabs].sort());
    for (const tab of tabs) {
      if (tab === "overview") expect(GEO_TAB_STEPS[tab]).toEqual([]);
      else expect(GEO_TAB_STEPS[tab].length, tab).toBeGreaterThan(0);
    }
  });

  it("names only steps that exist, and every step is read somewhere", () => {
    for (const tab of tabs) for (const step of GEO_TAB_STEPS[tab]) expect(GEO_STEP_KEYS, `${tab}: ${step}`).toContain(step);
    for (const step of GEO_STEP_KEYS) expect(tabs.some((tab) => GEO_TAB_STEPS[tab].includes(step)), step).toBe(true);
  });

  it("reads the same as the audit's table: the see-also tabs are the ones that also feed the step", () => {
    expect(GEO_TAB_STEPS.visibility).toEqual(["diagnosis", "monitoring"]);
    expect(GEO_TAB_STEPS.accuracy).toEqual(["diagnosis"]);
    expect(GEO_TAB_STEPS.questions).toEqual(["journey", "questions"]);
    expect(GEO_TAB_STEPS.sources).toEqual(["sources"]);
    expect(GEO_TAB_STEPS.plan).toEqual(["sources"]);
    expect(GEO_TAB_STEPS.actions).toEqual(["content", "distribution", "monitoring"]);
    expect(GEO_TAB_STEPS.evidence).toEqual(["evidence"]);
  });

  it("derives the measurement tabs from the table: 「AI 回答监测」 is the tabs built from the questions or the diagnosis", () => {
    expect([...GEO_MONITORING_TABS]).toEqual(["visibility", "accuracy", "questions"]);
  });

  it("sends an old address to where the table says the step is read now", () => {
    for (const [address, destination] of Object.entries(GEO_TAB_REDIRECTS)) {
      expect(GEO_STEP_KEYS, address).toContain(address);
      expect(destination.tab, address).toBe(GEO_STEP_HOME[address as keyof typeof GEO_STEP_HOME].tab);
    }
  });
});
