import {canonicalJson} from '@evimed/domain';
import {createHash} from 'node:crypto';
import {HttpError} from './security.mjs';
import {verifyExtensionGeneration} from './extensionGenerationService.mjs';
const digest=value=>'sha256:'+createHash('sha256').update(canonicalJson(value)).digest('hex');
export const EXTENSION_GENERATION_JOB_VARIANT='extension-generation-v1';
/** Exact observed inventory/config proof, never a runtime's generic healthy bit. @param {any} candidate @param {any} proof @param {string} actualRuntimeGeneration */
export function assertExtensionGenerationRuntimeProof(candidate,proof,actualRuntimeGeneration){
  const inventory=candidate.projection.plugins.map(plugin=>({extensionId:plugin.extensionId,artifactDigest:plugin.artifactDigest,configRevision:plugin.configRevision,configDigest:plugin.configDigest,enabled:plugin.enabled}));
  if(!proof||typeof proof.runtimeGeneration!=='string'||!proof.runtimeGeneration||proof.runtimeGeneration!==actualRuntimeGeneration
    ||canonicalJson(proof.reference??null)!==canonicalJson(candidate.reference??null)||canonicalJson(proof.inventory)!==canonicalJson(inventory)
    ||canonicalJson(proof.personal)!==canonicalJson(candidate.projection.personal)
    ||['baseRuntimeImageDigest','adapterRevision','permissionProfileRevision'].some(key=>proof[key]!==candidate.identity[key]))throw new HttpError(502,'plugin_apply_failed','The observed generation inventory did not match.');
}
/** Dispatched by the existing plugin-apply consumer; this class never claims a competing queue. */
export class ExtensionGenerationWorker{
  /** @param {{service:any,runtime:any,resolveProject:any,ledgerBusy:any,leaseMs?:number}} dependencies */
  constructor({service,runtime,resolveProject,ledgerBusy,leaseMs=300000}){this.service=service;this.database=service.database;this.jobs=service.jobs;this.runtime=runtime;this.resolveProject=resolveProject;this.ledgerBusy=ledgerBusy;this.leaseMs=leaseMs;}
  /** @param {any} job */
  canHandle(job){return job?.kind==='plugin-apply'&&job.payload?.variant===EXTENSION_GENERATION_JOB_VARIANT;}
  /** @param {any} job */
  defer(job){return this.jobs.withLease(job.userId,job.id,job.leaseToken,client=>client.query("UPDATE evimed_product.jobs SET status='queued',attempts=GREATEST(0,attempts-1),lease_token=NULL,lease_expires_at=NULL,run_after=clock_timestamp()+interval '5 seconds' WHERE id=$1",[job.id]));}
  /** @param {any} job */
  async runClaimed(job){if(!this.canHandle(job))throw new HttpError(400,'extension_contract_invalid','This job is not an extension generation apply.');let lost=false;
    try{return await this.database.transaction(client=>this.database.withTransactionClient(client,async()=>{
      const lock=await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`plugin-project:${job.userId}:${job.projectId}`]);if(!lock.rows[0].acquired)return this.defer(job);
      const project=await this.resolveProject(job);if(project.userId!==job.userId||project.id!==job.projectId)throw new HttpError(404,'plugin_project_unavailable','The project is unavailable.');
      const state=await this.service.current(project),candidate=state?.payload.desired;
      if(!candidate||canonicalJson(candidate.reference)!==canonicalJson(job.payload.reference)||state.revision!==job.payload.stateRevision)return this.jobs.finish(job.userId,job.id,job.leaseToken,{superseded:true});
      const lease=async()=>{if(lost||!await this.jobs.renew(job.userId,job.id,job.leaseToken,this.leaseMs))throw new HttpError(409,'product_job_lease_lost','Apply ownership changed.');};
      const guard=async()=>{await lease();return this.service.assertCurrent(job,candidate,client);};
      let renewing=false,pending=Promise.resolve();const timer=setInterval(()=>{if(renewing)return;renewing=true;pending=this.jobs.renew(job.userId,job.id,job.leaseToken,this.leaseMs).then(ok=>{if(!ok)lost=true;}).catch(()=>{lost=true;}).finally(()=>{renewing=false;});},Math.floor(this.leaseMs/3));timer.unref();
      try{
        await guard();const busy=async()=>{const prompts=await this.service.plugins.hasPendingPrompts(project),ledger=await this.ledgerBusy(project),kernel=await this.runtime.pluginRuntimeBusy(project);return [prompts,ledger,kernel].some(value=>typeof value!=='boolean'||value);};
        if(await busy())return this.defer(job);await verifyExtensionGeneration(this.service.config,project,candidate.reference,this.service.assessmentAdmission);
        const current=await this.runtime.currentGeneration(project),previous=state.payload.lastGood;
        const captured=previous&&canonicalJson(current?.reference??null)===canonicalJson(previous.reference)?previous:null;
        const baseline=()=>({...candidate,reference:null,projection:{plugins:candidate.projection.plugins.filter(plugin=>plugin.compatibility==='legacy-citation-v1'),personal:candidate.projection.personal},findings:candidate.findings});
        try{
          const prepared=await this.runtime.prepareGeneration(project,candidate);if(prepared?.joined!==true||prepared.manifestDigest!==digest(candidate))throw new HttpError(502,'plugin_apply_failed','Prepared manifest identity did not match.');
          await guard();if(await busy())return this.defer(job);
          const replaced=await this.runtime.replaceGeneration(project,candidate);if(replaced?.joined!==true)throw Object.assign(new HttpError(503,'product_state_unavailable','Generation replacement is unconfirmed.'),{joined:false});
          await guard();const proof=await this.runtime.probeGeneration(project,candidate);assertExtensionGenerationRuntimeProof(candidate,proof,this.runtime.runtimeGeneration(project));await guard();
          return this.jobs.finishWithLease(job.userId,job.id,job.leaseToken,{phase:'effective',reference:candidate.reference,findings:candidate.findings},async c=>{await this.service.assertCurrent(job,candidate,c);await this.service.markEffective(project,candidate,proof,c);});
        }catch(error){
          if(error.joined===false||error.code==='product_state_unavailable'&&error.joined!==true)throw Object.assign(error,{joined:false});if(error.code==='product_job_lease_lost')throw error;
          await lease();await this.service.assertAuthority(job,client);
          const restore=captured&&await this.service.canRestore(job,captured,client)?captured:baseline();
          const restored=await this.runtime.restoreGeneration(project,restore);if(restored?.joined!==true)throw Object.assign(new HttpError(503,'product_state_unavailable','Restore execution is unconfirmed.'),{joined:false});
          await lease();await this.service.assertAuthority(job,client);
          let verified=false,restoredProof=null;try{const proof=await this.runtime.probeGeneration(project,restore);assertExtensionGenerationRuntimeProof(restore,proof,this.runtime.runtimeGeneration(project));verified=true;restoredProof=proof;}catch{ /* Keep the core runtime available; no effective claim follows an unavailable proof. */ }
          const latest=await this.service.current(project),phase=verified?'rolled-back':'failed';
          return this.jobs.finishWithLease(job.userId,job.id,job.leaseToken,{phase,error:'plugin_apply_failed',restoredReference:verified?restore.reference:null},async c=>{
            await this.service.assertAuthority(job,c);await this.service.documents.put(project.userId,'extension-generation',latest.id,{...latest.payload,effective:verified&&restore.reference?restore:null,phase,runtimeGeneration:restoredProof?.runtimeGeneration??null,findings:[...latest.payload.findings,{extensionId:'selected-set',code:'plugin_apply_failed'}]},{expectedRevision:latest.revision,projectId:project.id,transactionClient:c});
          });
        }
      }finally{clearInterval(timer);await pending;}
    }));}catch(error){if(lost||error.code==='product_job_lease_lost'||error.joined===false)return null;
      try{return await this.jobs.fail(job.userId,job.id,job.leaseToken,{code:error.code??'plugin_apply_failed',message:'The extension generation was not applied.'},{retry:false});}catch(failure){if(failure.code!=='product_job_lease_lost')throw failure;return null;}}
  }
}
