import { isInternalProject } from './internalProjects.mjs';
import { evolutionKey } from './evolutionService.mjs';

/** Consume only already-recorded user actions; adoption is delivery feedback, not proof of scientific correctness.
 * @param {{service:any,maintenance:any,resolvePositiveEvidence?:any}} dependencies */
export function createEvolutionFeedback({ service, maintenance, resolvePositiveEvidence=null }) {
  return {
    /** Trusted receipt arrival can precede or follow a researcher adoption. @param {any} run */
    async observeVerifiedRun(run) {
      if(!resolvePositiveEvidence||!run?.id||!run.userId||!run.projectId||isInternalProject(run.projectId))return {observed:0};
      const uses=(await service.list('use',run.userId)).filter(row=>row.projectId===run.projectId&&row.payload.runId===run.id&&row.payload.evaluation!==true&&row.payload.researcherOwned!==false);
      let observed=0;
      for(const row of uses){
        const use=row.payload,observation=await maintenance.observationOf(use.toolId,run.id);
        if(observation?.invoked!==true)continue;
        if(observation.corrected===true)continue;
        const proof=await resolvePositiveEvidence(run,{...use,invoked:true});if(proof?.verified!==true)continue;
        const id=`evolution-feedback-${evolutionKey([proof.evidenceId,use.toolId,run.id])}`;
        const prior=await service.get(id,run.userId);if(prior?.payload.status==='applied')continue;
        await maintenance.observe(use.toolId,{runId:run.id,userId:run.userId,invoked:true,outcome:'accepted',corrected:false,positiveEvidence:proof,causalBenefit:'verified',at:proof.at});
        await service.save('feedback',id,{projectId:run.projectId,runId:run.id,toolId:use.toolId,evidenceId:proof.evidenceId,status:'applied',origin:'trusted-replay'},prior,run.userId);observed++;
      }
      return {observed};
    },
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
        const use=uses.find(row=>row.payload.toolId===toolId)?.payload;
        const positiveEvidence=outcome==='accepted'&&!corrected&&resolvePositiveEvidence?await resolvePositiveEvidence({id:event.runId,userId:event.userId,projectId:event.projectId},{...use,invoked:true}):null;
        // The account travels with the observation: retirement evidence counts distinct researchers, not runs.
        await maintenance.observe(toolId, { runId: event.runId, userId: event.userId, invoked: true, outcome, corrected,
          feedbackEventId: event.id, feedbackOccurredAt: event.occurredAt, at: event.occurredAt, feedbackKind: event.trigger,
          positiveEvidence, causalBenefit: positiveEvidence?.verified===true?'verified':'unproven' });
        await service.save('feedback', id, { projectId: event.projectId, runId: event.runId, toolId,
          sourceEventId: event.id, feedbackKind: event.trigger, outcome, corrected, status: 'applied', origin: 'user-statement' }, prior, event.userId);
        observed++;
      }
      return { observed };
    },
  };
}
