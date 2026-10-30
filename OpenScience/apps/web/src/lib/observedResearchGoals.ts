import type { WebAgentRun } from "./apiClient";

/**
 * A long research goal as this project's run ledger shows it: the continuation rounds LoopX ran for it, newest first,
 * and the turn that set it when that turn is still listed. The latest round's state is that round's, not the goal's.
 */
export interface ObservedResearchGoal { key: string; sessionId: string; goalId: string; latest: WebAgentRun; rounds: WebAgentRun[]; anchor: WebAgentRun | null }
const sessionPattern = /^[A-Za-z0-9_-]{1,160}$/;
const goalPattern = /^[A-Za-z0-9_.:-]{1,256}$/;

export function observedResearchGoals(runs: readonly WebAgentRun[]): ObservedResearchGoal[] {
  const groups = new Map<string, ObservedResearchGoal>();
  for (const run of runs) {
    const reason = typeof run.effectiveRouteReason === "string" ? run.effectiveRouteReason : "";
    if (run.automated !== true || !(reason === "loopx-continuation" || reason.endsWith(":loopx-continuation"))) continue;
    if (!run.goal || typeof run.goal.id !== "string" || typeof run.sessionId !== "string" || typeof run.id !== "string" || !goalPattern.test(run.goal.id) || !sessionPattern.test(run.sessionId) || !sessionPattern.test(run.id)) continue;
    if (!Number.isFinite(Date.parse(run.startedAt))) continue;
    const key = JSON.stringify([run.sessionId, run.goal.id]);
    const old = groups.get(key);
    const rounds = [...(old?.rounds ?? []), run];
    const latest = !old || Date.parse(run.startedAt) > Date.parse(old.latest.startedAt) ? run : old.latest;
    groups.set(key, { key, sessionId: run.sessionId, goalId: run.goal.id, latest, rounds, anchor: null });
  }
  for (const goal of groups.values()) {
    goal.rounds.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const anchorId = goal.rounds.map(round => round.goal?.runId).find((id): id is string => typeof id === "string" && sessionPattern.test(id));
    goal.anchor = anchorId ? runs.find(run => run.id === anchorId && run.sessionId === goal.sessionId) ?? null : null;
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.latest.startedAt) - Date.parse(a.latest.startedAt));
}

/** The words a goal is listed under: what the person asked when it was set, else the latest round's title. */
export function goalTitle(goal: ObservedResearchGoal): string {
  const asked = goal.anchor?.question?.replace(/^\/loopx\s*/i, "").trim();
  return asked || goal.anchor?.title?.trim() || goal.latest.title?.trim() || goal.latest.question?.replace(/^\/loopx\s*/i, "").trim() || "长期研究";
}
