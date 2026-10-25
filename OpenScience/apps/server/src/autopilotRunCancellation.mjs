import { HttpError } from './security.mjs';

/** Cancel a durable execution identity, never whichever turn now occupies its persistent conversation.
 * @param {{agentRuns:any,runtimeManager:any,stopRun:(project:any,run:any)=>Promise<unknown>}} dependencies
 * @param {any} project
 * @param {{runId:string,sessionId:string,episodeId:string,runtimeGeneration?:string|null}} target */
export async function cancelScheduledRun({ agentRuns, runtimeManager, stopRun }, project, target) {
  const run = (await agentRuns.list(project)).find(item => item.id === target.runId);
  if (run && run.sessionId !== target.sessionId) {
    throw new HttpError(409, 'autopilot_cancellation_conflict', 'The execution belongs to a different conversation.');
  }
  let cancellationError = null;
  if (run?.status === 'running') {
    try { await stopRun(project, run); }
    catch (error) { cancellationError = error; }
  }
  const scope = runtimeManager.boundedRuntimeScope(project);
  if (scope?.runId === target.episodeId) {
    const stopped = await runtimeManager.endBoundedRuntime(project, target.episodeId, target.runtimeGeneration ?? null);
    if (stopped) cancellationError = null;
  }
  if (cancellationError) throw cancellationError;
}
