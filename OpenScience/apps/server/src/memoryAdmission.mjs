import { isInternalProjectOf } from "./internalProjects.mjs";
import { isPlatformStartedRun } from "./memoryDispatch.mjs";
import { platformSessionOf } from "./openVikingSessions.mjs";
import { memoryPausedFor } from "./researchMemory.mjs";

/**
 * Whose conversations the native memory engine may learn from, and whom it may be read for.
 *
 * Hidden knowledge: on the legacy path these decisions are spread over the places that act on them — `recordRun` refuses an
 * automated run, an internal project, a paused account, a trial conversation and one that read a patient record; the recall
 * tool honours the pause; the dispatch withholds the profile. On the native path the unmodified memory plugin does all of
 * the acting, inside the runtime, and knows none of it: it captures every turn and reads the profile at every session start.
 * So the one place the platform can decide is the door every one of its requests passes — the memory gateway — and this
 * module is that decision, made once and asked by the gateway and by the memory page alike.
 *
 * Two answers, never one flag:
 *  - `learn` — whether what is said in this conversation may reach the engine (messages, commits, `remember`). False for a
 *    caller that must not be learned from: an account on the legacy engine, the platform's own projects, a conversation
 *    whose current turn the platform started (an automated run, a LoopX continuation, a scheduled task: the turn a captured
 *    message was spoken in when its time says so, else the turn in progress) or a subagent's,
 *    a paused account or project, a conversation trying someone else's capsule, a conversation that read a patient record,
 *    and any conversation while the engine's own policy cannot be confirmed (its templates are the "never keep" rules).
 *  - `recall` — whether the account's memories may be read into this conversation (the profile, listings, search, `read`).
 *    False for the legacy engine, the platform's own projects, a recall pause and a trial conversation.
 *
 * Refused callers are answered, not failed: a write is accepted and not forwarded, a read finds nothing. The plugin is
 * unmodified and has no vocabulary for "you may not", and a conversation never waits on memory.
 *
 * @module memoryAdmission
 */

/**
 * @typedef {{ native: boolean, learn: boolean, recall: boolean, learnReason: string | null, recallReason: string | null, sessionId: string | null }} MemoryAdmission
 */

export { isPlatformStartedRun };

/**
 * The run a message was spoken in, by when it was spoken: the run in progress at that instant, a platform-started one before
 * any other when two overlap. Null when no run covers the instant (a turn the ledger has not recorded yet) — the caller then
 * asks for the turn in progress.
 *
 * Hidden knowledge: the plugin posts each message when the kernel emits it and posts again, later, any message the gateway
 * could not take (a restart, a dropped connection: its queue replays for seven days). A replayed dispatch arrives while some
 * other turn is in progress, and "the turn in progress" would call it the person's. The message carries its own time.
 * @param {readonly any[]} runs the conversation's runs, newest first @param {number | null} at epoch milliseconds
 */
function runAt(runs, at) {
  if (at === null) return null;
  const covering = runs.filter((run) => {
    const start = Date.parse(run.startedAt ?? "");
    if (!Number.isFinite(start) || at < start) return false;
    const end = Date.parse(run.finishedAt ?? "");
    return run.status === "running" || (Number.isFinite(end) && at <= end);
  });
  return covering.find(isPlatformStartedRun) ?? covering[0] ?? null;
}

/**
 * @param {{
 *   config: any,
 *   researchMemory: any,
 *   engineReady?: (() => { ok: boolean, code: string | null }) | null,
 *   conversations?: {
 *     running: (project: any) => Promise<{ id: string, sessionId: string }[]>,
 *     runsOf: (project: any, sessionId: string) => Promise<any[]>,
 *     parentOf?: (sessionId: string, running: readonly { id: string, sessionId: string }[]) => string | null,
 *   } | null,
 *   internalAgent?: ((agentId: string) => Promise<boolean>) | null,
 *   clinicalContext?: ((userId: string, projectId: string, runs: { sessionId: string, runId: string }[]) => Promise<boolean>) | null,
 * }} dependencies
 */
export function createMemoryAdmission({ config, researchMemory, engineReady = null, conversations = null, internalAgent = null, clinicalContext = null }) {
  /**
   * @param {{ user: any, project: any, engineSessionId?: string | null, at?: number | null }} caller `engineSessionId` is the
   *   engine's session (`dsh-<conversation>`) when the request names one; without it the answer is the project's running
   *   conversation's when there is exactly one, and the account's and project's own switches otherwise. `at` is the time a
   *   captured message was spoken (epoch milliseconds): it decides which turn the message belongs to.
   * @returns {Promise<MemoryAdmission>}
   */
  async function admit({ user, project, engineSessionId = null, at = null }) {
    const userId = String(user.id);
    const projectId = String(project.id);
    /** @param {string} reason @returns {MemoryAdmission} */
    const neither = (reason, sessionId = null) => ({ native: reason !== "legacy_engine", learn: false, recall: false, learnReason: reason, recallReason: reason, sessionId });
    if (!researchMemory?.configured || config?.memoryEnabled === false) return neither("legacy_engine");
    if (await researchMemory.memoryEngine(userId) !== "native") return neither("legacy_engine");
    // The platform's own projects: a lesson, an evaluation cell, a source being read. Nothing of them is the person's.
    if (isInternalProjectOf(config, userId, projectId)) return neither("internal_project");

    const running = conversations ? await conversations.running(project).catch(() => []) : [];
    const named = engineSessionId ? platformSessionOf(engineSessionId) : null;
    // Which conversation this is: the one the request names, or the only one running in the project.
    const sessionId = named ?? (running.length === 1 ? running[0].sessionId : null);
    const pause = await memoryPausedFor(researchMemory, userId, projectId, sessionId);
    // With several running and none named, a trial among them protects the person: nothing is read or written.
    let trial = pause.trial;
    if (!named && running.length > 1 && typeof researchMemory.sessionState === "function") {
      const states = await Promise.all(running.map((run) => researchMemory.sessionState(userId, projectId, run.sessionId).catch(() => ({ trialCapsuleId: null }))));
      trial = trial || states.some((state) => Boolean(state?.trialCapsuleId));
    }
    if (trial) return neither("trial", sessionId);

    const recallReason = config?.memoryRecallEnabled === false || pause.recall ? "paused" : null;
    /** @param {string | null} learnReason @returns {MemoryAdmission} */
    const answer = (learnReason) => ({ native: true, learn: learnReason === null, recall: recallReason === null, learnReason, recallReason, sessionId });

    if (pause.learning) return answer("paused");
    // The engine's templates are where "what is never kept" lives. While they cannot be confirmed loaded, the engine would
    // extract by its built-in types, which copy quoted messages into memory: nothing is sent to it.
    if (engineReady && !engineReady().ok) return answer("engine_unavailable");

    if (sessionId && conversations) {
      // A subagent's session is a platform-written brief and its answer, never the person's words.
      if (named && !running.some((run) => run.sessionId === named) && conversations.parentOf?.(named, running)) return answer("subagent");
      const runs = await conversations.runsOf(project, sessionId).catch(() => []);
      // The turn the message was spoken in when its time says so, else the turn in progress, else the last one.
      const current = runAt(runs, typeof at === "number" && Number.isFinite(at) ? at : null) ?? runs.find((run) => run.status === "running") ?? runs[0] ?? null;
      if (isPlatformStartedRun(current)) return answer("automated_run");
      const agentId = String(current?.effectiveAgentId ?? current?.agentId ?? "");
      if (agentId && internalAgent && await internalAgent(agentId).catch(() => false)) return answer("internal_project");
      if (clinicalContext && runs.length) {
        const read = await clinicalContext(userId, projectId, runs.slice(0, 20).map((run) => ({ sessionId, runId: String(run.id) }))).catch(() => true);
        if (read) return answer("clinical_context");
      }
    }
    return answer(null);
  }

  return { admit };
}
