import { describe, expect, it } from "vitest";
import type { WebAgentRun } from "./apiClient";
import { goalTitle, observedResearchGoals } from "./observedResearchGoals";
const run = (id: string, sessionId: string, goalId: string, startedAt: string, extra: Record<string, unknown> = {}) => ({ id, sessionId, goal: { id: goalId, runId: null }, automated: true, effectiveRouteReason: "adopted:runtime-ui:loopx-continuation", startedAt, ...extra }) as unknown as WebAgentRun;
describe("observed research goals", () => {
  it("makes goals only of verified continuation records, grouped by session and goal", () => {
    const runs = [run("a", "s1", "g1", "2026-10-28T01:00:00Z"), run("b", "s1", "g1", "2026-10-28T02:00:00Z"), run("c", "s2", "g1", "2026-10-28T03:00:00Z"), run("d", "s1", "g2", "2026-10-28T04:00:00Z"), run("e", "s1", "g3", "2026-10-28T05:00:00Z", { automated: false }), run("f", "bad/session", "g4", "2026-10-28T06:00:00Z"), run("g", "s1", "g5", "2026-10-28T07:00:00Z", { effectiveRouteReason: "ordinary" }), run("h", "s1", "g6", "2026-10-28T08:00:00Z", { goal: {} }), run("i", "s1", "g7", "2026-10-28T09:00:00Z", { automated: "true" }), run("j", "s1", "g8", "2026-10-28T10:00:00Z", { effectiveRouteReason: 42 })];
    // Records that do not verify make no goal of their own; the turns of a session that has one belong to its newest goal from where it began.
    const goals = observedResearchGoals(runs);
    expect(goals.map(item => [item.sessionId, item.goalId])).toEqual([["s1", "g2"], ["s2", "g1"], ["s1", "g1"]]);
    expect(goals.map(item => item.rounds.map(round => round.id))).toEqual([["j", "i", "h", "g", "e", "d"], ["c"], ["b", "a"]]);
    expect(goals.some(item => item.rounds.some(round => round.id === "f"))).toBe(false);
  });
  it("takes any other turn of a goal's conversation for a round of it, so the goal is running while it runs", () => {
    const anchor = { id: "start", sessionId: "s1", effectiveRouteReason: "research-goal", question: "评估队列的再入院风险", status: "succeeded", startedAt: "2026-11-03T00:00:00Z" } as unknown as WebAgentRun;
    const round = run("a", "s1", "g1", "2026-11-03T01:00:00Z", { goal: { id: "g1", runId: "start" }, status: "succeeded" });
    const turn = (id: string, startedAt: string, extra: Record<string, unknown> = {}) => ({ id, sessionId: "s1", startedAt, status: "succeeded", ...extra }) as unknown as WebAgentRun;
    const said = turn("said", "2026-11-03T02:00:00Z", { question: "先看一下亚组", effectiveRouteReason: "unrouted:open-domain" });
    const resumed = turn("resumed", "2026-11-03T03:00:00Z", { automated: true, effectiveRouteReason: "research-goal-resume" });
    const retried = turn("retried", "2026-11-03T04:00:00Z", { automated: true, effectiveRouteReason: "adopted:runtime-ui:research-goal-retry", status: "running" });
    const [goal, ...others] = observedResearchGoals([retried, resumed, said, round, anchor]);
    expect(others).toEqual([]);
    expect(goal.rounds.map(item => item.id)).toEqual(["retried", "resumed", "said", "a", "start"]);
    expect(goal.latest.id).toBe("retried");
    expect(goal.latest.status).toBe("running");
    expect(goal.anchor?.id).toBe("start");
    expect(goalTitle(goal)).toBe("评估队列的再入院风险");
  });
  it("leaves out a session with no goal, another session's turns, and a turn from before the goal was set", () => {
    const anchor = { id: "start", sessionId: "s1", effectiveRouteReason: "research-goal", question: "目标", status: "succeeded", startedAt: "2026-11-03T05:00:00Z" } as unknown as WebAgentRun;
    const before = { id: "before", sessionId: "s1", question: "先聊聊", status: "succeeded", startedAt: "2026-11-03T04:00:00Z" } as unknown as WebAgentRun;
    const elsewhere = { id: "elsewhere", sessionId: "s2", question: "别的对话", status: "succeeded", startedAt: "2026-11-03T06:00:00Z" } as unknown as WebAgentRun;
    const malformed = { id: "bad id", sessionId: "s1", question: "x", status: "succeeded", startedAt: "2026-11-03T06:00:00Z" } as unknown as WebAgentRun;
    const [goal, ...others] = observedResearchGoals([anchor, before, elsewhere, malformed]);
    expect(others).toEqual([]);
    expect(goal.rounds.map(item => item.id)).toEqual(["start"]);
    expect(observedResearchGoals([before, elsewhere])).toEqual([]);
  });
  it("gives a turn to the goal of its session that began last before it", () => {
    const first = { id: "first", sessionId: "s1", effectiveRouteReason: "research-goal", question: "第一个目标", status: "succeeded", startedAt: "2026-11-03T01:00:00Z" } as unknown as WebAgentRun;
    const second = { id: "second", sessionId: "s1", effectiveRouteReason: "research-goal", question: "第二个目标", status: "succeeded", startedAt: "2026-11-03T03:00:00Z" } as unknown as WebAgentRun;
    const between = { id: "between", sessionId: "s1", question: "x", status: "succeeded", startedAt: "2026-11-03T02:00:00Z" } as unknown as WebAgentRun;
    const after = { id: "after", sessionId: "s1", question: "y", status: "succeeded", startedAt: "2026-11-03T04:00:00Z" } as unknown as WebAgentRun;
    const goals = observedResearchGoals([first, second, between, after]);
    expect(goals.map(item => [goalTitle(item), item.rounds.map(round => round.id)])).toEqual([["第二个目标", ["after", "second"]], ["第一个目标", ["between", "first"]]]);
  });
  it("keeps every round newest first and names the goal by what was asked when it was set", () => {
    const anchor = { id: "start", sessionId: "s1", question: "/loopx 评估队列的再入院风险", startedAt: "2026-10-28T00:00:00Z" } as unknown as WebAgentRun;
    const elsewhere = { id: "start", sessionId: "s9", question: "/loopx 别的对话", startedAt: "2026-10-28T00:00:00Z" } as unknown as WebAgentRun;
    const rounds = [run("a", "s1", "g1", "2026-10-28T01:00:00Z", { goal: { id: "g1", runId: "start" } }), run("b", "s1", "g1", "2026-10-28T02:00:00Z", { goal: { id: "g1", runId: "start" } })];
    const [goal] = observedResearchGoals([elsewhere, ...rounds, anchor]);
    expect(goal.rounds.map(item => item.id)).toEqual(["b", "a", "start"]);
    expect(goal.anchor?.sessionId).toBe("s1");
    expect(goalTitle(goal)).toBe("评估队列的再入院风险");
    const [untitled] = observedResearchGoals([run("c", "s2", "g2", "2026-10-28T03:00:00Z")]);
    expect(goalTitle(untitled)).toBe("长期研究");
  });
  it("lists a goal from the turn that set it, and keeps its address when the first continuation arrives", () => {
    const started = { id: "start", sessionId: "s1", effectiveRouteReason: "research-goal", question: "评估队列的再入院风险", status: "running", startedAt: "2026-10-28T00:00:00Z" } as unknown as WebAgentRun;
    const [alone] = observedResearchGoals([started]);
    expect(alone.latest.id).toBe("start");
    expect(goalTitle(alone)).toBe("评估队列的再入院风险");
    const round = run("a", "s1", "g1", "2026-10-28T01:00:00Z", { goal: { id: "g1", runId: "start" } });
    const [later] = observedResearchGoals([round, { ...started, status: "succeeded" } as unknown as WebAgentRun]);
    expect(later.key).toBe(alone.key);
    expect(later.goalId).toBe("g1");
    expect(later.rounds.map(item => item.id)).toEqual(["a", "start"]);
  });
  it("does not take an ordinary question, or a question answered by an automatic turn, for a goal", () => {
    const asked = { id: "q", sessionId: "s1", effectiveRouteReason: "unrouted:open-domain", question: "这个队列有多少人", startedAt: "2026-10-28T00:00:00Z" } as unknown as WebAgentRun;
    const automatic = { id: "r", sessionId: "s1", automated: true, effectiveRouteReason: "research-goal", question: "x", startedAt: "2026-10-28T00:00:00Z" } as unknown as WebAgentRun;
    expect(observedResearchGoals([asked, automatic])).toEqual([]);
  });
});
