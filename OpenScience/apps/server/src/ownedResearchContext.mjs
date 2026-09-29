/** One dispatch boundary for owner-scoped capability supplements. */
import { LEARNING_EVALUATION_DISPATCH_PREFIX } from "@evimed/domain";
import { prepareCapabilityHandbooks } from "./capabilityHandbooks.mjs";
import { isInternalProject } from "./internalProjects.mjs";
import { prepareResearchContext } from "./researchContext.mjs";
import { OPEN_DOMAIN_ANSWER_AGENT_ID } from "./specialistRouting.mjs";

/** @param {{learning:any,registry:any,config:any,runtimeManager:any,agentRuns:any,paused:Function,audit:Function}} dependencies */
export function createOwnedResearchContext({ learning, registry, config, runtimeManager, agentRuns, paused, audit }) {
  /** @param {any} project @param {any} session @param {any} options @param {any} run */
  return async (project, session, options, run) => {
    const capabilityId = run.effectiveAgentId ?? options.routedSpecialist?.agentId ?? session.agentId ?? OPEN_DOMAIN_ANSWER_AGENT_ID;
    let handbooks = null;
    if (learning && config.learningEnabled && !isInternalProject(project.id) && !run.learningEvaluation
      && !String(run.dispatchId ?? "").startsWith(LEARNING_EVALUATION_DISPATCH_PREFIX)) {
      try {
        const state = await paused(project.userId, project.id, session.sessionId);
        if (!state.learning && !state.trial) {
          const limit = Math.max(0, Number(config.mountedMethodPromptBytes) || 0);
          const mounted = runtimeManager.runtimes.get(runtimeManager.key(project))?.mountedMethodPromptBytes;
          // Only the running image knows what it mounted. Unknown is no spare
          // budget, so an adopted/older runtime cannot silently exceed it.
          const remaining = Number.isFinite(mounted) ? Math.max(0, limit - mounted) : 0;
          handbooks = await prepareCapabilityHandbooks({ learning, registry: await registry,
            project, capabilityId, config, maxPromptBytes: remaining });
        }
      } catch (error) {
        await audit("handbook.context", "failed", { userId: project.userId, projectId: project.id,
          runId: run.id, code: typeof error?.code === "string" ? error.code : "handbook_context_unavailable" });
      }
    }
    const prepared = await prepareResearchContext(project, { ...session, agentId: session.agentId ?? capabilityId }, config, { ...options, handbooks });
    if (prepared.handbooks.length) {
      await agentRuns.recordLearning(project, run.id, { capabilityHandbooks: prepared.handbooks });
    }
    return prepared;
  };
}
