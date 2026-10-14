import { describe, expect, it } from "vitest";
import type { GeoProject } from "@/lib/geoClient";
import { geoProject } from "./__fixtures__/geoTabs";
import { bandNow, bandSteps } from "./geoBand";
import { GEO_STEP_HOME, geoDestinationPath } from "./geoTabs";

/**
 * The band above every tab says the same things as the rail on 总览 used to — which step waits on the reader, which cannot go on
 * for want of a market, which an allowance refused — and one thing more: where each step's result is read, and 「现在」.
 */
const href = (step: keyof typeof GEO_STEP_HOME) => geoDestinationPath("geo_1", GEO_STEP_HOME[step]);
const project = (steps: Parameters<typeof geoProject>[0] = {}, overrides: Partial<GeoProject> = {}) => geoProject(steps, overrides);

describe("the steps in the band", () => {
  it("is the eight steps, in the programme's order, each with the address of its result", () => {
    const steps = bandSteps(project(), href);
    expect(steps.map((step) => step.id)).toEqual(["evidence", "journey", "questions", "diagnosis", "sources", "content", "distribution", "monitoring"]);
    expect(steps.map((step) => step.label)).toEqual(["证据", "旅程", "问题", "诊断", "信源", "内容", "投放", "监测"]);
    expect(steps.find((step) => step.id === "journey")?.href).toBe("/app/geo/geo_1/questions?view=journey");
    expect(steps.find((step) => step.id === "diagnosis")?.href).toBe("/app/geo/geo_1/accuracy#geo-errors");
    expect(steps.find((step) => step.id === "monitoring")?.href).toBe("/app/geo/geo_1/visibility#geo-trend");
  });

  it("marks the budget as the step waiting on the reader, and says so in the step's own words", () => {
    const waiting = project({ sources: "done", distribution: "running" }, { budget: null });
    expect(bandSteps(waiting, href).find((step) => step.id === "distribution")).toMatchObject({ state: "waiting", summary: "待你确认预算" });
  });

  it("never asks for a budget while no media market is connected (G20)", () => {
    const off = project({ sources: "done", distribution: "running" }, { budget: null, market: { configured: false } });
    expect(bandSteps(off, href).find((step) => step.id === "distribution")).toMatchObject({ state: "todo", summary: "等媒介集市接通" });
  });

  it("marks a step the allowance would not start as waiting on the reader, and one that did start as under way", () => {
    const refused = project({ evidence: "queued", journey: "queued" });
    refused.steps.evidence = { status: "queued", requested: true, waiting: "simulated_allowance", note: "等模拟额度" };
    const rail = bandSteps(refused, href);
    expect(rail.find((step) => step.id === "evidence")).toMatchObject({ state: "waiting" });
    expect(rail.find((step) => step.id === "journey")).toMatchObject({ state: "active" });
    refused.steps.evidence = { status: "running", requested: true, waiting: "simulated_allowance" };
    expect(bandSteps(refused, href).find((step) => step.id === "evidence")).toMatchObject({ state: "active" });
  });

  it("stops calling it a wait once the budget is set", () => {
    const funded = project({ distribution: "running" }, { budget: { totalCny: 8000, dailyCny: 800 } });
    expect(bandSteps(funded, href).find((step) => step.id === "distribution")).toMatchObject({ state: "active" });
  });

  it("asks for nothing about a placement nobody asked for", () => {
    // The server sends every step; an untouched one is { status: "none", requested: false }.
    const untouched = project({ sources: "done" }, { budget: null });
    const steps = { ...untouched.steps, distribution: { status: "none" as const, requested: false, updatedAt: null } };
    const never = { ...untouched, steps, overview: { ...untouched.overview, steps } };
    expect(bandSteps(never, href).find((step) => step.id === "distribution")).toMatchObject({ state: "todo", summary: null });
  });

  it("still asks for the budget once placement has been requested, before it has started", () => {
    const asked = project({ sources: "done" }, { budget: null });
    const steps = { ...asked.steps, distribution: { status: "none" as const, requested: true, updatedAt: null } };
    const requested = { ...asked, steps, overview: { ...asked.overview, steps } };
    expect(bandSteps(requested, href).find((step) => step.id === "distribution")).toMatchObject({ state: "waiting", summary: "待你确认预算" });
  });

  it("draws a step that did not finish as needing attention, and one a single run only half did as partial", () => {
    const rail = bandSteps(project({ evidence: "failed", diagnosis: "minimal", sources: "done" }), href);
    expect(rail.find((step) => step.id === "evidence")?.state).toBe("attention");
    expect(rail.find((step) => step.id === "diagnosis")?.state).toBe("partial");
    expect(rail.find((step) => step.id === "sources")?.state).toBe("done");
  });

  it("says what a step produced from the server's own count, else from its short note", () => {
    const counted = project({ evidence: "done", sources: "done" });
    counted.overview.steps.evidence = { status: "done", requested: true, summary: { text: "86 条结论", count: 86, unit: "claims" } };
    counted.overview.steps.sources = { status: "done", requested: true, note: "1,734 个" };
    const rail = bandSteps(counted, href);
    expect(rail.find((step) => step.id === "evidence")?.summary).toBe("86 条结论");
    expect(rail.find((step) => step.id === "sources")?.summary).toBe("1,734 个");
  });
});

describe("「现在」", () => {
  const NOW = new Date("2026-10-14T03:00:00.000Z");

  it("names the work the programme is doing, without a percentage", () => {
    const busy = project({ content: "running", distribution: "running", monitoring: "running" });
    expect(bandNow(busy, null, NOW)).toBe("正在写稿、投放");
  });

  it("says the next measurement with its weekday and day, and says a measurement under way as the round it is", () => {
    const quiet = project({ evidence: "done", diagnosis: "done" });
    expect(bandNow(quiet, { date: "2026-10-19", kind: "weekly" }, NOW)).toBe("下次复测 周一 10月19日");
    const measured = project({ diagnosis: "done" });
    measured.overview.steps.monitoring = { status: "done", requested: true, summary: { text: "2 轮测量", count: 2, unit: "rounds" } };
    expect(bandNow(measured, { date: "2026-10-14", kind: "weekly" }, NOW)).toBe("第 2 轮复测中");
    expect(bandNow(project(), { date: "2026-10-14", kind: "baseline" }, NOW)).toBe("基线测量中");
  });

  it("joins the work and the date, and says nothing at all when there is neither", () => {
    expect(bandNow(project({ content: "running" }), { date: "2026-10-19", kind: "weekly" }, NOW)).toBe("正在写稿 · 下次复测 周一 10月19日");
    expect(bandNow(project({ evidence: "done" }), null, NOW)).toBeNull();
  });

  it("does not call a step that waits on the allowance work", () => {
    const refused = project({ evidence: "queued" });
    refused.steps.evidence = { status: "queued", requested: true, waiting: "allowance" };
    expect(bandNow(refused, null, NOW)).toBeNull();
  });
});
