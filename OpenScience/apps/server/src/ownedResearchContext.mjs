/** One dispatch boundary for owner-scoped capability supplements. */
import { isResearcherOwnedWork, usagePurposeOfRun } from "@evimed/domain";
import { handbookContextFor, platformTrialContext, prepareCapabilityHandbooks } from "./capabilityHandbooks.mjs";
import { isInternalProject } from "./internalProjects.mjs";
import { prepareResearchContext } from "./researchContext.mjs";
import { sourceConversationContext } from "./sourceConversationContext.mjs";
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
    // Whether this run is one the learning loop may touch at all: the account's own supplements and the platform's probation entry share the answer.
    let eligible = false;
    if (learning && config.learningEnabled && !isInternalProject(project.id)
      && usagePurposeOfRun(run) === "kernel") {
      try {
        const state = await paused(project.userId, project.id, session.sessionId);
        if (!state.learning && !state.trial) {
          eligible = true;
          const remaining = remainingHandbookPromptBytes(config, runtimeManager, project);
          handbooks = await prepareCapabilityHandbooks({ learning, registry: await registry,
            project, capabilityId, config, maxPromptBytes: remaining });
        }
      } catch (error) {
        await audit("handbook.context", "failed", { userId: project.userId, projectId: project.id,
          runId: run.id, code: typeof error?.code === "string" ? error.code : "handbook_context_unavailable" });
      }
    }
    return { ...handbookContextFor(handbooks, project, capabilityId), selection: handbooks, eligible };
  };
}

/**
 * `platformTrial` is the platform's probation entry for a dispatch (`learningPlatformHandbooks.probationFor`), asked only of a researcher's own run the learning loop may
 * touch - not an internal project, a harness's, or one the researcher paused learning for - since an exposure is only worth making when it can be observed.
 * It is the dispatch's alone: a conversation typed in the kernel's own frame has no run to record it against, so it carries none.
 * @param {{learning:any,registry:any,config:any,runtimeManager:any,agentRuns:any,paused:Function,audit:Function,sourceService?:any,researchSessions?:any,
 *   platformTrial?:((input:{project:any,run:any,capabilityId:string,fits:(text:any)=>boolean})=>Promise<any>)|null}} dependencies */
export function createOwnedResearchContext(dependencies) {
  const select = createOwnedHandbookSelector(dependencies);
  const { config, agentRuns } = dependencies;
  return async (project, session, options, run) => {
    const { selection: handbooks, eligible } = await select(project, session, options, run);
    const capabilityId = run.effectiveAgentId ?? options.routedSpecialist?.agentId ?? session.agentId ?? OPEN_DOMAIN_ANSWER_AGENT_ID;
    let platformTrial = null;
    if (eligible && dependencies.platformTrial && isResearcherOwnedWork(run)) {
      // The same prompt room the account's supplements draw on: what they took is gone, and an entry that does not fit what is left is not served.
      const room = Math.max(0, remainingHandbookPromptBytes(config, dependencies.runtimeManager, project) - Number(handbooks?.bytes ?? 0));
      try {
        platformTrial = await dependencies.platformTrial({ project, run, capabilityId,
          fits: (/** @type {any} */ text) => Buffer.byteLength(platformTrialContext({ capabilityId, text })) + 1 <= room });
      } catch (error) {
        await dependencies.audit("handbook.platform_trial", "failed", { userId: project.userId, projectId: project.id,
          runId: run.id, code: typeof error?.code === "string" ? error.code : "platform_trial_unavailable" });
      }
    }
    const saved = dependencies.researchSessions ? await dependencies.researchSessions.get(project, session.sessionId) : session;
    const sourceContext = await sourceConversationContext(dependencies.sourceService, project, saved);
    const prepared = await prepareResearchContext(project, { ...session, agentId: session.agentId ?? capabilityId }, config, { ...options, handbooks, sourceContext, platformTrial });
    if (prepared.handbooks.length) {
      await agentRuns.recordLearning(project, run.id, { capabilityHandbooks: prepared.handbooks });
    }
    return prepared;
  };
}
