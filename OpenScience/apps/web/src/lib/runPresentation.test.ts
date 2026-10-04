import { describe, expect, it } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { compactTime, relativeTime, runDidNotDeliver, runMetaLine, runQuestion, runState, runTitle, undeliveredFiles, webRunOutcome } from "./runPresentation";

// The run ledger's presentation had no direct test (2026-09-16 review, D5):
// every page that shows a run reads its title, its dot and its outcome here.
const run = (overrides: Partial<WebAgentRun> = {}): WebAgentRun => ({
  id: "run_c657a9e0",
  sessionId: "session-1",
  status: "succeeded",
  errorCode: null,
  question: null,
  agentId: null,
  effectiveAgentId: null,
  artifacts: [],
  qualityNotices: [],
  ...overrides,
} as unknown as WebAgentRun);

describe("what a run is called", () => {
  it("is its question, else its capability's name, and never its id", () => {
    expect(runTitle(run({ question: "  SGLT2 抑制剂的长期肾脏获益？ " }))).toBe("SGLT2 抑制剂的长期肾脏获益？");
    expect(runTitle(run({ effectiveAgentId: "some-unnamed-capability" }))).toBe("some-unnamed-capability");
    const untitled = runTitle(run());
    expect(untitled).toBe("未记录题面的运行");
    expect(untitled).not.toContain("run_");
  });

  it("prefers the ledger's title, which a researcher may have set by hand", () => {
    expect(runTitle(run({ title: "≥70 岁阿司匹林一级预防", titleSource: "user", question: "别的题面" }))).toBe("≥70 岁阿司匹林一级预防");
  });

  // Every capability-card run began with the same twenty characters, so a
  // truncated row of any of them showed nothing but the template.
  it("drops the capability-card preamble from the question it titles with", () => {
    const templated = run({ question: "请以「临床证据深度分析」能力完成以下任务：≥70 岁人群阿司匹林一级预防的获益与出血风险" });
    expect(runQuestion(templated)).toBe("≥70 岁人群阿司匹林一级预防的获益与出血风险");
    expect(runTitle(templated)).toBe("≥70 岁人群阿司匹林一级预防的获益与出血风险");
    // A question that only happens to mention the phrase keeps it.
    expect(runQuestion(run({ question: "为什么要请以「X」能力完成以下任务？" }))).toBe("为什么要请以「X」能力完成以下任务？");
  });
});

describe("the state a run is shown in", () => {
  it("separates a clean delivery from one that still needs a person, in words as well as colour", () => {
    expect(runState(run({ status: "running" }))).toEqual({ key: "running", label: "进行中" });
    expect(runState(run({ status: "succeeded" }))).toEqual({ key: "done", label: "已完成" });
    expect(runState(run({ status: "succeeded", verification: "unverified" } as Partial<WebAgentRun>)).key).toBe("review");
    expect(runState(run({ status: "succeeded", phase: "degraded" } as Partial<WebAgentRun>)).key).toBe("review");
    expect(runState(run({ status: "failed", errorCode: "runtime_stalled" }))).toEqual({ key: "failed", label: "未完成" });
    expect(runState(run({ status: "canceled" }))).toEqual({ key: "canceled", label: "已停止" });
  });

  it("dates a row by when it ended and says how it came out on the second line", () => {
    const now = Date.parse("2026-09-18T10:00:00Z");
    const finished = run({ startedAt: "2026-09-18T09:00:00Z", finishedAt: "2026-09-18T09:50:00Z", verification: "unverified" } as Partial<WebAgentRun>);
    // One word per state, the inbox's words (2026-09-23 plan §5.8).
    expect(runMetaLine(finished, now)).toBe("10 分钟前 · 待核对");
    expect(relativeTime(now - 30_000, now)).toBe("刚刚");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
    expect(relativeTime(0, now)).toBe("");
    // Older than a day: the spec's date forms, never Intl's 9/20 or 2025/9/20.
    const today = new Date(now);
    const earlier = new Date(today.getFullYear(), 0, 2, 9, 0).getTime();
    if (now - earlier > 86_400_000) expect(relativeTime(earlier, now)).toBe("1月2日");
    expect(relativeTime(new Date(2020, 8, 20, 9, 0).getTime(), now)).toBe("2020-09-20");
    expect(compactTime(new Date(2020, 8, 20, 9, 0).getTime(), now)).toBe("2020-09-20");
  });
});

describe("what happened to a run", () => {
  it("names a cancel even when the record carries no code, and keeps the raw code out of the headline", () => {
    const canceled = webRunOutcome(run({ status: "canceled" }));
    expect(canceled.code).toBeNull();
    expect(canceled.headline).not.toMatch(/runtime_canceled/);
    expect(canceled.headline.length).toBeGreaterThan(0);
    const failed = webRunOutcome(run({ status: "failed", errorCode: "specialist_evidence_repair_failed", observedToolCalls: 42 } as Partial<WebAgentRun>));
    expect(failed.code).toBe("specialist_evidence_repair_failed");
    expect(failed.headline).not.toMatch(/specialist_evidence/);
    expect(failed.detail).toBe("结束前已完成 42 次检索与工具调用。");
  });

  it("owes an explanation only once it has finished without delivering", () => {
    expect(runDidNotDeliver(run({ status: "running" }))).toBe(false);
    expect(runDidNotDeliver(run({ status: "succeeded" }))).toBe(false);
    expect(runDidNotDeliver(run({ status: "failed", errorCode: "specialist_evidence_repair_failed" }))).toBe(true);
  });

  // 2026-10-04: a delivery receipt labels a result and never refuses one. What
  // the ledger now records for the three situations that used to end `failed`
  // — files with no receipt, files that moved after it, an answer whose
  // runtime stopped — is a finished run with a reservation on it, and it reads
  // as a result to open, not as 未完成.
  it("reads a delivery the receipt could not vouch for as a result with a label, not as a failure", () => {
    for (const verification of ["unverified", "unchecked"] as const) {
      const delivered = run({ status: "succeeded", errorCode: null, verification, artifacts: ["deliverables/d1/clinical-evidence-report.md"] } as Partial<WebAgentRun>);
      expect(runDidNotDeliver(delivered)).toBe(false);
      expect(runState(delivered)).toEqual({ key: "review", label: "待核对" });
      expect(webRunOutcome(delivered).kind).toBe("qualified");
    }
    // Nothing on disk, or a turn that had not finished, is still a run that did not deliver.
    for (const errorCode of ["specialist_required_output_missing", "runtime_stopped"]) {
      const failed = run({ status: "failed", errorCode });
      expect(runDidNotDeliver(failed)).toBe(true);
      expect(runState(failed)).toEqual({ key: "failed", label: "未完成" });
    }
  });

  // 2026-10-04: a tool the run got past is a notice on the run, never its
  // verdict. A delivered run that carries those notices is read in the same
  // words as one that carries none, and a run recorded before then as ending on
  // a tool is still explained by name.
  it("reads a delivered run that carries notices about its tools as a result, not as a failure", () => {
    const notices = [
      { code: "run_tool_unavailable", severity: "advice", title: "调用了本次运行没有的工具", detail: "这次运行没有提供「读网页」，它被调用了 1 次，这一步没有执行；成果照常交付，涉及它的部分请留意是否完整。", text: "Research tool web_read is not mounted in this session: 1 call(s) answered unknown tool." },
      { code: "review_unavailable", severity: "advice", title: "复核服务暂不可用", detail: "独立复核这次没有做成；它只给建议，交付结果不受影响。", text: "The advisory tool evimed_review_run answered review_unavailable 1 time(s) and no later call of it succeeded." },
    ];
    const delivered = run({ status: "succeeded", errorCode: null, verification: null, artifacts: ["deliverables/osimertinib-cardiac-adr/safety-report.md"], qualityNotices: notices } as Partial<WebAgentRun>);
    expect(runDidNotDeliver(delivered)).toBe(false);
    expect(runState(delivered)).toEqual({ key: "done", label: "已完成" });
    expect(webRunOutcome(delivered).kind).toBe("delivered");
    expect(runMetaLine({ ...delivered, finishedAt: "2026-10-04T07:10:00Z" } as WebAgentRun, Date.parse("2026-10-04T07:20:00Z"))).toBe("10 分钟前 · 已完成");

    const earlier = run({ status: "failed", errorCode: "runtime_tool_error" });
    expect(runState(earlier)).toEqual({ key: "failed", label: "未完成" });
    expect(webRunOutcome(earlier).headline).toMatch(/工具调用/);
  });

  it("tells an absent list of refused files apart from an empty one", () => {
    expect(undeliveredFiles(run())).toBeNull();
    expect(undeliveredFiles(run({ unverifiedArtifacts: [] } as Partial<WebAgentRun>))).toEqual([]);
    expect(undeliveredFiles(run({ unverifiedArtifacts: ["deliverables/report.md", "", 3] } as unknown as Partial<WebAgentRun>))).toEqual(["deliverables/report.md"]);
  });
});
