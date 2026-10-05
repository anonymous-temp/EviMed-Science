import { isInternalProject } from './internalProjects.mjs';
import { evolutionKey } from './evolutionService.mjs';

/** Consume only already-recorded user actions; adoption is delivery feedback, not proof of scientific correctness.
 * @param {{service:any,maintenance:any}} dependencies */
export function createEvolutionFeedback({ service, maintenance }) {
  return {
    /** @param {any} event */
    async observeFeedback(event) {
      if (!event?.id || !event.userId || !event.projectId || !event.runId || isInternalProject(event.projectId)) return { observed: 0 };
      let outcome = null;
      let corrected = false;
      if (event.trigger === 'deliverable-adopted') outcome = 'accepted';
      else if (event.trigger === 'deliverable-edited') { outcome = 'repaired'; corrected = true; }
      else if (event.trigger === 'result-corrected') {
        const kind = event.detail?.kind;
        if (kind === 'analytic' || kind === 'evidence') { outcome = 'rejected'; corrected = true; }
      }
      if (!outcome) return { observed: 0, reason: 'no-delivery-or-analytic-feedback' };
      const uses = (await service.list('use', event.userId)).filter(row => row.projectId === event.projectId && row.payload.runId === event.runId && row.payload.evaluation !== true && row.payload.researcherOwned !== false);
      const toolIds = [...new Set(uses.map(row => row.payload.toolId))];
      let observed = 0;
      for (const toolId of toolIds) {
        const id = `evolution-feedback-${evolutionKey([event.id, toolId])}`;
        const prior = await service.get(id, event.userId);
        if (prior?.payload.status === 'applied') continue;
        const observation = await maintenance.observationOf(toolId, event.runId);
        if (observation?.invoked !== true) continue;
        if (observation.feedbackOccurredAt && Date.parse(observation.feedbackOccurredAt) > Date.parse(event.occurredAt)) continue;
        // The account travels with the observation: retirement evidence counts distinct researchers, not runs.
        await maintenance.observe(toolId, { runId: event.runId, userId: event.userId, invoked: true, outcome, corrected,
          feedbackEventId: event.id, feedbackOccurredAt: event.occurredAt, at: event.occurredAt, feedbackKind: event.trigger,
          causalBenefit: 'unproven' });
        await service.save('feedback', id, { projectId: event.projectId, runId: event.runId, toolId,
          sourceEventId: event.id, feedbackKind: event.trigger, outcome, corrected, status: 'applied', origin: 'user-statement' }, prior, event.userId);
        observed++;
      }
      return { observed };
    },
  };
}
