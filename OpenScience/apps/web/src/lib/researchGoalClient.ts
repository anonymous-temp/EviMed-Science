import { productRequest } from "./productClient";

/**
 * What the control plane keeps for a long research goal between its rounds (a round that is running says so itself, in the run ledger):
 * `active` is between two rounds, `paused` was paused (`reason`: the person, a round limit without a new file, or the goal's spend limit),
 * `stopped` was stopped by the person, `finished` has nothing left to do, `waiting` has work left and asks for no round, and `interrupted`
 * lost its next round to the runtime or the provider (`reason` is then the code, or `stale`).
 */
export type ResearchGoalStatus = "active" | "paused" | "stopped" | "finished" | "waiting" | "interrupted";
export interface ResearchGoalState {
  sessionId: string;
  status: ResearchGoalStatus;
  reason: string | null;
  statusAt: string | null;
  goalId: string | null;
  progress: { processed: number; total: number } | null;
}
/** `available` is false where the deployment has no such service: the page then reads a goal by its rounds alone. */
export interface ResearchGoalList { available: boolean; goals: ResearchGoalState[] }

const query = (projectId: string) => `projectId=${encodeURIComponent(projectId)}`;

export function listResearchGoals(projectId: string) {
  return productRequest<ResearchGoalList>(`/research-goals?${query(projectId)}`);
}
export function pauseResearchGoal(projectId: string, sessionId: string) {
  return productRequest<{ sessionId: string; status: ResearchGoalStatus }>(`/research-goals/${encodeURIComponent(sessionId)}/pause?${query(projectId)}`, "POST");
}
/** Answers 409 `agent_run_active` while a round is running. */
export function resumeResearchGoal(projectId: string, sessionId: string) {
  return productRequest<{ sessionId: string; status: ResearchGoalStatus }>(`/research-goals/${encodeURIComponent(sessionId)}/resume?${query(projectId)}`, "POST");
}
