/** Lease takeover may reuse accepted work, but can retry only a proven unsent attempt. */
import { autopilotLogicalDispatchId, isUnsentAutopilotLeaseLoss } from "./autopilotService.mjs";
import { HttpError } from "./security.mjs";

const pending = () => new HttpError(409, "autopilot_dispatch_pending", "The prior research attempt is still being reconciled.");

/** @param {{service:any,agentRuns:any}} dependencies @param {any} project @param {any} input */
export async function inspectAutopilotDispatch({ service, agentRuns }, project, input) {
  const logicalId = input.verificationId ?? input.episodeId;
  const episode = await service.getEpisode(project.userId, input.episodeId);
  if (episode.projectId !== project.id) throw new HttpError(409, "autopilot_episode_state_conflict", "The episode belongs to another project.");
  const runs = await agentRuns.list(project);
  const owned = runs.filter(run => autopilotLogicalDispatchId(run.dispatchId) === logicalId
    && (input.verificationId || String(run.effectiveRouteReason ?? "").startsWith("autopilot:")
      || episode.payload.runId === run.id || episode.payload.unsentAttempts?.some(attempt => attempt.runId === run.id)));
  const attempt = run => Number(/-a(\d+)$/.exec(run.dispatchId)?.[1] ?? 1);
  owned.sort((a, b) => attempt(b) - attempt(a));
  const latest = owned[0] ?? null;
  if (!latest) {
    if (!input.verificationId && episode.payload.runId) throw pending();
    return { replay: null, unsent: null };
  }
  if (isUnsentAutopilotLeaseLoss(latest)) {
    if ((input.dispatchId ?? logicalId) === latest.dispatchId) throw pending();
    return { replay: null, unsent: latest };
  }
  if (latest.status === "running" && latest.dispatchStatus === "dispatching") throw pending();
  return { replay: latest, unsent: null };
}

/** Only the current lease may reclaim a captured runtime after the ledger proves no prompt was sent.
 * @param {{service:any,runtimeManager:any}} dependencies @param {any} project @param {any} input @param {any} run */
export async function reclaimUnsentAutopilotRuntime({ service, runtimeManager }, project, input, run) {
  if (!run) return;
  const logicalId = input.verificationId ?? input.episodeId;
  await service.recordUnsentAttempt(project.userId, input.episodeId, { projectId: project.id, run,
    ...(input.verificationId ? { verificationId: input.verificationId } : {}) });
  const target = runtimeManager.boundedRuntimeCleanupTarget(project);
  await input.assertDispatchAllowed?.();
  if (!target) return;
  if (target.runId !== logicalId || typeof target.generation !== "string" || !target.generation) throw pending();
  try {
    if (!await runtimeManager.endBoundedRuntime(project, logicalId, target.generation)) throw pending();
  } catch (error) {
    const remaining = runtimeManager.boundedRuntimeCleanupTarget(project);
    if (remaining?.runId === logicalId && remaining.generation === target.generation) {
      throw Object.assign(new HttpError(409, "runtime_cleanup_required", "The previous runtime has not confirmed shutdown."), { cause: error });
    }
    throw error;
  }
}
