import { describe, expect, it } from "vitest";
import type { VcrActivity } from "@/lib/vcrClient";
import { ACTIVITY_POLL_MS, CONVERSATION_POLL_MS, isMoving, pollInterval, runCountsLine, runDetailLine, waitingSentence } from "./vcrActivity";

const idle: VcrActivity = { run: null, queue: [], jobs: [], last: null };

describe("what a run is doing, as one line", () => {
  it("names only what has happened", () => {
    expect(runCountsLine({ search: 6, included: 23, fullText: 0 })).toBe("检索 6 次 · 纳入 23 篇");
    expect(runCountsLine({})).toBe("");
  });

  it("never says the phase twice: the counts already begin with it", () => {
    expect(runDetailLine({ phase: "search", counts: { search: 1 } })).toBe("检索 1 次");
    expect(runDetailLine({ phase: "fulltext", counts: { search: 6, included: 4, fullText: 2 } })).toBe("检索 6 次 · 纳入 4 篇 · 全文 2 篇");
  });

  it("says the phase first when the counts do not begin with it", () => {
    expect(runDetailLine({ phase: "screen", counts: { search: 6, included: 3 } })).toBe("筛选 · 检索 6 次 · 纳入 3 篇");
    // 「已核对」 is inside a count, not the start of one: the phase is still said.
    expect(runDetailLine({ phase: "claims", counts: { search: 4, claims: 5, claimsVerified: 3 } })).toBe("核对 · 检索 4 次 · 结论 3/5 已核对");
  });

  it("says the phase alone before anything is counted, and nothing before the first labelled call", () => {
    expect(runDetailLine({ phase: "write", counts: {} })).toBe("撰写");
    expect(runDetailLine({ phase: null, counts: {} })).toBe("");
  });
});

describe("what a step in line waits for", () => {
  it("names the step, the run, the allowance or the engine", () => {
    expect(waitingSentence("evidence")).toBe("等“证据”做完");
    expect(waitingSentence("run")).toBe("等这次运行做完");
    expect(waitingSentence("allowance")).toBe("等研究额度");
    expect(waitingSentence(null, true)).toBe("等计算引擎恢复");
  });

  it("does not guess at a cause the server did not name", () => {
    expect(waitingSentence(null)).toBe("等待开始");
    expect(waitingSentence(undefined)).toBe("等待开始");
  });
});

describe("when the study is read again", () => {
  const study = (activity: VcrActivity | null, status: "active" | "draft" = "active") => ({ activity, status }) as Parameters<typeof pollInterval>[0];

  it("reads every few seconds while something moves, and not at all when nothing does", () => {
    expect(pollInterval(study({ ...idle, queue: [{ step: "evidence", waitingFor: null }] }), "overview")).toBe(ACTIVITY_POLL_MS);
    expect(pollInterval(study(null), "overview")).toBeNull();
  });

  it("does not poll for a job that waits for a person's confirmation", () => {
    const waiting: VcrActivity = { ...idle, jobs: [{ id: "j1", kind: "design_analytic", state: "awaiting_budget", step: "trial", done: null, total: null }] };
    expect(isMoving(waiting)).toBe(false);
    expect(pollInterval(study(waiting), "overview")).toBeNull();
  });

  it("reads a little slower for a conversation that is open or a study that is a draft", () => {
    expect(pollInterval(study(null), "chat")).toBe(CONVERSATION_POLL_MS);
    expect(pollInterval(study(null, "draft"), "overview")).toBe(CONVERSATION_POLL_MS);
  });
});
