/**
 * What an episode's outcome does to its agenda, at the scope each stopping rule
 * was written for (plan 2026-10-02 §11.3 N10).
 *
 * `directionVerdict` in `@evimed/domain` answers one question — should this
 * direction keep running — with five actions, and they were never meant to act
 * on the same thing. `pause-type` is about a task type that keeps failing to
 * run; `halve` is about a direction that keeps producing nothing; `park` and
 * `pause-thread` are about the whole agenda. `recordOutcome` used to read one
 * agenda-wide failure counter, so a type that failed twice paused the whole
 * agenda (the other types had done nothing wrong), and `halve` was computed
 * and thrown away.
 *
 * Now:
 *
 * - **A type's failures are the type's.** Each task type keeps its own
 *   consecutive-failure count (`taskTypeState`); two failures of one type pause
 *   that type — it is no longer offered to the next episode's decision — and
 *   the agenda goes on with the rest. An agenda whose every type is paused has
 *   nothing left it may run, and is paused with the reason; an agenda with one
 *   type (the common one) behaves exactly as before.
 * - **Only an episode that ran is an observation about the direction.** A
 *   failed or canceled episode did not look at the question; counting it as one
 *   more episode without a gated claim would let an execution failure — a dead
 *   runtime, a refused balance — park a direction that had found nothing wrong
 *   with it. Only a succeeded episode moves `episodesWithoutGatedClaim`, either
 *   way.
 * - **`halve` is the direction's, and it is applied where the money is spent**:
 *   a scheduled episode of a direction at reduced priority gets half the budget
 *   (`reducedPriority`, read by `AutopilotService.schedule`). It is derived from
 *   the count on every use rather than stored, so it cannot outlive the count
 *   that caused it.
 *
 * @module autopilotOutcome
 */

import { AUTOPILOT_TASK_TYPES, directionVerdict } from "@evimed/domain";
import { eligibleTaskTypes } from "./autopilotNextAction.mjs";

/**
 * Whether the domain says this direction has earned only half of its budget.
 * `park` counts: a direction restarted after being parked has still produced
 * nothing, and a restart is not a reason to spend more on it than `halve` did.
 * @param {Record<string, any>} payload an agenda's payload
 */
export function reducedPriority(payload) {
  const verdict = directionVerdict({
    episodesWithoutGatedClaim: Number(payload?.episodesWithoutGatedClaim) || 0,
    consecutiveFailures: 0, daysSinceDigestOpened: 0, userRejected: false,
  });
  return verdict.action === "halve" || verdict.action === "park";
}

/**
 * The agenda fields one recorded outcome changes. Pure: the caller holds the
 * optimistic-concurrency loop and the clock.
 *
 * @param {Record<string, any>} payload an agenda's payload
 * @param {{episodeId: string, taskType: string | null, status: "succeeded" | "failed" | "canceled", gatedClaims: number,
 *   daysSinceDigestOpened: number, userRejected: boolean, at: string}} outcome
 * @returns {Record<string, any>} fields to merge into the payload
 */
export function foldOutcome(payload, { episodeId, taskType, status, gatedClaims, daysSinceDigestOpened, userRejected, at }) {
  const failed = status === "failed";
  const succeeded = status === "succeeded";
  const consecutiveFailures = failed ? Number(payload.consecutiveFailures ?? 0) + 1
    : succeeded ? 0 : Number(payload.consecutiveFailures ?? 0);
  const without = succeeded ? (gatedClaims === 0 ? Number(payload.episodesWithoutGatedClaim ?? 0) + 1 : 0)
    : Number(payload.episodesWithoutGatedClaim ?? 0);

  const taskTypeState = { ...(payload.taskTypeState ?? {}) };
  if (taskType && AUTOPILOT_TASK_TYPES.includes(/** @type {any} */ (taskType)) && (failed || succeeded)) {
    const previous = taskTypeState[taskType] ?? {};
    const failures = failed ? (Number(previous.consecutiveFailures) || 0) + 1 : 0;
    const verdict = directionVerdict({ episodesWithoutGatedClaim: 0, consecutiveFailures: failures, daysSinceDigestOpened: 0, userRejected: false });
    taskTypeState[taskType] = { ...previous, consecutiveFailures: failures, lastOutcome: status, lastEpisodeId: episodeId, at,
      ...(verdict.action === "pause-type" ? { pausedAt: at, pauseReason: verdict.reason } : {}) };
  }

  const thread = directionVerdict({ episodesWithoutGatedClaim: without, consecutiveFailures: 0, daysSinceDigestOpened, userRejected });
  const threadStops = thread.action === "pause-thread" || thread.action === "park";
  const typesExhausted = eligibleTaskTypes({ taskTypes: payload.taskTypes, taskTypeState }).length === 0;
  const paused = threadStops || typesExhausted;
  const reason = threadStops ? thread.reason
    : Object.values(taskTypeState).filter((state) => state?.pausedAt).at(-1)?.pauseReason ?? null;

  return {
    enabled: paused ? false : payload.enabled,
    status: payload.status === "stopped" ? "stopped" : paused ? "paused" : payload.status,
    pauseReason: paused ? reason : null,
    consecutiveFailures,
    episodesWithoutGatedClaim: without,
    taskTypeState,
    outcomes: [...(payload.outcomes ?? []), { episodeId, status, gatedClaims, at, ...(taskType ? { taskType } : {}) }].slice(-100),
  };
}
