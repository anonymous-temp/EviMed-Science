import { describe, expect, it } from "vitest";
import type { GeoProject } from "@/lib/geoClient";
import { geoProject } from "./__fixtures__/geoTabs";
import { bandNow, bandSteps, geoActivity, geoStepView, measurementPause, nextMeasurement } from "./geoBand";
import { GEO_STEP_HOME, geoDestinationPath } from "./geoTabs";

/**
 * The band above every tab says the same things as the rail on 总览 used to — which step waits on the reader, which cannot go on
 * for want of a market, which an allowance refused — and one thing more: where each step's result is read, and 「现在」.
 */
const href = (step: keyof typeof GEO_STEP_HOME) => geoDestinationPath("geo_1", GEO_STEP_HOME[step]);
const project = (steps: Parameters<typeof geoProject>[0] = {}, overrides: Partial<GeoProject> = {}) => {
  const p=geoProject(steps, overrides);
  p.steps.monitoring={status:'none',requested:false,...p.steps.monitoring,automation:{state:'confirmed',actorId:'actor',at:'2026-10-01T00:00:00Z',engines:[...p.engines],coverageDays:p.coverageDays}};
  return p;
};

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

describe("the rail's words (one vocabulary: workStateLabel)", () => {
  const rail = (p: GeoProject) => Object.fromEntries(bandSteps(p, href).map((step) => [step.id, step]));

  it("says only the name of a step outside the requested work — no 未请求 anywhere — and 待开始 for a step the work will run first", () => {
    const writing = rail(project({ content: "running" }));
    expect(writing.journey).toMatchObject({ stateLabel: "", outside: true });
    expect(writing.diagnosis).toMatchObject({ stateLabel: "", outside: true });
    expect(writing.monitoring).toMatchObject({ stateLabel: "", outside: true });
    // The evidence step was not asked for and runs first, so it is inside the work and about to start.
    expect(writing.evidence).toMatchObject({ stateLabel: "待开始", state: "todo", outside: false });
    expect(writing.content).toMatchObject({ stateLabel: "进行中", outside: false });
    const words = bandSteps(project({ content: "running" }), href).map((step) => step.stateLabel ?? "").join("|");
    expect(words).not.toMatch(/未请求|未开始|还没开始/);
  });

  it("words a requested step by what it is: 排队中 / 进行中 / 已完成 / 简版已完成 / 未完成", () => {
    const steps = rail(project({ evidence: "done", journey: "minimal", questions: "failed", diagnosis: "queued", sources: "running" }));
    expect(steps.evidence.stateLabel).toBe("已完成");
    expect(steps.journey.stateLabel).toBe("简版已完成");
    expect(steps.questions.stateLabel).toBe("未完成");
    expect(steps.diagnosis.stateLabel).toBe("排队中");
    expect(steps.sources.stateLabel).toBe("进行中");
  });

  it("says what the reader owes when the step waits for them: the budget, the allowance, the agreement to monitor, the scope", () => {
    const budget = project({ sources: "done", distribution: "running" }, { budget: null });
    expect(rail(budget).distribution).toMatchObject({ state: "waiting", stateLabel: "等你设预算" });

    const allowance = project({ evidence: "queued" });
    allowance.steps.evidence = { status: "queued", requested: true, waiting: "allowance" };
    expect(rail(allowance).evidence).toMatchObject({ state: "waiting", stateLabel: "等你补额度" });

    const unagreed = project({ diagnosis: "done" });
    unagreed.steps.monitoring = { status: "none", requested: true };
    expect(rail(unagreed).monitoring).toMatchObject({ state: "waiting", stateLabel: "等你开启自动监测" });

    const legacy = project({ journey: "done" });
    legacy.steps.content = { status: "none", requested: true, requestOrigin: "legacy" };
    expect(rail(legacy).content).toMatchObject({ state: "waiting", stateLabel: "等你确认范围" });
  });

  it("never lets a word contradict its glyph: a waiting step is both 等你… and the waiting glyph", () => {
    const allowance = project({ evidence: "queued" });
    allowance.steps.evidence = { status: "queued", requested: true, waiting: "simulated_allowance" };
    const step = rail(allowance).evidence;
    expect(step.state).toBe("waiting");
    expect((step.stateLabel ?? "").startsWith("等你")).toBe(true);
    // A queued step that is not waiting on the reader keeps 排队中 and the active glyph.
    expect(rail(project({ evidence: "queued" })).evidence).toMatchObject({ state: "active", stateLabel: "排队中" });
  });

  it("does not wait on someone who said no to monitoring: the answer is given, and the step is outside what they want", () => {
    const declined = project({ diagnosis: "done" });
    declined.steps.monitoring = { status: "none", requested: true, automation: { state: "declined", actorId: "actor", at: "2026-10-01T00:00:00Z", engines: [...declined.engines], coverageDays: declined.coverageDays } };
    expect(rail(declined).monitoring).toMatchObject({ stateLabel: "", outside: true });
    expect(geoStepView(declined, "monitoring").waitingFor).toBeNull();
  });

  it("asks for no budget of a placement nobody asked for, and says nothing of it", () => {
    const quiet = rail(project({ sources: "done" }, { budget: null }));
    expect(quiet.distribution).toMatchObject({ stateLabel: "", outside: true });
  });
});

describe("「现在」", () => {
  const NOW = new Date("2026-10-14T03:00:00.000Z");

  it("names the work the programme is doing, without a percentage", () => {
    const busy = project({ content: "running", distribution: "running", monitoring: "running" });
    expect(bandNow(busy, null, NOW)).toBe("正在写稿、投放 · 复测进行中");
  });

  it("says the next measurement with its weekday and day, and says a measurement under way as the round it is", () => {
    const quiet = project({ evidence: "done", diagnosis: "done" });
    expect(bandNow(quiet, { date: "2026-10-19", kind: "weekly" }, NOW)).toBe("下次复测 周一 10月19日");
    const measured = project({ diagnosis: "done" });
    measured.overview.steps.monitoring = { ...measured.steps.monitoring, status: "done", requested: true, summary: { text: "2 轮测量", count: 2, unit: "rounds" } };
    expect(bandNow(measured, { date: "2026-10-14", kind: "weekly" }, NOW)).toBe("待复测 10月14日");
    expect(bandNow(project(), { date: "2026-10-14", kind: "baseline" }, NOW)).toBe("待复测 10月14日");
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

it("does not infer an active round or round identity from dates or historical counts", () => {
  const due = project({ monitoring: "queued" });
  expect(bandNow(due, { date: "2026-10-13", kind: "weekly" }, new Date("2026-10-14T03:00:00Z"))).toBe("复测排队中 · 待复测 10月13日");
  const running = project({ monitoring: "running" });
  running.overview.steps.monitoring = { status: "running", requested: true, summary: { text: "99 completed rounds", count: 99, unit: "rounds" } };
  expect(bandNow(running, null)).toBe("复测进行中");
  running.overview.steps.monitoring.status = "queued";
  running.overview.steps.monitoring.waiting = "allowance";
  expect(bandNow(running, null)).toBe("复测等你补额度");
});

describe("the strip for running work", () => {
  it("is the running step, with how many stand behind it and the run the stop would stop", () => {
    const busy = project({ evidence: "done", content: "running", distribution: "queued", monitoring: "queued" });
    busy.steps.content = { status: "running", requested: true, runId: "run_c", updatedAt: "2026-10-14T01:00:00Z" };
    expect(geoActivity(busy)).toEqual({ step: "content", runId: "run_c", label: "写稿", startedAt: "2026-10-14T01:00:00Z", queued: 2 });
  });

  it("is the first in line, with the sentence that says it starts by itself, when nothing runs yet", () => {
    expect(geoActivity(project({ evidence: "queued", journey: "queued" }))).toMatchObject({ step: "evidence", waiting: "轮到时会自动开始", queued: 1 });
  });

  it("is nothing for a step the allowance would not start (it is the reader's, on the rail and in the needs), for a paused project and for idle work", () => {
    const refused = project({ evidence: "queued" });
    refused.steps.evidence = { status: "queued", requested: true, waiting: "allowance" };
    expect(geoActivity(refused)).toBeNull();
    expect(geoActivity(project({ content: "running" }, { status: "paused" }))).toBeNull();
    expect(geoActivity(project({ evidence: "done", content: "failed" }))).toBeNull();
  });
});

describe("the measurement's own state", () => {
  const NOW = new Date("2026-10-25T03:00:00.000Z");
  const PAUSED = { state: "paused" as const, since: "2026-10-20T04:00:00.000Z", engines: ["doubao", "kimi"] };

  it("says a paused measurement with the day it stopped and what happens next, in plain words", () => {
    expect(measurementPause(PAUSED)).toEqual({
      paused: true, short: "AI 回答测量暂停中（10月20日起）", detail: "测量服务暂时不可用，产品依据和已有结果仍可查看",
      sentence: "AI 回答测量暂停中（10月20日起）：测量服务暂时不可用，产品依据和已有结果仍可查看。",
    });
    expect(measurementPause({ state: "paused", since: null, engines: [] })?.short).toBe("AI 回答测量暂停中");
  });

  it("names the engines that are paused while the rest are measured, and says nothing when none is", () => {
    expect(measurementPause({ state: "measuring", since: null, engines: ["doubao", "kimi", "kimi"] })?.short).toBe("豆包、Kimi 暂停测量");
    expect(measurementPause({ state: "measuring", since: null, engines: [] })).toBeNull();
    expect(measurementPause(undefined)).toBeNull();
  });

  it("promises no next round for a paused project or a paused measurement, whatever the read says", () => {
    const next = { date: "2026-10-26", kind: "weekly" };
    expect(nextMeasurement(project(), { next })).toEqual(next);
    expect(nextMeasurement(project({}, {status:"paused"}), { next })).toBeNull();
    expect(nextMeasurement(project(), { next, measurement: PAUSED })).toBeNull();
    expect(bandNow(project({ evidence: "done" }, { status: "paused" }), next, NOW)).toBeNull();
    expect(bandNow(project({ evidence: "done" }), next, NOW, PAUSED)).toBe("AI 回答测量暂停中（10月20日起）");
    expect(bandNow(project({ evidence: "done" }), next, NOW, { state: "measuring", since: null, engines: ["doubao"] })).toBe("豆包暂停测量 · 下次复测 周一 10月26日");
  });
});

it('retains an accepted queued measurement without authorization for future schedules',()=>{
  const p=geoProject({monitoring:'queued'});
  expect(nextMeasurement(p,{next:{date:'2026-11-01',kind:'baseline',source:'queued'}})?.date).toBe('2026-11-01');
  expect(nextMeasurement(p,{next:{date:'2026-11-01',kind:'weekly',source:'schedule'}})).toBeNull();
});
