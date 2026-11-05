/** Dispatch admission can verify a cold selected release; actual host tools still require the live runtime proof. */
import {HttpError} from './security.mjs';
/** @param {{lifecycle:any,runtime:any,project:any,name?:string}} options */
export async function patientMatchingDispatchDescriptor({lifecycle,runtime,project,name='match_assess'}){
  if(!lifecycle)return null;
  if(runtime.runtimeGeneration(project))return lifecycle.resolveTool(project,name);
  const candidate=await lifecycle.selectForRuntime(project);if(!candidate)return null;
  await runtime.inspectPatientMatchingWorker();
  return {pluginId:'patient-matching',name,generation:candidate.reference.generationHash};
}
/** A page action may predate the conversation's first run. It still resumes that exact owned conversation.
 * @param {{runs:any[],conversation:any,sessionId:string,originRunId?:string|null,text:string}} options */
export function patientMatchingContinuationOptions({runs,conversation,sessionId,originRunId,text}){
  const prior=runs.filter(run=>run.sessionId===sessionId),original=originRunId?prior.find(run=>run.id===originRunId):prior[0];
  if(!conversation || originRunId&&!original)throw new HttpError(404,'patient_matching_origin_unavailable','The original conversation or turn is unavailable.');
  return {originalQuestion:original?.question??text,continuationRoute:{effectiveAgentId:original?.effectiveAgentId??original?.agentId??conversation.agentId??'open-domain-answer'}};
}
