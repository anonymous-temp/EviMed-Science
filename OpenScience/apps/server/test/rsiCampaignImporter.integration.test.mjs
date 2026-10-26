import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID,generateKeyPairSync,sign } from 'node:crypto'
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs'
import { RsiCampaignImporter } from '../src/rsiCampaignImporter.mjs'
import { rsiDigest,signRsiCampaignBundle } from '../src/rsiCampaignBundle.mjs'
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??''
if(url){const u=new URL(url);assert.ok(['localhost','127.0.0.1','::1'].includes(u.hostname));assert.match(u.pathname,/evimed_test/)}
const {publicKey,privateKey}=generateKeyPairSync('ed25519'),hash=rsiDigest('test')
/** @param {any} database @param {string} owner */
async function fixture(database,owner,surface='frontier-selection'){
 const target={surface,dependencyDigest:hash,baselineRevision:'base'}
 const qualification=Object.fromEntries(['registrationDigest','datasetDigest','measurementDigest','consumerDigest','evaluatorDigest','procedureDigest','qualificationDigest','corpusDigest'].map(k=>[k,hash]))
 const files=[{path:'policy.json',content:'{"limit":2}'}]
 const manifest={id:'bundle',campaignId:'campaign',surface:target.surface,kind:'policy',target,createdAt:'2026-10-26T00:00:00Z',expiresAt:'2026-10-27T00:00:00Z',verdict:{status:'qualified',scope:target.surface,...qualification,candidateDigest:rsiDigest(files)}}
 const envelope=await signRsiCampaignBundle({manifest,files,keyId:'publisher',signer:bytes=>sign(null,bytes,privateKey)})
 let installed=null,publications=0,failAfterPublish=false,rollbacks=0,bound=true
 const options={database,owner,validateAdmission:async()=>true,now:()=> '2026-10-26T12:00:00Z',isBound:()=>bound,currentTarget:async()=>({...target}),verificationOptions:async()=>({trustStore:{publisher:{publicKey,surfaces:[target.surface],kinds:['policy']}},expectedIdentity:{id:manifest.id,campaignId:manifest.campaignId},qualification:{...qualification,scope:target.surface,verifyReceipt:()=>true},currentTarget:{...target}}),activationPolicy:async()=>({mode:'shadow',minExecutions:100,minDays:3,maxErrors:0}),verifyObservation:async proof=>proof?.trusted?proof:null,adapters:{policy:{inspect:async()=>{if(failAfterPublish && installed){failAfterPublish=false;throw Error('process lost after external publish')}return installed},publish:async input=>{assert.equal(input.phase,'stage');publications++;installed={operationId:input.operationId,phase:input.phase,candidateDigest:rsiDigest(input.files),revision:'candidate',installed:true}},rollback:async input=>{rollbacks++;return {...input,installed:true}}}}}
 return {options,envelope,manifest,target,files,importer:new RsiCampaignImporter(options),publications:()=>publications,rollbacks:()=>rollbacks,crash:()=>{failAfterPublish=true},unbind:()=>{bound=false}}
}
/** @param {(database:any,owner:string)=>Promise<void>} operation */
async function withDatabase(operation){const database=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:4,databaseConnectionTimeoutMs:2000}),owner=`rsi_import_${randomUUID().replaceAll('-','')}`;try{await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'RSI importer test','development')",[owner]);await operation(database,owner)}finally{await database.query('DELETE FROM evimed_control.users WHERE id=$1',[owner]);await database.close()}}
const skip={skip:!url&&'Disposable localhost PostgreSQL required'}
test('publication adapters reuse the importer transaction instead of opening a nested surface lock',skip,()=>withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner),seen=new Set()
 for(const method of ['inspect','publish','rollback']){
  const original=f.options.adapters.policy[method]
  f.options.adapters.policy[method]=async input=>{
   assert.equal(typeof input.transactionClient?.query,'function',`${method} must receive its owning transaction`)
   await input.transactionClient.query('SELECT 1')
   seen.add(method)
   return original(input)
  }
 }
 f.options.verifyObservation=async(proof,_row,options)=>{
  assert.equal(typeof options?.transactionClient?.query,'function','consumer witness must share the owning transaction')
  await options.transactionClient.query('SELECT 1')
  return proof?.trusted?proof:null
 }
 const importer=new RsiCampaignImporter(f.options),row=await importer.importBundle(f.envelope)
 await importer.observe('bundle',{trusted:true,id:'fenced-critical',operationId:row.operationId,candidateDigest:rsiDigest(f.files),arm:'shadow',revision:'candidate',day:'2026-10-26',outcome:'critical',criticalCode:'corrupt-bytes'})
 assert.deepEqual([...seen].sort(),['inspect','publish','rollback'])
}))
test('invalid signature and unbound import cause no journal or adapter effects',skip,()=>withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner)
 assert.equal((await f.importer.importBundle({...f.envelope,payload:f.envelope.payload+' '})).state,'rejected')
 const rows=await database.query("SELECT id FROM evimed_product.documents WHERE user_id=$1",[owner]);assert.equal(rows.rowCount,0)
 f.unbind();assert.equal((await f.importer.importBundle(f.envelope)).state,'waiting');assert.equal(f.publications(),0)
}))
test('concurrent import is durable once-only; shadow serves incumbent; witness and fuse rollback are real identities',skip,()=>withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner),other=new RsiCampaignImporter(f.options)
 const rows=await Promise.all([f.importer.importBundle(f.envelope),other.importBundle(f.envelope)])
 assert.equal(rows.every(row=>row.state==='exposed'),true);assert.equal(f.publications(),1)
 const selected=await other.select(f.target.surface,{userId:'u',projectId:'p'});assert.equal(selected.revision,'base');assert.equal(selected.shadowRevision,'candidate')
 await assert.rejects(other.observe('bundle',true),{code:'campaign_consumer_witness_invalid'})
 const witness={trusted:true,id:'execution-1',operationId:rows[0].operationId,candidateDigest:rsiDigest(f.files),arm:'shadow',revision:'candidate',day:'2026-10-26',outcome:'ok'}
 const observed=await other.observe('bundle',witness);assert.equal(observed.state,'consumer-observed');assert.equal(observed.fuse.state,'inconclusive')
 assert.equal((await other.observe('bundle',witness)).observations.candidateExecutions,1)
 const stopped=await other.observe('bundle',{...witness,id:'execution-2',outcome:'critical',criticalCode:'corrupt-bytes'});assert.equal(stopped.state,'rolled-back');assert.equal(f.rollbacks(),1)
 assert.equal((await other.select(f.target.surface,{runPin:'candidate'})).revision,'base')
}))
test('restart after external publication adopts exact operation, while stale baseline refuses before publication',skip,()=>withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner);f.crash();await assert.rejects(f.importer.importBundle(f.envelope),/process lost/)
 const restarted=new RsiCampaignImporter(f.options);assert.equal((await restarted.resume('bundle')).state,'exposed');assert.equal(f.publications(),1)
 const different=await signRsiCampaignBundle({manifest:{...f.manifest,expiresAt:'2026-10-28T00:00:00Z'},files:f.files,keyId:'publisher',signer:bytes=>sign(null,bytes,privateKey)})
 await assert.rejects(restarted.importBundle(different),{code:'campaign_bundle_identity_conflict'})
}))
test('baseline changes during verification are rechecked under activation fence',skip,()=>withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner);f.options.currentTarget=async()=>({...f.target,baselineRevision:'new-base'})
 await assert.rejects(new RsiCampaignImporter(f.options).importBundle(f.envelope),{code:'campaign_target_changed'});assert.equal(f.publications(),0)
 const result=await database.query("SELECT id FROM evimed_product.documents WHERE user_id=$1",[owner]);assert.equal(result.rowCount,0)
}))
test('unknown qualification refuses without writes; installed digest mismatch cannot become exposed',skip,()=>withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner),original=f.options.verificationOptions
 f.options.verificationOptions=async envelope=>({...await original(envelope),qualification:null})
 assert.equal((await new RsiCampaignImporter(f.options).importBundle(f.envelope)).state,'rejected')
 let rows=await database.query("SELECT id FROM evimed_product.documents WHERE user_id=$1",[owner]);assert.equal(rows.rowCount,0)
 f.options.verificationOptions=original
 f.options.adapters.policy.inspect=async()=>({installed:true,phase:'stage',operationId:'wrong',candidateDigest:hash,revision:'candidate'})
 await assert.rejects(new RsiCampaignImporter(f.options).importBundle(f.envelope),{code:'campaign_installed_identity_conflict'})
 rows=await database.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1",[owner]);assert.equal(rows.rows[0].payload.state,'staged');assert.equal(f.publications(),0)
}))
test('competing campaign imports serialize surface admission with no partial second journal',skip,()=>withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner)
 const second=await signRsiCampaignBundle({manifest:{...f.manifest,id:'bundle-2',campaignId:'campaign-2'},files:f.files,keyId:'publisher',signer:bytes=>sign(null,bytes,privateKey)})
 const original=f.options.verificationOptions
 f.options.verificationOptions=async envelope=>({...await original(envelope),expectedIdentity:envelope===second?{id:'bundle-2',campaignId:'campaign-2'}:{id:'bundle',campaignId:'campaign'}})
 const importer=new RsiCampaignImporter(f.options)
 const results=await Promise.allSettled([importer.importBundle(f.envelope),importer.importBundle(second)])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 const rows=await database.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1",[owner]);assert.equal(rows.rowCount,1);assert.equal(f.publications(),1)
}))
test('selection rechecks live generation, expiry, binding and returns current incumbent after stop',skip,()=>withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner)
 await f.importer.importBundle(f.envelope)
 f.target.baselineRevision='new-incumbent';f.target.dependencyDigest='b'.repeat(64)
 const selected=await f.importer.select(f.target.surface,{runPin:'candidate',userId:'u',projectId:'p'})
 assert.equal(selected.revision,'new-incumbent');assert.equal(selected.shadowRevision,undefined)
 const rows=await database.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1",[owner]);assert.equal(rows.rows[0].payload.state,'stopped');assert.equal(f.rollbacks(),0)
}))
test('expired external activation is reconciled and rolled back under same operation identity',skip,()=>withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner);let active=null,staged=null,crashed=false,rollbackId=null
 const original=f.options.activationPolicy
 f.options.activationPolicy=async manifest=>({...await original(manifest),mode:'global',allowGlobal:true})
 f.options.adapters.policy={inspect:async({phase})=>{if(phase==='activate'&&active&&!crashed){crashed=true;throw Error('activation crash')}return phase==='activate'?active:staged},publish:async input=>{const receipt={installed:true,phase:input.phase,operationId:input.operationId,candidateDigest:rsiDigest(f.files),revision:'candidate'};if(input.phase==='activate'){active=receipt;f.target.baselineRevision='candidate'}else staged=receipt},rollback:async input=>{rollbackId=input.operationId;f.target.baselineRevision=input.revision;return {...input,installed:true}}}
 await assert.rejects(new RsiCampaignImporter(f.options).importBundle(f.envelope),/activation crash/)
 f.options.now=()=> '2026-10-28T12:00:00Z'
 const recovered=await new RsiCampaignImporter(f.options).resume('bundle')
 assert.equal(recovered.state,'rolled-back');assert.equal(f.target.baselineRevision,'base');assert.equal(rollbackId,`${active.operationId}-rollback`)
}))
test('trust-revoked external activation is inspected and rolled back during recovery',skip,()=>withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner);let active=null,staged=null,crashed=false,rollbackId=null
 const original=f.options.activationPolicy
 f.options.activationPolicy=async manifest=>({...await original(manifest),mode:'global',allowGlobal:true})
 f.options.adapters.policy={inspect:async({phase})=>{if(phase==='activate'&&active&&!crashed){crashed=true;throw Error('activation crash')}return phase==='activate'?active:staged},publish:async input=>{const receipt={installed:true,phase:input.phase,operationId:input.operationId,candidateDigest:rsiDigest(f.files),revision:'candidate'};if(input.phase==='activate'){active=receipt;f.target.baselineRevision='candidate'}else staged=receipt},rollback:async input=>{rollbackId=input.operationId;f.target.baselineRevision=input.revision;return {...input,installed:true}}}
 await assert.rejects(new RsiCampaignImporter(f.options).importBundle(f.envelope),/activation crash/)
 f.options.validateAdmission=async()=>false
 const recovered=await new RsiCampaignImporter(f.options).resume('bundle')
 assert.equal(recovered.state,'rolled-back');assert.equal(f.target.baselineRevision,'base');assert.equal(rollbackId,`${active.operationId}-rollback`)
}))
test('own active baseline stays eligible until expiry or binding withdrawal, then reconciles incumbent',skip,async()=>{
 for(const cause of ['expiry','binding','newer'])await withDatabase(async(database,owner)=>{
  const f=await fixture(database,owner);const receipts=new Map();let rollbackCount=0
  f.options.activationPolicy=async()=>({mode:'global',allowGlobal:true,minExecutions:10,minDays:3,maxErrors:0})
  f.options.adapters.policy={inspect:async({phase})=>receipts.get(phase),publish:async input=>{receipts.set(input.phase,{installed:true,phase:input.phase,operationId:input.operationId,candidateDigest:rsiDigest(f.files),revision:'candidate'});if(input.phase==='activate')f.target.baselineRevision='candidate'},rollback:async input=>{rollbackCount++;f.target.baselineRevision=input.revision;return {...input,installed:true}}}
  let importer=new RsiCampaignImporter(f.options)
  await importer.importBundle(f.envelope)
  assert.equal((await importer.select(f.target.surface,{userId:'u',projectId:'p'})).revision,'candidate')
  if(cause==='expiry'){f.options.now=()=> '2026-10-28T12:00:00Z';importer=new RsiCampaignImporter(f.options)}
  if(cause==='binding')f.unbind()
  if(cause==='newer')f.target.baselineRevision='third-incumbent'
  const selected=await importer.select(f.target.surface,{runPin:'candidate'})
  assert.equal(selected.revision,cause==='newer'?'third-incumbent':'base')
  assert.equal(rollbackCount,cause==='newer'?0:1)
 })
})
/** @param {any} f @param {any} policy */
function progressionAdapters(f,policy){
 const receipts=new Map();let activations=0,crash=false,thrown=false
 f.options.activationPolicy=async()=>policy
 f.options.adapters.policy={inspect:async({phase,transactionClient})=>{assert.ok(transactionClient);if(phase==='activate'&&receipts.has(phase)&&crash&&!thrown){thrown=true;throw Error('progression crash')}return receipts.get(phase)},publish:async input=>{assert.ok(input.transactionClient);receipts.set(input.phase,{installed:true,phase:input.phase,operationId:input.operationId,candidateDigest:rsiDigest(f.files),revision:'candidate'});if(input.phase==='activate'){activations++;f.target.baselineRevision='candidate'}},rollback:async input=>{assert.ok(input.transactionClient);f.target.baselineRevision=input.revision;return {...input,installed:true}}}
 return {activations:()=>activations,crash:()=>{crash=true},importer:new RsiCampaignImporter(f.options)}
}
/** @param {any} row @param {number} n @param {any} [extra] */
const execution=(row,n,extra={})=>({trusted:true,stageIndex:row.stageIndex??0,id:`exec-${n}`,operationId:row.operationId,candidateDigest:row.candidateDigest,revision:row.revision,consumerDigest:hash,arm:row.mode==='shadow'?'shadow':'candidate',day:n%2?'2026-10-25':'2026-10-26',outcome:'ok',...extra})
test('registered shadow executions activate once after sufficient days, then global consumer regression rolls back',skip,()=>withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner),p=progressionAdapters(f,{mode:'shadow',afterShadow:'global',allowExpansion:true,minExecutions:200,minDays:2,maxErrors:0})
 let row=await p.importer.importBundle(f.envelope)
 for(let n=1;n<200;n++)row=await p.importer.observe('bundle',execution(row,n))
 assert.equal(p.activations(),0);assert.equal((await p.importer.select(f.target.surface)).revision,'base')
 row=await p.importer.observe('bundle',execution(row,200));assert.equal(row.mode,'global');assert.equal(row.phase,'activate');assert.equal(p.activations(),1)
 assert.equal((await p.importer.select(f.target.surface)).revision,'candidate')
 await assert.rejects(p.importer.observe('bundle',execution(row,201,{stageIndex:0})),{code:'campaign_consumer_witness_stage_changed'})
 row=await p.importer.observe('bundle',execution(row,201));assert.equal(row.state,'consumer-observed')
 row=await p.importer.observe('bundle',execution(row,202,{stageIndex:0,arm:'shadow',outcome:'critical',criticalCode:'deterministic-regression'}));assert.equal(row.state,'rolled-back');assert.equal(f.target.baselineRevision,'base')
}))
test('shadow activation transition survives a crash and refuses newer baseline',skip,async()=>{
 for(const newer of [false,true])await withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner),p=progressionAdapters(f,{mode:'shadow',afterShadow:'global',allowExpansion:true,minExecutions:2,minDays:2,maxErrors:0})
 let row=await p.importer.importBundle(f.envelope);row=await p.importer.observe('bundle',execution(row,1));p.crash()
 await assert.rejects(p.importer.observe('bundle',execution(row,2)),/progression crash/)
 if(newer)f.target.baselineRevision='newer-incumbent'
 row=await new RsiCampaignImporter(f.options).resume('bundle')
 assert.equal(row.state,newer?'stopped':'exposed');assert.equal(p.activations(),1)
 assert.equal(f.target.baselineRevision,newer?'newer-incumbent':'candidate')
 })
})
test('cohort expansion follows registered steps with fresh observations for each stage',skip,()=>withDatabase(async(database,owner)=>{
 const f=await fixture(database,owner,'geo-supplements'),p=progressionAdapters(f,{mode:'cohort',cohortPercent:10,cohortSteps:[10,25,50,100],allowExpansion:true,minExecutions:2,minDays:2,maxErrors:0})
 let row=await p.importer.importBundle(f.envelope)
 for(let step=1;step<4;step++){
 row=await p.importer.observe('bundle',execution(row,2*step-1));assert.equal(row.cohortPercent,[10,25,50][step-1])
 row=await p.importer.observe('bundle',execution(row,2*step));assert.equal(row.cohortPercent,[25,50,100][step-1]);assert.equal(row.observations.candidateExecutions,0)
 }
 assert.equal(row.state,'exposed')
 row=await p.importer.observe('bundle',execution(row,7));assert.equal(row.state,'consumer-observed')
 row=await p.importer.observe('bundle',execution(row,8));assert.equal(row.state,'broadly-active');assert.equal(p.activations(),1)
}))
