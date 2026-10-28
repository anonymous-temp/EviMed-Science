import type { WebAgentRun } from "./apiClient";

/** A continuation observed in this project's run ledger; it does not prove the goal's current lifecycle state. */
export interface ObservedResearchGoal { key: string; sessionId: string; goalId: string; latest: WebAgentRun }
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
    if (!old || Date.parse(run.startedAt) > Date.parse(old.latest.startedAt)) groups.set(key, { key, sessionId: run.sessionId, goalId: run.goal.id, latest: run });
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.latest.startedAt) - Date.parse(a.latest.startedAt));
}
