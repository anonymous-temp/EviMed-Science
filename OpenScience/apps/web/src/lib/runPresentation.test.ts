import { describe, expect, it } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { relativeTime, runDidNotDeliver, runMetaLine, runQuestion, runState, runTitle, summarizeQualityNotices, undeliveredFiles, webRunOutcome } from "./runPresentation";

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
    expect(runState(run({ status: "running" }))).toEqual({ key: "running", label: "运行中" });
    expect(runState(run({ status: "succeeded" }))).toEqual({ key: "done", label: "已交付" });
    expect(runState(run({ status: "succeeded", verification: "unverified" } as Partial<WebAgentRun>)).key).toBe("review");
    expect(runState(run({ status: "succeeded", phase: "degraded" } as Partial<WebAgentRun>)).key).toBe("review");
    expect(runState(run({ status: "failed", errorCode: "runtime_stalled" }))).toEqual({ key: "failed", label: "未完成" });
    expect(runState(run({ status: "canceled" }))).toEqual({ key: "canceled", label: "已取消" });
  });

  it("dates a row by when it ended and says how it came out on the second line", () => {
    const now = Date.parse("2026-09-18T10:00:00Z");
    const finished = run({ startedAt: "2026-09-18T09:00:00Z", finishedAt: "2026-09-18T09:50:00Z", verification: "unverified" } as Partial<WebAgentRun>);
    expect(runMetaLine(finished, now)).toBe("10 分钟前 · 已交付，待复核");
    expect(relativeTime(now - 30_000, now)).toBe("刚刚");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
    expect(relativeTime(0, now)).toBe("");
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

  it("tells an absent list of refused files apart from an empty one", () => {
    expect(undeliveredFiles(run())).toBeNull();
    expect(undeliveredFiles(run({ unverifiedArtifacts: [] } as Partial<WebAgentRun>))).toEqual([]);
    expect(undeliveredFiles(run({ unverifiedArtifacts: ["deliverables/report.md", "", 3] } as unknown as Partial<WebAgentRun>))).toEqual(["deliverables/report.md"]);
  });
});

describe("the gate's notices, grouped", () => {
  it("leads with what must be fixed and admits every notice in its counts", () => {
    const summary = summarizeQualityNotices([
      "claims[0].claim numeric fact 10 is not present in its direct support.",
      "MUST FIX — Reading retrieved evidence was delegated to a child that restated it.",
      "citation-ledger.csv row 3 has no DOI.",
      "Something the table does not know about.",
    ]);
    expect(summary.total).toBe(4);
    expect(summary.mustFix).toBe(1);
    expect(summary.advisory).toBe(3);
    expect(summary.groups[0]).toMatchObject({ mustFix: true, label: "检索到的原文由子任务转述" });
    expect(summary.groups[0].items[0]).not.toMatch(/^MUST FIX/);
    expect(summary.groups.map((group) => group.label)).toEqual(expect.arrayContaining(["证据矩阵主张", "引文台账与参考文献", "其他核验提示"]));
  });

  it("puts a clinical-safety finding ahead of everything and counts it apart", () => {
    const summary = summarizeQualityNotices([
      "MUST FIX — claims[2].supportQuote was not found in its preserved source artifact.",
      "SAFETY — 临床实践要点第 12 行把呼叫急救的条件写成了服药后是否缓解。",
      "Report line 9 numeric facts 12 have no evidence-matrix claim reference.",
    ]);
    expect(summary).toMatchObject({ total: 3, mustFix: 2, safety: 1, advisory: 1 });
    expect(summary.groups.map((group) => [group.label, group.safety, group.mustFix])).toEqual([
      ["临床安全", true, true],
      ["证据矩阵主张", false, true],
      ["数字未标注其来源主张", false, false],
    ]);
    expect(summary.groups[0].items[0]).toBe("临床实践要点第 12 行把呼叫急救的条件写成了服药后是否缓解。");
  });
});
