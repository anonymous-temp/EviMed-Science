/** One dispatch boundary for owner-scoped capability supplements. */
import { usagePurposeOfRun } from "@evimed/domain";
import { handbookContextFor, prepareCapabilityHandbooks } from "./capabilityHandbooks.mjs";
import { isInternalProject } from "./internalProjects.mjs";
import { prepareResearchContext } from "./researchContext.mjs";
import { OPEN_DOMAIN_ANSWER_AGENT_ID } from "./specialistRouting.mjs";

/** The actual runtime mount, not a second estimate of what the image might carry. */
export function remainingHandbookPromptBytes(config, runtimeManager, project) {
  const limit = Math.max(0, Number(config.mountedMethodPromptBytes) || 0);
  const mounted = runtimeManager.runtimes.get(runtimeManager.key(project))?.mountedMethodPromptBytes;
  return Number.isFinite(mounted) ? Math.max(0, limit - mounted) : 0;
}

/** Shared selection for ordinary dispatch and an immutable native input envelope.
 * @param {{learning:any,registry:any,config:any,runtimeManager:any,paused:Function,audit:Function}} dependencies */
export function createOwnedHandbookSelector({ learning, registry, config, runtimeManager, paused, audit }) {
  /** @param {any} project @param {any} session @param {any} options @param {any} run */
  return async (project, session, options, run) => {
    const capabilityId = run.effectiveAgentId ?? options.routedSpecialist?.agentId ?? session.agentId ?? OPEN_DOMAIN_ANSWER_AGENT_ID;
    let handbooks = null;
    if (learning && config.learningEnabled && !isInternalProject(project.id) && !run.learningEvaluation
      && usagePurposeOfRun(run) === "kernel") {
      try {
        const state = await paused(project.userId, project.id, session.sessionId);
        if (!state.learning && !state.trial) {
          const remaining = remainingHandbookPromptBytes(config, runtimeManager, project);
          handbooks = await prepareCapabilityHandbooks({ learning, registry: await registry,
            project, capabilityId, config, maxPromptBytes: remaining });
        }
      } catch (error) {
        await audit("handbook.context", "failed", { userId: project.userId, projectId: project.id,
          runId: run.id, code: typeof error?.code === "string" ? error.code : "handbook_context_unavailable" });
      }
    }
    return { ...handbookContextFor(handbooks, project, capabilityId), selection: handbooks };
  };
}

/** @param {{learning:any,registry:any,config:any,runtimeManager:any,agentRuns:any,paused:Function,audit:Function}} dependencies */
export function createOwnedResearchContext(dependencies) {
  const select = createOwnedHandbookSelector(dependencies);
  const { config, agentRuns } = dependencies;
  return async (project, session, options, run) => {
    const { selection: handbooks } = await select(project, session, options, run);
    const capabilityId = run.effectiveAgentId ?? options.routedSpecialist?.agentId ?? session.agentId ?? OPEN_DOMAIN_ANSWER_AGENT_ID;
    const prepared = await prepareResearchContext(project, { ...session, agentId: session.agentId ?? capabilityId }, config, { ...options, handbooks });
    if (prepared.handbooks.length) {
      await agentRuns.recordLearning(project, run.id, { capabilityHandbooks: prepared.handbooks });
    }
    return prepared;
  };
}
