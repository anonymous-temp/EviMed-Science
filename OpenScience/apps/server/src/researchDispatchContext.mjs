/**
 * The context a dispatch hands a conversation: what `prepareResearchContext` writes, with the conversation's own sources read first. What every
 * dispatch needs: the capability the run was routed to, the sources the conversation selected (`sourceConversationContext`) and the context.
 */
import { sourceConversationContext } from "./sourceConversationContext.mjs";
import { prepareResearchContext } from "./researchContext.mjs";
import { OPEN_DOMAIN_ANSWER_AGENT_ID } from "./specialistRouting.mjs";

/**
 * @param {{ config: any, sourceService?: any, researchSessions?: any }} dependencies
 * @returns {(project: any, session: any, options: any, run: any) => Promise<Awaited<ReturnType<typeof prepareResearchContext>>>}
 */
export function createResearchDispatchContext({ config, sourceService = null, researchSessions = null }) {
  return async (project, session, options, run) => {
    const capabilityId = run.effectiveAgentId ?? options.routedSpecialist?.agentId ?? session.agentId ?? OPEN_DOMAIN_ANSWER_AGENT_ID;
    const saved = researchSessions ? await researchSessions.get(project, session.sessionId) : session;
    const sourceContext = await sourceConversationContext(sourceService, project, saved);
    return prepareResearchContext(project, { ...session, agentId: session.agentId ?? capabilityId }, config, { ...options, sourceContext });
  };
}
