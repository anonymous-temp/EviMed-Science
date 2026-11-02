import { HttpError } from "./security.mjs";
import { executionContext, reasoningEffort } from "./modelReasoningPolicy.mjs";

/** A pending tool call and its current native turn, as read from the kernel.
 * @param {any} transcript @param {any} context @returns {number | null} */
function liveCallTurn(transcript, context) {
  if (transcript?.sessionId !== context.sessionId || !Array.isArray(transcript.messages) || !Array.isArray(transcript.turns)) return null;
  const matches = transcript.messages.filter((message) => message.role === "tool" && Array.isArray(message.parts)
    && message.parts.some((part) => part.type === "tool" && part.callId === context.callId && part.status === "pending"));
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].turnStartSeq)) return null;
  const startSeq = matches[0].turnStartSeq;
  const turn = transcript.turns.at(-1);
  return turn?.startSeq === startSeq && !turn.end ? startSeq : null;
}

/** Resolve an exact session against its authenticated project's run graph and
 * durable used model selection. There is no project-wide last-request cache.
 * A native browser turn can reach a tool while the event pump is still adopting
 * that same turn. Only a kernel-witnessed live tool call may wait for that exact
 * turn; another session, another turn and an ended call never gain ownership.
 * @param {{config:Record<string,any>,store:any,agentRuns:any,runtimeManager:any,
 *   adoptionPollAttempts?:number,adoptionPollDelayMs?:number,wait?:(ms:number)=>Promise<void>}} deps */
export function createEngineExecutionContextResolver({ config, store, agentRuns, runtimeManager,
  adoptionPollAttempts = 19, adoptionPollDelayMs = 200,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  /** @param {{userId:string,projectId:string}} owner @param {any} supplied */
  return async (owner, supplied) => {
    const context = executionContext(supplied, config.deepseekModel);
    const user = await store.userById(owner.userId);
    if (!user) throw new HttpError(401, "engine_model_session_unowned", "The engine session is unavailable.");
    const project = await store.requireProject(user, owner.projectId);
    let active = await agentRuns.activeRuns(project);
    let runId = agentRuns.runIdForSession(context.sessionId, active);
    // A direct child may be in the kernel catalogue before the pump sees it.
    if (!runId && runtimeManager.subagentCatalogue) {
      for (const run of active) {
        const children = await runtimeManager.subagentCatalogue(project, run.sessionId);
        if (children.some((child) => child.id === context.sessionId)) { runId = run.id; break; }
      }
    }
    if (!runId && typeof runtimeManager.sessionTranscript === "function") {
      // A claimed session id alone is not proof: read the exact in-flight call
      // and turn from this project's kernel. Failure remains an unowned refusal.
      const readTurn = async () => {
        try {
          return liveCallTurn(await runtimeManager.sessionTranscript(project, context.sessionId, { wake: false, currentTurn: true }), context);
        } catch { return null; }
      };
      const startSeq = await readTurn();
      if (startSeq != null) {
        const attempts = Math.max(0, Math.min(19, Math.trunc(adoptionPollAttempts)));
        const delay = Math.max(0, Math.min(200, adoptionPollDelayMs));
        for (let attempt = 0; attempt < attempts; attempt++) {
          await wait(delay);
          active = await agentRuns.activeRuns(project);
          const found = active.find((run) => run.sessionId === context.sessionId && run.nativeTurn?.startSeq === startSeq);
          if (!found) continue;
          // The call can finish while adoption is underway. Recheck before
          // issuing a credential so a later turn cannot inherit its request.
          if (await readTurn() === startSeq) runId = found.id;
          break;
        }
      }
    }
    if (!runId) throw new HttpError(403, "engine_model_session_unowned", "The engine session does not belong to an active project run.");
    const selection = await runtimeManager.sessionModelSelection(project, context.sessionId);
    const used = selection?.lastUsed;
    const actual = used ? reasoningEffort(used.reasoningEffort ?? config.deepseekReasoningEffort ?? "high") : null;
    if (!used || used.provider !== context.provider || used.model !== context.model
      || (context.reasoningEffort !== undefined && context.reasoningEffort !== actual)) {
      throw new HttpError(409, "engine_model_policy_mismatch", "The engine policy does not match its session's used request header.");
    }
    return { runId, sessionId: context.sessionId, reasoningEffort: actual };
  };
}
