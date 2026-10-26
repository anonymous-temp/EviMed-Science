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
async function fixture(database,owner){
 const target={surface:'frontier-selection',dependencyDigest:hash,baselineRevision:'base'}
 const qualification=Object.fromEntries(['registrationDigest','datasetDigest','measurementDigest','consumerDigest','evaluatorDigest','procedureDigest','qualificationDigest','corpusDigest'].map(k=>[k,hash]))
 const files=[{path:'policy.json',content:'{"limit":2}'}]
 const manifest={id:'bundle',campaignId:'campaign',surface:target.surface,kind:'policy',target,createdAt:'2026-10-26T00:00:00Z',expiresAt:'2026-10-27T00:00:00Z',verdict:{status:'qualified',scope:target.surface,...qualification,candidateDigest:rsiDigest(files)}}
 const envelope=await signRsiCampaignBundle({manifest,files,keyId:'publisher',signer:bytes=>sign(null,bytes,privateKey)})
 let installed=null,publications=0,failAfterPublish=false,rollbacks=0,bound=true
 const options={database,owner,now:()=> '2026-10-26T12:00:00Z',isBound:()=>bound,currentTarget:async()=>({...target}),verificationOptions:async()=>({trustStore:{publisher:{publicKey,surfaces:[target.surface],kinds:['policy']}},expectedIdentity:{id:manifest.id,campaignId:manifest.campaignId},qualification:{...qualification,scope:target.surface,verifyReceipt:()=>true},currentTarget:{...target}}),activationPolicy:async()=>({mode:'shadow',minExecutions:100,minDays:3,maxErrors:0}),verifyObservation:async proof=>proof?.trusted?proof:null,adapters:{policy:{inspect:async()=>{if(failAfterPublish && installed){failAfterPublish=false;throw Error('process lost after external publish')}return installed},publish:async input=>{assert.equal(input.phase,'stage');publications++;installed={operationId:input.operationId,phase:input.phase,candidateDigest:rsiDigest(input.files),revision:'candidate',installed:true}},rollback:async input=>{rollbacks++;return {...input,installed:true}}}}}
 return {options,envelope,manifest,target,files,importer:new RsiCampaignImporter(options),publications:()=>publications,rollbacks:()=>rollbacks,crash:()=>{failAfterPublish=true},unbind:()=>{bound=false}}
}
/** @param {(database:any,owner:string)=>Promise<void>} operation */
async function withDatabase(operation){const database=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:4,databaseConnectionTimeoutMs:2000}),owner=`rsi_import_${randomUUID().replaceAll('-','')}`;try{await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'RSI importer test','development')",[owner]);await operation(database,owner)}finally{await database.query('DELETE FROM evimed_control.users WHERE id=$1',[owner]);await database.close()}}
const skip={skip:!url&&'Disposable localhost PostgreSQL required'}
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
