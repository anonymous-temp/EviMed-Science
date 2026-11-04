// Candidate-language unit executor prototype. Not registered with the job
// queue: admission, budgets, durable in-flight dependencies and cancellation
// integration must be completed before a worker may use it.
import { startMeteredVcrLanguageCall } from './vcrLanguageModel.mjs';

/** @param {{candidateStore:any,loadSources:(input:any)=>Promise<any>,verifySources:(input:any)=>Promise<boolean>,config:any,usageLedger:any,transport?:any}} deps */
export function createVcrLanguageUnitExecutor({candidateStore,loadSources,verifySources,config,usageLedger,transport}) {
  if(!candidateStore || typeof loadSources!=='function' || typeof verifySources!=='function' || !usageLedger) throw new TypeError('Language unit dependencies are required.');
  /** @param {{unit:any,jobId:string,leaseOwner:string,leaseAttempt:number,projectId:string,runLimit:number,signal?:AbortSignal}} input */
  return async ({unit,jobId,leaseOwner,leaseAttempt,projectId,runLimit,signal}) => {
    const started=await candidateStore.dispatchLanguageUnit({unit,jobId,leaseOwner,leaseAttempt,loadSources,
      onAuthorized:async context=>{
        const call=startMeteredVcrLanguageCall({config,usageLedger,...(transport?{transport}:{})}, {...context,jobId,projectId,runLimit,signal});
        await call.handoff;
        return {documents:context.documents,result:call.result};
      }});
    if(started.alreadyCommitted)return {id:started.id,alreadyCommitted:true,reevaluation:'pending'};
    const payload=await started.result;
    const choice=payload?.choices?.[0];
    if(choice?.finish_reason!=='stop')throw Object.assign(new Error('The language judgment did not finish.'),{code:'vcr_language_incomplete'});
    let answer;try{answer=JSON.parse(String(choice?.message?.content??''));}catch{throw Object.assign(new Error('The language judgment is not valid JSON.'),{code:'vcr_language_unreadable'});}
    if(!answer || typeof answer!=='object' || !['satisfied','not_satisfied','unknown'].includes(answer.state)
      || !Array.isArray(answer.evidence) || answer.evidence.length>10
      || (answer.state!=='unknown' && answer.evidence.length===0)
      || (answer.state==='unknown' && answer.evidence.length!==0))throw Object.assign(new Error('The language judgment has an invalid shape.'),{code:'vcr_language_unreadable'});
    const docs=new Map(started.documents.map(doc=>[doc.documentId,doc]));
    const evidence=answer.evidence.map(entry=>{
      const document=docs.get(entry?.documentId);
      if(!document || Object.keys(entry).some(key=>!['documentId','start','end','quote'].includes(key))) throw Object.assign(new Error('The evidence is not a supplied document span.'),{code:'vcr_language_evidence_invalid'});
      return {...entry,visibleAt:document.visibleAt};
    });
    const saved=await candidateStore.commitLanguageUnit({unit,jobId,leaseOwner,leaseAttempt,state:answer.state,evidence,validateSources:verifySources});
    return {...saved,reevaluation:'pending'};
  };
}

/** Isolated queue executor, not registered in the production composition.
 * @param {{unitExecutor:(input:any)=>Promise<any>,store:any}} deps */
export function createVcrLanguageBatchExecutor({unitExecutor,store}) {
  if(typeof unitExecutor!=='function'||!store)throw new TypeError('Language batch dependencies are required.');
  return async ({job,onProgress,isCanceled=async()=>false})=>{
    const {freezeVcrLanguageUnit}=await import('./vcrLanguageUnit.mjs');
    const {VCR_ENGINE_PROTOCOL_VERSION,VCR_MATCH_BATCH_METHODS,vcrResultOutputPayload}=await import('@evimed/domain');
    const {createHash}=await import('node:crypto');
    const scenario=job.scenario ?? {};
    if(!Array.isArray(scenario.units)||!Array.isArray(scenario.unitHashes)||scenario.units.length<1||scenario.units.length>20
      ||scenario.units.length!==scenario.unitHashes.length||!Number.isFinite(scenario.runLimit)||scenario.runLimit<=0)throw Object.assign(new Error('Invalid frozen language batch.'),{code:'vcr_language_replan_required'});
    const study=await store.studyById(String(job.studyId));
    if(!study)throw Object.assign(new Error('Study not found.'),{code:'vcr_study_not_found'});
    const startedAt=new Date().toISOString(), outcomes=[];
    for(let i=0;i<scenario.units.length;i++){
      const unit=scenario.units[i], hash=freezeVcrLanguageUnit(unit).unitHash;
      if(hash!==scenario.unitHashes[i]||unit.studyId!==job.studyId||unit.userId!==study.userId)throw Object.assign(new Error('Frozen unit does not match the job.'),{code:'vcr_language_replan_required'});
      if(await isCanceled()){outcomes.push({unitHash:hash,state:'pending',code:'vcr_job_canceled'});break;}
      const controller=new AbortController();let polling=false;
      const timer=setInterval(async()=>{if(polling)return;polling=true;try{if(await isCanceled())controller.abort();}catch{controller.abort();}finally{polling=false;}},500);
      timer.unref?.();
      try {
        const saved=await unitExecutor({unit,jobId:job.jobId,leaseOwner:job.leaseOwner,leaseAttempt:job.leaseAttempt,projectId:study.projectId,runLimit:scenario.runLimit,signal:controller.signal});
        outcomes.push({unitHash:hash,state:'awaiting_reevaluation',judgmentId:saved.id,alreadyCommitted:saved.alreadyCommitted===true});
      } catch(error) {
        const raw=/** @type {any} */ (error)?.code;
        const code=typeof raw==='string'&&/^vcr_[a-z0-9_]{1,70}$/.test(raw)?raw:'vcr_language_execution_failed';
        outcomes.push({unitHash:hash,state:'failed',code});
        if(['usage_budget_exceeded','insufficient_quota'].includes(String(raw)))break;
      } finally {clearInterval(timer);}
      await onProgress({done:i+1,total:scenario.units.length});
    }
    const complete=outcomes.length===scenario.units.length&&outcomes.every(row=>row.state==='completed');
    const result={jobId:job.jobId,protocolVersion:VCR_ENGINE_PROTOCOL_VERSION,status:'succeeded',method:'matching.language',methodVersion:VCR_MATCH_BATCH_METHODS['matching.language'].version,
      scenarioHash:job.scenarioHash,seed:job.seed,replicates:null,conclusion:complete?'estimable':'limited',counts:{realPatients:null,events:null,effectiveSampleSize:null,generatedRecords:0},measures:[],tables:[],
      diagnostics:{complete,outcomes,remaining:scenario.units.length-outcomes.length},manifest:{engineVersion:'control-plane',rVersion:`node ${process.version}`,packageLockHash:'1'.repeat(64),startedAt,finishedAt:new Date().toISOString(),cpuSeconds:0}};
    result.manifest.outputHash=createHash('sha256').update(vcrResultOutputPayload(result)).digest('hex');
    return result;
  };
}
