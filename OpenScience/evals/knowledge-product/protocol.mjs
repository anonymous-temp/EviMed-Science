import { createHash } from 'node:crypto';
export const memoryHash=profile=>createHash('sha256').update(JSON.stringify((profile.records??[]).map(r=>({id:r.id,value:r.value,version:r.version})).sort((a,b)=>String(a.id).localeCompare(String(b.id))))).digest('hex');
export async function freezeSeededMemory(call,{seedIds,sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=180000}={}) {
 if(!seedIds?.length)throw new Error('Native seeding completion receipts missing');
 const deadline=Date.now()+timeoutMs;let profile;
 do{
  profile=await call('GET','/api/memory/profile');
  if(profile.engine!=='native')throw new Error('Native memory identity mismatch');
  if(Array.isArray(profile.pending)&&profile.pending.length===0&&profile.records?.length){
   const settings=await call('PUT','/api/memory/settings',{learningPaused:true,recallPaused:false});
   if(settings.learningPaused!==true||settings.recallPaused!==false)throw new Error('Native memory freeze was not applied');
   const verified=await call('GET','/api/memory/settings');
   if(verified.learningPaused!==true||verified.recallPaused!==false)throw new Error('Native memory freeze identity mismatch');
   return {seedIds:[...seedIds],pending:0,records:profile.records.length,hash:memoryHash(profile),settings:verified};
  }
  await sleep(500);
 }while(Date.now()<deadline);
 throw new Error('Native seeding incomplete; refusing to freeze pending work');
}
export function fatalCollectionError(error){if(error?.cancellationUnconfirmed)return true;if(error?.cellDefect)return false;return /budget|wiring|listener|identity|auth|csrf|HTTP (401|403)|frozen memory/i.test(String(error?.message??error));}
export async function collectIndependentCells(cells,execute,record){
 const rows=[];
 for(const cell of cells){
  try{const result=await execute(cell);const row={cell,status:'collected',result};rows.push(row);await record(row);}
  catch(error){const row={cell,status:'inconclusive',reason:String(error.message),partialFile:error.partialFile??null,fatal:fatalCollectionError(error)};rows.push(row);await record(row);if(row.fatal)throw error;}
 }
 return rows;
}

// A cancel acknowledgement is not proof that the producer has stopped.
export async function cancelAndConfirmTerminal(api,run,{timeoutMs=15000,requestTimeoutMs=5000,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}){
 const evidence={runId:run.id,cancelResponse:null,lastStatus:run.status};
 const deadline=now()+timeoutMs;
 const bounded=async(method,url,body)=>{
  let timer;
  try{return await Promise.race([api.call(method,url,body),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cancellation network deadline exceeded')),Math.max(1,Math.min(requestTimeoutMs,deadline-now())));})]);}
  finally{clearTimeout(timer);}
 };
 try{
  const response=await bounded('POST',`/api/agent-runs/${run.id}/cancel`,{});
  evidence.cancelResponse={status:response.status,body:response.json};
  if(response.status>=400)throw new Error(`Cancellation HTTP ${response.status}`);
  while(now()<deadline){
   const listed=await bounded('GET','/api/agent-runs');
   if(listed.status>=400)throw new Error(`Cancellation status HTTP ${listed.status}`);
   const data=listed.json?.data;
   const rows=Array.isArray(data)?data:data?.items??data?.runs??[];
   const observed=rows.find(row=>row.id===run.id);
   evidence.lastStatus=observed?.status??null;
   if(['succeeded','failed','cancelled'].includes(evidence.lastStatus))return evidence;
   await sleep(Math.min(250,Math.max(0,deadline-now())));
  }
  throw new Error('Cancellation terminal status unconfirmed');
 }catch(cause){
  const error=new Error(`Cancellation unconfirmed: ${cause.message}`,{cause});
  error.cancellationUnconfirmed=true;error.cancellationEvidence=evidence;throw error;
 }
}
