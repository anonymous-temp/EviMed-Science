import {evolutionSourceRequestManifest} from './evolutionSourceRequests.mjs';
/** Acquisition changes eligibility only after the real evaluator has measured its missing resource.
 * @param {{service:any,scout:any,candidateEvaluator:any,loops:any}} deps */
export function createEvolutionResourceAcquisition({service,scout,candidateEvaluator,loops}){
 return async (mission,context=/** @type {any} */({}))=>{
  const opportunity=await service.get(mission.opportunityId);
  if(!opportunity)return {ready:false,reason:'opportunity_missing',wakeConditions:['new-method']};
  const prerequisites=opportunity.payload.prerequisites??mission.prerequisites??[];
  if(mission.moduleId==='tools'){
   const reference=await candidateEvaluator.prepareCases(opportunity.payload,{signal:context.signal});
   await scout.scout({dossierId:opportunity.id},{...context,job:context.job??{id:mission.id}});
   const measured=await service.get(opportunity.id);
   const ready=reference.ok===true&&measured?.payload.eligibility?.eligible===true&&(measured.payload.prerequisites??[]).length===0;
   return {ready,reason:ready?'independent_reference_eligibility_measured':reference.resourceCode??measured?.payload.eligibility?.reason??'independent_reference_inputs_pending',decisionChanged:ready?'tool-research-admission':null,referenceCounts:{publicInputCount:reference.publicInputCount??0,publishedReferenceCount:reference.publishedReferenceCount??0},wakeConditions:ready?[]:['new-data','new-method','new-tool']};
  }
  const development=await loops.prepareModuleTasks({...mission,missionId:mission.id,phase:'development'});
  const candidate=(await service.list('candidate')).find(row=>row.payload.moduleId===mission.moduleId&&row.payload.opportunityId===mission.opportunityId&&row.payload.frozenAt);
  const confirmation=candidate?await loops.prepareModuleTasks({...mission,missionId:mission.id,phase:'confirmation',candidate:candidate.payload,freezeAt:candidate.payload.frozenAt,modelReleasedAt:mission.modelReleasedAt}):null;
  const proofs=new Set();
  if(development.status==='ready')proofs.add('baseline-task-preparation');
  if(confirmation?.status==='ready')proofs.add('fresh-confirmation-tasks');
  const remaining=prerequisites.filter(item=>!proofs.has(item));
  if(remaining.length===0&&prerequisites.length>0)await loops.missions.opportunity({...opportunity.payload,id:opportunity.id,prerequisites:[],resourceAcquisitionMissionId:mission.id});
  const manifest=await evolutionSourceRequestManifest(service);
  const ready=prerequisites.length>0&&remaining.length===0;
  return {ready,reason:ready?'measured_resources_available':'public_resource_or_independent_truth_pending',remainingPrerequisites:remaining,development,confirmation,sourceRequestIds:manifest.sources.map(source=>source.id),decisionChanged:ready?'module-research-admission':null,wakeConditions:ready?[]:['new-data','new-method','new-tool','new-model']};
 };
}
