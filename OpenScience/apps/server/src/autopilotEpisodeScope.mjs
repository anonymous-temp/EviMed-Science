/**
 * What a scheduled task's execution shows the researcher, and what holds it to its cap when it runs in their own runtime.
 *
 * Two small decisions that used to be spread over `dispatchEpisode`, kept together because they change together (R13, E-18/E-20).
 *
 * **What the conversation shows.** The first message of an execution's session is the researcher's own words: the task's
 * instruction, or — for a follow-up — the note they wrote. The episode id, task type, planned focus, budget, progress and
 * contract boilerplate are the platform's brief, and they reach the model as platform context the socket injects and a
 * researcher's conversation does not draw: in the run context written for this session (`episodeContextBlock`, which for a
 * bounded runtime also carries the episode tag and the signed budget scope), and in the run's injected brief file. Before this a
 * researcher who opened an execution's conversation read "Run the literature-sentinel proactive research episode … Maximum
 * episode budget: CNY 100.00" and a base64 marker as the first thing they had "said".
 *
 * **What holds an interactive execution to its cap.** A bounded runtime is capped by its token: the token names the run and its
 * limits, and every model call is reserved against them. An execution started inside the researcher's open runtime has no such
 * token — the runtime's token is per project and names no run — and a signed budget marker cannot stand in for one: the gateway
 * refuses a marker in an interactive runtime on purpose (`consumeBudgetScope`), and a marker that stays in the history would be
 * the wrong carrier anyway, because it would cap whatever the researcher types into the same conversation afterwards and could
 * be quoted into a later turn. So the cap is kept where the run is: the episode records, before the prompt goes out, that it
 * is interactive and what its limit is (`markEpisodeDispatched`), and the model gateway asks this module for it on every call
 * it attributes to a running ledger run (`runScope` in `createModelGatewayHandler`). The call is then booked under the episode's
 * own id — which is what the task's daily and weekly caps and the episode's recorded cost already read — and reserved against
 * that limit exactly as a bounded runtime's would be.
 *
 * Properties that follow, each held by a test:
 *  - keyed by the *run*, not by anything in the conversation: once the execution's run has ended, a turn the researcher types
 *    into the same session is another run, attributed to itself, with neither the cap nor the charge;
 *  - fail closed: a run the ledger says is a scheduled execution whose scope cannot be read is refused, not run uncapped;
 *  - only an episode that says it is interactive is scoped here; a bounded one is capped by its token and passes through.
 *
 * Which model capability would make this deletable: a kernel that lets the control plane name the spending scope of one
 * session (rather than one runtime), after which the cap rides on the session like a bounded runtime's and this lookup goes.
 *
 * @module autopilotEpisodeScope
 */

import { autopilotLogicalDispatchId } from "./autopilotService.mjs";
import { HttpError } from "./security.mjs";

/**
 * How the executions of scheduled tasks were placed since this process started, for `/api/ops/metrics`
 * (`open_science_autopilot_episode_dispatches_total`, `…_interactive_scope_unreadable_total`): where they ran, how often an open
 * runtime busy with the researcher's own run made one wait, and how often a cap could not be read (the call or credential was refused).
 * Principle 15: a limit that changes what a run may do has a counter.
 */
const placements = { interactive: 0, bounded: 0, waiting: 0, unreadable: 0 };

/** @param {"interactive" | "bounded" | "waiting"} placement */
export function noteEpisodePlacement(placement) { placements[placement] += 1; }

/** @returns {{ interactive: number, bounded: number, waiting: number, unreadable: number }} */
export function episodePlacementCounts() { return { ...placements }; }

/** The route reasons the control plane writes for a researcher's scheduled execution (`autopilot:<task type>`); never a re-check's. */
const EPISODE_ROUTE_PREFIX = "autopilot:";

/**
 * The message the researcher sees as the execution's first one.
 *
 * @param {Record<string, any>} payload the episode document's payload
 * @param {string} fallback the platform's whole brief, for an execution that predates the split: it has no instruction recorded,
 *   and showing the brief is what it always did
 * @returns {string}
 */
export function episodeVisibleText(payload, fallback) {
  const said = payload?.trigger === "follow-up" ? payload?.followUpNote : payload?.instruction;
  return typeof said === "string" && said.trim() ? said : fallback;
}

/**
 * What an execution carries in its run context beside the researcher's words: the platform's whole brief (episode id, task type, planned
 * focus, budget, progress, contract boilerplate), and — for a bounded runtime only — the episode tag and the signed budget marker the
 * gateway checks the prompt's scope with. The brief is also in the run's injected brief file; it is repeated here because that file is a
 * host-side mirror shared by the whole workspace (a remote runtime never receives it, and a second dispatch overwrites it), whereas the
 * run context is written per session through the runtime provider and cannot be read by another conversation. The run context is
 * platform context the conversation does not draw for a researcher.
 *
 * An interactive execution carries no tag and no marker: the gateway refuses both in an interactive runtime.
 *
 * @param {{ brief: string, episodeId: string, marker: string | null }} input
 * @returns {string} text to append to the run context
 */
export function episodeContextBlock({ brief, episodeId, marker }) {
  return `\n\n<evimed-autopilot-brief>\n${brief}\n</evimed-autopilot-brief>`
    + (marker ? `\n<evimed-autopilot-episode>${episodeId}</evimed-autopilot-episode>\n${marker}` : "");
}

/**
 * The gateway's `runScope` hook for scheduled executions that run in the researcher's own runtime.
 *
 * @param {{ store: { userById: (id: string) => Promise<any>, requireProject: (user: any, projectId: string) => Promise<any> },
 *   agentRuns: { list: (project: any) => Promise<any[]> },
 *   service: { getEpisode: (userId: string, episodeId: string) => Promise<any> } | null,
 *   max?: number }} dependencies
 * @returns {(request: { userId: string, projectId: string, runId: string }) => Promise<{ usageRunId: string, runLimit: number } | null>}
 */
export function createAutopilotRunScope({ store, agentRuns, service, max = 5_000 }) {
  /** What was resolved, kept for the process's life: a run's route and its episode's limit never change once the prompt is out.
   *  @type {Map<string, { usageRunId: string, runLimit: number } | null>} */
  const resolved = new Map();
  const remember = (/** @type {string} */ key, /** @type {{ usageRunId: string, runLimit: number } | null} */ value) => {
    resolved.set(key, value);
    if (resolved.size > max) resolved.delete(/** @type {string} */ (resolved.keys().next().value));
    return value;
  };
  /** @param {string} key @param {{ userId: string, projectId: string, runId: string }} request */
  async function resolveScope(key, { userId, projectId, runId }) {
    const user = await store.userById(userId);
    if (!user) throw new HttpError(404, "autopilot_account_unavailable", "Autopilot account is unavailable.");
    const project = await store.requireProject(user, projectId);
    const run = (await agentRuns.list(project)).find((item) => item.id === runId);
    // Attributed from the ledger a moment ago, so a run that is not in it now is a race with a deletion, not a scheduled execution.
    if (!run) return null;
    if (!String(run.effectiveRouteReason ?? "").startsWith(EPISODE_ROUTE_PREFIX)) return remember(key, null);
    const episodeId = autopilotLogicalDispatchId(run.dispatchId);
    // A run that says it is a scheduled execution and names no episode cannot be held to any cap: refuse it.
    if (!episodeId) throw new HttpError(409, "autopilot_episode_state_conflict", "The scheduled execution names no episode.");
    const episode = await service.getEpisode(userId, episodeId);
    if (episode.projectId !== projectId) throw new HttpError(409, "autopilot_episode_state_conflict", "The episode belongs to another project.");
    // A bounded execution is capped by its token; an interactive caller is only attributed to one while the ledger still lists a
    // dead bounded run as running, and that is no reason to refuse the researcher's own call. Not remembered: the mark that says
    // "interactive" is written before the prompt goes out, so the answer can still change for a run that has only just started.
    if (episode.payload?.interactive !== true) return null;
    const runLimit = Number(episode.payload.runLimitCny);
    if (!Number.isFinite(runLimit) || runLimit <= 0) {
      throw new HttpError(409, "autopilot_episode_state_conflict", "The interactive execution records no spending limit.");
    }
    return remember(key, { usageRunId: episodeId, runLimit });
  }
  return async function autopilotRunScope({ userId, projectId, runId }) {
    const key = `${userId}\u0000${projectId}\u0000${runId}`;
    if (resolved.has(key)) return resolved.get(key) ?? null;
    if (!service) return null;
    try { return await resolveScope(key, { userId, projectId, runId }); }
    catch (error) { placements.unreadable += 1; throw error; }
  };
}
