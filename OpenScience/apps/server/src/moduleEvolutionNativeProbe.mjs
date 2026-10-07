import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {readRunTranscript} from './runTranscripts.mjs';
import {MODULE_RUNTIME_TASKS} from './moduleEvolutionRuntimeSession.mjs';
/** Real native sessions execute only checked-in nonclinical reference tasks. No generated prompt/code is accepted.
 * @param {{runs:any,store:any,agentRuns:any,config:any,readKernelProof:any}} deps */
export function createModuleEvolutionNativeProbe({runs,store,agentRuns,config,readKernelProof}){
 return async input=>{
  const reference=MODULE_RUNTIME_TASKS.find(item=>item.id===(input.item.nativeReferenceId??input.item.id));
  if(!reference)throw new Error('Native evaluation task is not a trusted code template.');
  const projectId=`eval-paper-runtime-${createHash('sha256').update(JSON.stringify([input.missionId,input.item.id,input.arm,input.repeat])).digest('hex').slice(0,24)}`;
  let sessionId=null;const turns=[],started=Date.now();
  const user=await store.userById(input.userId);let project,nativeScope;
  try {
  for(let index=0;index<reference.turns.length;index++){
   input.signal?.throwIfAborted();
   const task=reference.turns[index],dispatchId=`runtime-probe-${createHash('sha256').update(`${projectId}:${index}`).digest('hex').slice(0,28)}`;
   const run=await runs.dispatch({userId:input.userId,projectId,capabilityId:'open-domain-answer',dispatchId,brief:task.prompt,sessionId,nativeProbe:true});
   nativeScope??=run.nativeScope;sessionId=run.sessionId;project=await store.requireProject(user,projectId);
   const deadline=Date.now()+config.evolutionEvaluationTimeoutMs;
   let finished;
   while(Date.now()<deadline){input.signal?.throwIfAborted();finished=(await agentRuns.list(project)).find(row=>row.id===run.id);if(finished&&finished.status!=='running')break;await delay(1000,undefined,{signal:input.signal});}
   if(!['delivered','succeeded'].includes(finished?.status))throw new Error('Native runtime probe did not produce a completed first answer.');
   let history=await readRunTranscript(project,run.id);
   const sealDeadline=Date.now()+60000;
   while(history?.header?.completeness!=='complete'&&Date.now()<sealDeadline){input.signal?.throwIfAborted();await delay(250,undefined,{signal:input.signal});history=await readRunTranscript(project,run.id);}
   if(history?.header?.completeness!=='complete')throw new Error('Native runtime probe transcript is not durably complete.');
   const messages=Array.isArray(history)?history:history.messages??[];
   const assistant=messages.filter(message=>message.sessionId===run.sessionId&&(message.role==='assistant'||message.info?.role==='assistant')).at(-1);
   const reply=(assistant?.parts??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
   if(!reply)throw new Error('Native runtime probe has no preserved assistant response.');
   turns.push({runId:run.id,passed:reply.trim()===task.expectedText,replyHash:createHash('sha256').update(reply).digest('hex'),contextBytes:Buffer.byteLength(JSON.stringify(history))});
  }
  const proof=await readKernelProof(project);
  if(!proof?.kernelVersion||!proof.baselineVersion)throw new Error('Observed native kernel and baseline version proof is required.');
  return {sessionId,kernelVersion:proof.kernelVersion,baselineVersion:proof.baselineVersion,sessionHash:createHash('sha256').update(JSON.stringify(turns)).digest('hex'),turns,passed:turns.every(turn=>turn.passed),latencyMs:Date.now()-started,contextBytes:turns.reduce((sum,turn)=>sum+turn.contextBytes,0),evaluationScope:'trusted-native-nonclinical'};
  } finally {if(project&&nativeScope)await runs.closeNativeProbe(project,nativeScope);}
 };
}
