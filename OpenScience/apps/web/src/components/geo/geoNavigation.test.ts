import { describe, expect, it } from "vitest";
import { geoDestinationPath, geoViewedStep } from "./geoTabs";

describe("one GEO workflow navigation", () => {
  it("takes the current workbench from its actual view rather than an unrelated retained step", () => {
    expect(geoViewedStep("actions", { step: "journey" })).toBe("content");
    expect(geoViewedStep("accuracy", { step: "distribution" })).toBe("diagnosis");
    expect(geoViewedStep("questions", { step: "questions", view: "journey" })).toBe("journey");
    expect(geoViewedStep("questions", { step: "journey", view: "all" })).toBe("questions");
    expect(geoViewedStep("plan", {})).toBe("sources");
    expect(geoViewedStep("actions", { section: "geo-delivery" })).toBe("distribution");
    expect(geoViewedStep("actions", { step: "content", section: "geo-budget" })).toBe("distribution");
    expect(geoViewedStep("actions", { section: "geo-effect" })).toBe("monitoring");
    expect(geoViewedStep("actions", { step: "distribution", section: "geo-review" })).toBe("content");
    expect(geoViewedStep("visibility", { step: "diagnosis" })).toBe("diagnosis");
    expect(geoViewedStep("visibility", {})).toBe("diagnosis");
    expect(geoViewedStep("visibility", { step: "diagnosis", section: "geo-trend" })).toBe("monitoring");
    expect(geoViewedStep("visibility", { step: "monitoring" })).toBe("monitoring");
  });

  it("keeps valid workflow context in conversation without imposing a result page", () => {
    expect(geoViewedStep("overview", { step: "evidence", conversation: true })).toBe("evidence");
    expect(geoViewedStep("overview", { step: "unknown", conversation: true })).toBeNull();
  });

  it("preserves repeated analytical filters when a destination selects its own view", () => {
    const query = new URLSearchParams("engines=deepseek&engines=qianwen&from=2026-10-01&session=ses1&view=all");
    const url = new URL(geoDestinationPath("geo1", { tab: "questions", view: "journey" }, query), "https://example.test");
    expect(url.searchParams.getAll("engines")).toEqual(["deepseek", "qianwen"]);
    expect(url.searchParams.get("from")).toBe("2026-10-01");
    expect(url.searchParams.get("session")).toBe("ses1");
    expect(url.searchParams.get("view")).toBe("journey");
  });
});
