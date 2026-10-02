import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';

/** Resolve pending calls from the owned native session and its current tool registry.
 * Child lineage alone does not grant extension access. Signed accepted inputs
 * and the actual current root turn remain authority before ledger adoption.
 * @param {{store:any,runtimeManager:any,resolveActor:any}} dependencies */
export function createExtensionInvocationLookup({ store, runtimeManager, resolveActor }) {
  if (typeof resolveActor !== 'function') throw new Error('Trusted accepted caller lookup is required.');
  /** @param {any} auth @param {any} invocation */
  return async (auth, invocation) => {
    if (!auth?.userId || !auth.projectId || !auth.runtimeGeneration
      || invocation.agentId !== invocation.sessionId || invocation.rootCallId !== invocation.callId
      || invocation.runtimeGeneration !== auth.runtimeGeneration
      || !['doc_read', 'doc_write'].includes(invocation.toolName)) return null;
    const user = await store.userById(auth.userId);
    if (!user) return null;
    const project = await store.requireProject(user, auth.projectId);
    const facts = await runtimeManager.extensionInvocationFacts(project, invocation.sessionId);
    if (!facts || facts.sessionId !== invocation.sessionId || facts.agentId !== invocation.agentId
      || facts.runtimeGeneration !== auth.runtimeGeneration || facts.running !== true || facts.origin !== 'root'
      || !facts.tools?.includes(invocation.toolName)) return null;
    const transcript = await runtimeManager.sessionTranscript(project, invocation.sessionId, { wake: false });
    if (transcript?.sessionId !== invocation.sessionId || transcript.truncated === true) return null;
    const matches = (transcript.messages ?? []).flatMap(message => (message.parts ?? []).map(part => ({ message, part })))
      .filter(item => item.part.type === 'tool' && item.part.callId === invocation.callId);
    if (matches.length !== 1 || matches[0].part.status !== 'pending' || matches[0].part.tool !== invocation.toolName) return null;
    const currentTurn = transcript.turns?.at(-1);
    if (!currentTurn || currentTurn.end !== null || matches[0].message.turnStartSeq !== currentTurn.startSeq) return null;
    const actor = await resolveActor(auth, invocation, matches[0].message, transcript);
    if (!actor || actor.userId !== auth.userId || actor.projectId !== auth.projectId || actor.runtimeGeneration !== auth.runtimeGeneration) return null;
    const input = matches[0].part.input;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'operation')) return null;
    const keys = invocation.toolName === 'doc_read' ? ['resourceId', 'options'] : ['targetId', 'format', 'spec'];
    if (Object.keys(input).some(key => !keys.includes(key))) return null;
    // The native call is durable before dispatch. Its arguments, rather than a
    // header supplied by the bridge, bind the body accepted by the gateway.
    const requestDigest = createHash('sha256').update(canonicalJson({ operation: invocation.toolName, ...input })).digest('hex');
    const current = await runtimeManager.extensionInvocationFacts(project, invocation.sessionId);
    if (!current || current.runtimeGeneration !== auth.runtimeGeneration || current.sessionId !== invocation.sessionId
      || current.agentId !== invocation.agentId || current.running !== true || current.origin !== 'root'
      || !current.tools?.includes(invocation.toolName)) return null;
    const latest = await runtimeManager.sessionTranscript(project, invocation.sessionId, { wake: false });
    const latestTurn = latest.turns?.at(-1);
    if (latest.sessionId !== invocation.sessionId || !latestTurn || latestTurn.startSeq !== currentTurn.startSeq || latestTurn.end !== null) return null;
    const calls = (latest.messages ?? []).flatMap(message => (message.parts ?? []).map(part => ({ message, part })))
      .filter(item => item.part.type === 'tool' && item.part.callId === invocation.callId);
    if (calls.length !== 1 || calls[0].part.status !== 'pending' || calls[0].part.tool !== invocation.toolName
      || calls[0].message.seq !== matches[0].message.seq || calls[0].message.turnStartSeq !== currentTurn.startSeq
      || canonicalJson(calls[0].part.input) !== canonicalJson(input)) return null;
    const freshActor = await resolveActor(auth, invocation, calls[0].message, latest);
    if (!freshActor || canonicalJson(freshActor) !== canonicalJson(actor)) return null;
    return { userId: auth.userId, projectId: auth.projectId, runtimeGeneration: current.runtimeGeneration,
      sessionId: invocation.sessionId, callId: invocation.callId, rootCallId: invocation.callId,
      agentId: invocation.agentId, toolName: invocation.toolName, pending: true, toolPermitted: true, requestDigest };
  };
}
