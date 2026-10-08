import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgendaRecord, EpisodeRecord } from "@/lib/autopilotClient";
import { budgetBlocks, executionLabel, executionsOf, inLingdou, lingdou, RUN_STATES, rowLine, runState, scheduleLine, taskGroupOf, whenText } from "./taskPresentation";

// Thursday 1 October 2026, 10:00 in Beijing.
const NOW = new Date("2026-10-01T02:00:00Z");
const viewer = vi.hoisted(() => ({ zone: "Asia/Shanghai" }));

const agenda = (payload: Record<string, unknown> = {}): AgendaRecord => ({ id: "agenda-1", projectId: "p", revision: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", deletedAt: null, payload: {
  title: "任务", prompt: "跟进", topics: [], taskTypes: ["literature-sentinel"], dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 7, timeZone: "Asia/Shanghai",
  schedule: { kind: "weekly", timeZone: "Asia/Shanghai", time: "09:00", weekdays: [5] }, nextRunAt: "2026-10-02T01:00:00Z", scheduleState: "scheduled", enabled: true, status: "active", pauseReason: null, outcomes: [], ...payload } } as AgendaRecord);
const episode = (id: string, payload: Record<string, unknown> = {}): EpisodeRecord => ({ id, projectId: "p", revision: 1, createdAt: "", updatedAt: "", deletedAt: null, payload: {
  agendaId: "agenda-1", taskType: "literature-sentinel", date: "2026-09-29", status: "merged", runId: null, budgetCny: 8, createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z", ...payload } } as EpisodeRecord);

describe("how a task says when", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) { return { ...resolved.call(this), timeZone: viewer.zone }; });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); viewer.zone = "Asia/Shanghai"; });

  it("says today, tomorrow, the weekday within the week, and the date after it: by the task's own day", () => {
    expect(whenText("2026-10-01T09:00:00Z", "Asia/Shanghai", NOW)).toBe("今天 17:00");
    expect(whenText("2026-10-01T16:30:00Z", "Asia/Shanghai", NOW)).toBe("明天 00:30");
    expect(whenText("2026-10-02T01:00:00Z", "Asia/Shanghai", NOW)).toBe("明天 09:00");
    expect(whenText("2026-10-03T01:00:00Z", "Asia/Shanghai", NOW)).toBe("周六 09:00");
    expect(whenText("2026-10-07T01:00:00Z", "Asia/Shanghai", NOW)).toBe("周三 09:00");
    expect(whenText("2026-10-08T01:00:00Z", "Asia/Shanghai", NOW)).toBe("10月8日 09:00");
    expect(whenText("2026-10-15T23:00:00Z", "Asia/Shanghai", NOW)).toBe("10月16日 07:00");
    expect(whenText(null, "Asia/Shanghai", NOW)).toBe("");
    expect(whenText("not a time", "Asia/Shanghai", NOW)).toBe("");
  });

  it("says a row by its name's one line: next time and how often, running, why it stopped, done", () => {
    expect(rowLine(agenda(), false, NOW)).toBe("下次 明天 09:00 · 每周");
    expect(rowLine(agenda({ schedule: { kind: "daily", timeZone: "Asia/Shanghai", time: "07:00" }, nextRunAt: "2026-10-01T23:00:00Z" }), false, NOW)).toBe("下次 明天 07:00 · 每天");
    expect(rowLine(agenda({ schedule: { kind: "once", timeZone: "Asia/Shanghai", time: "09:00", date: "2026-10-02" } }), false, NOW)).toBe("下次 明天 09:00 · 仅一次");
    expect(rowLine(agenda({ schedule: { kind: "weekly", timeZone: "Asia/Shanghai", time: "08:00", weekdays: [1] } }), true, NOW)).toBe("进行中 · 每周一 08:00");
    expect(rowLine(agenda({ nextRunAt: null }), false, NOW)).toBe("暂无下次运行 · 每周");
    expect(rowLine(agenda({ enabled: false, status: "paused", scheduleState: "paused", nextRunAt: null }), false, NOW)).toBe("已暂停");
    expect(rowLine(agenda({ enabled: false, status: "paused", scheduleState: "paused", nextRunAt: null, plannerStop: { kind: "needs_input", reason: "要监测的药品名单", at: "2026-10-01T00:00:00Z" } }), false, NOW)).toBe("需要你补充：要监测的药品名单");
    expect(rowLine(agenda({ scheduleState: "completed", nextRunAt: null, schedule: { kind: "once", timeZone: "Asia/Shanghai", time: "09:00", date: "2026-09-29" } }), false, NOW)).toBe("已完成 · 9月29日");
  });

  it("names a zone in a row only when it is not the reader's own", () => {
    viewer.zone = "America/New_York";
    expect(rowLine(agenda(), false, NOW)).toBe("下次 明天 09:00 中国标准时间 · 每周");
    expect(rowLine(agenda(), true, NOW)).toBe("进行中 · 每周五 09:00 中国标准时间");
    // Two names of one zone are one zone.
    viewer.zone = "Asia/Chongqing";
    expect(rowLine(agenda(), false, NOW)).toBe("下次 明天 09:00 · 每周");
  });

  it("always says the zone in the task bar's line, since a time without one is ambiguous", () => {
    expect(scheduleLine(agenda())).toBe("每周五 09:00 · 中国标准时间 · 下次 10月2日 09:00");
    viewer.zone = "America/New_York";
    expect(scheduleLine(agenda())).toBe("每周五 09:00 · 中国标准时间 · 下次 10月2日 09:00");
    expect(scheduleLine(agenda({ enabled: false, status: "paused", scheduleState: "paused", nextRunAt: null }))).toBe("每周五 09:00 · 中国标准时间");
  });

  it("groups a task as upcoming, paused or done: a finished one-time task is done and not paused", () => {
    expect(taskGroupOf(agenda())).toBe("upcoming");
    expect(taskGroupOf(agenda({ enabled: false, status: "paused", scheduleState: "paused" }))).toBe("paused");
    expect(taskGroupOf(agenda({ scheduleState: "completed" }))).toBe("completed");
  });

  it("counts executions from the first, and names one by its place and its day", () => {
    const list = executionsOf("agenda-1", [episode("c", { createdAt: "2026-10-01T01:00:00Z" }), episode("a", { createdAt: "2026-09-22T00:00:00Z" }), episode("x", { agendaId: "other" }), episode("b", { createdAt: "2026-09-30T00:00:00Z" })]);
    expect(list.map(item => item.id)).toEqual(["a", "b", "c"]);
    expect(executionLabel(list[2], 3, "Asia/Shanghai", NOW)).toBe("第 3 次 · 今天");
    expect(executionLabel(list[1], 2, "Asia/Shanghai", NOW)).toBe("第 2 次 · 昨天");
    expect(executionLabel(list[0], 1, "Asia/Shanghai", NOW)).toBe("第 1 次 · 9月22日");
  });
});

describe("what an execution is called", () => {
  it("calls the stage after a run the research it is, and never 核验", () => {
    expect(RUN_STATES.verifying).toBe("研究进行中");
    expect(runState(episode("v", { status: "verifying" }).payload)).toBe("研究进行中");
    expect(Object.values(RUN_STATES).join("")).not.toContain("核验");
    expect(runState(episode("q", { status: "queued" }).payload)).toBe("排队中");
  });
});

describe("amounts", () => {
  it("are in 灵豆, an estimate rounded and marked 约, a limit kept as it is", () => {
    expect(lingdou(100, { estimate: true })).toBe("约 100 灵豆");
    expect(lingdou(99.6, { estimate: true })).toBe("约 100 灵豆");
    expect(lingdou(3.5)).toBe("3.5 灵豆");
    expect(lingdou(8)).toBe("8 灵豆");
    expect(lingdou(0.1 + 0.2)).toBe("0.3 灵豆");
  });

  it("turn a registry sentence written in yuan into the same number of 灵豆", () => {
    expect(inLingdou("“单次上限”不能低于 ¥3.50：一次模型调用要先预留约 ¥1 才能发出")).toBe("“单次上限”不能低于 3.50 灵豆：一次模型调用要先预留约 1 灵豆 才能发出");
    expect(inLingdou("没有金额")).toBe("没有金额");
  });
});

describe("when a budget is the researcher's business again", () => {
  it("is only when it is what stopped the task", () => {
    expect(budgetBlocks(agenda(), null)).toBe(false);
    expect(budgetBlocks(agenda(), episode("e", { status: "failed", error: { code: "runtime_busy" } }))).toBe(false);
    expect(budgetBlocks(agenda({ maxEpisodeCny: 0.5 }), null)).toBe(true);
    expect(budgetBlocks(agenda({ pauseCode: "autopilot_weekly_budget_spent" }), null)).toBe(true);
    expect(budgetBlocks(agenda(), episode("e", { status: "failed", error: { code: "autopilot_daily_budget_spent" } }))).toBe(true);
    expect(budgetBlocks(agenda(), episode("e", { status: "merged", error: { code: "autopilot_daily_budget_spent" } }))).toBe(false);
  });
});
