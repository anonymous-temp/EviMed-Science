import { describe, expect, it } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import type { RunStreamEvent } from "@/lib/runEvents";
import {
  childrenLine,
  claimSummaryLine,
  currentPhaseLabel,
  foldRunEvents,
  parseRunProgress,
  progressCountsLine,
  runDeliverables,
} from "./runProgress";

const progress = {
  deliverables: [{ id: "d1", title: "报告", status: "submitted", attempts: 1 }],
  phaseCounts: { search: 3, screen: 0, fulltext: 2, claims: 5, write: 1, deliver: 0 },
  currentPhase: "write",
  sources: { searched: 40, included: 9, fullText: 2 },
  claims: { total: 12, verified: 10 },
  children: [{ childSessionId: "c1", state: "done", lastActivityAt: null }],
  startedAt: "2026-09-18T01:00:00Z",
  updatedAt: "2026-09-18T01:10:00Z",
};

const event = (type: string, data: Record<string, unknown>, seq = 1): RunStreamEvent => ({ seq, time: "", type, ...data });

const run = (overrides: Partial<WebAgentRun> = {}) => ({ id: "r", status: "running", artifacts: [], ...overrides } as unknown as WebAgentRun);

describe("a run's progress", () => {
  it("parses the aggregate defensively and says it as counts", () => {
    const parsed = parseRunProgress(progress);
    expect(parsed?.deliverables[0]).toMatchObject({ id: "d1", status: "submitted" });
    expect(progressCountsLine(parsed)).toBe("检索 3 次 · 纳入 9 篇 · 全文 2 篇 · 结论 10/12 已核对");
    expect(currentPhaseLabel(parsed)).toBe("正在撰写");
    expect(childrenLine(parsed)).toBe("子任务 1 个");
    expect(parseRunProgress({ phaseCounts: {} })).toBeNull();
    expect(parseRunProgress(null)).toBeNull();
    // A state the vocabulary does not have is read as planned, never invented.
    expect(parseRunProgress({ ...progress, deliverables: [{ id: "x", status: "exploded" }] })?.deliverables[0].status).toBe("planned");
  });

  it("says nothing for a run that made no labelled call", () => {
    const empty = parseRunProgress({ ...progress, phaseCounts: {}, sources: {}, claims: {}, currentPhase: null, children: [] });
    expect(progressCountsLine(empty)).toBe("");
    expect(currentPhaseLabel(empty)).toBeNull();
    expect(childrenLine(empty)).toBeNull();
  });

  it("follows the stream: the aggregate first, per-item frames until one arrives", () => {
    const record = run({ deliverables: [{ id: "d1", title: "报告", status: "planned", attempts: 0 }] });
    // Before any `run/progress`, a `deliverable/update` already moves the item.
    const early = foldRunEvents([event("deliverable/update", { id: "d1", title: "报告", status: "rejected", attempts: 2 })]);
    expect(runDeliverables(record, early)[0]).toMatchObject({ status: "rejected", attempts: 2 });
    // Then the aggregate wins.
    const later = foldRunEvents([
      event("deliverable/update", { id: "d1", status: "rejected" }, 1),
      event("run/progress", progress, 2),
      event("run/state", { state: "succeeded" }, 3),
    ]);
    expect(runDeliverables(record, later)[0].status).toBe("submitted");
    expect(later.state).toBe("succeeded");
  });

  it("falls back to the record, then to the old plan items", () => {
    expect(runDeliverables(run({ progress: progress as never }))[0].status).toBe("submitted");
    expect(runDeliverables(run({ planItems: [{ id: "p1", title: "旧计划", status: "queued", attempts: 0 }] }))[0])
      .toMatchObject({ id: "p1", status: "planned" });
    expect(runDeliverables(run())).toEqual([]);
  });

  it("says how many claims were checked", () => {
    expect(claimSummaryLine({ total: 72, verified: 68, unverified: 4 })).toBe("72 条结论，68 条引文已核对，4 条未核对");
    expect(claimSummaryLine({ total: 5, verified: 5, unverified: 0 })).toBe("5 条结论，引文全部已核对");
    expect(claimSummaryLine({ total: 0, verified: 0, unverified: 0 })).toBeNull();
    expect(claimSummaryLine(null)).toBeNull();
  });
});
