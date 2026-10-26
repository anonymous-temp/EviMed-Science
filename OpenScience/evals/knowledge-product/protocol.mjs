import {reviewRequest,validateSeedReview,verifyReviewedProfile,REVIEWED_SEED_MODE} from './seed_review.mjs';
import {seedMemoryProof} from './personal_context.mjs';
import { createHash } from 'node:crypto';
export const memoryHash=profile=>createHash('sha256').update(JSON.stringify((profile.records??[]).map(r=>({id:r.id,value:r.value,version:r.version})).sort((a,b)=>String(a.id).localeCompare(String(b.id))))).digest('hex');
export async function freezeSeededMemory(call,{seedIds,requiredSeeds=[],judge,reviewSeeds,reviewIdentity,reviewTimeoutMs=120000,sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=180000}={}) {
 if(typeof judge!=='function')throw new Error('Semantic seed judge is required for freeze');
 if(!requiredSeeds?.length)throw new Error('Native freeze requires authored seed provenance');
 if(!seedIds?.length)throw new Error('Native seeding completion receipts missing');
 const deadline=Date.now()+timeoutMs;let profile;
 do{
  profile=await call('GET','/api/memory/profile');
  if(Array.isArray(profile.pending)&&profile.pending.length===0&&profile.records?.length){
   const settings=await call('PUT','/api/memory/settings',{learningPaused:true,recallPaused:false});
   if(settings.learningPaused!==true||settings.recallPaused!==false)throw Error('Native memory freeze was not applied');
   const verified=await call('GET','/api/memory/settings');
   const frozen=await call('GET','/api/memory/profile');
   if(verified.learningPaused!==true||verified.recallPaused!==false||frozen.pending?.length||memoryHash(frozen)!==memoryHash(profile))throw Error('Frozen memory identity changed during preparation');
   let reviewManifest=null,review=null;
   if(reviewSeeds)try{
    if(!Number.isSafeInteger(reviewTimeoutMs)||reviewTimeoutMs<1||reviewTimeoutMs>600000)throw Error('Bounded seed review timeout required');
    const request=reviewRequest(reviewIdentity,requiredSeeds,frozen);
    if(reviewRequest(reviewIdentity,requiredSeeds,profile).profileSha256!==request.profileSha256)throw Error('Native URI/body profile changed while freezing');
    let timer;
    try{reviewManifest=await Promise.race([reviewSeeds(request),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native seed review timed out; preparation inconclusive')),reviewTimeoutMs);})]);}finally{clearTimeout(timer);}
    review=validateSeedReview(request,reviewManifest);
   }catch(error){error.seedPreparationHeld=true;throw error;}
   let provenance;
   try{provenance=await seedMemoryProof(requiredSeeds,frozen,{judge,selectedRecords:review?.selected});}catch(error){if(review)error.seedPreparationHeld=true;throw error;}
   const afterSettings=await call('GET','/api/memory/settings');
   if(afterSettings.learningPaused!==true||afterSettings.recallPaused!==false)throw Object.assign(Error('Frozen memory settings changed during seed review'),{seedPreparationHeld:Boolean(review)});
   const after=await call('GET','/api/memory/profile');
   if(review)try{verifyReviewedProfile({mode:REVIEWED_SEED_MODE,reviewSeeds:requiredSeeds,reviewManifest,reviewManifestSha256:review.manifestSha256,reviewRequestSha256:review.requestSha256},requiredSeeds,after,reviewIdentity);}catch(error){error.seedPreparationHeld=true;throw error;}
   else if(memoryHash(after)!==memoryHash(frozen)||after.pending?.length)throw Error('Frozen memory identity changed during semantic freeze');
   return {mode:review?REVIEWED_SEED_MODE:'semantic-authored-seed',...(review?{reviewIdentity,reviewSeeds:requiredSeeds,reviewManifest,reviewManifestSha256:review.manifestSha256,reviewRequestSha256:review.requestSha256,reviewMethod:reviewManifest.method}:{}),seedIds:[...seedIds],provenance,pending:0,records:profile.records.length,hash:memoryHash(profile),settings:afterSettings};
  }
  await sleep(500);
 }while(Date.now()<deadline);
 throw new Error('Native seeding incomplete; refusing to freeze pending work');
}
export async function freezeCanaryMemory(call,{seedIds,marker,sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=180000}={}){
 if(!seedIds?.length||typeof marker!=='string'||!marker.trim())throw Error('Explicit canary identity and receipt required');
 const deadline=Date.now()+timeoutMs;
 do{
  const profile=await call('GET','/api/memory/profile');
  const matches=(profile.records??[]).filter(r=>String(r.value??'').includes(marker)&&/^viking:\/\/user\/[^/]+\/memories\//.test(r.document?.uri??r.uri??r.id??''));
  if(profile.pending?.length===0&&matches.length){
   await call('PUT','/api/memory/settings',{learningPaused:true,recallPaused:false});
   const settings=await call('GET','/api/memory/settings'),after=await call('GET','/api/memory/profile');
   if(settings.learningPaused!==true||settings.recallPaused!==false||after.pending?.length||memoryHash(after)!==memoryHash(profile))throw Error('Canary freeze identity changed');
   return {mode:'canary-presence-only',semanticEligible:false,seedIds,marker,provenance:matches.map(r=>({uri:r.document?.uri??r.uri??r.id})),hash:memoryHash(profile),settings};
  }
  await sleep(500);
 }while(Date.now()<deadline);
 throw Error('Controlled native canary not ready');
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
