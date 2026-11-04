import type { WebAgentRun } from "./apiClient";

/**
 * A long research goal as this project's run ledger shows it: the turn that set it, the continuation rounds that ran for it and every
 * other turn of its conversation since (a person's message between two rounds, a turn the control plane started to take it up again),
 * newest first. The latest round's state is that round's, not the goal's: the goal's own state is the control plane's
 * (`researchGoalClient`), and nothing here knows whether more rounds are to come.
 */
export interface ObservedResearchGoal { key: string; sessionId: string; goalId: string | null; latest: WebAgentRun; rounds: WebAgentRun[]; anchor: WebAgentRun | null }
const sessionPattern = /^[A-Za-z0-9_-]{1,160}$/;
const goalPattern = /^[A-Za-z0-9_.:-]{1,256}$/;

const routeOf = (run: WebAgentRun) => (typeof run.effectiveRouteReason === "string" ? run.effectiveRouteReason : "");
const listable = (run: WebAgentRun) => typeof run.sessionId === "string" && typeof run.id === "string" && sessionPattern.test(run.sessionId) && sessionPattern.test(run.id) && Number.isFinite(Date.parse(run.startedAt));

/** The turn that set a goal: 「发起研究」 records its route, and a goal typed in a conversation starts with the command. */
function setsGoal(run: WebAgentRun): boolean {
  if (run.automated === true) return false;
  const route = routeOf(run);
  return route === "research-goal" || route.endsWith(":research-goal") || /^\/loopx(\s|$)/i.test(run.question?.trim() ?? "");
}

/** A goal's address for as long as it lives: by the turn that set it, so a goal keeps its place when its first continuation arrives. */
export function goalKey(sessionId: string, anchorOrGoal: string): string { return JSON.stringify([sessionId, anchorOrGoal]); }

export function observedResearchGoals(runs: readonly WebAgentRun[]): ObservedResearchGoal[] {
  const groups = new Map<string, ObservedResearchGoal>();
  const add = (key: string, run: WebAgentRun, goalId: string | null) => {
    const old = groups.get(key);
    groups.set(key, { key, sessionId: run.sessionId as string, goalId: goalId ?? old?.goalId ?? null, rounds: [...(old?.rounds ?? []), run], latest: run, anchor: old?.anchor ?? null });
  };
  for (const run of runs) {
    const reason = routeOf(run);
    if (run.automated !== true || !(reason === "loopx-continuation" || reason.endsWith(":loopx-continuation"))) continue;
    if (!listable(run) || !run.goal || typeof run.goal.id !== "string" || !goalPattern.test(run.goal.id)) continue;
    const anchorId = typeof run.goal.runId === "string" && sessionPattern.test(run.goal.runId) ? run.goal.runId : null;
    add(goalKey(run.sessionId as string, anchorId ?? run.goal.id), run, run.goal.id);
  }
  // The turn that set the goal is its first round: the goal is listed, and watched, from its first second.
  for (const run of runs) {
    if (!listable(run)) continue;
    const key = goalKey(run.sessionId as string, run.id);
    if (setsGoal(run) || groups.has(key)) add(key, run, null);
    const group = groups.get(key);
    if (group) group.anchor = run;
  }
  // Any other turn in a goal's conversation is a round of it: it does the goal's work, and while it runs the goal is running. It belongs to
  // the goal of its session whose beginning is the latest one before it; a conversation with no goal has none.
  const taken = new Set([...groups.values()].flatMap(goal => goal.rounds.map(round => round.id)));
  const beginning = (goal: ObservedResearchGoal) => (goal.anchor ? Date.parse(goal.anchor.startedAt) : Math.min(...goal.rounds.map(round => Date.parse(round.startedAt))));
  for (const run of runs) {
    if (!listable(run) || taken.has(run.id)) continue;
    const at = Date.parse(run.startedAt);
    const owner = [...groups.values()].filter(goal => goal.sessionId === run.sessionId && beginning(goal) <= at).sort((a, b) => beginning(b) - beginning(a))[0];
    if (owner) { owner.rounds.push(run); taken.add(run.id); }
  }
  for (const goal of groups.values()) {
    goal.rounds.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    goal.latest = goal.rounds[0];
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.latest.startedAt) - Date.parse(a.latest.startedAt));
}

/** The words a goal is listed under: what the person asked when it was set, else the latest round's title. */
export function goalTitle(goal: ObservedResearchGoal): string {
  const asked = goal.anchor?.question?.replace(/^\/loopx\s*/i, "").trim();
  return asked || goal.anchor?.title?.trim() || goal.latest.title?.trim() || goal.latest.question?.replace(/^\/loopx\s*/i, "").trim() || "长期研究";
}
