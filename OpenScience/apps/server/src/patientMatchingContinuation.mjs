/** Durable continuations ask the native agent to resume the original saved task in its original conversation. */
import { randomUUID } from 'node:crypto';
import { profileIdentity } from '@evimed/patient-matching-core';
import { HttpError } from './security.mjs';

export const PATIENT_MATCHING_CONTINUATION_KIND='patient-matching-continuation';
const pendingError=code=>new HttpError(409,code,'Matching continuation is waiting for its original conversation.');
const live=run=>['queued','running'].includes(run?.status);
/** This worker stores only task/session references. The adapter remains the authority on progress and cancellation. */
export class PatientMatchingContinuation {
  /** @param {{jobs:any,documents:any,adapter:any,resolve:(origin:any)=>Promise<any>,runs:(project:any)=>Promise<any[]>,dispatch:(context:any,request:any)=>Promise<any>,allowed?:(origin:any)=>Promise<boolean>,notify?:(origin:any,taskId:string)=>Promise<void>,report?:(code:string)=>void,pollMs?:number,leaseMs?:number}} dependencies */
  constructor({jobs,documents,adapter,resolve,runs,dispatch,allowed=async()=>true,notify=async()=>{},report=()=>{},pollMs=5000,leaseMs=60000}){
    this.jobs=jobs;
    this.documents=documents;
    this.adapter=adapter;
    this.resolve=resolve;
    this.runs=runs;
    this.dispatch=dispatch;
    this.allowed=allowed;
    this.notify=notify;
    this.report=report;
    this.pollMs=pollMs;
    this.leaseMs=leaseMs;
    this.workerId=`patient-matching-${randomUUID()}`;
    /** @type {NodeJS.Timeout|null} */ this.timer=null;
    /** @type {Promise<void>|null} */ this.ticking=null;
    /** @type {string|null} */ this.sweepAfter=null;
    this.lastSweep=0;
  }
  async enqueue(origin,taskId){
    const p=await this.adapter.pending(origin,taskId);if(!p.pending)return null;
    const saved={userId:origin.userId,projectId:origin.projectId,rootSessionId:origin.rootSessionId,runId:origin.runId??null,pluginGeneration:origin.pluginGeneration};
    const key=profileIdentity({taskId,cursor:p.cursor,epoch:p.continuationEpoch??0,pluginGeneration:saved.pluginGeneration});
    return this.jobs.enqueue(origin.userId,PATIENT_MATCHING_CONTINUATION_KIND,{origin:saved,taskId,cursor:p.cursor,epoch:p.continuationEpoch??0},
      {idempotencyKey:`matching-continue-${key.slice(7)}`,projectId:origin.projectId,maxAttempts:3});
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>void this.tick(),this.pollMs);this.timer.unref?.();}
  async stop(){if(this.timer)clearInterval(this.timer);this.timer=null;await this.ticking;}
  async tick(){if(this.ticking)return this.ticking;this.ticking=this.runOne().catch(error=>this.report(error?.code??'patient_matching_continuation_failed')).finally(()=>{this.ticking=null;});return this.ticking;}
  async runOne(){
    let job=await this.jobs.claim([PATIENT_MATCHING_CONTINUATION_KIND],this.workerId,{leaseMs:this.leaseMs});
    if(Date.now()-this.lastSweep>60000){await this.recover();this.lastSweep=Date.now();}
    if(!job)job=await this.jobs.claim([PATIENT_MATCHING_CONTINUATION_KIND],this.workerId,{leaseMs:this.leaseMs});if(!job)return;
    const {origin,taskId,cursor,epoch=0}=job.payload;
    let lease=true;
    const heartbeat=setInterval(()=>{void this.jobs.renew(job.userId,job.id,job.leaseToken,this.leaseMs).then(ok=>{lease=ok;}).catch(()=>{lease=false;});},Math.max(1000,Math.floor(this.leaseMs/3)));heartbeat.unref?.();
    const assertCurrent=async()=>{
      if(!lease || !await this.jobs.withLease(job.userId,job.id,job.leaseToken,async()=>true))throw pendingError('product_job_lease_lost');
      const p=await this.adapter.pending(origin,taskId);
      if(!p.pending || p.cursor!==cursor || (p.continuationEpoch??0)!==epoch)throw pendingError('patient_matching_continuation_superseded');
      if(!await this.allowed(origin))throw pendingError('patient_matching_generation_unavailable');
    };
    try{
      let p=await this.adapter.pending(origin,taskId);
      if(!p.pending || p.cursor!==cursor || (p.continuationEpoch??0)!==epoch){await this.jobs.finish(job.userId,job.id,job.leaseToken,{taskId,state:p.state,cursor:p.cursor});if(p.pending)await this.enqueue(origin,taskId);return;}
      if(!await this.allowed(origin))throw pendingError('patient_matching_generation_unavailable');
      const context=await this.resolve(origin);
      if(!context?.project || !context?.user || context.project.id!==origin.projectId || context.user.id!==origin.userId || context.sessionId!==origin.rootSessionId)throw pendingError('patient_matching_origin_unavailable');
      const stateId=`pm_continue_${job.id}`;
      let row=await this.documents.get(origin.userId,PATIENT_MATCHING_CONTINUATION_KIND,stateId);
      let round=row?.payload.round??0;
      let dispatchId=`pm_${job.id}_${round}`;
      const running=await this.runs(context.project);
      let prior=running.find(run=>run.dispatchId===dispatchId);
      if(prior && !live(prior)){
        p=await this.adapter.pending(origin,taskId);
        if(!p.pending || p.cursor!==cursor || (p.continuationEpoch??0)!==epoch){await this.jobs.finish(job.userId,job.id,job.leaseToken,{taskId,state:p.state,cursor:p.cursor});if(p.pending)await this.enqueue(origin,taskId);return;}
        if(round>=2){await this.jobs.finish(job.userId,job.id,job.leaseToken,{taskId,state:'needs-attention',pending:true,reason:'no-progress',rounds:round+1});await this.notify(origin,taskId);return;}
        round++;dispatchId=`pm_${job.id}_${round}`;prior=running.find(run=>run.dispatchId===dispatchId);
      }
      if(!row || row.payload.round!==round)row=await this.documents.put(origin.userId,PATIENT_MATCHING_CONTINUATION_KIND,stateId,{taskId,round,cursor,origin},{expectedRevision:row?.revision??0,projectId:origin.projectId});
      const fingerprint=profileIdentity({taskId,cursor,round,origin});
      if(prior && (prior.sessionId!==origin.rootSessionId || prior.dispatchFingerprint!==fingerprint))throw pendingError('patient_matching_dispatch_conflict');
      if(!prior){
        if(running.some(run=>live(run)))throw pendingError('agent_run_project_busy');
        await assertCurrent();
        await this.dispatch(context,{sessionId:origin.rootSessionId,dispatchId,text:`Continue saved patient-matching task ${taskId}. Call match_job to inspect its current state, then match_assess with this taskId for unfinished pairs. Use the saved sources and profile; do not create another task or conversation. Persist results before describing progress.`,
          options:{nativeContinuation:true,dispatchFingerprint:fingerprint,originRunId:origin.runId,beforePrompt:assertCurrent,beforeReserve:assertCurrent}});
      }
      // Acceptance can be lost after the kernel started. A retry uses the exact dispatch identity and observes it.
      await this.jobs.fail(job.userId,job.id,job.leaseToken,{code:'patient_matching_waiting_for_round',message:'Waiting for the native continuation.'},{retry:true,refundAttempt:true,delayMs:this.pollMs});
    }catch(error){
      const code=String(error?.code??'patient_matching_continuation_failed');
      if(code==='product_job_lease_lost')return;
      if(code==='patient_matching_continuation_superseded'){
        const p=await this.adapter.pending(origin,taskId);await this.jobs.finish(job.userId,job.id,job.leaseToken,{taskId,state:p.state,cursor:p.cursor});if(p.pending)await this.enqueue(origin,taskId);return;
      }
      const terminal=['patient_matching_task_not_found','patient_matching_origin_unavailable','patient_matching_generation_unavailable','patient_matching_dispatch_conflict','project_not_found','research_session_not_found'].includes(code);
      const busy=['agent_run_project_busy','agent_run_busy','agent_run_already_running'].includes(code);
      const outcome=await this.jobs.fail(job.userId,job.id,job.leaseToken,{code,message:'The original matching task could not continue.'},{retry:!terminal,refundAttempt:busy,delayMs:this.pollMs});
      if(terminal || outcome.status==='failed')await this.notify(origin,taskId);
    }finally{clearInterval(heartbeat);}
  }
  /** Recover a commit whose post-save enqueue was interrupted. Reference pages never become tasks. */
  async recover(){
    if(!this.jobs.database)return;
    const rows=await this.jobs.database.query(`SELECT id,payload FROM evimed_product.documents
      WHERE kind='patient-matching-task' AND deleted_at IS NULL AND payload->>'recordType'='matching-task'
      AND payload->>'state'='pending' AND ($1::text IS NULL OR id>$1) ORDER BY id LIMIT 100`,[this.sweepAfter]);
    this.sweepAfter=rows.rows.length===100?rows.rows.at(-1).id:null;
    for(const row of rows.rows){const origin=row.payload.origin;if(!origin?.pluginGeneration)continue;
      try{await this.enqueue(origin,row.id);}catch(error){this.report(error?.code??'patient_matching_recovery_failed');}}
  }
}
