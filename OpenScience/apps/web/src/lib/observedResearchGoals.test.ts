import { describe, expect, it } from "vitest";
import type { WebAgentRun } from "./apiClient";
import { observedResearchGoals } from "./observedResearchGoals";
const run = (id: string, sessionId: string, goalId: string, startedAt: string, extra: Record<string, unknown> = {}) => ({ id, sessionId, goal: { id: goalId, runId: null }, automated: true, effectiveRouteReason: "adopted:runtime-ui:loopx-continuation", startedAt, ...extra }) as unknown as WebAgentRun;
describe("observed research goals", () => {
  it("groups only verified continuation records by session and goal", () => {
    const runs = [run("a", "s1", "g1", "2026-10-28T01:00:00Z"), run("b", "s1", "g1", "2026-10-28T02:00:00Z"), run("c", "s2", "g1", "2026-10-28T03:00:00Z"), run("d", "s1", "g2", "2026-10-28T04:00:00Z"), run("e", "s1", "g3", "2026-10-28T05:00:00Z", { automated: false }), run("f", "bad/session", "g4", "2026-10-28T06:00:00Z"), run("g", "s1", "g5", "2026-10-28T07:00:00Z", { effectiveRouteReason: "ordinary" }), run("h", "s1", "g6", "2026-10-28T08:00:00Z", { goal: {} }), run("i", "s1", "g7", "2026-10-28T09:00:00Z", { automated: "true" }), run("j", "s1", "g8", "2026-10-28T10:00:00Z", { effectiveRouteReason: 42 })];
    expect(observedResearchGoals(runs).map(item => item.latest.id)).toEqual(["d", "c", "b"]);
  });
});
