/** Monotonic stop intent, distinct from the kernel's cancellation outcome.
 * Immutable owner-local receipts are fsynced before wire admission; the PG set
 * provides the cross-controller index without sharing mutable learning gauges. */
import path from 'node:path';
import {createHash} from 'node:crypto';
import {migrateProductStore} from './productPersistence.mjs';
import {HttpError,openScopedFileNoFollow,writeFileExclusiveNoFollow} from './security.mjs';
export class RuntimePromptStops {
 /** @param {{database?:any,maxBytes?:number}} options */
 constructor({database=null,maxBytes=1024*1024}={}){this.database=database;this.maxBytes=maxBytes;}
 file(project,sessionId,runId){return path.join(project.metaDir,'prompt-stops',`${createHash('sha256').update(JSON.stringify([sessionId,runId])).digest('hex')}.json`);}
 async local(project,sessionId,runId){
  if(!project.rootDir||!project.metaDir)return false;let opened;
  try{opened=await openScopedFileNoFollow(project.rootDir,this.file(project,sessionId,runId));if(opened.stat.size>this.maxBytes)throw new HttpError(413,'agent_runs_too_large','Prompt stop receipt exceeds the ledger budget.');const value=JSON.parse(await opened.handle.readFile('utf8'));return value.ownerId===project.userId&&value.projectId===project.id&&value.sessionId===sessionId&&value.runId===runId;}
  catch(error){if(['ENOENT','file_not_found','directory_not_found'].includes(error?.code))return false;throw error;}
  finally{await opened?.handle.close();}
 }
 async record(project,sessionId,runIds){
  const ids=[...new Set(runIds)];if(!ids.length)return;
  if(project.rootDir&&project.metaDir)for(const runId of ids){
   const text=JSON.stringify({ownerId:project.userId,projectId:project.id,sessionId,runId});
   if(Buffer.byteLength(text)>this.maxBytes)throw new HttpError(413,'agent_runs_too_large','Prompt stop receipt exceeds the ledger budget.');
   try{await writeFileExclusiveNoFollow(project.rootDir,this.file(project,sessionId,runId),text,{encoding:'utf8',mode:0o600});}
   catch(error){if(error?.code!=='EEXIST'||!await this.local(project,sessionId,runId))throw error;}
  }
  if(this.database){await migrateProductStore(this.database);await this.database.query(`INSERT INTO evimed_product.prompt_stop_intents(user_id,project_id,session_id,run_id)
   SELECT $1,$2,$3,id FROM unnest($4::text[]) AS id ON CONFLICT DO NOTHING`,[project.userId,project.id,sessionId,ids]);}
 }
 async has(project,sessionId,runId){
  if(await this.local(project,sessionId,runId))return true;
  if(this.database){await migrateProductStore(this.database);return Boolean((await this.database.query('SELECT 1 FROM evimed_product.prompt_stop_intents WHERE user_id=$1 AND project_id=$2 AND session_id=$3 AND run_id=$4',[project.userId,project.id,sessionId,runId])).rows.length);}
  return false;
 }
}
