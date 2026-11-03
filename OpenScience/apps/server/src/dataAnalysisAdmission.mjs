/** Dispatch locks must not occupy the query pool: even one lock owner would deadlock a pool of one. */
import pg from 'pg';
import { HttpError } from './security.mjs';

/** @param {any} config @param {{clientFactory?:(config:any)=>any}} options */
export function createDataAnalysisDispatchLock(config,{clientFactory=options=>new pg.Client(options)}={}){
  let active=0;
  const maximum=config.dataAnalysisMaxDispatches??4;
  return async(userId,turnId,operation)=>{
    if(active>=maximum)throw new HttpError(429,'analysis_dispatch_capacity','Analysis dispatch capacity is occupied. Retry the same requestId.');
    active++;
    let client;
    try{client=clientFactory({connectionString:config.databaseUrl,connectionTimeoutMillis:config.databaseConnectionTimeoutMs??10000,
      query_timeout:10000,application_name:'evimed-data-analysis-admission'});}
    catch{active--;throw new HttpError(503,'analysis_dispatch_admission_unavailable','Analysis dispatch admission is unavailable.');}
    let lost=false;
    const onError=()=>{lost=true;};client.on('error',onError);
    const assertLock=async()=>{
      if(lost)throw new HttpError(503,'analysis_dispatch_lock_lost','Analysis dispatch admission was interrupted. Query the same turn.');
      try{await client.query('SELECT 1');}
      catch{lost=true;throw new HttpError(503,'analysis_dispatch_lock_lost','Analysis dispatch admission was interrupted. Query the same turn.');}
    };
    try{
      await client.connect();await client.query('BEGIN');
      const locked=await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked',[`data-analysis:${userId}`,turnId]);
      const result=await operation(locked.rows[0]?.locked?assertLock:null);
      await assertLock();await client.query('COMMIT');return result;
    }catch(error){
      if(error instanceof HttpError)throw error;
      throw new HttpError(503,'analysis_dispatch_admission_unavailable','Analysis dispatch admission is unavailable. Query or retry the same requestId.');
    }finally{
      // Closing this dedicated connection releases its transaction even after a lost COMMIT acknowledgement.
      lost=true;await client.end().catch(()=>{});client.removeListener('error',onError);active--;
    }
  };
}
