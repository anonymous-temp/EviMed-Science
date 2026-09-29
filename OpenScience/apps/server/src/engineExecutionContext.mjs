import { HttpError } from "./security.mjs";
import { executionContext, reasoningEffort } from "./modelReasoningPolicy.mjs";

/** Resolve an exact session against its authenticated project's run graph and
 * durable used model selection. There is no project-wide last-request cache.
 * @param {{config:Record<string,any>,store:any,agentRuns:any,runtimeManager:any}} deps */
export function createEngineExecutionContextResolver({ config, store, agentRuns, runtimeManager }) {
  /** @param {{userId:string,projectId:string}} owner @param {any} supplied */
  return async (owner, supplied) => {
    const context = executionContext(supplied, config.deepseekModel);
    const user = await store.userById(owner.userId);
    if (!user) throw new HttpError(401, "engine_model_session_unowned", "The engine session is unavailable.");
    const project = await store.requireProject(user, owner.projectId);
    const active = await agentRuns.activeRuns(project);
    let runId = agentRuns.runIdForSession(context.sessionId, active);
    // The event pump may not yet have observed a freshly created direct child.
    // Its kernel catalogue is exact evidence, unlike a sole-active-run guess.
    if (!runId && runtimeManager.subagentCatalogue) {
      for (const run of active) {
        const children = await runtimeManager.subagentCatalogue(project, run.sessionId);
        if (children.some(child => child.id === context.sessionId)) { runId = run.id; break; }
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
