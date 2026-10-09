import { autopilotLogicalDispatchId, isUnsentAutopilotLeaseLoss } from "./autopilotService.mjs";
import { safeAutopilotArtifactRefs } from "./autopilotProgress.mjs";

/** Complete only the durable episode that owns this terminal research run.
 * Other bounded workflows share the runtime manager but not its release authority.
 * @param {{service:any,runtimeManager:any,usageLedger:any,readDelta:(project:any,run:any)=>Promise<any>,audit:(event:string,error:any)=>Promise<void>}} dependencies
 * @param {any} project @param {any} run */
export async function completeOwnedAutopilotRun({ service, runtimeManager, usageLedger, readDelta, audit }, project, run) {
  if (!service) return false;
  let episode;
  try {
    episode = await service.episodeForRun(project.userId, project.id, run.id);
    if (!episode && String(run.effectiveRouteReason ?? "").startsWith("autopilot:") && run.dispatchId) {
      episode = await service.getEpisode(project.userId, autopilotLogicalDispatchId(run.dispatchId) ?? run.dispatchId);
    }
  } catch (error) {
    await audit("autopilot.run.owner", error);
    return false;
  }
  if (!episode || episode.projectId !== project.id
    || (episode.payload?.runId && episode.payload.runId !== run.id)
    || (episode.payload?.sessionId && episode.payload.sessionId !== run.sessionId)) return false;

  if (isUnsentAutopilotLeaseLoss(run)) {
    await service.recordUnsentAttempt(project.userId, episode.id, { projectId: project.id, run });
    // An expired worker owns no cleanup authority; the next lease or the idle
    // manager decides whether the old runtime can be reclaimed.
    return true;
  }
  if (run.dispatchStatus === "rejected" && ["autopilot_paused", "autopilot_stopped"].includes(run.errorCode)) {
    await service.markEpisodeCanceled(project.userId, episode.id);
    if (runtimeManager.boundedRuntimeScope(project)?.runId === episode.id) {
      await runtimeManager.endBoundedRuntime(project, episode.id).catch(error => audit("autopilot.runtime.release", error));
    }
    return true;
  }

  const delta = await readDelta(project, run);
  const usage = usageLedger ? await usageLedger.summaryRun(project.userId, episode.id).catch(() => null) : null;
  await service.completeRun(project.userId, {
    ...delta, projectId: project.id, runId: run.id, episodeId: episode.id, sessionId: run.sessionId,
    status: run.status, artifactRoles: run.artifactRoles ?? {}, artifacts: run.artifacts ?? [], unverifiedArtifacts: run.unverifiedArtifacts ?? [],
    artifactRefs: safeAutopilotArtifactRefs(project.id, run), costCny: usage?.actualCost ?? 0,
  }).catch(error => audit("autopilot.run.complete", error));

  // Read after completion: a late callback must not release a newer workflow.
  if (runtimeManager.boundedRuntimeScope(project)?.runId === episode.id) {
    await runtimeManager.endBoundedRuntime(project, episode.id)
      .catch(error => audit("autopilot.runtime.release", error));
  }
  return true;
}
