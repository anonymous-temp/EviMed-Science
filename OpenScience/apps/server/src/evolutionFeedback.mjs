import { isInternalProject } from './internalProjects.mjs';
import { evolutionKey } from './evolutionService.mjs';

/** Consume only already-recorded user actions; adoption is delivery feedback, not proof of scientific correctness.
 * @param {{service:any,maintenance:any,resolvePositiveEvidence?:any,observeHandbookOutcome?:((input:any)=>Promise<any>)|null}} dependencies */
export function createEvolutionFeedback({ service, maintenance, resolvePositiveEvidence=null, observeHandbookOutcome=null }) {
  return {
    /** Trusted receipt arrival can precede or follow a researcher adoption. @param {any} run */
    async observeVerifiedRun(run) {
      if(!resolvePositiveEvidence||!run?.id||!run.userId||!run.projectId||isInternalProject(run.projectId))return {observed:0};
      const uses=(await service.list('use',run.userId)).filter(row=>row.projectId===run.projectId&&row.payload.runId===run.id&&row.payload.evaluation!==true&&row.payload.researcherOwned!==false);
      let observed=0;
      for(const row of uses){
        const use=row.payload,observation=await maintenance.observationOf(use.toolId,run.id);
        if(observation?.invoked!==true)continue;
        const tool=await service.get(use.toolId);
        const negative=await resolvePositiveEvidence.resolveNegativeEvidence?.(run,{...use,invoked:true,artifactDigest:use.artifactDigest??tool?.payload.artifactDigest});
        if(negative?.verified===true&&negative.kind==='trusted-replay-regression'&&tool?.payload.artifactDigest===negative.artifactDigest){
          const verdict=(await service.list('candidate-verdict')).find(item=>item.payload.toolId===use.toolId&&item.payload.artifactDigest===negative.artifactDigest&&item.payload.missionId&&item.payload.receiptValid);
          if(verdict)await service.withLock(`mission-regression:${verdict.payload.missionId}`,async()=>{
            const mission=await service.get(verdict.payload.missionId);if(!mission)return;
            const evidenceKey=evolutionKey([negative.replayId,negative.resultId,use.toolId,negative.artifactDigest,run.id]);
            const observations=mission.payload.regressionObservations??[];
            if(observations.some(item=>item.evidenceKey===evidenceKey))return;
            const merged=[...observations,{evidenceKey,verdictId:verdict.id,regressed:true,outcome:'trusted-replay-regression',at:negative.at}];
            await service.save('mission',mission.id,{...mission.payload,regressionObservations:merged,regressions:merged.filter(item=>item.regressed).length,regressionBasis:'independent-verdicts-and-bound-engine-replays'},mission);
          });
        }
        if(observation.corrected===true)continue;
        const proof=await resolvePositiveEvidence(run,{...use,invoked:true});if(proof?.verified!==true)continue;
        const id=`evolution-feedback-${evolutionKey([proof.evidenceId,use.toolId,run.id])}`;
        const prior=await service.get(id,run.userId);if(prior?.payload.status==='applied')continue;
        await maintenance.observe(use.toolId,{runId:run.id,userId:run.userId,invoked:true,outcome:'accepted',corrected:false,positiveEvidence:proof,causalBenefit:'verified',at:proof.at});
        if(observeHandbookOutcome)await observeHandbookOutcome({toolId:use.toolId,runId:run.id,outcome:'useful',evidence:{attributable:true,resultId:proof.resultId,independent:true}});
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
        if(observeHandbookOutcome)await observeHandbookOutcome({toolId,runId:event.runId,outcome:corrected?'harmful':positiveEvidence?.verified===true?'useful':'unknown',evidence:positiveEvidence?{attributable:true,resultId:positiveEvidence.resultId,independent:true}:null});
        observed++;
      }
      return { observed };
    },
  };
}
