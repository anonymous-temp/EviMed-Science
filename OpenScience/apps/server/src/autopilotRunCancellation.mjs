import { HttpError } from './security.mjs';

/** Cancel a durable execution identity, never whichever turn now occupies its persistent conversation.
 *
 * A run the ledger read does not show (a read bounded by its size, a reservation not yet visible) is not one known to be over:
 * nothing was stopped, so the cancellation is retried (`autopilot_cancellation_unconfirmed`) rather than recorded as done —
 * until its job's last attempt (`finalAttempt`), after which a run no read ever showed running is taken as gone, so a
 * cancellation of a run that never existed cannot retry for ever (review F13).
 * @param {{agentRuns:any,runtimeManager:any,stopRun:(project:any,run:any)=>Promise<unknown>}} dependencies
 * @param {any} project
 * @param {{runId:string,sessionId:string,episodeId:string,runtimeGeneration?:string|null,finalAttempt?:boolean}} target */
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
  let runtimeEnded = false;
  if (scope?.runId === target.episodeId) {
    runtimeEnded = Boolean(await runtimeManager.endBoundedRuntime(project, target.episodeId, target.runtimeGeneration ?? null));
    if (runtimeEnded) cancellationError = null;
  }
  if (cancellationError) throw cancellationError;
  if (!run && !runtimeEnded && target.finalAttempt !== true) {
    throw new HttpError(409, 'autopilot_cancellation_unconfirmed', 'The execution is not in the run ledger yet; its cancellation will be retried.');
  }
}
