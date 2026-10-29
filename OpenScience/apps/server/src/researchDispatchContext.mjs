/**
 * The context a dispatch hands a conversation: what `prepareResearchContext` writes, with the conversation's own sources read first. What every
 * dispatch needs: the capability the run was routed to, the sources the conversation selected (`sourceConversationContext`) and the context.
 *
 * A shared GEO project's conversation reads its sources through the project's own knowledge context (`knowledgeContext`,
 * `sharedKnowledgeContext.mjs`): the selection is the one that context holds for the conversation, and only what it admits is read.
 */
import { sourceConversationContext } from "./sourceConversationContext.mjs";
import { prepareResearchContext } from "./researchContext.mjs";
import { OPEN_DOMAIN_ANSWER_AGENT_ID } from "./specialistRouting.mjs";

/**
 * @param {{ config: any, sourceService?: any, researchSessions?: any,
 *   knowledgeContext?: { forProject: (project: any) => Promise<any> | any } | null }} dependencies
 * @returns {(project: any, session: any, options: any, run: any) => Promise<Awaited<ReturnType<typeof prepareResearchContext>>>}
 */
export function createResearchDispatchContext({ config, sourceService = null, researchSessions = null, knowledgeContext = null }) {
  return async (project, session, options, run) => {
    const capabilityId = run.effectiveAgentId ?? options.routedSpecialist?.agentId ?? session.agentId ?? OPEN_DOMAIN_ANSWER_AGENT_ID;
    let saved = researchSessions ? await researchSessions.get(project, session.sessionId) : session;
    const knowledge = await knowledgeContext?.forProject(project);
    if (knowledge?.kind === "geo-project" && saved?.sourceScope) saved = { ...saved, sourceScope: await knowledge.sourceScope(session.sessionId) };
    const sourceContext = await sourceConversationContext(sourceService, project, saved, false, knowledge?.kind === "geo-project" ? knowledge : {});
    return prepareResearchContext(project, { ...session, agentId: session.agentId ?? capabilityId }, config, { ...options, sourceContext });
  };
}
