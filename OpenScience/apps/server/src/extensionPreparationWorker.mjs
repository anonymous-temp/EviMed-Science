import {randomUUID} from 'node:crypto';
import {canonicalExtensionCoordinate,canonicalJson} from '@evimed/domain';
import {HttpError} from './security.mjs';
import {extensionPreparationIdentity} from './extensionToolController.mjs';
import {heavyWorkAdmission} from './heavyWorkAdmission.mjs';
/** Leased preparation of admitted artifacts only; never arbitrary acquisition or SaaS qualification. */
export class ExtensionPreparationWorker{
  /** @param {{service:any,controller:any,admittedArtifacts:any[],onPrepared?:any,leaseMs?:number,pollMs?:number}} dependencies */
  constructor({service,controller,admittedArtifacts,onPrepared=null,leaseMs=60000,pollMs=1000}){
    this.service=service;this.database=service.database;this.jobs=service.jobs;this.controller=controller;this.artifacts=new Map(admittedArtifacts.map(item=>[item.id,structuredClone(item)]));
    this.leaseMs=leaseMs;this.pollMs=pollMs;this.workerId=`extension-prepare-${randomUUID()}`;this.running=null;this.timer=null;this.active=new Map();this.lastError=null;
    this.onPrepared=onPrepared;
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>{void this.tick();},this.pollMs);this.timer.unref();void this.tick();}
  async close(){clearInterval(this.timer);this.timer=null;await this.running;}
  async tick(){if(this.running)return this.running;this.running=this.run().catch(error=>{this.lastError=error?.code??'product_state_unavailable';return null;}).finally(()=>{this.running=null;});return this.running;}
  /** @param {any} job @param {any} client */
  async assertCurrent(job,client){
    const user={id:job.userId,accountCreatedAt:job.payload.accountCreatedAt};
    const epoch=await this.service.access.account(user,client);if(epoch!==job.payload.accountCreatedAt)throw new HttpError(401,'unauthorized','The account generation changed.');
    const row=(await client.query("SELECT revision,payload FROM evimed_product.documents WHERE user_id=$1 AND kind='extension-installation' AND id=$2 AND deleted_at IS NULL FOR SHARE",[job.userId,job.payload.installationId])).rows[0];
    if(!row||row.revision!==job.payload.installationRevision||row.payload.prepareJobId!==job.id||row.payload.integrity!==job.payload.integrity||row.payload.catalogueId!==job.payload.catalogueId||canonicalExtensionCoordinate(row.payload.coordinate)!==job.payload.coordinate)throw new HttpError(409,'product_revision_conflict','The saved installation changed.');
    const entry=this.service.entries.get(job.payload.catalogueId),artifact=this.artifacts.get(job.payload.catalogueId);
    if(!entry||entry.executionClass!=='isolated-tool'||!artifact||artifact.integrity!==job.payload.integrity||canonicalExtensionCoordinate(artifact.coordinate)!==job.payload.coordinate||canonicalExtensionCoordinate(entry.coordinate)!==job.payload.coordinate||entry.integrity!==job.payload.integrity)throw new HttpError(400,'extension_contract_invalid','This artifact is not supported by the preparation adapter.');
    const target=job.payload.projectTarget??null;
    if(target){const project=await this.service.access.project(user,target.projectId,{manage:true,client});if((project.extensionMembershipEpoch??null)!==target.membershipEpoch||project.userId!==target.ownerId||!target.projectCreatedAt||project.projectCreatedAt!==target.projectCreatedAt)throw new HttpError(404,'project_not_found','The project generation changed.');}
    return{artifact,identity:extensionPreparationIdentity({jobId:job.id,leaseToken:job.leaseToken,attempts:job.attempts,installationId:job.payload.installationId,installationRevision:job.payload.installationRevision,accountCreatedAt:epoch,projectTarget:target})};
  }
  /** @param {any} job */
  async guard(job){if(!await this.jobs.renew(job.userId,job.id,job.leaseToken,this.leaseMs))throw new HttpError(409,'product_job_lease_lost','Preparation ownership changed.');
    const current=await this.jobs.withLease(job.userId,job.id,job.leaseToken,client=>this.assertCurrent(job,client));if(!current)throw new HttpError(409,'product_job_lease_lost','Preparation ownership changed.');return current;}
  /** Expired preparation is joined against its original attempt before any retry.
   * Unknown cleanup holds both job state and host capacity. */
  async recover(){
    const rows=(await this.database.query("SELECT user_id,id FROM evimed_product.jobs WHERE kind='extension-prepare' AND status='running' AND lease_expires_at<=clock_timestamp() ORDER BY lease_expires_at,id LIMIT 20")).rows;
    for(const row of rows){
      const job=await this.jobs.get(row.user_id,row.id);
      if(!job||job.status!=='running'||!job.leaseToken||!job.payload.accountCreatedAt)continue;
      const identity=extensionPreparationIdentity({jobId:job.id,leaseToken:job.leaseToken,attempts:job.attempts,installationId:job.payload.installationId,installationRevision:job.payload.installationRevision,accountCreatedAt:job.payload.accountCreatedAt,projectTarget:job.payload.projectTarget??null});
      let ack;try{ack=await this.controller.cancelPreparation(identity);}catch{continue;}
      if(ack?.joined!==true||ack.physicallyAbsent!==true||ack.settled!==true||canonicalJson(ack.identity??{})!==canonicalJson(identity))continue;
      await this.database.transaction(client=>this.database.withTransactionClient(client,async()=>{
        const current=(await client.query("SELECT lease_token,attempts,status,lease_expires_at<clock_timestamp() AS expired FROM evimed_product.jobs WHERE user_id=$1 AND id=$2 FOR UPDATE",[job.userId,job.id])).rows[0];
        if(!current||current.status!=='running'||!current.expired||current.lease_token!==job.leaseToken||current.attempts!==job.attempts)return;
        let reusable=job.attempts<job.maxAttempts;
        if(reusable)try{await this.assertCurrent(job,client);}catch{reusable=false;}
        await client.query(`UPDATE evimed_product.jobs SET status=$3,lease_token=NULL,lease_expires_at=NULL,worker_id=NULL,
          run_after=clock_timestamp(),finished_at=CASE WHEN $3='failed' THEN clock_timestamp() ELSE NULL END,
          error=CASE WHEN $3='failed' THEN '{"code":"product_state_unavailable","message":"Joined preparation could not resume."}'::jsonb ELSE NULL END
          WHERE user_id=$1 AND id=$2 AND lease_token=$4`,[job.userId,job.id,reusable?'queued':'failed',job.leaseToken]);
      }));
    }
  }
  /** Durable post-preparation scheduling resumes after a process restart. */
  async reconcilePrepared(){
    if(!this.onPrepared)return;
    const rows=(await this.database.query("SELECT user_id,id FROM evimed_product.jobs WHERE kind='extension-prepare' AND status='succeeded' AND result->>'activationIntentQueued' IS DISTINCT FROM 'true' ORDER BY finished_at,id LIMIT 20")).rows;
    for(const row of rows){const job=await this.jobs.get(row.user_id,row.id);if(!job||job.status!=='succeeded')continue;
      try{await this.onPrepared(job);await this.database.query("UPDATE evimed_product.jobs SET result=jsonb_set(result,'{activationIntentQueued}','true') WHERE user_id=$1 AND id=$2 AND status='succeeded'",[job.userId,job.id]);}
      catch(error){this.lastError=error?.code??'product_state_unavailable';}}
  }
  async run(){
    await this.recover();await this.reconcilePrepared();
    const job=await this.jobs.claim(['extension-prepare'],this.workerId,{leaseMs:this.leaseMs,admission:client=>this.database.withTransactionClient(client,async()=>await heavyWorkAdmission(client,'render')&&this.controller.admissionAvailable())});if(!job)return null;
    const abort=new AbortController();let renewal=null;
    try{
      const current=await this.guard(job);this.active.set(job.id,{job,identity:current.identity});
      renewal=setInterval(()=>{void this.guard(job).catch(()=>abort.abort());},Math.floor(this.leaseMs/3));renewal.unref();
      const result=await this.controller.prepare({descriptorId:job.payload.catalogueId,identity:current.identity},{signal:abort.signal});
      if(result.artifactDigest!==current.artifact.artifactDigest||result.integrity!==job.payload.integrity||result.coordinate!==job.payload.coordinate||result.qualified!==false||result.joined!==true)throw new HttpError(400,'extension_contract_invalid','The artifact preparation identity did not match.');
      await this.guard(job);
      const finished=await this.jobs.finishWithLease(job.userId,job.id,job.leaseToken,{installationId:job.payload.installationId,installationRevision:job.payload.installationRevision,integrity:job.payload.integrity,artifactDigest:result.artifactDigest,coordinate:result.coordinate,qualified:false},client=>this.assertCurrent(job,client));
      if(this.onPrepared)try{await this.onPrepared(job);await this.database.query("UPDATE evimed_product.jobs SET result=jsonb_set(result,'{activationIntentQueued}','true') WHERE user_id=$1 AND id=$2 AND status='succeeded'",[job.userId,job.id]);}catch(error){this.lastError=error?.code??'product_state_unavailable';}
      return finished;
    }catch(error){
      if(error?.canceled||error?.joined===false||error?.code==='product_state_unavailable'&&error?.joined!==true||error?.code==='product_job_lease_lost')return null;
      try{return await this.jobs.fail(job.userId,job.id,job.leaseToken,{code:error?.code??'product_state_unavailable',message:'The extension preparation was refused.'},{retry:false});}catch(failure){if(failure.code!=='product_job_lease_lost')throw failure;return null;}
    }finally{clearInterval(renewal);this.active.delete(job.id);}
  }
  /** @param {any} identity */
  async cancelPreparation(identity){const active=this.active.get(identity.jobId);if(!active||canonicalJson(identity)!==canonicalJson(active.identity))throw new HttpError(409,'product_revision_conflict','The preparation attempt changed.');await this.guard(active.job);return this.controller.cancelPreparation(identity);}
}
