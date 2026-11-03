/**
 * What a long research goal's rounds say, read from the run ledger alone. Pure, so every rule here is tested without a kernel.
 *
 * LoopX owns a goal's lifecycle (`deps-version.json` `loopx.notes`); what it does not own is what happens around it: the kernel holds its
 * driver in memory, so a runtime that goes away takes the goal's next round with it and nobody starts it again, and a goal whose work is
 * done can keep asking for rounds. Measured on 2026-11-03 (`reports/主动科研实测与故障演练.md`): a control-plane restart or a dead container
 * left the goal silent until a person wrote to it, and 2 of 8 finished goals ran a round every 21 seconds saying there was nothing new.
 *
 * Everything decided here is a count, a status or a sum: never the words of a round.
 *
 * @module researchGoalState
 */

/** The states the control plane keeps for a goal between its rounds. A round that is running says so itself, in the ledger. */
export const GOAL_STATUSES = Object.freeze(["active", "paused", "stopped", "finished", "waiting", "interrupted"]);
/** Who or what paused a goal. */
export const GOAL_PAUSE_REASONS = Object.freeze(["person", "no_progress", "budget"]);
/** The statuses `ResearchGoals.tick` looks at again: the others wait for a person, or are over. */
export const GOAL_REVIEWED_STATUSES = Object.freeze(["active"]);

/** A round the runtime going away ended, or the provider did: nothing about the goal, and worth starting again. */
const REVIVABLE_ERRORS = new Set([
  "runtime_stopped", "runtime_canceled", "runtime_yielded", "runtime_session_error", "runtime_monitor_stalled", "runtime_prompt_lost",
  "runtime_unavailable", "runtime_start_failed", "model_empty_reply",
]);

/** @param {any} run */
const routeOf = (run) => (typeof run?.effectiveRouteReason === "string" ? run.effectiveRouteReason : "");

/** A turn LoopX started on a goal. @param {any} run */
export function isGoalContinuation(run) {
  const route = routeOf(run);
  return run?.automated === true && (route === "loopx-continuation" || route.endsWith(":loopx-continuation"));
}

/** The turn that set a goal: 「发起研究」, or the gesture typed in a conversation. @param {any} run */
export function setsResearchGoal(run) {
  if (run?.automated === true) return false;
  const route = routeOf(run);
  return route === "research-goal" || route.endsWith(":research-goal") || /^\/loopx(\s|$)/i.test(String(run?.question ?? "").trim());
}

/** A turn the control plane itself started on a goal: to take it up again, or to set it again when its first turn came back empty. */
export const GOAL_RESUME_ROUTE = "research-goal-resume";
export const GOAL_RETRY_ROUTE = "research-goal-retry";

/** Every turn of a session from the one that set its goal on, oldest first. A session with no goal has none. @param {readonly any[]} runs @param {string} sessionId */
export function goalRounds(runs, sessionId) {
  const own = runs.filter((run) => run?.sessionId === sessionId)
    .sort((a, b) => Date.parse(a.startedAt ?? a.createdAt ?? 0) - Date.parse(b.startedAt ?? b.createdAt ?? 0));
  const first = own.findIndex((run) => setsResearchGoal(run) || isGoalContinuation(run));
  return first < 0 ? [] : own.slice(first);
}

/** The sessions of a project that have a goal, each with its rounds. @param {readonly any[]} runs @returns {Map<string, any[]>} */
export function goalSessions(runs) {
  const sessions = new Map();
  for (const sessionId of new Set(runs.filter((run) => setsResearchGoal(run) || isGoalContinuation(run)).map((run) => run.sessionId))) {
    if (typeof sessionId === "string" && sessionId) sessions.set(sessionId, goalRounds(runs, sessionId));
  }
  return sessions;
}

/** @param {any} run */
const isRunning = (run) => run?.status === "running" || run?.status === "queued";

/** Whether a round left a file behind. @param {any} run */
export function roundProducedFiles(run) {
  return [run?.artifacts, run?.outputFiles, run?.unverifiedArtifacts, run?.presentedFiles].some((list) => Array.isArray(list) && list.length > 0);
}

/**
 * How many of the goal's latest rounds LoopX ran and left no file. A round with a file, a turn of a person's or one from before `since`
 * ends the count. Rounds that register work and rounds that do it alternate on a real topic (2026-11-03: file, none, file, none), so this
 * is meant to be read against a limit above one.
 * @param {readonly any[]} rounds oldest first @param {string | null} [since]
 */
export function roundsWithoutProgress(rounds, since = null) {
  const floor = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const run of [...rounds].reverse()) {
    if (isRunning(run)) continue;
    if (Date.parse(run.startedAt ?? run.createdAt ?? 0) < floor) break;
    if (!isGoalContinuation(run) || roundProducedFiles(run)) break;
    count += 1;
  }
  return count;
}

/** What the goal's rounds have cost since `since`, in CNY. A round with no usage recorded counts nothing. @param {readonly any[]} rounds @param {string | null} [since] */
export function goalSpendCny(rounds, since = null) {
  const floor = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  return rounds.reduce((sum, run) => {
    if (Date.parse(run.startedAt ?? run.createdAt ?? 0) < floor) return sum;
    const cost = Number(run?.usage?.costCny);
    return Number.isFinite(cost) && cost > 0 ? sum + cost : sum;
  }, 0);
}

/**
 * Whether a goal should be paused now, and why. A limit of 0 is off.
 * @param {{ rounds: readonly any[], since?: string | null, maxRoundsWithoutProgress: number, maxCny: number }} input
 * @returns {"no_progress" | "budget" | null}
 */
export function guardVerdict({ rounds, since = null, maxRoundsWithoutProgress, maxCny }) {
  if (maxCny > 0 && goalSpendCny(rounds, since) >= maxCny) return "budget";
  if (maxRoundsWithoutProgress > 0 && roundsWithoutProgress(rounds, since) >= maxRoundsWithoutProgress) return "no_progress";
  return null;
}

/** Whether what ended a round was the platform or the provider and not the goal: a person's stop never is. @param {any} run */
export function roundWasInterrupted(run) {
  if (!run || isRunning(run) || run.status === "succeeded") return false;
  if (run.status === "canceled" && run.canceledBy === "user") return false;
  return REVIVABLE_ERRORS.has(String(run.errorCode));
}

/** Whether a person stopped this round. @param {any} run */
export function roundStoppedByPerson(run) {
  return run?.status === "canceled" && run.canceledBy === "user";
}

/**
 * What a goal with no round running and no round for a while has come to, from LoopX's own bar.
 *
 * `read` is `goalBarState` below. A goal whose list of work is all done is finished; a goal LoopX stopped was paused from its bar; a session
 * LoopX has no goal for ended on its reply; and a goal with work left that asks for no round is waiting for someone.
 * @param {{ kind: string, activation?: string, processed?: number, remaining?: number, total?: number }} read
 * @returns {{ status: "finished" | "paused" | "waiting", reason?: "person" } | null} null: the bar could not say, ask again
 */
export function statusFromGoalBar(read) {
  if (read.kind === "hidden") return { status: "finished" };
  if (read.kind !== "present") return null;
  // Work all done first: LoopX stops a goal itself when it finishes it (D22, 2026-11-03), and that is no one's pause.
  if (Number(read.total) > 0 && Number(read.remaining) === 0) return { status: "finished" };
  if (read.activation === "stopped") return { status: "paused", reason: "person" };
  return { status: "waiting" };
}

/**
 * LoopX's bar's answer, as the fields this module reads. The wire is `loopx_goalbar_response_v2`; anything else is `fault`.
 * @param {any} value the bar's `read` response
 */
export function goalBarState(value) {
  const result = value?.result ?? value;
  if (result?.kind === "hidden") return { kind: "hidden" };
  if (result?.kind !== "present" || !result.snapshot) return { kind: "fault", code: typeof result?.code === "string" ? result.code : "goalbar_unreadable" };
  const { snapshot } = result;
  return {
    kind: "present",
    goalId: String(snapshot.goalId ?? ""),
    loopxAgentId: String(snapshot.loopxAgentId ?? ""),
    activation: typeof snapshot.goalActivation === "string" ? snapshot.goalActivation : String(snapshot.goalActivation?.state ?? ""),
    agentStatus: typeof snapshot.agentStatus === "string" ? snapshot.agentStatus : "",
    processed: Number(snapshot.progress?.processed ?? 0),
    remaining: Number(snapshot.progress?.remaining ?? 0),
    total: Number(snapshot.progress?.total ?? 0),
  };
}
