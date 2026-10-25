// Native lifecycle acceptance over existing product APIs and genuine runtime tool results.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { checked } from './provision.mjs';
import { freezeCanaryMemory,fatalCollectionError } from './protocol.mjs';
import { compileExport } from './compile_export.mjs';
import { runNativeToolProbe,returnedFacts } from './native_probe.mjs';
export const requiredNativeApis=Object.freeze(['/api/memory/settings','/api/memory/profile','/api/memory/remember','/api/knowledge-pages','/api/knowledge-pages/compile','/api/knowledge-pages/tree','/api/agent-keys','/api/agent-memory/v1/recall','/api/capsules/transfers/preview','/api/capsules/transfers/import','/api/agent-runs/'+'dispatch']);
export const nativeScenarios=Object.freeze(['stale-page','revoked-page','other-memory','delete-memory','revoke-recall','capsule','expiry']);
const runtimeNativeIds=['stale-page','revoked-page','other-memory','delete-memory','revoke-recall'].map(s=>'lifecycle-'+s);
export function assertRestoredIdentity(before,after){
 if(after?.id!==before.id||after.payload?.fingerprint?.sha256!==before.payload?.fingerprint?.sha256||after.payload?.logicalPath!==before.payload?.logicalPath||!(Number(after.payload?.generation)>Number(before.payload?.generation)))throw Object.assign(new Error('Exact original restoration identity/bytes/path/generation mismatch'),{cellDefect:true,details:{before:{id:before.id,payload:before.payload},after:{id:after?.id,payload:after?.payload}}});
 return true;
}
export function lifecycleEligibility(rows,{runtimeMode,requiredNativeIds=runtimeNativeIds}={}){
 return runtimeMode==='kernel'&&rows.length===30&&rows.every(r=>['pass','fail'].includes(r.status)&&r.measured!==false)&&requiredNativeIds.every(id=>rows.some(r=>r.caseId===id&&r.nativeProof?.engine===true&&r.nativeProof?.runtime===true));
}
export class NativeUnavailable extends Error{constructor(message){super(message);this.blocked=true;}}
const insist=(ok,message)=>{if(!ok)throw new Error(message);};
async function available(api,method,url,body,statuses=[200,201]){
 if(api.evalBudget)await import('./shared_budget.mjs').then(m=>m.verifyBoundCollector(api.base,api.evalBudget.scope,api.evalBudget.config));
 const r=await api.call(method,url,body);
 if(!statuses.includes(r.status))throw new NativeUnavailable(`Required actual API ${method} ${url}: HTTP ${r.status}/${r.json?.code??'unknown'}`);
 return r.json?.data;
}
export async function nativePrerequisites(ctx){
 const a=ctx.accounts['account-alpha'];a.api.project=a.projects['project-alpha'].id;const facts={runtimeMode:ctx.runtimeMode,requiredApis:requiredNativeApis};
 if(ctx.runtimeMode!=='kernel')return {...facts,ready:false,reason:'Mock HTTP runtime cannot establish native lifecycle acceptance'};
 await available(a.api,'GET','/api/memory/settings');
 const profile=await available(a.api,'GET','/api/memory/profile');
 const knowledge=await available(a.api,'GET',`/api/knowledge-pages?projectId=${a.api.project}`);
 await available(a.api,'GET','/api/agent-keys');await available(a.api,'GET','/api/capsules');
 return {...facts,ready:Array.isArray(profile.records)&&knowledge.enabled&&knowledge.engine?.ok===true,memoryEngine:'native',knowledgeState:knowledge.state,engine:knowledge.engine,ownedExpiryFixture:!!ctx.databaseBindingsFile};
}
async function createNote(api,projectId,title,body){api.project=projectId;return (await checked(api,'POST','/api/sources/notes',{projectId,title,body})).source;}
async function controlReady(api,projectId,minimum){
 const deadline=Date.now()+180000;
 do{const state=await available(api,'GET',`/api/knowledge-pages?projectId=${projectId}`);if(state.enabled&&state.engine?.ok&&state.readable>=minimum)return state;await new Promise(r=>setTimeout(r,500));}while(Date.now()<deadline);
 throw new NativeUnavailable('Actual source sync/engine readable inventory did not become ready');
}
async function seedMemory(api,scope,marker){
 await checked(api,'PUT','/api/memory/settings',{learningPaused:false,recallPaused:false});
 const commit=await checked(api,'POST','/api/memory/remember',{projectId:scope.id,text:`For my personal notes, always use the exact heading "${marker}". Please remember this working preference.`});
 const freeze=await freezeCanaryMemory((...args)=>checked(api,...args),{seedIds:[commit.pending?.id].filter(Boolean),marker});
 const profile=await checked(api,'GET','/api/memory/profile');const records=profile.records.filter(r=>String(r.value??r.summary??'').includes(marker));
 if(!records.length)throw new NativeUnavailable('Actual native extraction completed without retaining the required canary');
 return {freeze,records};
}
function toolSucceeded(probe){return ['completed','success','succeeded'].includes(probe.tool.status)&&!probe.tool.error&&!probe.tool.output?.error;}
function toolFacts(probe){return returnedFacts(probe.tool.output);}
async function mint(api,projectId){return checked(api,'POST','/api/agent-keys',{name:'Owned W15 lifecycle probe',projectId,scopes:['memory.read'],expiresInDays:1});}
async function agentRead(api,key,route,body){
 if(api.evalBudget)await import('./shared_budget.mjs').then(m=>m.verifyBoundCollector(api.base,api.evalBudget.scope,api.evalBudget.config));
 const r=await fetch(api.base+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${key}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 let result;try{result=await r.json();}catch{result=null;}return {status:r.status,body:result};
}
export function validateExpiryBinding(actual,verified){
 if(!verified)throw new Error('Verified collector database binding missing');
 const database=new URL(actual.databaseUrl);
 if(!['127.0.0.1','localhost','::1','[::1]'].includes(database.hostname)||!['postgres:','postgresql:'].includes(database.protocol))throw new Error('Expiry database binding must use loopback PostgreSQL');
 for(const field of ['arm','collectorBase','userId','projectId'])if(actual[field]!==verified[field])throw new Error('Expiry context binding differs from verified collector');
 if(database.pathname!==`/${verified.database}`||!verified.database.startsWith('evimed_test_knowledge_evaluation_'))throw new Error('Expiry database binding differs from exact owned arm database');
 return true;
}
async function actualCollectorDatabase(ctx,owner,projectId){
 const {verifyBoundCollector}=await import('./shared_budget.mjs');
 const bound=await verifyBoundCollector(ctx.base,ctx.arm,ctx.sharedBudget),pid=bound.binding.processId;
 // Read only the exact already-verified collector process; never emit its environment or credential values.
 const env=Object.fromEntries((await fs.readFile(`/proc/${pid}/environ`,'utf8')).split('\0').filter(Boolean).map(pair=>{const at=pair.indexOf('=');return [pair.slice(0,at),pair.slice(at+1)];}));
 let url=env.OPEN_SCIENCE_DATABASE_URL??env.LIVE_DATABASE_URL;
 if(!url&&env.OPEN_SCIENCE_DATABASE_URL_FILE)url=(await fs.readFile(`/proc/${pid}/root/${env.OPEN_SCIENCE_DATABASE_URL_FILE.replace(/^\/+/,'')}`,'utf8')).trim();
 if(!url)throw new Error('Actual collector database binding cannot be verified before connection');
 const me=await checked(owner.api,'GET','/api/me');
 if(me.user?.id!==owner.userId||!ctx.receipt.created.some(r=>r.id===owner.userId&&r.runId===ctx.runId)||!Object.values(owner.projects).some(p=>p.id===projectId))throw new Error('Provisioned expiry account/project binding mismatch');
 return {arm:ctx.arm,collectorBase:new URL(ctx.base).origin,database:new URL(url).pathname.slice(1),userId:me.user.id,projectId,databaseUrl:url};
}
async function expireOwnedKey(ctx,owner,key,projectId){
 if(!ctx.databaseBindingsFile)throw new NativeUnavailable('Owned isolated databaseBindingsFile is required to advance only this expiry fixture; real API minimum TTL is one day');
 const bindings=JSON.parse(await fs.readFile(ctx.databaseBindingsFile,'utf8')),url=bindings[ctx.arm]?.url??bindings.url;
 const verified=await actualCollectorDatabase(ctx,owner,projectId);
 validateExpiryBinding({arm:ctx.arm,collectorBase:new URL(ctx.base).origin,userId:owner.userId,projectId,databaseUrl:url},verified);
 if(url!==verified.databaseUrl)throw new Error('Expiry connection binding differs from actual collector credentials/endpoint');
 const require=createRequire(new URL('../../apps/server/package.json',import.meta.url)),{Client}=require('pg');const client=new Client({connectionString:url});
 await client.connect();try{const result=await client.query("UPDATE evimed_agent.api_keys SET expires_at=now()-interval '1 second' WHERE id=$1 AND user_id=$2 AND project_id=$3 RETURNING id,expires_at",[key.id,owner.userId,projectId]);if(result.rowCount!==1)throw new Error('Owned expiry key identity mismatch');return {keyId:result.rows[0].id,expiresAt:result.rows[0].expires_at,fixtureMutation:'owned key timestamp only'};}finally{await client.end();}
}
async function signedCapsuleDoesNotGrant(ctx,source){
 const a=ctx.accounts['account-alpha'],b=ctx.accounts['account-beta'];
 const capsule=await available(a.api,'POST','/api/capsules',{title:'Owned W15 permission-context fixture',description:'Disposable lifecycle probe'});
 await checked(a.api,'POST',`/api/capsules/${capsule.id}/entries`,{factKind:'project_fact',layer:'knowledge',content:`Context refers to private source:${source.id}. Context is not authorization to its original bytes.`});
 const password=randomBytes(24).toString('hex');
 const exported=await available(a.api,'POST',`/api/capsules/${capsule.id}/exports`,{password,scopes:['workstyle','+knowledge']});
 if(typeof exported.archive!=='string'||!exported.snapshot?.id)throw new NativeUnavailable('Actual signed capsule archive/snapshot was not produced');
 const preview=await available(b.api,'POST','/api/capsules/transfers/preview',{archive:exported.archive,password});
 if(preview.issuerTrust!=='verified'||!preview.canImport)throw new NativeUnavailable('Actual capsule signature/issuer verification did not establish an importable pack');
 const imported=await available(b.api,'POST','/api/capsules/transfers/import',{archive:exported.archive,password,expectedDigest:preview.archiveSha256,confirmed:true,title:'Owned imported permission context'});
 await available(b.api,'POST',`/api/capsules/${imported.id}/enable`,{projectId:b.projects['project-alpha'].id});
 const denied=await b.api.call('GET',`/api/sources/${source.id}`);
 insist([403,404].includes(denied.status),'Signed capsule import granted foreign original source access');
 return {snapshotId:exported.snapshot.id,archiveSha256:preview.archiveSha256,issuerTrust:preview.issuerTrust,importedCapsuleId:imported.id,foreignSourceReadStatus:denied.status,credentialRecorded:false};
}
export async function runNativeLifecycle(c,ctx){
 const receipts=[],proofs=[];const a=ctx.accounts['account-alpha'],b=ctx.accounts['account-beta'],scopeA=a.projects['project-alpha'],scopeB=a.projects['project-beta'];a.api.project=scopeA.id;b.api.project=b.projects['project-alpha'].id;
 if(ctx.runtimeMode!=='kernel')return {caseId:c.id,status:'blocked',blocked:'Real native engine/runtime required; mock HTTP is not native acceptance',receipts,qualityRun:false};
 try{
  const prerequisites=await nativePrerequisites(ctx);if(!prerequisites.ready)throw new NativeUnavailable(`Actual native prerequisites unavailable: ${JSON.stringify(prerequisites)}`);
  const marker=`W15FACT_${randomBytes(5).toString('hex')}`;
  if(c.scenario==='expiry'){
   const key=await mint(a.api,scopeA.id),before=await agentRead(a.api,key.key,'/api/agent-memory/v1/records');insist(before.status===200,'Owned expiring credential was not initially usable');
   const expired=await expireOwnedKey(ctx,a,key,scopeA.id),after=await agentRead(a.api,key.key,'/api/agent-memory/v1/records');insist(after.status===401,'Expired AgentMemory credential still authorizes access');receipts.push({operation:'actual-expiring-AgentMemory-credential',...expired,beforeStatus:before.status,afterStatus:after.status,tokenRecorded:false});
  }else if(c.scenario==='capsule'){
   const source=await createNote(a.api,scopeA.id,'Owned private context '+marker,marker);receipts.push(await signedCapsuleDoesNotGrant(ctx,source));
  }else if(['other-memory','delete-memory'].includes(c.scenario)){
   const seeded=await seedMemory(a.api,scopeA,marker);receipts.push({operation:'native-memory-seed-frozen',hash:seeded.freeze.hash,recordIds:seeded.records.map(r=>r.id),pending:0});
   const before=await runNativeToolProbe(a.api,scopeA,'mcp__openviking__search',{query:marker});proofs.push(before);if(!toolSucceeded(before)||!toolFacts(before).includes(marker))throw new NativeUnavailable('Actual native search did not retrieve its materialized canary before the test');
   if(c.scenario==='other-memory'){
    await available(b.api,'GET','/api/memory/profile');
    const after=await runNativeToolProbe(b.api,b.projects['project-alpha'],'mcp__openviking__search',{query:marker});proofs.push(after);insist(toolSucceeded(after)&&!toolFacts(after).includes(marker),'Cross-account native recall exposed the owner memory');
   }else{
    for(const record of seeded.records)await checked(a.api,'DELETE',`/api/memory/records/${encodeURIComponent(record.id)}`);
    const after=await runNativeToolProbe(a.api,scopeA,'mcp__openviking__search',{query:marker});proofs.push(after);insist(toolSucceeded(after)&&!toolFacts(after).includes(marker),'Deleted native memory remains recallable');
   }
  }else{
   const source=await createNote(a.api,scopeA.id,'Owned evidence '+marker,`The unique source fact is ${marker}. This paragraph is the original source to cite.`);
   const shared=c.scenario!=='stale-page',scope=shared?scopeB:scopeA;
   if(shared)await checked(a.api,'POST','/api/library',{sourceId:source.id});
   a.api.project=scope.id;for(let i=0;i<8;i++)await createNote(a.api,scope.id,`Context ${marker} ${i}`,`Context document ${i} for ${marker}. It contains no replacement of the original unique source fact.`);
   await controlReady(a.api,scope.id,8);
   if(c.scenario==='revoke-recall'){
    const before=await runNativeToolProbe(a.api,scope,'kb_search',{query:marker,limit:10,sourceIds:[source.id]});proofs.push(before);if(!toolSucceeded(before)||!toolFacts(before).includes(source.id))throw new NativeUnavailable('Shared source was not genuinely retrievable before revocation');
    await checked(a.api,'DELETE',`/api/library/${source.id}`);
    const after=await runNativeToolProbe(a.api,scope,'kb_search',{query:marker,limit:10,sourceIds:[source.id]});proofs.push(after);insist(toolSucceeded(after)&&!toolFacts(after).includes(source.id),'Revoked library source remains in actual runtime retrieval');
   }else{
    const compile=await compileExport({api:a.api,projectId:scope.id,sourceMap:{[source.id]:source.id},outDir:path.join(ctx.privateDir,'native-compiled',c.scenario),topicId:'owned-fixture',repetition:1});receipts.push({operation:'actual-official-compile',round:compile.status.round,pages:compile.pages.length});
    const tree=await checked(a.api,'GET',`/api/knowledge-pages/tree?projectId=${scope.id}`);let page;
    for(const row of tree.pages.filter(p=>p.tree==='wiki')){const view=await checked(a.api,'GET',`/api/knowledge-pages/page?sourceId=${row.sourceId}`);if(view.links?.some(l=>l.sourceId===source.id&&l.available)){page=row;break;}}
    if(!page)throw new NativeUnavailable('Genuine compiled tree did not cite the required available source; native stale-source fixture is incomplete');
    const input={op:'read',root:'wiki',path:page.path},before=await runNativeToolProbe(a.api,scope,'kb_browse',input);proofs.push(before);if(!toolSucceeded(before))throw new NativeUnavailable('Actual runtime could not read the compiled page before source removal');
    if(shared)await checked(a.api,'DELETE',`/api/library/${source.id}`);else{a.api.project=scopeA.id;await checked(a.api,'DELETE',`/api/sources/${source.id}`,{expectedRevision:(await checked(a.api,'GET',`/api/sources/${source.id}`)).revision});a.api.project=scope.id;}
    const after=await runNativeToolProbe(a.api,scope,'kb_browse',input);proofs.push(after);const refusal=JSON.stringify(after.tool.output)+' '+JSON.stringify(after.tool.error);
    insist(!toolSucceeded(after)&&/kb_browse_not_found|no longer available|404/i.test(refusal),'Compiled page remained readable after its source became ineligible');
   }
  }
  const exportedProofs=proofs.map(p=>({runId:p.runId,runStatus:p.runStatus,tool:p.tool}));
  for(const [i,p]of proofs.entries()){const dir=path.join(ctx.privateDir,'native-probe-evidence');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,`${c.id}-${i}-${p.runId}.jsonl`),p.transcript);}
  return {caseId:c.id,status:'pass',measured:true,receipts,proofs:exportedProofs,nativeProof:proofs.length?{engine:true,runtime:true,runIds:proofs.map(p=>p.runId)}:undefined,qualityRun:false};
 }catch(error){if(fatalCollectionError(error))throw error;return {caseId:c.id,status:error.blocked?'blocked':'fail',measured:!error.blocked,nativeProof:proofs.length>=2?{engine:true,runtime:true,runIds:proofs.map(p=>p.runId)}:undefined,blocked:error.blocked?error.message:null,error:error.blocked?null:error.message,receipts,proofs:proofs.map(p=>({runId:p.runId,tool:p.tool})),qualityRun:false};}finally{
  const dir=ctx.evidenceDir??path.join(ctx.privateDir,'native-probe-evidence');
  if(proofs.length){await fs.mkdir(dir,{recursive:true});for(const [i,p]of proofs.entries())await fs.writeFile(path.join(dir,`${c.id}-${i}-${p.runId}.jsonl`),p.transcript);}
 }
}
