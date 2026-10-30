import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';
export const EVOLUTION_SERVING_EVENT_TYPES = Object.freeze(['researcher-feedback','runtime-gap','autopilot-gap','dataset-ready','tool-ready','evaluation-gap']);
/** The serving continuation of published state: events, decision expiries, the operators' digest, a retirement's completion and the
 * metrics-only month; and a self-check, an already published tool run in the isolated executor on a researcher's dataset. */
export const EVOLUTION_SERVING_LIGHT_KINDS = Object.freeze(['evolution-event','evolution-decision','evolution-digest','evolution-maintain']);
export const EVOLUTION_SERVING_SELF_CHECK_KIND = 'evolution-self-check';
/** A request a retry cannot change (main's classification): the job fails at once. */
const TERMINAL_STATUSES = Object.freeze([400, 401, 403, 404, 422]);
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** Deterministic continuation of already published product operations. No experimental job is claimed.
 * @param {{service:any,integration:any,decisions?:any,maintenance?:any,selfCheck?:any,config?:any,logger?:any,quarantine?:(admission:(client?:any)=>Promise<boolean>|boolean)=>Promise<any>,canRun?:(client?:any)=>Promise<boolean>|boolean}} dependencies */
export function createEvolutionServingWorker({service,integration,decisions=null,maintenance=null,selfCheck=null,config={},logger=console,canRun=async()=>true,quarantine=async()=>0}) {
 const workerId=`evolution-serving-${randomUUID()}`;
 /** @type {ReturnType<typeof setInterval>|null} */ let timer=null;
 /** @type {Promise<any>|null} */ let active=null;
 let closed=false;
 const counters={processed:0,closed:0,failed:0,terminal:0,quarantined:0,housekeepingFailed:0};
 const kinds=Object.freeze([...EVOLUTION_SERVING_LIGHT_KINDS,...(selfCheck?[EVOLUTION_SERVING_SELF_CHECK_KIND]:[])]);
 const leaseMs=()=>config.evolutionLeaseMs??120000;
 /** @type {Map<string,{at:number,key:string|null}>} */ const blockRuns=new Map();
 /** A block runs when it never ran, its key changed or its interval passed, and is marked done only after it succeeded.
  * @param {string} name @param {{ms:number,key?:string|null}} schedule @param {()=>Promise<any>} work */
 const every=async(name,{ms,key=null},work)=>{const at=service.now().getTime(),last=blockRuns.get(name);if(last&&last.key===key&&at-last.at<ms)return;await work();blockRuns.set(name,{at,key});};
 /** The recovery and reporting paths of published state (main's housekeeping, without any experiment): each idempotent, keyed. */
 async function housekeeping() {
  const now=service.now(),local=new Date(now.getTime()+8*HOUR),day=local.toISOString().slice(0,10),month=now.toISOString().slice(0,7);
  const previousMonth=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)).toISOString().slice(0,7);
  // Experimental rows left queued at cutover: on the first poll and at most hourly, admitted as a claim is.
  await every('quarantine',{ms:HOUR},async()=>{counters.quarantined+=Number(await quarantine(canRun)??0);});
  // An event saved `queued` whose enqueue was lost.
  await every('reconcile',{ms:MINUTE},async()=>{await service.reconcileQueued?.();});
  await every('retirements',{ms:MINUTE},async()=>{
   for(const tool of await service.tools())if(tool.payload.status==='retired'&&tool.payload.retirement?.state!=='complete')await service.enqueue('maintain',{action:'retirement-reconcile',toolId:tool.id},`retirement:${tool.id}:${day}`);
   for(const review of await service.list('maintenance-review'))if(review.payload.restoration?.state==='pending'&&review.payload.restoration.decisionId)await service.enqueue('decision',{decisionId:review.payload.restoration.decisionId},`restore-decision:${review.id}:${day}`);
  });
  // The operators' 进化日报, the one delivery path of a saved card that was not yet delivered.
  await every('digest',{ms:MINUTE},async()=>{
   const preferences=await service.notifications?.preferences?.(await service.owner());
   if(local.toISOString().slice(11,16)>=(preferences?.digestTime??'08:00'))await every('digest-queued',{ms:DAY,key:day},()=>service.enqueue('digest',{day},`daily-digest:${day}`));
  });
  // The month's funnel figures, metrics-only, under a key of serving's own: a cancelled `monthly-v2:`/`monthly-metrics:` row cannot hold it.
  await every('monthly',{ms:DAY,key:month},async()=>{
   const months=new Set([previousMonth]);
   const firstMonth=[...await service.tools(),...await service.list('evaluation')].map(row=>String(row.createdAt??'').slice(0,7)).filter(value=>/^\d{4}-\d{2}$/.test(value)).sort()[0];
   if(firstMonth)for(let count=0,cursor=new Date(`${firstMonth}-01T00:00:00Z`);count<120&&cursor.toISOString().slice(0,7)<previousMonth;count++,cursor.setUTCMonth(cursor.getUTCMonth()+1))months.add(cursor.toISOString().slice(0,7));
   for(const metricsMonth of [...months].sort())if(!await service.get(`evolution-monthly-metrics-${metricsMonth}`))await service.enqueue('maintain',{metricsMonth,metricsOnly:true},`serving-metrics:${metricsMonth}`);
  });
 }
 /** At most `evolutionMaxConcurrency` self-checks run across the deployment's processes; each holds the isolated executor. @param {any} client */
 const selfCheckAdmission=async client=>{
  if(!await canRun(client))return false;
  await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-evolution-self-check-admission'))");
  const live=await client.query("SELECT count(*)::integer AS count FROM evimed_product.jobs WHERE kind=$1 AND status='running' AND lease_expires_at>clock_timestamp()",[EVOLUTION_SERVING_SELF_CHECK_KIND]);
  return Number(live.rows[0]?.count??0)<(config.evolutionMaxConcurrency??1);
 };
 /** @param {any} job */
 async function execute(job) {
  const p=job.payload;
  if(job.kind==='evolution-decision'){
   const result=await decisions.expire(p.decisionId);
   // Serving closes what it cannot carry out; a deferral reaching here is a defect, failed once rather than retried for ever.
   if(result?.status==='deferred')throw new HttpError(422,result.code,'The decision cannot be carried out by serving.');
   return {decisionId:p.decisionId,status:result?.payload?.status??null};
  }
  if(job.kind==='evolution-digest')return {digestId:(await decisions.digest(p.day))?.id??null};
  if(job.kind==='evolution-maintain'){
   if(p.action==='retirement-reconcile'){
    const tool=await service.get(p.toolId);
    const retired=tool?await maintenance.retire(tool,tool.payload.retirement?.reason??'retirement-recovery'):null;
    return {toolId:p.toolId,retirement:retired?.payload.retirement?.state??null};
   }
   // A monthly pass queued before cutover keeps its identity and runs as serving does: the figures only.
   return {metricsId:(await maintenance.monthly({...p,metricsOnly:true}))?.id??null};
  }
  if(job.kind===EVOLUTION_SERVING_SELF_CHECK_KIND){
   const result=await selfCheck.run(p);
   const completed=await service.completeSelfCheck(p,result);
   return {selfCheckId:result?.id??null,status:result?.payload?.status??null,resumed:completed?.resumed===true};
  }
  const row=await service.get(p.eventId,p.eventOwnerId);
  if(!row||['processed','closed'].includes(row.payload.status))return {eventId:p.eventId};
  if(!EVOLUTION_SERVING_EVENT_TYPES.includes(row.payload.type)){
   // An experiment's event moved to the offline lab: closed once, with its reason, and kept whole for the lab's migration.
   await service.save('event',row.id,{...row.payload,status:'closed',closedReason:'retired-to-lab',closedAt:service.now().toISOString()},row,p.eventOwnerId);
   counters.closed++;
   return {eventId:p.eventId,status:'closed',closedReason:'retired-to-lab'};
  }
  await integration.consume(row.payload);
  if (!['dataset-ready', 'tool-ready'].includes(row.payload.type)) await service.resolveWaiters(row.payload);
  await service.save('event',row.id,{...row.payload,status:'processed'},row,p.eventOwnerId);
  counters.processed++;
  return {eventId:p.eventId};
 }
 async function perform() {
  if(closed||config.evolutionEnabled!==true||!await canRun())return null;
  // A housekeeping block that failed is tried again on the next poll; it never stops the claims.
  try{await housekeeping();}catch(error){counters.housekeepingFailed++;logger.error('Evolution serving housekeeping failed',{code:error?.code??'evolution_serving_housekeeping_failed'});}
  const ownerId=await service.owner();
  const job=await service.jobs.claim([...EVOLUTION_SERVING_LIGHT_KINDS],workerId,{ownerId,leaseMs:leaseMs(),admission:canRun})
   ??(selfCheck?await service.jobs.claim([EVOLUTION_SERVING_SELF_CHECK_KIND],workerId,{ownerId,leaseMs:leaseMs(),admission:selfCheckAdmission}):null);
  if(!job)return null;
  let lost=false;
  const heartbeat=setInterval(()=>{service.jobs.renew(job.userId,job.id,job.leaseToken,leaseMs()).then(owned=>{if(!owned)lost=true;}).catch(()=>{lost=true;});},Math.max(1000,Math.floor(leaseMs()/4)));
  try {
   const result=await execute(job);
   if(lost)throw new Error('Evolution serving lease lost.');
   return await service.jobs.finish(job.userId,job.id,job.leaseToken,result??{});
  }catch(error){
   counters.failed++;
   // Main's classification: a request a retry cannot change fails at once, anything else is tried again until the attempts are spent.
   const terminal=Number(job.attempts??1)>=Math.min(job.maxAttempts??10,config.evolutionMaxJobAttempts??3)||TERMINAL_STATUSES.includes(error?.status??error?.statusCode);
   if(terminal)counters.terminal++;
   const code=typeof error?.code==='string'&&/^[a-z0-9_]{1,64}$/.test(error.code)?error.code:'evolution_serving_failed';
   return service.jobs.fail(job.userId,job.id,job.leaseToken,{code,message:'Serving continuation failed; the closed code identifies the cause.'},{retry:!terminal,delayMs:config.evolutionRetryMs??60000});
  }
  finally{clearInterval(heartbeat);}
 }
 const tick=()=>{if(!active)active=perform().finally(()=>{active=null;});return active;};
 const stop=()=>{if(timer)clearInterval(timer);timer=null;};
 return {kinds,counters,tick,start(){if(!closed&&!timer)timer=setInterval(()=>{tick().catch(error=>logger.error('Evolution serving worker failed',{code:error?.code??'evolution_serving_failed'}));},config.evolutionPollMs??15000);},stop,
  async close(){closed=true;stop();await active;},status:()=>({enabled:config.evolutionEnabled===true,experimentScheduling:false,running:active!==null,serving:true})};
}
