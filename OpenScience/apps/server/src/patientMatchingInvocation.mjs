/** First-party matching tool proof. A runtime token and model-supplied session id are insufficient authority. */
import { canonicalJson } from '@evimed/domain';
import { HttpError } from './security.mjs';

const denied = () => new HttpError(403, 'patient_matching_invocation_unavailable', 'A current matching tool invocation is required.');

/** The descriptor resolver reads an admitted release, never an operation body supplied by the runtime.
 * @param {{request:any,project:any,runtimeManager:any,resolveSession:(project:any,id:string)=>any,runs:(()=>Promise<any[]>)|any[],resolveTool:(project:any,name:string)=>Promise<any>,authenticatedUserId:string,adoptionWaitMs?:number}} options */
export async function verifyPatientMatchingInvocation({ request, project, runtimeManager, resolveSession, runs, resolveTool, authenticatedUserId, adoptionWaitMs = 0 }) {
  const invocation = request?.invocation;
  if (!invocation || typeof invocation.tool !== 'string' || typeof invocation.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(invocation.sessionId)
    || typeof invocation.callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/.test(invocation.callId)) throw denied();
  const descriptor = await resolveTool(project, invocation.tool);
  if (!descriptor || descriptor.pluginId !== 'patient-matching' || descriptor.name !== invocation.tool || typeof descriptor.generation !== 'string') throw denied();
  const owned = resolveSession(project, invocation.sessionId);
  const transcript = await runtimeManager.sessionTranscript(project, invocation.sessionId, { wake: false, currentTurn: true,
    ...(owned?.child ? { parentSessionId: owned.parentSessionId } : {}) });
  const turn = transcript?.turns?.at(-1);
  const calls = (transcript?.messages ?? []).flatMap(message => (message.parts ?? []).map(part => ({ message, part })))
    .filter(item => item.part.type === 'tool' && item.part.callId === invocation.callId);
  if (transcript?.sessionId !== invocation.sessionId || transcript.truncated || !turn || turn.end !== null || calls.length !== 1
    || calls[0].part.status !== 'pending' || calls[0].part.tool !== invocation.tool || calls[0].message.turnStartSeq !== turn.startSeq) throw denied();
  try { if (canonicalJson(calls[0].part.input) !== canonicalJson(invocation.args)) throw denied(); }
  catch { throw denied(); }
  const deadline = Date.now() + Math.max(0, Math.min(30000, adoptionWaitMs));
  let run;
  for (;;) {
    const active = await (typeof runs === 'function' ? runs() : runs);
    run = active.find(row => row.id === owned?.runId || row.sessionId === invocation.sessionId);
    if (run?.sessionId || typeof runs !== 'function' || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!run?.sessionId || run.status !== 'running') throw denied();
  let rootCallId = invocation.callId;
  if (owned?.child) {
    if (owned.parentSessionId !== run.sessionId) throw denied();
    const root = await runtimeManager.sessionTranscript(project, run.sessionId, { wake: false, currentTurn: true });
    const rootTurn = root?.turns?.at(-1);
    const roots = (root?.messages ?? []).flatMap(message => (message.parts ?? []).map(part => ({ message, part })))
      .filter(item => item.part.type === 'tool' && item.part.tool === 'match_assess' && item.part.status === 'pending'
        && (!item.part.input?.taskId || item.part.input.taskId === invocation.args?.taskId));
    if (root?.sessionId !== run.sessionId || root.truncated || !rootTurn || rootTurn.end !== null || roots.length !== 1
      || roots[0].part.tool !== 'match_assess' || roots[0].part.status !== 'pending' || roots[0].message.turnStartSeq !== rootTurn.startSeq) throw denied();
    rootCallId = roots[0].part.callId;
  } else if (invocation.sessionId !== run.sessionId) throw denied();
  return {
    userId: authenticatedUserId, projectId: project.id, sessionId: invocation.sessionId, rootSessionId: run.sessionId,
    runId: run.id, callId: invocation.callId, tool: invocation.tool, args: calls[0].part.input,
    rootCallId, child: Boolean(owned?.child),
    pluginGeneration: descriptor.generation, descriptor,
  };
}
