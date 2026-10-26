import { randomUUID } from 'node:crypto';
export const EVOLUTION_SERVING_EVENT_TYPES = Object.freeze(['researcher-feedback','runtime-gap','autopilot-gap','dataset-ready','tool-ready','evaluation-gap']);
/** Deterministic continuation of already published product operations. No experimental job is claimed.
 * @param {{service:any,integration:any,decisions?:any,config?:any,logger?:any,quarantine?:()=>Promise<any>,canRun?:(client?:any)=>Promise<boolean>|boolean}} dependencies */
export function createEvolutionServingWorker({service,integration,decisions=null,config={},logger=console,canRun=async()=>true,quarantine=async()=>{}}) {
 const workerId=`evolution-serving-${randomUUID()}`;
 /** @type {ReturnType<typeof setInterval>|null} */ let timer=null;
 /** @type {Promise<any>|null} */ let active=null;
 let closed=false;
 const counters={processed:0,deferred:0,failed:0};
 const kinds=Object.freeze(['evolution-event', 'evolution-decision']);
 async function perform() {
  if(closed||config.evolutionEnabled!==true||!await canRun())return null;
  await quarantine();
  const job=await service.jobs.claim([...kinds],workerId,{ownerId:await service.owner(),leaseMs:config.evolutionLeaseMs??120000,admission:canRun});
  if(!job)return null;
  let lost=false;
  const heartbeat=setInterval(()=>{service.jobs.renew(job.userId,job.id,job.leaseToken,config.evolutionLeaseMs??120000).then(owned=>{if(!owned)lost=true;}).catch(()=>{lost=true;});},Math.max(1000,Math.floor((config.evolutionLeaseMs??120000)/4)));
  try {
   const p=job.payload;
   if(job.kind === 'evolution-decision') {
    const result=await decisions.expire(p.decisionId);
    if(result?.status==='deferred')return service.jobs.fail(job.userId,job.id,job.leaseToken,{code:'evolution_offline_only',message:'Experimental decision retained for offline review.'},{retry:true,refundAttempt:true,delayMs:86400000});
    return service.jobs.finish(job.userId,job.id,job.leaseToken,result??{});
   }
   const row=await service.get(p.eventId,p.eventOwnerId);
   if(row&&row.payload.status!=='processed'){
    if(!EVOLUTION_SERVING_EVENT_TYPES.includes(row.payload.type)){
     await service.save('event',row.id,{...row.payload,status:'deferred',deferredReason:'evolution_offline_only'},row,p.eventOwnerId);
     counters.deferred++;
     return service.jobs.fail(job.userId,job.id,job.leaseToken,{code:'evolution_offline_only',message:'Experimental event retained for offline campaign migration.'},{retry:true,refundAttempt:true,delayMs:86400000});
    }
    await integration.consume(row.payload);
    if (!['dataset-ready', 'tool-ready'].includes(row.payload.type)) await service.resolveWaiters(row.payload);
    if(lost)throw new Error('Evolution serving event lease lost.');
    await service.save('event',row.id,{...row.payload,status:'processed'},row,p.eventOwnerId);
    counters.processed++;
   }
   return service.jobs.finish(job.userId,job.id,job.leaseToken,{eventId:p.eventId});
  }catch(error){counters.failed++;return service.jobs.fail(job.userId,job.id,job.leaseToken,{code:error?.code??'evolution_serving_failed',message:'Serving continuation waits for recovery; the closed code identifies the cause.'},{retry:true,refundAttempt:true,delayMs:60000});}
  finally{clearInterval(heartbeat);}
 }
 const tick=()=>{if(!active)active=perform().finally(()=>{active=null;});return active;};
 const stop=()=>{if(timer)clearInterval(timer);timer=null;};
 return {kinds,counters,tick,start(){if(!closed&&!timer)timer=setInterval(()=>{tick().catch(error=>logger.error('Evolution serving worker failed',{code:error?.code??'evolution_serving_failed'}));},config.evolutionPollMs??15000);},stop,
  async close(){closed=true;stop();await active;},status:()=>({enabled:config.evolutionEnabled===true,experimentScheduling:false,running:active!==null,serving:true})};
}
