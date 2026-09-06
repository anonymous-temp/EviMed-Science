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
      episode = await service.getEpisode(project.userId, run.dispatchId);
    }
  } catch (error) {
    await audit("autopilot.run.owner", error);
    return false;
  }
  if (!episode || episode.projectId !== project.id
    || (episode.payload?.runId && episode.payload.runId !== run.id)
    || (episode.payload?.sessionId && episode.payload.sessionId !== run.sessionId)) return false;

  const delta = await readDelta(project, run);
  const usage = usageLedger ? await usageLedger.summaryRun(project.userId, episode.id).catch(() => null) : null;
  await service.completeRun(project.userId, {
    projectId: project.id, runId: run.id, episodeId: episode.id, sessionId: run.sessionId,
    status: run.status, ...delta, artifacts: run.artifacts ?? [], costCny: usage?.actualCost ?? 0,
  }).catch(error => audit("autopilot.run.complete", error));

  // Read after completion: a late callback must not release a newer workflow.
  if (runtimeManager.boundedRuntimeScope(project)?.runId === episode.id) {
    await runtimeManager.endBoundedRuntime(project, episode.id)
      .catch(error => audit("autopilot.runtime.release", error));
  }
  return true;
}
